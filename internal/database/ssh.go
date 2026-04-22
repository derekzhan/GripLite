package database

// SSH tunnel support for the connection Manager.
//
// This file is a parallel implementation to internal/driver/mysql/ssh.go.
// Both files accomplish the same thing — routing MySQL TCP connections through
// an SSH jump host — but they operate on independent registries and use
// different network-name prefixes so they never collide:
//
//	internal/driver/mysql/ssh.go  →  "sshnet:<connID>"   (driver layer)
//	internal/database/ssh.go      →  "mgrssh_<connID>"   (manager layer)
//
// The Manager layer uses prefix "mgrssh_" (no special chars) to avoid any
// edge-cases in the MySQL DSN protocol-name parser.

import (
	"context"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	mysqldrv "github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"
)

// ─────────────────────────────────────────────────────────────────────────────
// Package-level SSH dialer registry
// ─────────────────────────────────────────────────────────────────────────────

// sshDialer wraps an *ssh.Client so it can be replaced on reconnect without
// re-registering the same network name with the MySQL driver.
type sshDialer struct {
	mu     sync.RWMutex
	client *ssh.Client
}

// dial returns a net.Conn routed through the SSH client.
func (d *sshDialer) dial(ctx context.Context, addr string) (net.Conn, error) {
	d.mu.RLock()
	c := d.client
	d.mu.RUnlock()
	if c == nil {
		return nil, fmt.Errorf("ssh tunnel is not active")
	}
	// Use DialContext when the ssh.Client supports it (Go ≥1.22 crypto/ssh).
	type contextDialer interface {
		DialContext(ctx context.Context, n, addr string) (net.Conn, error)
	}
	if cd, ok := any(c).(contextDialer); ok {
		return cd.DialContext(ctx, "tcp", addr)
	}
	return c.Dial("tcp", addr)
}

// set atomically swaps in a new *ssh.Client, closing the old one if present.
func (d *sshDialer) set(c *ssh.Client) {
	d.mu.Lock()
	if d.client != nil && d.client != c {
		_ = d.client.Close()
	}
	d.client = c
	d.mu.Unlock()
}

// close tears down the underlying SSH connection.
func (d *sshDialer) close() {
	d.mu.Lock()
	if d.client != nil {
		_ = d.client.Close()
		d.client = nil
	}
	d.mu.Unlock()
}

// registry: connID → dialer holder (write-once per connID, then update client)
var (
	registryMu sync.Mutex
	registry   = map[string]*sshDialer{} // netName → holder
)

// netName returns the MySQL protocol name for a given connection ID.
// Uses prefix "mgrssh_" to avoid collision with driver/mysql's "sshnet:" prefix.
func netName(connID string) string {
	return "mgrssh_" + connID
}

// ─────────────────────────────────────────────────────────────────────────────
// setupSSHTunnel
// ─────────────────────────────────────────────────────────────────────────────

// setupSSHTunnel establishes an SSH connection to the jump host described by
// cfg and wires it into the global MySQL dial registry under a unique network
// name derived from connID.
//
// Returns the network name to embed into the MySQL DSN, e.g.:
//
//	user:pass@mgrssh_abc123(db-host:3306)/mydb?parseTime=true
//
// If a tunnel already exists for connID the old SSH client is replaced with a
// fresh one (no panic from double-registration since the function holder is
// registered only once).
func setupSSHTunnel(connID string, cfg SSHConfig) (string, error) {
	auth, err := buildSSHAuth(cfg)
	if err != nil {
		return "", err
	}

	user := cfg.User
	if user == "" {
		user = "root"
	}
	port := cfg.Port
	if port == 0 {
		port = 22
	}

	sshCfg := &ssh.ClientConfig{
		User: user,
		Auth: auth,
		// InsecureIgnoreHostKey is acceptable for an internal dev tool.
		// A production release should verify known_hosts.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}

	sshAddr := fmt.Sprintf("%s:%d", cfg.Host, port)
	sshClient, err := ssh.Dial("tcp", sshAddr, sshCfg)
	if err != nil {
		return "", fmt.Errorf("ssh dial %s: %w", sshAddr, err)
	}

	name := netName(connID)

	registryMu.Lock()
	holder, exists := registry[name]
	if !exists {
		holder = &sshDialer{}
		registry[name] = holder
		// Register the dial function with go-sql-driver/mysql — ONCE per name.
		// Subsequent reconnects only update the SSH client pointer inside holder.
		localHolder := holder
		mysqldrv.RegisterDialContext(name, func(ctx context.Context, addr string) (net.Conn, error) {
			return localHolder.dial(ctx, addr)
		})
	}
	registryMu.Unlock()

	holder.set(sshClient)
	return name, nil
}

// closeSSHTunnel tears down the SSH client for connID (called by Manager.Disconnect).
func closeSSHTunnel(connID string) {
	name := netName(connID)
	registryMu.Lock()
	holder, ok := registry[name]
	registryMu.Unlock()
	if ok {
		holder.close()
	}
}

// buildSSHAuth constructs the SSH authentication methods from cfg.
func buildSSHAuth(cfg SSHConfig) ([]ssh.AuthMethod, error) {
	switch cfg.AuthType {
	case "keyPair":
		if cfg.PrivateKeyPath == "" {
			return nil, fmt.Errorf("ssh: privateKeyPath is required for keyPair auth")
		}
		pemBytes, err := os.ReadFile(cfg.PrivateKeyPath)
		if err != nil {
			return nil, fmt.Errorf("ssh: read private key %q: %w", cfg.PrivateKeyPath, err)
		}
		signer, err := ssh.ParsePrivateKey(pemBytes)
		if err != nil {
			return nil, fmt.Errorf("ssh: parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	default:
		// "password" or unset
		return []ssh.AuthMethod{ssh.Password(cfg.Password)}, nil
	}
}
