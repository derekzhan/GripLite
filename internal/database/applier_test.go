package database

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// Test fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

// newApplierDB creates an in-memory SQLite DB with a simple "users" table and
// registers it in a Manager under the ID "conn1".
func newApplierDB(t *testing.T) (*Manager, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.SetMaxOpenConns(1)

	schema := `CREATE TABLE users (
		id      INTEGER PRIMARY KEY AUTOINCREMENT,
		name    TEXT    NOT NULL DEFAULT '',
		email   TEXT    NOT NULL DEFAULT '',
		age     INTEGER NOT NULL DEFAULT 0
	)`
	if _, err := db.Exec(schema); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO users (name, email, age) VALUES
		('alice', 'alice@a.com', 30),
		('bob',   'bob@b.com',   25),
		('carol', 'carol@c.com', 35),
		('dave',  'dave@d.com',  40)`); err != nil {
		t.Fatalf("seed data: %v", err)
	}

	m := NewManager()
	m.mu.Lock()
	m.pools["conn1"] = &dbEntry{db: db, cfg: ConnectionConfig{ID: "conn1"}}
	m.mu.Unlock()

	return m, db
}

// countRows returns the number of rows in the table.
func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// fetchUser reads a single user row by id; returns nil if not found.
func fetchUser(t *testing.T, db *sql.DB, id int) map[string]any {
	t.Helper()
	row := db.QueryRow("SELECT id, name, email, age FROM users WHERE id = ?", id)
	var rid, age int64
	var name, email string
	if err := row.Scan(&rid, &name, &email, &age); err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		t.Fatalf("fetchUser %d: %v", id, err)
	}
	return map[string]any{"id": rid, "name": name, "email": email, "age": age}
}

// baseCS returns a minimal valid ChangeSet skeleton.
func baseCS() ChangeSet {
	return ChangeSet{
		ConnectionID: "conn1",
		TableName:    "users",
		PrimaryKey:   "id",
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_Delete(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.DeletedIds = []any{int64(2), int64(4)} // delete bob and dave

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.DeletedCount != 2 {
		t.Errorf("want DeletedCount=2, got %d", res.DeletedCount)
	}

	if countRows(t, db, "users") != 2 {
		t.Errorf("want 2 rows remaining, got %d", countRows(t, db, "users"))
	}
	if fetchUser(t, db, 2) != nil {
		t.Error("bob should have been deleted")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERT
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_Insert(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.AddedRows = []map[string]any{
		{"name": "eve", "email": "eve@e.com", "age": int64(28)},
		{"name": "frank", "email": "frank@f.com", "age": int64(45)},
	}

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.InsertedCount != 2 {
		t.Errorf("want InsertedCount=2, got %d", res.InsertedCount)
	}

	if countRows(t, db, "users") != 6 {
		t.Errorf("want 6 rows, got %d", countRows(t, db, "users"))
	}
}

func TestApplyChanges_Insert_SkipsEmptyRow(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.AddedRows = []map[string]any{
		{},                                   // empty — must be skipped
		{"name": "valid", "email": "v@v.com", "age": int64(20)}, // real row
	}

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if countRows(t, db, "users") != 5 {
		t.Errorf("want 5 rows (empty row skipped), got %d", countRows(t, db, "users"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_Update(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.EditedRows = []map[string]any{
		{"id": int64(1), "email": "alice-new@a.com"},
		{"id": int64(3), "name": "CAROL", "age": int64(36)},
	}

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.UpdatedCount != 2 {
		t.Errorf("want UpdatedCount=2, got %d", res.UpdatedCount)
	}

	alice := fetchUser(t, db, 1)
	if alice["email"] != "alice-new@a.com" {
		t.Errorf("alice email: got %v", alice["email"])
	}

	carol := fetchUser(t, db, 3)
	if carol["name"] != "CAROL" {
		t.Errorf("carol name: got %v", carol["name"])
	}
	if carol["age"] != int64(36) {
		t.Errorf("carol age: got %v", carol["age"])
	}
}

func TestApplyChanges_Update_MissingPK(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.EditedRows = []map[string]any{
		{"email": "nopk@x.com"}, // no "id" field — must fail
	}

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error == "" {
		t.Error("expected error when PK is missing from editedRow")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Mixed mutations
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_Mixed(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.DeletedIds = []any{int64(4)}                                      // delete dave
	cs.AddedRows = []map[string]any{{"name": "eve", "email": "e@e.com", "age": int64(22)}} // add eve
	cs.EditedRows = []map[string]any{{"id": int64(1), "name": "ALICE"}}  // update alice

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.DeletedCount != 1 || res.InsertedCount != 1 || res.UpdatedCount != 1 {
		t.Errorf("counts: del=%d ins=%d upd=%d", res.DeletedCount, res.InsertedCount, res.UpdatedCount)
	}
	if res.TimeMs < 0 {
		t.Errorf("TimeMs should be non-negative, got %d", res.TimeMs)
	}
	if len(res.Statements) != 3 {
		t.Errorf("want 3 SQL statements logged, got %d: %v", len(res.Statements), res.Statements)
	}

	// Verify final DB state.
	if countRows(t, db, "users") != 4 { // 4 original - 1 deleted + 1 inserted
		t.Errorf("want 4 rows, got %d", countRows(t, db, "users"))
	}
	alice := fetchUser(t, db, 1)
	if alice["name"] != "ALICE" {
		t.Errorf("alice.name: got %v", alice["name"])
	}
	if fetchUser(t, db, 4) != nil {
		t.Error("dave should have been deleted")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback on error
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_Rollback(t *testing.T) {
	m, db := newApplierDB(t)
	defer db.Close()

	cs := baseCS()
	cs.DeletedIds = []any{int64(1)} // valid
	cs.AddedRows = []map[string]any{
		{"nonexistent_col": "will_fail"}, // INSERT into nonexistent column → error
	}

	res := m.ApplyChanges(context.Background(), cs)
	if res.Error == "" {
		t.Fatal("expected error due to bad INSERT")
	}

	// Row 1 must NOT have been deleted (transaction was rolled back).
	if fetchUser(t, db, 1) == nil {
		t.Error("alice should still exist after rollback")
	}
	if countRows(t, db, "users") != 4 {
		t.Errorf("expected 4 rows after rollback, got %d", countRows(t, db, "users"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

func TestApplyChanges_ValidationErrors(t *testing.T) {
	m, _ := newApplierDB(t)

	cases := []struct {
		name string
		cs   ChangeSet
	}{
		{
			name: "empty connectionId",
			cs:   ChangeSet{TableName: "users", PrimaryKey: "id", DeletedIds: []any{1}},
		},
		{
			name: "empty tableName",
			cs:   ChangeSet{ConnectionID: "conn1", PrimaryKey: "id", DeletedIds: []any{1}},
		},
		{
			name: "empty primaryKey",
			cs:   ChangeSet{ConnectionID: "conn1", TableName: "users", DeletedIds: []any{1}},
		},
		{
			name: "no mutations",
			cs:   ChangeSet{ConnectionID: "conn1", TableName: "users", PrimaryKey: "id"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := m.ApplyChanges(context.Background(), tc.cs)
			if res.Error == "" {
				t.Errorf("expected error for %q", tc.name)
			}
		})
	}
}

func TestApplyChanges_UnknownConnection(t *testing.T) {
	m := NewManager()
	cs := ChangeSet{
		ConnectionID: "ghost",
		TableName:    "t",
		PrimaryKey:   "id",
		DeletedIds:   []any{1},
	}
	res := m.ApplyChanges(context.Background(), cs)
	if res.Error == "" {
		t.Error("expected error for unknown connection")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// quoteIdent + SQL builder unit tests
// ─────────────────────────────────────────────────────────────────────────────

func TestQuoteIdent(t *testing.T) {
	cases := []struct{ in, want string }{
		{"users", "`users`"},
		{"my table", "`my table`"},
		{"has`backtick", "`has``backtick`"},
		{"", "``"},
	}
	for _, tc := range cases {
		got := quoteIdent(tc.in)
		if got != tc.want {
			t.Errorf("quoteIdent(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBuildInsert(t *testing.T) {
	sql := buildInsert("orders", []string{"amount", "status", "user_id"})
	want := "INSERT INTO `orders` (`amount`, `status`, `user_id`) VALUES (?, ?, ?)"
	if sql != want {
		t.Errorf("\n got: %q\nwant: %q", sql, want)
	}
}

func TestBuildUpdate(t *testing.T) {
	sql := buildUpdate("users", []string{"email", "name"}, "id")
	want := "UPDATE `users` SET `email` = ?, `name` = ? WHERE `id` = ?"
	if sql != want {
		t.Errorf("\n got: %q\nwant: %q", sql, want)
	}
}

func TestMapToSortedPairs(t *testing.T) {
	m := map[string]any{"z": 3, "a": 1, "m": 2}
	cols, vals := mapToSortedPairs(m)
	if len(cols) != 3 || cols[0] != "a" || cols[1] != "m" || cols[2] != "z" {
		t.Errorf("unexpected cols order: %v", cols)
	}
	if vals[0] != 1 || vals[1] != 2 || vals[2] != 3 {
		t.Errorf("unexpected vals: %v", vals)
	}
}

func TestMapToSortedPairsExcluding(t *testing.T) {
	m := map[string]any{"id": 99, "name": "alice", "email": "a@a.com"}
	cols, vals := mapToSortedPairsExcluding(m, "id")
	if len(cols) != 2 {
		t.Errorf("expected 2 cols after excluding id, got %v", cols)
	}
	for _, c := range cols {
		if c == "id" {
			t.Error("id should be excluded")
		}
	}
	if len(vals) != 2 {
		t.Errorf("expected 2 vals, got %v", vals)
	}
}
