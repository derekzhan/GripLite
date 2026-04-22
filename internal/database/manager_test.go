package database

import (
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// DSN builder tests (no real DB required)
// ─────────────────────────────────────────────────────────────────────────────

func TestBuildDSN_DirectTCP(t *testing.T) {
	cfg := ConnectionConfig{
		Host:     "db.example.com",
		Port:     3306,
		Username: "alice",
		Password: "s3cr3t",
		Database: "shop",
	}

	dsn := buildDSN(cfg, "tcp")

	if !strings.Contains(dsn, "alice:s3cr3t@tcp(db.example.com:3306)/shop") {
		t.Errorf("unexpected DSN: %s", dsn)
	}
	if !strings.Contains(dsn, "parseTime=true") {
		t.Errorf("expected parseTime in DSN: %s", dsn)
	}
}

func TestBuildDSN_SSHProtocol(t *testing.T) {
	cfg := ConnectionConfig{
		Host:     "private-db:3306",
		Port:     3306,
		Username: "bob",
		Password: "pw",
		Database: "analytics",
	}

	dsn := buildDSN(cfg, "mgrssh_conn42")

	if !strings.Contains(dsn, "@mgrssh_conn42(") {
		t.Errorf("expected ssh proto name in DSN: %s", dsn)
	}
}

func TestBuildDSN_AdvancedParams(t *testing.T) {
	cfg := ConnectionConfig{
		Host:     "localhost",
		Port:     3306,
		Username: "root",
		Password: "",
		Database: "",
		Advanced: []AdvancedParam{
			{Key: "allowMultiQueries", Value: "true", Enabled: true},
			{Key: "charset", Value: "latin1", Enabled: true},
			{Key: "disabled", Value: "ignored", Enabled: false},
		},
	}

	dsn := buildDSN(cfg, "tcp")

	if !strings.Contains(dsn, "allowMultiQueries=true") {
		t.Errorf("missing advanced param in DSN: %s", dsn)
	}
	// charset appears in Advanced — it should override the default value (or be present)
	if !strings.Contains(dsn, "charset=") {
		t.Errorf("missing charset in DSN: %s", dsn)
	}
	if strings.Contains(dsn, "disabled=ignored") {
		t.Errorf("disabled param must not appear in DSN: %s", dsn)
	}
}

func TestBuildDSN_TLS(t *testing.T) {
	cfg := ConnectionConfig{
		Host:     "secure.db",
		Port:     3306,
		Username: "u",
		Password: "p",
		Database: "d",
		TLS:      true,
	}

	dsn := buildDSN(cfg, "tcp")

	if !strings.Contains(dsn, "tls=true") {
		t.Errorf("expected tls in DSN: %s", dsn)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager pool map tests (no real DB — Connect is not called)
// ─────────────────────────────────────────────────────────────────────────────

func TestManager_DBNotFound(t *testing.T) {
	m := NewManager()
	_, ok := m.DB("nonexistent")
	if ok {
		t.Error("expected ok=false for unknown connection ID")
	}
}

func TestManager_IDsEmpty(t *testing.T) {
	m := NewManager()
	if ids := m.IDs(); len(ids) != 0 {
		t.Errorf("expected empty IDs, got %v", ids)
	}
}

func TestManager_DisconnectNotFound(t *testing.T) {
	m := NewManager()
	err := m.Disconnect("ghost")
	if err == nil {
		t.Error("expected error for disconnecting non-existent ID")
	}
}

func TestManager_CloseAllEmpty(t *testing.T) {
	m := NewManager()
	m.CloseAll() // must not panic
}

// ─────────────────────────────────────────────────────────────────────────────
// Crypto wrapper tests
// ─────────────────────────────────────────────────────────────────────────────

func TestEncryptDecryptWrappers(t *testing.T) {
	plain := "mypassword123"
	enc, err := EncryptPassword(plain)
	if err != nil {
		t.Fatalf("EncryptPassword: %v", err)
	}
	got, err := DecryptPassword(enc)
	if err != nil {
		t.Fatalf("DecryptPassword: %v", err)
	}
	if got != plain {
		t.Errorf("want %q, got %q", plain, got)
	}
}
