package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"GripLite/internal/cache"
	"GripLite/internal/database"
	"GripLite/internal/db"
	"GripLite/internal/driver"
	mysqlpkg "GripLite/internal/driver/mysql" // registers MySQL driver + SSH helpers
	"GripLite/internal/store"
)

// ─────────────────────────────────────────────────────────────────────────────
// IPC-serializable types
// (Wails marshals these to JSON over the IPC bridge; keep them flat.)
// ─────────────────────────────────────────────────────────────────────────────

// ColumnMeta is the frontend-facing column descriptor.
type ColumnMeta struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}

// QueryResult is the IPC return value of RunQuery.
// It is fully materialised (max maxQueryRows rows) so it can cross the
// Wails JSON bridge without streaming.
type QueryResult struct {
	// Columns describes each column in order.
	Columns []ColumnMeta `json:"columns"`

	// Rows holds the cell values. Each inner slice has the same length as Columns.
	// Cell types: string | float64 | int64 | bool | nil (JSON null).
	Rows [][]any `json:"rows"`

	// RowCount is the number of rows materialised (≤ maxQueryRows).
	RowCount int `json:"rowCount"`

	// Truncated is true when the server returned more rows than maxQueryRows.
	Truncated bool `json:"truncated"`

	// RowsAffected is non-zero for DML (INSERT / UPDATE / DELETE).
	RowsAffected int64 `json:"rowsAffected"`

	// ExecMs is the server-side execution time in milliseconds.
	ExecMs int64 `json:"execMs"`

	// Error is non-empty when the query failed.
	Error string `json:"error,omitempty"`
}

// ConnectionInfo is returned by ListConnections for the UI's connection picker.
type ConnectionInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	Database      string `json:"database"`
	ServerVersion string `json:"serverVersion"`
	Connected     bool   `json:"connected"`
	Color         string `json:"color"`
	ReadOnly      bool   `json:"readOnly"`
}

// maxQueryRows is the safety cap on rows read into memory per query.
// Large result sets should be paginated at the SQL level (LIMIT / OFFSET).
const maxQueryRows = 1000

// ─────────────────────────────────────────────────────────────────────────────
// App — the Wails application struct, bound to the frontend
// ─────────────────────────────────────────────────────────────────────────────

// App is the single Wails-bound struct. All exported methods on App become
// callable from the React frontend via window.go.main.App.<Method>().
type App struct {
	ctx context.Context

	mu          sync.RWMutex
	connections map[string]driver.DatabaseDriver // keyed by ConnectionConfig.ID
	configs     map[string]driver.ConnectionConfig

	// sharedDB is the unified griplite.db connection shared by store and meta.
	// It is opened by InitLocalDB and closed in shutdown.
	sharedDB *sql.DB

	// dbPath is the absolute path of griplite.db.  Populated by InitLocalDB
	// and exposed to the frontend via GetDBPath() so the UI can show users
	// exactly where their config / metadata are persisted.
	dbPath string

	// meta is the local SQLite schema cache powering autocomplete.
	meta *cache.MetadataCache

	// store persists saved connection configurations to disk.
	store *store.ConnectionStore

	// dbMgr is the runtime connection pool manager (Phase 9).
	// It owns the map[connID]*sql.DB and handles SSH tunnel setup.
	dbMgr *database.Manager

	// queryMu protects queryCancels.
	queryMu      sync.Mutex
	queryCancels map[string]context.CancelFunc
}

// NewApp creates the App instance. Called once at startup.
func NewApp() *App {
	return &App{
		connections:  make(map[string]driver.DatabaseDriver),
		configs:      make(map[string]driver.ConnectionConfig),
		dbMgr:        database.NewManager(),
		queryCancels: make(map[string]context.CancelFunc),
	}
}

// startup is called by Wails after the window is created.
// The context is used to cancel any in-flight queries when the app closes.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	if err := a.InitLocalDB(); err != nil {
		log.Printf("[app] InitLocalDB failed: %v", err)
	}
}

