package database

// Schema crawler for GripLite — Phase 10.
//
// This file implements the metadata sync engine that pulls schema information
// from a live MySQL database and writes it to the local SQLite cache.
//
// # Design
//
// Unlike internal/cache/cache.go (which goes through the driver.DatabaseDriver
// abstraction layer), the crawler works directly on the *sql.DB obtained from
// the connection Manager.  This allows it to run the two optimised
// information_schema queries specified in the Phase 10 brief in a single pass
// rather than issuing per-table DESCRIBE / SHOW TABLE STATUS calls.
//
// # Data flow
//
//	information_schema.TABLES  ─┐
//	information_schema.COLUMNS ─┤→ in-memory maps → SQLite transaction
//	                             └─ (liveDB)               (cacheDB)
//
// # Cache tables written
//
//	metadata_cache    — one row per table, engine, size_bytes, columns_json
//	metadata_tables   — one row per table (for DatabaseExplorer tree)
//	metadata_columns  — one row per column (for autocomplete)
//	metadata_fts      — FTS5 shadow table (for autocomplete prefix search)
//	sync_log          — last-sync status for the connection
//
// All writes happen inside a single SQLite transaction per connection so the
// cache is always consistent (never partially written).
//
// # Thread safety
//
// SyncMetadata is safe to run from multiple goroutines with different connIDs.
// Concurrent syncs for the same connID are serialised by the caller (app.go
// tracks an in-progress set and skips duplicate requests).

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

// CachedTableEntry is the IPC-serialisable shape returned to the frontend by
// GetTablesFromCache.  It feeds both the left-side Database Explorer tree and
// the DatabaseViewer grid.
type CachedTableEntry struct {
	// TableName is the unqualified table / view name.
	TableName string `json:"tableName"`

	// Engine is the MySQL storage engine, e.g. "InnoDB" or "MyISAM".
	Engine string `json:"engine"`

	// SizeBytes is the on-disk size (data_length + index_length) in bytes.
	// -1 means the value was not available.
	SizeBytes int64 `json:"sizeBytes"`

	// Comment is the TABLE_COMMENT from information_schema.
	Comment string `json:"comment"`

	// Columns is populated only when the caller requests full schema detail.
	// For tree-rendering it is intentionally left nil to keep payloads small.
	Columns []CachedColumn `json:"columns,omitempty"`
}

