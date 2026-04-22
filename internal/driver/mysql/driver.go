// Package mysql implements the UDAL [driver.DatabaseDriver] interface for MySQL.
//
// Registration happens automatically via init(); callers only need a blank import:
//
//	import _ "GripLite/internal/driver/mysql"
//
// The driver is then available via [driver.New] with Kind = [driver.DriverMySQL].
package mysql

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql" // side-effect: registers "mysql" with database/sql

	"GripLite/internal/driver"
)

func init() {
	driver.Register(driver.DriverMySQL, func(cfg driver.ConnectionConfig) (driver.DatabaseDriver, error) {
		return New(cfg)
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// mysqlDriver
// ─────────────────────────────────────────────────────────────────────────────

type mysqlDriver struct {
	cfg           driver.ConnectionConfig
	db            *sql.DB
	serverVersion string

	// SSH tunnel state (populated by setupSSHTunnel, cleared by closeTunnel).
	sshNetName string
	sshHolder  *mysqlSSHDialer
}

// New creates a new mysqlDriver. It does NOT open a connection;
// call [Connect] to establish the pool.
func New(cfg driver.ConnectionConfig) (*mysqlDriver, error) {
	if cfg.Host == "" {
		return nil, fmt.Errorf("mysql: host is required")
	}
	if cfg.Port == 0 {
		cfg.Port = 3306
	}
	return &mysqlDriver{cfg: cfg}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

func (d *mysqlDriver) Connect(ctx context.Context) error {
	if d.db != nil {
		return driver.ErrAlreadyConnected
	}

	timeout := d.cfg.ConnectTimeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}

	// ── SSH tunnel (optional) ───────────────────────────────────────────────
	if d.cfg.SSHTunnel != nil && d.cfg.SSHTunnel.Host != "" {
		if err := d.setupSSHTunnel(ctx); err != nil {
			return fmt.Errorf("mysql: %w", err)
		}
	}

	// ── Build DSN ───────────────────────────────────────────────────────────
	dsn := d.buildDSN(timeout)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("mysql: open DSN: %w", err)
	}

	maxOpen := d.cfg.MaxOpenConns
	if maxOpen <= 0 {
		maxOpen = 10
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxOpen / 2)
	db.SetConnMaxLifetime(30 * time.Minute)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return fmt.Errorf("mysql: ping failed: %w", err)
	}

	// Fetch server version for the status bar.
	var version string
	_ = db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&version)

	d.db = db
	d.serverVersion = version
	return nil
}

// buildDSN constructs the MySQL DSN, optionally using the SSH dialer network
// and appending any enabled AdvancedParams as query-string parameters.
func (d *mysqlDriver) buildDSN(timeout time.Duration) string {
	// Base query parameters.
	params := url.Values{}
	params.Set("parseTime", "true")
	params.Set("charset", "utf8mb4")
	params.Set("timeout", timeout.String())
	params.Set("readTimeout", "30s")
	params.Set("writeTimeout", "30s")

	// Append any enabled AdvancedParams — translating JDBC-style keys that
	// users often copy-paste from their existing connection strings into the
	// form keys go-sql-driver/mysql actually understands.  Anything we don't
	// recognise is passed through verbatim; the driver in turn forwards it as
	// a `SET key=value` at connect time, which MySQL rejects with Error 1193
	// ("Unknown system variable") for truly unknown keys — so we only apply
	// well-known translations here and drop a couple of no-ops that would
	// otherwise break the connection handshake.
	for _, p := range d.cfg.AdvancedParams {
		if !p.Enabled || p.Key == "" {
			continue
		}
		k, v, keep := translateAdvancedParam(p.Key, p.Value)
		if !keep {
			continue
		}
		params.Set(k, v)
	}

	// Network protocol: either the registered SSH dialer or plain "tcp".
	network := "tcp"
	if d.sshNetName != "" {
		network = d.sshNetName
	}

	return fmt.Sprintf("%s:%s@%s(%s:%d)/%s?%s",
		d.cfg.Username,
		d.cfg.Password,
		network,
		d.cfg.Host,
		d.cfg.Port,
		d.cfg.Database,
		strings.ReplaceAll(params.Encode(), "+", "%20"),
	)
}

func (d *mysqlDriver) Close(ctx context.Context) error {
	if d.db != nil {
		err := d.db.Close()
		d.db = nil
		if err != nil {
			return err
		}
	}
	d.closeTunnel()
	return nil
}

