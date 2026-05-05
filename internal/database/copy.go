package database

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const DefaultCopyBatchSize = 1000

// CopyProgressEvent is emitted to the frontend as "copy_progress".
type CopyProgressEvent struct {
	Status        string `json:"status"`
	ProcessedRows int    `json:"processedRows"`
	TotalRows     int    `json:"totalRows"`
}

// CopyResult summarises a copy job. Errors are returned in-band so frontend
// callers can render them without an uncaught Promise rejection.
type CopyResult struct {
	Success bool   `json:"success"`
	TimeMs  int64  `json:"timeMs"`
	Error   string `json:"error,omitempty"`
}

// CopyTableConfig describes a single-table copy operation.
type CopyTableConfig struct {
	SourceConnID       string `json:"sourceConnId"`
	SourceDB           string `json:"sourceDb"`
	SourceTable        string `json:"sourceTable"`
	TargetConnID       string `json:"targetConnId"`
	TargetDB           string `json:"targetDb"`
	TargetTable        string `json:"targetTable"`
	CopyStructure      bool   `json:"copyStructure"`
	CopyData           bool   `json:"copyData"`
	DropTargetIfExists bool   `json:"dropTargetIfExists"`
	BatchSize          int    `json:"batchSize"`
}

// CopyDatabaseConfig is the database-level copy job used by the UI.
// Tables is intentionally optional so the same contract can later support
// whole-database, selected-table, and one-table flows without new IPC methods.
type CopyDatabaseConfig struct {
	SourceConnID       string   `json:"sourceConnId"`
	SourceDB           string   `json:"sourceDb"`
	TargetConnID       string   `json:"targetConnId"`
	TargetDB           string   `json:"targetDb"`
	CopyStructure      bool     `json:"copyStructure"`
	CopyData           bool     `json:"copyData"`
	DropTargetIfExists bool     `json:"dropTargetIfExists"`
	BatchSize          int      `json:"batchSize"`
	Scope              string   `json:"scope"`
	Tables             []string `json:"tables"`
}

func NormalizeCopyTableConfig(cfg CopyTableConfig) CopyTableConfig {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = DefaultCopyBatchSize
	}
	if cfg.TargetTable == "" {
		cfg.TargetTable = cfg.SourceTable
	}
	return cfg
}

func NormalizeCopyDatabaseConfig(cfg CopyDatabaseConfig) CopyDatabaseConfig {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = DefaultCopyBatchSize
	}
	if cfg.Scope == "" {
		cfg.Scope = "database"
	}
	if cfg.Tables == nil {
		cfg.Tables = []string{}
	}
	return cfg
}

