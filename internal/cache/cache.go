// Package cache implements the local SQLite metadata cache for GripLite.
//
// The cache stores database schema information (databases, tables, columns)
// fetched from live drivers so that:
//
//  1. Monaco Editor can provide instant (sub-millisecond) autocomplete
//     suggestions without issuing live database queries on every keystroke.
//  2. The Database Explorer tree can be re-populated offline (without a live
//     connection).
//
// # Storage layout
//
//	~/.cache/GripLite/metadata.db   (Linux/macOS)
//	%LOCALAPPDATA%\GripLite\metadata.db  (Windows)
//
// # Schema
//
//	metadata_tables   — one row per table / collection
//	metadata_columns  — one row per column, FK to metadata_tables
//	metadata_fts      — FTS5 virtual table for sub-ms prefix search
//	sync_log          — one row per connection, tracks last successful sync
//
// # Thread safety
//
// [MetadataCache] is safe for concurrent use. The underlying *sql.DB
// connection pool is protected by database/sql's own mutex. The per-connection
// sync goroutines are coordinated via the cancels map + mu.
package cache

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite" // registers "sqlite" driver with database/sql

	"GripLite/internal/driver"
)

// ─────────────────────────────────────────────────────────────────────────────
// DDL
// ─────────────────────────────────────────────────────────────────────────────

// Each statement is separated by ";\n" so we can split and execute individually.
const schemaDDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata_tables (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    conn_id        TEXT    NOT NULL,
    db_name        TEXT    NOT NULL,
    table_name     TEXT    NOT NULL,
    kind           TEXT    NOT NULL DEFAULT 'table',
    row_count      INTEGER NOT NULL DEFAULT -1,
    size_bytes     INTEGER NOT NULL DEFAULT -1,
    comment        TEXT    NOT NULL DEFAULT '',
    engine         TEXT    NOT NULL DEFAULT '',
    charset        TEXT    NOT NULL DEFAULT '',
    collation      TEXT    NOT NULL DEFAULT '',
    auto_increment INTEGER,
    synced_at      TEXT    NOT NULL,
    UNIQUE(conn_id, db_name, table_name)
);

CREATE INDEX IF NOT EXISTS idx_mt_lookup
    ON metadata_tables(conn_id, db_name);

CREATE INDEX IF NOT EXISTS idx_mt_name
    ON metadata_tables(table_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS metadata_columns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    conn_id     TEXT    NOT NULL,
    db_name     TEXT    NOT NULL,
    table_name  TEXT    NOT NULL,
    column_name TEXT    NOT NULL,
    column_type TEXT    NOT NULL DEFAULT '',
    is_nullable INTEGER NOT NULL DEFAULT 0,
    is_pk       INTEGER NOT NULL DEFAULT 0,
    comment     TEXT    NOT NULL DEFAULT '',
    synced_at   TEXT    NOT NULL,
    UNIQUE(conn_id, db_name, table_name, column_name)
);

CREATE INDEX IF NOT EXISTS idx_mc_lookup
    ON metadata_columns(conn_id, db_name, table_name);

