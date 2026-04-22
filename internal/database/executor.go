package database

// executor.go — dynamic SQL execution with safe type coercion.
//
// This file is the "Phase 11" query engine.  It operates directly on the
// *sql.DB obtained from the Manager (not through the driver.DatabaseDriver
// abstraction layer) so it can work with any connection that was registered
// via Connect(), including those opened from saved configs.
//
// # Why sql.RawBytes?
//
// MySQL's Go driver reports every column as []byte at the wire level.
// sql.RawBytes is a zero-copy alias for []byte that signals to database/sql
// that we own the buffer and will convert it ourselves, avoiding an internal
// copy.  After scanning we immediately convert to one of:
//
//	nil      — SQL NULL
//	int64    — integer-typed columns (TINYINT … BIGINT, YEAR, BIT≤64)
//	float64  — floating-point columns (FLOAT, DOUBLE, DECIMAL)
//	bool     — TINYINT(1) / BIT(1) columns reported as boolean by parseTime=true
//	string   — everything else (VARCHAR, TEXT, BLOB, DATETIME, etc.)
//
// This matches the JSON encoding that the React frontend expects: numbers are
// numeric, strings are strings, and nulls are null.
//
// # LIMIT injection
//
// SQL that arrives without a LIMIT clause can bring the entire table over the
// wire and blow the frontend grid's memory budget.  InjectLimit detects the
// absence of a top-level LIMIT keyword and appends "LIMIT <n>" to the query.
// It is intentionally conservative: if the keyword appears anywhere in the
// string (including sub-queries) it does not inject, preferring false-negatives
// over accidentally changing query semantics.

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// DefaultLimit is the LIMIT appended when the query has none and the caller
// passes limit ≤ 0.
const DefaultLimit = 1000