func (m *Manager) CopyTable(ctx context.Context, cfg CopyTableConfig, emit func(CopyProgressEvent)) CopyResult {
	start := time.Now()
	fail := func(format string, args ...any) CopyResult {
		return CopyResult{
			Success: false,
			TimeMs:  time.Since(start).Milliseconds(),
			Error:   fmt.Sprintf(format, args...),
		}
	}
	progress := func(status string, processedRows, totalRows int) {
		if emit != nil {
			emit(CopyProgressEvent{
				Status:        status,
				ProcessedRows: processedRows,
				TotalRows:     totalRows,
			})
		}
	}

	cfg = NormalizeCopyTableConfig(cfg)
	if strings.TrimSpace(cfg.SourceConnID) == "" || strings.TrimSpace(cfg.TargetConnID) == "" {
		return fail("source and target connection IDs are required")
	}
	if strings.TrimSpace(cfg.SourceDB) == "" || strings.TrimSpace(cfg.SourceTable) == "" {
		return fail("source database and table are required")
	}
	if strings.TrimSpace(cfg.TargetDB) == "" || strings.TrimSpace(cfg.TargetTable) == "" {
		return fail("target database and table are required")
	}

	sourceDB, ok := m.DB(cfg.SourceConnID)
	if !ok || sourceDB == nil {
		return fail("source connection %q not found", cfg.SourceConnID)
	}
	targetDB, ok := m.DB(cfg.TargetConnID)
	if !ok || targetDB == nil {
		return fail("target connection %q not found", cfg.TargetConnID)
	}

	progress("Checking target table...", 0, 0)
	exists, err := targetTableExists(ctx, targetDB, cfg.TargetDB, cfg.TargetTable)
	if err != nil {
		return fail("check target table: %v", err)
	}
	if exists && cfg.CopyStructure && !cfg.DropTargetIfExists {
		return fail("target table %s.%s already exists", cfg.TargetDB, cfg.TargetTable)
	}

	if cfg.CopyStructure {
		progress("Reading source table DDL...", 0, 0)
		ddl, err := fetchCreateTableDDL(ctx, sourceDB, cfg.SourceDB, cfg.SourceTable)
		if err != nil {
			return fail("read source DDL: %v", err)
		}
		ddl, err = rewriteCreateTableDDL(ddl, cfg.TargetDB, cfg.TargetTable)
		if err != nil {
			return fail("rewrite source DDL: %v", err)
		}

		if cfg.DropTargetIfExists {
			progress("Dropping target table if it exists...", 0, 0)
			if _, err := targetDB.ExecContext(ctx,
				fmt.Sprintf("DROP TABLE IF EXISTS %s", qualifiedIdent(cfg.TargetDB, cfg.TargetTable)),
			); err != nil {
				return fail("drop target table: %v", err)
			}
		}

		progress("Creating target table...", 0, 0)
		if _, err := targetDB.ExecContext(ctx, ddl); err != nil {
			return fail("create target table: %v", err)
		}
	}

	if !cfg.CopyData {
		progress("Copy complete", 0, 0)
		return CopyResult{Success: true, TimeMs: time.Since(start).Milliseconds()}
	}

	if !exists && !cfg.CopyStructure {
		return fail("target table %s.%s does not exist", cfg.TargetDB, cfg.TargetTable)
	}

	progress("Copying data...", 0, 0)
	if err := copyTableData(ctx, sourceDB, targetDB, cfg, progress); err != nil {
		return fail("copy data: %v", err)
	}
	progress("Copy complete", 0, 0)
	return CopyResult{Success: true, TimeMs: time.Since(start).Milliseconds()}
}

