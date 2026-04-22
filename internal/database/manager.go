// Package database implements the runtime Connection Manager for GripLite.
//
// Responsibilities
// ────────────────
//  1. Accepts connection parameters from the frontend (via app.go IPC).
//  2. Optionally establishes an SSH tunnel through a jump host.
//  3. Opens and owns a *sql.DB connection pool for each live connection.
//  4. Provides safe concurrent access to pools via a RW-mutex-protected map.
//  5. Delegates password encryption/decryption to internal/crypto.
//
// Relationship to internal/driver
// ────────────────────────────────
// internal/driver/mysql implements a higher-level DatabaseDriver interface that
// wraps *sql.DB and adds schema-introspection methods (FetchDatabases,
// FetchTables, etc.).  The Manager in this package operates at the *sql.DB
// level to give direct, low-overhead access to the connection pool.
//
// app.go uses BOTH layers:
//   - database.Manager for pool lifecycle (Connect, Disconnect, CloseAll)
//   - driver.DatabaseDriver for schema operations (FetchDatabases, etc.)
//
// # Connection lifecycle
//
//	Connect(cfg)      → registers SSH tunnel (if any) → sql.Open → Ping
//	                    → stores *sql.DB in pools map
//	Disconnect(id)    → closes *sql.DB → tears down SSH client
//	CloseAll()        → Disconnect for every open connection (called on shutdown)
package database

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"GripLite/internal/crypto"
)

// ─────────────────────────────────────────────────────────────────────────────
// Connection configuration types
// ─────────────────────────────────────────────────────────────────────────────

// ConnectionConfig is the runtime descriptor of a data source.
//
// Passwords are in PLAINTEXT at runtime — callers must decrypt them from the
// store (via crypto.Decrypt) before populating this struct.
// This struct is also safe to send over the Wails IPC bridge; app.go receives
// it from the frontend when the user clicks "OK" in the connection dialog.
type ConnectionConfig struct {
	// ID is the stable UUID used as map key and in SSH net-name generation.
	ID string `json:"id"`

	// Name is the human-readable connection label.
	Name string `json:"name"`

	// Kind is the driver kind, currently always "mysql".
	Kind string `json:"kind"`

	// Host / Port / Username / Password are the database server credentials.
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"` // plaintext at runtime

	// Database is the default schema to select on connect.
	Database string `json:"database"`

	// TLS controls whether the MySQL driver requires an encrypted channel.
	TLS bool `json:"tls"`

	// SSH describes the optional jump-host tunnel.
	SSH SSHConfig `json:"ssh"`

	// Advanced are extra driver parameters appended to the DSN query string.
	Advanced []AdvancedParam `json:"advancedParams"`
}

