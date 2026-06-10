/**
 * bridge.js — thin wrapper around the Wails IPC layer.
 *
 * In the Wails desktop runtime (wails dev / wails build) window.go is injected
 * by the webview. In a plain browser dev-server session (npm run dev) it is
 * absent, so every function falls back to realistic mock data so the UI can
 * be developed and tested without a running database.
 */

const isWails = () => typeof window !== 'undefined' && !!window?.go?.main?.App

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers — browser dev-server only
// ─────────────────────────────────────────────────────────────────────────────

/** Simulated network delay */
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Generates a mock QueryResult for browser development.
 * Produces realistic column names derived from the SQL text.
 */
function mockQueryResult(sql) {
  const cols = [
    { name: 'id',         type: 'INT',          nullable: false },
    { name: 'username',   type: 'VARCHAR(64)',   nullable: false },
    { name: 'email',      type: 'VARCHAR(255)',  nullable: true  },
    { name: 'status',     type: 'ENUM',          nullable: false },
    { name: 'score',      type: 'DECIMAL(10,2)', nullable: true  },
    { name: 'created_at', type: 'DATETIME',      nullable: false },
  ]
  const statuses = ['active', 'inactive', 'banned']
  const rows = Array.from({ length: 600 }, (_, i) => [
    i + 1,
    `user_${i + 1}`,
    i % 7 === 0 ? null : `user${i + 1}@example.com`,
    statuses[i % 3],
    i % 5 === 0 ? null : (Math.random() * 1000).toFixed(2),
    `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')} 09:00:00`,
  ])
  return {
    columns: cols,
    rows,
    rowCount: rows.length,
    truncated: false,
    rowsAffected: 0,
    execMs: Math.floor(Math.random() * 80) + 5,
    error: '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — same shape whether using Wails IPC or mocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RunQuery — execute SQL on a named connection.
 *
 * @param {string} connectionID
 * @param {string} dbName  active schema; backend runs USE `db` first on the
 *   same dedicated connection so the database context is always consistent,
 *   even with a connection pool.  Pass '' to skip.
 * @param {string} sql
 */
export async function runQuery(connectionID, dbName, sql, queryID = '') {
  if (isWails()) {
    const { RunQueryWithID } = await import('../../wailsjs/go/main/App.js')
    return RunQueryWithID(queryID, connectionID, dbName ?? '', sql)
  }
  // Browser dev mock
  await delay(150 + Math.random() * 200)
  return mockQueryResult(sql)
}

export async function runQueryPage(connectionID, dbName, sql, offset = 0, limit = 100, queryID = '') {
  if (isWails()) {
    const { RunQueryPageWithID } = await import('../../wailsjs/go/main/App.js')
    return RunQueryPageWithID(queryID, connectionID, dbName ?? '', sql, offset, limit)
  }
  await delay(120 + Math.random() * 120)
  const mock = mockQueryResult(sql)
  const rows = mock.rows.slice(offset, offset + limit)
  return {
    ...mock,
    rows,
    rowCount: rows.length,
    truncated: offset + rows.length < mock.rows.length,
  }
}

// ─── Data tab WHERE filter history (persisted in griplite.db) ─────────────
const FILTER_HISTORY_LS = 'griplite_data_filter_history_v1'

function filterHistoryKey(connId, dbName, tableName) {
  return `${String(connId)}\0${String(dbName)}\0${String(tableName)}`
}

function readMockFilterHistory() {
  try {
    return JSON.parse(localStorage.getItem(FILTER_HISTORY_LS) || '{}') || {}
  } catch { return {} }
}

function writeMockFilterHistory(m) {
  try { localStorage.setItem(FILTER_HISTORY_LS, JSON.stringify(m)) } catch { /* ignore */ }
}

/**
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 * @returns {Promise<string[]>} newest-first WHERE clause snippets
 */
export async function getDataFilterHistory(connectionID, dbName, tableName) {
  if (isWails()) {
    const { GetDataFilterHistory } = await import('../../wailsjs/go/main/App.js')
    return GetDataFilterHistory(connectionID, dbName, tableName)
  }
  await delay(0)
  const m = readMockFilterHistory()
  return m[filterHistoryKey(connectionID, dbName, tableName)] ?? []
}

/**
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 * @param {string[]} entries max 20, newest first
 */
export async function setDataFilterHistory(connectionID, dbName, tableName, entries) {
  if (isWails()) {
    const { SetDataFilterHistory } = await import('../../wailsjs/go/main/App.js')
    return SetDataFilterHistory(connectionID, dbName, tableName, entries)
  }
  await delay(0)
  const m = readMockFilterHistory()
  const k = filterHistoryKey(connectionID, dbName, tableName)
  if (!entries || entries.length === 0) delete m[k]
  else m[k] = entries
  writeMockFilterHistory(m)
}

// ─── Table open-frequency (persisted in griplite.db; survives reinstall) ──
const TABLE_USAGE_LS = 'griplite_table_usage_v1'

function readMockTableUsage() {
  try {
    return JSON.parse(localStorage.getItem(TABLE_USAGE_LS) || '{}') || {}
  } catch { return {} }
}

function writeMockTableUsage(m) {
  try { localStorage.setItem(TABLE_USAGE_LS, JSON.stringify(m)) } catch { /* ignore */ }
}

/**
 * getTableUsage — load the open-frequency map used to sort the Explorer tree.
 * In the Wails runtime this reads griplite.db (durable across reinstalls); in
 * browser dev it falls back to localStorage.
 *
 * @returns {Promise<Object<string,{count:number,lastUsedAt:number}>>}
 *   keyed by `${connId}::${dbName}::${tableName}`
 */
export async function getTableUsage() {
  if (isWails()) {
    const { GetTableUsage } = await import('../../wailsjs/go/main/App.js')
    const rows = (await GetTableUsage()) ?? []
    const map = {}
    for (const r of rows) {
      map[`${r.connId}::${r.dbName}::${r.tableName}`] = { count: r.count, lastUsedAt: r.lastUsedAt }
    }
    return map
  }
  await delay(0)
  return readMockTableUsage()
}

/**
 * recordTableUsage — register one "open" of a table. Persists to griplite.db in
 * the Wails runtime; mirrors into localStorage in browser dev. Fire-and-forget.
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 */
export async function recordTableUsage(connectionID, dbName, tableName) {
  if (!tableName) return
  if (isWails()) {
    const { RecordTableUsage } = await import('../../wailsjs/go/main/App.js')
    return RecordTableUsage(connectionID, dbName ?? '', tableName)
  }
  await delay(0)
  const m = readMockTableUsage()
  const key = `${connectionID}::${dbName ?? ''}::${tableName}`
  const prev = m[key]
  m[key] = { count: (prev?.count ?? 0) + 1, lastUsedAt: Date.now() }
  writeMockTableUsage(m)
}

/**
 * AddConnection — open and register a new database connection.
 *
 * @param {object} cfg  ConnectionConfig fields
 * @returns {Promise<string>}  the connection ID
 */
export async function addConnection(cfg) {
  if (isWails()) {
    const { AddConnection } = await import('../../wailsjs/go/main/App.js')
    return AddConnection(cfg)
  }
  await delay(400)
  return cfg.id ?? 'mock-conn'
}

/**
 * ListConnections — returns all registered connections.
 *
 * @returns {Promise<Array>}
 */
export async function listConnections() {
  if (isWails()) {
    const { ListConnections } = await import('../../wailsjs/go/main/App.js')
    return ListConnections()
  }
  await delay(50)
  return [
    {
      id: 'mock-conn',
      name: 'localhost (mock)',
      kind: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'db1',
      serverVersion: '8.0.35 (mock)',
      connected: true,
    },
    {
      id: 'mock-mongo-1',
      name: 'MongoDB Atlas (mock)',
      kind: 'mongodb',
      host: 'cluster.example.mongodb.net',
      port: 27017,
      database: 'admin',
      serverVersion: '7.0.0 (mock)',
      connected: true,
    },
    {
      id: 'mock-redis-1',
      name: 'Redis (mock)',
      kind: 'redis',
      host: '127.0.0.1',
      port: 6379,
      database: '0',
      serverVersion: '7.2.4 (mock)',
      connected: true,
    },
  ]
}

/**
 * FetchDatabases — returns database names for a connection.
 *
 * @param {string} connectionID
 * @returns {Promise<string[]>}
 */
export async function fetchDatabases(connectionID) {
  if (isWails()) {
    const { FetchDatabases } = await import('../../wailsjs/go/main/App.js')
    return FetchDatabases(connectionID)
  }
  await delay(80)
  if (String(connectionID).includes('mongo')) {
    return ['admin', 'sample_mflix', 'prm']
  }
  return ['db1', 'analytics', 'logs']
}

// ─── Mock schema for browser dev autocomplete ─────────────────────────────
const MOCK_SCHEMA = [
  { kind: 'table',  label: 'users',    detail: 'db1',               dbName: 'db1', tableName: '',       isPrimaryKey: false },
  { kind: 'table',  label: 'orders',   detail: 'db1',               dbName: 'db1', tableName: '',       isPrimaryKey: false },
  { kind: 'table',  label: 'products', detail: 'db1',               dbName: 'db1', tableName: '',       isPrimaryKey: false },
  { kind: 'column', label: 'id',       detail: 'INT (PK)',          dbName: 'db1', tableName: 'users',  isPrimaryKey: true  },
  { kind: 'column', label: 'username', detail: 'VARCHAR(64)',        dbName: 'db1', tableName: 'users',  isPrimaryKey: false },
  { kind: 'column', label: 'email',    detail: 'VARCHAR(255)',       dbName: 'db1', tableName: 'users',  isPrimaryKey: false },
  { kind: 'column', label: 'status',   detail: 'ENUM',              dbName: 'db1', tableName: 'users',  isPrimaryKey: false },
  { kind: 'column', label: 'id',       detail: 'INT (PK)',          dbName: 'db1', tableName: 'orders', isPrimaryKey: true  },
  { kind: 'column', label: 'user_id',  detail: 'INT',               dbName: 'db1', tableName: 'orders', isPrimaryKey: false },
  { kind: 'column', label: 'total',    detail: 'DECIMAL(10,2)',     dbName: 'db1', tableName: 'orders', isPrimaryKey: false },
  { kind: 'column', label: 'id',       detail: 'INT (PK)',          dbName: 'db1', tableName: 'products', isPrimaryKey: true },
  { kind: 'column', label: 'name',     detail: 'VARCHAR(128)',      dbName: 'db1', tableName: 'products', isPrimaryKey: false },
  { kind: 'column', label: 'price',    detail: 'DECIMAL(10,2)',     dbName: 'db1', tableName: 'products', isPrimaryKey: false },
  { kind: 'column', label: 'created_at', detail: 'DATETIME',       dbName: 'db1', tableName: 'users',  isPrimaryKey: false },
]

/**
 * FetchTables — returns table metadata for a database.
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @returns {Promise<Array<{name:string, schema:string, kind:string, rowCount:number, sizeMB:number}>>}
 */
export async function fetchTables(connectionID, dbName) {
  if (isWails()) {
    const { FetchTables } = await import('../../wailsjs/go/main/App.js')
    return FetchTables(connectionID, dbName)
  }
  await delay(80)
  if (String(connectionID).includes('mongo')) {
    const mockCollections = {
      admin: [
        { name: 'system.version', kind: 'collection', rowCount: -1, sizeBytes: -1, comment: 'MongoDB system metadata' },
      ],
      sample_mflix: [
        { name: 'movies', kind: 'collection', rowCount: 23541, sizeBytes: 134_217_728, comment: 'Movie documents' },
        { name: 'comments', kind: 'collection', rowCount: 50304, sizeBytes: 268_435_456, comment: 'User comments' },
      ],
      prm: [
        { name: 'prm_order', kind: 'collection', rowCount: 120000, sizeBytes: 536_870_912, comment: 'Order documents' },
        { name: 'prm_order_error', kind: 'collection', rowCount: 4200, sizeBytes: 67_108_864, comment: 'Order error documents' },
      ],
    }
    const fallback = [{ name: 'sample_collection', kind: 'collection', rowCount: -1, sizeBytes: -1, comment: '' }]
    return (mockCollections[dbName] ?? fallback).map((t) => ({ ...t, schema: dbName }))
  }
  // Mock data includes realistic sizeBytes values so the tree UI can be
  // developed and verified without a live database connection.
  const mockTables = {
    db1: [
      { name: 'users',      kind: 'view',  rowCount:  1024, sizeBytes:   131_072, comment: 'Application user accounts'      }, //  128 K
      { name: 'orders',     kind: 'table', rowCount:  8842, sizeBytes: 1_572_864, comment: 'Customer purchase orders'       }, //  1.5 M
      { name: 'products',   kind: 'table', rowCount:   512, sizeBytes:    65_536, comment: ''                               }, //   64 K
      { name: 'categories', kind: 'table', rowCount:    48, sizeBytes:    16_384, comment: 'Product taxonomy'               }, //   16 K
      { name: 'reviews',    kind: 'table', rowCount: 24500, sizeBytes: 8_388_608, comment: 'User-submitted product reviews' }, //    8 M
    ],
    analytics: [
      { name: 'events',   kind: 'table', rowCount: 1_200_000, sizeBytes: 536_870_912, comment: 'Raw event stream'                   }, // 512 M
      { name: 'sessions', kind: 'table', rowCount:   350_000, sizeBytes: 104_857_600, comment: 'Derived user sessions'              }, // 100 M
      { name: 'funnels',  kind: 'table', rowCount:       220, sizeBytes:      32_768, comment: 'Precomputed conversion funnels'     }, //  32 K
    ],
    logs: [
      { name: 'app_logs',    kind: 'table', rowCount: 5_000_000, sizeBytes: 2_147_483_648, comment: 'Structured application logs' }, // 2 G
      { name: 'error_logs',  kind: 'table', rowCount:    42_000, sizeBytes:    67_108_864, comment: 'Captured unhandled errors'   }, // 64 M
      { name: 'audit_trail', kind: 'table', rowCount:   180_000, sizeBytes:   268_435_456, comment: 'Security audit events'       }, // 256 M
    ],
  }
  const fallback = [{ name: 'sample_table', kind: 'table', rowCount: 0, sizeBytes: -1, comment: '' }]
  return (mockTables[dbName] ?? fallback).map((t) => ({ ...t, schema: dbName }))
}

// ─── Mock schema-metadata for browser dev GetTableSchema ─────────────────
// Phase 15: each table carries a `comment` string (TABLE_COMMENT) and each
// column an optional `comment` (COLUMN_COMMENT).  Empty strings are fine —
// the UI coerces null/undefined to '' defensively.
const MOCK_TABLE_SCHEMAS = {
  users: {
    found: true, kind: 'table', rowCount: 1024, syncedAt: '2025-01-01T00:00:00Z',
    comment: 'Application user accounts and authentication data',
    columns: [
      { ordinal: 1, name: 'id',            type: 'int(11)',     nullable: false, isPrimaryKey: true,  comment: 'Primary key' },
      { ordinal: 2, name: 'username',       type: 'varchar(64)', nullable: false, isPrimaryKey: false, comment: 'Unique login username' },
      { ordinal: 3, name: 'email',          type: 'varchar(255)', nullable: false, isPrimaryKey: false, comment: 'Email address' },
      { ordinal: 4, name: 'password_hash',  type: 'varchar(255)', nullable: false, isPrimaryKey: false, comment: 'Bcrypt password hash' },
      { ordinal: 5, name: 'status',         type: "enum('active','inactive','banned')", nullable: false, isPrimaryKey: false, comment: 'Account status' },
      { ordinal: 6, name: 'score',          type: 'decimal(10,2)', nullable: true, isPrimaryKey: false, comment: 'User reputation score' },
      { ordinal: 7, name: 'created_at',     type: 'datetime', nullable: false, isPrimaryKey: false, comment: 'Account creation time' },
      { ordinal: 8, name: 'updated_at',     type: 'datetime', nullable: false, isPrimaryKey: false, comment: '' },
    ],
  },
  orders: {
    found: true, kind: 'table', rowCount: 8842, syncedAt: '2025-01-01T00:00:00Z',
    comment: 'Customer purchase orders',
    columns: [
      { ordinal: 1, name: 'id',         type: 'int(11)',       nullable: false, isPrimaryKey: true,  comment: 'Order ID' },
      { ordinal: 2, name: 'user_id',    type: 'int(11)',       nullable: false, isPrimaryKey: false, comment: 'FK → users.id' },
      { ordinal: 3, name: 'total',      type: 'decimal(12,2)', nullable: false, isPrimaryKey: false, comment: 'Order total' },
      { ordinal: 4, name: 'status',     type: "enum('pending','paid','shipped','cancelled')", nullable: false, isPrimaryKey: false, comment: '' },
      { ordinal: 5, name: 'created_at', type: 'datetime',      nullable: false, isPrimaryKey: false, comment: '' },
    ],
  },
  products: {
    found: true, kind: 'table', rowCount: 512, syncedAt: '2025-01-01T00:00:00Z',
    comment: '',
    columns: [
      { ordinal: 1, name: 'id',          type: 'int(11)',       nullable: false, isPrimaryKey: true,  comment: '' },
      { ordinal: 2, name: 'name',         type: 'varchar(128)', nullable: false, isPrimaryKey: false, comment: '' },
      { ordinal: 3, name: 'price',        type: 'decimal(10,2)', nullable: false, isPrimaryKey: false, comment: '' },
      { ordinal: 4, name: 'stock',        type: 'int(11)',       nullable: false, isPrimaryKey: false, comment: '' },
      { ordinal: 5, name: 'description',  type: 'text',          nullable: true,  isPrimaryKey: false, comment: '' },
    ],
  },
}

/**
 * GetTableSchema — reads table + column metadata from the local SQLite cache.
 *
 * Never hits the live database; typical latency < 1 ms in production.
 * Falls back to mock data in the browser dev-server.
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 * @returns {Promise<{found:boolean, columns:Array, kind:string, rowCount:number, syncedAt:string}>}
 */
export async function getTableSchema(connectionID, dbName, tableName) {
  if (isWails()) {
    const { GetTableSchema } = await import('../../wailsjs/go/main/App.js')
    return GetTableSchema(connectionID, dbName, tableName)
  }
  // Browser dev: no delay — simulating SQLite sub-ms read
  const mock = MOCK_TABLE_SCHEMAS[tableName]
  if (mock) {
    return { ...mock, connId: connectionID, dbName, tableName }
  }
  return { found: false, connId: connectionID, dbName, tableName, columns: [], kind: '', rowCount: -1, syncedAt: '' }
}

export async function refreshTableMetadata(connectionID, dbName, tableName) {
  if (isWails()) {
    const { RefreshTableMetadata } = await import('../../wailsjs/go/main/App.js')
    return RefreshTableMetadata(connectionID, dbName, tableName)
  }
}

/**
 * getTableAdvancedProperties — Phase 19 advanced Properties tab data.
 *
 * Unlike getTableSchema (which reads from the SQLite mirror), this call goes
 * straight to the live database so results reflect the authoritative server
 * state — DDL, indexes, constraints, foreign keys, references, triggers.
 *
 * Returns the fully-hydrated payload on success, or throws (rejects) if the
 * connection is unknown or the live query fails.  The caller is expected to
 * lazy-invoke this only when the user switches to a section that needs it,
 * so the one-round-trip cost stays out of the Properties tab's critical path.
 *
 * Shape:
 *   {
 *     schema, table,
 *     ddl: string,
 *     indexes:     [{ name, type, unique, columns: string[], comment }],
 *     constraints: [{ name, type, columns: string[], expression }],
 *     partitions:  [{ name, method, expression, description, rows }],
 *     foreignKeys: [{ name, columns, refSchema, refTable, refColumns, onDelete, onUpdate }],
 *     references:  [{ name, fromSchema, fromTable, fromCols, toCols, onDelete, onUpdate }],
 *     triggers:    [{ name, event, timing, statement }],
 *   }
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 */
export async function getTableAdvancedProperties(connectionID, dbName, tableName) {
  if (isWails()) {
    const { GetTableAdvancedProperties } = await import('../../wailsjs/go/main/App.js')
    return GetTableAdvancedProperties(connectionID, dbName, tableName)
  }
  // Browser dev mock — keeps the UI demoable without a live backend.
  return buildMockAdvancedProps(dbName, tableName)
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock data for browser dev mode.
// Only covers the two example tables we ship in MOCK_TABLE_SCHEMAS so a full
// "offline walkthrough" still lights up every Properties sub-tab.
// ─────────────────────────────────────────────────────────────────────────────
function buildMockAdvancedProps(dbName, tableName) {
  const base = {
    schema: dbName || 'db1',
    table:  tableName,
    ddl:    `-- DDL not available in browser dev mode\nCREATE TABLE \`${tableName}\` (/* run inside Wails to see live DDL */);`,
    indexes:     [],
    constraints: [],
    partitions:  [],
    foreignKeys: [],
    references:  [],
    triggers:    [],
  }
  if (tableName === 'users') {
    base.ddl = `CREATE TABLE \`users\` (\n  \`id\` int(11) NOT NULL AUTO_INCREMENT,\n  \`username\` varchar(64) NOT NULL,\n  \`email\` varchar(255) NOT NULL,\n  PRIMARY KEY (\`id\`),\n  UNIQUE KEY \`idx_username\` (\`username\`),\n  UNIQUE KEY \`idx_email\` (\`email\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    base.indexes = [
      { name: 'PRIMARY',      type: 'BTREE', unique: true,  columns: ['id'],       comment: '' },
      { name: 'idx_username', type: 'BTREE', unique: true,  columns: ['username'], comment: '' },
      { name: 'idx_email',    type: 'BTREE', unique: true,  columns: ['email'],    comment: '' },
    ]
    base.constraints = [
      { name: 'PRIMARY',     type: 'PRIMARY KEY', columns: ['id'],       expression: '' },
      { name: 'idx_username', type: 'UNIQUE',     columns: ['username'], expression: '' },
      { name: 'idx_email',    type: 'UNIQUE',     columns: ['email'],    expression: '' },
      { name: 'chk_status',   type: 'CHECK',      columns: [],           expression: "`status` in ('active','inactive','banned')" },
    ]
    base.references = [
      { name: 'fk_orders_user', fromSchema: dbName || 'db1', fromTable: 'orders',
        fromCols: ['user_id'], toCols: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ]
  } else if (tableName === 'orders') {
    base.ddl = `CREATE TABLE \`orders\` (\n  \`id\` int(11) NOT NULL AUTO_INCREMENT,\n  \`user_id\` int(11) NOT NULL,\n  \`total\` decimal(12,2) NOT NULL DEFAULT 0.00,\n  PRIMARY KEY (\`id\`),\n  KEY \`idx_user_id\` (\`user_id\`),\n  CONSTRAINT \`fk_orders_user\` FOREIGN KEY (\`user_id\`)\n    REFERENCES \`users\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
    base.indexes = [
      { name: 'PRIMARY',     type: 'BTREE', unique: true,  columns: ['id'],      comment: '' },
      { name: 'idx_user_id', type: 'BTREE', unique: false, columns: ['user_id'], comment: '' },
    ]
    base.constraints = [
      { name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'], expression: '' },
    ]
    base.partitions = [
      { name: 'p_2024', method: 'RANGE', expression: 'TO_DAYS(created_at)', description: '739617', rows: 12000 },
      { name: 'p_max',  method: 'RANGE', expression: 'TO_DAYS(created_at)', description: 'MAXVALUE', rows: 3400 },
    ]
    base.foreignKeys = [
      { name: 'fk_orders_user', columns: ['user_id'], refSchema: dbName || 'db1',
        refTable: 'users', refColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
    ]
    base.triggers = [
      { name: 'trg_orders_audit', event: 'INSERT', timing: 'AFTER',
        statement: "INSERT INTO audit_log(action, tbl) VALUES ('INSERT', 'orders')" },
    ]
  }
  return base
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 20 — Schema Designer (ALTER TABLE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * previewTableAlter — ask the backend to compute the ALTER TABLE diff
 * between two column/table-info snapshots.  Returns the generated SQL
 * statements so the UI can show a Review dialog *before* anything runs.
 *
 * @param {string} connectionID
 * @param {{
 *   schema: string,
 *   table: string,
 *   originalInfo: { engine:string, collation:string, comment:string },
 *   updatedInfo:  { engine:string, collation:string, comment:string },
 *   oldColumns: Array<Object>,
 *   newColumns: Array<Object>,
 * }} req
 */
export async function previewTableAlter(connectionID, req) {
  if (isWails()) {
    const { PreviewTableAlter } = await import('../../wailsjs/go/main/App.js')
    return PreviewTableAlter(connectionID, req)
  }
  return buildMockAlterPreview(req)
}

/**
 * executeTableAlter — re-runs the diff server-side (so the frontend cannot
 * smuggle arbitrary DDL) and applies the statements in order.  The backend
 * aborts on the first failure; the result carries ExecutedCount,
 * FailedIndex, FailedStatement, and Error when Success is false.
 */
export async function executeTableAlter(connectionID, req) {
  if (isWails()) {
    const { ExecuteTableAlter } = await import('../../wailsjs/go/main/App.js')
    return ExecuteTableAlter(connectionID, req)
  }
  // Browser dev mock — pretend every statement succeeded so the UI flow
  // can be walked through end-to-end without a live backend.
  const pv = await buildMockAlterPreview(req)
  return {
    success: true,
    executedCount: pv.statements.length,
    statements: pv.statements,
    failedIndex: -1,
    failedStatement: '',
    error: '',
  }
}

export async function previewIndexAlter(connectionID, req) {
  if (isWails()) {
    const { PreviewIndexAlter } = await import('../../wailsjs/go/main/App.js')
    return PreviewIndexAlter(connectionID, req)
  }
  return buildMockIndexPreview(req)
}

export async function executeIndexAlter(connectionID, req) {
  if (isWails()) {
    const { ExecuteIndexAlter } = await import('../../wailsjs/go/main/App.js')
    return ExecuteIndexAlter(connectionID, req)
  }
  const pv = await buildMockIndexPreview(req)
  return {
    success: true,
    executedCount: pv.statements.length,
    statements: pv.statements,
    failedIndex: -1,
    failedStatement: '',
    error: '',
  }
}

export async function previewConstraintAlter(connectionID, req) {
  if (isWails()) {
    const { PreviewConstraintAlter } = await import('../../wailsjs/go/main/App.js')
    return PreviewConstraintAlter(connectionID, req)
  }
  return buildMockConstraintPreview(req)
}

export async function executeConstraintAlter(connectionID, req) {
  if (isWails()) {
    const { ExecuteConstraintAlter } = await import('../../wailsjs/go/main/App.js')
    return ExecuteConstraintAlter(connectionID, req)
  }
  const pv = await buildMockConstraintPreview(req)
  return {
    success: true,
    executedCount: pv.statements.length,
    statements: pv.statements,
    failedIndex: -1,
    failedStatement: '',
    error: '',
  }
}

export async function previewPartitionAlter(connectionID, req) {
  if (isWails()) {
    const { PreviewPartitionAlter } = await import('../../wailsjs/go/main/App.js')
    return PreviewPartitionAlter(connectionID, req)
  }
  return buildMockPartitionPreview(req)
}

export async function executePartitionAlter(connectionID, req) {
  if (isWails()) {
    const { ExecutePartitionAlter } = await import('../../wailsjs/go/main/App.js')
    return ExecutePartitionAlter(connectionID, req)
  }
  const pv = await buildMockPartitionPreview(req)
  return {
    success: true,
    executedCount: pv.statements.length,
    statements: pv.statements,
    failedIndex: -1,
    failedStatement: '',
    error: '',
  }
}

function buildMockAlterPreview(req) {
  const stmts = []
  const warnings = []
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`'
  const q = `${ident(req.schema)}.${ident(req.table)}`
  const oldByOrig = new Map((req.oldColumns ?? []).map((c) => [c.originalName, c]))
  const newByOrig = new Map((req.newColumns ?? []).filter((c) => c.originalName).map((c) => [c.originalName, c]))

  for (const oc of req.oldColumns ?? []) {
    if (!newByOrig.has(oc.originalName)) {
      stmts.push({ kind: 'drop', summary: `Drop column \`${oc.originalName}\``,
        sql: `ALTER TABLE ${q} DROP COLUMN ${ident(oc.originalName)};` })
      warnings.push(`Dropping column \`${oc.originalName}\` is destructive.`)
    }
  }
  for (const nc of req.newColumns ?? []) {
    if (!nc.originalName) continue
    const oc = oldByOrig.get(nc.originalName)
    if (!oc) continue
    const changed =
      oc.name !== nc.name ||
      (oc.type || '').toLowerCase() !== (nc.type || '').toLowerCase() ||
      oc.notNull !== nc.notNull ||
      oc.comment !== nc.comment
    if (changed) {
      const spec = `${nc.type} ${nc.notNull ? 'NOT NULL' : 'NULL'}${nc.comment ? ` COMMENT '${nc.comment.replace(/'/g, "''")}'` : ''}`
      if (nc.originalName !== nc.name) {
        stmts.push({ kind: 'rename', summary: `Rename/redefine \`${nc.originalName}\` → \`${nc.name}\``,
          sql: `ALTER TABLE ${q} CHANGE COLUMN ${ident(nc.originalName)} ${ident(nc.name)} ${spec};` })
      } else {
        stmts.push({ kind: 'modify', summary: `Modify column \`${nc.name}\``,
          sql: `ALTER TABLE ${q} MODIFY COLUMN ${ident(nc.name)} ${spec};` })
      }
    }
  }
  for (let i = 0; i < (req.newColumns ?? []).length; i++) {
    const nc = req.newColumns[i]
    if (nc.originalName) continue
    const spec = `${nc.type} ${nc.notNull ? 'NOT NULL' : 'NULL'}${nc.comment ? ` COMMENT '${nc.comment.replace(/'/g, "''")}'` : ''}`
    const pos = i === 0 ? ' FIRST' : ` AFTER ${ident(req.newColumns[i - 1].name || req.newColumns[i - 1].originalName)}`
    stmts.push({ kind: 'add', summary: `Add column \`${nc.name}\` ${nc.type}`,
      sql: `ALTER TABLE ${q} ADD COLUMN ${ident(nc.name)} ${spec}${pos};` })
  }
  if (req.originalInfo && req.updatedInfo &&
      (req.originalInfo.engine !== req.updatedInfo.engine ||
       req.originalInfo.collation !== req.updatedInfo.collation ||
       req.originalInfo.comment !== req.updatedInfo.comment)) {
    const parts = []
    if (req.updatedInfo.engine && req.originalInfo.engine !== req.updatedInfo.engine)
      parts.push(`ENGINE = ${req.updatedInfo.engine}`)
    if (req.updatedInfo.collation && req.originalInfo.collation !== req.updatedInfo.collation)
      parts.push(`COLLATE = ${req.updatedInfo.collation}`)
    if (req.originalInfo.comment !== req.updatedInfo.comment)
      parts.push(`COMMENT = '${(req.updatedInfo.comment || '').replace(/'/g, "''")}'`)
    stmts.push({ kind: 'table', summary: 'Update table options',
      sql: `ALTER TABLE ${q} ${parts.join(', ')};` })
  }
  return { statements: stmts, warnings }
}

