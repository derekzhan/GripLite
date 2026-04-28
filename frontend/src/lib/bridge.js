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
  const rows = Array.from({ length: 50 }, (_, i) => [
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
export async function runQuery(connectionID, dbName, sql) {
  if (isWails()) {
    const { RunQuery } = await import('../../wailsjs/go/main/App.js')
    return RunQuery(connectionID, dbName ?? '', sql)
  }
  // Browser dev mock
  await delay(150 + Math.random() * 200)
  return mockQueryResult(sql)
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
 *     constraints: [{ name, type, columns: string[] }],
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
      { name: 'PRIMARY',     type: 'PRIMARY KEY', columns: ['id'] },
      { name: 'idx_username', type: 'UNIQUE',     columns: ['username'] },
      { name: 'idx_email',    type: 'UNIQUE',     columns: ['email'] },
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
      { name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] },
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
    return 'Successfully connected · MySQL 8.0.35 (mock)'
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

export async function cancelQuery(connectionID) {
  if (isWails()) {
    const { CancelQuery } = await import('../../wailsjs/go/main/App.js')
    return CancelQuery(connectionID)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load More (offset pagination)
// ─────────────────────────────────────────────────────────────────────────────

export async function runQueryPage(connectionID, dbName, sql, offset, limit = 1000) {
  if (isWails()) {
    const { RunQueryPage } = await import('../../wailsjs/go/main/App.js')
    return RunQueryPage(connectionID, dbName ?? '', sql, offset, limit)
  }
  await delay(100)
  return { columns: [], rows: [], rowCount: 0, truncated: false, execMs: 0, error: '' }
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
    version: 'v0.1.6',
    buildDate: new Date().toISOString().slice(0, 10),
    platform: 'Wails + React (browser preview)',
    goVersion: 'go (dev)',
    license: 'MIT',
    author: 'derek',
    email: 'zhanweichun@gmail.com',
    homepage: 'https://github.com/derek-zhanweichun/GripLite',
  }
}