func (m *Manager) CopyDatabase(ctx context.Context, cfg CopyDatabaseConfig, emit func(CopyProgressEvent)) CopyResult {
	start := time.Now()
	fail := func(format string, args ...any) CopyResult {
		return CopyResult{
			Success: false,
			TimeMs:  time.Since(start).Milliseconds(),
			Error:   fmt.Sprintf(format, args...),
		}
	}
	progress := func(status string, processedRows, totalRows int) {
		if emit != nil {
			emit(CopyProgressEvent{
				Status:        status,
				ProcessedRows: processedRows,
				TotalRows:     totalRows,
			})
		}
	}

	cfg = NormalizeCopyDatabaseConfig(cfg)
	if strings.TrimSpace(cfg.SourceConnID) == "" || strings.TrimSpace(cfg.TargetConnID) == "" {
		return fail("source and target connection IDs are required")
	}
	if strings.TrimSpace(cfg.SourceDB) == "" || strings.TrimSpace(cfg.TargetDB) == "" {
		return fail("source and target databases are required")
	}
	if cfg.SourceConnID == cfg.TargetConnID && cfg.SourceDB == cfg.TargetDB {
		return fail("source and target database must be different")
	}
	if !cfg.CopyStructure && !cfg.CopyData {
		return fail("at least one copy option must be selected")
	}

	sourceDB, ok := m.DB(cfg.SourceConnID)
	if !ok || sourceDB == nil {
		return fail("source connection %q not found", cfg.SourceConnID)
	}
	targetDB, ok := m.DB(cfg.TargetConnID)
	if !ok || targetDB == nil {
		return fail("target connection %q not found", cfg.TargetConnID)
	}

	progress("Reading source tables...", 0, 0)
	tables := cfg.Tables
	if len(tables) == 0 {
		var err error
		tables, err = listBaseTables(ctx, sourceDB, cfg.SourceDB)
		if err != nil {
			return fail("list source tables: %v", err)
		}
	}
	if len(tables) == 0 {
		progress("Copy complete", 0, 0)
		return CopyResult{Success: true, TimeMs: time.Since(start).Milliseconds()}
	}

	for i, table := range tables {
		table = strings.TrimSpace(table)
		if table == "" {
			continue
		}
		if cfg.CopyStructure && !cfg.DropTargetIfExists {
			exists, err := targetTableExists(ctx, targetDB, cfg.TargetDB, table)
			if err != nil {
				return fail("check target table %s: %v", table, err)
			}
			if exists {
				progress(fmt.Sprintf("Skipped existing table %s", table), i+1, len(tables))
				continue
			}
		}
		progress(fmt.Sprintf("Copying table %s...", table), i, len(tables))
		result := m.CopyTable(ctx, CopyTableConfig{
			SourceConnID:       cfg.SourceConnID,
			SourceDB:           cfg.SourceDB,
			SourceTable:        table,
			TargetConnID:       cfg.TargetConnID,
			TargetDB:           cfg.TargetDB,
			TargetTable:        table,
			CopyStructure:      cfg.CopyStructure,
			CopyData:           cfg.CopyData,
			DropTargetIfExists: cfg.DropTargetIfExists,
			BatchSize:          cfg.BatchSize,
		}, func(evt CopyProgressEvent) {
			status := evt.Status
			if status != "" {
				status = fmt.Sprintf("%s: %s", table, status)
			}
			progress(status, evt.ProcessedRows, evt.TotalRows)
		})
		if !result.Success {
			return fail("copy table %s: %s", table, result.Error)
		}
		progress(fmt.Sprintf("Copied table %s", table), i+1, len(tables))
	}

	progress("Copy complete", len(tables), len(tables))
	return CopyResult{Success: true, TimeMs: time.Since(start).Milliseconds()}
}

func listBaseTables(ctx context.Context, db *sql.DB, dbName string) ([]string, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
		dbName,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return tables, nil
}