function buildMockIndexPreview(req) {
  const stmts = []
  const warnings = []
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`'
  const q = `${ident(req.schema)}.${ident(req.table)}`
  const norm = (idx) => ({
    ...idx,
    originalName: (idx.originalName ?? '').trim(),
    name: (idx.name ?? '').trim(),
    type: (idx.type ?? 'BTREE').trim().toUpperCase() || 'BTREE',
    columns: (idx.columns ?? []).map((c) => String(c).trim()).filter(Boolean),
    comment: (idx.comment ?? '').trim(),
  })
  const oldByOrig = new Map((req.oldIndexes ?? [])
    .map(norm)
    .filter((idx) => idx.name.toUpperCase() !== 'PRIMARY')
    .map((idx) => [idx.originalName || idx.name, idx]))
  const newByOrig = new Map((req.newIndexes ?? [])
    .map(norm)
    .filter((idx) => idx.originalName && idx.originalName.toUpperCase() !== 'PRIMARY' && idx.name.toUpperCase() !== 'PRIMARY')
    .map((idx) => [idx.originalName, idx]))
  const eq = (a, b) =>
    a.name === b.name && a.type === b.type && !!a.unique === !!b.unique &&
    a.comment === b.comment && a.columns.join('\0') === b.columns.join('\0')
  const drop = (name) => ({ kind: 'drop', summary: `Drop index \`${name}\``, sql: `DROP INDEX ${ident(name)} ON ${q};` })
  const create = (idx) => {
    const prefix = idx.type === 'FULLTEXT' ? 'FULLTEXT INDEX'
      : idx.type === 'SPATIAL' ? 'SPATIAL INDEX'
      : idx.unique ? 'UNIQUE INDEX'
      : 'INDEX'
    const using = idx.type === 'BTREE' || idx.type === 'HASH' ? ` USING ${idx.type}` : ''
    const comment = idx.comment ? ` COMMENT '${idx.comment.replace(/'/g, "''")}'` : ''
    return {
      kind: 'add',
      summary: `Create index \`${idx.name}\``,
      sql: `CREATE ${prefix} ${ident(idx.name)} ON ${q} (${idx.columns.map(ident).join(', ')})${using}${comment};`,
    }
  }

  for (const oldIdx of (req.oldIndexes ?? []).map(norm)) {
    const orig = oldIdx.originalName || oldIdx.name
    if (orig.toUpperCase() === 'PRIMARY') continue
    const next = newByOrig.get(orig)
    if (!next) {
      stmts.push(drop(orig))
      warnings.push(`Dropping index \`${orig}\` can affect query performance.`)
    } else if (!eq(oldIdx, next)) {
      stmts.push(drop(orig))
      warnings.push(`Modifying index \`${orig}\` requires dropping and recreating it.`)
    }
  }
  for (const newIdx of (req.newIndexes ?? []).map(norm)) {
    if (newIdx.name.toUpperCase() === 'PRIMARY' || newIdx.originalName.toUpperCase() === 'PRIMARY') continue
    if (!newIdx.originalName) {
      stmts.push(create(newIdx))
    } else {
      const oldIdx = oldByOrig.get(newIdx.originalName)
      if (oldIdx && !eq(oldIdx, newIdx)) stmts.push(create(newIdx))
    }
  }
  return { statements: stmts, warnings }
}

