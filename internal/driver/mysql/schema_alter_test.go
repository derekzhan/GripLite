// Unit tests for the Phase 20 DDL diff engine.
//
// These tests exercise PreviewAlter directly — no live database required.
// Each test names one scenario and asserts on the exact SQL emitted so a
// regression in the generator is immediately visible in the diff.

package mysql

import (
	"strings"
	"testing"

	"GripLite/internal/driver"
)

func newDriver() *mysqlDriver {
	// PreviewAlter does not touch d.db so a zero struct is sufficient.
	return &mysqlDriver{}
}

func col(orig, name, typ string, notNull bool) driver.ColumnDraft {
	return driver.ColumnDraft{OriginalName: orig, Name: name, Type: typ, NotNull: notNull}
}

// usersBefore returns the canonical "users" snapshot used by most tests.
func usersBefore() []driver.ColumnDraft {
	return []driver.ColumnDraft{
		col("id", "id", "int(11)", true),
		col("username", "username", "varchar(64)", true),
		col("email", "email", "varchar(255)", true),
	}
}

func TestPreviewAlter_NoChanges(t *testing.T) {
	d := newDriver()
	req := driver.SchemaChangeRequest{
		Schema:     "app", Table: "users",
		OldColumns: usersBefore(), NewColumns: usersBefore(),
	}
	pv, err := d.PreviewAlter(req)
	if err != nil {
		t.Fatalf("PreviewAlter returned error: %v", err)
	}
	if len(pv.Statements) != 0 {
		t.Fatalf("expected 0 statements for identity diff, got %d: %+v", len(pv.Statements), pv.Statements)
	}
}

func TestPreviewAlter_AddColumnAtEnd(t *testing.T) {
	d := newDriver()
	after := append(usersBefore(), driver.ColumnDraft{Name: "created_at", Type: "datetime", NotNull: true})
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: usersBefore(), NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d", len(pv.Statements))
	}
	got := pv.Statements[0]
	if got.Kind != "add" {
		t.Errorf("kind = %q, want add", got.Kind)
	}
	want := "ALTER TABLE `app`.`users` ADD COLUMN `created_at` datetime NOT NULL AFTER `email`;"
	if got.SQL != want {
		t.Errorf("sql mismatch:\n got: %s\nwant: %s", got.SQL, want)
	}
}

func TestPreviewAlter_AddColumnFirst(t *testing.T) {
	d := newDriver()
	after := []driver.ColumnDraft{
		{Name: "tenant", Type: "bigint"}, // new, inserted at index 0
	}
	after = append(after, usersBefore()...)
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: usersBefore(), NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// Expect exactly 1 ADD (tenant FIRST) + reorders for existing columns.
	// The added column is emitted as FIRST; the rest keep their relative
	// order and receive MODIFY … AFTER statements.
	addCount := 0
	for _, st := range pv.Statements {
		if st.Kind == "add" {
			addCount++
			if !strings.Contains(st.SQL, "ADD COLUMN `tenant`") || !strings.HasSuffix(st.SQL, "FIRST;") {
				t.Errorf("unexpected add stmt: %s", st.SQL)
			}
		}
	}
	if addCount != 1 {
		t.Errorf("add count = %d, want 1", addCount)
	}
}

func TestPreviewAlter_DropColumn(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	after := []driver.ColumnDraft{before[0], before[2]} // drop username

	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: before, NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d: %+v", len(pv.Statements), pv.Statements)
	}
	want := "ALTER TABLE `app`.`users` DROP COLUMN `username`;"
	if pv.Statements[0].SQL != want {
		t.Errorf("sql mismatch:\n got: %s\nwant: %s", pv.Statements[0].SQL, want)
	}
	if len(pv.Warnings) == 0 {
		t.Errorf("expected a drop-destructive warning")
	}
}

func TestPreviewAlter_RenameColumn(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	after := make([]driver.ColumnDraft, len(before))
	copy(after, before)
	// Rename username → user_name (same type).
	after[1] = driver.ColumnDraft{OriginalName: "username", Name: "user_name", Type: "varchar(64)", NotNull: true}

	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: before, NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d", len(pv.Statements))
	}
	got := pv.Statements[0]
	if got.Kind != "rename" {
		t.Errorf("kind = %q, want rename", got.Kind)
	}
	want := "ALTER TABLE `app`.`users` CHANGE COLUMN `username` `user_name` varchar(64) NOT NULL;"
	if got.SQL != want {
		t.Errorf("sql mismatch:\n got: %s\nwant: %s", got.SQL, want)
	}
}

