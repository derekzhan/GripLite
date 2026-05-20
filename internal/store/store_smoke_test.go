package store

import (
	"database/sql"
	"testing"

	"GripLite/internal/db"
	_ "modernc.org/sqlite"
)

// newTestStore creates a ConnectionStore backed by a fresh griplite.db in a
// temp dir.  The store is automatically closed via t.Cleanup.
func newTestStore(t *testing.T) *ConnectionStore {
	t.Helper()
	database, _, err := db.Open(t.TempDir())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return NewFromDB(database)
}

// TestStore_SaveAndGet verifies that Save followed by Get returns the full
// connection including a decrypted password.
func TestStore_SaveAndGet(t *testing.T) {
	s := newTestStore(t)

	conn := SavedConnection{
		ID:       "conn-1",
		Name:     "Local MySQL",
		Kind:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Username: "root",
		Password: "secret-123",
		Database: "shop",
		TLS:      false,
		SSH: SSHConfig{
			Enabled:  true,
			Host:     "bastion.example.com",
			Port:     22,
			User:     "deploy",
			AuthType: "password",
			Password: "ssh-secret",
		},
		AdvancedParams: []AdvancedParam{
			{Key: "allowMultiQueries", Value: "true", Enabled: true},
			{Key: "serverTimezone", Value: "UTC", Enabled: false},
		},
	}

	if err := s.Save(conn); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := s.Get("conn-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get returned nil")
	}

	// Passwords must be returned in plaintext after decryption.
	if got.Password != "secret-123" {
		t.Errorf("Password: want %q, got %q", "secret-123", got.Password)
	}
	if got.SSH.Password != "ssh-secret" {
		t.Errorf("SSH.Password: want %q, got %q", "ssh-secret", got.SSH.Password)
	}

	// Other fields must round-trip exactly.
	if got.Name != conn.Name || got.Host != conn.Host || got.Port != conn.Port {
		t.Errorf("basic fields mismatch: %+v", got)
	}
	if !got.SSH.Enabled || got.SSH.Host != "bastion.example.com" {
		t.Errorf("SSH not round-tripped: %+v", got.SSH)
	}
	if len(got.AdvancedParams) != 2 || got.AdvancedParams[0].Key != "allowMultiQueries" {
		t.Errorf("AdvancedParams not round-tripped: %+v", got.AdvancedParams)
	}
}

// TestStore_ListRedactsPasswords verifies that List() returns all connections
// but with empty password fields (security invariant).
func TestStore_ListRedactsPasswords(t *testing.T) {
	s := newTestStore(t)

	if err := s.Save(SavedConnection{ID: "a", Name: "A", Host: "h1", Port: 3306, Password: "p1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(SavedConnection{ID: "b", Name: "B", Host: "h2", Port: 3306, Password: "p2", SSH: SSHConfig{Password: "ssh-p2"}}); err != nil {
		t.Fatal(err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(list))
	}
	for _, c := range list {
		if c.Password != "" {
			t.Errorf("conn %q leaks password: %q", c.ID, c.Password)
		}
		if c.SSH.Password != "" {
			t.Errorf("conn %q leaks ssh password: %q", c.ID, c.SSH.Password)
		}
	}
}

// TestStore_UpdateRoundTrip verifies that Save upserts — updating an existing
// row rather than creating a duplicate.
func TestStore_UpdateRoundTrip(t *testing.T) {
	s := newTestStore(t)

	first := SavedConnection{ID: "x", Name: "original", Host: "h", Port: 3306, Password: "p1"}
	if err := s.Save(first); err != nil {
		t.Fatal(err)
	}

	updated := first
	updated.Name = "renamed"
	updated.Password = "p2"
	if err := s.Save(updated); err != nil {
		t.Fatal(err)
	}

	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 row after update, got %d", len(list))
	}

	got, _ := s.Get("x")
	if got.Name != "renamed" || got.Password != "p2" {
		t.Errorf("update not persisted: %+v", got)
	}
}

