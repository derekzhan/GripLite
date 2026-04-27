// Package driver defines the Unified Data Access Layer (UDAL) for GripLite.
//
// The UDAL abstracts over heterogeneous database backends (MySQL, MongoDB, …)
// behind a single, context-aware interface. Callers never import a concrete
// driver directly; they program against [DatabaseDriver].
//
// Dependency graph (read-only, no import cycles):
//
//	frontend (Wails IPC)
//	    └── app.go (service layer)
//	            └── internal/driver (this package – interfaces & types only)
//	                    ├── internal/driver/mysql  (future: MySQL implementation)
//	                    └── internal/driver/mongo  (future: MongoDB implementation)
package driver

import (
	"context"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Connection configuration
// ─────────────────────────────────────────────────────────────────────────────

// DriverKind identifies the backend technology of a data source.
// It is used as a discriminant when the registry selects the correct
// [DatabaseDriver] factory for a given [ConnectionConfig].
type DriverKind string

const (
	DriverMySQL   DriverKind = "mysql"
	DriverMongoDB DriverKind = "mongodb"
)

// SSHTunnelConfig carries the optional SSH jump-host configuration.
// When non-nil, the driver MUST route the database connection through the
// tunnel rather than connecting directly. This mirrors the DataGrip UX.
type SSHTunnelConfig struct {
	// Host is the SSH server address (hostname or IP, no port).
	Host string `json:"host"`
	// Port defaults to 22 if zero.
	Port int `json:"port"`
	// Username is the OS user on the SSH host.
	Username string `json:"user"`
	// AuthType is "password" or "keyPair". Defaults to "password".
	AuthType string `json:"authType"`
	// PrivateKeyPath is the path to a PEM-encoded private key file.
	// Used when AuthType == "keyPair".
	PrivateKeyPath string `json:"privateKeyPath"`
	// Password is the SSH login password (AuthType == "password").
	// MUST NOT be persisted in plain text.
	Password string `json:"password"`
}

// AdvancedParam is a single driver-level key/value parameter (e.g. MySQL DSN
// query-string options).  Enabled controls whether the param is appended.
type AdvancedParam struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// ConnectionConfig is the driver-agnostic description of a data source.
//
// Sensitive fields (Password) MUST NOT be stored in plain text on disk.
// Persisters should serialise the rest of the struct to SQLite and retrieve
// the password at connection time from the system Keychain (darwin: Keychain
// Access, linux: libsecret, windows: Windows Credential Manager).
type ConnectionConfig struct {
	// ID is a stable, client-generated UUID that uniquely identifies this
	// data source across sessions.
	ID string `json:"id"`

	// Name is a human-readable label shown in the Database Explorer tree.
	Name string `json:"name"`

	// Comment is an optional user-supplied note about this connection.
	Comment string `json:"comment"`

	// Kind selects the backend driver implementation.
	Kind DriverKind `json:"kind"`

	// Host is the database server hostname or IP (never includes a port).
	Host string `json:"host"`

	// Port is the TCP port of the database server.
	// Conventional defaults: MySQL = 3306, MongoDB = 27017.
	Port int `json:"port"`

	// Username is the database login name.
	Username string `json:"username"`

	// Password is the database login password.
	// MUST be sourced from an in-memory secret store at runtime;
	// persisting this field is a security violation.
	Password string `json:"password"`

	// Database is the default database (schema) to select on connect.
	// For MongoDB this is the authentication database.
	// May be empty if the driver supports server-level queries.
	Database string `json:"database"`

	// ConnectTimeout is the maximum time allowed for the initial handshake.
	// Zero means the driver's built-in default applies.
	ConnectTimeout time.Duration `json:"connectTimeout"`

	// MaxOpenConns is the connection-pool ceiling.
	// Zero lets each driver apply its own sensible default.
	MaxOpenConns int `json:"maxOpenConns"`

	// TLS controls whether TLS is required for the connection.
	TLS bool `json:"tls"`

	// SSHTunnel, when non-nil, routes all traffic through an SSH jump host.
	SSHTunnel *SSHTunnelConfig `json:"sshTunnel,omitempty"`

	// AdvancedParams are driver-specific key/value options appended to the DSN.
	AdvancedParams []AdvancedParam `json:"advancedParams,omitempty"`

	// ReadOnly, when true, blocks DML/DDL statements at the app layer.
	ReadOnly bool `json:"readOnly"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema metadata
// ─────────────────────────────────────────────────────────────────────────────

// ObjectKind distinguishes database objects within a schema.
// Drivers return this in [TableInfo] so the UI can render the correct icon.
type ObjectKind string

const (
	ObjectTable     ObjectKind = "table"
	ObjectView      ObjectKind = "view"
	ObjectRoutine   ObjectKind = "routine"  // stored procedures & functions
	ObjectCollection ObjectKind = "collection" // MongoDB-specific
)

// ColumnInfo describes a single column (or document field) returned in a
// query result or schema introspection call.
type ColumnInfo struct {
	// Name is the column/field name as reported by the server.
	Name string

	// DatabaseType is the raw type string from the server (e.g. "VARCHAR(255)",
	// "BIGINT UNSIGNED", "ObjectId"). Drivers MUST NOT normalise this value so
	// that the UI can display exactly what the server reports.
	DatabaseType string

	// Nullable indicates whether the server allows NULL (or BSON null) in
	// this column. False means NOT NULL or an inferred non-nullable field.
	Nullable bool

	// PrimaryKey is true when this column is part of the table's primary key.
	// For MongoDB _id fields this is always true.
	PrimaryKey bool

	// Ordinal is the 0-based position of this column in the result set.
	// For schema introspection it reflects the server's declared column order.
	Ordinal int

	// Comment is the user-supplied description of the column (MySQL
	// COLUMN_COMMENT). Empty string when no comment is set on the server —
	// never nil and never "NULL" — so the UI can render it verbatim.
	Comment string
}

// IndexInfo describes a single index on a table or collection.
type IndexInfo struct {
	// Name is the server-assigned index name.
	Name string

	// Columns lists the column names that form the index key, in key order.
	Columns []string

	// Unique is true when the index enforces uniqueness.
	Unique bool

	// Primary is true when this is the table's primary-key index.
	Primary bool
}

// TableInfo is a lightweight summary of a table, view, or collection used
// to populate the Database Explorer tree.
//
// Drivers return a slice of TableInfo from [DatabaseDriver.FetchTables].
// Full schema detail (columns, indexes) is fetched lazily via
// [DatabaseDriver.FetchTableDetail] only when the user expands the node.
type TableInfo struct {
	// Name is the unqualified table / collection name.
	Name string `json:"name"`

	// Schema is the containing schema or database name.
	// For MySQL this is the database name; for MongoDB it is the db name.
	Schema string `json:"schema"`

	// Kind classifies the object so the UI renders the correct icon.
	Kind ObjectKind `json:"kind"`

	// RowCount is an estimated row count from server statistics.
	// -1 means the driver could not obtain an estimate without a full scan.
	RowCount int64 `json:"rowCount"`

	// SizeBytes is the estimated on-disk size in bytes (data + indexes).
	// Populated from information_schema.TABLES (data_length + index_length).
	// -1 means unavailable (e.g. the driver did not query size information).
	SizeBytes int64 `json:"sizeBytes"`

	// Comment is the user-supplied description of the table (MySQL
	// TABLE_COMMENT).  Empty string when the table has no comment — never
	// nil and never "NULL" so the UI can render it verbatim.
	Comment string `json:"comment"`

	// Engine is the storage engine (MySQL: InnoDB / MyISAM / …).
	// Empty string when the driver does not expose this concept (SQLite,
	// most document stores) so the UI can suppress the field.
	Engine string `json:"engine"`

	// Charset is the default character set of the table (MySQL
	// DEFAULT CHARSET).  Empty when unavailable.
	Charset string `json:"charset"`

	// Collation is the default collation (MySQL DEFAULT COLLATE).
	// Empty when unavailable.
	Collation string `json:"collation"`

	// AutoIncrement is the next auto-increment counter.  A nil pointer
	// means "not applicable" (no auto-increment column, or driver does
	// not expose it); a concrete value lets the UI show "1024" literally.
	AutoIncrement *int64 `json:"autoIncrement"`
}

// TableDetail augments [TableInfo] with column and index metadata.
// It is fetched lazily (only on tree-node expansion) to avoid issuing
// heavy INFORMATION_SCHEMA queries during the initial tree render.
type TableDetail struct {
	TableInfo

	// Columns is the ordered list of columns / document fields.
	Columns []ColumnInfo

	// Indexes lists all indexes declared on this table.
	Indexes []IndexInfo

	// DDL is the server-generated CREATE TABLE / CREATE VIEW statement.
	// Empty string means the driver does not support DDL generation.
	DDL string
}

// ─────────────────────────────────────────────────────────────────────────────
// Result set – streaming design
// ─────────────────────────────────────────────────────────────────────────────

// Row represents a single result row as an ordered slice of raw values.
// Each element corresponds to the [ColumnInfo] at the same index in
// [ResultSet.Columns].
//
// Value types depend on the backend:
//   - MySQL:   int64, float64, []byte, string, time.Time, nil
//   - MongoDB: primitive.ObjectID, string, int32, int64, float64,
//              bool, time.Time, primitive.M (sub-document), nil
//
// Callers MUST type-assert defensively; they MUST NOT assume a specific
// concrete type without first inspecting [ColumnInfo.DatabaseType].
type Row = []any

// RowIterator is a pull-based cursor over a result set.
//
// Usage pattern (mirrors database/sql.Rows intentionally):
//
//	iter, err := driver.ExecuteQuery(ctx, query)
//	if err != nil { ... }
//	defer iter.Close()
//
//	for iter.Next() {
//	    row := iter.Row()
//	    // process row
//	}
//	if err := iter.Err(); err != nil { ... }
//
// Implementations MUST be safe to call Close multiple times.
// After Close returns, Row and Next MUST NOT be called.
//
// Context cancellation MUST cause Next to return false and Err to return
// the context's error on the subsequent call.
type RowIterator interface {
	// Next advances the cursor to the next row.
	// Returns true when a row is available, false when exhausted or on error.
	Next() bool

	// Row returns the current row's values.
	// Callers MUST call Next first; behaviour is undefined otherwise.
	// The returned slice is owned by the iterator and MAY be overwritten
	// on the next call to Next – callers that need to retain a row MUST copy it.
	Row() Row

	// Err returns the first non-EOF error encountered by Next.
	// Must be checked after the for-loop exits.
	Err() error

	// Close releases all resources held by the iterator (network connections,
	// server-side cursors, open transactions).
	// Callers MUST call Close even when iteration completes normally.
	Close() error
}

// ResultSet is the return value of [DatabaseDriver.ExecuteQuery].
//
// It separates column metadata (available immediately after the server
// sends its response header) from row data (delivered as a lazy stream).
// This mirrors the wire protocol of both MySQL (EOF-terminated result sets)
// and MongoDB (cursor-based getMore).
//
// Memory contract: drivers MUST NOT buffer the full result set in memory.
// Row data flows through [RowIterator] one row at a time, allowing the UI
// to page through millions of rows without exhausting the heap.
type ResultSet struct {
	// Columns describes the shape of every row in this result set.
	// Available immediately after ExecuteQuery returns (before any iteration).
	Columns []ColumnInfo

	// Rows is the lazy row stream. Callers MUST always call Rows.Close()
	// to avoid leaking server-side resources.
	Rows RowIterator

	// RowsAffected is the number of rows modified by a DML statement
	// (INSERT / UPDATE / DELETE). Zero for SELECT queries.
	RowsAffected int64

	// LastInsertID is the auto-increment ID generated by the last INSERT.
	// Zero when not applicable (SELECT, UPDATE, MongoDB upserts without _id).
	LastInsertID int64

	// ExecutionTime is the wall-clock duration measured by the driver from
	// the moment the query was sent until the first byte of the result header
	// was received. Network latency is included; row-fetch time is excluded.
	ExecutionTime time.Duration

	// Plan contains the execution plan if the query was prefixed with EXPLAIN
	// or if the driver automatically fetches it (future feature).
	// Nil when no plan is available.
	Plan *ExecutionPlan
}

// ExecutionPlan holds the raw and structured forms of a query's execution plan.
type ExecutionPlan struct {
	// Format identifies the serialisation format of Raw.
	// Known values: "json" (MySQL 8 EXPLAIN FORMAT=JSON),
	// "text" (MySQL EXPLAIN), "bson" (MongoDB explain).
	Format string

	// Raw is the unmodified plan text returned by the server.
	Raw string
}

// ─────────────────────────────────────────────────────────────────────────────
// Core driver interface
// ─────────────────────────────────────────────────────────────────────────────

// DatabaseDriver is the central abstraction of the UDAL.
//
// Every method accepts a [context.Context] as its first argument so that:
//  1. The Wails frontend can cancel in-flight operations via the UI.
//  2. Long-running queries respect the OS-level shutdown signal.
//  3. Connection-pool acquisition is bounded by the same deadline that
//     governs the query itself.
//
// Implementations MUST be safe for concurrent use by multiple goroutines.
// The connection pool is managed internally; callers never acquire or
// release individual connections.
//
// Lifecycle:
//
//	cfg  := driver.ConnectionConfig{...}
//	drv, err := mysql.New(cfg)   // factory – does NOT open a connection
//	if err != nil { ... }
//
//	ctx := context.Background()
//	if err := drv.Connect(ctx); err != nil { ... }
//	defer drv.Close(ctx)
//
//	// … use drv …
type DatabaseDriver interface {
	// ── Lifecycle ────────────────────────────────────────────────────────────

	// Connect initialises the connection pool and verifies reachability
	// by performing a lightweight ping. It does NOT open MaxOpenConns
	// connections up-front; the pool grows lazily.
	//
	// Calling Connect on an already-connected driver is a no-op.
	// Returns a descriptive error if the server is unreachable, credentials
	// are rejected, or the context deadline expires.
	Connect(ctx context.Context) error

	// Close drains in-flight queries, releases all pooled connections, and
	// frees any OS resources (file descriptors, SSH tunnels).
	//
	// After Close returns, the driver MUST NOT accept further calls.
	// Callers MUST NOT call Close concurrently with other methods.
	Close(ctx context.Context) error

	// Ping verifies that the server is still reachable without executing a
	// full query. Drivers SHOULD use a lightweight protocol-level heartbeat
	// (MySQL COM_PING, MongoDB { ping: 1 }).
	//
	// Useful for implementing the connection-health indicator in the status bar.
	Ping(ctx context.Context) error

	// ── Schema introspection ─────────────────────────────────────────────────

	// FetchDatabases returns the names of all databases (MySQL) or databases
	// (MongoDB) visible to the authenticated user.
	//
	// Drivers MUST respect the context; a cancelled context MUST cause the
	// method to return promptly with the context's error.
	//
	// Results are returned in server-default order (typically alphabetical).
	// The caller is responsible for sorting if a different order is required.
	FetchDatabases(ctx context.Context) ([]string, error)

	// FetchTables returns lightweight metadata for all tables, views, and
	// routines (or MongoDB collections) within the named database.
	//
	// Drivers MUST NOT issue one query per object; a single
	// INFORMATION_SCHEMA (MySQL) or listCollections (MongoDB) query is expected.
	//
	// Returns [ErrDatabaseNotFound] if dbName does not exist or the user lacks
	// the SHOW privilege.
	FetchTables(ctx context.Context, dbName string) ([]TableInfo, error)

	// FetchTableDetail returns full column and index metadata for a single table.
	//
	// This method is intentionally separate from [FetchTables] to support
	// lazy loading in the UI: columns are fetched only when the user expands
	// a table node, avoiding N×INFORMATION_SCHEMA queries on startup.
	//
	// Returns [ErrTableNotFound] if the table does not exist.
	FetchTableDetail(ctx context.Context, dbName, tableName string) (*TableDetail, error)

	// ── Query execution ───────────────────────────────────────────────────────

	// ExecuteQuery executes an arbitrary SQL (or MongoDB command) string and
	// returns a streaming [ResultSet].
	//
	// The query string MAY contain multiple statements separated by semicolons;
	// behaviour for multi-statement queries is driver-defined. MySQL drivers
	// MUST enable the CLIENT_MULTI_STATEMENTS capability and return the first
	// result set; subsequent result sets are discarded unless the driver
	// implements [MultiResultDriver].
	//
	// Callers MUST call ResultSet.Rows.Close() even on error paths to avoid
	// leaking server-side cursors.
	//
	// Context cancellation MUST interrupt the in-flight query. For MySQL this
	// means issuing a COM_KILL on a separate connection. For MongoDB this means
	// calling killCursors.
	ExecuteQuery(ctx context.Context, query string) (*ResultSet, error)

	// ExecuteQueryOnDB is identical to [ExecuteQuery] but first switches the
	// session to the specified database (USE <dbName> for MySQL,
	// db.<collection> for MongoDB).
	//
	// This allows the SQL Editor's active-database selector to be honoured
	// without mutating the driver's default database permanently.
	ExecuteQueryOnDB(ctx context.Context, dbName, query string) (*ResultSet, error)

	// ── Driver metadata ───────────────────────────────────────────────────────

	// Kind returns the [DriverKind] constant for this implementation.
	// Useful for rendering backend-specific UI elements.
	Kind() DriverKind

	// ServerVersion returns a human-readable version string (e.g. "8.0.35",
	// "7.0.4 (MongoDB)") obtained during [Connect]. Returns an empty string
	// before Connect is called.
	ServerVersion() string
}

// ─────────────────────────────────────────────────────────────────────────────
// Optional extension interfaces
//
// Callers discover these at runtime via type assertion:
//
//	if ex, ok := drv.(driver.ExplainDriver); ok {
//	    plan, err := ex.ExplainQuery(ctx, query)
//	}
// ─────────────────────────────────────────────────────────────────────────────

// ExplainDriver is an optional extension for drivers that support query
// plan introspection natively (MySQL EXPLAIN, MongoDB explain()).
type ExplainDriver interface {
	DatabaseDriver

	// ExplainQuery returns the execution plan for the given query without
	// actually executing it.
	ExplainQuery(ctx context.Context, query string) (*ExecutionPlan, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Advanced schema introspection (Phase 19)
// ─────────────────────────────────────────────────────────────────────────────

// IndexDetail is a richer variant of [IndexInfo] used by the Properties panel.
// Unlike IndexInfo (which is part of TableDetail and meant for the Explorer
// tree), IndexDetail preserves server-reported metadata such as the index
// algorithm and a free-text comment.
type IndexDetail struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // BTREE / HASH / FULLTEXT / SPATIAL
	Unique  bool     `json:"unique"`
	Columns []string `json:"columns"` // key columns in key order
	Comment string   `json:"comment"`
}

// ConstraintDetail describes a named table constraint.  For MySQL the
// current implementation surfaces PRIMARY KEY, UNIQUE, and CHECK constraints
// — FOREIGN KEY constraints are exposed via [ForeignKeyDetail] instead so
// the UI can split them into their own tab.
type ConstraintDetail struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // PRIMARY KEY / UNIQUE / CHECK
	Columns []string `json:"columns"` // empty for CHECK constraints
}

// ForeignKeyDetail describes one foreign key relationship.  Multi-column
// foreign keys collapse Columns / RefColumns into parallel slices.
type ForeignKeyDetail struct {
	Name       string   `json:"name"`
	Columns    []string `json:"columns"`
	RefSchema  string   `json:"refSchema"`
	RefTable   string   `json:"refTable"`
	RefColumns []string `json:"refColumns"`
	OnDelete   string   `json:"onDelete"` // CASCADE / RESTRICT / SET NULL / NO ACTION
	OnUpdate   string   `json:"onUpdate"`
}

// ReferenceDetail is the inverse of [ForeignKeyDetail]: it lists the tables
// that reference the current table.  Useful for answering "who depends on
// this table?" before a drop.
type ReferenceDetail struct {
	Name       string   `json:"name"`
	FromSchema string   `json:"fromSchema"`
	FromTable  string   `json:"fromTable"`
	FromCols   []string `json:"fromCols"`
	ToCols     []string `json:"toCols"`
	OnDelete   string   `json:"onDelete"`
	OnUpdate   string   `json:"onUpdate"`
}

// TriggerDetail describes one trigger attached to a table.
type TriggerDetail struct {
	Name      string `json:"name"`
	Event     string `json:"event"`     // INSERT / UPDATE / DELETE
	Timing    string `json:"timing"`    // BEFORE / AFTER
	Statement string `json:"statement"` // body (truncated in UI if very long)
}

// RoutineInfo describes a stored procedure or function in a database.
type RoutineInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`       // PROCEDURE or FUNCTION
	ReturnType string `json:"returnType"` // only for FUNCTION
	Comment    string `json:"comment"`
	Created    string `json:"created"`
	Modified   string `json:"modified"`
}

// EventInfo describes a MySQL scheduled event.
type EventInfo struct {
	Name     string `json:"name"`
	Status   string `json:"status"`   // ENABLED / DISABLED
	Schedule string `json:"schedule"` // human description
	Comment  string `json:"comment"`
}

// AdvancedTableProperties is the aggregate payload returned by
// [AdvancedSchemaDriver.FetchAdvancedTableProperties].  All slices are
// guaranteed non-nil (empty rather than nil) so the frontend can iterate
// safely without null checks.
type AdvancedTableProperties struct {
	Schema      string             `json:"schema"`
	Table       string             `json:"table"`
	DDL         string             `json:"ddl"`
	Indexes     []IndexDetail      `json:"indexes"`
	Constraints []ConstraintDetail `json:"constraints"`
	ForeignKeys []ForeignKeyDetail `json:"foreignKeys"`
	References  []ReferenceDetail  `json:"references"`
	Triggers    []TriggerDetail    `json:"triggers"`
}

// AdvancedSchemaDriver is an optional extension interface for drivers that
// can report full "CREATE TABLE" DDL, indexes, foreign keys, and triggers.
//
// Callers discover it via type assertion:
//
//	if adv, ok := drv.(driver.AdvancedSchemaDriver); ok {
//	    props, err := adv.FetchAdvancedTableProperties(ctx, dbName, tableName)
//	}
//
// Drivers that cannot produce this metadata (e.g. future MongoDB impl)
// simply don't implement the interface.
type AdvancedSchemaDriver interface {
	DatabaseDriver

	FetchAdvancedTableProperties(ctx context.Context, dbName, tableName string) (*AdvancedTableProperties, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema alteration (Phase 20)
//
// The Schema Designer lets the user edit a table's columns + table-level
// options in the UI, then generate an ALTER TABLE diff to apply back to
// the server.  The flow is two-phase:
//
//   1. PreviewAlter(before, after)  → returns the generated SQL statements
//                                     (pure function, no side effects).
//   2. ExecuteAlter(before, after)  → re-runs the diff on the server and
//                                     applies each statement in order.
//
// Step 1 lets the UI show a "Review SQL" dialog.  Step 2 re-computes the
// diff server-side so a tampered frontend payload cannot inject arbitrary
// DDL — the server only ever runs statements that it itself generated from
// the two draft snapshots.
// ─────────────────────────────────────────────────────────────────────────────

// ColumnDraft is the editable shape of a single column inside the Schema
// Designer.  The frontend sends two arrays: the original snapshot and the
// edited version.  The diff engine matches rows by [ColumnDraft.OriginalName]
// — empty means "newly added column".
type ColumnDraft struct {
	// OriginalName is the column's name at the time the draft was loaded.
	// Empty string marks a freshly added column.
	OriginalName string `json:"originalName"`

	// Name is the desired name after the edit.  When Name differs from
	// OriginalName a CHANGE COLUMN (rename) is emitted.
	Name string `json:"name"`

	// Type is the full type declaration ("varchar(64)", "int(11) unsigned",
	// "enum('a','b')"…).  The diff engine does NOT normalise it — the
	// server will reject invalid syntax.
	Type string `json:"type"`

	// NotNull maps to NOT NULL / NULL in the column spec.
	NotNull bool `json:"notNull"`

	// AutoIncrement toggles AUTO_INCREMENT.  Only legal on a single
	// integer column that is part of the primary key; we do not validate
	// that constraint here — MySQL will surface a clear error.
	AutoIncrement bool `json:"autoIncrement"`

	// Default is the literal default expression, already properly quoted
	// (e.g. "'active'", "CURRENT_TIMESTAMP", "0").  HasDefault distinguishes
	// "DEFAULT NULL" (explicit) from "no DEFAULT clause" (implicit).
	Default    string `json:"default"`
	HasDefault bool   `json:"hasDefault"`

	// Comment maps to COMMENT '...' in the column spec.
	Comment string `json:"comment"`
}

// TableInfoDraft carries the editable table-level options.
// Fields map 1:1 to MySQL's CREATE TABLE options.
//
// Name is the (possibly renamed) table name; when Updated.Name differs
// from Original.Name, drivers should emit a RENAME TABLE statement.
// Charset and AutoIncrement are MySQL-specific table options.  A nil
// AutoIncrement means "leave the current value alone" (so opening a
// table and saving without touching the field is a no-op).
type TableInfoDraft struct {
	Name          string `json:"name"`
	Engine        string `json:"engine"`
	Collation     string `json:"collation"`
	Charset       string `json:"charset"`
	AutoIncrement *int64 `json:"autoIncrement"`
	Comment       string `json:"comment"`
}

// SchemaChangeRequest is the payload sent by the Schema Designer to
// PreviewAlter / ExecuteAlter.  The server performs the diff; the client
// merely supplies the before/after snapshots.
type SchemaChangeRequest struct {
	Schema    string         `json:"schema"`
	Table     string         `json:"table"`
	Original  TableInfoDraft `json:"originalInfo"`
	Updated   TableInfoDraft `json:"updatedInfo"`
	OldColumns []ColumnDraft `json:"oldColumns"` // as-loaded snapshot
	NewColumns []ColumnDraft `json:"newColumns"` // edited
}

// SchemaChangeStatement describes one generated ALTER statement together
// with a human-readable summary ("Add column `email`", "Drop column `bio`")
// so the Review SQL dialog can render each line with a label.
type SchemaChangeStatement struct {
	Kind    string `json:"kind"`    // add / drop / rename / modify / reorder / table
	Summary string `json:"summary"` // human-readable one-liner
	SQL     string `json:"sql"`     // the ALTER TABLE statement
}

// SchemaChangePreview is the pure-function output of [SchemaAlterDriver.PreviewAlter].
type SchemaChangePreview struct {
	Statements []SchemaChangeStatement `json:"statements"`
	// Warnings carry non-fatal hints the UI can surface above the Execute
	// button (e.g. "dropping a column is destructive").
	Warnings []string `json:"warnings"`
}

// SchemaChangeResult is the output of [SchemaAlterDriver.ExecuteAlter].
// When Success == false the caller should inspect FailedIndex /
// FailedStatement / Error to understand which statement aborted the run.
type SchemaChangeResult struct {
	Success         bool                    `json:"success"`
	ExecutedCount   int                     `json:"executedCount"`
	Statements      []SchemaChangeStatement `json:"statements"`
	FailedIndex     int                     `json:"failedIndex"`     // -1 on success
	FailedStatement string                  `json:"failedStatement"` // empty on success
	Error           string                  `json:"error"`           // empty on success
}

// SchemaAlterDriver is the optional extension implemented by drivers that
// can produce + apply ALTER TABLE diffs.
type SchemaAlterDriver interface {
	DatabaseDriver

	// PreviewAlter computes the ALTER TABLE statements needed to turn
	// req.OldColumns/OriginalInfo into req.NewColumns/UpdatedInfo.
	//
	// MUST NOT touch the database; implementations that need the server's
	// current state should do so via separate Fetch calls and pass the
	// result in the request.
	PreviewAlter(req SchemaChangeRequest) (*SchemaChangePreview, error)

	// ExecuteAlter re-runs PreviewAlter and applies every statement in
	// order.  On the first failure the method aborts and returns a
	// SchemaChangeResult with Success=false and enough context for the UI
	// to show a partial-failure notice.  MySQL DDL is auto-commit, so
	// statements already executed remain in effect.
	ExecuteAlter(ctx context.Context, req SchemaChangeRequest) (*SchemaChangeResult, error)
}

// MultiResultDriver is an optional extension for drivers that support
// returning multiple result sets from a single call (e.g. stored procedures).
type MultiResultDriver interface {
	DatabaseDriver

	// ExecuteMulti executes a query and returns an iterator over all result
	// sets produced. Callers MUST drain and close each ResultSet before
	// calling Next on the outer iterator.
	ExecuteMulti(ctx context.Context, query string) (ResultSetIterator, error)
}

// ResultSetIterator iterates over multiple result sets returned by a single
// multi-statement query or stored-procedure call.
type ResultSetIterator interface {
	// Next advances to the next result set. Returns false when all sets have
	// been consumed or on error.
	Next() bool

	// ResultSet returns the current result set.
	// Valid only after a successful call to Next.
	ResultSet() *ResultSet

	// Err returns the first error encountered. Must be checked after Next
	// returns false.
	Err() error

	// Close releases all underlying resources.
	Close() error
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel errors
// ─────────────────────────────────────────────────────────────────────────────

// Sentinel errors allow callers to use errors.Is() for structured error
// handling without importing driver-specific packages.
//
// Concrete driver errors MUST wrap these sentinels with %w so that
// errors.Is / errors.As traversal works correctly.
//
// Example (mysql driver):
//
//	return nil, fmt.Errorf("database %q not found: %w", name, driver.ErrDatabaseNotFound)
var (
	// ErrNotConnected is returned when a method is called before [Connect].
	ErrNotConnected = driverErr("driver: not connected")

	// ErrAlreadyConnected is returned when Connect is called on a live driver.
	ErrAlreadyConnected = driverErr("driver: already connected")

	// ErrDatabaseNotFound is returned when [FetchTables] is called with a
	// database name that does not exist or is not accessible.
	ErrDatabaseNotFound = driverErr("driver: database not found")

	// ErrTableNotFound is returned when [FetchTableDetail] is called with a
	// table name that does not exist in the specified database.
	ErrTableNotFound = driverErr("driver: table not found")

	// ErrQueryCancelled is returned when the context passed to [ExecuteQuery]
	// (or any other method) is cancelled before the server responds.
	ErrQueryCancelled = driverErr("driver: query cancelled")

	// ErrUnsupported is returned when the driver does not support a particular
	// operation (e.g. DDL generation on MongoDB).
	ErrUnsupported = driverErr("driver: operation not supported by this driver")
)

// driverErr is an unexported string-based error type so that each sentinel
// has a distinct identity even if they share the same message text.
type driverErr string

func (e driverErr) Error() string { return string(e) }

// ─────────────────────────────────────────────────────────────────────────────
// Factory registry (wiring point, not an implementation)
// ─────────────────────────────────────────────────────────────────────────────

// Factory is a function that constructs a [DatabaseDriver] from a config.
// Concrete driver packages register themselves via [Register] in their init()
// functions so that the service layer can remain import-free of specific drivers.
//
// The factory MUST NOT open a network connection; it only validates the config
// and allocates the driver struct. [DatabaseDriver.Connect] opens connections.
type Factory func(cfg ConnectionConfig) (DatabaseDriver, error)

// registry maps [DriverKind] to its [Factory]. Protected by init-time
// registration; no mutex needed (written once before any goroutines start).
var registry = map[DriverKind]Factory{}

// Register associates a [Factory] with a [DriverKind].
// Intended to be called from driver package init() functions.
// Panics on duplicate registration to surface wiring mistakes at startup.
func Register(kind DriverKind, f Factory) {
	if _, exists := registry[kind]; exists {
		panic("driver: duplicate registration for kind " + string(kind))
	}
	registry[kind] = f
}

// New instantiates the driver registered for cfg.Kind.
// Returns an error if no driver has been registered for that kind.
func New(cfg ConnectionConfig) (DatabaseDriver, error) {
	f, ok := registry[cfg.Kind]
	if !ok {
		return nil, driverErr("driver: no driver registered for kind " + string(cfg.Kind))
	}
	return f(cfg)
}
