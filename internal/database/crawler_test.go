package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// openTestDB creates an in-memory SQLite database with the full cache schema.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)

	// Apply the schema expected by the crawler.
	ddl := []string{
		`PRAGMA journal_mode = WAL`,
		`PRAGMA foreign_keys = ON`,
		`CREATE TABLE IF NOT EXISTS metadata_cache (
			id            INTEGER PRIMARY KEY AUTOINCREMENT,
			connection_id TEXT    NOT NULL,
			db_name       TEXT    NOT NULL,
			table_name    TEXT    NOT NULL,
			engine        TEXT    NOT NULL DEFAULT '',
			size_bytes    INTEGER NOT NULL DEFAULT -1,
			comment       TEXT    NOT NULL DEFAULT '',
			columns_json  TEXT    NOT NULL DEFAULT '[]',
			sync_time     TEXT    NOT NULL DEFAULT (datetime('now')),
			UNIQUE(connection_id, db_name, table_name) ON CONFLICT REPLACE
		)`,
		`CREATE TABLE IF NOT EXISTS metadata_tables (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			conn_id    TEXT    NOT NULL,
			db_name    TEXT    NOT NULL,
			table_name TEXT    NOT NULL,
			kind       TEXT    NOT NULL DEFAULT 'table',
			row_count  INTEGER NOT NULL DEFAULT -1,
			size_bytes INTEGER NOT NULL DEFAULT -1,
			comment    TEXT    NOT NULL DEFAULT '',
			synced_at  TEXT    NOT NULL DEFAULT '',
			UNIQUE(conn_id, db_name, table_name)
		)`,
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
		`CREATE VIRTUAL TABLE IF NOT EXISTS metadata_fts USING fts5(
			conn_id    UNINDEXED,
			db_name,
			table_name,
			column_name,
			column_type UNINDEXED,
			is_pk       UNINDEXED,
			tokenize = 'unicode61 remove_diacritics 1'
		)`,
		`CREATE TABLE IF NOT EXISTS sync_log (
			conn_id      TEXT    PRIMARY KEY,
			last_sync_at TEXT    NOT NULL DEFAULT '',
			tables_count INTEGER NOT NULL DEFAULT 0,
			cols_count   INTEGER NOT NULL DEFAULT 0,
			status       TEXT    NOT NULL DEFAULT 'idle',
			error_msg    TEXT    NOT NULL DEFAULT ''
		)`,
	}
	for _, s := range ddl {
		if _, err := db.Exec(s); err != nil {
			// FTS5 may fail in some CI environments — skip the virtual table.
			if s[:20] == "CREATE VIRTUAL TABLE" {
				continue
			}
			t.Fatalf("apply ddl: %v\nSQL: %s", err, s[:min(80, len(s))])
		}
	}
	return db
}

// seedCache inserts fake rows into metadata_cache for testing GetTablesFromCache.
func seedCache(t *testing.T, db *sql.DB, connID, dbName, tableName, engine string, sizeBytes int64, cols []CachedColumn) {
	t.Helper()
	seedCacheWithComment(t, db, connID, dbName, tableName, engine, sizeBytes, "", cols)
}