CREATE INDEX IF NOT EXISTS idx_mc_col_name
    ON metadata_columns(column_name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_mc_tbl_name
    ON metadata_columns(table_name COLLATE NOCASE);

CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(
    conn_id    UNINDEXED,
    db_name,
    table_name,
    column_name,
    column_type UNINDEXED,
    is_pk       UNINDEXED,
    tokenize   = 'unicode61 remove_diacritics 1'
);

CREATE TABLE IF NOT EXISTS sync_log (
    conn_id       TEXT PRIMARY KEY,
    last_sync_at  TEXT NOT NULL,
    tables_count  INTEGER NOT NULL DEFAULT 0,
    cols_count    INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'done',
    error_msg     TEXT NOT NULL DEFAULT ''
);
`

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

// CompletionItem is the IPC-serialisable unit returned to Monaco Editor.
type CompletionItem struct {
	// Kind is "table" or "column".
	Kind string `json:"kind"`

	// Label is the identifier to insert (table name or column name).
	Label string `json:"label"`

	// Detail is shown in the Monaco suggestion widget's secondary line.
	// For columns: the SQL type (e.g. "VARCHAR(255) NOT NULL").
	// For tables: the database name.
	Detail string `json:"detail"`

	// DBName is the owning database / schema.
	DBName string `json:"dbName"`

	// TableName is the owning table (empty for table-kind items).
	TableName string `json:"tableName"`

	// IsPrimaryKey flags PK columns so the UI can render a key icon.
	IsPrimaryKey bool `json:"isPrimaryKey"`
}

// SyncStatus is returned by SyncState so the UI can show a progress indicator.
type SyncStatus struct {
	ConnID      string `json:"connId"`
	State       string `json:"state"` // "idle" | "syncing" | "done" | "error"
	TablesCount int    `json:"tablesCount"`
	ColsCount   int    `json:"colsCount"`
	LastSyncAt  string `json:"lastSyncAt"`
	ErrorMsg    string `json:"errorMsg,omitempty"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached schema types — used by GetTableSchema
// ─────────────────────────────────────────────────────────────────────────────

// CachedColumn is one column's metadata as stored in the local SQLite mirror.
// The Ordinal field reflects the column's position in the DDL (1-based).
type CachedColumn struct {
	Ordinal  int    `json:"ordinal"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	IsPK     bool   `json:"isPrimaryKey"`
	// Comment is the per-column description (COLUMN_COMMENT) — empty string
	// when the server reports no comment.  Added in Phase 15 so the
	// Properties panel's Columns grid can render a Comment column.
	Comment string `json:"comment"`
}

// CachedTableSchema is the IPC-serialisable table-properties snapshot that the
// TableViewer's Properties panel consumes.  It is read entirely from the local
// SQLite cache so the round-trip cost is < 1 ms regardless of database size or
// network latency.
//
// If Found is false the table was not present in the cache at query time,
// which means either the schema sync has not run yet for this connection or
// the table name / database name was misspelled.
type CachedTableSchema struct {
	// Found is false when the cache does not contain the requested table.
	// The Properties panel should show a "Cache not synced" hint in this case.
	Found bool `json:"found"`

	ConnID    string `json:"connId"`
	DBName    string `json:"dbName"`
	TableName string `json:"tableName"`

	// Kind is "table", "view", or "collection" depending on the driver.
	Kind string `json:"kind"`

	// RowCount is the approximate row count captured at sync time.
	// -1 means the count was not fetched.
	RowCount int64 `json:"rowCount"`

	// SizeBytes is the on-disk size (data + index bytes) captured at sync time.
	// -1 means the driver did not supply size information.
	SizeBytes int64 `json:"sizeBytes"`

	// SyncedAt is the RFC3339 timestamp of the last successful sync.
	SyncedAt string `json:"syncedAt"`

	// Comment is the TABLE_COMMENT captured at sync time (Phase 15).
	// Empty string when the server has no comment for this table.
	Comment string `json:"comment"`

	// Engine is the storage engine captured at sync time (MySQL InnoDB,
	// MyISAM, …).  Empty string when the driver does not expose this or
	// the cache row was written before Phase 24.
	Engine string `json:"engine"`

	// Charset is the default charset (e.g. "utf8mb4").  Empty when
	// unavailable.  Derived from the collation on MySQL.
	Charset string `json:"charset"`

	// Collation is the default collation (e.g. "utf8mb4_unicode_ci").
	// Empty when unavailable.
	Collation string `json:"collation"`

	// AutoIncrement is the next AUTO_INCREMENT counter, or nil when the
	// table has no AI column or the driver does not expose it.
	AutoIncrement *int64 `json:"autoIncrement"`

	// Columns is the ordered list of column descriptors.
	Columns []CachedColumn `json:"columns"`
}

// ─────────────────────────────────────────────────────────────────────────────
// MetadataCache
// ─────────────────────────────────────────────────────────────────────────────

// MetadataCache manages the local SQLite schema mirror.
type MetadataCache struct {
	db    *sql.DB
	ownDB bool // true when New opened the DB and Close should shut it down

	mu      sync.Mutex
	cancels map[string]context.CancelFunc // keyed by conn_id; cancel to stop the goroutine
	syncing map[string]bool               // true while the goroutine is running
}

// NewFromDB creates a MetadataCache that operates on a shared *sql.DB
// (typically the unified griplite.db opened by internal/db.Open).
//
// The extended schema (metadata_tables, metadata_columns, FTS, sync_log) is
// applied to the shared DB so all tables coexist in one file.  This is the
// preferred constructor in the normal application startup path.
func NewFromDB(db *sql.DB) (*MetadataCache, error) {
	if err := applySchema(db); err != nil {
		return nil, fmt.Errorf("cache: apply schema to shared DB: %w", err)
	}
	return &MetadataCache{
		db:      db,
		cancels: make(map[string]context.CancelFunc),
		syncing: make(map[string]bool),
		ownDB:   false,
	}, nil
}

// New opens (or creates) the SQLite metadata database and applies the schema.
// dbPath is the filesystem path of the .db file; pass "" to use the default
// OS-appropriate location (~/.cache/GripLite/metadata.db on Linux/macOS).
//
// Use [NewFromDB] instead when a shared *sql.DB is already available (e.g.
// the unified griplite.db).
func New(dbPath string) (*MetadataCache, error) {
	if dbPath == "" {
		var err error
		dbPath, err = defaultDBPath()
		if err != nil {
			return nil, fmt.Errorf("cache: resolve db path: %w", err)
		}
	}

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("cache: mkdir %q: %w", filepath.Dir(dbPath), err)
	}

	// modernc.org/sqlite registers itself as "sqlite" (not "sqlite3").
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("cache: open %q: %w", dbPath, err)
	}

	// SQLite works best with a single writer connection to avoid SQLITE_BUSY.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0) // keep connection alive for the app's lifetime

	if err := applySchema(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("cache: apply schema: %w", err)
	}

	return &MetadataCache{
		db:      db,
		cancels: make(map[string]context.CancelFunc),
		syncing: make(map[string]bool),
		ownDB:   true,
	}, nil
}

// Close shuts down all background sync goroutines and closes the database.
// When the MetadataCache was created via [NewFromDB] the DB is NOT closed
// because the caller owns it; only background goroutines are cancelled.
func (c *MetadataCache) Close() error {
	c.mu.Lock()
	for id, cancel := range c.cancels {
		cancel()
		delete(c.cancels, id)
	}
	c.mu.Unlock()
	if c.ownDB {
		return c.db.Close()
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// SyncSchema — background goroutine
// ─────────────────────────────────────────────────────────────────────────────

// SyncSchema starts a background goroutine that fetches the full schema from
// drv and writes it to the local SQLite cache.
//
// Design decisions:
//
//   - Only one sync per connID runs at a time; calling SyncSchema again
//     cancels the previous goroutine for the same connection.
//   - All writes for a single database are batched inside one SQLite
//     transaction to minimise fsync overhead (thousands of rows in < 100 ms).
//   - Errors are logged and recorded in sync_log but never crash the app.
//   - The parent ctx (app shutdown signal) cancels all syncs when the app exits.
func (c *MetadataCache) SyncSchema(parentCtx context.Context, connID string, drv driver.DatabaseDriver) {
	// Cancel any previous sync for this connection.
	c.mu.Lock()
	if prev, ok := c.cancels[connID]; ok {
		prev()
	}
	ctx, cancel := context.WithCancel(parentCtx)
	c.cancels[connID] = cancel
	c.syncing[connID] = true
	c.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			c.mu.Lock()
			delete(c.cancels, connID)
			c.syncing[connID] = false
			c.mu.Unlock()
		}()

		if err := c.syncSchema(ctx, connID, drv); err != nil {
			if ctx.Err() != nil {
				return // cancelled — not an error
			}
			log.Printf("[cache] SyncSchema %q failed: %v", connID, err)
			_ = c.writeSyncLog(connID, 0, 0, "error", err.Error())
		}
	}()
}

// syncSchema is the synchronous body of the sync goroutine.
func (c *MetadataCache) syncSchema(ctx context.Context, connID string, drv driver.DatabaseDriver) error {
	log.Printf("[cache] starting schema sync for conn=%q", connID)

	// ── 1. Fetch all database names ─────────────────────────────────────────
	databases, err := drv.FetchDatabases(ctx)
	if err != nil {
		return fmt.Errorf("FetchDatabases: %w", err)
	}

	// System databases that contain no user objects — skip them.
	skip := map[string]bool{
		"information_schema": true,
		"performance_schema": true,
		"sys":                true,
		"mysql":              true,
	}

	var totalTables, totalCols int

	for _, dbName := range databases {
		if skip[dbName] {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}

		tables, cols, err := c.syncDatabase(ctx, connID, dbName, drv)
		if err != nil {
			// Log per-database errors but continue with the next database.
			log.Printf("[cache] syncDatabase %q.%q: %v", connID, dbName, err)
			continue
		}
		totalTables += tables
		totalCols += cols
	}

	log.Printf("[cache] sync done for conn=%q: %d tables, %d columns",
		connID, totalTables, totalCols)
	return c.writeSyncLog(connID, totalTables, totalCols, "done", "")
}

// syncDatabase fetches and caches all tables + columns for a single database.
// All SQLite writes happen inside a single transaction for performance.
func (c *MetadataCache) syncDatabase(
	ctx context.Context,
	connID, dbName string,
	drv driver.DatabaseDriver,
) (tableCount, colCount int, err error) {

	// ── 2. Fetch table list ──────────────────────────────────────────────────
	tables, err := drv.FetchTables(ctx, dbName)
	if err != nil {
		return 0, 0, fmt.Errorf("FetchTables: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)

	// ── 3. Open a single write transaction for the whole database ───────────
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	// Delete stale rows for this (connID, dbName) so renamed / dropped objects
	// are removed from the cache.
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM metadata_fts
		 WHERE conn_id = ? AND db_name = ?`, connID, dbName); err != nil {
		return 0, 0, fmt.Errorf("delete fts: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM metadata_columns
		 WHERE conn_id = ? AND db_name = ?`, connID, dbName); err != nil {
		return 0, 0, fmt.Errorf("delete columns: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM metadata_tables
		 WHERE conn_id = ? AND db_name = ?`, connID, dbName); err != nil {
		return 0, 0, fmt.Errorf("delete tables: %w", err)
	}

	// Prepare reusable insert statements inside the transaction.
	// Phase 15: both metadata_tables and metadata_columns now carry a
	// `comment` column sourced from information_schema (TABLE_COMMENT /
	// COLUMN_COMMENT).
	stmtTable, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO metadata_tables
		    (conn_id, db_name, table_name, kind, row_count, size_bytes,
		     comment, engine, charset, collation, auto_increment, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, fmt.Errorf("prepare table stmt: %w", err)
	}
	defer stmtTable.Close()

	stmtCol, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO metadata_columns
		    (conn_id, db_name, table_name, column_name, column_type,
		     is_nullable, is_pk, comment, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, fmt.Errorf("prepare col stmt: %w", err)
	}
	defer stmtCol.Close()

	// FTS insert — mirrors metadata_columns row.
	stmtFTS, err := tx.PrepareContext(ctx, `
		INSERT INTO metadata_fts
		    (conn_id, db_name, table_name, column_name, column_type, is_pk)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, fmt.Errorf("prepare fts stmt: %w", err)
	}
	defer stmtFTS.Close()

	// ── 4. Iterate tables, fetch columns, insert everything ─────────────────
	for _, tbl := range tables {
		if ctx.Err() != nil {
			return 0, 0, ctx.Err()
		}

		// AutoIncrement is *int64; the sql driver handles nil → SQL NULL.
		var aiArg any
		if tbl.AutoIncrement != nil {
			aiArg = *tbl.AutoIncrement
		}
		if _, err = stmtTable.ExecContext(ctx,
			connID, dbName, tbl.Name, string(tbl.Kind), tbl.RowCount, tbl.SizeBytes,
			tbl.Comment, tbl.Engine, tbl.Charset, tbl.Collation, aiArg, now,
		); err != nil {
			return 0, 0, fmt.Errorf("insert table %q: %w", tbl.Name, err)
		}
		tableCount++

		// Fetch full column detail for this table.
		detail, detailErr := drv.FetchTableDetail(ctx, dbName, tbl.Name)
		if detailErr != nil {
			// Views / certain table types may not be introspectable; skip them.
			log.Printf("[cache] FetchTableDetail %q.%q: %v (skipped)", dbName, tbl.Name, detailErr)
			continue
		}

		for _, col := range detail.Columns {
			nullable := 0
			if col.Nullable {
				nullable = 1
			}
			isPK := 0
			if col.PrimaryKey {
				isPK = 1
			}

			if _, err = stmtCol.ExecContext(ctx,
				connID, dbName, tbl.Name, col.Name, col.DatabaseType,
				nullable, isPK, col.Comment, now,
			); err != nil {
				return 0, 0, fmt.Errorf("insert column %q.%q: %w", tbl.Name, col.Name, err)
			}

			if _, err = stmtFTS.ExecContext(ctx,
				connID, dbName, tbl.Name, col.Name, col.DatabaseType, isPK,
			); err != nil {
				return 0, 0, fmt.Errorf("insert fts %q.%q: %w", tbl.Name, col.Name, err)
			}

			colCount++
		}
	}

	if err = tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("commit: %w", err)
	}
	return tableCount, colCount, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// RefreshTable — targeted single-table re-crawl (Phase 20)
//
// Used after a successful ALTER TABLE so the Properties panel immediately
// reflects the new columns without waiting for a full SyncSchema pass.
// Scope is strictly one (connID, dbName, tableName): other tables /
// databases are untouched, so this is cheap enough to run synchronously
// on the UI's save path.
//
// The method is tolerant of a dropped table — if FetchTableDetail returns
// an error the existing cache rows for that table are still purged so the
// UI doesn't keep showing a ghost schema.
// ─────────────────────────────────────────────────────────────────────────────
func (c *MetadataCache) RefreshTable(
	ctx context.Context,
	connID, dbName, tableName string,
	drv driver.DatabaseDriver,
) error {
	if c == nil || c.db == nil {
		return fmt.Errorf("cache not initialised")
	}
	if connID == "" || dbName == "" || tableName == "" {
		return fmt.Errorf("RefreshTable: connID/dbName/tableName required")
	}

	detail, detailErr := drv.FetchTableDetail(ctx, dbName, tableName)
	// detailErr is handled after the delete pass so that a drop still
	// evicts stale rows.

	now := time.Now().UTC().Format(time.RFC3339)

	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	// Evict existing rows for this specific table — FTS + columns.  The
	// metadata_tables row is left intact because table-level stats
	// (row_count, size_bytes) are the responsibility of a full crawl;
	// refreshing only columns is both faster and avoids trashing the
	// stale-but-still-useful row count for the tree UI.
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM metadata_fts
		 WHERE conn_id = ? AND db_name = ? AND table_name = ?`,
		connID, dbName, tableName); err != nil {
		return fmt.Errorf("delete fts: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM metadata_columns
		 WHERE conn_id = ? AND db_name = ? AND table_name = ?`,
		connID, dbName, tableName); err != nil {
		return fmt.Errorf("delete columns: %w", err)
	}

	if detailErr != nil {
		// Caller may be handling a DROP TABLE; commit the deletions and
		// surface the error so the UI can decide whether to show it.
		if commitErr := tx.Commit(); commitErr != nil {
			return fmt.Errorf("commit (after detail err %v): %w", detailErr, commitErr)
		}
		return fmt.Errorf("FetchTableDetail: %w", detailErr)
	}

	// Refresh the table-level metadata — COMMENT / ENGINE / CHARSET /
	// COLLATION / AUTO_INCREMENT may have all moved after an ALTER.
	// We update only the mutable columns; synced_at stays truthful for
	// what has actually been refreshed.  When the driver did not surface
	// a field (empty string / nil pointer) we skip overwriting the
	// previously cached value to avoid blanking out good data.
	var aiArg any
	if detail.AutoIncrement != nil {
		aiArg = *detail.AutoIncrement
	}
	if _, err = tx.ExecContext(ctx,
		`UPDATE metadata_tables
		    SET comment        = ?,
		        engine         = CASE WHEN ? = '' THEN engine    ELSE ? END,
		        charset        = CASE WHEN ? = '' THEN charset   ELSE ? END,
		        collation      = CASE WHEN ? = '' THEN collation ELSE ? END,
		        auto_increment = COALESCE(?, auto_increment),
		        synced_at      = ?
		  WHERE conn_id = ? AND db_name = ? AND table_name = ?`,
		detail.Comment,
		detail.Engine, detail.Engine,
		detail.Charset, detail.Charset,
		detail.Collation, detail.Collation,
		aiArg,
		now,
		connID, dbName, tableName); err != nil {
		return fmt.Errorf("update table row: %w", err)
	}

	stmtCol, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO metadata_columns
		    (conn_id, db_name, table_name, column_name, column_type,
		     is_nullable, is_pk, comment, synced_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare col stmt: %w", err)
	}
	defer stmtCol.Close()

	stmtFTS, err := tx.PrepareContext(ctx, `
		INSERT INTO metadata_fts
		    (conn_id, db_name, table_name, column_name, column_type, is_pk)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return fmt.Errorf("prepare fts stmt: %w", err)
	}
	defer stmtFTS.Close()

	for _, col := range detail.Columns {
		nullable := 0
		if col.Nullable {
			nullable = 1
		}
		isPK := 0
		if col.PrimaryKey {
			isPK = 1
		}
		if _, err = stmtCol.ExecContext(ctx,
			connID, dbName, tableName, col.Name, col.DatabaseType,
			nullable, isPK, col.Comment, now,
		); err != nil {
			return fmt.Errorf("insert column %q: %w", col.Name, err)
		}
		if _, err = stmtFTS.ExecContext(ctx,
			connID, dbName, tableName, col.Name, col.DatabaseType, isPK,
		); err != nil {
			return fmt.Errorf("insert fts %q: %w", col.Name, err)
		}
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GetTableSchema — instant Properties panel data from SQLite
// ─────────────────────────────────────────────────────────────────────────────

// GetTableSchema returns the cached schema for a single table without touching
// the live database.  Typical execution time is well under 1 ms because it
// reads from the local SQLite file using indexed lookups.
//
// When the cache has not been populated for this table yet (Found == false in
// the returned struct) the caller should prompt the user to trigger a sync or
// fall back to a live SHOW TABLE STATUS / DESCRIBE query.
func (c *MetadataCache) GetTableSchema(
	ctx context.Context,
	connID, dbName, tableName string,
) (*CachedTableSchema, error) {
	schema := &CachedTableSchema{
		ConnID:    connID,
		DBName:    dbName,
		TableName: tableName,
	}

	// ── 1. Table-level metadata ──────────────────────────────────────────────
	// COALESCE protects rows written before Phase 15/24 migrations added
	// their columns — older griplite.db files may have NULL for the newer
	// fields.  auto_increment is a nullable INTEGER: NULL → *int64 nil.
	row := c.db.QueryRowContext(ctx, `
		SELECT kind, row_count, size_bytes,
		       COALESCE(comment,   ''),
		       COALESCE(engine,    ''),
		       COALESCE(charset,   ''),
		       COALESCE(collation, ''),
		       auto_increment,
		       synced_at
		FROM   metadata_tables
		WHERE  conn_id = ? AND db_name = ? AND table_name = ?`,
		connID, dbName, tableName)

	var autoInc sql.NullInt64
	if err := row.Scan(
		&schema.Kind, &schema.RowCount, &schema.SizeBytes,
		&schema.Comment, &schema.Engine, &schema.Charset, &schema.Collation,
		&autoInc, &schema.SyncedAt,
	); err != nil {
		if err == sql.ErrNoRows {
			return schema, nil // Found remains false — cache not synced for this table
		}
		return nil, fmt.Errorf("cache: get table %q.%q: %w", dbName, tableName, err)
	}
	if autoInc.Valid {
		v := autoInc.Int64
		schema.AutoIncrement = &v
	}
	schema.Found = true

	// ── 2. Column metadata (DDL-order via rowid) ─────────────────────────────
	// We order by rowid which matches the insertion order from syncDatabase
	// (columns are inserted in DDL/DESCRIBE order during the sync pass).
	rows, err := c.db.QueryContext(ctx, `
		SELECT column_name, column_type, is_nullable, is_pk, COALESCE(comment, '')
		FROM   metadata_columns
		WHERE  conn_id = ? AND db_name = ? AND table_name = ?
		ORDER  BY rowid`,
		connID, dbName, tableName)
	if err != nil {
		return nil, fmt.Errorf("cache: get columns %q.%q: %w", dbName, tableName, err)
	}
	defer rows.Close()

	for ordinal := 1; rows.Next(); ordinal++ {
		var col CachedColumn
		var nullable, isPK int
		if err := rows.Scan(&col.Name, &col.Type, &nullable, &isPK, &col.Comment); err != nil {
			return nil, fmt.Errorf("cache: scan column: %w", err)
		}
		col.Ordinal  = ordinal
		col.Nullable = nullable == 1
		col.IsPK     = isPK == 1
		schema.Columns = append(schema.Columns, col)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("cache: iterate columns: %w", err)
	}

	return schema, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchColumns — FTS-powered autocomplete
// ─────────────────────────────────────────────────────────────────────────────

// SearchColumns returns autocomplete candidates for the given keyword.
//
// Strategy (two-pass):
//  1. FTS5 prefix search on the metadata_fts virtual table — handles typos,
//     diacritics, and word-boundary matching with sub-millisecond latency.
//  2. If the FTS result set is empty (or the FTS table is not yet populated),
//     fall back to a LIKE search on the indexed metadata_columns table.
//
// Results include both column-kind items (with parent table / type info)
// and table-kind items so Monaco can complete bare table names too.
//
// keyword may be a partial identifier (e.g. "use", "ord").
// The search is case-insensitive.
func (c *MetadataCache) SearchColumns(ctx context.Context, connID, keyword string) ([]CompletionItem, error) {
	if keyword == "" {
		return nil, nil
	}

	items, err := c.ftsSearch(ctx, connID, keyword)
	if err != nil || len(items) == 0 {
		// Fall back to LIKE for robustness (FTS may still be building).
		return c.likeSearch(ctx, connID, keyword)
	}
	return items, nil
}

// ftsSearch uses the FTS5 virtual table for prefix matching.
// The FTS5 MATCH syntax 'keyword*' matches any token starting with keyword.
func (c *MetadataCache) ftsSearch(ctx context.Context, connID, keyword string) ([]CompletionItem, error) {
	// FTS5 requires the match token to not start with punctuation; guard against
	// empty or special inputs that would produce a syntax error.
	token := strings.TrimSpace(keyword)
	if token == "" {
		return nil, nil
	}
	// Escape double-quotes inside the token (FTS5 phrase syntax).
	token = strings.ReplaceAll(token, `"`, `""`)
	ftsQuery := fmt.Sprintf(`"%s"*`, token) // prefix match

	// SQLite disallows LIMIT on a bare compound arm; each SELECT that needs
	// its own LIMIT must be wrapped in a sub-SELECT.
	const q = `
		SELECT * FROM (
		    SELECT
		        'column'    AS kind,
		        column_name AS label,
		        column_type || CASE CAST(is_pk AS INTEGER) WHEN 1 THEN ' (PK)' ELSE '' END AS detail,
		        db_name,
		        table_name,
		        CAST(is_pk AS INTEGER) AS is_pk
		    FROM metadata_fts
		    WHERE conn_id = ? AND metadata_fts MATCH ?
		    LIMIT 40
		)
		UNION ALL
		SELECT * FROM (
		    SELECT DISTINCT
		        'table'     AS kind,
		        table_name  AS label,
		        db_name     AS detail,
		        db_name,
		        ''          AS table_name,
		        0           AS is_pk
		    FROM metadata_fts
		    WHERE conn_id = ? AND table_name MATCH ?
		    LIMIT 20
		)`

	rows, err := c.db.QueryContext(ctx, q, connID, ftsQuery, connID, ftsQuery)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// likeSearch is the fallback path using LIKE with COLLATE NOCASE indexes.
func (c *MetadataCache) likeSearch(ctx context.Context, connID, keyword string) ([]CompletionItem, error) {
	pattern := keyword + "%"

	const q = `
		SELECT * FROM (
		    SELECT
		        'column'    AS kind,
		        column_name AS label,
		        column_type || CASE is_pk WHEN 1 THEN ' (PK)' ELSE '' END AS detail,
		        db_name,
		        table_name,
		        is_pk
		    FROM metadata_columns
		    WHERE conn_id = ?
		      AND (column_name LIKE ? COLLATE NOCASE
		        OR table_name  LIKE ? COLLATE NOCASE)
		    LIMIT 40
		)
		UNION ALL
		SELECT * FROM (
		    SELECT DISTINCT
		        'table'     AS kind,
		        table_name  AS label,
		        db_name     AS detail,
		        db_name,
		        ''          AS table_name,
		        0           AS is_pk
		    FROM metadata_columns
		    WHERE conn_id = ?
		      AND table_name LIKE ? COLLATE NOCASE
		    LIMIT 20
		)`

	rows, err := c.db.QueryContext(ctx, q,
		connID, pattern, pattern,
		connID, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanItems(rows)
}

// scanItems reads a result set into []CompletionItem.
// Deduplicates by (kind, label, tableName) so UNION ALL doesn't create dupes.
func scanItems(rows *sql.Rows) ([]CompletionItem, error) {
	seen := make(map[string]bool)
	var items []CompletionItem

	for rows.Next() {
		var item CompletionItem
		var isPK int
		if err := rows.Scan(
			&item.Kind, &item.Label, &item.Detail,
			&item.DBName, &item.TableName, &isPK,
		); err != nil {
			return nil, err
		}
		item.IsPrimaryKey = isPK == 1

		key := item.Kind + ":" + item.TableName + "." + item.Label
		if seen[key] {
			continue
		}
		seen[key] = true
		items = append(items, item)
	}
	return items, rows.Err()
}

// ─────────────────────────────────────────────────────────────────────────────
// SyncState — query current sync status for a connection
// ─────────────────────────────────────────────────────────────────────────────

// SyncState returns the last-known sync status for a connection.
// Returns a zero SyncStatus (State="idle") if no sync has been run yet.
func (c *MetadataCache) SyncState(ctx context.Context, connID string) SyncStatus {
	c.mu.Lock()
	isSyncing := c.syncing[connID]
	c.mu.Unlock()

	if isSyncing {
		return SyncStatus{ConnID: connID, State: "syncing"}
	}

	var status SyncStatus
	status.ConnID = connID

	row := c.db.QueryRowContext(ctx, `
		SELECT last_sync_at, tables_count, cols_count, status, error_msg
		FROM sync_log WHERE conn_id = ?`, connID)

	var lastSyncAt string
	err := row.Scan(&lastSyncAt, &status.TablesCount, &status.ColsCount,
		&status.State, &status.ErrorMsg)
	if err != nil {
		status.State = "idle"
	}
	status.LastSyncAt = lastSyncAt
	return status
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func (c *MetadataCache) writeSyncLog(connID string, tables, cols int, state, errMsg string) error {
	_, err := c.db.Exec(`
		INSERT INTO sync_log (conn_id, last_sync_at, tables_count, cols_count, status, error_msg)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(conn_id) DO UPDATE SET
		    last_sync_at  = excluded.last_sync_at,
		    tables_count  = excluded.tables_count,
		    cols_count    = excluded.cols_count,
		    status        = excluded.status,
		    error_msg     = excluded.error_msg`,
		connID, time.Now().UTC().Format(time.RFC3339),
		tables, cols, state, errMsg)
	return err
}

// applySchema executes the DDL statements one by one.
// PRAGMA and CREATE statements are idempotent (IF NOT EXISTS).
// Additive column migrations are also applied here using ALTER TABLE … ADD
// COLUMN IF NOT EXISTS; SQLite ignores the statement silently when the column
// already exists (supported from SQLite 3.37 / modernc.org/sqlite ≥ 1.21).
func applySchema(db *sql.DB) error {
	stmts := strings.Split(schemaDDL, ";")
	for _, s := range stmts {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("exec %q: %w", s[:min(40, len(s))], err)
		}
	}

	// ── Additive migrations ────────────────────────────────────────────────
	// Each migration is guarded so it is safe to run on every startup.
	migrations := []string{
		// Phase 6.6: table on-disk size
		`ALTER TABLE metadata_tables ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT -1`,
		// Phase 15: table & column descriptions
		`ALTER TABLE metadata_tables  ADD COLUMN comment TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_columns ADD COLUMN comment TEXT NOT NULL DEFAULT ''`,
		// Phase 24: MySQL-specific table-level options surfaced by the
		// Properties panel (engine / charset / collation / auto-increment).
		// NULL auto_increment means "not applicable" — nullable integer
		// maps cleanly to *int64 on the Go side via sql.NullInt64.
		`ALTER TABLE metadata_tables ADD COLUMN engine         TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_tables ADD COLUMN charset        TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_tables ADD COLUMN collation      TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_tables ADD COLUMN auto_increment INTEGER`,
	}
	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			// SQLite returns an error when the column already exists.
			// The modernc.org/sqlite driver surfaces this as a generic error;
			// we match on the substring rather than an error code.
			if strings.Contains(err.Error(), "duplicate column") {
				continue // already applied — skip
			}
			return fmt.Errorf("migration %q: %w", m[:min(60, len(m))], err)
		}
	}
	return nil
}

func defaultDBPath() (string, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cacheDir, "GripLite", "metadata.db"), nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