// SSHConfig describes the optional SSH jump-host tunnel.
type SSHConfig struct {
	Enabled        bool   `json:"enabled"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	AuthType       string `json:"authType"`       // "password" | "keyPair"
	Password       string `json:"password"`       // plaintext at runtime
	PrivateKeyPath string `json:"privateKeyPath"` // path to PEM key file
}

// AdvancedParam is a single MySQL DSN query-string parameter.
type AdvancedParam struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager
// ─────────────────────────────────────────────────────────────────────────────

// Manager owns the map of live *sql.DB connection pools.
//
// All exported methods are safe for concurrent use by multiple goroutines.
type Manager struct {
	mu    sync.RWMutex
	pools map[string]*dbEntry // connID → entry
}

type dbEntry struct {
	db  *sql.DB
	cfg ConnectionConfig
}

// NewManager creates an empty Manager ready to accept connections.
func NewManager() *Manager {
	return &Manager{pools: make(map[string]*dbEntry)}
}

// ─────────────────────────────────────────────────────────────────────────────
// Connect
// ─────────────────────────────────────────────────────────────────────────────

// Connect opens a MySQL connection pool for cfg.
//
// If cfg.SSH.Enabled is true an SSH tunnel is established first and the MySQL
// driver is instructed to route all TCP connections through it via a custom
// dial-context registered with mysql.RegisterDialContext.
//
// An existing pool for the same ID is closed before the new one is opened,
// so Connect can be used for both initial connects and reconnects.
//
// Returns cfg.ID on success.
func (m *Manager) Connect(ctx context.Context, cfg ConnectionConfig) (string, error) {
	if cfg.ID == "" {
		return "", fmt.Errorf("database: connection ID must not be empty")
	}
	if cfg.Port == 0 {
		cfg.Port = 3306
	}
	if cfg.Kind == "" {
		cfg.Kind = "mysql"
	}

	// Close any existing pool for this ID (reconnect scenario).
	m.mu.Lock()
	if old, ok := m.pools[cfg.ID]; ok {
		_ = old.db.Close()
		delete(m.pools, cfg.ID)
	}
	m.mu.Unlock()

	// Resolve the MySQL network protocol name (may be an SSH dialer).
	proto := "tcp"
	if cfg.SSH.Enabled && cfg.SSH.Host != "" {
		name, err := setupSSHTunnel(cfg.ID, cfg.SSH)
		if err != nil {
			return "", fmt.Errorf("database: %w", err)
		}
		proto = name
	}

	// Build DSN and open the pool.
	dsn := buildDSN(cfg, proto)
	db, err := openPool(dsn)
	if err != nil {
		closeSSHTunnel(cfg.ID) // clean up tunnel on failure
		return "", fmt.Errorf("database: open pool: %w", err)
	}

	// Verify the server is reachable.
	pingCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		closeSSHTunnel(cfg.ID)
		return "", fmt.Errorf("database: ping %s:%d: %w", cfg.Host, cfg.Port, err)
	}

	m.mu.Lock()
	m.pools[cfg.ID] = &dbEntry{db: db, cfg: cfg}
	m.mu.Unlock()

	return cfg.ID, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool accessors
// ─────────────────────────────────────────────────────────────────────────────

// DB returns the live *sql.DB for connID.
// Returns (nil, false) when no pool is registered for that ID.
func (m *Manager) DB(connID string) (*sql.DB, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.pools[connID]
	if !ok {
		return nil, false
	}
	return e.db, true
}

// Config returns the ConnectionConfig used to open the pool for connID.
func (m *Manager) Config(connID string) (ConnectionConfig, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.pools[connID]
	if !ok {
		return ConnectionConfig{}, false
	}
	return e.cfg, true
}

// Ping verifies that the connection for connID is still alive.
func (m *Manager) Ping(ctx context.Context, connID string) error {
	db, ok := m.DB(connID)
	if !ok {
		return fmt.Errorf("database: connection %q not found", connID)
	}
	return db.PingContext(ctx)
}

// ServerVersion queries the server version string for connID.
func (m *Manager) ServerVersion(ctx context.Context, connID string) (string, error) {
	db, ok := m.DB(connID)
	if !ok {
		return "", fmt.Errorf("database: connection %q not found", connID)
	}
	var ver string
	if err := db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&ver); err != nil {
		return "", err
	}
	return ver, nil
}

// IDs returns the list of all open connection IDs.
func (m *Manager) IDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.pools))
	for id := range m.pools {
		ids = append(ids, id)
	}
	return ids
}

// ─────────────────────────────────────────────────────────────────────────────
// Disconnect / CloseAll
// ─────────────────────────────────────────────────────────────────────────────

// Disconnect closes the pool for connID and tears down any SSH tunnel.
// Returns an error if the ID is not found.
func (m *Manager) Disconnect(connID string) error {
	m.mu.Lock()
	entry, ok := m.pools[connID]
	if ok {
		delete(m.pools, connID)
	}
	m.mu.Unlock()

	if !ok {
		return fmt.Errorf("database: connection %q not found", connID)
	}

	closeSSHTunnel(connID)
	return entry.db.Close()
}

// CloseAll closes every open pool and its SSH tunnel.
// Safe to call from shutdown hooks; ignores per-connection close errors.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	entries := make(map[string]*dbEntry, len(m.pools))
	for id, e := range m.pools {
		entries[id] = e
	}
	m.pools = make(map[string]*dbEntry)
	m.mu.Unlock()

	for id, e := range entries {
		closeSSHTunnel(id)
		_ = e.db.Close()
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (thin wrappers — callers may also call crypto.Encrypt directly)
// ─────────────────────────────────────────────────────────────────────────────

// EncryptPassword encrypts a plaintext password for storage.
// Delegates to internal/crypto.Encrypt.
func EncryptPassword(plaintext string) (string, error) {
	return crypto.Encrypt(plaintext)
}

// DecryptPassword decrypts a ciphertext produced by EncryptPassword.
// Delegates to internal/crypto.Decrypt.
func DecryptPassword(ciphertext string) (string, error) {
	return crypto.Decrypt(ciphertext)
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

// buildDSN constructs the MySQL DSN string.
//
// proto is either "tcp" (direct) or the SSH dialer's network name
// (e.g. "mgrssh_<connID>").
func buildDSN(cfg ConnectionConfig, proto string) string {
	p := url.Values{}
	p.Set("parseTime", "true")
	p.Set("charset", "utf8mb4")
	p.Set("timeout", "10s")
	p.Set("readTimeout", "30s")
	p.Set("writeTimeout", "30s")
	if cfg.TLS {
		p.Set("tls", "true")
	}
	for _, adv := range cfg.Advanced {
		if adv.Enabled && adv.Key != "" {
			p.Set(adv.Key, adv.Value)
		}
	}

	return fmt.Sprintf("%s:%s@%s(%s:%d)/%s?%s",
		cfg.Username,
		cfg.Password,
		proto,
		cfg.Host,
		cfg.Port,
		cfg.Database,
		strings.ReplaceAll(p.Encode(), "+", "%20"),
	)
}

// openPool opens a *sql.DB with production-grade pool settings.
func openPool(dsn string) (*sql.DB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
	return db, nil
}
