package database

// applier.go — inline-edit transaction generator (Phase 12).
//
// This file converts the frontend's Diff-state (edits, addedRows, deletedIds)
// into a single atomic database transaction, matching the structure that
// Phase 6.8 maintains in React state.
//
// # Security model
//
// • Column and table names are backtick-quoted via quoteIdent, preventing
//   SQL injection through identifier names.
// • Cell values are always passed as prepared-statement parameters (?), so
//   they never appear literally in the SQL string.
// • The table name and primary-key name come from the frontend, so they are
//   validated (non-empty, no null bytes) before use.
//
// # Transaction semantics
//
// All three mutation kinds (DELETE, INSERT, UPDATE) run inside a single
// *sql.Tx.  If any statement fails the transaction is rolled back and the
// error is returned in ApplyResult.Error — never as a Go error — so the
// React component can display it without an uncaught-Promise crash.
// Only when every statement succeeds does Commit() run.
//
// # Execution order
//
//  1. DELETE  — remove rows first so primary-key conflicts cannot block INSERTs.
//  2. INSERT  — add new rows.
//  3. UPDATE  — patch existing rows last.
//
// The caller (frontend) is responsible for ensuring that the PK value is
// present in every editedRow map and that deletedIds contains raw PK values
// (numbers or strings, not objects).

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

// ChangeSet is the IPC-deserialisable payload sent by the frontend when the
// user clicks "Save" in the inline-edit ActionFooter.
//
// JSON shape (matches DataViewer's editState):
//
//	{
//	  "connectionId": "uuid",
//	  "database":     "mydb",
//	  "tableName":    "orders",
//	  "primaryKey":   "id",
//	  "deletedIds":   [3, 4],
//	  "addedRows":    [{"status": "new", "amount": 99.0}],
//	  "editedRows":   [{"id": 1, "email": "new@a.com"}]
//	}
type ChangeSet struct {
	// ConnectionID identifies the live *sql.DB pool in the Manager.
	ConnectionID string `json:"connectionId"`

	// Database is the MySQL schema name (used for "USE `db`" before DML).
	// May be empty if the connection already has a default database.
	Database string `json:"database"`

	// TableName is the unqualified table name, e.g. "orders".
	TableName string `json:"tableName"`

	// PrimaryKey is the single primary-key column name, e.g. "id".
	// Composite PKs are not supported in this version.
	PrimaryKey string `json:"primaryKey"`

	// DeletedIds is a list of PK values whose rows should be DELETEd.
	// Each element is any JSON scalar (number, string).
	DeletedIds []any `json:"deletedIds"`

	// AddedRows is a list of new rows to INSERT.
	// Each map holds column→value pairs; the PK may be absent when the
	// column is AUTO_INCREMENT.
	AddedRows []map[string]any `json:"addedRows"`

	// EditedRows is a list of modified rows.
	// Each map MUST contain the PK value so the WHERE clause can be built.
	// Only the keys present in the map are included in the SET clause.
	EditedRows []map[string]any `json:"editedRows"`
}