func targetTableExists(ctx context.Context, db *sql.DB, dbName, tableName string) (bool, error) {
	var count int
	err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
		dbName,
		tableName,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func fetchCreateTableDDL(ctx context.Context, db *sql.DB, dbName, tableName string) (string, error) {
	row := db.QueryRowContext(ctx, fmt.Sprintf(
		"SHOW CREATE TABLE %s",
		qualifiedIdent(dbName, tableName),
	))

	var table string
	var ddl string
	if err := row.Scan(&table, &ddl); err != nil {
		return "", err
	}
	if strings.TrimSpace(ddl) == "" {
		return "", fmt.Errorf("SHOW CREATE TABLE returned empty DDL")
	}
	return ddl, nil
}

func qualifiedIdent(dbName, tableName string) string {
	return quoteIdent(dbName) + "." + quoteIdent(tableName)
}

var createTableTargetRE = regexp.MustCompile("(?is)^(\\s*CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(`(?:``|[^`])*`(?:\\s*\\.\\s*`(?:``|[^`])*`)?|[^\\s(]+(?:\\s*\\.\\s*[^\\s(]+)?)(\\s*\\()")

func rewriteCreateTableDDL(ddl, targetDB, targetTable string) (string, error) {
	target := qualifiedIdent(targetDB, targetTable)
	if !createTableTargetRE.MatchString(ddl) {
		return "", fmt.Errorf("unsupported CREATE TABLE DDL")
	}
	return createTableTargetRE.ReplaceAllString(ddl, "${1}"+target+"${3}"), nil
}

func copyTableData(
	ctx context.Context,
	sourceDB *sql.DB,
	targetDB *sql.DB,
	cfg CopyTableConfig,
	progress func(status string, processedRows, totalRows int),
) error {
	rows, err := sourceDB.QueryContext(ctx, fmt.Sprintf(
		"SELECT * FROM %s",
		qualifiedIdent(cfg.SourceDB, cfg.SourceTable),
	))
	if err != nil {
		return err
	}
	defer rows.Close()

	columns, err := rows.Columns()
	if err != nil {
		return fmt.Errorf("read source columns: %w", err)
	}
	if len(columns) == 0 {
		return fmt.Errorf("source query returned no columns")
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		return fmt.Errorf("read source column types: %w", err)
	}
	dbTypes := make([]string, len(columns))
	for i := range columns {
		if i < len(columnTypes) && columnTypes[i] != nil {
			dbTypes[i] = columnTypes[i].DatabaseTypeName()
		}
	}

	batch := make([][]any, 0, cfg.BatchSize)
	processedRows := 0

	rawValues := make([]sql.RawBytes, len(columns))
	scanDest := make([]any, len(columns))
	for i := range rawValues {
		scanDest[i] = &rawValues[i]
	}

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := insertBatch(ctx, targetDB, cfg.TargetDB, cfg.TargetTable, columns, batch); err != nil {
			return err
		}
		processedRows += len(batch)
		progress("Copying data...", processedRows, 0)
		batch = batch[:0]
		return nil
	}

	for rows.Next() {
		if err := rows.Scan(scanDest...); err != nil {
			return fmt.Errorf("scan source row: %w", err)
		}
		batch = append(batch, cloneRawRow(rawValues, dbTypes))
		if len(batch) >= cfg.BatchSize {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate source rows: %w", err)
	}
	return flush()
}

func cloneRawRow(rawValues []sql.RawBytes, dbTypes []string) []any {
	row := make([]any, len(rawValues))
	for i, raw := range rawValues {
		dbType := ""
		if i < len(dbTypes) {
			dbType = dbTypes[i]
		}
		row[i] = normalizeCopyValue(raw, dbType)
	}
	return row
}

func normalizeCopyValue(raw sql.RawBytes, dbType string) any {
	if raw == nil {
		return nil
	}
	copied := make([]byte, len(raw))
	copy(copied, raw)

	typ := strings.ToUpper(strings.TrimSpace(dbType))
	if !isTemporalCopyType(typ) {
		return copied
	}

	s := string(copied)
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return copied
	}
	if typ == "DATE" {
		return parsed.Format("2006-01-02")
	}
	formatted := parsed.Format("2006-01-02 15:04:05.999999")
	return strings.TrimRight(strings.TrimRight(formatted, "0"), ".")
}

func isTemporalCopyType(dbType string) bool {
	switch dbType {
	case "DATE", "DATETIME", "TIMESTAMP":
		return true
	default:
		return false
	}
}

func insertBatch(ctx context.Context, db *sql.DB, dbName, tableName string, columns []string, rows [][]any) error {
	stmt, args := buildBatchInsertSQL(dbName, tableName, columns, rows)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin target transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
		return fmt.Errorf("execute target insert: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit target transaction: %w", err)
	}
	committed = true
	return nil
}

func buildBatchInsertSQL(dbName, tableName string, columns []string, rows [][]any) (string, []any) {
	quotedCols := make([]string, len(columns))
	for i, col := range columns {
		quotedCols[i] = quoteIdent(col)
	}

	oneRow := "(" + strings.TrimRight(strings.Repeat("?, ", len(columns)), ", ") + ")"
	valueGroups := make([]string, len(rows))
	args := make([]any, 0, len(rows)*len(columns))
	for i, row := range rows {
		valueGroups[i] = oneRow
		args = append(args, row...)
	}

	stmt := fmt.Sprintf(
		"INSERT INTO %s (%s) VALUES %s",
		qualifiedIdent(dbName, tableName),
		strings.Join(quotedCols, ", "),
		strings.Join(valueGroups, ", "),
	)
	return stmt, args
}
