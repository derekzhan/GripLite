package cache

import (
	"context"
	"fmt"
	"testing"
	"time"

	"GripLite/internal/db"
	"GripLite/internal/driver"
)

// ─────────────────────────────────────────────────────────────────────────────
// Fake driver — implements the minimal subset of driver.DatabaseDriver used
// by SyncSchema.  Non-schema methods panic to catch accidental usage.
// ─────────────────────────────────────────────────────────────────────────────

type fakeDriver struct {
	databases []string
	tables    map[string][]driver.TableInfo         // dbName -> tables
	details   map[string]*driver.TableDetail        // "db.table" -> detail
}

func (f *fakeDriver) Connect(ctx context.Context) error { return nil }
func (f *fakeDriver) Close(ctx context.Context) error   { return nil }
func (f *fakeDriver) Ping(ctx context.Context) error    { return nil }

func (f *fakeDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	return f.databases, nil
}

func (f *fakeDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	return f.tables[dbName], nil
}

func (f *fakeDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	d, ok := f.details[dbName+"."+tableName]
	if !ok {
		return nil, fmt.Errorf("table not found: %s.%s", dbName, tableName)
	}
	return d, nil
}

func (f *fakeDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	panic("ExecuteQuery should not be called by cache")
}
func (f *fakeDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	panic("ExecuteQueryOnDB should not be called by cache")
}
func (f *fakeDriver) Kind() driver.DriverKind { return driver.DriverMySQL }
func (f *fakeDriver) ServerVersion() string   { return "8.0.35-fake" }

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newTestCache(t *testing.T) *MetadataCache {
	t.Helper()
	database, _, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	c, err := NewFromDB(database)
	if err != nil {
		t.Fatalf("NewFromDB: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// sampleDriver returns a fakeDriver pre-populated with two tables in db "shop".
func sampleDriver() *fakeDriver {
	usersAI := int64(2048)
	return &fakeDriver{
		databases: []string{"shop", "information_schema"}, // second one is skipped
		tables: map[string][]driver.TableInfo{
			"shop": {
				{
					Name: "users", Schema: "shop", Kind: driver.ObjectTable,
					RowCount: 1024, SizeBytes: 131072,
					Engine: "InnoDB", Charset: "utf8mb4", Collation: "utf8mb4_unicode_ci",
					AutoIncrement: &usersAI,
				},
				{
					Name: "orders", Schema: "shop", Kind: driver.ObjectTable,
					RowCount: 500, SizeBytes: 65536,
					Engine: "InnoDB", Charset: "utf8mb4", Collation: "utf8mb4_0900_ai_ci",
				},
			},
		},
		details: map[string]*driver.TableDetail{
			"shop.users": {
				TableInfo: driver.TableInfo{Name: "users", Schema: "shop", Kind: driver.ObjectTable, RowCount: 1024, SizeBytes: 131072},
				Columns: []driver.ColumnInfo{
					{Name: "id", DatabaseType: "int(11)", Nullable: false, PrimaryKey: true, Ordinal: 0},
					{Name: "username", DatabaseType: "varchar(64)", Nullable: false, PrimaryKey: false, Ordinal: 1},
					{Name: "email", DatabaseType: "varchar(255)", Nullable: true, PrimaryKey: false, Ordinal: 2},
				},
			},
			"shop.orders": {
				TableInfo: driver.TableInfo{Name: "orders", Schema: "shop", Kind: driver.ObjectTable, RowCount: 500, SizeBytes: 65536},
				Columns: []driver.ColumnInfo{
					{Name: "id", DatabaseType: "int(11)", Nullable: false, PrimaryKey: true, Ordinal: 0},
					{Name: "user_id", DatabaseType: "int(11)", Nullable: false, PrimaryKey: false, Ordinal: 1},
					{Name: "total", DatabaseType: "decimal(12,2)", Nullable: false, PrimaryKey: false, Ordinal: 2},
				},
			},
		},
	}
}

// waitForSyncDone polls c.SyncState until state == "done" (or error) or timeout.
func waitForSyncDone(t *testing.T, c *MetadataCache, connID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		st := c.SyncState(context.Background(), connID)
		if st.State == "done" {
			return
		}
		if st.State == "error" {
			t.Fatalf("sync errored: %+v", st)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("sync did not complete within %v; last state: %+v",
		timeout, c.SyncState(context.Background(), connID))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// TestCache_SyncSchema_EndToEnd exercises the full sync pipeline with a fake
// driver, then verifies the cache can be queried via GetTableSchema and
// SearchColumns.
func TestCache_SyncSchema_EndToEnd(t *testing.T) {
	c := newTestCache(t)
	drv := sampleDriver()

	c.SyncSchema(context.Background(), "conn-1", drv)
	waitForSyncDone(t, c, "conn-1", 3*time.Second)

	// ── Table metadata should be cached ─────────────────────────────────────
	schema, err := c.GetTableSchema(context.Background(), "conn-1", "shop", "users")
	if err != nil {
		t.Fatalf("GetTableSchema: %v", err)
	}
	if !schema.Found {
		t.Fatal("expected Found=true for cached table")
	}
	if schema.RowCount != 1024 {
		t.Errorf("RowCount: want 1024, got %d", schema.RowCount)
	}
	if schema.SizeBytes != 131072 {
		t.Errorf("SizeBytes: want 131072, got %d", schema.SizeBytes)
	}
	if len(schema.Columns) != 3 {
		t.Errorf("expected 3 columns, got %d", len(schema.Columns))
	}
	if schema.Columns[0].Name != "id" || !schema.Columns[0].IsPK {
		t.Errorf("first column should be 'id' PK, got %+v", schema.Columns[0])
	}
	if schema.Columns[2].Name != "email" || !schema.Columns[2].Nullable {
		t.Errorf("email column incorrect: %+v", schema.Columns[2])
	}

	// Phase 24: table-level options should round-trip through the cache.
	if schema.Engine != "InnoDB" {
		t.Errorf("Engine: want InnoDB, got %q", schema.Engine)
	}
	if schema.Charset != "utf8mb4" {
		t.Errorf("Charset: want utf8mb4, got %q", schema.Charset)
	}
	if schema.Collation != "utf8mb4_unicode_ci" {
		t.Errorf("Collation: want utf8mb4_unicode_ci, got %q", schema.Collation)
	}
	if schema.AutoIncrement == nil || *schema.AutoIncrement != 2048 {
		t.Errorf("AutoIncrement: want 2048, got %v", schema.AutoIncrement)
	}
}

// TestCache_GetTableSchema_Miss verifies a cache miss returns Found=false
// rather than erroring.
func TestCache_GetTableSchema_Miss(t *testing.T) {
	c := newTestCache(t)

	schema, err := c.GetTableSchema(context.Background(), "conn-none", "shop", "ghost")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if schema.Found {
		t.Errorf("expected Found=false for uncached table, got %+v", schema)
	}
}

// TestCache_SearchColumns verifies autocomplete queries return both table
// and column matches after a sync has populated the index.
func TestCache_SearchColumns(t *testing.T) {
	c := newTestCache(t)
	drv := sampleDriver()

	c.SyncSchema(context.Background(), "conn-2", drv)
	waitForSyncDone(t, c, "conn-2", 3*time.Second)

	// "use" should match both the "users" table and "user_id" column.
	items, err := c.SearchColumns(context.Background(), "conn-2", "", "use")
	if err != nil {
		t.Fatalf("SearchColumns: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected non-empty search results for 'use'")
	}

	// At least one result should be the "users" table.
	foundTable := false
	foundColumn := false
	for _, it := range items {
		if it.Kind == "table" && it.Label == "users" {
			foundTable = true
		}
		if it.Kind == "column" && (it.Label == "user_id" || it.Label == "username") {
			foundColumn = true
		}
	}
	if !foundTable {
		t.Error("expected 'users' table in results")
	}
	if !foundColumn {
		t.Error("expected a column match in results")
	}
}

// TestCache_SyncSchema_Comment verifies that TABLE_COMMENT / COLUMN_COMMENT
// survive the full sync pipeline and are retrievable via GetTableSchema
// (Phase 15).
func TestCache_SyncSchema_Comment(t *testing.T) {
	c := newTestCache(t)
	drv := &fakeDriver{
		databases: []string{"shop"},
		tables: map[string][]driver.TableInfo{
			"shop": {
				{Name: "users", Schema: "shop", Kind: driver.ObjectTable, RowCount: 1, SizeBytes: 1,
					Comment: "All registered users"},
				{Name: "no_comment", Schema: "shop", Kind: driver.ObjectTable, RowCount: 1, SizeBytes: 1},
			},
		},
		details: map[string]*driver.TableDetail{
			"shop.users": {
				TableInfo: driver.TableInfo{Name: "users", Schema: "shop", Kind: driver.ObjectTable,
					Comment: "All registered users"},
				Columns: []driver.ColumnInfo{
					{Name: "id", DatabaseType: "int", PrimaryKey: true, Comment: "surrogate key"},
					{Name: "email", DatabaseType: "varchar"}, // comment intentionally empty
				},
			},
			"shop.no_comment": {
				TableInfo: driver.TableInfo{Name: "no_comment", Schema: "shop", Kind: driver.ObjectTable},
				Columns: []driver.ColumnInfo{
					{Name: "id", DatabaseType: "int", PrimaryKey: true},
				},
			},
		},
	}

	c.SyncSchema(context.Background(), "conn-c", drv)
	waitForSyncDone(t, c, "conn-c", 3*time.Second)

	users, err := c.GetTableSchema(context.Background(), "conn-c", "shop", "users")
	if err != nil {
		t.Fatalf("GetTableSchema users: %v", err)
	}
	if users.Comment != "All registered users" {
		t.Errorf("users.Comment: want %q, got %q", "All registered users", users.Comment)
	}
	if len(users.Columns) != 2 {
		t.Fatalf("want 2 columns, got %d", len(users.Columns))
	}
	if users.Columns[0].Comment != "surrogate key" {
		t.Errorf("columns[0].Comment: want %q, got %q", "surrogate key", users.Columns[0].Comment)
	}
	if users.Columns[1].Comment != "" {
		t.Errorf("columns[1].Comment: want empty string, got %q", users.Columns[1].Comment)
	}

	// Tables and columns without comments must return empty strings — never
	// NULL / "null" — so the frontend renders them verbatim.
	noComment, err := c.GetTableSchema(context.Background(), "conn-c", "shop", "no_comment")
	if err != nil {
		t.Fatalf("GetTableSchema no_comment: %v", err)
	}
	if noComment.Comment != "" {
		t.Errorf("no_comment.Comment: want empty string, got %q", noComment.Comment)
	}
	if len(noComment.Columns) != 1 || noComment.Columns[0].Comment != "" {
		t.Errorf("no_comment columns[0].Comment: want empty string, got %+v", noComment.Columns)
	}
}

// TestCache_SearchColumns_EmptyKeyword verifies empty input returns nil.
func TestCache_SearchColumns_EmptyKeyword(t *testing.T) {
	c := newTestCache(t)

	items, err := c.SearchColumns(context.Background(), "conn", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if items != nil {
		t.Errorf("expected nil for empty keyword, got %v", items)
	}
}

// TestCache_SyncState tracks state transitions: before sync, during, and
// after completion.
func TestCache_SyncState(t *testing.T) {
	c := newTestCache(t)
	drv := sampleDriver()

	// Before sync — state should be "idle" or empty (no log entry).
	before := c.SyncState(context.Background(), "conn-3")
	if before.State == "syncing" {
		t.Errorf("should not be syncing before SyncSchema, got %q", before.State)
	}

	c.SyncSchema(context.Background(), "conn-3", drv)
	waitForSyncDone(t, c, "conn-3", 3*time.Second)

	after := c.SyncState(context.Background(), "conn-3")
	if after.State != "done" {
		t.Errorf("state: want done, got %q", after.State)
	}
	if after.TablesCount == 0 || after.ColsCount == 0 {
		t.Errorf("expected non-zero counts, got %+v", after)
	}
}