// ApplyResult summarises the outcome of a ChangeSet transaction.
type ApplyResult struct {
	// Counts of rows affected by each mutation kind.
	DeletedCount int64 `json:"deletedCount"`
	InsertedCount int64 `json:"insertedCount"`
	UpdatedCount  int64 `json:"updatedCount"`

	// TimeMs is total wall-clock milliseconds for the transaction.
	TimeMs int64 `json:"timeMs"`

	// Statements holds the SQL strings that were executed (for debugging /
	// audit log display in the UI).  Values are replaced by "?" placeholders.
	Statements []string `json:"statements,omitempty"`

	// Error is non-empty when the transaction was rolled back.
	// Returned in-band so the React component can show it without crashing.
	Error string `json:"error,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// ApplyChanges
// ─────────────────────────────────────────────────────────────────────────────

// ApplyChanges converts the ChangeSet into SQL and executes it atomically.
//
// Front-end usage:
//
//	const result = await ApplyChanges({
//	  connectionId: "uuid",
//	  database:     "mydb",
//	  tableName:    "orders",
//	  primaryKey:   "id",
//	  deletedIds:   [3, 4],
//	  addedRows:    [{ status: "shipped", amount: 99.0 }],
//	  editedRows:   [{ id: 1, email: "new@example.com" }],
//	})
//	if (result.error) showError(result.error)
//	else refreshGrid()
func (m *Manager) ApplyChanges(ctx context.Context, cs ChangeSet) ApplyResult {
	start := time.Now()

	if err := validateChangeSet(cs); err != nil {
		return ApplyResult{Error: err.Error()}
	}

	db, ok := m.DB(cs.ConnectionID)
	if !ok {
		return ApplyResult{Error: fmt.Sprintf("connection %q not found — call Connect first", cs.ConnectionID)}
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return ApplyResult{Error: fmt.Sprintf("begin tx: %v", err)}
	}

	// Switch to the target database when specified.
	if cs.Database != "" {
		if _, err := tx.ExecContext(ctx, "USE "+quoteIdent(cs.Database)); err != nil {
			_ = tx.Rollback()
			return ApplyResult{Error: fmt.Sprintf("USE %q: %v", cs.Database, err)}
		}
	}

	var res ApplyResult

	// ── 1. DELETE ────────────────────────────────────────────────────────────
	for _, pkVal := range cs.DeletedIds {
		sqlStr := fmt.Sprintf("DELETE FROM %s WHERE %s = ?",
			quoteIdent(cs.TableName), quoteIdent(cs.PrimaryKey))
		res.Statements = append(res.Statements, sqlStr)

		r, err := tx.ExecContext(ctx, sqlStr, pkVal)
		if err != nil {
			_ = tx.Rollback()
			return ApplyResult{
				Statements: res.Statements,
				TimeMs:     time.Since(start).Milliseconds(),
				Error:      fmt.Sprintf("DELETE pk=%v: %v", pkVal, err),
			}
		}
		n, _ := r.RowsAffected()
		res.DeletedCount += n
	}

	// ── 2. INSERT ────────────────────────────────────────────────────────────
	for _, row := range cs.AddedRows {
		if len(row) == 0 {
			continue // skip fully-empty rows
		}

		cols, vals := mapToSortedPairs(row)
		sqlStr := buildInsert(cs.TableName, cols)
		res.Statements = append(res.Statements, sqlStr)

		r, err := tx.ExecContext(ctx, sqlStr, vals...)
		if err != nil {
			_ = tx.Rollback()
			return ApplyResult{
				Statements: res.Statements,
				TimeMs:     time.Since(start).Milliseconds(),
				Error:      fmt.Sprintf("INSERT row: %v", err),
			}
		}
		n, _ := r.RowsAffected()
		res.InsertedCount += n
	}

	// ── 3. UPDATE ────────────────────────────────────────────────────────────
	for _, row := range cs.EditedRows {
		pkVal, ok := row[cs.PrimaryKey]
		if !ok {
			_ = tx.Rollback()
			return ApplyResult{
				Statements: res.Statements,
				TimeMs:     time.Since(start).Milliseconds(),
				Error: fmt.Sprintf("editedRow is missing primary key column %q; row: %v",
					cs.PrimaryKey, row),
			}
		}

		// Build SET pairs from every column EXCEPT the primary key.
		setCols, setVals := mapToSortedPairsExcluding(row, cs.PrimaryKey)
		if len(setCols) == 0 {
			continue // nothing to update (row map only contained the PK)
		}

		sqlStr := buildUpdate(cs.TableName, setCols, cs.PrimaryKey)
		res.Statements = append(res.Statements, sqlStr)

		// Params: SET values first, then the WHERE PK value.
		params := append(setVals, pkVal) //nolint:gocritic // intentional slice grow
		r, err := tx.ExecContext(ctx, sqlStr, params...)
		if err != nil {
			_ = tx.Rollback()
			return ApplyResult{
				Statements: res.Statements,
				TimeMs:     time.Since(start).Milliseconds(),
				Error:      fmt.Sprintf("UPDATE pk=%v: %v", pkVal, err),
			}
		}
		n, _ := r.RowsAffected()
		res.UpdatedCount += n
	}

	// ── 4. Commit ────────────────────────────────────────────────────────────
	if err := tx.Commit(); err != nil {
		_ = tx.Rollback()
		return ApplyResult{
			Statements: res.Statements,
			TimeMs:     time.Since(start).Milliseconds(),
			Error:      fmt.Sprintf("commit: %v", err),
		}
	}

	res.TimeMs = time.Since(start).Milliseconds()
	return res
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL builders
// ─────────────────────────────────────────────────────────────────────────────

// buildInsert constructs an INSERT statement for the given table and column list.
//
//	INSERT INTO `tbl` (`col1`, `col2`) VALUES (?, ?)
func buildInsert(table string, cols []string) string {
	quoted := make([]string, len(cols))
	placeholders := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = quoteIdent(c)
		placeholders[i] = "?"
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)",
		quoteIdent(table),
		strings.Join(quoted, ", "),
		strings.Join(placeholders, ", "))
}

// buildUpdate constructs an UPDATE statement.
//
//	UPDATE `tbl` SET `col1` = ?, `col2` = ? WHERE `pk` = ?
func buildUpdate(table string, setCols []string, pk string) string {
	pairs := make([]string, len(setCols))
	for i, c := range setCols {
		pairs[i] = quoteIdent(c) + " = ?"
	}
	return fmt.Sprintf("UPDATE %s SET %s WHERE %s = ?",
		quoteIdent(table),
		strings.Join(pairs, ", "),
		quoteIdent(pk))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// quoteIdent wraps an SQL identifier in backticks and escapes any embedded
// backticks, preventing SQL injection through column or table names.
//
//	quoteIdent("users")     → "`users`"
//	quoteIdent("my`table")  → "`my``table`"
func quoteIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

// mapToSortedPairs returns the keys and values of m in sorted key order.
// Sorting ensures deterministic SQL and prepared-statement parameter order.
func mapToSortedPairs(m map[string]any) (cols []string, vals []any) {
	cols = make([]string, 0, len(m))
	for k := range m {
		cols = append(cols, k)
	}
	sort.Strings(cols)
	vals = make([]any, len(cols))
	for i, k := range cols {
		vals[i] = m[k]
	}
	return cols, vals
}

// mapToSortedPairsExcluding returns sorted key/value pairs, skipping exclude.
func mapToSortedPairsExcluding(m map[string]any, exclude string) (cols []string, vals []any) {
	cols = make([]string, 0, len(m))
	for k := range m {
		if k != exclude {
			cols = append(cols, k)
		}
	}
	sort.Strings(cols)
	vals = make([]any, len(cols))
	for i, k := range cols {
		vals[i] = m[k]
	}
	return cols, vals
}

// validateChangeSet returns an error when the ChangeSet fields that appear
// in SQL identifiers are missing or contain null bytes (basic sanity check).
func validateChangeSet(cs ChangeSet) error {
	if cs.ConnectionID == "" {
		return fmt.Errorf("changeSet.connectionId must not be empty")
	}
	if cs.TableName == "" {
		return fmt.Errorf("changeSet.tableName must not be empty")
	}
	if cs.PrimaryKey == "" {
		return fmt.Errorf("changeSet.primaryKey must not be empty")
	}
	// Null bytes in identifiers would break the backtick quoting scheme.
	for _, s := range []string{cs.TableName, cs.PrimaryKey, cs.Database} {
		if strings.ContainsRune(s, 0) {
			return fmt.Errorf("identifier contains null byte: %q", s)
		}
	}
	// Guard against no-op calls so we don't open a transaction for nothing.
	if len(cs.DeletedIds) == 0 && len(cs.AddedRows) == 0 && len(cs.EditedRows) == 0 {
		return fmt.Errorf("changeSet has no mutations (deletedIds, addedRows, and editedRows are all empty)")
	}
	return nil
}