function buildMockConstraintPreview(req) {
  const stmts = []
  const warnings = []
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`'
  const q = `${ident(req.schema)}.${ident(req.table)}`
  const norm = (c) => ({
    ...c,
    originalName: (c.originalName ?? '').trim(),
    name: (c.name ?? '').trim(),
    type: (c.type ?? '').trim().toUpperCase(),
    columns: (c.columns ?? []).map((col) => String(col).trim()).filter(Boolean),
    expression: (c.expression ?? '').trim(),
  })
  const editable = (c) => c.type === 'UNIQUE' || c.type === 'CHECK'
  const eq = (a, b) => a.name === b.name && a.type === b.type &&
    a.expression === b.expression && a.columns.join('\0') === b.columns.join('\0')
  const drop = (c, name = c.originalName || c.name) => ({
    kind: 'drop',
    summary: `Drop ${c.type.toLowerCase()} constraint \`${name}\``,
    sql: `ALTER TABLE ${q} ${c.type === 'UNIQUE' ? 'DROP INDEX' : 'DROP CHECK'} ${ident(name)};`,
  })
  const add = (c) => ({
    kind: 'add',
    summary: `Add ${c.type.toLowerCase()} constraint \`${c.name}\``,
    sql: c.type === 'UNIQUE'
      ? `ALTER TABLE ${q} ADD CONSTRAINT ${ident(c.name)} UNIQUE (${c.columns.map(ident).join(', ')});`
      : `ALTER TABLE ${q} ADD CONSTRAINT ${ident(c.name)} CHECK (${c.expression});`,
  })
  const newByOrig = new Map((req.newConstraints ?? []).map(norm).filter((c) => editable(c) && c.originalName).map((c) => [c.originalName, c]))
  for (const oldC of (req.oldConstraints ?? []).map(norm).filter(editable)) {
    const orig = oldC.originalName || oldC.name
    const next = newByOrig.get(orig)
    if (!next) {
      stmts.push(drop(oldC, orig))
      warnings.push(`Dropping constraint \`${orig}\` changes validation rules.`)
    } else if (!eq(oldC, next)) {
      stmts.push(drop(oldC, orig), add(next))
      warnings.push(`Modifying constraint \`${orig}\` requires dropping and recreating it.`)
    }
  }
  for (const newC of (req.newConstraints ?? []).map(norm).filter(editable)) {
    if (!newC.originalName) stmts.push(add(newC))
  }
  return { statements: stmts, warnings }
}