func TestStore_NewFromDBMigratesExistingConnectionSchema(t *testing.T) {
	database, err := sql.Open("sqlite", "file:"+t.TempDir()+"/legacy.db?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		t.Fatalf("sql.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	_, err = database.Exec(`CREATE TABLE connections (
		id                    TEXT PRIMARY KEY,
		name                  TEXT NOT NULL DEFAULT '',
		comment               TEXT NOT NULL DEFAULT '',
		kind                  TEXT NOT NULL DEFAULT 'mysql',
		host                  TEXT NOT NULL DEFAULT '',
		port                  INTEGER NOT NULL DEFAULT 3306,
		username              TEXT NOT NULL DEFAULT '',
		encrypted_password    TEXT NOT NULL DEFAULT '',
		database              TEXT NOT NULL DEFAULT '',
		tls                   INTEGER NOT NULL DEFAULT 0,
		ssh_config_json       TEXT NOT NULL DEFAULT '{}',
		ssh_pw_enc            TEXT NOT NULL DEFAULT '',
		advanced_options_json TEXT NOT NULL DEFAULT '[]',
		created_at            TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
	)`)
	if err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	_, err = database.Exec(`INSERT INTO connections
		(id, name, kind, host, port, ssh_config_json, advanced_options_json)
		VALUES ('legacy', 'Legacy DB', 'mysql', '127.0.0.1', 3306, '{}', '[]')`)
	if err != nil {
		t.Fatalf("insert legacy connection: %v", err)
	}

	s := NewFromDB(database)
	list, err := s.List()
	if err != nil {
		t.Fatalf("List after NewFromDB migration: %v", err)
	}
	if len(list) != 1 || list[0].ID != "legacy" {
		t.Fatalf("legacy connection not preserved: %+v", list)
	}
	if !s.schemaReady {
		t.Fatalf("NewFromDB should cache successful schema migration")
	}
}

func TestStore_EnsureSchemaCachesSuccessfulMigration(t *testing.T) {
	s := newTestStore(t)
	if !s.schemaReady {
		t.Fatalf("new test store should start with schemaReady=true")
	}
	s.schemaReady = false
	if err := s.ensureSchema(); err != nil {
		t.Fatalf("ensureSchema: %v", err)
	}
	if !s.schemaReady {
		t.Fatalf("ensureSchema should mark schemaReady after success")
	}
}

// TestStore_Delete verifies that Delete removes the row and subsequent Get
// returns a "not found" error per the store contract.
func TestStore_Delete(t *testing.T) {
	s := newTestStore(t)

	_ = s.Save(SavedConnection{ID: "dead", Name: "to-delete", Host: "h", Port: 3306})

	if err := s.Delete("dead"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	got, err := s.Get("dead")
	if err == nil {
		t.Fatal("expected not-found error, got nil")
	}
	if got != nil {
		t.Errorf("Get after delete: expected nil, got %+v", got)
	}

	// Deleting a nonexistent ID should also report "not found".
	if err := s.Delete("dead"); err == nil {
		t.Error("second Delete: expected not-found error, got nil")
	}
}

// TestStore_GetUnknown verifies that Get on a missing ID returns (nil, error).
func TestStore_GetUnknown(t *testing.T) {
	s := newTestStore(t)

	got, err := s.Get("nope")
	if err == nil {
		t.Fatal("expected not-found error, got nil")
	}
	if got != nil {
		t.Errorf("expected nil for missing ID, got %+v", got)
	}
}

// TestStore_EmptyPasswordsAreBlank verifies that empty passwords remain empty
// after round-trip (i.e. we don't accidentally encrypt "" into non-empty data).
func TestStore_EmptyPasswordsAreBlank(t *testing.T) {
	s := newTestStore(t)

	_ = s.Save(SavedConnection{ID: "nopass", Name: "nopass", Host: "h", Port: 3306})

	got, _ := s.Get("nopass")
	if got == nil {
		t.Fatal("Get returned nil")
	}
	if got.Password != "" {
		t.Errorf("expected empty password, got %q", got.Password)
	}
}