// seedCacheWithComment is the Phase-15 variant that also seeds a comment.
// The older seedCache() delegates here with an empty comment so existing
// tests keep compiling unchanged.
func seedCacheWithComment(t *testing.T, db *sql.DB, connID, dbName, tableName, engine string, sizeBytes int64, comment string, cols []CachedColumn) {
	t.Helper()
	colsJSON, _ := json.Marshal(cols)
	_, err := db.Exec(`
		INSERT OR REPLACE INTO metadata_cache
		    (connection_id, db_name, table_name, engine, size_bytes, comment, columns_json)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		connID, dbName, tableName, engine, sizeBytes, comment, string(colsJSON))
	if err != nil {
		t.Fatalf("seedCache: %v", err)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ─────────────────────────────────────────────────────────────────────────────
// GetTablesFromCache tests
// ─────────────────────────────────────────────────────────────────────────────

func TestGetTablesFromCache_Empty(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	entries, err := GetTablesFromCache(context.Background(), db, "conn1", "mydb")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries, got %d", len(entries))
	}
}

func TestGetTablesFromCache_WithData(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	seedCache(t, db, "conn1", "shop", "orders", "InnoDB", 1024000, nil)
	seedCache(t, db, "conn1", "shop", "products", "InnoDB", 512000, nil)
	seedCache(t, db, "conn1", "analytics", "events", "MyISAM", 8192000, nil)
	// Different connection — must not appear.
	seedCache(t, db, "conn2", "shop", "orders", "InnoDB", 100, nil)

	tests := []struct {
		dbName    string
		wantCount int
		wantFirst string
	}{
		{"shop", 2, "orders"},
		{"analytics", 1, "events"},
		{"", 3, "events"}, // all schemas for conn1
	}
	for _, tt := range tests {
		t.Run("db="+tt.dbName, func(t *testing.T) {
			entries, err := GetTablesFromCache(context.Background(), db, "conn1", tt.dbName)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(entries) != tt.wantCount {
				t.Errorf("want %d entries, got %d", tt.wantCount, len(entries))
			}
			if len(entries) > 0 && entries[0].TableName != tt.wantFirst {
				t.Errorf("want first=%q, got %q", tt.wantFirst, entries[0].TableName)
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GetTableDetailFromCache tests
// ─────────────────────────────────────────────────────────────────────────────

func TestGetTableDetailFromCache_Miss(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	entry, err := GetTableDetailFromCache(context.Background(), db, "conn1", "shop", "nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry != nil {
		t.Error("expected nil for cache miss")
	}
}

func TestGetTableDetailFromCache_WithColumns(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	cols := []CachedColumn{
		{Ordinal: 1, Name: "id", Type: "int", Nullable: false, IsPK: true},
		{Ordinal: 2, Name: "email", Type: "varchar", Nullable: false},
	}
	seedCache(t, db, "conn1", "shop", "users", "InnoDB", 65536, cols)

	entry, err := GetTableDetailFromCache(context.Background(), db, "conn1", "shop", "users")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if entry == nil {
		t.Fatal("expected non-nil entry")
	}
	if entry.TableName != "users" {
		t.Errorf("want tableName=users, got %q", entry.TableName)
	}
	if entry.Engine != "InnoDB" {
		t.Errorf("want engine=InnoDB, got %q", entry.Engine)
	}
	if entry.SizeBytes != 65536 {
		t.Errorf("want sizeBytes=65536, got %d", entry.SizeBytes)
	}
	if len(entry.Columns) != 2 {
		t.Errorf("want 2 columns, got %d", len(entry.Columns))
	}
	if !entry.Columns[0].IsPK {
		t.Error("first column should be PK")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GetDatabasesFromCache tests
// ─────────────────────────────────────────────────────────────────────────────

func TestGetDatabasesFromCache(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	// Empty — should return [] not nil.
	dbs, err := GetDatabasesFromCache(context.Background(), db, "conn1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dbs == nil {
		t.Error("expected non-nil slice for empty cache")
	}
	if len(dbs) != 0 {
		t.Errorf("expected 0 dbs, got %v", dbs)
	}

	// With data.
	seedCache(t, db, "conn1", "alpha", "t1", "InnoDB", 1, nil)
	seedCache(t, db, "conn1", "beta", "t2", "InnoDB", 1, nil)
	seedCache(t, db, "conn1", "alpha", "t3", "InnoDB", 1, nil) // same schema, different table

	dbs, err = GetDatabasesFromCache(context.Background(), db, "conn1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(dbs) != 2 {
		t.Errorf("expected 2 distinct dbs, got %v", dbs)
	}
	if dbs[0] != "alpha" || dbs[1] != "beta" {
		t.Errorf("unexpected db order: %v", dbs)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// writeSyncLog + buildCachedColumns helpers
// ─────────────────────────────────────────────────────────────────────────────

func TestWriteSyncLog(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := writeSyncLog(db, "conn1", 42, 300, "done", ""); err != nil {
		t.Fatalf("writeSyncLog: %v", err)
	}

	var status, errMsg string
	var tables, cols int
	err := db.QueryRow(`SELECT status, error_msg, tables_count, cols_count FROM sync_log WHERE conn_id = ?`, "conn1").
		Scan(&status, &errMsg, &tables, &cols)
	if err != nil {
		t.Fatalf("read sync_log: %v", err)
	}
	if status != "done" || tables != 42 || cols != 300 {
		t.Errorf("unexpected sync_log: status=%q tables=%d cols=%d", status, tables, cols)
	}

	// Upsert — should update, not insert a second row.
	if err = writeSyncLog(db, "conn1", 50, 400, "error", "timeout"); err != nil {
		t.Fatalf("writeSyncLog update: %v", err)
	}
	var count int
	_ = db.QueryRow(`SELECT COUNT(*) FROM sync_log WHERE conn_id = ?`, "conn1").Scan(&count)
	if count != 1 {
		t.Errorf("expected 1 row after upsert, got %d", count)
	}
}

func TestBuildCachedColumns(t *testing.T) {
	cols := []crawledColumn{
		{ordinal: 1, name: "id", typ: "int", key: "PRI", extra: "auto_increment", comment: "primary key"},
		{ordinal: 2, name: "name", typ: "varchar"},
	}
	out := buildCachedColumns(cols)
	if len(out) != 2 {
		t.Fatalf("expected 2, got %d", len(out))
	}
	if !out[0].IsPK {
		t.Error("first column should be PK")
	}
	if out[0].Extra != "auto_increment" {
		t.Errorf("expected extra=auto_increment, got %q", out[0].Extra)
	}
	if out[0].Comment != "primary key" {
		t.Errorf("expected comment=%q, got %q", "primary key", out[0].Comment)
	}
	if out[1].IsPK {
		t.Error("second column should not be PK")
	}
	if out[1].Comment != "" {
		t.Errorf("missing COLUMN_COMMENT must marshal to '', got %q", out[1].Comment)
	}
}

// TestGetTablesFromCache_Comment verifies that TABLE_COMMENT stored in the
// metadata_cache row survives the round-trip through GetTablesFromCache (the
// function returns the row straight to the frontend's DatabaseViewer grid).
func TestGetTablesFromCache_Comment(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	seedCacheWithComment(t, db, "conn1", "shop", "orders", "InnoDB", 1024, "Customer orders table", nil)
	seedCacheWithComment(t, db, "conn1", "shop", "products", "InnoDB", 512, "", nil)

	entries, err := GetTablesFromCache(context.Background(), db, "conn1", "shop")
	if err != nil {
		t.Fatalf("GetTablesFromCache: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(entries))
	}

	byName := map[string]CachedTableEntry{}
	for _, e := range entries {
		byName[e.TableName] = e
	}
	if got := byName["orders"].Comment; got != "Customer orders table" {
		t.Errorf("orders.Comment: want %q, got %q", "Customer orders table", got)
	}
	if got := byName["products"].Comment; got != "" {
		// Must be empty string (not "NULL" / null) so the UI renders verbatim.
		t.Errorf("products.Comment: want empty string, got %q", got)
	}
}

// TestGetTableDetailFromCache_Comment verifies that both the table-level
// and column-level comments survive the GetTableDetailFromCache round trip.
// The column comment lives inside the columns_json blob.
func TestGetTableDetailFromCache_Comment(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	cols := []CachedColumn{
		{Ordinal: 1, Name: "id", Type: "int", IsPK: true, Comment: "surrogate key"},
		{Ordinal: 2, Name: "email", Type: "varchar(255)"}, // no comment
	}
	seedCacheWithComment(t, db, "conn1", "shop", "users", "InnoDB", 65536, "All registered users", cols)

	entry, err := GetTableDetailFromCache(context.Background(), db, "conn1", "shop", "users")
	if err != nil {
		t.Fatalf("GetTableDetailFromCache: %v", err)
	}
	if entry == nil {
		t.Fatal("expected non-nil entry")
	}
	if entry.Comment != "All registered users" {
		t.Errorf("table Comment: want %q, got %q", "All registered users", entry.Comment)
	}
	if len(entry.Columns) != 2 {
		t.Fatalf("want 2 columns, got %d", len(entry.Columns))
	}
	if entry.Columns[0].Comment != "surrogate key" {
		t.Errorf("col[0].Comment: want %q, got %q", "surrogate key", entry.Columns[0].Comment)
	}
	if entry.Columns[1].Comment != "" {
		t.Errorf("col[1].Comment: want empty, got %q", entry.Columns[1].Comment)
	}
}
