// Package db manages the unified local SQLite database for GripLite.
//
// All persistent application state lives in a single file:
//
//	macOS / Linux:  ~/.config/GripLite/griplite.db
//	Windows:        %APPDATA%\GripLite\griplite.db
//
// # Schema overview
//
// The database contains two groups of tables:
//
// Core tables (required by the spec):
//
//	connections     — saved data-source configs (passwords AES-256-GCM encrypted)
//	metadata_cache  — pre-serialized per-table schema snapshots (fast reads)
//
// Extended tables (used by the metadata sync engine in internal/cache):
//
//	metadata_tables   — one row per table / view (rowCount, sizeBytes, kind)
//	metadata_columns  — one row per column (FK → metadata_tables)
//	metadata_fts      — FTS5 virtual table for sub-ms autocomplete search
//	sync_log          — last-sync timestamp per connection
//
// All tables use "CREATE TABLE IF NOT EXISTS" so repeated calls to InitLocalDB
// are safe and idempotent.
//
// # Cross-package sharing
//
// Open returns a *sql.DB that is passed to internal/store and internal/cache
// via their NewFromDB constructors.  Both packages operate on the SAME file
// and connection pool, eliminating the previous two-file split.
//
// # No CGO
//
// The driver is modernc.org/sqlite — a pure-Go port of SQLite that compiles
// without GCC on all platforms supported by Go.
package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // registers "sqlite" with database/sql
)

// FileName is the basename of the unified database file.
const FileName = "griplite.db"

// ─────────────────────────────────────────────────────────────────────────────
// DDL
//
// Statements are executed one at a time (sqlite is fussy about multi-statement
// Exec).  Each section is separated by a blank line for readability.
// ─────────────────────────────────────────────────────────────────────────────

// pragmas are applied immediately after the connection is opened.
// WAL mode allows concurrent readers alongside a single writer.
var pragmas = []string{
	`PRAGMA journal_mode = WAL`,
	`PRAGMA synchronous  = NORMAL`,
	`PRAGMA foreign_keys = ON`,
	`PRAGMA busy_timeout = 5000`,
}

// coreDDL creates the two tables required by the Phase 8 spec.
//
// connections
//
//	Stores data-source configurations.  Sensitive fields (encrypted_password,
//	ssh_pw_enc) hold AES-256-GCM ciphertext encoded as base64.
//
// metadata_cache
//
//	Stores a pre-serialized JSON snapshot of each table's schema.  This is
//	the fast path for the Properties panel: one SQLite read instead of a
//	round-trip to the live database.  The cache engine also maintains the
//	normalised metadata_tables / metadata_columns tables for autocomplete.
var coreDDL = []string{
	// ── connections ──────────────────────────────────────────────────────────
	`CREATE TABLE IF NOT EXISTS connections (
		id                    TEXT    PRIMARY KEY,
		name                  TEXT    NOT NULL DEFAULT '',
		comment               TEXT    NOT NULL DEFAULT '',
		kind                  TEXT    NOT NULL DEFAULT 'mysql',
		host                  TEXT    NOT NULL DEFAULT '',
		port                  INTEGER NOT NULL DEFAULT 3306,
		username              TEXT    NOT NULL DEFAULT '',
		encrypted_password    TEXT    NOT NULL DEFAULT '',
		database              TEXT    NOT NULL DEFAULT '',
		tls                   INTEGER NOT NULL DEFAULT 0,
		ssh_config_json       TEXT    NOT NULL DEFAULT '{}',
		ssh_pw_enc            TEXT    NOT NULL DEFAULT '',
		advanced_options_json TEXT    NOT NULL DEFAULT '[]',
		created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
		updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
	)`,

	// ── metadata_cache ───────────────────────────────────────────────────────
	// columns_json: JSON array of {name, type, nullable, isPrimaryKey, ordinal, comment}
	// comment:      TABLE_COMMENT from information_schema.TABLES (Phase 15).
	`CREATE TABLE IF NOT EXISTS metadata_cache (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		connection_id TEXT   NOT NULL,
		db_name      TEXT    NOT NULL,
		table_name   TEXT    NOT NULL,
		engine       TEXT    NOT NULL DEFAULT '',
		size_bytes   INTEGER NOT NULL DEFAULT -1,
		comment      TEXT    NOT NULL DEFAULT '',
		columns_json TEXT    NOT NULL DEFAULT '[]',
		sync_time    TEXT    NOT NULL DEFAULT (datetime('now')),
		UNIQUE(connection_id, db_name, table_name) ON CONFLICT REPLACE
	)`,
	`CREATE INDEX IF NOT EXISTS idx_mc_conn ON metadata_cache(connection_id)`,
	`CREATE INDEX IF NOT EXISTS idx_mc_table ON metadata_cache(connection_id, db_name, table_name)`,
}

