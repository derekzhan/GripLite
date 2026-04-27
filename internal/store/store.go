// Package store provides persistent storage for GripLite connection configs.
//
// # Security model
//
// Passwords are NEVER written to disk in plain text.  Before inserting or
// updating a row the store encrypts each password field with AES-256-GCM using
// a static application key (encKey).  The key is hard-coded in v0.1 as a
// pragmatic minimum; future versions should derive it from the OS keychain
// (darwin: Security.framework / SecKeychainFind, Windows: DPAPI, Linux: libsecret).
//
// The nonce is generated fresh per encryption operation (crypto/rand) and is
// prepended to the ciphertext before base64 encoding, so each stored value is
// independently random even for identical passwords.
//
// # Storage
//
// In the normal (production) startup path the ConnectionStore shares the
// unified griplite.db opened by [internal/db.Open].  Pass the *sql.DB to
// [NewFromDB] to wire this up.
//
// [New] is a standalone constructor that opens its own griplite.db; it exists
// for testing and backward-compatibility only.
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"GripLite/internal/crypto"
)

// ─────────────────────────────────────────────────────────────────────────────
// Domain types  (IPC-serialisable, used between frontend and app.go)
// ─────────────────────────────────────────────────────────────────────────────

// SSHConfig is the SSH tunnel sub-form sent by the frontend.
type SSHConfig struct {
	Enabled        bool   `json:"enabled"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	AuthType       string `json:"authType"` // "password" | "keyPair"
	Password       string `json:"password"` // plain at runtime, encrypted at rest
	PrivateKeyPath string `json:"privateKeyPath"`
}

// AdvancedParam is a single driver-level key/value option (e.g. MySQL DSN param).
type AdvancedParam struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// SavedConnection is the full connection record exchanged over Wails IPC.
//
// When returned by List the Password fields are EMPTY for security.
// When returned by Get the Password fields are decrypted so the edit dialog
// can pre-populate them.
type SavedConnection struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Comment        string          `json:"comment"`
	Kind           string          `json:"kind"`
	Host           string          `json:"host"`
	Port           int             `json:"port"`
	Username       string          `json:"username"`
	Password       string          `json:"password"` // plain at runtime; empty in List responses
	Database       string          `json:"database"`
	TLS            bool            `json:"tls"`
	SSH            SSHConfig       `json:"ssh"`
	AdvancedParams []AdvancedParam `json:"advancedParams"`
	ReadOnly       bool            `json:"readOnly"`
	Color          string          `json:"color"` // e.g. "#ef4444" or "" for default
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
}

// ─────────────────────────────────────────────────────────────────────────────
// ConnectionStore
// ─────────────────────────────────────────────────────────────────────────────

// ConnectionStore reads and writes connection configs to the `connections`
// table in griplite.db.
//
// The zero value is unusable; create instances via [NewFromDB] or [New].
type ConnectionStore struct {
	db      *sql.DB
	ownDB   bool // true when New opened the DB and Close should shut it down
}

// tableDDL is used only by the standalone [New] constructor when it needs to
// bootstrap its own database file (the unified path uses internal/db).
const tableDDL = `
CREATE TABLE IF NOT EXISTS connections (
    id                    TEXT    PRIMARY KEY,
    name                  TEXT    NOT NULL DEFAULT '',
    comment               TEXT    NOT NULL DEFAULT '',
    kind                  TEXT    NOT NULL DEFAULT 'mysql',
    host                  TEXT    NOT NULL DEFAULT '',
    port                  INTEGER NOT NULL DEFAULT 3306,
    username              TEXT    NOT NULL DEFAULT '',
    encrypted_password    TEXT    NOT NULL DEFAULT '',
    database              TEXT    NOT NULL DEFAULT '',
    tls                   INTEGER NOT NULL DEFAULT 0,
    ssh_config_json       TEXT    NOT NULL DEFAULT '{}',
    ssh_pw_enc            TEXT    NOT NULL DEFAULT '',
    advanced_options_json TEXT    NOT NULL DEFAULT '[]',
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);`

// NewFromDB creates a ConnectionStore that operates on a shared *sql.DB
// (typically the unified griplite.db opened by internal/db.Open).
//
// The schema is assumed to be already applied; this constructor does NOT
// create the connections table.
func NewFromDB(db *sql.DB) *ConnectionStore {
	return &ConnectionStore{db: db, ownDB: false}
}

// New is a standalone constructor for testing or one-off tools.
// It opens (or creates) griplite.db at dir and applies the connections table DDL.
// Pass an empty dir to use the OS-default config directory.
func New(dir string) (*ConnectionStore, error) {
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			base = os.TempDir()
		}
		dir = filepath.Join(base, "GripLite")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: mkdir %q: %w", dir, err)
	}
	path := filepath.Join(dir, "griplite.db")
	db, err := sql.Open("sqlite", "file:"+path+"?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("store: open %q: %w", path, err)
	}
	if _, err = db.Exec(tableDDL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: apply schema: %w", err)
	}
	return &ConnectionStore{db: db, ownDB: true}, nil
}

// Close releases the database handle only when this store owns it (i.e. when
// it was opened by [New]).  If the DB is shared via [NewFromDB], Close is a
// no-op — the caller that opened the DB is responsible for closing it.
func (s *ConnectionStore) Close() error {
	if s.ownDB && s.db != nil {
		return s.db.Close()
	}
	return nil
}

// Save inserts or replaces a connection.  Passwords are encrypted before storage.
func (s *ConnectionStore) Save(c SavedConnection) error {
	if c.ID == "" {
		return fmt.Errorf("store: connection ID must not be empty")
	}
	if c.Kind == "" {
		c.Kind = "mysql"
	}
	if c.Port == 0 {
		c.Port = 3306
	}

	// Encrypt DB password.
	pwEnc, err := crypto.Encrypt(c.Password)
	if err != nil {
		return fmt.Errorf("store: encrypt password: %w", err)
	}

	// Build SSH JSON (with password stripped out — stored separately encrypted).
	sshNoPass := c.SSH
	sshNoPass.Password = ""
	sshJSON, err := json.Marshal(sshNoPass)
	if err != nil {
		return fmt.Errorf("store: marshal ssh: %w", err)
	}
	sshPwEnc, err := crypto.Encrypt(c.SSH.Password)
	if err != nil {
		return fmt.Errorf("store: encrypt ssh password: %w", err)
	}

	// Advanced params JSON.
	advJSON, err := json.Marshal(c.AdvancedParams)
	if err != nil {
		return fmt.Errorf("store: marshal advanced params: %w", err)
	}

	tls := 0
	if c.TLS {
		tls = 1
	}
	readOnly := 0
	if c.ReadOnly {
		readOnly = 1
	}
	now := time.Now().UTC().Format(time.RFC3339)

	_, err = s.db.Exec(`
		INSERT INTO connections
			(id, name, comment, kind, host, port, username, encrypted_password, database, tls,
			 ssh_config_json, ssh_pw_enc, advanced_options_json, read_only, color, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			name                  = excluded.name,
			comment               = excluded.comment,
			kind                  = excluded.kind,
			host                  = excluded.host,
			port                  = excluded.port,
			username              = excluded.username,
			encrypted_password    = excluded.encrypted_password,
			database              = excluded.database,
			tls                   = excluded.tls,
			ssh_config_json       = excluded.ssh_config_json,
			ssh_pw_enc            = excluded.ssh_pw_enc,
			advanced_options_json = excluded.advanced_options_json,
			read_only             = excluded.read_only,
			color                 = excluded.color,
			updated_at            = excluded.updated_at`,
		c.ID, c.Name, c.Comment, c.Kind, c.Host, c.Port, c.Username, pwEnc, c.Database, tls,
		string(sshJSON), sshPwEnc, string(advJSON), readOnly, c.Color, now, now,
	)
	return err
}

// List returns all saved connections with passwords OMITTED.
func (s *ConnectionStore) List() ([]SavedConnection, error) {
	rows, err := s.db.Query(`
		SELECT id, name, comment, kind, host, port, username, database, tls,
		       ssh_config_json, advanced_options_json, read_only, color, created_at, updated_at
		FROM connections ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []SavedConnection
	for rows.Next() {
		var c SavedConnection
		var tls, readOnly int
		var sshJSON, advJSON string
		if err := rows.Scan(
			&c.ID, &c.Name, &c.Comment, &c.Kind, &c.Host, &c.Port, &c.Username,
			&c.Database, &tls, &sshJSON, &advJSON, &readOnly, &c.Color, &c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		c.TLS = tls != 0
		c.ReadOnly = readOnly != 0
		_ = json.Unmarshal([]byte(sshJSON), &c.SSH)
		_ = json.Unmarshal([]byte(advJSON), &c.AdvancedParams)
		if c.AdvancedParams == nil {
			c.AdvancedParams = []AdvancedParam{}
		}
		results = append(results, c)
	}
	return results, rows.Err()
}

// Get returns a single connection with passwords decrypted (for the edit dialog).
func (s *ConnectionStore) Get(id string) (*SavedConnection, error) {
	var c SavedConnection
	var tls, readOnly int
	var pwEnc, sshPwEnc, sshJSON, advJSON string
	err := s.db.QueryRow(`
		SELECT id, name, comment, kind, host, port, username, encrypted_password, database, tls,
		       ssh_config_json, ssh_pw_enc, advanced_options_json, read_only, color, created_at, updated_at
		FROM connections WHERE id = ?`, id).Scan(
		&c.ID, &c.Name, &c.Comment, &c.Kind, &c.Host, &c.Port, &c.Username, &pwEnc,
		&c.Database, &tls, &sshJSON, &sshPwEnc, &advJSON, &readOnly, &c.Color, &c.CreatedAt, &c.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("store: connection %q not found", id)
	}
	if err != nil {
		return nil, err
	}
	c.TLS = tls != 0
	c.ReadOnly = readOnly != 0
	c.Password, _ = crypto.Decrypt(pwEnc)
	_ = json.Unmarshal([]byte(sshJSON), &c.SSH)
	c.SSH.Password, _ = crypto.Decrypt(sshPwEnc)
	_ = json.Unmarshal([]byte(advJSON), &c.AdvancedParams)
	if c.AdvancedParams == nil {
		c.AdvancedParams = []AdvancedParam{}
	}
	return &c, nil
}

// Delete removes a saved connection by ID.
func (s *ConnectionStore) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM connections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("store: connection %q not found", id)
	}
	return nil
}