func (d *mysqlDriver) Ping(ctx context.Context) error {
	if d.db == nil {
		return driver.ErrNotConnected
	}
	if err := d.db.PingContext(ctx); err != nil {
		return fmt.Errorf("mysql: ping: %w", err)
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema introspection
// ─────────────────────────────────────────────────────────────────────────────

// systemSchemas lists the MySQL built-in schemas that should NEVER appear in
// the Database Explorer tree.  They are:
//
//	information_schema  — cross-database metadata views
//	mysql               — internal auth / privilege tables
//	performance_schema  — perf instrumentation
//	sys                 — pre-aggregated helper views over performance_schema
//
// Keep lookup cheap (map + exact match, no regex) — this is called once per
// tree expansion.
var systemSchemas = map[string]bool{
	"information_schema": true,
	"mysql":              true,
	"performance_schema": true,
	"sys":                true,
}

// FetchDatabases returns every user-visible schema on the server.
//
// System schemas are filtered out deterministically so the tree never shows
// auth/metadata internals (matches the behaviour of DBeaver / DataGrip).
// Phase 17: this is also called implicitly by the schema crawler so users
// with multiple business databases (e.g. ulala_main + DemoDB + ginlogin) see
// all of them in the Explorer instead of only the one listed in the
// ConnectionConfig.Database field.
func (d *mysqlDriver) FetchDatabases(ctx context.Context) ([]string, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}

	rows, err := d.db.QueryContext(ctx, "SHOW DATABASES")
	if err != nil {
		return nil, fmt.Errorf("mysql: SHOW DATABASES: %w", err)
	}
	defer rows.Close()

	dbs := make([]string, 0, 8)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("mysql: scan database name: %w", err)
		}
		if systemSchemas[strings.ToLower(name)] {
			continue
		}
		dbs = append(dbs, name)
	}
	return dbs, rows.Err()
}

func (d *mysqlDriver) FetchTables(ctx context.Context, dbName string) ([]driver.TableInfo, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}

	// A single INFORMATION_SCHEMA query — avoids N+1 round trips.
	// data_length + index_length gives the total on-disk footprint in bytes;
	// COALESCE guards against NULL for VIEWs and INFORMATION_SCHEMA tables.
	// TABLE_COMMENT surfaces the server-side description so the UI's
	// Description column and the Properties panel can render it verbatim
	// (Phase 15).  COALESCE collapses NULL comments to the empty string.
	//
	// ENGINE / TABLE_COLLATION / AUTO_INCREMENT power the Properties panel
	// so the user sees the real server-side values when editing them.
	// TABLE_COLLATION yields "utf8mb4_unicode_ci"-style identifiers; we
	// strip the charset prefix client-side when needed.  AUTO_INCREMENT is
	// NULL for tables without an auto-increment column; we forward NULL as
	// a nil pointer so the UI can render the field empty.
	const q = `
		SELECT
		    TABLE_NAME,
		    TABLE_TYPE,
		    COALESCE(TABLE_ROWS, -1)                          AS row_count,
		    COALESCE(DATA_LENGTH + INDEX_LENGTH, -1)          AS size_bytes,
		    COALESCE(TABLE_COMMENT, '')                       AS table_comment,
		    COALESCE(ENGINE, '')                              AS engine,
		    COALESCE(TABLE_COLLATION, '')                     AS collation,
		    AUTO_INCREMENT                                    AS auto_increment
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = ?
		ORDER BY TABLE_NAME`

	rows, err := d.db.QueryContext(ctx, q, dbName)
	if err != nil {
		return nil, fmt.Errorf("mysql: FetchTables %q: %w", dbName, err)
	}
	defer rows.Close()

	var tables []driver.TableInfo
	for rows.Next() {
		var (
			name, tableType, comment    string
			engine, collation           string
			rowCount, sizeBytes         int64
			autoInc                     sql.NullInt64
		)
		if err := rows.Scan(&name, &tableType, &rowCount, &sizeBytes, &comment,
			&engine, &collation, &autoInc); err != nil {
			return nil, fmt.Errorf("mysql: scan table row: %w", err)
		}
		kind := driver.ObjectTable
		if tableType == "VIEW" {
			kind = driver.ObjectView
		}
		// Derive the charset from the collation (e.g. "utf8mb4_unicode_ci"
		// → "utf8mb4") so the Properties panel can show it without an
		// extra query.  INFORMATION_SCHEMA.TABLES does not expose the
		// charset directly; this matches what SHOW TABLE STATUS prints.
		charset := ""
		if collation != "" {
			if i := strings.IndexByte(collation, '_'); i > 0 {
				charset = collation[:i]
			}
		}
		var aiPtr *int64
		if autoInc.Valid {
			v := autoInc.Int64
			aiPtr = &v
		}
		tables = append(tables, driver.TableInfo{
			Name:          name,
			Schema:        dbName,
			Kind:          kind,
			RowCount:      rowCount,
			SizeBytes:     sizeBytes,
			Comment:       comment,
			Engine:        engine,
			Charset:       charset,
			Collation:     collation,
			AutoIncrement: aiPtr,
		})
	}
	return tables, rows.Err()
}