function buildMockPartitionPreview(req) {
  const stmts = []
  const warnings = []
  const ident = (s) => '`' + String(s).replace(/`/g, '``') + '`'
  const q = `${ident(req.schema)}.${ident(req.table)}`
  const norm = (p) => ({
    ...p,
    originalName: (p.originalName ?? '').trim(),
    name: (p.name ?? '').trim(),
    definition: (p.definition ?? '').trim(),
  })
  const newByOrig = new Map((req.newPartitions ?? []).map(norm).filter((p) => p.originalName).map((p) => [p.originalName, p]))
  for (const oldP of (req.oldPartitions ?? []).map(norm)) {
    const orig = oldP.originalName || oldP.name
    if (!newByOrig.has(orig)) {
      stmts.push({ kind: 'drop', summary: `Drop partition \`${orig}\``, sql: `ALTER TABLE ${q} DROP PARTITION ${ident(orig)};` })
      warnings.push(`Dropping partition \`${orig}\` deletes the data stored in that partition.`)
    }
  }
  for (const newP of (req.newPartitions ?? []).map(norm)) {
    if (newP.originalName) continue
    const upper = newP.definition.toUpperCase()
    const def = upper.startsWith('PARTITION ') ? newP.definition : `PARTITION ${ident(newP.name)} ${newP.definition}`
    stmts.push({ kind: 'add', summary: `Add partition \`${newP.name}\``, sql: `ALTER TABLE ${q} ADD PARTITION (${def});` })
  }
  return { statements: stmts, warnings }
}

/**
 * SearchCompletions — queries the local SQLite cache for autocomplete candidates.
 * Sub-millisecond in Wails runtime; returns mock data in browser dev mode.
 *
 * @param {string} connectionID
 * @param {string} dbName  active schema to restrict results; '' = all schemas
 * @param {string} keyword  partial identifier typed by the user
 * @returns {Promise<Array<{kind,label,detail,dbName,tableName,isPrimaryKey}>>}
 */
export async function searchCompletions(connectionID, dbName, keyword) {
  if (!keyword) return []
  if (isWails()) {
    const { SearchCompletions } = await import('../../wailsjs/go/main/App.js')
    return SearchCompletions(connectionID, dbName ?? '', keyword) ?? []
  }
  const kw = keyword.toLowerCase()
  return MOCK_SCHEMA.filter(
    (item) =>
      item.label.toLowerCase().startsWith(kw) ||
      item.tableName.toLowerCase().startsWith(kw),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection config store (Phase 7)
// ─────────────────────────────────────────────────────────────────────────────

/** Default mock saved connections for browser dev mode. */
const MOCK_SAVED = [
  {
    id: 'mock-saved-1',
    name: 'localhost (dev)',
    comment: 'Local MySQL for development',
    kind: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: '',
    database: 'db1',
    tls: false,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password', password: '', privateKeyPath: '' },
    advancedParams: [
      { key: 'allowMultiQueries', value: 'true',  enabled: false },
      { key: 'characterEncoding', value: 'UTF-8', enabled: false },
      { key: 'useSSL',            value: 'false', enabled: false },
      { key: 'serverTimezone',    value: 'UTC',   enabled: false },
    ],
    readOnly: false,
    color: '',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'mock-mongo-1',
    name: 'MongoDB Atlas (mock)',
    comment: 'Mock MongoDB SRV connection',
    kind: 'mongodb',
    host: 'cluster.example.mongodb.net',
    port: 27017,
    username: 'demo',
    password: '',
    database: 'admin',
    tls: true,
    ssh: { enabled: false, host: '', port: 22, user: '', authType: 'password', password: '', privateKeyPath: '' },
    advancedParams: [
      { key: '_gripliteMongoConnectionMode', value: 'srv', enabled: true },
    ],
    readOnly: false,
    color: '',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
]

/**
 * ListSavedConnections — all persisted connection configs (no passwords).
 * @returns {Promise<Array>}
 */
export async function listSavedConnections() {
  if (isWails()) {
    const { ListSavedConnections } = await import('../../wailsjs/go/main/App.js')
    return (await ListSavedConnections()) ?? []
  }
  await delay(50)
  return MOCK_SAVED.map(({ password, ...rest }) => rest)
}

/**
 * GetSavedConnection — single saved connection with decrypted passwords.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function getSavedConnection(id) {
  if (isWails()) {
    const { GetSavedConnection } = await import('../../wailsjs/go/main/App.js')
    return GetSavedConnection(id)
  }
  await delay(30)
  return MOCK_SAVED.find((c) => c.id === id) ?? null
}

/**
 * SaveConnection — persist (insert or update) a connection config.
 * @param {object} conn  SavedConnection fields including plain-text passwords
 * @returns {Promise<void>}
 */
export async function saveConnection(conn) {
  if (isWails()) {
    const { SaveConnection } = await import('../../wailsjs/go/main/App.js')
    return SaveConnection(conn)
  }
  await delay(100)
  // In-memory mock update
  const idx = MOCK_SAVED.findIndex((c) => c.id === conn.id)
  if (idx >= 0) {
    MOCK_SAVED[idx] = { ...conn }
  } else {
    MOCK_SAVED.push({ ...conn })
  }
}

/**
 * DeleteSavedConnection — remove a saved connection by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteSavedConnection(id) {
  if (isWails()) {
    const { DeleteSavedConnection } = await import('../../wailsjs/go/main/App.js')
    return DeleteSavedConnection(id)
  }
  await delay(80)
  const idx = MOCK_SAVED.findIndex((c) => c.id === id)
  if (idx >= 0) MOCK_SAVED.splice(idx, 1)
}

/**
 * TestConnection — verify credentials without saving.
 * @param {object} conn  SavedConnection fields
 * @returns {Promise<string>}  human-readable result message
 */
export async function testConnection(conn) {
  if (isWails()) {
    const { TestConnection } = await import('../../wailsjs/go/main/App.js')
    return TestConnection(conn)
  }
  await delay(800 + Math.random() * 400)
  // Mock: succeed 80% of the time
  if (Math.random() > 0.2) {
    return conn?.kind === 'mongodb'
      ? 'Successfully connected · MongoDB 7.0.0 (mock)'
      : 'Successfully connected · MySQL 8.0.35 (mock)'
  }
  throw new Error('Connection refused: mock failure')
}

/**
 * ConnectSaved — open a live connection from a saved config ID.
 * @param {string} id
 * @returns {Promise<string>}  connection ID
 */
export async function connectSaved(id) {
  if (isWails()) {
    const { ConnectSaved } = await import('../../wailsjs/go/main/App.js')
    return ConnectSaved(id)
  }
  await delay(400)
  return id
}

/**
 * OpenFileDialog — native file picker for private key selection.
 * @param {string} title  dialog window title
 * @returns {Promise<string>}  chosen file path, or '' if cancelled
 */
export async function openFileDialog(title = 'Select file') {
  if (isWails()) {
    const { OpenFileDialog } = await import('../../wailsjs/go/main/App.js')
    return OpenFileDialog(title)
  }
  // Browser dev: return a fake path
  return '/home/user/.ssh/id_rsa'
}

/**
 * PickColor — open the native color picker when available.
 * @param {string} initialColor  #rrggbb starting color
 * @returns {Promise<string>} selected #rrggbb color, or '' when cancelled
 */
export async function pickColor(initialColor = '#3b82f6') {
  if (isWails()) {
    const { PickColor } = await import('../../wailsjs/go/main/App.js')
    return PickColor(initialColor)
  }
  return initialColor
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: Connection Manager (direct connect + disconnect)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connect — open a live DB pool from a ConnectionConfig (without saving).
 *
 * Useful for "Test + Connect" flows in the connection dialog where the user
 * has just entered credentials and wants to open the pool immediately.
 *
 * @param {object} cfg  database.ConnectionConfig fields (id required)
 * @returns {Promise<{connectionId:string, serverVersion:string, error?:string}>}
 */
export async function connect(cfg) {
  if (isWails()) {
    const { Connect } = await import('../../wailsjs/go/main/App.js')
    return Connect(cfg)
  }
  await delay(400)
  return { connectionId: cfg.id ?? 'mock-conn', serverVersion: '8.0.35 (mock)' }
}

/**
 * Disconnect — close a live connection pool (driver + Manager layers).
 * @param {string} connectionID
 * @returns {Promise<void>}
 */
export async function disconnect(connectionID) {
  if (isWails()) {
    const { Disconnect } = await import('../../wailsjs/go/main/App.js')
    return Disconnect(connectionID)
  }
  await delay(80)
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 10: Schema Crawler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SyncMetadata — fire-and-forget background crawl of information_schema.
 *
 * The promise resolves as soon as the crawl goroutine has been launched;
 * poll GetSyncState(connID) for progress, or just re-query
 * GetTablesFromCache when needed.
 *
 * @param {string} connectionID
 * @returns {Promise<void>}
 */
export async function syncMetadata(connectionID) {
  if (isWails()) {
    const { SyncMetadata } = await import('../../wailsjs/go/main/App.js')
    return SyncMetadata(connectionID)
  }
  await delay(50)
}

/**
 * GetTablesFromCache — sub-ms read of cached table list for the tree/grid.
 *
 * Pass dbName="" to retrieve tables across every schema for the connection.
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @returns {Promise<Array<{tableName:string, engine:string, sizeBytes:number, comment:string}>>}
 */
export async function getTablesFromCache(connectionID, dbName) {
  if (isWails()) {
    const { GetTablesFromCache } = await import('../../wailsjs/go/main/App.js')
    return (await GetTablesFromCache(connectionID, dbName)) ?? []
  }
  // Browser dev mock — reuse the fetchTables mock data.
  const tables = await fetchTables(connectionID, dbName || 'db1')
  return tables.map((t) => ({
    tableName: t.name,
    engine: 'InnoDB',
    sizeBytes: t.sizeBytes ?? -1,
    comment: '',
  }))
}

/**
 * GetTableDetailFromCache — sub-ms read of full column list for one table.
 *
 * Returns null on cache miss (frontend should trigger syncMetadata()).
 *
 * @param {string} connectionID
 * @param {string} dbName
 * @param {string} tableName
 * @returns {Promise<{tableName:string, engine:string, sizeBytes:number, columns:Array}|null>}
 */
export async function getTableDetailFromCache(connectionID, dbName, tableName) {
  if (isWails()) {
    const { GetTableDetailFromCache } = await import('../../wailsjs/go/main/App.js')
    return GetTableDetailFromCache(connectionID, dbName, tableName)
  }
  const mock = MOCK_TABLE_SCHEMAS[tableName]
  if (!mock) return null
  return {
    tableName,
    engine: 'InnoDB',
    sizeBytes: 65536,
    columns: mock.columns.map((c) => ({
      ordinal: c.ordinal,
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
    })),
  }
}

/**
 * GetDatabasesFromCache — sub-ms read of distinct schema names for connection.
 * @param {string} connectionID
 * @returns {Promise<string[]>}
 */
export async function getDatabasesFromCache(connectionID) {
  if (isWails()) {
    const { GetDatabasesFromCache } = await import('../../wailsjs/go/main/App.js')
    return (await GetDatabasesFromCache(connectionID)) ?? []
  }
  return ['db1', 'analytics', 'logs']
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11: Query Executor (named-column map results)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ExecuteQuery — run SQL and return rows as an array of column→value maps.
 *
 * If the SQL has no LIMIT clause and is a SELECT, "LIMIT <limit>" is injected
 * server-side automatically (default 1000).
 *
 * Unlike runQuery (which returns [][]any for Glide Data Grid efficiency),
 * ExecuteQuery returns []map[string]any so cells can be accessed by name:
 *
 *   const res = await executeQuery(id, 'SELECT * FROM users', 200)
 *   console.log(res.rows[0].email)
 *
 * @param {string} connectionID
 * @param {string} sql
 * @param {number} limit  pass 0 or negative to use server default (1000)
 * @returns {Promise<{columns:string[], rows:Array<object>, rowCount:number, truncated:boolean, rowsAffected:number, timeMs:number, error?:string}>}
 */
export async function executeQuery(connectionID, sql, limit = 1000) {
  if (isWails()) {
    const { ExecuteQuery } = await import('../../wailsjs/go/main/App.js')
    return ExecuteQuery(connectionID, sql, limit)
  }
  // Browser dev: build a plausible named-column result from the RunQuery mock.
  await delay(120 + Math.random() * 150)
  const mock = mockQueryResult(sql)
  const colNames = mock.columns.map((c) => c.name)
  const rows = mock.rows.slice(0, limit > 0 ? limit : mock.rows.length).map((arr) => {
    const obj = {}
    colNames.forEach((name, i) => {
      obj[name] = arr[i]
    })
    return obj
  })
  return {
    columns: colNames,
    rows,
    rowCount: rows.length,
    truncated: rows.length < mock.rows.length,
    rowsAffected: 0,
    timeMs: mock.execMs,
    error: '',
  }
}

/**
 * ExecDML — run INSERT / UPDATE / DELETE / DDL; no result rows.
 * @param {string} connectionID
 * @param {string} sql
 * @returns {Promise<{rowsAffected:number, timeMs:number, error?:string}>}
 */
export async function execDML(connectionID, sql) {
  if (isWails()) {
    const { ExecDML } = await import('../../wailsjs/go/main/App.js')
    return ExecDML(connectionID, sql)
  }
  await delay(80)
  return { columns: [], rows: [], rowsAffected: 1, timeMs: 5, error: '' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 12: Inline-edit transaction (ApplyChanges)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ApplyChanges — commit inline-edit diff-state as one atomic transaction.
 *
 * Mirrors DataViewer's editState exactly:
 *
 *   await applyChanges({
 *     connectionId: 'uuid',
 *     database:     'shop',
 *     tableName:    'orders',
 *     primaryKey:   'id',
 *     deletedIds:   [3, 4],
 *     addedRows:    [{ status: 'shipped', amount: 99.0 }],
 *     editedRows:   [{ id: 1, email: 'new@example.com' }],
 *   })
 *
 * If the transaction fails the error is returned in result.error (NOT thrown)
 * so the React component can display it inline without an uncaught-Promise
 * crash.
 *
 * @param {{connectionId:string, database?:string, tableName:string, primaryKey:string,
 *          deletedIds?:Array, addedRows?:Array<object>, editedRows?:Array<object>}} changeSet
 * @returns {Promise<{deletedCount:number, insertedCount:number, updatedCount:number,
 *                    timeMs:number, statements?:string[], error?:string}>}
 */
export async function applyChanges(changeSet) {
  if (isWails()) {
    const { ApplyChanges } = await import('../../wailsjs/go/main/App.js')
    return ApplyChanges(changeSet)
  }
  await delay(200 + Math.random() * 200)
  // Browser dev mock — pretend everything succeeded.
  return {
    deletedCount: (changeSet.deletedIds ?? []).length,
    insertedCount: (changeSet.addedRows ?? []).length,
    updatedCount: (changeSet.editedRows ?? []).length,
    timeMs: Math.floor(Math.random() * 100) + 10,
    statements: [],
    error: '',
  }
}

export async function applyMongoChanges(changeSet) {
  if (isWails()) {
    const { ApplyMongoChanges } = await import('../../wailsjs/go/main/App.js')
    return ApplyMongoChanges(changeSet)
  }
  await delay(200 + Math.random() * 200)
  return {
    deletedCount: (changeSet.deletedIds ?? []).length,
    insertedCount: (changeSet.addedRows ?? []).length,
    updatedCount: (changeSet.editedRows ?? []).length,
    timeMs: Math.floor(Math.random() * 100) + 10,
    statements: [],
    error: '',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 18: Build metadata — feeds the About modal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getBuildInfo — fetch the app version / build date / author info.
 *
 * In Wails the backend provides authoritative values (Go runtime version,
 * GOOS/GOARCH, link-time build date).  In browser dev we stub plausible
 * defaults so the About modal can still be exercised in the web preview.
 *
 * @returns {Promise<{name:string, version:string, buildDate:string,
 *                    platform:string, goVersion:string, license:string,
 *                    author:string, email:string, homepage:string}>}
 */
// ─────────────────────────────────────────────────────────────────────────────
// Query History
// ─────────────────────────────────────────────────────────────────────────────

export async function getQueryHistory(connectionID, limit = 200) {
  if (isWails()) {
    const { GetQueryHistory } = await import('../../wailsjs/go/main/App.js')
    return (await GetQueryHistory(connectionID, limit)) ?? []
  }
  return []
}

export async function clearQueryHistory(connectionID) {
  if (isWails()) {
    const { ClearQueryHistory } = await import('../../wailsjs/go/main/App.js')
    return ClearQueryHistory(connectionID)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel running query
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelQuery(queryID) {
  if (isWails()) {
    const { CancelQuery } = await import('../../wailsjs/go/main/App.js')
    return CancelQuery(queryID)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kill Query
// ─────────────────────────────────────────────────────────────────────────────

export async function killQuery(connectionID, processID) {
  if (isWails()) {
    const { KillQuery } = await import('../../wailsjs/go/main/App.js')
    return KillQuery(connectionID, processID)
  }
  return { columns: [], rows: [], rowCount: 0, execMs: 0, error: '' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema: routines, triggers, events
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchRoutines(connectionID, dbName) {
  if (isWails()) {
    const { FetchRoutines } = await import('../../wailsjs/go/main/App.js')
    return (await FetchRoutines(connectionID, dbName)) ?? []
  }
  return []
}

export async function fetchTriggers(connectionID, dbName) {
  if (isWails()) {
    const { FetchTriggers } = await import('../../wailsjs/go/main/App.js')
    return (await FetchTriggers(connectionID, dbName)) ?? []
  }
  return []
}

export async function fetchEvents(connectionID, dbName) {
  if (isWails()) {
    const { FetchEvents } = await import('../../wailsjs/go/main/App.js')
    return (await FetchEvents(connectionID, dbName)) ?? []
  }
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy data jobs
// ─────────────────────────────────────────────────────────────────────────────

const mockCopyProgressListeners = new Set()

function emitMockCopyProgress(payload) {
  for (const listener of mockCopyProgressListeners) {
    try { listener(payload) } catch { /* keep other listeners alive */ }
  }
}

export async function copyDatabase(config) {
  if (isWails()) {
    const { CopyDatabase } = await import('../../wailsjs/go/main/App.js')
    return CopyDatabase(config)
  }

  const totalRows = 1000
  emitMockCopyProgress({ status: 'Preparing copy job...', processedRows: 0, totalRows })
  for (const processedRows of [120, 280, 460, 650, 820, 1000]) {
    await delay(180)
    emitMockCopyProgress({ status: 'Copying data...', processedRows, totalRows })
  }
  emitMockCopyProgress({ status: 'Copy complete', processedRows: totalRows, totalRows })
}

export async function cancelCopy() {
  if (isWails()) {
    const { CancelCopy } = await import('../../wailsjs/go/main/App.js')
    return CancelCopy()
  }
  emitMockCopyProgress({ status: 'Copy cancelled', processedRows: 0, totalRows: 0 })
}

export async function copyTable(config) {
  if (isWails()) {
    const { CopyTable } = await import('../../wailsjs/go/main/App.js')
    return CopyTable(config)
  }

  await copyDatabase(config)
  return { success: true, timeMs: 0, error: '' }
}

export async function onCopyProgress(callback) {
  if (isWails()) {
    const { EventsOn } = await import('../../wailsjs/runtime/runtime.js')
    return EventsOn('copy_progress', callback)
  }

  mockCopyProgressListeners.add(callback)
  return () => mockCopyProgressListeners.delete(callback)
}

/**
 * getPlatform — runtime OS identifier ('darwin' | 'windows' | 'linux'), or
 * 'browser' in dev. Used to decide whether the native menu bar hosts Tools/Help
 * (macOS) or the in-app MenuBar should keep them (Windows/Linux).
 *
 * @returns {Promise<string>}
 */
export async function getPlatform() {
  if (!isWails()) return 'browser'
  try {
    const { Environment } = await import('../../wailsjs/runtime/runtime.js')
    const env = await Environment()
    return env?.platform ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * onMenuAction — subscribe to native menu clicks emitted by the Go side. Each
 * handler is optional. No-op outside the Wails runtime.
 *
 * @param {{ settings?: Function, shortcuts?: Function, about?: Function }} handlers
 * @returns {Promise<() => void>}  unsubscribe function
 */
export async function onMenuAction(handlers = {}) {
  if (!isWails()) return () => {}
  const { EventsOn } = await import('../../wailsjs/runtime/runtime.js')
  const offs = []
  if (handlers.settings)  offs.push(EventsOn('menu:settings',  handlers.settings))
  if (handlers.shortcuts) offs.push(EventsOn('menu:shortcuts', handlers.shortcuts))
  if (handlers.about)     offs.push(EventsOn('menu:about',     handlers.about))
  return () => offs.forEach((off) => { try { off?.() } catch { /* ignore */ } })
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL Dump Export
// ─────────────────────────────────────────────────────────────────────────────

export async function exportDump(connectionID, dbName, tableName) {
  if (isWails()) {
    const { ExportDump } = await import('../../wailsjs/go/main/App.js')
    return ExportDump(connectionID, dbName, tableName)
  }
  return `-- Mock dump for ${dbName}.${tableName}\n-- Run inside the Wails app for live output.\n`
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic file save (native Save-As dialog)
// ─────────────────────────────────────────────────────────────────────────────

export async function saveTextFile(defaultFilename, content) {
  if (isWails()) {
    const { SaveTextFile } = await import('../../wailsjs/go/main/App.js')
    return SaveTextFile(defaultFilename, content)
  }
  // Dev/browser fallback: use blob download
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: defaultFilename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return defaultFilename
}

// ─────────────────────────────────────────────────────────────────────────────
// Build info
// ─────────────────────────────────────────────────────────────────────────────

export async function getBuildInfo() {
  if (isWails()) {
    const { GetBuildInfo } = await import('../../wailsjs/go/main/App.js')
    return GetBuildInfo()
  }
  await delay(10)
  return {
    name: 'GripLite',
    version: 'v0.1.9',
    buildDate: new Date().toISOString().slice(0, 10),
    platform: 'Wails + React (browser preview)',
    goVersion: 'go (dev)',
    license: 'MIT',
    author: 'derek',
    email: 'zhanweichun@gmail.com',
    homepage: 'https://github.com/derekzhan',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Redis
//
// Values cross the bridge base64-encoded so binary-safe payloads survive JSON.
// In browser dev, an in-memory keyspace backs every operation.
// ─────────────────────────────────────────────────────────────────────────────

const b64encode = (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'))
const b64decode = (s) => { try { return decodeURIComponent(escape(atob(s))) } catch { return s } }

// Browser-dev mock keyspace for db0.
const mockRedis = {
  'user:1':    { type: 'string', ttl: -1, str: 'Alice' },
  'user:2':    { type: 'string', ttl: 3600, str: 'Bob' },
  'cache:home':{ type: 'string', ttl: -1, str: '{"hits":42}' },
  'user:profile:1': { type: 'hash', ttl: -1, hash: { name: 'Alice', age: '30' } },
  'queue:jobs':{ type: 'list', ttl: -1, list: ['job-1', 'job-2', 'job-3'] },
  'tags':      { type: 'set', ttl: -1, set: ['red', 'green', 'blue'] },
  'leaderboard': { type: 'zset', ttl: -1, zset: [{ member: 'alice', score: 100 }, { member: 'bob', score: 80 }] },
  'events':    { type: 'stream', ttl: -1, stream: [{ id: '1700000000000-0', fields: { kind: 'login', user: 'alice' } }] },
}

function mockKeyValue(key) {
  const e = mockRedis[key]
  if (!e) return { meta: { key, type: 'none', ttl: -2 }, }
  const meta = { key, type: e.type, ttl: e.ttl ?? -1, sizeBytes: 0, encoding: 'mock' }
  const out = { meta }
  switch (e.type) {
    case 'string': out.str = b64encode(e.str); break
    case 'hash':   out.hash = Object.entries(e.hash).map(([f, v]) => ({ field: b64encode(f), value: b64encode(v) })); break
    case 'list':   out.list = e.list.map(b64encode); break
    case 'set':    out.set = e.set.map(b64encode); break
    case 'zset':   out.zset = e.zset.map((z) => ({ member: b64encode(z.member), score: z.score })); break
    case 'stream': out.stream = e.stream; break
  }
  return out
}

export async function redisDatabases(connectionID) {
  if (isWails()) {
    const { RedisDatabases } = await import('../../wailsjs/go/main/App.js')
    return RedisDatabases(connectionID)
  }
  await delay(30)
  return Array.from({ length: 16 }, (_, i) => `db${i}`)
}

export async function redisDBSize(connectionID, db) {
  if (isWails()) {
    const { RedisDBSize } = await import('../../wailsjs/go/main/App.js')
    return RedisDBSize(connectionID, db)
  }
  await delay(10)
  return db === 0 ? Object.keys(mockRedis).length : 0
}

export async function redisScanKeys(connectionID, db, pattern, cursor = 0, count = 200) {
  if (isWails()) {
    const { RedisScanKeys } = await import('../../wailsjs/go/main/App.js')
    return RedisScanKeys(connectionID, db, pattern || '*', cursor, count)
  }
  await delay(30)
  if (db !== 0) return { keys: [], nextCursor: 0 }
  const glob = (pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  const re = new RegExp(`^${glob}$`)
  return { keys: Object.keys(mockRedis).filter((k) => re.test(k)), nextCursor: 0 }
}

export async function redisGetKey(connectionID, db, key) {
  if (isWails()) {
    const { RedisGetKey } = await import('../../wailsjs/go/main/App.js')
    return RedisGetKey(connectionID, db, key)
  }
  await delay(20)
  return mockKeyValue(key)
}

export async function redisSetString(connectionID, db, key, value, ttl = 0) {
  if (isWails()) {
    const { RedisSetString } = await import('../../wailsjs/go/main/App.js')
    return RedisSetString(connectionID, db, key, b64encode(value), ttl)
  }
  mockRedis[key] = { type: 'string', ttl: ttl || -1, str: value }
}

export async function redisHashSet(connectionID, db, key, field, value) {
  if (isWails()) {
    const { RedisHashSet } = await import('../../wailsjs/go/main/App.js')
    return RedisHashSet(connectionID, db, key, b64encode(field), b64encode(value))
  }
  const e = mockRedis[key] ?? (mockRedis[key] = { type: 'hash', ttl: -1, hash: {} })
  e.hash[field] = value
}

export async function redisHashDelete(connectionID, db, key, field) {
  if (isWails()) {
    const { RedisHashDelete } = await import('../../wailsjs/go/main/App.js')
    return RedisHashDelete(connectionID, db, key, b64encode(field))
  }
  if (mockRedis[key]) delete mockRedis[key].hash[field]
}

export async function redisListSet(connectionID, db, key, index, value) {
  if (isWails()) {
    const { RedisListSet } = await import('../../wailsjs/go/main/App.js')
    return RedisListSet(connectionID, db, key, index, b64encode(value))
  }
  if (mockRedis[key]) mockRedis[key].list[index] = value
}

export async function redisListPush(connectionID, db, key, value, left = false) {
  if (isWails()) {
    const { RedisListPush } = await import('../../wailsjs/go/main/App.js')
    return RedisListPush(connectionID, db, key, b64encode(value), left)
  }
  const e = mockRedis[key] ?? (mockRedis[key] = { type: 'list', ttl: -1, list: [] })
  left ? e.list.unshift(value) : e.list.push(value)
}

export async function redisListRemove(connectionID, db, key, count, value) {
  if (isWails()) {
    const { RedisListRemove } = await import('../../wailsjs/go/main/App.js')
    return RedisListRemove(connectionID, db, key, count, b64encode(value))
  }
  if (mockRedis[key]) mockRedis[key].list = mockRedis[key].list.filter((v) => v !== value)
}

export async function redisSetAdd(connectionID, db, key, member) {
  if (isWails()) {
    const { RedisSetAdd } = await import('../../wailsjs/go/main/App.js')
    return RedisSetAdd(connectionID, db, key, b64encode(member))
  }
  const e = mockRedis[key] ?? (mockRedis[key] = { type: 'set', ttl: -1, set: [] })
  if (!e.set.includes(member)) e.set.push(member)
}

export async function redisSetRemove(connectionID, db, key, member) {
  if (isWails()) {
    const { RedisSetRemove } = await import('../../wailsjs/go/main/App.js')
    return RedisSetRemove(connectionID, db, key, b64encode(member))
  }
  if (mockRedis[key]) mockRedis[key].set = mockRedis[key].set.filter((m) => m !== member)
}

export async function redisZAdd(connectionID, db, key, member, score) {
  if (isWails()) {
    const { RedisZAdd } = await import('../../wailsjs/go/main/App.js')
    return RedisZAdd(connectionID, db, key, b64encode(member), score)
  }
  const e = mockRedis[key] ?? (mockRedis[key] = { type: 'zset', ttl: -1, zset: [] })
  const ex = e.zset.find((z) => z.member === member)
  if (ex) ex.score = score
  else e.zset.push({ member, score })
}

export async function redisZRemove(connectionID, db, key, member) {
  if (isWails()) {
    const { RedisZRemove } = await import('../../wailsjs/go/main/App.js')
    return RedisZRemove(connectionID, db, key, b64encode(member))
  }
  if (mockRedis[key]) mockRedis[key].zset = mockRedis[key].zset.filter((z) => z.member !== member)
}

export async function redisStreamAdd(connectionID, db, key, id, fields) {
  if (isWails()) {
    const { RedisStreamAdd } = await import('../../wailsjs/go/main/App.js')
    return RedisStreamAdd(connectionID, db, key, id || '*', fields)
  }
  const e = mockRedis[key] ?? (mockRedis[key] = { type: 'stream', ttl: -1, stream: [] })
  const newId = id && id !== '*' ? id : `${Date.now()}-0`
  e.stream.push({ id: newId, fields })
  return newId
}

export async function redisStreamDelete(connectionID, db, key, id) {
  if (isWails()) {
    const { RedisStreamDelete } = await import('../../wailsjs/go/main/App.js')
    return RedisStreamDelete(connectionID, db, key, id)
  }
  if (mockRedis[key]) mockRedis[key].stream = mockRedis[key].stream.filter((s) => s.id !== id)
}

export async function redisRenameKey(connectionID, db, oldKey, newKey) {
  if (isWails()) {
    const { RedisRenameKey } = await import('../../wailsjs/go/main/App.js')
    return RedisRenameKey(connectionID, db, oldKey, newKey)
  }
  if (mockRedis[oldKey]) { mockRedis[newKey] = mockRedis[oldKey]; delete mockRedis[oldKey] }
}

export async function redisDeleteKey(connectionID, db, key) {
  if (isWails()) {
    const { RedisDeleteKey } = await import('../../wailsjs/go/main/App.js')
    return RedisDeleteKey(connectionID, db, key)
  }
  delete mockRedis[key]
}

export async function redisSetTTL(connectionID, db, key, ttl) {
  if (isWails()) {
    const { RedisSetTTL } = await import('../../wailsjs/go/main/App.js')
    return RedisSetTTL(connectionID, db, key, ttl)
  }
  if (mockRedis[key]) mockRedis[key].ttl = ttl > 0 ? ttl : -1
}

export async function redisExecCommand(connectionID, db, raw) {
  if (isWails()) {
    const { RedisExecCommand } = await import('../../wailsjs/go/main/App.js')
    return RedisExecCommand(connectionID, db, raw)
  }
  await delay(20)
  const name = (raw.trim().split(/\s+/)[0] || '').toUpperCase()
  if (name === 'PING') return { ok: true, text: 'PONG' }
  return { ok: true, text: `(mock) ${raw}` }
}

export async function redisDecodeValue(dataB64, format) {
  if (isWails()) {
    const { RedisDecodeValue } = await import('../../wailsjs/go/main/App.js')
    return RedisDecodeValue(dataB64, format)
  }
  const raw = b64decode(dataB64)
  if (format === 'hex') return { ok: true, text: Array.from(raw).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') }
  if (format === 'json') { try { return { ok: true, text: JSON.stringify(JSON.parse(raw), null, 2) } } catch (e) { return { ok: false, error: 'not valid JSON' } } }
  return { ok: true, text: raw }
}

export async function redisServerInfo(connectionID) {
  if (isWails()) {
    const { RedisServerInfo } = await import('../../wailsjs/go/main/App.js')
    return RedisServerInfo(connectionID)
  }
  await delay(20)
  return {
    Server: { redis_version: '7.2.4', uptime_in_seconds: '12345', redis_mode: 'standalone' },
    Clients: { connected_clients: '3' },
    Memory: { used_memory_human: '1.20M', maxmemory_human: '0B' },
    Stats: { instantaneous_ops_per_sec: '42', total_commands_processed: '99999' },
    Keyspace: { db0: `keys=${Object.keys(mockRedis).length},expires=1` },
  }
}

export async function redisSlowLog(connectionID, count = 64) {
  if (isWails()) {
    const { RedisSlowLog } = await import('../../wailsjs/go/main/App.js')
    return RedisSlowLog(connectionID, count)
  }
  await delay(20)
  return [{ id: 1, time: Math.floor(Date.now() / 1000), duration: 1500, args: ['GET', 'big:key'], client: '127.0.0.1:5000', name: '' }]
}

export async function redisClientList(connectionID) {
  if (isWails()) {
    const { RedisClientList } = await import('../../wailsjs/go/main/App.js')
    return RedisClientList(connectionID)
  }
  await delay(20)
  return ['id=3 addr=127.0.0.1:5000 name= age=10 idle=0 cmd=client|list']
}

export async function redisSubscribe(connectionID, channels, patterns) {
  if (isWails()) {
    const { RedisSubscribe } = await import('../../wailsjs/go/main/App.js')
    return RedisSubscribe(connectionID, channels || [], patterns || [])
  }
  await delay(10)
  return 'mock-sub'
}

export async function redisUnsubscribe(subID) {
  if (isWails()) {
    const { RedisUnsubscribe } = await import('../../wailsjs/go/main/App.js')
    return RedisUnsubscribe(subID)
  }
}

/**
 * onRedisMessage — subscribe to messages for a pub/sub subscription ID.
 * Returns an unsubscribe function. No-op in browser dev.
 */
export async function onRedisMessage(subID, handler) {
  if (!isWails()) return () => {}
  const { EventsOn } = await import('../../wailsjs/runtime/runtime.js')
  return EventsOn(`redis:message:${subID}`, handler)
}

/** decodeRedisValue — UTF-8 decode a base64 payload for default display. */
export function decodeRedisB64(s) { return b64decode(s) }
