package db

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestOpen_CreatesFileAndTables verifies that Open() creates griplite.db in
// the given directory, returns IsNew=true the first time and false afterwards,
// and applies the full schema (core + extended DDL).
func TestOpen_CreatesFileAndTables(t *testing.T) {
	dir := t.TempDir()

	db, info, err := Open(dir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()

	expectedPath := filepath.Join(dir, FileName)
	if info.Path != expectedPath {
		t.Errorf("path: want %q, got %q", expectedPath, info.Path)
	}
	if !info.IsNew {
		t.Error("first Open: expected IsNew=true")
	}
	if _, err := os.Stat(expectedPath); err != nil {
		t.Errorf("file was not created: %v", err)
	}

	// Verify core + extended tables exist.
	wantTables := []string{
		"connections",      // core
		"metadata_cache",   // core
		"metadata_tables",  // extended (from cache)
		"metadata_columns", // extended
		"metadata_fts",     // extended (FTS5 virtual table)
		"sync_log",         // extended
	}
	for _, name := range wantTables {
		var out string
		err := db.QueryRow(
			`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
			name,
		).Scan(&out)
		if err != nil {
			t.Errorf("table %q not found: %v", name, err)
			continue
		}
		if !strings.EqualFold(out, name) {
			t.Errorf("unexpected table name: got %q, want %q", out, name)
		}
	}
}

// TestOpen_Idempotent verifies Open() can be called twice without error and
// reports IsNew=false the second time.
func TestOpen_Idempotent(t *testing.T) {
	dir := t.TempDir()

	db1, _, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open failed: %v", err)
	}
	db1.Close()

	db2, info, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open failed: %v", err)
	}
	defer db2.Close()

	if info.IsNew {
		t.Error("second Open: expected IsNew=false")
	}
}

// TestOpen_CommentColumnMigration exercises the Phase-15 additive migration
// that adds `comment` to metadata_cache / metadata_tables / metadata_columns.
//
// The test simulates an older griplite.db by dropping the three comment
// columns after the first Open, re-opens the DB, and verifies that the
// migration re-adds the columns without losing existing data or erroring out.
func TestOpen_CommentColumnMigration(t *testing.T) {
	dir := t.TempDir()

	// First open creates the full v15 schema — that on its own exercises the
	// fresh-install code path.
	db1, _, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}

	// Simulate an older DB by dropping the comment columns.  SQLite 3.35+
	// supports ALTER TABLE … DROP COLUMN, which modernc.org/sqlite ships.
	drops := []string{
		`ALTER TABLE metadata_cache   DROP COLUMN comment`,
		`ALTER TABLE metadata_tables  DROP COLUMN comment`,
		`ALTER TABLE metadata_columns DROP COLUMN comment`,
	}
	for _, s := range drops {
		if _, err := db1.Exec(s); err != nil {
			// If DROP COLUMN isn't supported on this build we can't run the
			// migration half of the test — just bail out early with a skip
			// rather than fail spuriously.
			db1.Close()
			t.Skipf("DROP COLUMN not supported: %v", err)
		}
	}
	db1.Close()

	// Re-open — the additive migration should re-add the comment columns.
	db2, _, err := Open(dir)
	if err != nil {
		t.Fatalf("re-Open after drop: %v", err)
	}
	defer db2.Close()

	for _, table := range []string{"metadata_cache", "metadata_tables", "metadata_columns"} {
		var col string
		err := db2.QueryRow(
			`SELECT name FROM pragma_table_info(?) WHERE name = 'comment'`,
			table,
		).Scan(&col)
		if err != nil {
			t.Errorf("table %q: missing comment column after migration: %v", table, err)
		}
	}

	// Round-trip the new column to make sure writes work end-to-end.
	if _, err := db2.Exec(`
		INSERT INTO metadata_cache (connection_id, db_name, table_name, engine, size_bytes, comment)
		VALUES ('c1', 'shop', 'orders', 'InnoDB', 1024, 'hello world')`); err != nil {
		t.Fatalf("insert with comment: %v", err)
	}
	var got string
	if err := db2.QueryRow(
		`SELECT comment FROM metadata_cache WHERE connection_id='c1' AND table_name='orders'`,
	).Scan(&got); err != nil {
		t.Fatalf("select comment: %v", err)
	}
	if got != "hello world" {
		t.Errorf("comment roundtrip: want %q, got %q", "hello world", got)
	}
}

// TestOpen_InsertAndRead performs a minimal write/read round-trip to ensure
// the DB is actually functional (WAL, foreign keys, pragmas).
func TestOpen_InsertAndRead(t *testing.T) {
	dir := t.TempDir()
	db, _, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(
		`INSERT INTO connections (id, name, host, port, username) VALUES (?, ?, ?, ?, ?)`,
		"test-1", "local", "127.0.0.1", 3306, "root",
	)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	var name string
	if err := db.QueryRow(`SELECT name FROM connections WHERE id = ?`, "test-1").Scan(&name); err != nil {
		t.Fatalf("select: %v", err)
	}
	if name != "local" {
		t.Errorf("name: want %q, got %q", "local", name)
	}
}