// CachedColumn mirrors cache.CachedColumn so the frontend receives a uniform
// shape from both the old driver path and the new crawler path.
type CachedColumn struct {
	Ordinal  int    `json:"ordinal"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	IsPK     bool   `json:"isPrimaryKey"`
	Extra    string `json:"extra,omitempty"`
	Comment  string `json:"comment,omitempty"`
}

// SyncResult is returned by SyncMetadata to summarise the crawl.
type SyncResult struct {
	ConnID      string `json:"connId"`
	TablesCount int    `json:"tablesCount"`
	ColsCount   int    `json:"colsCount"`
	DurationMs  int64  `json:"durationMs"`
	Error       string `json:"error,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// SyncMetadata
// ─────────────────────────────────────────────────────────────────────────────

// SyncMetadata crawls the live database for connID and stores the results in
// the local SQLite cacheDB.
//
// Parameters:
//   - ctx      — parent context (cancelled on app shutdown or by the caller)
//   - connID   — the connection identifier used as the cache key
//   - liveDB   — the *sql.DB pool for the live MySQL server
//   - cacheDB  — the *sql.DB pool for the local griplite.db SQLite file
//
// The function is synchronous.  app.go runs it inside a goroutine so the
// Wails IPC call returns immediately while the sync continues in the
// background.
func SyncMetadata(ctx context.Context, connID string, liveDB *sql.DB, cacheDB *sql.DB) SyncResult {
	start := time.Now()
	res := SyncResult{ConnID: connID}

	log.Printf("[crawler] starting metadata sync for conn=%q", connID)

	// Mark sync as in-progress in sync_log so SyncState returns "syncing".
	_ = writeSyncLog(cacheDB, connID, 0, 0, "syncing", "")

	tables, cols, err := doSync(ctx, connID, liveDB, cacheDB)
	res.TablesCount = tables
	res.ColsCount = cols
	res.DurationMs = time.Since(start).Milliseconds()

	if err != nil {
		if ctx.Err() != nil {
			log.Printf("[crawler] sync for conn=%q cancelled", connID)
			_ = writeSyncLog(cacheDB, connID, tables, cols, "idle", "cancelled")
			res.Error = "cancelled"
			return res
		}
		log.Printf("[crawler] sync for conn=%q failed after %dms: %v", connID, res.DurationMs, err)
		_ = writeSyncLog(cacheDB, connID, tables, cols, "error", err.Error())
		res.Error = err.Error()
		return res
	}

	log.Printf("[crawler] sync done for conn=%q: %d tables, %d cols in %dms",
		connID, tables, cols, res.DurationMs)
	_ = writeSyncLog(cacheDB, connID, tables, cols, "done", "")
	return res
}

// ─────────────────────────────────────────────────────────────────────────────
// Core crawl logic
// ─────────────────────────────────────────────────────────────────────────────

type tableKey struct{ schema, table string }

// crawledTable holds one row from information_schema.TABLES.
type crawledTable struct {
	engine    string
	sizeBytes int64
	comment   string
}

// crawledColumn holds one row from information_schema.COLUMNS.
type crawledColumn struct {
	ordinal int
	name    string
	typ     string
	key     string // "PRI" | "UNI" | "MUL" | ""
	extra   string // "auto_increment" | ""
	comment string
}

func doSync(ctx context.Context, connID string, live *sql.DB, cache *sql.DB) (totalTables, totalCols int, err error) {
	// ── 1. Pull all user tables ──────────────────────────────────────────────
	tablesMeta, tableOrder, err := fetchTables(ctx, live)
	if err != nil {
		return 0, 0, fmt.Errorf("fetch tables: %w", err)
	}
	if ctx.Err() != nil {
		return 0, 0, ctx.Err()
	}

	// ── 2. Pull all user columns in one shot ─────────────────────────────────
	colsMeta, err := fetchColumns(ctx, live)
	if err != nil {
		return 0, 0, fmt.Errorf("fetch columns: %w", err)
	}
	if ctx.Err() != nil {
		return 0, 0, ctx.Err()
	}

	// ── 3. Write everything to SQLite in one transaction ─────────────────────
	tx, err := cache.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	// Prepare all statements once (faster than ExecContext inside a loop).
	stmts, closeStmts, prepErr := prepareStmts(ctx, tx)
	if prepErr != nil {
		return 0, 0, prepErr
	}
	defer closeStmts()

	now := time.Now().UTC().Format(time.RFC3339)

	// Clear stale data for this connection before re-inserting.
	for _, del := range []string{
		`DELETE FROM metadata_fts     WHERE conn_id = ?`,
		`DELETE FROM metadata_columns WHERE conn_id = ?`,
		`DELETE FROM metadata_tables  WHERE conn_id = ?`,
		`DELETE FROM metadata_cache   WHERE connection_id = ?`,
	} {
		if _, e := tx.ExecContext(ctx, del, connID); e != nil {
			return 0, 0, fmt.Errorf("clear stale (%s): %w", del[:30], e)
		}
	}

	// Iterate in insertion order so tree stays sorted as the server returns it.
	for _, key := range tableOrder {
		if ctx.Err() != nil {
			return totalTables, totalCols, ctx.Err()
		}

		tbl := tablesMeta[key]
		cols := colsMeta[key] // may be nil for views

		// Build columns JSON for metadata_cache.
		cachedCols := buildCachedColumns(cols)
		colsJSON, jsonErr := json.Marshal(cachedCols)
		if jsonErr != nil {
			colsJSON = []byte("[]")
		}

		isPK := isPKSet(cols)

		// metadata_cache — one blob row per table (fast Properties panel reads).
		// The `comment` column is populated verbatim; empty string when the
		// server reports no comment (Phase 15).
		if _, e := stmts.insCache.ExecContext(ctx,
			connID, key.schema, key.table,
			tbl.engine, tbl.sizeBytes, tbl.comment, string(colsJSON), now,
		); e != nil {
			return totalTables, totalCols, fmt.Errorf("insert metadata_cache %q.%q: %w", key.schema, key.table, e)
		}

		// metadata_tables — one row per table (Database Explorer + DatabaseViewer)
		if _, e := stmts.insTable.ExecContext(ctx,
			connID, key.schema, key.table, "table",
			-1, tbl.sizeBytes, tbl.comment, now,
		); e != nil {
			return totalTables, totalCols, fmt.Errorf("insert metadata_tables %q.%q: %w", key.schema, key.table, e)
		}
		totalTables++

		// metadata_columns + FTS — one row per column
		for _, col := range cols {
			nullable := 1 // columns are nullable by default
			pk := 0
			if col.key == "PRI" || isPK[col.name] {
				pk = 1
			}

			if _, e := stmts.insCol.ExecContext(ctx,
				connID, key.schema, key.table,
				col.name, col.typ, nullable, pk, col.ordinal, col.comment, now,
			); e != nil {
				return totalTables, totalCols, fmt.Errorf("insert col %q.%q.%q: %w", key.schema, key.table, col.name, e)
			}

			if _, e := stmts.insFTS.ExecContext(ctx,
				connID, key.schema, key.table,
				col.name, col.typ, pk,
			); e != nil {
				return totalTables, totalCols, fmt.Errorf("insert fts %q.%q.%q: %w", key.schema, key.table, col.name, e)
			}
			totalCols++
		}
	}

	if err = tx.Commit(); err != nil {
		return totalTables, totalCols, fmt.Errorf("commit: %w", err)
	}
	return totalTables, totalCols, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// information_schema queries
// ─────────────────────────────────────────────────────────────────────────────

// systemSchemas is the set of MySQL built-in schemas to exclude.
// Used as a literal IN-list in the two information_schema queries below.
const systemSchemas = `'information_schema','mysql','performance_schema','sys'`

const tablesQuery = `
SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE,
       COALESCE(DATA_LENGTH + INDEX_LENGTH, -1) AS size_bytes,
       COALESCE(TABLE_COMMENT, '')              AS comment
FROM   information_schema.TABLES
WHERE  TABLE_SCHEMA NOT IN (` + systemSchemas + `)
  AND  TABLE_TYPE IN ('BASE TABLE','VIEW')
ORDER  BY TABLE_SCHEMA, TABLE_NAME`

const columnsQuery = `
SELECT TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION,
       COLUMN_NAME, DATA_TYPE,
       COALESCE(COLUMN_KEY, '')     AS column_key,
       COALESCE(EXTRA, '')          AS extra,
       COALESCE(COLUMN_COMMENT, '') AS column_comment
FROM   information_schema.COLUMNS
WHERE  TABLE_SCHEMA NOT IN (` + systemSchemas + `)
ORDER  BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`

func fetchTables(ctx context.Context, db *sql.DB) (
	meta map[tableKey]crawledTable,
	order []tableKey,
	err error,
) {
	rows, err := db.QueryContext(ctx, tablesQuery)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	meta = make(map[tableKey]crawledTable)
	for rows.Next() {
		var schema, table, engine, comment string
		var size int64
		if err = rows.Scan(&schema, &table, &engine, &size, &comment); err != nil {
			return nil, nil, err
		}
		k := tableKey{schema, table}
		meta[k] = crawledTable{engine: engine, sizeBytes: size, comment: comment}
		order = append(order, k)
	}
	return meta, order, rows.Err()
}

func fetchColumns(ctx context.Context, db *sql.DB) (map[tableKey][]crawledColumn, error) {
	rows, err := db.QueryContext(ctx, columnsQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	m := make(map[tableKey][]crawledColumn)
	for rows.Next() {
		var schema, table, colName, dataType, colKey, extra, comment string
		var ordinal int
		if err = rows.Scan(&schema, &table, &ordinal, &colName, &dataType, &colKey, &extra, &comment); err != nil {
			return nil, err
		}
		k := tableKey{schema, table}
		m[k] = append(m[k], crawledColumn{
			ordinal: ordinal,
			name:    colName,
			typ:     dataType,
			key:     colKey,
			extra:   extra,
			comment: comment,
		})
	}
	return m, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Prepared statement helpers
// ─────────────────────────────────────────────────────────────────────────────

type preparedStmts struct {
	insCache *sql.Stmt
	insTable *sql.Stmt
	insCol   *sql.Stmt
	insFTS   *sql.Stmt
}

func prepareStmts(ctx context.Context, tx *sql.Tx) (preparedStmts, func(), error) {
	var s preparedStmts
	var err error

	s.insCache, err = tx.PrepareContext(ctx, `
		INSERT OR REPLACE INTO metadata_cache
		    (connection_id, db_name, table_name, engine, size_bytes, comment, columns_json, sync_time)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return s, func() {}, fmt.Errorf("prepare insCache: %w", err)
	}

	s.insTable, err = tx.PrepareContext(ctx, `
		INSERT OR REPLACE INTO metadata_tables
		    (conn_id, db_name, table_name, kind, row_count, size_bytes, comment, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return s, func() {}, fmt.Errorf("prepare insTable: %w", err)
	}

	s.insCol, err = tx.PrepareContext(ctx, `
		INSERT OR REPLACE INTO metadata_columns
		    (conn_id, db_name, table_name, column_name, column_type,
		     is_nullable, is_pk, ordinal, comment, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return s, func() {}, fmt.Errorf("prepare insCol: %w", err)
	}

	s.insFTS, err = tx.PrepareContext(ctx, `
		INSERT INTO metadata_fts
		    (conn_id, db_name, table_name, column_name, column_type, is_pk)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return s, func() {}, fmt.Errorf("prepare insFTS: %w", err)
	}

	closeAll := func() {
		if s.insCache != nil {
			_ = s.insCache.Close()
		}
		if s.insTable != nil {
			_ = s.insTable.Close()
		}
		if s.insCol != nil {
			_ = s.insCol.Close()
		}
		if s.insFTS != nil {
			_ = s.insFTS.Close()
		}
	}
	return s, closeAll, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GetTablesFromCache — fast tree rendering (sub-millisecond)
// ─────────────────────────────────────────────────────────────────────────────

// GetTablesFromCache reads the cached table list for (connID, dbName) from the
// local SQLite database.
//
// Returns entries sorted by table name.  The Columns field is nil to keep
// payloads small — call GetTableDetailFromCache for per-table column info.
//
// Pass dbName="" to get tables for ALL schemas under connID (useful for
// DatabaseViewer's full grid).
func GetTablesFromCache(ctx context.Context, cacheDB *sql.DB, connID, dbName string) ([]CachedTableEntry, error) {
	var rows *sql.Rows
	var err error

	// COALESCE protects rows written before the `comment` column migration
	// landed (NULL on SQLite when a column was added without a default).
	if dbName == "" {
		rows, err = cacheDB.QueryContext(ctx, `
			SELECT table_name, engine, size_bytes, COALESCE(comment, '') AS comment
			FROM   metadata_cache
			WHERE  connection_id = ?
			ORDER  BY db_name, table_name`,
			connID)
	} else {
		rows, err = cacheDB.QueryContext(ctx, `
			SELECT table_name, engine, size_bytes, COALESCE(comment, '') AS comment
			FROM   metadata_cache
			WHERE  connection_id = ? AND db_name = ?
			ORDER  BY table_name`,
			connID, dbName)
	}
	if err != nil {
		return nil, fmt.Errorf("GetTablesFromCache: %w", err)
	}
	defer rows.Close()

	var entries []CachedTableEntry
	for rows.Next() {
		var e CachedTableEntry
		if err = rows.Scan(&e.TableName, &e.Engine, &e.SizeBytes, &e.Comment); err != nil {
			return nil, fmt.Errorf("GetTablesFromCache scan: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// GetTableDetailFromCache returns the full column list for a single table from
// the metadata_cache JSON blob.  Response time is typically < 1 ms.
func GetTableDetailFromCache(ctx context.Context, cacheDB *sql.DB, connID, dbName, tableName string) (*CachedTableEntry, error) {
	row := cacheDB.QueryRowContext(ctx, `
		SELECT table_name, engine, size_bytes, COALESCE(comment, '') AS comment, columns_json
		FROM   metadata_cache
		WHERE  connection_id = ? AND db_name = ? AND table_name = ?`,
		connID, dbName, tableName)

	var e CachedTableEntry
	var colsJSON string
	if err := row.Scan(&e.TableName, &e.Engine, &e.SizeBytes, &e.Comment, &colsJSON); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // cache miss — caller should trigger a sync
		}
		return nil, fmt.Errorf("GetTableDetailFromCache: %w", err)
	}

	if err := json.Unmarshal([]byte(colsJSON), &e.Columns); err != nil {
		e.Columns = nil // treat bad JSON as empty — not fatal
	}
	return &e, nil
}

// GetDatabasesFromCache returns the distinct schema names cached under connID.
// The list is sorted alphabetically.  Returns an empty slice (not nil) when
// the cache is empty, so the frontend always gets a valid JSON array.
func GetDatabasesFromCache(ctx context.Context, cacheDB *sql.DB, connID string) ([]string, error) {
	rows, err := cacheDB.QueryContext(ctx, `
		SELECT DISTINCT db_name
		FROM   metadata_cache
		WHERE  connection_id = ?
		ORDER  BY db_name`,
		connID)
	if err != nil {
		return nil, fmt.Errorf("GetDatabasesFromCache: %w", err)
	}
	defer rows.Close()

	var dbs []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			return nil, err
		}
		dbs = append(dbs, name)
	}
	if dbs == nil {
		dbs = []string{}
	}
	return dbs, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// buildCachedColumns converts raw crawled columns into the JSON-friendly type.
func buildCachedColumns(cols []crawledColumn) []CachedColumn {
	out := make([]CachedColumn, 0, len(cols))
	for _, c := range cols {
		out = append(out, CachedColumn{
			Ordinal:  c.ordinal,
			Name:     c.name,
			Type:     c.typ,
			Nullable: true, // information_schema doesn't give nullable in this query; default true
			IsPK:     c.key == "PRI",
			Extra:    c.extra,
			Comment:  c.comment,
		})
	}
	return out
}

// isPKSet builds a quick lookup of primary-key column names for the table.
func isPKSet(cols []crawledColumn) map[string]bool {
	m := make(map[string]bool, 2)
	for _, c := range cols {
		if c.key == "PRI" {
			m[c.name] = true
		}
	}
	return m
}

// writeSyncLog upserts a row in sync_log with the given status.
// Column names match internal/cache/cache.go so SyncState reads it correctly.
func writeSyncLog(db *sql.DB, connID string, tables, cols int, status, errMsg string) error {
	_, err := db.Exec(`
		INSERT INTO sync_log (conn_id, last_sync_at, tables_count, cols_count, status, error_msg)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(conn_id) DO UPDATE SET
		    last_sync_at  = excluded.last_sync_at,
		    tables_count  = excluded.tables_count,
		    cols_count    = excluded.cols_count,
		    status        = excluded.status,
		    error_msg     = excluded.error_msg`,
		connID, time.Now().UTC().Format(time.RFC3339),
		tables, cols, status, errMsg)
	return err
}