func (d *mysqlDriver) FetchTableDetail(ctx context.Context, dbName, tableName string) (*driver.TableDetail, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}

	// Phase 15: COLUMN_COMMENT surfaces per-field descriptions for the
	// Properties panel's Columns tab.  COALESCE flattens NULL (older MySQL
	// versions may still return NULL for views) to the empty string.
	const q = `
		SELECT
		    COLUMN_NAME,
		    DATA_TYPE,
		    COLUMN_TYPE,
		    IS_NULLABLE,
		    COLUMN_KEY,
		    ORDINAL_POSITION,
		    COALESCE(COLUMN_COMMENT, '') AS column_comment
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
		ORDER BY ORDINAL_POSITION`

	rows, err := d.db.QueryContext(ctx, q, dbName, tableName)
	if err != nil {
		return nil, fmt.Errorf("mysql: FetchTableDetail %q.%q: %w", dbName, tableName, err)
	}
	defer rows.Close()

	var cols []driver.ColumnInfo
	for rows.Next() {
		var colName, dataType, columnType, isNullable, columnKey, comment string
		var ordinal int
		if err := rows.Scan(&colName, &dataType, &columnType, &isNullable, &columnKey, &ordinal, &comment); err != nil {
			return nil, fmt.Errorf("mysql: scan column: %w", err)
		}
		cols = append(cols, driver.ColumnInfo{
			Name:         colName,
			DatabaseType: columnType,
			Nullable:     isNullable == "YES",
			PrimaryKey:   columnKey == "PRI",
			Ordinal:      ordinal - 1,
			Comment:      comment,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(cols) == 0 {
		return nil, fmt.Errorf("%w: %s.%s", driver.ErrTableNotFound, dbName, tableName)
	}

	// Fetch the table-level metadata (engine / charset / collation /
	// auto_increment / comment / row_count / size_bytes) in a separate,
	// bounded query so RefreshTable can keep the Properties panel in
	// sync without a full database crawl.  Failures here are not fatal
	// — we still return the columns — so older MySQL variants or
	// partial permissions don't break the Columns tab.
	info := driver.TableInfo{Name: tableName, Schema: dbName, Kind: driver.ObjectTable}
	const qTbl = `
		SELECT
		    TABLE_TYPE,
		    COALESCE(TABLE_ROWS, -1),
		    COALESCE(DATA_LENGTH + INDEX_LENGTH, -1),
		    COALESCE(TABLE_COMMENT, ''),
		    COALESCE(ENGINE, ''),
		    COALESCE(TABLE_COLLATION, ''),
		    AUTO_INCREMENT
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`
	var (
		tableType, comment, engine, collation string
		rowCount, sizeBytes                   int64
		autoInc                               sql.NullInt64
	)
	if err := d.db.QueryRowContext(ctx, qTbl, dbName, tableName).
		Scan(&tableType, &rowCount, &sizeBytes, &comment, &engine, &collation, &autoInc); err == nil {
		if tableType == "VIEW" {
			info.Kind = driver.ObjectView
		}
		info.RowCount = rowCount
		info.SizeBytes = sizeBytes
		info.Comment = comment
		info.Engine = engine
		info.Collation = collation
		if collation != "" {
			if i := strings.IndexByte(collation, '_'); i > 0 {
				info.Charset = collation[:i]
			}
		}
		if autoInc.Valid {
			v := autoInc.Int64
			info.AutoIncrement = &v
		}
	}

	return &driver.TableDetail{
		TableInfo: info,
		Columns:   cols,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Query execution
// ─────────────────────────────────────────────────────────────────────────────

func (d *mysqlDriver) ExecuteQuery(ctx context.Context, query string) (*driver.ResultSet, error) {
	return d.ExecuteQueryOnDB(ctx, "", query)
}

func (d *mysqlDriver) ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*driver.ResultSet, error) {
	if d.db == nil {
		return nil, driver.ErrNotConnected
	}

	conn, err := d.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("mysql: acquire connection: %w", err)
	}
	// conn.Close() is deferred inside the RowIterator.

	if dbName != "" {
		if _, err := conn.ExecContext(ctx, "USE `"+dbName+"`"); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("mysql: USE %q: %w", dbName, err)
		}
	}

	start := time.Now()
	sqlRows, err := conn.QueryContext(ctx, query)
	elapsed := time.Since(start)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("mysql: query: %w", err)
	}

	colTypes, err := sqlRows.ColumnTypes()
	if err != nil {
		_ = sqlRows.Close()
		_ = conn.Close()
		return nil, fmt.Errorf("mysql: column types: %w", err)
	}

	cols := make([]driver.ColumnInfo, len(colTypes))
	for i, ct := range colTypes {
		nullable, _ := ct.Nullable()
		cols[i] = driver.ColumnInfo{
			Name:         ct.Name(),
			DatabaseType: ct.DatabaseTypeName(),
			Nullable:     nullable,
			Ordinal:      i,
		}
	}

	iter := &sqlRowIterator{
		rows:   sqlRows,
		conn:   conn,
		nCols:  len(cols),
	}

	return &driver.ResultSet{
		Columns:       cols,
		Rows:          iter,
		ExecutionTime: elapsed,
	}, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// JDBC → go-sql-driver parameter translation
// ─────────────────────────────────────────────────────────────────────────────
//
// The Advanced tab in the connection dialog accepts free-form key/value pairs,
// and users often copy them straight out of their existing JDBC URLs:
//
//	jdbc:mysql://host:port/db?useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true
//
// These keys are specific to Connector/J.  go-sql-driver/mysql uses a different
// vocabulary, and unknown keys are silently forwarded to the server as
// "SET <key> = <value>" at connect time — which fails with Error 1193
// "Unknown system variable" and prevents the connection from opening at all.
//
// translateAdvancedParam rewrites the best-known JDBC keys to their Go-driver
// equivalents and returns keep=false for keys that are safe to drop.  Unknown
// keys are passed through unchanged so power-users retain full control.
//
// References:
//   - https://github.com/go-sql-driver/mysql#parameters
//   - https://dev.mysql.com/doc/connector-j/en/connector-j-reference-configuration-properties.html

func translateAdvancedParam(key, value string) (outKey, outValue string, keep bool) {
	switch strings.ToLower(key) {
	// JDBC useSSL=true/false  →  tls=true/false
	case "usessl":
		return "tls", strings.ToLower(value), true

	// JDBC serverTimezone=Area/City  →  loc=Area/City  (Go driver loads via
	// time.LoadLocation; value format is identical).
	case "servertimezone":
		return "loc", value, true

	// JDBC allowPublicKeyRetrieval=true is required by MySQL 8 + caching_sha2
	// when using non-TLS connections.  go-sql-driver/mysql handles this
	// automatically since v1.6; the key is a no-op and the server would
	// otherwise reject it with Error 1193 — so we drop it silently.
	case "allowpublickeyretrieval":
		return "", "", false

	// Already-correct go-driver keys (or keys we don't recognise) pass through.
	default:
		return key, value, true
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver metadata
// ─────────────────────────────────────────────────────────────────────────────

func (d *mysqlDriver) Kind() driver.DriverKind { return driver.DriverMySQL }

func (d *mysqlDriver) ServerVersion() string { return d.serverVersion }

// ─────────────────────────────────────────────────────────────────────────────
// sqlRowIterator — wraps *sql.Rows as a driver.RowIterator
// ─────────────────────────────────────────────────────────────────────────────

type sqlRowIterator struct {
	rows  *sql.Rows
	conn  *sql.Conn // underlying conn returned to pool on Close
	nCols int
	err   error
}

func (it *sqlRowIterator) Next() bool {
	if it.err != nil || it.rows == nil {
		return false
	}
	return it.rows.Next()
}

// Row scans the current row into a fresh []any.
// []byte columns (TEXT, BLOB, etc.) are eagerly converted to string so that
// the caller never holds a reference into the driver's internal buffer.
func (it *sqlRowIterator) Row() driver.Row {
	// Allocate pointer targets for scanning.
	ptrs := make([]any, it.nCols)
	vals := make([]any, it.nCols)
	for i := range ptrs {
		ptrs[i] = &vals[i]
	}

	if err := it.rows.Scan(ptrs...); err != nil {
		it.err = err
		return nil
	}

	result := make(driver.Row, it.nCols)
	for i, v := range vals {
		switch t := v.(type) {
		case []byte:
			// TEXT / BLOB — materialise as string to avoid dangling slice.
			result[i] = string(t)
		case time.Time:
			// Serialise as ISO 8601 so JSON / Wails can round-trip it.
			result[i] = t.Format(time.RFC3339)
		default:
			result[i] = v
		}
	}
	return result
}

func (it *sqlRowIterator) Err() error {
	if it.err != nil {
		return it.err
	}
	if it.rows != nil {
		return it.rows.Err()
	}
	return nil
}

func (it *sqlRowIterator) Close() error {
	var rowErr, connErr error
	if it.rows != nil {
		rowErr = it.rows.Close()
		it.rows = nil
	}
	if it.conn != nil {
		connErr = it.conn.Close()
		it.conn = nil
	}
	if rowErr != nil {
		return rowErr
	}
	return connErr
}