// shutdown is called by Wails just before the window is destroyed.
// It gracefully closes all open database connections and the metadata cache.
func (a *App) shutdown(ctx context.Context) {
	a.mu.Lock()
	for id, drv := range a.connections {
		_ = drv.Close(ctx)
		delete(a.connections, id)
	}
	a.mu.Unlock()

	// Close the pool manager (closes all live DB connections + SSH tunnels).
	if a.dbMgr != nil {
		a.dbMgr.CloseAll()
	}
	// Close meta and store (they do NOT own the shared DB).
	if a.meta != nil {
		_ = a.meta.Close()
	}
	if a.store != nil {
		_ = a.store.Close()
	}
	// Close the shared SQLite DB last.
	if a.sharedDB != nil {
		_ = a.sharedDB.Close()
		a.sharedDB = nil
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Local database initialisation
// ─────────────────────────────────────────────────────────────────────────────

// DBStatus is returned by InitLocalDB to let the frontend display the DB path
// and whether this is the first launch.
type DBStatus struct {
	// Path is the absolute path of griplite.db.
	Path string `json:"path"`
	// IsNew is true when the database file was created during this call.
	IsNew bool `json:"isNew"`
	// Error is non-empty when initialisation failed.
	Error string `json:"error,omitempty"`
}

// InitLocalDB opens (or creates) the unified griplite.db file, applies the
// full schema, and wires the connection store and metadata cache to the shared
// *sql.DB.
//
// It is called automatically from startup and may also be called from the
// frontend (e.g. a "Reset database" button) to reinitialise after a schema
// migration.
//
// Frontend usage:
//
//	const status = await InitLocalDB()
//	console.log("DB at", status.path, status.isNew ? "(new)" : "(existing)")
func (a *App) InitLocalDB() error {
	// If a previous shared DB exists, close it cleanly before re-opening.
	if a.sharedDB != nil {
		if a.meta != nil {
			_ = a.meta.Close()
			a.meta = nil
		}
		if a.store != nil {
			_ = a.store.Close()
			a.store = nil
		}
		_ = a.sharedDB.Close()
		a.sharedDB = nil
	}

	sharedDB, info, err := db.Open("") // "" → OS-default config dir
	if err != nil {
		return fmt.Errorf("InitLocalDB: open griplite.db: %w", err)
	}
	a.sharedDB = sharedDB
	a.dbPath = info.Path

	// Extra-loud startup log so users can copy-paste the absolute path from
	// the Wails dev console.  This is the single source of truth for where
	// connection configs + schema cache live on disk.
	log.Printf("[griplite] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	log.Printf("[griplite] local database ready")
	log.Printf("[griplite]   path : %s", info.Path)
	log.Printf("[griplite]   new  : %v", info.IsNew)
	log.Printf("[griplite] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	// Wire the cache engine to the shared DB.
	meta, err := cache.NewFromDB(sharedDB)
	if err != nil {
		log.Printf("[app] metadata cache init failed: %v (autocomplete disabled)", err)
	} else {
		a.meta = meta
	}

	// Wire the connection store to the shared DB.
	a.store = store.NewFromDB(sharedDB)

	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection management
// ─────────────────────────────────────────────────────────────────────────────

// AddConnection registers and opens a new database connection.
// Returns the connection ID on success.
//
// Frontend usage:
//
//	const id = await AddConnection({ id:"c1", kind:"mysql", host:"127.0.0.1", ... })
func (a *App) AddConnection(cfg driver.ConnectionConfig) (string, error) {
	if cfg.ID == "" {
		return "", fmt.Errorf("connection ID must not be empty")
	}

	drv, err := driver.New(cfg)
	if err != nil {
		return "", fmt.Errorf("create driver: %w", err)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()

	if err := drv.Connect(ctx); err != nil {
		return "", fmt.Errorf("connect: %w", err)
	}

	a.mu.Lock()
	a.connections[cfg.ID] = drv
	a.configs[cfg.ID] = cfg
	a.mu.Unlock()

	// Also register in the pool Manager so the *sql.DB is directly accessible.
	if a.dbMgr != nil {
		mgrcfg := driverCfgToManagerCfg(cfg)
		if _, e := a.dbMgr.Connect(ctx, mgrcfg); e != nil {
			log.Printf("[app] dbMgr.Connect %q: %v (non-fatal, driver layer still active)", cfg.ID, e)
		}
	}

	// Kick off a background schema sync so autocomplete is ready shortly after
	// the connection is established.
	if a.meta != nil {
		a.meta.SyncSchema(a.ctx, cfg.ID, drv)
	}

	return cfg.ID, nil
}

// driverCfgToManagerCfg converts a driver.ConnectionConfig to a
// database.ConnectionConfig for registration in the pool Manager.
func driverCfgToManagerCfg(cfg driver.ConnectionConfig) database.ConnectionConfig {
	mc := database.ConnectionConfig{
		ID:       cfg.ID,
		Name:     cfg.Name,
		Kind:     string(cfg.Kind),
		Host:     cfg.Host,
		Port:     cfg.Port,
		Username: cfg.Username,
		Password: cfg.Password,
		Database: cfg.Database,
		TLS:      cfg.TLS,
	}
	if t := cfg.SSHTunnel; t != nil {
		mc.SSH = database.SSHConfig{
			Enabled:        t.Host != "",
			Host:           t.Host,
			Port:           t.Port,
			User:           t.Username,
			AuthType:       t.AuthType,
			Password:       t.Password,
			PrivateKeyPath: t.PrivateKeyPath,
		}
	}
	for _, p := range cfg.AdvancedParams {
		mc.Advanced = append(mc.Advanced, database.AdvancedParam{
			Key: p.Key, Value: p.Value, Enabled: p.Enabled,
		})
	}
	return mc
}

// RemoveConnection closes and removes a connection.
func (a *App) RemoveConnection(connectionID string) error {
	a.mu.Lock()
	drv, ok := a.connections[connectionID]
	if ok {
		delete(a.connections, connectionID)
		delete(a.configs, connectionID)
	}
	a.mu.Unlock()

	if !ok {
		return fmt.Errorf("connection %q not found", connectionID)
	}

	// Remove from pool Manager (ignore not-found; it may not have been registered).
	if a.dbMgr != nil {
		_ = a.dbMgr.Disconnect(connectionID)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Second)
	defer cancel()
	return drv.Close(ctx)
}

// ListConnections returns metadata for every connection the user can see in
// the Database Explorer tree.
//
// Phase 16 — persistence fix.  Before this change the method only returned
// connections currently live in the in-memory map, so restarting the app
// would "lose" all saved data sources until the user manually re-connected.
// The implementation now *merges* two sources:
//
//  1. Every SavedConnection persisted in griplite.db (disk-truth).  These are
//     reported with Connected=false until the user actually opens them.
//  2. Every live driver currently in a.connections.  If a saved row is also
//     live we overlay its Connected=true + serverVersion so the UI reflects
//     reality.
//
// The result is that the Explorer tree is populated on cold startup without
// requiring the user to do anything — exactly the behaviour any DataGrip /
// DBeaver user expects.
func (a *App) ListConnections() []ConnectionInfo {
	// order tracks insertion order so the UI list is stable across refreshes.
	// Go maps iterate in a non-deterministic order, so we must NOT rely on
	// ranging over byID to build the result slice.
	var order []string
	byID := make(map[string]ConnectionInfo, 8)

	// 1. Start from persisted connections (disk-truth), preserving their order.
	if a.store != nil {
		if saved, err := a.store.List(); err == nil {
			for _, sc := range saved {
				order = append(order, sc.ID)
				byID[sc.ID] = ConnectionInfo{
					ID:        sc.ID,
					Name:      sc.Name,
					Kind:      sc.Kind,
					Host:      sc.Host,
					Port:      sc.Port,
					Database:  sc.Database,
					Color:     sc.Color,
					ReadOnly:  sc.ReadOnly,
					Connected: false, // not open until the user opens it
				}
			}
		} else {
			log.Printf("[app] ListConnections: store.List failed: %v", err)
		}
	}

	// 2. Overlay with any live drivers (serverVersion + Connected flag).
	// Unsaved live connections (edge case) are appended after saved ones.
	a.mu.RLock()
	for id, drv := range a.connections {
		cfg := a.configs[id]
		info := byID[id] // zero value when not saved
		if _, known := byID[id]; !known {
			order = append(order, id)
		}
		info.ID = id
		if info.Name == "" {
			info.Name = cfg.Name
		}
		if info.Kind == "" {
			info.Kind = string(cfg.Kind)
		}
		if info.Host == "" {
			info.Host = cfg.Host
		}
		if info.Port == 0 {
			info.Port = cfg.Port
		}
		if info.Database == "" {
			info.Database = cfg.Database
		}
		info.ServerVersion = drv.ServerVersion()
		info.Connected = drv.Ping(a.ctx) == nil
		byID[id] = info
	}
	a.mu.RUnlock()

	result := make([]ConnectionInfo, 0, len(order))
	for _, id := range order {
		if info, ok := byID[id]; ok {
			result = append(result, info)
		}
	}
	return result
}

// GetDBPath returns the absolute path of griplite.db.  Exposed so the
// frontend (e.g. About dialog / status bar) can show users where their
// local database lives.  Returns an empty string before InitLocalDB has run.
//
// Frontend usage:
//
//	const path = await GetDBPath()
//	// "/Users/zhanwei/Library/Application Support/GripLite/griplite.db"
func (a *App) GetDBPath() string {
	return a.dbPath
}

// GetDataFilterHistory returns persisted Data-tab WHERE-clause history for
// a table, newest first (same order as the in-app dropdown), max 20 items.
// Empty when none has been stored yet. Used after restart so DBeaver-style
// filter memory survives sessions.
func (a *App) GetDataFilterHistory(connectionID, dbName, tableName string) ([]string, error) {
	if a.sharedDB == nil {
		return nil, fmt.Errorf("local database not initialised")
	}
	var raw string
	err := a.sharedDB.QueryRow(
		`SELECT entries_json FROM data_filter_history
		 WHERE conn_id = ? AND db_name = ? AND table_name = ?`,
		connectionID, dbName, tableName,
	).Scan(&raw)
	if err == sql.ErrNoRows {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, err
	}
	if out == nil {
		return []string{}, nil
	}
	return out, nil
}

// SetDataFilterHistory replaces the persisted history for a table. Pass an
// empty slice after "Clear history" in the UI. Capped to 20 entries.
func (a *App) SetDataFilterHistory(connectionID, dbName, tableName string, entries []string) error {
	if a.sharedDB == nil {
		return fmt.Errorf("local database not initialised")
	}
	if len(entries) > 20 {
		entries = entries[:20]
	}
	b, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	_, err = a.sharedDB.Exec(
		`INSERT INTO data_filter_history (conn_id, db_name, table_name, entries_json, updated_at)
		 VALUES (?, ?, ?, ?, datetime('now'))
		 ON CONFLICT(conn_id, db_name, table_name) DO UPDATE SET
		   entries_json = excluded.entries_json,
		   updated_at   = excluded.updated_at`,
		connectionID, dbName, tableName, string(b),
	)
	return err
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy reconnect (Phase 16)
// ─────────────────────────────────────────────────────────────────────────────

// ensureLive makes sure that connectionID has an active driver in memory.
//
// If the driver is already open it is returned immediately.  Otherwise the
// method looks up the SavedConnection in griplite.db, opens it fresh, and
// registers it just like AddConnection would.
//
// This is what lets the Explorer tree work on cold startup: the frontend
// shows saved connections even before the user clicks "Connect", and the
// first query / FetchTables call transparently establishes the socket.
//
// Returns an error only if the connection is unknown (not saved AND not live)
// or if the re-connect attempt itself fails.
func (a *App) ensureLive(connectionID string) (driver.DatabaseDriver, error) {
	// Fast path — already open.
	a.mu.RLock()
	drv, ok := a.connections[connectionID]
	a.mu.RUnlock()
	if ok {
		return drv, nil
	}

	// Not in memory — try to reopen from disk-truth.
	if a.store == nil {
		return nil, fmt.Errorf("connection %q not found", connectionID)
	}
	sc, err := a.store.Get(connectionID)
	if err != nil {
		return nil, fmt.Errorf("connection %q not found", connectionID)
	}
	if sc == nil {
		return nil, fmt.Errorf("connection %q not found", connectionID)
	}

	cfg := savedConnToDriverCfg(*sc)
	if _, err := a.AddConnection(cfg); err != nil {
		return nil, fmt.Errorf("reopen %q: %w", connectionID, err)
	}

	a.mu.RLock()
	drv = a.connections[connectionID]
	a.mu.RUnlock()
	if drv == nil {
		return nil, fmt.Errorf("reopen %q: driver not registered after AddConnection", connectionID)
	}
	log.Printf("[app] lazily reopened saved connection %q", connectionID)
	return drv, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Query execution
// ─────────────────────────────────────────────────────────────────────────────

// RunQuery executes a SQL statement on the named connection and returns up to
// maxQueryRows rows as a fully-materialised [QueryResult].
//
// Error handling strategy: query-level errors (bad SQL, lost connection) are
// returned in QueryResult.Error rather than as a Go error so that the React
// frontend can display them inline without an uncaught-Promise crash.
// Fatal/programming errors (unknown connection ID) are returned as Go errors.
//
// Frontend usage:
//
//	const result = await RunQuery("c1", "SELECT * FROM users LIMIT 50")
//	if (result.error) { showError(result.error) }
//	else { displayGrid(result.columns, result.rows) }
func (a *App) RunQuery(connectionID, dbName, sql string) (*QueryResult, error) {
	// Phase 16: transparently reopen a saved connection if it was not yet
	// re-established after an app restart.
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}

	// Enforce read-only mode: block DML/DDL statements.
	a.mu.RLock()
	cfg, hasCfg := a.configs[connectionID]
	a.mu.RUnlock()
	if hasCfg && cfg.ReadOnly {
		upper := strings.ToUpper(strings.TrimSpace(sql))
		isDML := strings.HasPrefix(upper, "INSERT") || strings.HasPrefix(upper, "UPDATE") ||
			strings.HasPrefix(upper, "DELETE") || strings.HasPrefix(upper, "DROP") ||
			strings.HasPrefix(upper, "CREATE") || strings.HasPrefix(upper, "ALTER") ||
			strings.HasPrefix(upper, "TRUNCATE") || strings.HasPrefix(upper, "RENAME")
		if isDML {
			return &QueryResult{Error: "connection is in read-only mode; write operations are blocked"}, nil
		}
	}

	// Set up a cancellable context so CancelQuery can abort in-flight queries.
	baseCtx, baseCancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer baseCancel()
	cancelCtx, cancelFn := context.WithCancel(baseCtx)
	defer cancelFn()
	a.queryMu.Lock()
	a.queryCancels[connectionID] = cancelFn
	a.queryMu.Unlock()
	defer func() {
		a.queryMu.Lock()
		delete(a.queryCancels, connectionID)
		a.queryMu.Unlock()
	}()
	ctx := cancelCtx

	// ExecuteQueryOnDB runs USE `dbName` first on the same dedicated connection,
	// ensuring the database context is correct even with a connection pool.
	rs, err := drv.ExecuteQueryOnDB(ctx, dbName, sql)
	if err != nil {
		// Return the error in-band so the React component can display it.
		return &QueryResult{Error: err.Error()}, nil
	}
	defer rs.Rows.Close()

	// Materialise columns.
	cols := make([]ColumnMeta, len(rs.Columns))
	for i, c := range rs.Columns {
		cols[i] = ColumnMeta{Name: c.Name, Type: c.DatabaseType, Nullable: c.Nullable}
	}

	// Materialise rows — hard cap at maxQueryRows to protect heap.
	var (
		rows      [][]any
		truncated bool
	)
	for rs.Rows.Next() {
		if len(rows) >= maxQueryRows {
			truncated = true
			break
		}
		row := rs.Rows.Row()
		if row == nil {
			if err := rs.Rows.Err(); err != nil {
				return &QueryResult{
					Columns: cols,
					Rows:    rows,
					Error:   fmt.Sprintf("read row: %v", err),
					ExecMs:  rs.ExecutionTime.Milliseconds(),
				}, nil
			}
			break
		}
		rows = append(rows, row)
	}

	if err := rs.Rows.Err(); err != nil {
		return &QueryResult{
			Columns: cols,
			Rows:    rows,
			Error:   fmt.Sprintf("row iteration: %v", err),
			ExecMs:  rs.ExecutionTime.Milliseconds(),
		}, nil
	}

	// Persist to local history (best-effort, runs in background goroutine).
	if a.sharedDB != nil {
		execMs := rs.ExecutionTime.Milliseconds()
		go func() {
			ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel2()
			_, _ = a.sharedDB.ExecContext(ctx2,
				`INSERT INTO query_history (conn_id, db_name, sql_text, exec_ms, error_msg)
				 VALUES (?, ?, ?, ?, ?)`,
				connectionID, dbName, sql, execMs, "")
		}()
	}

	return &QueryResult{
		Columns:      cols,
		Rows:         rows,
		RowCount:     len(rows),
		Truncated:    truncated,
		RowsAffected: rs.RowsAffected,
		ExecMs:       rs.ExecutionTime.Milliseconds(),
	}, nil
}

// FetchDatabases returns all database names visible to the given connection.
func (a *App) FetchDatabases(connectionID string) ([]string, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	return drv.FetchDatabases(ctx)
}

// FetchTables returns table metadata for a database.
func (a *App) FetchTables(connectionID, dbName string) ([]driver.TableInfo, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return drv.FetchTables(ctx, dbName)
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata cache — autocomplete IPC methods
// ─────────────────────────────────────────────────────────────────────────────

// SearchCompletions returns Monaco autocomplete candidates for the given keyword.
// It queries the local SQLite cache (sub-millisecond) without hitting the DB server.
// dbName restricts results to a single schema; pass "" to search all schemas.
//
// Frontend usage:
//
//	const items = await SearchCompletions("c1", "im_platform", "use")
//	// → [{ kind:"table", label:"users", detail:"im_platform" }, ...]
func (a *App) SearchCompletions(connectionID, dbName, keyword string) ([]cache.CompletionItem, error) {
	if a.meta == nil {
		return nil, nil // cache not initialised (startup error)
	}
	ctx, cancel := context.WithTimeout(a.ctx, 200*time.Millisecond)
	defer cancel()
	return a.meta.SearchColumns(ctx, connectionID, dbName, keyword)
}

// TriggerSync manually re-triggers a background schema sync for a connection.
// Useful when the user clicks "Refresh" in the Database Explorer.
func (a *App) TriggerSync(connectionID string) error {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return err
	}
	if a.meta == nil {
		return fmt.Errorf("metadata cache not available")
	}
	a.meta.SyncSchema(a.ctx, connectionID, drv)
	return nil
}

// GetSyncState returns the current sync status for a connection.
// The frontend can poll this to show a progress indicator.
func (a *App) GetSyncState(connectionID string) cache.SyncStatus {
	if a.meta == nil {
		return cache.SyncStatus{ConnID: connectionID, State: "idle"}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 100*time.Millisecond)
	defer cancel()
	return a.meta.SyncState(ctx, connectionID)
}

// GetTableSchema returns cached column metadata for a single table.
//
// The data is read from the local SQLite mirror created by SyncSchema — no
// round-trip to the live database is needed.  Typical latency is < 1 ms.
//
// Use this in the TableViewer Properties panel instead of issuing
// "SHOW TABLE STATUS" or "DESCRIBE <table>" against the live server.
//
// When CachedTableSchema.Found is false the cache has not been populated for
// this table yet; the caller should trigger TriggerSync or fall back to a live
// query in that edge case.
//
// Frontend usage:
//
//	const schema = await GetTableSchema("c1", "mydb", "users")
//	if (schema.found) { renderPropertiesPanel(schema.columns) }
func (a *App) GetTableSchema(connectionID, dbName, tableName string) (*cache.CachedTableSchema, error) {
	if a.meta == nil {
		// Cache not initialised — return an unfound schema rather than an error
		// so the frontend degrades gracefully.
		return &cache.CachedTableSchema{
			Found:     false,
			ConnID:    connectionID,
			DBName:    dbName,
			TableName: tableName,
		}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 500*time.Millisecond)
	defer cancel()
	return a.meta.GetTableSchema(ctx, connectionID, dbName, tableName)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 19: Advanced table properties (DDL / Indexes / FKs / References / Triggers)
//
// Unlike GetTableSchema, which reads from the SQLite metadata mirror, this
// method goes straight to the live MySQL server.  The payload is too rich
// (and too server-version-specific) to cache sensibly, and the Properties
// panel only opens it on demand — so a round-trip per tab is acceptable.
//
// The 10-second timeout is generous to survive the occasional slow
// information_schema lookup on large instances without looking hung.
// ─────────────────────────────────────────────────────────────────────────────

// GetTableAdvancedProperties returns DDL + index / constraint / FK / reference
// / trigger metadata for a single table, fetched live from the database.
//
// Errors:
//   - "connection … not found" — the id is unknown (check ListConnections).
//   - driver.ErrUnsupported    — the underlying driver is not a MySQL driver
//     and does not implement [driver.AdvancedSchemaDriver].
//   - propagated server error  — e.g. ErrTableNotFound, context deadline.
func (a *App) GetTableAdvancedProperties(connectionID, dbName, tableName string) (*driver.AdvancedTableProperties, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}

	adv, ok := drv.(driver.AdvancedSchemaDriver)
	if !ok {
		return nil, fmt.Errorf("GetTableAdvancedProperties: %w", driver.ErrUnsupported)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	return adv.FetchAdvancedTableProperties(ctx, dbName, tableName)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 20: Schema Designer — ALTER TABLE preview & execute
//
// Two-phase flow so the UI can show a "Review SQL" dialog before the
// server touches the database:
//
//   1. PreviewTableAlter — pure function, returns the generated statements.
//   2. ExecuteTableAlter — re-runs the diff server-side and applies it.
//
// The re-compute inside ExecuteTableAlter is intentional: it means a
// tampered frontend cannot smuggle arbitrary DDL past the server — only
// statements that the diff engine itself emits are ever executed.
// ─────────────────────────────────────────────────────────────────────────────

// PreviewTableAlter returns the list of ALTER TABLE statements needed to
// turn req.OldColumns / req.Original into req.NewColumns / req.Updated.
// Does not touch the live database.
//
// Returns driver.ErrUnsupported when the underlying driver is not a MySQL
// driver (MongoDB et al. do not support relational ALTER).
func (a *App) PreviewTableAlter(connectionID string, req driver.SchemaChangeRequest) (*driver.SchemaChangePreview, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.SchemaAlterDriver)
	if !ok {
		return nil, fmt.Errorf("PreviewTableAlter: %w", driver.ErrUnsupported)
	}
	return alt.PreviewAlter(req)
}

// ExecuteTableAlter re-runs the diff and applies each statement in order.
// MySQL DDL is auto-commit, so partial failures leave partial changes in
// place — the [driver.SchemaChangeResult] surfaces that.
//
// On success (full or partial) the SQLite metadata cache for this single
// table is refreshed immediately so the Properties panel reflects the
// new column list the moment the modal closes.  We deliberately refresh
// on partial-failure too — every applied statement is now the server's
// truth, and showing stale column counts in the UI would be worse than
// showing whatever survived.
func (a *App) ExecuteTableAlter(connectionID string, req driver.SchemaChangeRequest) (*driver.SchemaChangeResult, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.SchemaAlterDriver)
	if !ok {
		return nil, fmt.Errorf("ExecuteTableAlter: %w", driver.ErrUnsupported)
	}

	// Outer budget generous enough to cover several per-statement bounds.
	// ExecuteAlter applies its own 30s per statement.
	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Minute)
	defer cancel()

	result, execErr := alt.ExecuteAlter(ctx, req)

	// Refresh cache iff any statement actually ran.  A pre-flight error
	// (execErr != nil with zero executed) leaves the server untouched,
	// so the cache is still accurate and no refresh is needed.
	if result != nil && result.ExecutedCount > 0 && a.meta != nil {
		refreshCtx, refreshCancel := context.WithTimeout(a.ctx, 10*time.Second)
		defer refreshCancel()
		if rErr := a.meta.RefreshTable(refreshCtx, connectionID, req.Schema, req.Table, drv); rErr != nil {
			log.Printf("[app] ExecuteTableAlter: cache refresh failed for %s.%s: %v",
				req.Schema, req.Table, rErr)
		}
	}
	return result, execErr
}

// ─────────────────────────────────────────────────────────────────────────────
// Index Designer — CREATE / DROP / recreate indexes
// ─────────────────────────────────────────────────────────────────────────────

func (a *App) PreviewIndexAlter(connectionID string, req driver.IndexChangeRequest) (*driver.SchemaChangePreview, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.IndexAlterDriver)
	if !ok {
		return nil, fmt.Errorf("PreviewIndexAlter: %w", driver.ErrUnsupported)
	}
	return alt.PreviewIndexAlter(req)
}

func (a *App) ExecuteIndexAlter(connectionID string, req driver.IndexChangeRequest) (*driver.SchemaChangeResult, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.IndexAlterDriver)
	if !ok {
		return nil, fmt.Errorf("ExecuteIndexAlter: %w", driver.ErrUnsupported)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Minute)
	defer cancel()

	result, execErr := alt.ExecuteIndexAlter(ctx, req)
	if result != nil && result.ExecutedCount > 0 && a.meta != nil {
		refreshCtx, refreshCancel := context.WithTimeout(a.ctx, 10*time.Second)
		defer refreshCancel()
		if rErr := a.meta.RefreshTable(refreshCtx, connectionID, req.Schema, req.Table, drv); rErr != nil {
			log.Printf("[app] ExecuteIndexAlter: cache refresh failed for %s.%s: %v",
				req.Schema, req.Table, rErr)
		}
	}
	return result, execErr
}

// ─────────────────────────────────────────────────────────────────────────────
// Constraint / Partition Designers
// ─────────────────────────────────────────────────────────────────────────────

func (a *App) PreviewConstraintAlter(connectionID string, req driver.ConstraintChangeRequest) (*driver.SchemaChangePreview, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.ConstraintAlterDriver)
	if !ok {
		return nil, fmt.Errorf("PreviewConstraintAlter: %w", driver.ErrUnsupported)
	}
	return alt.PreviewConstraintAlter(req)
}

func (a *App) ExecuteConstraintAlter(connectionID string, req driver.ConstraintChangeRequest) (*driver.SchemaChangeResult, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.ConstraintAlterDriver)
	if !ok {
		return nil, fmt.Errorf("ExecuteConstraintAlter: %w", driver.ErrUnsupported)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Minute)
	defer cancel()

	result, execErr := alt.ExecuteConstraintAlter(ctx, req)
	if result != nil && result.ExecutedCount > 0 && a.meta != nil {
		refreshCtx, refreshCancel := context.WithTimeout(a.ctx, 10*time.Second)
		defer refreshCancel()
		if rErr := a.meta.RefreshTable(refreshCtx, connectionID, req.Schema, req.Table, drv); rErr != nil {
			log.Printf("[app] ExecuteConstraintAlter: cache refresh failed for %s.%s: %v",
				req.Schema, req.Table, rErr)
		}
	}
	return result, execErr
}

func (a *App) PreviewPartitionAlter(connectionID string, req driver.PartitionChangeRequest) (*driver.SchemaChangePreview, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.PartitionAlterDriver)
	if !ok {
		return nil, fmt.Errorf("PreviewPartitionAlter: %w", driver.ErrUnsupported)
	}
	return alt.PreviewPartitionAlter(req)
}

func (a *App) ExecutePartitionAlter(connectionID string, req driver.PartitionChangeRequest) (*driver.SchemaChangeResult, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	alt, ok := drv.(driver.PartitionAlterDriver)
	if !ok {
		return nil, fmt.Errorf("ExecutePartitionAlter: %w", driver.ErrUnsupported)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 5*time.Minute)
	defer cancel()

	result, execErr := alt.ExecutePartitionAlter(ctx, req)
	if result != nil && result.ExecutedCount > 0 && a.meta != nil {
		refreshCtx, refreshCancel := context.WithTimeout(a.ctx, 10*time.Second)
		defer refreshCancel()
		if rErr := a.meta.RefreshTable(refreshCtx, connectionID, req.Schema, req.Table, drv); rErr != nil {
			log.Printf("[app] ExecutePartitionAlter: cache refresh failed for %s.%s: %v",
				req.Schema, req.Table, rErr)
		}
	}
	return result, execErr
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Connection Manager IPC methods
// ─────────────────────────────────────────────────────────────────────────────

// ConnectResult is the IPC return type of the Connect method.
type ConnectResult struct {
	// ConnectionID is the stable ID that identifies this session.
	ConnectionID string `json:"connectionId"`
	// ServerVersion is the version string returned by the database server.
	ServerVersion string `json:"serverVersion"`
	// Error is non-empty when the connection attempt failed.
	Error string `json:"error,omitempty"`
}

// Connect opens a live database connection from a ConnectionConfig supplied
// directly by the frontend (e.g. from the connection dialog's "Test+Connect"
// button, before the config is saved to disk).
//
// The method registers the pool in both the pool Manager (raw *sql.DB) and the
// driver layer (schema introspection).
//
// Frontend usage:
//
//	const result = await Connect({ id:"uuid", host:"localhost", port:3306, ... })
//	if (result.error) showError(result.error)
func (a *App) Connect(cfg database.ConnectionConfig) ConnectResult {
	if cfg.ID == "" {
		return ConnectResult{Error: "connection ID must not be empty"}
	}

	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()

	id, err := a.dbMgr.Connect(ctx, cfg)
	if err != nil {
		return ConnectResult{Error: err.Error()}
	}

	ver, _ := a.dbMgr.ServerVersion(ctx, id)

	// Also register in the driver layer so FetchDatabases / FetchTables work.
	driverCfg := managerCfgToDriverCfg(cfg)
	drv, drvErr := driver.New(driverCfg)
	if drvErr == nil {
		if connErr := drv.Connect(ctx); connErr == nil {
			a.mu.Lock()
			a.connections[cfg.ID] = drv
			a.configs[cfg.ID] = driverCfg
			a.mu.Unlock()
			if a.meta != nil {
				a.meta.SyncSchema(a.ctx, cfg.ID, drv)
			}
		}
	}

	return ConnectResult{ConnectionID: id, ServerVersion: ver}
}

// Disconnect closes the live connection for connID.
// Mirrors RemoveConnection but accepts the string ID directly.
//
// Frontend usage:
//
//	await Disconnect("uuid-here")
func (a *App) Disconnect(connID string) error {
	// Driver layer
	a.mu.Lock()
	drv, ok := a.connections[connID]
	if ok {
		delete(a.connections, connID)
		delete(a.configs, connID)
	}
	a.mu.Unlock()
	if ok {
		ctx, cancel := context.WithTimeout(a.ctx, 5*time.Second)
		defer cancel()
		_ = drv.Close(ctx)
	}

	// Pool Manager layer
	if a.dbMgr != nil {
		_ = a.dbMgr.Disconnect(connID) // ignore "not found"
	}
	return nil
}

// managerCfgToDriverCfg converts a database.ConnectionConfig → driver.ConnectionConfig.
func managerCfgToDriverCfg(mc database.ConnectionConfig) driver.ConnectionConfig {
	cfg := driver.ConnectionConfig{
		ID:       mc.ID,
		Name:     mc.Name,
		Kind:     driver.DriverKind(mc.Kind),
		Host:     mc.Host,
		Port:     mc.Port,
		Username: mc.Username,
		Password: mc.Password,
		Database: mc.Database,
		TLS:      mc.TLS,
	}
	if mc.SSH.Enabled && mc.SSH.Host != "" {
		cfg.SSHTunnel = &driver.SSHTunnelConfig{
			Host:           mc.SSH.Host,
			Port:           mc.SSH.Port,
			Username:       mc.SSH.User,
			AuthType:       mc.SSH.AuthType,
			Password:       mc.SSH.Password,
			PrivateKeyPath: mc.SSH.PrivateKeyPath,
		}
	}
	for _, p := range mc.Advanced {
		cfg.AdvancedParams = append(cfg.AdvancedParams, driver.AdvancedParam{
			Key: p.Key, Value: p.Value, Enabled: p.Enabled,
		})
	}
	return cfg
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12: Inline-edit transaction generator
// ─────────────────────────────────────────────────────────────────────────────

// ApplyChanges converts the frontend's Diff-state (edits / addedRows /
// deletedIds) into an atomic MySQL transaction.
//
// The method mirrors DataViewer's editState exactly:
//
//	result = await ApplyChanges({
//	  connectionId: "uuid",
//	  database:     "shop",
//	  tableName:    "orders",
//	  primaryKey:   "id",
//	  deletedIds:   [3, 4],
//	  addedRows:    [{ status: "shipped", amount: 99.0 }],
//	  editedRows:   [{ id: 1, email: "new@example.com" }],
//	})
//	if (result.error) showError(result.error)
//	else { clearDirtyState(); refreshGrid() }
func (a *App) ApplyChanges(cs database.ChangeSet) database.ApplyResult {
	if a.dbMgr == nil {
		return database.ApplyResult{Error: "database manager not initialised"}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()
	return a.dbMgr.ApplyChanges(ctx, cs)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11: Query Executor IPC methods
// ─────────────────────────────────────────────────────────────────────────────

// ExecuteQuery runs an arbitrary SQL statement on connID and returns up to
// limit rows as an ExecResult with named-column maps.
//
// Compared to RunQuery (which returns [][]any for Glide Data Grid efficiency),
// ExecuteQuery returns []map[string]any so the frontend can access cells by
// column name.
//
// If limit ≤ 0 it defaults to database.DefaultLimit (1000).
// If the query has no LIMIT clause one is injected automatically.
//
// Frontend usage:
//
//	const res = await ExecuteQuery("conn-uuid", "SELECT * FROM orders", 500)
//	if (res.error) showError(res.error)
//	else renderTable(res.columns, res.rows)
func (a *App) ExecuteQuery(connID, sqlStr string, limit int) database.ExecResult {
	if a.dbMgr == nil {
		return database.ExecResult{Error: "database manager not initialised"}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	return a.dbMgr.ExecuteQuery(ctx, connID, sqlStr, limit)
}

// ExecDML runs a non-SELECT statement (INSERT / UPDATE / DELETE / DDL).
// Returns rows affected and timing; never returns result rows.
//
// Frontend usage:
//
//	const res = await ExecDML("conn-uuid", "DELETE FROM tmp WHERE expired=1")
func (a *App) ExecDML(connID, sqlStr string) database.ExecResult {
	if a.dbMgr == nil {
		return database.ExecResult{Error: "database manager not initialised"}
	}
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	return a.dbMgr.ExecDML(ctx, connID, sqlStr)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 10: Schema Crawler IPC methods
// ─────────────────────────────────────────────────────────────────────────────

// SyncMetadata starts a background schema crawl for connID.
//
// The method returns immediately; the actual work runs in a goroutine.
// Use GetSyncState(connID) to poll progress, or listen for the emitted
// "sync:done" / "sync:error" Wails events.
//
// Frontend usage:
//
//	await SyncMetadata("conn-uuid")   // fire-and-forget
//	const state = await GetSyncState("conn-uuid") // poll
func (a *App) SyncMetadata(connID string) error {
	if a.dbMgr == nil || a.sharedDB == nil {
		return fmt.Errorf("database not initialised")
	}

	liveDB, ok := a.dbMgr.DB(connID)
	if !ok {
		return fmt.Errorf("connection %q not found — call Connect first", connID)
	}

	go func() {
		res := database.SyncMetadata(a.ctx, connID, liveDB, a.sharedDB)
		if res.Error != "" {
			log.Printf("[app] SyncMetadata %q: %s", connID, res.Error)
		} else {
			log.Printf("[app] SyncMetadata %q done: %d tables, %d cols in %dms",
				connID, res.TablesCount, res.ColsCount, res.DurationMs)
		}
	}()
	return nil
}

// GetTablesFromCache returns the cached table list for (connID, dbName).
//
// Response time is sub-millisecond (local SQLite read).  Returns an empty
// slice when the cache has not been populated — the UI should prompt a sync.
//
// Pass dbName="" to get tables across all schemas for this connection.
//
// Frontend usage:
//
//	const tables = await GetTablesFromCache("conn-uuid", "mydb")
func (a *App) GetTablesFromCache(connID, dbName string) ([]database.CachedTableEntry, error) {
	if a.sharedDB == nil {
		return nil, fmt.Errorf("database not initialised")
	}
	return database.GetTablesFromCache(a.ctx, a.sharedDB, connID, dbName)
}

// GetTableDetailFromCache returns full column metadata for a single table.
// Returns nil (not an error) when the table is not yet in the cache.
//
// Frontend usage:
//
//	const detail = await GetTableDetailFromCache("conn-uuid", "mydb", "users")
func (a *App) GetTableDetailFromCache(connID, dbName, tableName string) (*database.CachedTableEntry, error) {
	if a.sharedDB == nil {
		return nil, fmt.Errorf("database not initialised")
	}
	return database.GetTableDetailFromCache(a.ctx, a.sharedDB, connID, dbName, tableName)
}

// GetDatabasesFromCache returns the distinct schema names cached for connID.
// The list is sorted and is always a valid JSON array (never null).
//
// Frontend usage:
//
//	const dbs = await GetDatabasesFromCache("conn-uuid")
func (a *App) GetDatabasesFromCache(connID string) ([]string, error) {
	if a.sharedDB == nil {
		return []string{}, nil
	}
	return database.GetDatabasesFromCache(a.ctx, a.sharedDB, connID)
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection config store — persistent save/load/delete
// ─────────────────────────────────────────────────────────────────────────────

// savedConnToDriverCfg converts a store.SavedConnection to the runtime
// driver.ConnectionConfig used to open a live database connection.
func savedConnToDriverCfg(sc store.SavedConnection) driver.ConnectionConfig {
	cfg := driver.ConnectionConfig{
		ID:       sc.ID,
		Name:     sc.Name,
		Comment:  sc.Comment,
		Kind:     driver.DriverKind(sc.Kind),
		Host:     sc.Host,
		Port:     sc.Port,
		Username: sc.Username,
		Password: sc.Password,
		Database: sc.Database,
		TLS:      sc.TLS,
		ReadOnly: sc.ReadOnly,
	}
	// SSH tunnel
	cfg.SSHTunnel = mysqlpkg.ToDriverSSHTunnel(
		sc.SSH.Enabled,
		sc.SSH.Host, sc.SSH.Port, sc.SSH.User,
		sc.SSH.AuthType, sc.SSH.Password, sc.SSH.PrivateKeyPath,
	)
	// Advanced params
	for _, p := range sc.AdvancedParams {
		cfg.AdvancedParams = append(cfg.AdvancedParams, driver.AdvancedParam{
			Key:     p.Key,
			Value:   p.Value,
			Enabled: p.Enabled,
		})
	}
	return cfg
}

// SaveConnection persists a connection configuration.
// The connection is NOT opened; call ConnectSaved or AddConnection to open it.
//
// Frontend usage:
//
//	await SaveConnection({ id:"uuid", name:"My DB", host:"localhost", ... })
func (a *App) SaveConnection(sc store.SavedConnection) error {
	if a.store == nil {
		return fmt.Errorf("connection store not available")
	}
	return a.store.Save(sc)
}

// ListSavedConnections returns all persisted connection configs.
// Password fields are EMPTY for security; use GetSavedConnection to retrieve
// a single record with decrypted passwords for the edit dialog.
//
// Frontend usage:
//
//	const conns = await ListSavedConnections()
func (a *App) ListSavedConnections() []store.SavedConnection {
	if a.store == nil {
		return nil
	}
	list, err := a.store.List()
	if err != nil {
		log.Printf("[app] ListSavedConnections: %v", err)
		return nil
	}
	return list
}

// GetSavedConnection returns a single saved connection with decrypted passwords.
// Use this when opening the edit dialog so form fields can be pre-populated.
//
// Frontend usage:
//
//	const conn = await GetSavedConnection("uuid-here")
func (a *App) GetSavedConnection(id string) (*store.SavedConnection, error) {
	if a.store == nil {
		return nil, fmt.Errorf("connection store not available")
	}
	return a.store.Get(id)
}

// DeleteSavedConnection removes a saved connection config from disk.
// If the connection is currently live, it is also closed.
//
// Frontend usage:
//
//	await DeleteSavedConnection("uuid-here")
func (a *App) DeleteSavedConnection(id string) error {
	// Close live connection if open.
	a.mu.Lock()
	if drv, ok := a.connections[id]; ok {
		_ = drv.Close(a.ctx)
		delete(a.connections, id)
		delete(a.configs, id)
	}
	a.mu.Unlock()

	if a.store == nil {
		return fmt.Errorf("connection store not available")
	}
	return a.store.Delete(id)
}

// TestConnection briefly opens and immediately closes a database connection to
// verify that the supplied credentials are correct. Returns a human-readable
// result message (e.g. "Connected to MySQL 8.0.35").
//
// No connection is retained after the call completes.
//
// Frontend usage:
//
//	const msg = await TestConnection({ host:"localhost", port:3306, ... })
func (a *App) TestConnection(sc store.SavedConnection) (string, error) {
	cfg := savedConnToDriverCfg(sc)
	if cfg.Kind == "" {
		cfg.Kind = driver.DriverMySQL
	}

	drv, err := driver.New(cfg)
	if err != nil {
		return "", fmt.Errorf("create driver: %w", err)
	}

	ctx, cancel := context.WithTimeout(a.ctx, 20*time.Second)
	defer cancel()

	if err := drv.Connect(ctx); err != nil {
		return "", err
	}
	ver := drv.ServerVersion()
	_ = drv.Close(ctx)

	if ver != "" {
		return fmt.Sprintf("Successfully connected · MySQL %s", ver), nil
	}
	return "Successfully connected", nil
}

// ConnectSaved opens a live database connection from a saved config.
// On success the connection is registered and available for RunQuery etc.
// Returns the connection ID.
//
// Frontend usage:
//
//	const id = await ConnectSaved("uuid-here")
func (a *App) ConnectSaved(id string) (string, error) {
	if a.store == nil {
		return "", fmt.Errorf("connection store not available")
	}
	sc, err := a.store.Get(id)
	if err != nil {
		return "", err
	}
	cfg := savedConnToDriverCfg(*sc)
	return a.AddConnection(cfg)
}

// OpenFileDialog shows a native file-open dialog and returns the chosen path.
// Used by the SSH/SSL tab to browse for a private key file.
//
// Frontend usage:
//
//	const path = await OpenFileDialog("Select Private Key")
func (a *App) OpenFileDialog(title string) (string, error) {
	path, err := wailsruntime.OpenFileDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: title,
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "PEM / Key files", Pattern: "*.pem;*.key;*.ppk;*.rsa"},
			{DisplayName: "All files", Pattern: "*"},
		},
	})
	return path, err
}

// ─────────────────────────────────────────────────────────────────────────────
// Query history
// ─────────────────────────────────────────────────────────────────────────────

// QueryHistoryItem is one row from the local query history log.
type QueryHistoryItem struct {
	ID         int64  `json:"id"`
	ConnID     string `json:"connId"`
	DBName     string `json:"dbName"`
	SQL        string `json:"sql"`
	ExecMs     int64  `json:"execMs"`
	ErrorMsg   string `json:"errorMsg"`
	ExecutedAt string `json:"executedAt"`
}

// GetQueryHistory returns recent query history for a connection, newest first.
// limit defaults to 200 when ≤ 0.
func (a *App) GetQueryHistory(connID string, limit int) ([]QueryHistoryItem, error) {
	if a.sharedDB == nil {
		return nil, fmt.Errorf("local database not initialised")
	}
	if limit <= 0 {
		limit = 200
	}
	rows, err := a.sharedDB.QueryContext(a.ctx,
		`SELECT id, conn_id, db_name, sql_text, exec_ms, error_msg, executed_at
		 FROM query_history WHERE conn_id = ?
		 ORDER BY executed_at DESC, id DESC LIMIT ?`,
		connID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []QueryHistoryItem
	for rows.Next() {
		var it QueryHistoryItem
		if err := rows.Scan(&it.ID, &it.ConnID, &it.DBName, &it.SQL, &it.ExecMs, &it.ErrorMsg, &it.ExecutedAt); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	if items == nil {
		items = []QueryHistoryItem{}
	}
	return items, rows.Err()
}

// ClearQueryHistory deletes all query history for a connection.
func (a *App) ClearQueryHistory(connID string) error {
	if a.sharedDB == nil {
		return fmt.Errorf("local database not initialised")
	}
	_, err := a.sharedDB.ExecContext(a.ctx, `DELETE FROM query_history WHERE conn_id = ?`, connID)
	return err
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel running query
// ─────────────────────────────────────────────────────────────────────────────

// CancelQuery cancels the in-flight RunQuery for the given connection.
// Returns nil when a query was cancelled; returns an error if none was running.
func (a *App) CancelQuery(connectionID string) error {
	a.queryMu.Lock()
	fn, ok := a.queryCancels[connectionID]
	a.queryMu.Unlock()
	if !ok {
		return fmt.Errorf("no running query for connection %q", connectionID)
	}
	fn()
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginated query (Load More)
// ─────────────────────────────────────────────────────────────────────────────

// RunQueryPage executes a SQL statement and returns a page of rows starting at
// offset. Used for "Load More" in the result grid.
func (a *App) RunQueryPage(connectionID, dbName, sqlStr string, offset, limit int) (*QueryResult, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = maxQueryRows
	}
	pagedSQL := fmt.Sprintf("SELECT * FROM (%s) _page LIMIT %d OFFSET %d", sqlStr, limit, offset)
	ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
	defer cancel()
	rs, err := drv.ExecuteQueryOnDB(ctx, dbName, pagedSQL)
	if err != nil {
		return &QueryResult{Error: err.Error()}, nil
	}
	defer rs.Rows.Close()
	cols := make([]ColumnMeta, len(rs.Columns))
	for i, c := range rs.Columns {
		cols[i] = ColumnMeta{Name: c.Name, Type: c.DatabaseType, Nullable: c.Nullable}
	}
	var rows [][]any
	truncated := false
	for rs.Rows.Next() {
		if len(rows) >= limit {
			truncated = true
			break
		}
		row := rs.Rows.Row()
		if row == nil {
			break
		}
		rows = append(rows, row)
	}
	return &QueryResult{
		Columns:   cols,
		Rows:      rows,
		RowCount:  len(rows),
		Truncated: truncated,
		ExecMs:    rs.ExecutionTime.Milliseconds(),
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill query (KILL QUERY <pid>)
// ─────────────────────────────────────────────────────────────────────────────

// KillQuery sends KILL QUERY <processID> on the given connection.
func (a *App) KillQuery(connectionID string, processID int64) (*QueryResult, error) {
	return a.RunQuery(connectionID, "", fmt.Sprintf("KILL QUERY %d", processID))
}

// ─────────────────────────────────────────────────────────────────────────────
// FetchRoutines / FetchTriggers / FetchEvents
// ─────────────────────────────────────────────────────────────────────────────

// FetchRoutines returns stored procedures and functions for a database.
func (a *App) FetchRoutines(connectionID, dbName string) ([]driver.RoutineInfo, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	type routinesFetcher interface {
		FetchRoutines(ctx context.Context, dbName string) ([]driver.RoutineInfo, error)
	}
	rf, ok := drv.(routinesFetcher)
	if !ok {
		return []driver.RoutineInfo{}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return rf.FetchRoutines(ctx, dbName)
}

// FetchTriggers returns triggers for a database.
func (a *App) FetchTriggers(connectionID, dbName string) ([]driver.TriggerDetail, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	type triggersFetcher interface {
		FetchTriggers(ctx context.Context, dbName string) ([]driver.TriggerDetail, error)
	}
	tf, ok := drv.(triggersFetcher)
	if !ok {
		return []driver.TriggerDetail{}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return tf.FetchTriggers(ctx, dbName)
}

// FetchEvents returns scheduled events for a database.
func (a *App) FetchEvents(connectionID, dbName string) ([]driver.EventInfo, error) {
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return nil, err
	}
	type eventsFetcher interface {
		FetchEvents(ctx context.Context, dbName string) ([]driver.EventInfo, error)
	}
	ef, ok := drv.(eventsFetcher)
	if !ok {
		return []driver.EventInfo{}, nil
	}
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return ef.FetchEvents(ctx, dbName)
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic file save
// ─────────────────────────────────────────────────────────────────────────────

// SaveTextFile opens a native Save-File dialog with defaultFilename pre-filled,
// writes content to the chosen path, and returns the saved path.
// Returns an empty string (no error) when the user cancels the dialog.
func (a *App) SaveTextFile(defaultFilename, content string) (string, error) {
	ext := ""
	if idx := strings.LastIndex(defaultFilename, "."); idx >= 0 {
		ext = defaultFilename[idx+1:]
	}
	filters := []wailsruntime.FileFilter{
		{DisplayName: ext + " files (*." + ext + ")", Pattern: "*." + ext},
		{DisplayName: "All files (*.*)", Pattern: "*.*"},
	}
	savePath, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		DefaultFilename: defaultFilename,
		Title:           "Save File",
		Filters:         filters,
	})
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	if savePath == "" {
		return "", nil
	}
	if err := os.WriteFile(savePath, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("write file: %w", err)
	}
	return savePath, nil
}

// SQL dump export
// ─────────────────────────────────────────────────────────────────────────────

// ExportDump generates a SQL dump (CREATE TABLE + INSERT statements) for a
// table, opens a native Save-File dialog, writes the file, and returns the
// saved path. Returns an empty string (no error) when the user cancels.
// Limited to 10000 rows to protect memory.
func (a *App) ExportDump(connectionID, dbName, tableName string) (string, error) {
	if tableName == "" {
		return "", fmt.Errorf("tableName is required")
	}
	drv, err := a.ensureLive(connectionID)
	if err != nil {
		return "", err
	}
	adv, ok := drv.(driver.AdvancedSchemaDriver)
	if !ok {
		return "", fmt.Errorf("driver does not support schema introspection")
	}
	ctx, cancel := context.WithTimeout(a.ctx, 30*time.Second)
	defer cancel()

	props, err := adv.FetchAdvancedTableProperties(ctx, dbName, tableName)
	if err != nil {
		return "", err
	}

	dataSQL := fmt.Sprintf("SELECT * FROM `%s`.`%s` LIMIT 10000", dbName, tableName)
	rs, err := drv.ExecuteQueryOnDB(ctx, dbName, dataSQL)
	if err != nil {
		return "", err
	}
	defer rs.Rows.Close()

	var sb strings.Builder
	sb.WriteString("-- GripLite SQL Dump\n")
	sb.WriteString(fmt.Sprintf("-- Table: %s.%s\n", dbName, tableName))
	sb.WriteString(fmt.Sprintf("-- Generated: %s\n\n", time.Now().UTC().Format(time.RFC3339)))

	sb.WriteString("SET FOREIGN_KEY_CHECKS=0;\n\n")
	sb.WriteString(props.DDL)
	sb.WriteString(";\n\n")

	colNames := make([]string, len(rs.Columns))
	for i, c := range rs.Columns {
		colNames[i] = "`" + strings.ReplaceAll(c.Name, "`", "``") + "`"
	}
	colList := strings.Join(colNames, ", ")

	count := 0
	for rs.Rows.Next() {
		row := rs.Rows.Row()
		if row == nil {
			break
		}
		vals := make([]string, len(row))
		for i, v := range row {
			if v == nil {
				vals[i] = "NULL"
			} else {
				s := fmt.Sprintf("%v", v)
				s = strings.ReplaceAll(s, "'", "\\'")
				vals[i] = "'" + s + "'"
			}
		}
		sb.WriteString(fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s);\n",
			tableName, colList, strings.Join(vals, ", ")))
		count++
	}

	sb.WriteString(fmt.Sprintf("\n-- %d rows dumped\n", count))
	sb.WriteString("SET FOREIGN_KEY_CHECKS=1;\n")

	// Open native save-file dialog so the user can choose the destination.
	savePath, err := wailsruntime.SaveFileDialog(a.ctx, wailsruntime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("%s_dump.sql", tableName),
		Title:           "Save SQL Dump",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "SQL files (*.sql)", Pattern: "*.sql"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("save dialog: %w", err)
	}
	if savePath == "" {
		// User cancelled the dialog — not an error.
		return "", nil
	}

	if err := os.WriteFile(savePath, []byte(sb.String()), 0o644); err != nil {
		return "", fmt.Errorf("write file: %w", err)
	}
	return savePath, nil
}