func TestPreviewAlter_ModifyColumn(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	after := make([]driver.ColumnDraft, len(before))
	copy(after, before)
	// Widen email varchar(255) → varchar(320) and drop NOT NULL.
	after[2] = driver.ColumnDraft{OriginalName: "email", Name: "email", Type: "varchar(320)", NotNull: false}

	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: before, NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d", len(pv.Statements))
	}
	got := pv.Statements[0]
	if got.Kind != "modify" {
		t.Errorf("kind = %q, want modify", got.Kind)
	}
	want := "ALTER TABLE `app`.`users` MODIFY COLUMN `email` varchar(320) NULL;"
	if got.SQL != want {
		t.Errorf("sql mismatch:\n got: %s\nwant: %s", got.SQL, want)
	}
}

func TestPreviewAlter_ReorderOnly(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	// Move email to position 1: [id, email, username]
	after := []driver.ColumnDraft{before[0], before[2], before[1]}

	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema: "app", Table: "users",
		OldColumns: before, NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// Both email (position 1) and username (position 2) changed positions,
	// so we emit 2 reorder statements — one per moved column.
	if len(pv.Statements) != 2 {
		t.Fatalf("want 2 stmts, got %d: %+v", len(pv.Statements), pv.Statements)
	}
	for _, st := range pv.Statements {
		if st.Kind != "reorder" {
			t.Errorf("kind = %q, want reorder", st.Kind)
		}
		if !strings.Contains(st.SQL, "MODIFY COLUMN") {
			t.Errorf("stmt missing MODIFY COLUMN: %s", st.SQL)
		}
	}
	// First reorder places email AFTER id.
	if !strings.Contains(pv.Statements[0].SQL, "`email`") ||
		!strings.Contains(pv.Statements[0].SQL, "AFTER `id`") {
		t.Errorf("unexpected first reorder: %s", pv.Statements[0].SQL)
	}
}

func TestPreviewAlter_TableOptions(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{Engine: "InnoDB", Collation: "utf8mb4_0900_ai_ci", Comment: "old"},
		Updated:    driver.TableInfoDraft{Engine: "InnoDB", Collation: "utf8mb4_unicode_ci", Comment: "People"},
		OldColumns: before,
		NewColumns: before,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d: %+v", len(pv.Statements), pv.Statements)
	}
	got := pv.Statements[0]
	if got.Kind != "table" {
		t.Errorf("kind = %q, want table", got.Kind)
	}
	want := "ALTER TABLE `app`.`users` DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci, COMMENT = 'People';"
	if got.SQL != want {
		t.Errorf("sql mismatch:\n got: %s\nwant: %s", got.SQL, want)
	}
}

func TestPreviewAlter_CharsetOnlyChange(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{Charset: "utf8mb4", Collation: "utf8mb4_unicode_ci"},
		Updated:    driver.TableInfoDraft{Charset: "latin1", Collation: "utf8mb4_unicode_ci"},
		OldColumns: before,
		NewColumns: before,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d", len(pv.Statements))
	}
	want := "ALTER TABLE `app`.`users` DEFAULT CHARSET = latin1 COLLATE = utf8mb4_unicode_ci;"
	if pv.Statements[0].SQL != want {
		t.Errorf("sql:\n got: %s\nwant: %s", pv.Statements[0].SQL, want)
	}
}

func TestPreviewAlter_AutoIncrementChange(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	old1 := int64(1)
	new1000 := int64(1000)
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{AutoIncrement: &old1},
		Updated:    driver.TableInfoDraft{AutoIncrement: &new1000},
		OldColumns: before,
		NewColumns: before,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d: %+v", len(pv.Statements), pv.Statements)
	}
	want := "ALTER TABLE `app`.`users` AUTO_INCREMENT = 1000;"
	if pv.Statements[0].SQL != want {
		t.Errorf("sql:\n got: %s\nwant: %s", pv.Statements[0].SQL, want)
	}
}

func TestPreviewAlter_AutoIncrementNilIgnored(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{},
		Updated:    driver.TableInfoDraft{},
		OldColumns: before,
		NewColumns: before,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 0 {
		t.Fatalf("want 0 stmts, got %d", len(pv.Statements))
	}
}

func TestPreviewAlter_RenameTable(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{Name: "users"},
		Updated:    driver.TableInfoDraft{Name: "people"},
		OldColumns: before,
		NewColumns: before,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 1 {
		t.Fatalf("want 1 stmt, got %d", len(pv.Statements))
	}
	st := pv.Statements[0]
	if st.Kind != "rename" {
		t.Errorf("kind = %q, want rename", st.Kind)
	}
	want := "RENAME TABLE `app`.`users` TO `app`.`people`;"
	if st.SQL != want {
		t.Errorf("sql:\n got: %s\nwant: %s", st.SQL, want)
	}
}