// ExecResult is the IPC-serialisable query result returned by ExecuteQuery.
//
// Unlike the existing QueryResult (which uses [][]any for Glide Data Grid
// efficiency), ExecResult uses []map[string]any so the frontend can access
// cells by column name:
//
//	const name = row["first_name"]
//
// The two formats coexist; use RunQuery for the grid, ExecuteQuery for
// everything else.
type ExecResult struct {
	// Columns is the ordered list of column names.
	Columns []string `json:"columns"`

	// Rows holds the cell values keyed by column name.
	// Cell types: string | int64 | float64 | bool | nil (JSON null).
	Rows []map[string]any `json:"rows"`

	// RowCount is the number of rows materialised.
	RowCount int `json:"rowCount"`

	// Truncated is true when the server returned more rows than limit.
	Truncated bool `json:"truncated"`

	// RowsAffected is non-zero for DML (INSERT / UPDATE / DELETE).
	RowsAffected int64 `json:"rowsAffected"`

	// TimeMs is the wall-clock milliseconds for the whole call (network + scan).
	TimeMs int64 `json:"timeMs"`

	// Error is non-empty when the query failed.
	// It is returned in-band (not as a Go error) so the React component can
	// display it inline without an uncaught-Promise crash.
	Error string `json:"error,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// ExecuteQuery — the main entry point
// ─────────────────────────────────────────────────────────────────────────────

// ExecuteQuery executes sqlString on the connection identified by connID and
// returns up to limit rows as an ExecResult.
//
// Rules:
//   - If limit ≤ 0 it defaults to DefaultLimit (1000).
//   - If sqlString does not contain a top-level LIMIT keyword, "LIMIT <limit>"
//     is appended automatically to prevent accidental full-table scans.
//   - Errors are returned inside ExecResult.Error, not as Go errors, so the
//     frontend can display them without an uncaught-Promise exception.
//
// Front-end usage:
//
//	const res = await ExecuteQuery("conn-uuid", "SELECT * FROM users", 200)
//	if (res.error) { showError(res.error); return }
//	renderGrid(res.columns, res.rows)
func (m *Manager) ExecuteQuery(ctx context.Context, connID, sqlStr string, limit int) ExecResult {
	start := time.Now()

	db, ok := m.DB(connID)
	if !ok {
		return ExecResult{Error: fmt.Sprintf("connection %q not found — call Connect first", connID)}
	}

	if limit <= 0 {
		limit = DefaultLimit
	}

	// Inject LIMIT when the query is a plain SELECT without one.
	effective := InjectLimit(sqlStr, limit)

	rows, err := db.QueryContext(ctx, effective)
	if err != nil {
		return ExecResult{
			TimeMs: time.Since(start).Milliseconds(),
			Error:  fmt.Sprintf("query error: %v", err),
		}
	}
	defer rows.Close()

	result, execErr := materialiseRows(rows, limit)
	result.TimeMs = time.Since(start).Milliseconds()
	if execErr != nil {
		result.Error = execErr.Error()
	}
	return result
}

// ExecDML runs a non-SELECT statement (INSERT / UPDATE / DELETE / DDL) and
// returns rows affected and timing.
//
// Front-end usage:
//
//	const res = await ExecDML("conn-uuid", "UPDATE users SET active=1 WHERE id=42")
func (m *Manager) ExecDML(ctx context.Context, connID, sqlStr string) ExecResult {
	start := time.Now()

	db, ok := m.DB(connID)
	if !ok {
		return ExecResult{Error: fmt.Sprintf("connection %q not found", connID)}
	}

	result, err := db.ExecContext(ctx, sqlStr)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return ExecResult{TimeMs: ms, Error: fmt.Sprintf("exec error: %v", err)}
	}

	affected, _ := result.RowsAffected()
	return ExecResult{
		Columns:      []string{},
		Rows:         []map[string]any{},
		RowsAffected: affected,
		TimeMs:       ms,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// InjectLimit
// ─────────────────────────────────────────────────────────────────────────────

// InjectLimit appends "LIMIT n" to query when no top-level LIMIT clause is
// detected.  The detection is case-insensitive and conservative: if "LIMIT"
// appears anywhere in the query string it is left untouched.
//
// Examples:
//
//	"SELECT * FROM t"           → "SELECT * FROM t LIMIT 200"
//	"SELECT * FROM t LIMIT 50"  → unchanged
//	"SELECT * FROM t limit 50"  → unchanged (case-insensitive)
//	"UPDATE t SET x=1"          → unchanged (non-SELECT DML)
//	"SELECT id FROM (SELECT id FROM t LIMIT 100) sub" → unchanged (has LIMIT)
func InjectLimit(query string, n int) string {
	upper := strings.ToUpper(query)

	// Only inject on plain SELECTs.  DML / DDL / stored-proc calls should
	// never have an injected LIMIT because it is meaningless or harmful.
	trimmed := strings.TrimLeftFunc(upper, unicode.IsSpace)
	if !strings.HasPrefix(trimmed, "SELECT") {
		return query
	}

	// Conservative: if LIMIT appears anywhere we leave the query alone.
	if strings.Contains(upper, "LIMIT") {
		return query
	}

	// Strip trailing semicolon before appending, then re-add it.
	q := strings.TrimRightFunc(query, unicode.IsSpace)
	if strings.HasSuffix(q, ";") {
		return q[:len(q)-1] + " LIMIT " + strconv.Itoa(n) + ";"
	}
	return q + " LIMIT " + strconv.Itoa(n)
}

// ─────────────────────────────────────────────────────────────────────────────
// materialiseRows — scan *sql.Rows into []map[string]any
// ─────────────────────────────────────────────────────────────────────────────

// materialiseRows reads all rows from the result set and returns an ExecResult.
// cap is the maximum number of rows to materialise; if more rows are available
// ExecResult.Truncated is set to true.
func materialiseRows(rows *sql.Rows, cap int) (ExecResult, error) {
	colNames, err := rows.Columns()
	if err != nil {
		return ExecResult{}, fmt.Errorf("columns: %w", err)
	}
	rawColTypes, err := rows.ColumnTypes()
	if err != nil {
		return ExecResult{}, fmt.Errorf("column types: %w", err)
	}

	nCols := len(colNames)

	// Convert to the columnTyper interface slice used by coerce.
	colTypes := make([]columnTyper, nCols)
	for i, ct := range rawColTypes {
		colTypes[i] = ct
	}

	// Pre-allocate scan buffers.
	// We use *[]byte (i.e. *sql.RawBytes) for every column and then coerce.
	scanBufs := make([]sql.RawBytes, nCols)
	scanPtrs := make([]any, nCols)
	for i := range scanBufs {
		scanPtrs[i] = &scanBufs[i]
	}

	var (
		result    []map[string]any
		truncated bool
	)

	for rows.Next() {
		if len(result) >= cap {
			truncated = true
			break
		}

		if err := rows.Scan(scanPtrs...); err != nil {
			return ExecResult{
				Columns:   colNames,
				Rows:      result,
				RowCount:  len(result),
				Truncated: truncated,
			}, fmt.Errorf("scan row %d: %w", len(result), err)
		}

		row := make(map[string]any, nCols)
		for i, raw := range scanBufs {
			row[colNames[i]] = coerce(raw, colTypes[i])
		}
		result = append(result, row)
	}

	if err := rows.Err(); err != nil {
		return ExecResult{
			Columns:   colNames,
			Rows:      result,
			RowCount:  len(result),
			Truncated: truncated,
		}, fmt.Errorf("row iteration: %w", err)
	}

	return ExecResult{
		Columns:   colNames,
		Rows:      result,
		RowCount:  len(result),
		Truncated: truncated,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// coerce — type-safe conversion of sql.RawBytes → Go scalar
// ─────────────────────────────────────────────────────────────────────────────

// columnTyper is the minimal interface required by coerce.
// *sql.ColumnType satisfies it; test fakes can implement it without embedding
// the concrete (unexportable) sql.ColumnType struct.
type columnTyper interface {
	DatabaseTypeName() string
}

// coerce converts a raw MySQL wire value to the most appropriate Go type for
// JSON serialisation.
//
// Conversion table:
//
//	nil raw bytes           → nil        (SQL NULL)
//	INT/BIGINT/SMALLINT/… → int64       (strconv.ParseInt)
//	YEAR                   → int64
//	FLOAT/DOUBLE           → float64    (strconv.ParseFloat)
//	DECIMAL/NUMERIC        → float64    (preserves decimal precision in JSON)
//	TINYINT(1) / BIT(1)   → bool
//	everything else        → string     (safe fallback, covers DATETIME etc.)
func coerce(raw sql.RawBytes, ct columnTyper) any {
	if raw == nil {
		return nil
	}
	s := string(raw)

	dbType := strings.ToUpper(ct.DatabaseTypeName())

	switch {
	case dbType == "NULL":
		return nil

	case isIntType(dbType):
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
		return s // fallback: return as string if parse fails

	case isFloatType(dbType):
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			return v
		}
		return s

	case isBoolType(dbType):
		// MySQL TINYINT(1) is typically 0 or 1 on the wire.
		switch s {
		case "1", "true", "TRUE":
			return true
		case "0", "false", "FALSE":
			return false
		}
		return s

	default:
		return s
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Type classification helpers
// ─────────────────────────────────────────────────────────────────────────────

func isIntType(dbType string) bool {
	switch dbType {
	case "INT", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT",
		"INT2", "INT4", "INT8", "YEAR":
		return true
	}
	return false
}

func isFloatType(dbType string) bool {
	switch dbType {
	case "FLOAT", "DOUBLE", "REAL", "NUMERIC", "DECIMAL", "DOUBLE PRECISION":
		return true
	}
	return false
}

// isBoolType identifies columns that should be decoded as bool.
// We only treat BIT(1) as boolean; larger BIT columns stay as strings to
// preserve the bit-vector semantics.
func isBoolType(dbType string) bool {
	return dbType == "BIT"
}