// extendedDDL creates the tables used by the internal/cache sync engine.
// These tables hold the normalised, column-level data that drives autocomplete.
var extendedDDL = []string{
	// Per-table statistics (used by Database Explorer tree + DatabaseViewer).
	// `comment` holds TABLE_COMMENT verbatim (Phase 15).
	`CREATE TABLE IF NOT EXISTS metadata_tables (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		conn_id    TEXT    NOT NULL,
		db_name    TEXT    NOT NULL,
		table_name TEXT    NOT NULL,
		kind       TEXT    NOT NULL DEFAULT 'table',
		row_count  INTEGER NOT NULL DEFAULT -1,
		size_bytes INTEGER NOT NULL DEFAULT -1,
		comment    TEXT    NOT NULL DEFAULT '',
		synced_at  TEXT    NOT NULL,
		UNIQUE(conn_id, db_name, table_name)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_mt_lookup ON metadata_tables(conn_id, db_name)`,
	`CREATE INDEX IF NOT EXISTS idx_mt_name   ON metadata_tables(table_name COLLATE NOCASE)`,

	// Per-column details (used by autocomplete + Properties panel).
	//
	// Column names match internal/cache/cache.go exactly so that both packages
	// can share the unified griplite.db without conflict.
	`CREATE TABLE IF NOT EXISTS metadata_columns (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		conn_id      TEXT    NOT NULL,
		db_name      TEXT    NOT NULL,
		table_name   TEXT    NOT NULL,
		column_name  TEXT    NOT NULL,
		column_type  TEXT    NOT NULL DEFAULT '',
		is_nullable  INTEGER NOT NULL DEFAULT 0,
		is_pk        INTEGER NOT NULL DEFAULT 0,
		ordinal      INTEGER NOT NULL DEFAULT 0,
		comment      TEXT    NOT NULL DEFAULT '',
		synced_at    TEXT    NOT NULL DEFAULT '',
		UNIQUE(conn_id, db_name, table_name, column_name)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_mc_search    ON metadata_columns(conn_id, column_name COLLATE NOCASE)`,
	`CREATE INDEX IF NOT EXISTS idx_mc_tbl_lookup ON metadata_columns(conn_id, db_name, table_name)`,
	`CREATE INDEX IF NOT EXISTS idx_mc_tbl_name   ON metadata_columns(table_name COLLATE NOCASE)`,

	// FTS5 virtual table for instant prefix-match autocomplete.
	// Column order and UNINDEXED flags match cache.go's INSERT statements.
	`CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(
		conn_id    UNINDEXED,
		db_name,
		table_name,
		column_name,
		column_type UNINDEXED,
		is_pk       UNINDEXED,
		tokenize = 'unicode61 remove_diacritics 1'
	)`,

	// Tracks the last successful sync per connection.
	//
	// Column names match internal/cache/cache.go (last_sync_at, tables_count,
	// cols_count, status, error_msg) so cache.SyncState reads correctly.
	`CREATE TABLE IF NOT EXISTS sync_log (
		conn_id      TEXT    PRIMARY KEY,
		last_sync_at TEXT    NOT NULL DEFAULT '',
		tables_count INTEGER NOT NULL DEFAULT 0,
		cols_count   INTEGER NOT NULL DEFAULT 0,
		status       TEXT    NOT NULL DEFAULT 'idle',
		error_msg    TEXT    NOT NULL DEFAULT ''
	)`,

	// Per-(connection, database, table) list of Data-tab WHERE filter strings,
	// JSON array, newest first, max 20.  Survives app restarts (DBeaver-style).
	`CREATE TABLE IF NOT EXISTS data_filter_history (
		conn_id      TEXT    NOT NULL,
		db_name      TEXT    NOT NULL,
		table_name   TEXT    NOT NULL,
		entries_json TEXT    NOT NULL DEFAULT '[]',
		updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
		PRIMARY KEY (conn_id, db_name, table_name)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_dfh_updated ON data_filter_history(updated_at)`,

	// Query history — one row per RunQuery invocation.
	`CREATE TABLE IF NOT EXISTS query_history (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		conn_id     TEXT    NOT NULL,
		db_name     TEXT    NOT NULL DEFAULT '',
		sql_text    TEXT    NOT NULL,
		exec_ms     INTEGER NOT NULL DEFAULT 0,
		error_msg   TEXT    NOT NULL DEFAULT '',
		executed_at TEXT    NOT NULL DEFAULT (datetime('now'))
	)`,
	`CREATE INDEX IF NOT EXISTS idx_qh_conn ON query_history(conn_id, executed_at)`,
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

// DBInfo holds metadata about the opened database file (useful for the UI and
// logs).
type DBInfo struct {
	// Path is the absolute path to griplite.db.
	Path string
	// IsNew is true when the file was created during this Open call (first run).
	IsNew bool
}

// Open opens (or creates) griplite.db in dir and applies the full schema.
//
// Pass an empty dir to use the OS-default application config directory:
//
//	macOS / Linux: $HOME/.config/GripLite/griplite.db
//	Windows:       %APPDATA%\GripLite\griplite.db
//
// The returned *sql.DB is shared across all packages that need persistent
// storage (internal/store, internal/cache).  Callers MUST call db.Close() when
// the application shuts down.
func Open(dir string) (*sql.DB, DBInfo, error) {
	path, isNew, err := resolvePath(dir)
	if err != nil {
		return nil, DBInfo{}, err
	}

	// Open with WAL mode baked into the DSN so the very first connection
	// enables WAL before any DDL runs.
	dsn := "file:" + path + "?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, DBInfo{}, fmt.Errorf("db: open %q: %w", path, err)
	}

	// SQLite works best with a single writer connection.
	db.SetMaxOpenConns(1)

	if err := applySchema(db); err != nil {
		_ = db.Close()
		return nil, DBInfo{}, fmt.Errorf("db: apply schema: %w", err)
	}

	return db, DBInfo{Path: path, IsNew: isNew}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func resolvePath(dir string) (path string, isNew bool, err error) {
	if dir == "" {
		base, e := os.UserConfigDir()
		if e != nil {
			base = os.TempDir()
		}
		dir = filepath.Join(base, "GripLite")
	}
	if e := os.MkdirAll(dir, 0o700); e != nil {
		return "", false, fmt.Errorf("db: mkdir %q: %w", dir, e)
	}
	path = filepath.Join(dir, FileName)
	_, statErr := os.Stat(path)
	isNew = os.IsNotExist(statErr)
	return path, isNew, nil
}

func applySchema(db *sql.DB) error {
	// Apply PRAGMAs first.
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			return fmt.Errorf("pragma %q: %w", p, err)
		}
	}
	// Apply core tables.
	for _, stmt := range coreDDL {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("core DDL: %w", err)
		}
	}
	// Apply extended tables (cache engine).
	for _, stmt := range extendedDDL {
		if _, err := db.Exec(stmt); err != nil {
			// FTS5 might not be available in all SQLite builds — log and continue.
			if isFTS5Error(err) {
				continue
			}
			return fmt.Errorf("extended DDL: %w", err)
		}
	}

	// Additive migrations — idempotent ADD COLUMN statements for griplite.db
	// files created before a given schema revision.  SQLite does not support
	// "ADD COLUMN IF NOT EXISTS" on every build, so we swallow the "duplicate
	// column name" error instead.
	//
	// Phase 15: TABLE_COMMENT / COLUMN_COMMENT fields.
	migrations := []string{
		`ALTER TABLE metadata_cache   ADD COLUMN comment TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_tables  ADD COLUMN comment TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE metadata_columns ADD COLUMN comment TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE connections ADD COLUMN color TEXT NOT NULL DEFAULT ''`,
	}
	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			msg := err.Error()
			if contains(msg, "duplicate column") {
				continue
			}
			return fmt.Errorf("migration %q: %w", m, err)
		}
	}
	return nil
}

// isFTS5Error returns true when the error indicates that FTS5 is not compiled
// into the SQLite build.  modernc.org/sqlite ships with FTS5 enabled so this
// path is only hit in unusual cross-compile scenarios.
func isFTS5Error(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return contains(msg, "no such module: fts5") ||
		contains(msg, "unknown tokenizer")
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && indexStr(s, sub) >= 0)
}

func indexStr(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