func TestPreviewAlter_RenameTableLastAfterColumnChanges(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	after := []driver.ColumnDraft{
		col("id", "id", "int(11)", true),
		col("username", "username", "varchar(64)", true),
		col("email", "email", "varchar(255)", true),
		{Name: "score", Type: "int(11)"},
	}
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{Name: "users"},
		Updated:    driver.TableInfoDraft{Name: "people"},
		OldColumns: before,
		NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pv.Statements) != 2 {
		t.Fatalf("want 2 stmts (add + rename), got %d", len(pv.Statements))
	}
	if pv.Statements[0].Kind != "add" {
		t.Errorf("stmt[0].kind = %q, want add", pv.Statements[0].Kind)
	}
	if pv.Statements[1].Kind != "rename" {
		t.Errorf("stmt[1].kind = %q, want rename", pv.Statements[1].Kind)
	}
	if !strings.Contains(pv.Statements[0].SQL, "`app`.`users`") {
		t.Errorf("add stmt should target original name: %s", pv.Statements[0].SQL)
	}
}

func TestPreviewAlter_Combined(t *testing.T) {
	d := newDriver()
	before := usersBefore()
	// Drop username, rename email → email_addr, add status, change comment.
	after := []driver.ColumnDraft{
		{OriginalName: "id", Name: "id", Type: "int(11)", NotNull: true},
		{OriginalName: "email", Name: "email_addr", Type: "varchar(255)", NotNull: true},
		{Name: "status", Type: "varchar(16)", NotNull: true, Comment: "active/banned"},
	}
	pv, err := d.PreviewAlter(driver.SchemaChangeRequest{
		Schema:     "app",
		Table:      "users",
		Original:   driver.TableInfoDraft{Comment: ""},
		Updated:    driver.TableInfoDraft{Comment: "People"},
		OldColumns: before, NewColumns: after,
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// Expected order: drop username, rename email, add status, table comment.
	kinds := []string{}
	for _, st := range pv.Statements {
		kinds = append(kinds, st.Kind)
	}
	// Note: the reorder phase also sees email moving from idx 2 → idx 1
	// but we skip reorders for columns whose definition changed this pass,
	// so the expected kinds are exactly:
	wantKinds := []string{"drop", "rename", "add", "table"}
	if !equalStringSlice(kinds, wantKinds) {
		t.Errorf("kinds = %v, want %v", kinds, wantKinds)
	}
	// Comment spec must be properly escaped.
	var addStmt string
	for _, st := range pv.Statements {
		if st.Kind == "add" {
			addStmt = st.SQL
		}
	}
	if !strings.Contains(addStmt, "COMMENT 'active/banned'") {
		t.Errorf("add stmt missing comment: %s", addStmt)
	}
}

func TestBuildColumnSpec_DefaultAndComment(t *testing.T) {
	c := driver.ColumnDraft{
		Name: "status", Type: "enum('active','banned')", NotNull: true,
		HasDefault: true, Default: "'active'",
		Comment: "user's state",
	}
	got := buildColumnSpec(c)
	want := "enum('active','banned') NOT NULL DEFAULT 'active' COMMENT 'user''s state'"
	if got != want {
		t.Errorf("got  = %q\nwant = %q", got, want)
	}
}

func TestBuildColumnSpec_AutoIncrement(t *testing.T) {
	c := driver.ColumnDraft{Name: "id", Type: "int(11)", NotNull: true, AutoIncrement: true}
	got := buildColumnSpec(c)
	want := "int(11) NOT NULL AUTO_INCREMENT"
	if got != want {
		t.Errorf("got = %q, want %q", got, want)
	}
}

func TestQuoteStringLiteral(t *testing.T) {
	cases := map[string]string{
		"":           "''",
		"hi":         "'hi'",
		"it's":       "'it''s'",
		`a\b`:        `'a\\b'`,
		`it's \ fun`: `'it''s \\ fun'`,
	}
	for in, want := range cases {
		got := quoteStringLiteral(in)
		if got != want {
			t.Errorf("quoteStringLiteral(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCharsetFromCollation(t *testing.T) {
	cases := map[string]string{
		"utf8mb4_unicode_ci": "utf8mb4",
		"latin1_swedish_ci":  "latin1",
		"binary":             "",
		"":                   "",
	}
	for in, want := range cases {
		if got := charsetFromCollation(in); got != want {
			t.Errorf("charsetFromCollation(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPositionClause(t *testing.T) {
	cols := []driver.ColumnDraft{
		{Name: "a"}, {Name: "b"}, {Name: "c"},
	}
	if got := positionClause(0, cols); got != " FIRST" {
		t.Errorf("idx 0 = %q, want ' FIRST'", got)
	}
	if got := positionClause(2, cols); got != " AFTER `b`" {
		t.Errorf("idx 2 = %q, want ' AFTER `b`'", got)
	}
}

func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
