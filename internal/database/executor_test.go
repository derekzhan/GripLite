package database

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// InjectLimit
// ─────────────────────────────────────────────────────────────────────────────

func TestInjectLimit(t *testing.T) {
	cases := []struct {
		name  string
		query string
		n     int
		want  string // "" means query must be unchanged
	}{
		// Injection cases
		{
			name:  "plain SELECT no limit",
			query: "SELECT * FROM users",
			n:     200,
			want:  "SELECT * FROM users LIMIT 200",
		},
		{
			name:  "SELECT with WHERE",
			query: "SELECT id, name FROM orders WHERE status = 'active'",
			n:     100,
			want:  "SELECT id, name FROM orders WHERE status = 'active' LIMIT 100",
		},
		{
			name:  "SELECT with trailing spaces — spaces are trimmed before appending",
			query: "SELECT 1   ",
			n:     50,
			want:  "SELECT 1 LIMIT 50",
		},
		{
			name:  "SELECT with trailing semicolon",
			query: "SELECT * FROM t;",
			n:     10,
			want:  "SELECT * FROM t LIMIT 10;",
		},
		{
			name:  "lowercase select",
			query: "select * from t",
			n:     5,
			want:  "select * from t LIMIT 5",
		},

		// No-injection cases (query already has LIMIT)
		{
			name:  "already has LIMIT uppercase",
			query: "SELECT * FROM t LIMIT 50",
			n:     200,
			want:  "SELECT * FROM t LIMIT 50",
		},
		{
			name:  "already has LIMIT lowercase",
			query: "select * from t limit 10",
			n:     200,
			want:  "select * from t limit 10",
		},
		{
			name:  "subquery LIMIT — conservative, no injection",
			query: "SELECT id FROM (SELECT id FROM t LIMIT 100) sub",
			n:     200,
			want:  "SELECT id FROM (SELECT id FROM t LIMIT 100) sub",
		},

		// Non-SELECT — never inject
		{
			name:  "UPDATE unchanged",
			query: "UPDATE t SET x=1 WHERE id=2",
			n:     200,
			want:  "UPDATE t SET x=1 WHERE id=2",
		},
		{
			name:  "DELETE unchanged",
			query: "DELETE FROM t WHERE id=1",
			n:     200,
			want:  "DELETE FROM t WHERE id=1",
		},
		{
			name:  "INSERT unchanged",
			query: "INSERT INTO t (x) VALUES (1)",
			n:     200,
			want:  "INSERT INTO t (x) VALUES (1)",
		},
		{
			name:  "SHOW unchanged",
			query: "SHOW DATABASES",
			n:     200,
			want:  "SHOW DATABASES",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := InjectLimit(tc.query, tc.n)
			want := tc.want
			if want == "" {
				want = tc.query
			}
			if got != want {
				t.Errorf("\ninput: %q\n  got: %q\n want: %q", tc.query, got, want)
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// coerce — unit tests using a dummy ColumnType via SQLite
// ─────────────────────────────────────────────────────────────────────────────

// We use an in-memory SQLite DB to generate real *sql.ColumnType values.
// The MySQL driver type names are tested via the string-path since SQLite
// returns different database type names.

func TestCoerce_NilRaw(t *testing.T) {
	// nil raw bytes must return nil regardless of type.
	var ct *sql.ColumnType // will be nil
	if ct != nil {
		t.Fatal("sanity: ct should be nil")
	}
	// Call coerce directly with nil raw and a stand-in nil ct.
	// isIntType("") == false, isFloatType("") == false → falls through to string.
	// But nil raw should be caught before type switch.
	result := coerce(nil, nilColumnType{})
	if result != nil {
		t.Errorf("expected nil for NULL raw, got %v", result)
	}
}

func TestCoerce_IntTypes(t *testing.T) {
	cases := []struct {
		dbType string
		raw    string
		want   any
	}{
		{"INT", "42", int64(42)},
		{"BIGINT", "-1000000000000", int64(-1000000000000)},
		{"TINYINT", "127", int64(127)},
		{"SMALLINT", "32767", int64(32767)},
		{"YEAR", "2024", int64(2024)},
		// Unparseable int → falls back to string
		{"INT", "not-a-number", "not-a-number"},
	}
	for _, tc := range cases {
		t.Run(tc.dbType+"/"+tc.raw, func(t *testing.T) {
			got := coerce(sql.RawBytes(tc.raw), fakeColumnType{tc.dbType})
			if got != tc.want {
				t.Errorf("coerce(%q,%q) = %v (%T), want %v (%T)",
					tc.raw, tc.dbType, got, got, tc.want, tc.want)
			}
		})
	}
}

func TestCoerce_FloatTypes(t *testing.T) {
	cases := []struct {
		dbType string
		raw    string
		want   any
	}{
		{"FLOAT", "3.14", float64(3.14)},
		{"DOUBLE", "2.718281828", float64(2.718281828)},
		{"DECIMAL", "99.99", float64(99.99)},
		{"NUMERIC", "-0.001", float64(-0.001)},
		// Unparseable → string
		{"FLOAT", "NaN-value", "NaN-value"},
	}
	for _, tc := range cases {
		t.Run(tc.dbType+"/"+tc.raw, func(t *testing.T) {
			got := coerce(sql.RawBytes(tc.raw), fakeColumnType{tc.dbType})
			if got != tc.want {
				t.Errorf("coerce(%q,%q) = %v, want %v", tc.raw, tc.dbType, got, tc.want)
			}
		})
	}
}

func TestCoerce_BoolType(t *testing.T) {
	cases := []struct {
		raw  string
		want any
	}{
		{"1", true},
		{"0", false},
		{"true", true},
		{"false", false},
		{"TRUE", true},
		{"FALSE", false},
		{"maybe", "maybe"}, // unrecognised → string
	}
	for _, tc := range cases {
		t.Run(tc.raw, func(t *testing.T) {
			got := coerce(sql.RawBytes(tc.raw), fakeColumnType{"BIT"})
			if got != tc.want {
				t.Errorf("coerce(%q, BIT) = %v (%T), want %v (%T)",
					tc.raw, got, got, tc.want, tc.want)
			}
		})
	}
}

func TestCoerce_StringFallback(t *testing.T) {
	cases := []string{"VARCHAR", "TEXT", "BLOB", "DATETIME", "JSON", "CHAR", "TIMESTAMP"}
	for _, dbType := range cases {
		t.Run(dbType, func(t *testing.T) {
			raw := sql.RawBytes("hello world")
			got := coerce(raw, fakeColumnType{dbType})
			if got != "hello world" {
				t.Errorf("coerce(%q, %q) = %v, want string", "hello world", dbType, got)
			}
		})
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// materialiseRows — end-to-end via in-memory SQLite
// ─────────────────────────────────────────────────────────────────────────────

func TestMaterialiseRows_Basic(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`CREATE TABLE t (id INTEGER, name TEXT, score REAL)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO t VALUES (1,'alice',9.5),(2,'bob',8.0),(3,NULL,NULL)`); err != nil {
		t.Fatalf("insert: %v", err)
	}

	rows, err := db.QueryContext(context.Background(), "SELECT id, name, score FROM t ORDER BY id")
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()

	result, execErr := materialiseRows(rows, 100)
	if execErr != nil {
		t.Fatalf("materialiseRows: %v", execErr)
	}

	if result.RowCount != 3 {
		t.Errorf("want RowCount=3, got %d", result.RowCount)
	}
	if result.Truncated {
		t.Error("should not be truncated")
	}

	// Row 0: id=1, name="alice", score=9.5
	r0 := result.Rows[0]
	if r0["name"] != "alice" {
		t.Errorf("row0[name]: got %v", r0["name"])
	}

	// Row 2: NULL values should be nil
	r2 := result.Rows[2]
	if r2["name"] != nil {
		t.Errorf("row2[name]: expected nil, got %v", r2["name"])
	}
	if r2["score"] != nil {
		t.Errorf("row2[score]: expected nil, got %v", r2["score"])
	}
}

func TestMaterialiseRows_Truncation(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if _, err := db.Exec(`CREATE TABLE nums (n INTEGER)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	for i := range 20 {
		db.Exec(`INSERT INTO nums VALUES (?)`, i)
	}

	rows, _ := db.QueryContext(context.Background(), "SELECT n FROM nums")
	defer rows.Close()

	result, _ := materialiseRows(rows, 5)
	if result.RowCount != 5 {
		t.Errorf("want RowCount=5, got %d", result.RowCount)
	}
	if !result.Truncated {
		t.Error("should be truncated")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ExecuteQuery via Manager with real SQLite pool
// ─────────────────────────────────────────────────────────────────────────────

func TestExecuteQuery_LimitInjection(t *testing.T) {
	// Register a SQLite-backed connection in the Manager.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE items (id INTEGER, label TEXT)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	for i := range 50 {
		db.Exec(`INSERT INTO items VALUES (?, ?)`, i, "x")
	}

	m := NewManager()
	// Bypass Connect by injecting the pool directly.
	m.mu.Lock()
	m.pools["test"] = &dbEntry{db: db, cfg: ConnectionConfig{ID: "test", Kind: "mysql"}}
	m.mu.Unlock()

	// Query without LIMIT + limit=10 → LIMIT 10 is injected into the SQL.
	// The DB returns exactly 10 rows so Truncated stays false (the DB-side
	// LIMIT is enforced, not the Go-side cap).
	res := m.ExecuteQuery(context.Background(), "test", "SELECT * FROM items", 10)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.RowCount != 10 {
		t.Errorf("want 10 rows (limit injected), got %d", res.RowCount)
	}
	// Truncated is false because the SQL LIMIT was injected — the DB only
	// streamed 10 rows and rows.Next() returned false naturally.
	if res.Truncated {
		t.Error("should NOT be truncated when DB-side LIMIT is injected")
	}

	// Verify columns slice is populated.
	if len(res.Columns) != 2 {
		t.Errorf("want 2 columns, got %v", res.Columns)
	}

	// Verify named-map access.
	if _, ok := res.Rows[0]["id"]; !ok {
		t.Error("expected 'id' key in row map")
	}

	// Separate truncation test: Go-side cap is hit (no SQL LIMIT, cap < rows returned).
	// We set limit=3 but the DB still returns 10 rows because "SELECT * FROM items LIMIT 3"
	// → only 3 rows from DB → Truncated=false. So to test Go-side cap we need
	// a query that already has a LIMIT larger than our cap.
	res2 := m.ExecuteQuery(context.Background(), "test", "SELECT * FROM items LIMIT 50", 5)
	if res2.Error != "" {
		t.Fatalf("unexpected error: %s", res2.Error)
	}
	if res2.RowCount != 5 {
		t.Errorf("want RowCount=5 (Go-side cap), got %d", res2.RowCount)
	}
	if !res2.Truncated {
		t.Error("should be truncated when Go-side cap is hit before DB exhausted")
	}
}

func TestExecuteQuery_UnknownConn(t *testing.T) {
	m := NewManager()
	res := m.ExecuteQuery(context.Background(), "ghost", "SELECT 1", 10)
	if res.Error == "" {
		t.Error("expected error for unknown connection")
	}
	if !strings.Contains(res.Error, "ghost") {
		t.Errorf("error should mention the connection ID; got: %s", res.Error)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake ColumnType helpers for coerce tests
// ─────────────────────────────────────────────────────────────────────────────

// fakeColumnType satisfies the columnTyper interface (only DatabaseTypeName is needed).
type fakeColumnType struct{ dbType string }

func (f fakeColumnType) DatabaseTypeName() string { return f.dbType }

// nilColumnType for the nil-raw-bytes test.
type nilColumnType struct{}

func (n nilColumnType) DatabaseTypeName() string { return "" }
