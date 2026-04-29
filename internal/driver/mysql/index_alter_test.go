package mysql

import (
	"testing"

	"GripLite/internal/driver"
)

func TestPreviewIndexAlter_AddUniqueCompositeIndex(t *testing.T) {
	d := newDriver()
	pv, err := d.PreviewIndexAlter(driver.IndexChangeRequest{
		Schema: "app",
		Table:  "orders",
		NewIndexes: []driver.IndexDraft{{
			Name:    "uq_user_order",
			Type:    "BTREE",
			Unique:  true,
			Columns: []string{"user_id", "order_no"},
			Comment: "lookup",
		}},
	})
	if err != nil {
		t.Fatalf("PreviewIndexAlter returned error: %v", err)
	}
	assertSQL(t, pv, []string{
		"CREATE UNIQUE INDEX `uq_user_order` ON `app`.`orders` (`user_id`, `order_no`) USING BTREE COMMENT 'lookup';",
	})
}

func TestPreviewIndexAlter_DropIndex(t *testing.T) {
	d := newDriver()
	pv, err := d.PreviewIndexAlter(driver.IndexChangeRequest{
		Schema: "app",
		Table:  "orders",
		OldIndexes: []driver.IndexDraft{{
			OriginalName: "idx_created",
			Name:         "idx_created",
			Type:         "BTREE",
			Columns:      []string{"created_at"},
		}},
		NewIndexes: []driver.IndexDraft{},
	})
	if err != nil {
		t.Fatalf("PreviewIndexAlter returned error: %v", err)
	}
	assertSQL(t, pv, []string{
		"DROP INDEX `idx_created` ON `app`.`orders`;",
	})
	if len(pv.Warnings) != 1 {
		t.Fatalf("expected 1 warning for drop, got %d", len(pv.Warnings))
	}
}

func TestPreviewIndexAlter_ModifyIndexDropsAndRecreates(t *testing.T) {
	d := newDriver()
	oldIdx := driver.IndexDraft{
		OriginalName: "idx_user",
		Name:         "idx_user",
		Type:         "BTREE",
		Columns:      []string{"user_id"},
	}
	newIdx := oldIdx
	newIdx.Unique = true
	newIdx.Columns = []string{"user_id", "status"}

	pv, err := d.PreviewIndexAlter(driver.IndexChangeRequest{
		Schema:     "app",
		Table:      "orders",
		OldIndexes: []driver.IndexDraft{oldIdx},
		NewIndexes: []driver.IndexDraft{newIdx},
	})
	if err != nil {
		t.Fatalf("PreviewIndexAlter returned error: %v", err)
	}
	assertSQL(t, pv, []string{
		"DROP INDEX `idx_user` ON `app`.`orders`;",
		"CREATE UNIQUE INDEX `idx_user` ON `app`.`orders` (`user_id`, `status`) USING BTREE;",
	})
}

func TestPreviewIndexAlter_IgnoresPrimaryKey(t *testing.T) {
	d := newDriver()
	pv, err := d.PreviewIndexAlter(driver.IndexChangeRequest{
		Schema: "app",
		Table:  "orders",
		OldIndexes: []driver.IndexDraft{{
			OriginalName: "PRIMARY",
			Name:         "PRIMARY",
			Type:         "BTREE",
			Unique:       true,
			Columns:      []string{"id"},
		}},
		NewIndexes: []driver.IndexDraft{},
	})
	if err != nil {
		t.Fatalf("PreviewIndexAlter returned error: %v", err)
	}
	if len(pv.Statements) != 0 {
		t.Fatalf("expected PRIMARY changes to be ignored, got %+v", pv.Statements)
	}
}

func TestPreviewIndexAlter_RejectsDuplicateNames(t *testing.T) {
	d := newDriver()
	_, err := d.PreviewIndexAlter(driver.IndexChangeRequest{
		Schema: "app",
		Table:  "orders",
		NewIndexes: []driver.IndexDraft{
			{Name: "idx_a", Columns: []string{"a"}},
			{Name: "IDX_A", Columns: []string{"b"}},
		},
	})
	if err == nil {
		t.Fatal("expected duplicate index name error")
	}
}

func assertSQL(t *testing.T, pv *driver.SchemaChangePreview, want []string) {
	t.Helper()
	if len(pv.Statements) != len(want) {
		t.Fatalf("statement count = %d, want %d: %+v", len(pv.Statements), len(want), pv.Statements)
	}
	for i, sql := range want {
		if got := pv.Statements[i].SQL; got != sql {
			t.Fatalf("statement %d SQL = %q, want %q", i, got, sql)
		}
	}
}
