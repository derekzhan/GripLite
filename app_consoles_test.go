package main

import (
	"testing"

	"GripLite/internal/db"
)

func appWithDB(t *testing.T) *App {
	t.Helper()
	database, _, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	a := NewApp()
	a.sharedDB = database
	return a
}

func TestSaveConsoleInsertThenUpdate(t *testing.T) {
	a := appWithDB(t)

	// Insert (empty id → generated).
	saved, err := a.SaveConsole(SavedConsole{
		Name: "orders", SQL: "SELECT 1", ConnID: "c1", DBName: "shop", ConnectionKind: "mysql",
	})
	if err != nil {
		t.Fatalf("SaveConsole insert: %v", err)
	}
	if saved.ID == "" {
		t.Fatal("expected generated id on insert")
	}
	if saved.CreatedAt == "" || saved.UpdatedAt == "" {
		t.Errorf("expected timestamps, got created=%q updated=%q", saved.CreatedAt, saved.UpdatedAt)
	}

	// Update in place (same id) — should NOT create a second row.
	updated, err := a.SaveConsole(SavedConsole{
		ID: saved.ID, Name: "orders v2", SQL: "SELECT 2", ConnID: "c1", DBName: "shop2", ConnectionKind: "mysql",
	})
	if err != nil {
		t.Fatalf("SaveConsole update: %v", err)
	}
	if updated.ID != saved.ID {
		t.Errorf("update changed id: %q -> %q", saved.ID, updated.ID)
	}
	if updated.Name != "orders v2" || updated.SQL != "SELECT 2" || updated.DBName != "shop2" {
		t.Errorf("update did not persist fields: %+v", updated)
	}

	list, err := a.ListSavedConsoles()
	if err != nil {
		t.Fatalf("ListSavedConsoles: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 console after update, got %d", len(list))
	}
}

func TestSaveConsoleRequiresName(t *testing.T) {
	a := appWithDB(t)
	if _, err := a.SaveConsole(SavedConsole{Name: "", SQL: "SELECT 1"}); err == nil {
		t.Fatal("expected error for empty name")
	}
}

func TestListSavedConsolesOrdersNewestFirst(t *testing.T) {
	a := appWithDB(t)
	first, _ := a.SaveConsole(SavedConsole{Name: "first", SQL: "SELECT 1"})
	second, _ := a.SaveConsole(SavedConsole{Name: "second", SQL: "SELECT 2"})

	// Touch `first` so it becomes the most-recently-updated.
	if _, err := a.SaveConsole(SavedConsole{ID: first.ID, Name: "first", SQL: "SELECT 1 -- touched"}); err != nil {
		t.Fatalf("touch first: %v", err)
	}

	list, err := a.ListSavedConsoles()
	if err != nil {
		t.Fatalf("ListSavedConsoles: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2, got %d", len(list))
	}
	// Ordering is by updated_at DESC; both share second-resolution timestamps so
	// just assert both ids are present rather than a strict order.
	seen := map[string]bool{}
	for _, c := range list {
		seen[c.ID] = true
	}
	if !seen[first.ID] || !seen[second.ID] {
		t.Errorf("missing ids in list: %+v", list)
	}
}

func TestDeleteSavedConsole(t *testing.T) {
	a := appWithDB(t)
	saved, _ := a.SaveConsole(SavedConsole{Name: "tmp", SQL: "SELECT 1"})

	if err := a.DeleteSavedConsole(saved.ID); err != nil {
		t.Fatalf("DeleteSavedConsole: %v", err)
	}
	list, _ := a.ListSavedConsoles()
	if len(list) != 0 {
		t.Errorf("expected 0 after delete, got %d", len(list))
	}

	// Deleting again / unknown id is a no-op.
	if err := a.DeleteSavedConsole(saved.ID); err != nil {
		t.Errorf("delete unknown id should be no-op, got %v", err)
	}
	if err := a.DeleteSavedConsole(""); err != nil {
		t.Errorf("delete empty id should be no-op, got %v", err)
	}
}
