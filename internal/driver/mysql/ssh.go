package mysql

// SSH tunnel support for the MySQL driver.
//
// Architecture
// ────────────
// go-sql-driver/mysql allows callers to inject a custom network dialer via
// mysql.RegisterDialContext(netName, dialFunc).  We exploit this to route
// TCP connections through an SSH client:
//
//   1. Establish an *ssh.Client to the jump host.
//   2. Register a dialer under a unique netName (e.g. "sshnet:<connID>").
//   3. Build a DSN that uses that netName as the network protocol:
//        root:pw@sshnet:myconn(db-host:3306)/mydb?...
//      The go-sql-driver then calls our dialer for every new pool connection.
//
// Re-connection safety
// ─────────────────────
// mysql.RegisterDialContext panics on duplicate names, so each connID may only
// be registered once per process.  We achieve this with sshRegistry (a
// package-level map protected by sshMu).  The registered function holds a
// pointer to a mysqlSSHDialer struct; when the driver reconnects we simply
// swap the inner *ssh.Client rather than re-registering.

import (
	"context"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	mysqldrv "github.com/go-sql-driver/mysql"
	"golang.org/x/crypto/ssh"

	"GripLite/internal/driver"
)

// ─────────────────────────────────────────────────────────────────────────────
// mysqlSSHDialer – mutable pointer to the current SSH client
// ─────────────────────────────────────────────────────────────────────────────

type mysqlSSHDialer struct {
	mu     sync.RWMutex
	client *ssh.Client
}

func (d *mysqlSSHDialer) set(c *ssh.Client) {
	d.mu.Lock()
	if d.client != nil && d.client != c {
		_ = d.client.Close()
	}
	d.client = c
	d.mu.Unlock()
}

func (d *mysqlSSHDialer) close() {
	d.mu.Lock()
	if d.client != nil {
		_ = d.client.Close()
		d.client = nil
	}
	d.mu.Unlock()
}

func (d *mysqlSSHDialer) dial(ctx context.Context, addr string) (net.Conn, error) {
	d.mu.RLock()
	c := d.client
	d.mu.RUnlock()
	if c == nil {
		return nil, fmt.Errorf("ssh tunnel is not active")
	}
	// ssh.Client.DialContext is available in golang.org/x/crypto v0.13+.
	type contextDialer interface {
		DialContext(ctx context.Context, n, addr string) (net.Conn, error)
	}
	if cd, ok := any(c).(contextDialer); ok {
		return cd.DialContext(ctx, "tcp", addr)
	}
	return c.Dial("tcp", addr)
}

// ─────────────────────────────────────────────────────────────────────────────
// Package-level registry (write-once per connID, then update client pointer)
// ─────────────────────────────────────────────────────────────────────────────

var (
	sshMu       sync.Mutex
	sshRegistry = map[string]*mysqlSSHDialer{} // netName → dialer holder
)

// setupSSHTunnel dials the SSH jump host, registers (or updates) the custom
// MySQL dialer, and stores the netName in d.sshNetName.
func (d *mysqlDriver) setupSSHTunnel(ctx context.Context) error {
	tun := d.cfg.SSHTunnel
	if tun == nil || tun.Host == "" {
		return nil
	}

	port := tun.Port
	if port == 0 {
		port = 22
	}

	// ── Build SSH auth ──────────────────────────────────────────────────────
	var authMethods []ssh.AuthMethod
	switch tun.AuthType {
	case "keyPair":
		if tun.PrivateKeyPath == "" {
			return fmt.Errorf("ssh: privateKeyPath is required for keyPair auth")
		}
		pemData, err := os.ReadFile(tun.PrivateKeyPath)
		if err != nil {
			return fmt.Errorf("ssh: read private key %q: %w", tun.PrivateKeyPath, err)
		}
		signer, err := ssh.ParsePrivateKey(pemData)
		if err != nil {
			return fmt.Errorf("ssh: parse private key: %w", err)
		}
		authMethods = []ssh.AuthMethod{ssh.PublicKeys(signer)}
	default:
		authMethods = []ssh.AuthMethod{ssh.Password(tun.Password)}
	}

	user := tun.Username
	if user == "" {
		user = d.cfg.Username // fall back to the DB user
	}

	sshCfg := &ssh.ClientConfig{
		User: user,
		Auth: authMethods,
		// InsecureIgnoreHostKey is acceptable for an internal dev tool;
		// a production release should persist and verify the host key.
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         15 * time.Second,
	}

	sshAddr := fmt.Sprintf("%s:%d", tun.Host, port)
	sshClient, err := ssh.Dial("tcp", sshAddr, sshCfg)
	if err != nil {
		return fmt.Errorf("ssh: dial %s: %w", sshAddr, err)
	}

	// ── Register or update the dialer ───────────────────────────────────────
	netName := "sshnet:" + d.cfg.ID

	sshMu.Lock()
	holder, exists := sshRegistry[netName]
	if !exists {
		holder = &mysqlSSHDialer{}
		sshRegistry[netName] = holder
		// Register once — subsequent reconnects reuse the same holder.
		localHolder := holder
		mysqldrv.RegisterDialContext(netName, func(ctx context.Context, addr string) (net.Conn, error) {
			return localHolder.dial(ctx, addr)
		})
	}
	sshMu.Unlock()

	// Swap in the fresh SSH client (closes the previous one if any).
	holder.set(sshClient)

	d.sshNetName = netName
	d.sshHolder = holder
	return nil
}

// closeTunnel tears down the SSH connection (called from mysqlDriver.Close).
func (d *mysqlDriver) closeTunnel() {
	if d.sshHolder != nil {
		d.sshHolder.close()
		d.sshHolder = nil
	}
	d.sshNetName = ""
}

// toSSHTunnelConfig converts a store.SSHConfig → driver.SSHTunnelConfig.
// Kept here to avoid circular imports; called by app.go when building a live
// ConnectionConfig from a SavedConnection.
func ToDriverSSHTunnel(enabled bool, host string, port int, user, authType, password, keyPath string) *driver.SSHTunnelConfig {
	if !enabled || host == "" {
		return nil
	}
	return &driver.SSHTunnelConfig{
		Host:           host,
		Port:           port,
		Username:       user,
		AuthType:       authType,
		Password:       password,
		PrivateKeyPath: keyPath,
	}
}
