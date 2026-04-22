/**
 * TableViewer — DBeaver-style table editor with two top-level tabs.
 *
 *   ┌─ Properties ─────────────────────────────────────────────────────┐
 *   │  TableInfoPanel (table metadata form)                            │
 *   │  ┌─ Sidebar ──┬─ Detail (Columns / Indexes / DDL / …) ─────────┐│
 *   │  │ Columns    │  sticky-header table                            ││
 *   │  │ Constraints│                                                  ││
 *   │  │ …          │                                                  ││
 *   │  └────────────┴──────────────────────────────────────────────────┘│
 *   └──────────────────────────────────────────────────────────────────┘
 *
 *   ┌─ Data ───────────────────────────────────────────────────────────┐
 *   │  Auto-loads SELECT * FROM `table` LIMIT 100 on mount.           │
 *   │  Renders result in Glide Data Grid (canvas, zero DOM overhead).  │
 *   │  Loading / error / empty states handled inline.                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * State isolation guarantee:
 *   Each TableViewer instance has its own useState for dataResult, loading,
 *   error, active section, etc.  App.jsx keeps all instances mounted (CSS
 *   display:none when not active) so state is never lost on tab switch.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import { ArrowUp, ArrowDown, ArrowUpDown, Plus, Minus, Save, XCircle } from 'lucide-react'
import DataViewer, { exportCsv } from './DataViewer'
import ActionFooter from './ActionFooter'
import ReviewSqlModal from './ReviewSqlModal'
import { useTheme } from '../theme/ThemeProvider'
import {
  runQuery, getTableSchema, getTableAdvancedProperties,
  previewTableAlter, executeTableAlter, applyChanges,
} from '../lib/bridge'
import { useEditState } from '../hooks/useEditState'
import { normalizeError } from '../lib/errors'
import { toast } from '../lib/toast'

// ─────────────────────────────────────────────────────────────────────────────
// Mock schema metadata (Properties tab)
// In production these come from the Go UDAL backend via IPC.
// ─────────────────────────────────────────────────────────────────────────────
function getMockSchema(tableName = 'users') {
  const schemas = {
    users: {
      info: { name: 'users', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4', autoIncrement: 1024, comment: 'Application user accounts and authentication data' },
      columns: [
        { ord: 1, name: 'id',           type: 'int(11)',                             notNull: true,  ai: true,  key: 'PRI', default: null,                                          comment: 'Primary key' },
        { ord: 2, name: 'username',      type: 'varchar(64)',                         notNull: true,  ai: false, key: 'UNI', default: null,                                          comment: 'Unique login username' },
        { ord: 3, name: 'email',         type: 'varchar(255)',                        notNull: true,  ai: false, key: 'UNI', default: null,                                          comment: 'Email address' },
        { ord: 4, name: 'password_hash', type: 'varchar(255)',                        notNull: true,  ai: false, key: '',    default: null,                                          comment: 'Bcrypt password hash' },
        { ord: 5, name: 'status',        type: "enum('active','inactive','banned')",  notNull: true,  ai: false, key: '',    default: "'active'",                                    comment: 'Account status' },
        { ord: 6, name: 'score',         type: 'decimal(10,2)',                       notNull: false, ai: false, key: '',    default: '0.00',                                        comment: 'User reputation score' },
        { ord: 7, name: 'created_at',    type: 'datetime',                            notNull: true,  ai: false, key: 'MUL', default: 'CURRENT_TIMESTAMP',                           comment: 'Account creation time' },
        { ord: 8, name: 'updated_at',    type: 'datetime',                            notNull: true,  ai: false, key: '',    default: 'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', comment: '' },
      ],
      indexes: [
        { name: 'PRIMARY',      type: 'BTREE', unique: true,  columns: ['id'],        comment: '' },
        { name: 'idx_username', type: 'BTREE', unique: true,  columns: ['username'],  comment: '' },
        { name: 'idx_email',    type: 'BTREE', unique: true,  columns: ['email'],     comment: '' },
        { name: 'idx_created',  type: 'BTREE', unique: false, columns: ['created_at'], comment: '' },
      ],
      constraints: [
        { name: 'PRIMARY',     type: 'PRIMARY KEY', columns: ['id'] },
        { name: 'uq_username', type: 'UNIQUE',      columns: ['username'] },
        { name: 'uq_email',    type: 'UNIQUE',      columns: ['email'] },
      ],
      foreignKeys: [],
      ddl: `CREATE TABLE \`users\` (\n  \`id\`            int(11)      NOT NULL AUTO_INCREMENT,\n  \`username\`      varchar(64)  NOT NULL,\n  \`email\`         varchar(255) NOT NULL,\n  \`password_hash\` varchar(255) NOT NULL,\n  \`status\`        enum('active','inactive','banned') NOT NULL DEFAULT 'active',\n  \`score\`         decimal(10,2) DEFAULT 0.00,\n  \`created_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  \`updated_at\`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP\n                   ON UPDATE CURRENT_TIMESTAMP,\n  PRIMARY KEY (\`id\`),\n  UNIQUE KEY \`idx_username\` (\`username\`),\n  UNIQUE KEY \`idx_email\`    (\`email\`),\n  KEY \`idx_created\`         (\`created_at\`)\n) ENGINE=InnoDB AUTO_INCREMENT=1024 DEFAULT CHARSET=utf8mb4\n  COLLATE=utf8mb4_unicode_ci\n  COMMENT='Application user accounts and authentication data';`,
    },
    orders: {
      info: { name: 'orders', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4', autoIncrement: 8842, comment: 'Customer purchase orders' },
      columns: [
        { ord: 1, name: 'id',         type: 'int(11)',       notNull: true,  ai: true,  key: 'PRI', default: null,         comment: 'Order ID' },
        { ord: 2, name: 'user_id',    type: 'int(11)',       notNull: true,  ai: false, key: 'MUL', default: null,         comment: 'FK → users.id' },
        { ord: 3, name: 'total',      type: 'decimal(12,2)', notNull: true,  ai: false, key: '',    default: '0.00',       comment: 'Order total' },
        { ord: 4, name: 'status',     type: "enum('pending','paid','shipped','cancelled')", notNull: true, ai: false, key: '', default: "'pending'", comment: '' },
        { ord: 5, name: 'created_at', type: 'datetime',      notNull: true,  ai: false, key: 'MUL', default: 'CURRENT_TIMESTAMP', comment: '' },
      ],
      indexes: [
        { name: 'PRIMARY',     type: 'BTREE', unique: true,  columns: ['id'],        comment: '' },
        { name: 'idx_user_id', type: 'BTREE', unique: false, columns: ['user_id'],   comment: '' },
        { name: 'idx_created', type: 'BTREE', unique: false, columns: ['created_at'], comment: '' },
      ],
      constraints: [{ name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] }],
      foreignKeys: [{ name: 'fk_orders_user', column: 'user_id', refTable: 'users', refColumn: 'id', onDelete: 'RESTRICT', onUpdate: 'CASCADE' }],
      ddl: `CREATE TABLE \`orders\` (\n  \`id\` int(11) NOT NULL AUTO_INCREMENT,\n  \`user_id\` int(11) NOT NULL,\n  \`total\` decimal(12,2) NOT NULL DEFAULT 0.00,\n  \`status\` enum('pending','paid','shipped','cancelled') NOT NULL DEFAULT 'pending',\n  \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (\`id\`),\n  KEY \`idx_user_id\` (\`user_id\`),\n  KEY \`idx_created\` (\`created_at\`),\n  CONSTRAINT \`fk_orders_user\` FOREIGN KEY (\`user_id\`)\n    REFERENCES \`users\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE\n) ENGINE=InnoDB AUTO_INCREMENT=8842 DEFAULT CHARSET=utf8mb4;`,
    },
    products: {
      info: { name: 'products', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4', autoIncrement: 512, comment: 'Product catalog' },
      columns: [
        { ord: 1, name: 'id',          type: 'int(11)',       notNull: true,  ai: true,  key: 'PRI', default: null,   comment: '' },
        { ord: 2, name: 'name',         type: 'varchar(128)',  notNull: true,  ai: false, key: 'UNI', default: null,   comment: 'Product display name' },
        { ord: 3, name: 'price',        type: 'decimal(10,2)', notNull: true,  ai: false, key: '',    default: '0.00', comment: 'Unit price' },
        { ord: 4, name: 'stock',        type: 'int(11)',       notNull: true,  ai: false, key: '',    default: '0',    comment: 'Available stock' },
        { ord: 5, name: 'description',  type: 'text',          notNull: false, ai: false, key: '',    default: null,   comment: '' },
      ],
      indexes: [{ name: 'PRIMARY', type: 'BTREE', unique: true, columns: ['id'], comment: '' }],
      constraints: [{ name: 'PRIMARY', type: 'PRIMARY KEY', columns: ['id'] }],
      foreignKeys: [],
      ddl: `CREATE TABLE \`products\` (\n  \`id\` int(11) NOT NULL AUTO_INCREMENT,\n  \`name\` varchar(128) NOT NULL,\n  \`price\` decimal(10,2) NOT NULL DEFAULT 0.00,\n  \`stock\` int(11) NOT NULL DEFAULT 0,\n  \`description\` text,\n  PRIMARY KEY (\`id\`),\n  UNIQUE KEY \`uq_name\` (\`name\`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`,
    },
  }
  // Fallback for unknown tables
  const base = schemas[tableName]
  if (base) return base
  return {
    info: { name: tableName, engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', charset: 'utf8mb4', autoIncrement: 1, comment: '' },
    columns: [], indexes: [], constraints: [], foreignKeys: [], ddl: `-- DDL not available for ${tableName}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar definition
// ─────────────────────────────────────────────────────────────────────────────
const SIDEBAR_ITEMS = [
  { id: 'columns',      label: 'Columns',      icon: '⊞' },
  { id: 'constraints',  label: 'Constraints',  icon: '🔒' },
  { id: 'foreignkeys',  label: 'Foreign Keys', icon: '🔗' },
  { id: 'references',   label: 'References',   icon: '↩' },
  { id: 'triggers',     label: 'Triggers',     icon: '⚡' },
  { id: 'indexes',      label: 'Indexes',      icon: '⚑' },
  { id: 'partitions',   label: 'Partitions',   icon: '⊙' },
  { id: 'ddl',          label: 'DDL',          icon: '</>' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Micro-components shared across detail views
// ─────────────────────────────────────────────────────────────────────────────
const TH = ({ children, center = false }) => (
  <th className={`sticky top-0 z-10 bg-titlebar px-3 py-1.5 text-[11px] font-semibold
                  uppercase tracking-wider text-fg-muted border-b border-r border-line-subtle
                  whitespace-nowrap select-none ${center ? 'text-center' : 'text-left'}`}>
    {children}
  </th>
)
const TD = ({ children, center = false, mono = false, className = '' }) => (
  <td className={`px-3 py-1.5 border-r border-b border-line-subtle ${center ? 'text-center' : ''} ${mono ? 'font-mono text-syntax-string' : ''} ${className}`}>
    {children}
  </td>
)
const BoolCell = ({ value }) =>
  value ? <span className="text-success font-bold">✓</span>
        : <span className="text-fg-muted">–</span>

const KeyBadge = ({ value }) => {
  if (!value) return <span className="text-fg-muted">–</span>
  const colors = {
    PRI: 'bg-danger-bg text-danger border-danger',
    UNI: 'bg-accent-subtle text-accent-text border-accent',
    MUL: 'bg-warn/15 text-warn border-warn',
  }
  return <span className={`px-1.5 py-px rounded text-[10px] font-bold border ${colors[value] ?? 'border-line text-fg-muted'}`}>{value}</span>
}

const EmptyState = ({ label }) => (
  <div className="flex items-center justify-center h-full text-fg-muted text-[13px] italic select-none">
    No {label} defined for this table.
  </div>
)

// ─────────────────────────────────────────────────────────────────────────────
// Properties tab — sub-views
// ─────────────────────────────────────────────────────────────────────────────

const ENGINE_OPTIONS = ['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'BLACKHOLE']

const CHARSET_OPTIONS = [
  'utf8mb4', 'utf8', 'latin1', 'ascii', 'binary', 'gbk', 'big5', 'ucs2',
]

// Collations we surface by default.  Filtered down to those compatible
// with the currently-selected charset so the dropdown stays sane.
const COLLATION_OPTIONS = {
  utf8mb4: ['utf8mb4_unicode_ci', 'utf8mb4_0900_ai_ci', 'utf8mb4_general_ci', 'utf8mb4_bin'],
  utf8:    ['utf8_unicode_ci', 'utf8_general_ci', 'utf8_bin'],
  latin1:  ['latin1_swedish_ci', 'latin1_general_ci', 'latin1_bin'],
  ascii:   ['ascii_general_ci', 'ascii_bin'],
  binary:  ['binary'],
  gbk:     ['gbk_chinese_ci', 'gbk_bin'],
  big5:    ['big5_chinese_ci', 'big5_bin'],
  ucs2:    ['ucs2_general_ci', 'ucs2_bin'],
}

const FIELD_LABEL_CLS =
  'text-[10px] uppercase tracking-wider text-fg-muted mb-0.5 select-none'

const FIELD_INPUT_CLS =
  'w-full bg-elevated border border-line-subtle rounded px-2 py-1 text-[12px] ' +
  'text-fg-primary font-mono outline-none focus:border-accent hover:border-accent ' +
  'transition-colors'

/**
 * TableInfoPanel — every field is directly editable; commits on blur or
 * Enter.  Engine / Charset / Collation surface a `<select>` dropdown so
 * users don't have to remember exact identifiers.  Changes flow into the
 * draft via `onPatch` and are committed via the regular ReviewSqlModal /
 * Apply flow at the bottom of the Properties tab.
 */
function TableInfoPanel({ info, editable = true, onPatch }) {
  const patch = (field) => (val) => onPatch({ [field]: val })

  // Filter collations by the currently-selected charset; fall back to a
  // generic list if the charset is unknown so we never show an empty menu.
  const charset    = info.charset || 'utf8mb4'
  const collations = COLLATION_OPTIONS[charset] || COLLATION_OPTIONS.utf8mb4
  // If the current collation isn't in the dropdown, prepend it so the
  // value still appears (rather than silently switching to the first).
  const collationOpts = info.collation && !collations.includes(info.collation)
    ? [info.collation, ...collations]
    : collations

  return (
    <div className="flex-shrink-0 bg-titlebar border-b border-line-subtle px-4 py-3">
      <div className="grid grid-cols-6 gap-3">
        <TextField    label="Table Name"     value={info.name}          editable={editable} onCommit={patch('name')} />
        <SelectField  label="Engine"         value={info.engine}        editable={editable} options={ENGINE_OPTIONS}  onCommit={patch('engine')} />
        <SelectField  label="Collation"      value={info.collation}     editable={editable} options={collationOpts}   onCommit={patch('collation')} />
        <NumberField  label="Auto Increment" value={info.autoIncrement} editable={editable} onCommit={patch('autoIncrement')} />
        <SelectField  label="Charset"        value={info.charset}       editable={editable} options={CHARSET_OPTIONS} onCommit={patch('charset')} />
        <TextField    label="Description"    value={info.comment}       editable={editable} onCommit={patch('comment')} wide textarea />
      </div>
    </div>
  )
}

/* ── Field primitives ────────────────────────────────────────────────── */

// Local-buffer pattern: `value` from the parent is the source of truth,
// but while focused the user sees their own draft.  Commits on blur or
// Enter; Escape reverts to the parent value.
function useFieldBuffer(value) {
  const [buf, setBuf] = useState(value ?? '')
  useEffect(() => { setBuf(value ?? '') }, [value])
  return [buf, setBuf]
}

function TextField({ label, value, editable, onCommit, wide, textarea }) {
  const [buf, setBuf] = useFieldBuffer(value)
  const commit = () => { if (buf !== (value ?? '')) onCommit(buf) }
  const revert = () => setBuf(value ?? '')
  const onKey  = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); revert(); e.target.blur() }
    else if (!textarea && e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur() }
    else if (textarea && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); commit(); e.target.blur()
    }
  }
  const Tag = textarea ? 'textarea' : 'input'
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className={FIELD_LABEL_CLS}>{label}</div>
      <Tag
        value={buf}
        readOnly={!editable}
        rows={textarea ? 2 : undefined}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        className={[
          FIELD_INPUT_CLS,
          textarea ? 'min-h-[50px] resize-none' : '',
          !editable ? 'opacity-70 cursor-not-allowed' : '',
        ].join(' ')}
      />
    </div>
  )
}

function NumberField({ label, value, editable, onCommit, wide }) {
  const [buf, setBuf] = useFieldBuffer(value === null || value === undefined ? '' : String(value))
  const commit = () => {
    const trimmed = buf.trim()
    const next = trimmed === '' ? null : Number(trimmed)
    if (trimmed !== '' && (!Number.isFinite(next) || next < 0)) { setBuf(String(value ?? '')); return }
    if (next !== value) onCommit(next)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); setBuf(String(value ?? '')); e.target.blur() }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); e.target.blur() }
  }
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className={FIELD_LABEL_CLS}>{label}</div>
      <input
        type="number"
        min={0}
        value={buf}
        readOnly={!editable}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
        className={`${FIELD_INPUT_CLS} ${!editable ? 'opacity-70 cursor-not-allowed' : ''}`}
      />
    </div>
  )
}

function SelectField({ label, value, editable, options, onCommit, wide }) {
  // Prepend the current value if it's not in the predefined list so we
  // never silently change a custom value just because we don't know it.
  const opts = value && !options.includes(value) ? [value, ...options] : options
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <div className={FIELD_LABEL_CLS}>{label}</div>
      <select
        value={value ?? ''}
        disabled={!editable}
        onChange={(e) => onCommit(e.target.value)}
        className={[
          FIELD_INPUT_CLS,
          'cursor-pointer pr-6',
          !editable ? 'opacity-70 cursor-not-allowed' : '',
        ].join(' ')}
      >
        {opts.map((o) => (
          <option key={o} value={o} className="bg-panel text-fg-primary">{o}</option>
        ))}
      </select>
    </div>
  )
}

// Default suggestions for the Data Type column's <datalist>.  Users can
// still type anything — MySQL will reject invalid syntax at ALTER time.
const DATA_TYPE_SUGGESTIONS = [
  'int(11)', 'int unsigned', 'bigint(20)', 'smallint(6)', 'tinyint(1)',
  'varchar(32)', 'varchar(64)', 'varchar(128)', 'varchar(255)',
  'char(16)', 'char(36)',
  'text', 'mediumtext', 'longtext',
  'decimal(10,2)', 'decimal(18,6)', 'float', 'double',
  'datetime', 'date', 'timestamp', 'time', 'year',
  'json', 'blob', 'mediumblob', 'longblob',
  "enum('a','b')", "set('a','b')",
]

/**
 * InlineCell — a single cell that flips between a read-only label and a
 * live input.  Activation rules follow DBeaver:
 *
 *   • Double-click enters edit mode on THAT cell only.
 *   • Enter or blur commits.
 *   • Escape reverts to the original value and exits edit mode.
 *
 * The caller owns the authoritative value; local state only holds the
 * in-progress buffer while the input is focused, which keeps the draft
 * stable if the user presses Escape mid-edit.
 */
function InlineCell({
  value,
  onCommit,
  active,           // true ⇢ this cell is the currently-editing one
  onActivate,       // () => void — ask the parent to set us active
  onDeactivate,     // () => void — ask the parent to clear active
  list,             // optional <datalist> id
  placeholder,
  displayClass = '',
  inputClass   = '',
  renderDisplay,    // optional custom display renderer
}) {
  const [buffer, setBuffer] = useState(value)
  const inputRef = useRef(null)

  useEffect(() => {
    if (active) {
      setBuffer(value)
      // Defer focus/select until the input is mounted.
      queueMicrotask(() => {
        inputRef.current?.focus()
        inputRef.current?.select?.()
      })
    }
  }, [active, value])

  if (!active) {
    return (
      <div
        onDoubleClick={(e) => { e.stopPropagation(); onActivate() }}
        title="Double-click to edit"
        className={`truncate px-1.5 py-0.5 rounded cursor-text select-text
                    hover:bg-hover ${displayClass}`}
      >
        {renderDisplay
          ? renderDisplay(value)
          : (value === '' || value == null
            ? <span className="text-fg-muted italic">{placeholder ?? '—'}</span>
            : value)}
      </div>
    )
  }

  const commit = () => { onCommit(buffer); onDeactivate() }
  const revert = () => { onDeactivate() }

  return (
    <input
      ref={inputRef}
      value={buffer}
      list={list}
      onChange={(e) => setBuffer(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        else if (e.key === 'Escape') { e.preventDefault(); revert() }
      }}
      onBlur={commit}
      placeholder={placeholder}
      className={`w-full bg-panel border border-accent rounded px-1.5 py-0.5
                  text-[12px] font-mono text-fg-primary outline-none ${inputClass}`}
    />
  )
}

/**
 * ColumnsView — always-live editable grid (DBeaver-style).
 *
 * Every cell starts as a read-only label.  Double-clicking a cell makes
 * that single cell editable; Enter / blur commits, Escape reverts.
 * Checkboxes (Not Null / AI) toggle on a single click — they're
 * already trivially "editable".  The PK 🔑 icon is surfaced on the
 * name cell for columns that originated as primary keys so users
 * don't accidentally rename them.
 *
 * Sorting
 * ───────
 * Clicking a sortable column header toggles asc → desc → unsorted.
 * Sorting is *display only*: it affects which rows appear where on
 * screen but does NOT mutate the draft's true ordinal order.  That
 * distinction matters because the ordinal order is what PreviewAlter
 * diffs against to emit AFTER clauses — sorting by Name must not be
 * interpreted as the user reordering columns.
 *
 * While a sort is active the ↑/↓ reorder arrows are disabled to avoid
 * the confusing situation of clicking "move up" on a row that is in
 * alphabetical position, not table position.  The user can either
 * switch back to "unsorted" or use Add / Remove which are position-
 * independent.
 */

// Sortable header — visually aligned with the plain <TH> component but
// clickable and decorated with a sort-direction glyph.  Matches the
// sticky/border styling of TH so sortable and non-sortable headers sit
// on the same visual baseline inside the same <thead> row.
function SortableTH({ label, field, sortField, sortDir, onSort, center = false }) {
  const active = sortField === field
  return (
    <th
      onClick={() => onSort(field)}
      className={`sticky top-0 z-10 px-3 py-1.5 text-[11px] font-semibold
                  uppercase tracking-wider border-b border-r border-line-subtle
                  whitespace-nowrap select-none cursor-pointer transition-colors
                  hover:bg-hover ${center ? 'text-center' : 'text-left'}
                  ${active ? 'bg-hover text-accent' : 'bg-titlebar text-fg-muted'}`}
    >
      <span className={`inline-flex items-center gap-1 ${center ? 'justify-center' : ''}`}>
        {label}
        {active
          ? (sortDir === 'asc'
              ? <ArrowUp size={10} />
              : <ArrowDown size={10} />)
          : <ArrowUpDown size={10} className="opacity-40" />}
      </span>
    </th>
  )
}

function compareColumns(a, b, field, dir) {
  const mul = dir === 'desc' ? -1 : 1
  let av, bv
  switch (field) {
    case 'name':    av = (a.name ?? '').toLowerCase();    bv = (b.name ?? '').toLowerCase();    break
    case 'type':    av = (a.type ?? '').toLowerCase();    bv = (b.type ?? '').toLowerCase();    break
    case 'notNull': av = a.notNull ? 1 : 0;               bv = b.notNull ? 1 : 0;               break
    case 'default': av = (a.hasDefault ? a.default : ''); bv = (b.hasDefault ? b.default : ''); break
    case 'comment': av = (a.comment ?? '').toLowerCase(); bv = (b.comment ?? '').toLowerCase(); break
    default:        return 0
  }
  if (av < bv) return -1 * mul
  if (av > bv) return  1 * mul
  return 0
}

function ColumnsView({ columns, onChange, selectedIdx, setSelectedIdx, pkNames }) {
  // activeCell stores "<row>:<field>" so only one cell can be live at a
  // time.  null = no cell editing, matching the DBeaver default state.
  const [activeCell, setActiveCell] = useState(null)
  const [sortField, setSortField]   = useState(null)       // null = unsorted (original ordinal)
  const [sortDir, setSortDir]       = useState('asc')      // 'asc' | 'desc'

  // View rows are (col, realIdx) pairs.  realIdx points back into
  // `columns` so patch / move / remove keep operating on draft order.
  const viewRows = useMemo(() => {
    const pairs = columns.map((col, realIdx) => ({ col, realIdx }))
    if (!sortField) return pairs
    return pairs.slice().sort((a, b) => compareColumns(a.col, b.col, sortField, sortDir))
  }, [columns, sortField, sortDir])

  const onSort = useCallback((field) => {
    setSortField((prev) => {
      if (prev !== field) { setSortDir('asc'); return field }
      // Same field clicked — cycle asc → desc → unsorted.
      if (sortDir === 'asc')  { setSortDir('desc'); return field }
      setSortDir('asc')
      return null
    })
  }, [sortDir])

  const patch = useCallback((realIdx, delta) => {
    onChange((prev) => prev.map((c, i) => (i === realIdx ? { ...c, ...delta } : c)))
  }, [onChange])

  const move = useCallback((realIdx, dir) => {
    onChange((prev) => {
      const target = realIdx + dir
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      ;[next[realIdx], next[target]] = [next[target], next[realIdx]]
      return next
    })
    setSelectedIdx(realIdx + dir)
  }, [onChange, setSelectedIdx])

  const cellKey = (row, field) => `${row}:${field}`
  const isActive = (row, field) => activeCell === cellKey(row, field)
  const activate   = (row, field) => setActiveCell(cellKey(row, field))
  const deactivate = () => setActiveCell(null)

  const sorted = sortField !== null

  return (
    <div className="h-full overflow-auto">
      <datalist id="type-list">
        {DATA_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
      </datalist>
      <table className="w-full border-collapse text-[12.5px]">
        <thead><tr>
          <TH>#</TH>
          <SortableTH label="Name"      field="name"    sortField={sortField} sortDir={sortDir} onSort={onSort} />
          <SortableTH label="Data Type" field="type"    sortField={sortField} sortDir={sortDir} onSort={onSort} />
          <SortableTH label="Not Null"  field="notNull" sortField={sortField} sortDir={sortDir} onSort={onSort} center />
          <TH center>AI</TH>
          <SortableTH label="Default"   field="default" sortField={sortField} sortDir={sortDir} onSort={onSort} />
          <SortableTH label="Comment"   field="comment" sortField={sortField} sortDir={sortDir} onSort={onSort} />
          <TH center>Order</TH>
        </tr></thead>
        <tbody>
          {viewRows.map(({ col, realIdx }) => {
            const isNew    = !col.originalName
            const isPK     = pkNames?.has(col.originalName)
            const selected = selectedIdx === realIdx
            return (
              <tr key={col._key ?? realIdx}
                onClick={() => setSelectedIdx(realIdx)}
                className={`transition-colors ${selected ? 'bg-active' : 'hover:bg-hover'}`}>
                <TD className="text-right text-[11px] w-8 select-none tabular-nums">
                  <span className={isNew ? 'text-success font-semibold' : 'text-fg-muted'}>
                    {isNew ? '+' : realIdx + 1}
                  </span>
                </TD>
                <TD className={isPK ? 'font-medium text-syntax-pk' : 'font-medium text-fg-primary'}>
                  <div className="flex items-center">
                    {isPK && <span className="mr-1.5 text-[10px] flex-shrink-0">🔑</span>}
                    <div className="flex-1 min-w-0">
                      <InlineCell
                        value={col.name}
                        onCommit={(v) => patch(realIdx, { name: v })}
                        active={isActive(realIdx, 'name')}
                        onActivate={() => activate(realIdx, 'name')}
                        onDeactivate={deactivate}
                        placeholder="column_name"
                        displayClass="font-mono"
                        inputClass="text-fg-primary"
                      />
                    </div>
                  </div>
                </TD>
                <TD>
                  <InlineCell
                    value={col.type}
                    onCommit={(v) => patch(realIdx, { type: v })}
                    active={isActive(realIdx, 'type')}
                    onActivate={() => activate(realIdx, 'type')}
                    onDeactivate={deactivate}
                    list="type-list"
                    placeholder="varchar(64)"
                    displayClass="font-mono text-syntax-string"
                    inputClass="text-syntax-string"
                  />
                </TD>
                <TD center>
                  <input
                    type="checkbox"
                    checked={col.notNull}
                    onChange={(e) => patch(realIdx, { notNull: e.target.checked })}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-accent cursor-pointer"
                  />
                </TD>
                <TD center>
                  <input
                    type="checkbox"
                    checked={col.autoIncrement}
                    onChange={(e) => patch(realIdx, { autoIncrement: e.target.checked })}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-accent cursor-pointer"
                  />
                </TD>
                <TD>
                  <InlineCell
                    value={col.hasDefault ? col.default : ''}
                    onCommit={(v) => patch(realIdx, { default: v, hasDefault: v !== '' })}
                    active={isActive(realIdx, 'default')}
                    onActivate={() => activate(realIdx, 'default')}
                    onDeactivate={deactivate}
                    placeholder="NULL"
                    displayClass="font-mono text-syntax-pk"
                    inputClass="text-syntax-pk"
                  />
                </TD>
                <TD>
                  <InlineCell
                    value={col.comment}
                    onCommit={(v) => patch(realIdx, { comment: v })}
                    active={isActive(realIdx, 'comment')}
                    onActivate={() => activate(realIdx, 'comment')}
                    onDeactivate={deactivate}
                    placeholder="—"
                    displayClass="text-fg-secondary"
                    inputClass="text-fg-primary"
                  />
                </TD>
                <TD center>
                  <div className="inline-flex items-center gap-0.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); move(realIdx, -1) }}
                      disabled={sorted || realIdx === 0}
                      title={sorted ? 'Disable sort to reorder' : 'Move up'}
                      className="p-0.5 text-fg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
                    ><ArrowUp size={12} /></button>
                    <button
                      onClick={(e) => { e.stopPropagation(); move(realIdx, 1) }}
                      disabled={sorted || realIdx === columns.length - 1}
                      title={sorted ? 'Disable sort to reorder' : 'Move down'}
                      className="p-0.5 text-fg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
                    ><ArrowDown size={12} /></button>
                  </div>
                </TD>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Async-state wrapper — every advanced view renders one of these states.
// ─────────────────────────────────────────────────────────────────────────────
function AsyncGate({ loading, error, isEmpty, emptyLabel, onRetry, children }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-fg-muted text-[12px]">
        <div className="w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        Loading {emptyLabel}…
      </div>
    )
  }
  if (error) {
    // Belt-and-suspenders: even though every setter above funnels through
    // normalizeError, a stray non-string here would re-introduce the
    // "Objects are not valid as a React child" crash — so we coerce once
    // more at the render boundary.
    const errText = typeof error === 'string' ? error : normalizeError(error)
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
        <div className="text-danger font-semibold text-[13px]">Failed to load {emptyLabel}</div>
        <pre className="text-fg-primary text-[11px] font-mono whitespace-pre-wrap bg-elevated
                         rounded p-2 border border-line-subtle max-w-full">{errText}</pre>
        {onRetry && (
          <button onClick={onRetry}
            className="px-3 py-1 text-[12px] rounded border border-line text-fg-primary
                       hover:bg-hover transition-colors">
            Retry
          </button>
        )}
      </div>
    )
  }
  if (isEmpty) return <EmptyState label={emptyLabel} />
  return children
}

function IndexesView({ indexes, loading, error, onRetry }) {
  return (
    <AsyncGate loading={loading} error={error} onRetry={onRetry}
      isEmpty={!indexes?.length} emptyLabel="indexes">
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><TH>Name</TH><TH>Type</TH><TH center>Unique</TH><TH>Columns</TH><TH>Comment</TH></tr></thead>
          <tbody>
            {(indexes ?? []).map((idx) => (
              <tr key={idx.name} className="hover:bg-hover transition-colors">
                <TD className="font-medium text-fg-primary">{idx.name}</TD>
                <TD className="text-fg-muted">{idx.type}</TD>
                <TD center><BoolCell value={idx.unique} /></TD>
                <TD mono>{(idx.columns ?? []).join(', ')}</TD>
                <TD className="text-fg-muted text-[12px]">{idx.comment}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AsyncGate>
  )
}

function ConstraintsView({ constraints, loading, error, onRetry }) {
  return (
    <AsyncGate loading={loading} error={error} onRetry={onRetry}
      isEmpty={!constraints?.length} emptyLabel="constraints">
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr><TH>Name</TH><TH>Type</TH><TH>Columns</TH></tr></thead>
          <tbody>
            {(constraints ?? []).map((c) => (
              <tr key={c.name} className="hover:bg-hover transition-colors">
                <TD className="font-medium text-fg-primary">{c.name}</TD>
                <TD className="text-success">{c.type}</TD>
                <TD mono>{(c.columns ?? []).join(', ')}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AsyncGate>
  )
}

function ForeignKeysView({ foreignKeys, loading, error, onRetry }) {
  return (
    <AsyncGate loading={loading} error={error} onRetry={onRetry}
      isEmpty={!foreignKeys?.length} emptyLabel="foreign keys">
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr>
            <TH>Name</TH><TH>Columns</TH><TH>Ref Schema</TH><TH>Ref Table</TH>
            <TH>Ref Columns</TH><TH>On Delete</TH><TH>On Update</TH>
          </tr></thead>
          <tbody>
            {(foreignKeys ?? []).map((fk) => (
              <tr key={fk.name} className="hover:bg-hover transition-colors">
                <TD className="font-medium text-fg-primary">{fk.name}</TD>
                <TD mono>{(fk.columns ?? []).join(', ')}</TD>
                <TD className="text-syntax-keyword">{fk.refSchema}</TD>
                <TD className="text-syntax-keyword">{fk.refTable}</TD>
                <TD mono>{(fk.refColumns ?? []).join(', ')}</TD>
                <TD className="text-fg-muted">{fk.onDelete}</TD>
                <TD className="text-fg-muted">{fk.onUpdate}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AsyncGate>
  )
}

function ReferencesView({ references, loading, error, onRetry }) {
  return (
    <AsyncGate loading={loading} error={error} onRetry={onRetry}
      isEmpty={!references?.length} emptyLabel="references">
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr>
            <TH>Name</TH><TH>From Schema</TH><TH>From Table</TH>
            <TH>From Columns</TH><TH>To Columns</TH><TH>On Delete</TH><TH>On Update</TH>
          </tr></thead>
          <tbody>
            {(references ?? []).map((r) => (
              <tr key={`${r.fromSchema}.${r.fromTable}.${r.name}`}
                  className="hover:bg-hover transition-colors">
                <TD className="font-medium text-fg-primary">{r.name}</TD>
                <TD className="text-syntax-keyword">{r.fromSchema}</TD>
                <TD className="text-syntax-keyword">{r.fromTable}</TD>
                <TD mono>{(r.fromCols ?? []).join(', ')}</TD>
                <TD mono>{(r.toCols ?? []).join(', ')}</TD>
                <TD className="text-fg-muted">{r.onDelete}</TD>
                <TD className="text-fg-muted">{r.onUpdate}</TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AsyncGate>
  )
}

function TriggersView({ triggers, loading, error, onRetry }) {
  return (
    <AsyncGate loading={loading} error={error} onRetry={onRetry}
      isEmpty={!triggers?.length} emptyLabel="triggers">
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead><tr>
            <TH>Name</TH><TH>Timing</TH><TH>Event</TH><TH>Statement</TH>
          </tr></thead>
          <tbody>
            {(triggers ?? []).map((t) => (
              <tr key={t.name} className="hover:bg-hover transition-colors align-top">
                <TD className="font-medium text-fg-primary">{t.name}</TD>
                <TD className="text-success">{t.timing}</TD>
                <TD className="text-syntax-pk">{t.event}</TD>
                <TD mono className="max-w-[640px]">
                  <pre className="whitespace-pre-wrap break-words text-[11.5px] leading-[1.45]">{t.statement}</pre>
                </TD>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AsyncGate>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DDLView — read-only Monaco editor (sql / vs-dark) + Copy button.
// ─────────────────────────────────────────────────────────────────────────────
function DDLView({ ddl, loading, error, onRetry }) {
  const [copied, setCopied] = useState(false)
  const { resolvedTheme } = useTheme()
  const copy = useCallback(() => {
    if (!ddl) return
    navigator.clipboard.writeText(ddl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }, [ddl])

  // The editor is heavyweight; we only mount it once we actually have a
  // DDL string to avoid a visible layout jump while loading.
  if (loading || error || !ddl) {
    return (
      <AsyncGate loading={loading} error={error} onRetry={onRetry}
        isEmpty={!ddl} emptyLabel="DDL">
        <div />
      </AsyncGate>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 bg-titlebar
                      border-b border-line-subtle flex-shrink-0">
        <span className="text-[11px] text-fg-muted select-none">Read-only · SHOW CREATE TABLE</span>
        <button onClick={copy}
          className="text-[11px] text-fg-muted hover:text-fg-primary px-2 py-0.5 rounded
                     hover:bg-hover transition-colors select-none">
          {copied ? '✓ Copied' : '⎘ Copy'}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <Editor
          value={ddl}
          language="sql"
          theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
          options={{
            readOnly: true,
            domReadOnly: true,
            fontSize: 12,
            lineHeight: 18,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'none',
            folding: true,
            smoothScrolling: true,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// useAdvancedProperties — one round-trip, loaded the first time the user
// opens a section that needs it (Indexes, Constraints, FKs, References,
// Triggers, DDL).  Columns is served from the SQLite cache (schema prop)
// so opening Properties has zero live-query cost.
//
// The single shared loader means that if the user clicks Indexes then later
// clicks DDL we don't pay for a second round-trip — all six derived views
// come from the same payload.
// ─────────────────────────────────────────────────────────────────────────────
const ADVANCED_SECTIONS = new Set(['indexes', 'constraints', 'foreignkeys', 'references', 'triggers', 'ddl'])

function useAdvancedProperties(connId, dbName, tableName) {
  const [state, setState] = useState({ data: null, loading: false, error: '' })
  const [loadToken, setLoadToken] = useState(0)

  const load = useCallback(() => setLoadToken((t) => t + 1), [])

  useEffect(() => {
    if (loadToken === 0) return   // not triggered yet
    let cancelled = false

    setState((s) => ({ ...s, loading: true, error: '' }))
    getTableAdvancedProperties(connId, dbName, tableName)
      .then((data) => {
        if (cancelled) return
        setState({ data, loading: false, error: '' })
      })
      .catch((err) => {
        if (cancelled) return
        // Always store a string — the AsyncGate renders this directly
        // into JSX and React would crash the whole tab if `error` were
        // ever a raw object (white-screen regression).
        setState({ data: null, loading: false, error: normalizeError(err) })
      })

    return () => { cancelled = true }
  }, [connId, dbName, tableName, loadToken])

  // Reset cached payload when the table identity changes so a new tab
  // doesn't briefly show the previous table's DDL.
  useEffect(() => {
    setState({ data: null, loading: false, error: '' })
    setLoadToken(0)
  }, [connId, dbName, tableName])

  return { ...state, load }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Designer draft (Phase 20)
//
// `useSchemaDraft` owns the editable mirror of the table info + columns.
// Editing is entered via enterEdit(); cancelEdit() snaps back to the
// original snapshot.  isDirty is a strict structural comparison so
// typing-then-deleting a character keeps the footer hidden.
//
// Columns acquire a stable React key (_key) the moment they enter the
// draft — never derived from the possibly-mutated Name field — so a
// rename doesn't unmount/remount the input and lose focus.
// ─────────────────────────────────────────────────────────────────────────────
let _draftSeq = 0
function nextKey() { _draftSeq += 1; return `col_${_draftSeq}` }

function toDraftColumn(c) {
  return {
    _key: nextKey(),
    originalName:  c.name ?? '',
    name:          c.name ?? '',
    type:          c.type ?? '',
    notNull:       !!c.notNull,
    autoIncrement: !!c.ai,
    hasDefault:    c.default !== null && c.default !== undefined,
    default:       c.default == null ? '' : String(c.default),
    comment:       c.comment ?? '',
  }
}

function toDraftInfo(info) {
  return {
    name:          info?.name          ?? '',
    engine:        info?.engine        ?? '',
    collation:     info?.collation     ?? '',
    charset:       info?.charset       ?? '',
    autoIncrement: info?.autoIncrement ?? null,
    comment:       info?.comment       ?? '',
  }
}

function columnsEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i]
    if (x.originalName  !== y.originalName)  return false
    if (x.name          !== y.name)          return false
    if (x.type          !== y.type)          return false
    if (x.notNull       !== y.notNull)       return false
    if (x.autoIncrement !== y.autoIncrement) return false
    if (x.hasDefault    !== y.hasDefault)    return false
    if (x.default       !== y.default)       return false
    if (x.comment       !== y.comment)       return false
  }
  return true
}

function infoEqual(a, b) {
  return a.name          === b.name
      && a.engine        === b.engine
      && a.collation     === b.collation
      && a.charset       === b.charset
      && a.autoIncrement === b.autoIncrement
      && a.comment       === b.comment
}

/**
 * useSchemaDraft — always-live draft bound to the current schema.
 *
 * There is no explicit "edit mode" flag: the draft starts as an exact
 * copy of the loaded schema, dirty-tracking surfaces the Save/Cancel
 * footer whenever the user deviates from it, and `cancel()` snaps back
 * to the pristine snapshot.
 *
 * Cells in the grid are static labels until the user double-clicks one,
 * at which point only that single cell becomes editable — matching the
 * DBeaver interaction model.
 */
function useSchemaDraft(schema) {
  const [draftCols, setDraftCols]     = useState([])
  const [draftInfo, setDraftInfo]     = useState({
    name: '', engine: '', collation: '', charset: '', autoIncrement: null, comment: '',
  })
  const [selectedIdx, setSelectedIdx] = useState(null)

  // Baseline snapshots used for both dirty-checking AND building the
  // PreviewAlter request's `old*` fields.  Re-captured whenever the
  // underlying schema prop identity changes (tab switched to a new table,
  // or schema reloaded after a successful ALTER).
  const baseline = useRef({
    cols: [],
    info: { name: '', engine: '', collation: '', charset: '', autoIncrement: null, comment: '' },
  })

  // Sync baseline + draft from the live schema whenever it changes.
  useEffect(() => {
    const cols = (schema.columns ?? []).map(toDraftColumn)
    const info = toDraftInfo(schema.info)
    baseline.current = {
      cols: cols.map((c) => ({ ...c })),
      info: { ...info },
    }
    setDraftCols(cols)
    setDraftInfo(info)
    setSelectedIdx(null)
  }, [schema])

  const cancel = useCallback(() => {
    setDraftCols(baseline.current.cols.map((c) => ({ ...c, _key: nextKey() })))
    setDraftInfo({ ...baseline.current.info })
    setSelectedIdx(null)
  }, [])

  const addColumn = useCallback(() => {
    setDraftCols((prev) => {
      const next = [
        ...prev,
        { _key: nextKey(), originalName: '', name: '', type: 'varchar(64)',
          notNull: false, autoIncrement: false, hasDefault: false, default: '', comment: '' },
      ]
      setSelectedIdx(next.length - 1)
      return next
    })
  }, [])

  const removeColumn = useCallback((idx) => {
    setDraftCols((prev) => prev.filter((_, i) => i !== idx))
    setSelectedIdx(null)
  }, [])

  const isDirty = useMemo(() => {
    return !columnsEqual(draftCols, baseline.current.cols) ||
           !infoEqual(draftInfo, baseline.current.info)
  }, [draftCols, draftInfo])

  // Build the SchemaChangeRequest payload expected by previewTableAlter.
  // Strips React-local fields (_key) so the JSON bridge payload stays tidy.
  const buildRequest = useCallback((schemaName, tableName) => {
    const strip = (c) => ({
      originalName:  c.originalName,
      name:          c.name,
      type:          c.type,
      notNull:       !!c.notNull,
      autoIncrement: !!c.autoIncrement,
      hasDefault:    !!c.hasDefault,
      default:       c.default,
      comment:       c.comment,
    })
    return {
      schema: schemaName,
      table:  tableName,
      originalInfo: { ...baseline.current.info },
      updatedInfo:  { ...draftInfo },
      oldColumns: baseline.current.cols.map(strip),
      newColumns: draftCols.map(strip),
    }
  }, [draftCols, draftInfo])

  return {
    draftCols, setDraftCols,
    draftInfo, patchInfo: (p) => setDraftInfo((prev) => ({ ...prev, ...p })),
    selectedIdx, setSelectedIdx,
    addColumn, removeColumn,
    isDirty, cancel, buildRequest,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties view (top panel + sidebar + detail)
// ─────────────────────────────────────────────────────────────────────────────
function PropertiesView({ schema, connId, dbName, tableName, onSchemaChanged }) {
  const [section, setSection] = useState('columns')
  const adv = useAdvancedProperties(connId, dbName, tableName)
  const draft = useSchemaDraft(schema)

  // Review/Execute modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [preview,   setPreview]   = useState(null)
  const [running,   setRunning]   = useState(false)
  const [result,    setResult]    = useState(null)
  const [previewError, setPreviewError] = useState('')

  const openPreview = useCallback(async () => {
    setPreviewError('')
    setResult(null)
    const req = draft.buildRequest(dbName, tableName)
    try {
      const pv = await previewTableAlter(connId, req)
      setPreview(pv)
      setModalOpen(true)
    } catch (err) {
      const msg = normalizeError(err)
      setPreviewError(msg)
      toast.error(`Preview failed: ${msg}`)
    }
  }, [connId, dbName, tableName, draft])

  const runExecute = useCallback(async () => {
    setRunning(true)
    setResult(null)
    const req = draft.buildRequest(dbName, tableName)
    try {
      const res = await executeTableAlter(connId, req)
      setResult(res)
      if (res?.success) {
        toast.success(
          `Schema updated · ${res.executedCount} statement${res.executedCount === 1 ? '' : 's'} executed`,
        )
        // Let the parent refresh whatever needs it (advanced props cache,
        // columns cache).  Small delay so the user can read the success
        // message before the modal closes; once the reloaded schema flows
        // back into useSchemaDraft the dirty footer disappears on its own.
        setTimeout(() => {
          setModalOpen(false)
          setResult(null)
          onSchemaChanged?.()
        }, 800)
      } else if (res && !res.success) {
        // Server-reported failure (DDL applied partially or rejected).
        toast.error(`Schema update failed: ${normalizeError(res.error) || 'Unknown error'}`)
      }
    } catch (err) {
      const msg = normalizeError(err)
      setResult({ success: false, executedCount: 0, failedIndex: 0,
        failedStatement: '', error: msg, statements: [] })
      toast.error(`Schema update failed: ${msg}`)
    } finally {
      setRunning(false)
    }
  }, [connId, dbName, tableName, draft, onSchemaChanged])

  // Trigger advanced round-trip the first time user enters an advanced section.
  useEffect(() => {
    if (ADVANCED_SECTIONS.has(section) && !adv.data && !adv.loading && !adv.error) {
      adv.load()
    }
  }, [section, adv])

  // Primary-key name set so the ColumnsView can render the 🔑 glyph
  // for columns that originated as PKs in the loaded schema.
  const pkNames = useMemo(() => {
    const s = new Set()
    for (const c of schema.columns ?? []) if (c.key === 'PRI') s.add(c.name)
    return s
  }, [schema.columns])

  const detail = () => {
    switch (section) {
      case 'columns':
        return <ColumnsView
          columns={draft.draftCols}
          onChange={draft.setDraftCols}
          selectedIdx={draft.selectedIdx}
          setSelectedIdx={draft.setSelectedIdx}
          pkNames={pkNames} />
      case 'indexes':
        return <IndexesView
          indexes={adv.data?.indexes}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      case 'constraints':
        return <ConstraintsView
          constraints={adv.data?.constraints}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      case 'foreignkeys':
        return <ForeignKeysView
          foreignKeys={adv.data?.foreignKeys}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      case 'references':
        return <ReferencesView
          references={adv.data?.references}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      case 'triggers':
        return <TriggersView
          triggers={adv.data?.triggers}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      case 'ddl':
        return <DDLView
          ddl={adv.data?.ddl}
          loading={adv.loading} error={adv.error} onRetry={adv.load} />
      default:
        return <EmptyState label={SIDEBAR_ITEMS.find(s => s.id === section)?.label.toLowerCase()} />
    }
  }

  const activeItem = SIDEBAR_ITEMS.find((s) => s.id === section)
  const columnsCount = draft.draftCols.length
  const detailCount = useMemo(() => {
    switch (section) {
      case 'columns':     return columnsCount
      case 'indexes':     return adv.data?.indexes?.length     ?? null
      case 'constraints': return adv.data?.constraints?.length ?? null
      case 'foreignkeys': return adv.data?.foreignKeys?.length ?? null
      case 'references':  return adv.data?.references?.length  ?? null
      case 'triggers':    return adv.data?.triggers?.length    ?? null
      default:            return null
    }
  }, [section, columnsCount, adv.data])

  return (
    <div className="flex flex-col h-full overflow-hidden relative">
      <TableInfoPanel
        info={{ ...schema.info, ...draft.draftInfo }}
        onPatch={draft.patchInfo}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left sidebar */}
        <div className="flex flex-col w-40 flex-shrink-0 bg-titlebar border-r border-line-subtle overflow-y-auto py-1">
          {SIDEBAR_ITEMS.map((item) => {
            const active = section === item.id
            return (
              <button key={item.id}
                onClick={() => setSection(item.id)}
                className={[
                  'flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left transition-colors',
                  'select-none border-l-2',
                  active
                    ? 'border-l-accent bg-active text-fg-on-accent font-medium'
                    : 'border-l-transparent text-fg-secondary hover:bg-hover',
                ].join(' ')}>
                <span className={`text-[11px] w-4 text-center flex-shrink-0 ${active ? 'text-accent' : 'text-fg-muted'}`}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </div>

        {/* Detail area */}
        <div className="flex-1 flex flex-col overflow-hidden bg-app">
          <div className="flex items-center px-3 py-1 bg-titlebar border-b border-line-subtle flex-shrink-0 text-[11px] gap-2">
            <span className="font-medium text-fg-secondary">{activeItem?.label}</span>
            {detailCount !== null && (
              <span className="text-fg-muted">· {detailCount} item{detailCount !== 1 ? 's' : ''}</span>
            )}
            {section === 'columns' && (
              <span className="text-[10px] text-fg-muted italic">· double-click a cell to edit · click header to sort</span>
            )}
            {ADVANCED_SECTIONS.has(section) && adv.data && !adv.loading && !adv.error && (
              <span className="ml-auto text-[10px] text-success select-none">✓ live</span>
            )}

            {/* Columns section — always-on add / remove toolbar */}
            {section === 'columns' && (
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={draft.addColumn}
                  title="Add column"
                  className="flex items-center gap-1 px-2 py-0.5 rounded border border-line-subtle
                             text-success hover:bg-hover transition-colors"
                >
                  <Plus size={11} /> Column
                </button>
                <button
                  onClick={() => draft.selectedIdx !== null && draft.removeColumn(draft.selectedIdx)}
                  disabled={draft.selectedIdx === null}
                  title="Remove selected column (click a row first)"
                  className="flex items-center gap-1 px-2 py-0.5 rounded border border-line-subtle
                             text-danger hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed
                             transition-colors"
                >
                  <Minus size={11} /> Remove
                </button>
              </div>
            )}
          </div>
          <div className="flex-1 overflow-hidden">
            {detail()}
          </div>
        </div>
      </div>

      {/* Dirty footer — Save / Cancel floating above the main panel */}
      {draft.isDirty && (
        <div className="flex-shrink-0 flex items-center justify-between px-4 py-2
                        bg-warn-bg border-t-2 border-warn text-[12px]">
          <div className="flex items-center gap-2 text-warn">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
            <span>Unsaved schema changes</span>
          </div>
          {previewError && (
            <span className="text-danger text-[11px]">{previewError}</span>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={draft.cancel}
              className="flex items-center gap-1 px-3 py-1 rounded border border-line
                         text-fg-secondary hover:bg-hover transition-colors"
            >
              <XCircle size={12} /> Cancel
            </button>
            <button
              onClick={openPreview}
              className="flex items-center gap-1.5 px-3 py-1 rounded
                         bg-accent hover:bg-accent-hover text-fg-on-accent font-medium transition-colors"
            >
              <Save size={12} /> Review & Save
            </button>
          </div>
        </div>
      )}

      <ReviewSqlModal
        isOpen={modalOpen}
        preview={preview}
        result={result}
        running={running}
        onClose={() => {
          if (running) return
          setModalOpen(false)
          setResult(null)
        }}
        onExecute={runExecute}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier quoting helper (Phase 14)
//
// MySQL identifiers are quoted with backticks; any literal ` inside the name
// must be doubled.  Defensive quoting here means the auto-generated
// SELECT can survive even exotic table / schema names that contain
// backticks, periods, or reserved words.
// ─────────────────────────────────────────────────────────────────────────────
const quoteIdent = (s) => `\`${String(s).replace(/`/g, '``')}\``

/**
 * buildSelectSql — constructs a paginated "SELECT * FROM `db`.`tbl`
 * LIMIT <pageSize> OFFSET <(page-1)*pageSize>" statement.
 *
 * `dbName` is optional: when absent (empty string / undefined, e.g. during
 * unit tests) we fall back to the unqualified form so old call-sites keep
 * working.  In production, App.jsx always feeds TableViewer a non-empty
 * dbName, so every live query is fully qualified and MySQL error 1046
 * ("No database selected") cannot occur.
 *
 * When `pageSize === 'all'` we still emit an explicit LIMIT so the backend
 * executor doesn't inject its own default (DefaultLimit=1000) and truncate
 * silently; the caller is expected to clamp 'all' to backendHardCap first.
 */
function buildSelectSql(dbName, tableName, pageSize, currentPage = 1) {
  const target = dbName
    ? `${quoteIdent(dbName)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName)
  const page   = Math.max(1, currentPage | 0)
  const limit  = pageSize === 'all' ? BACKEND_HARD_CAP : Math.max(1, pageSize | 0)
  const offset = pageSize === 'all' ? 0 : (page - 1) * limit
  return offset > 0
    ? `SELECT * FROM ${target} LIMIT ${limit} OFFSET ${offset}`
    : `SELECT * FROM ${target} LIMIT ${limit}`
}

/**
 * buildCountSql — exact row count.  Fast for small/medium tables; for very
 * large tables it is O(n) on InnoDB and we fall back to an estimate via
 * buildApproxCountSql if it times out.
 */
function buildCountSql(dbName, tableName) {
  const target = dbName
    ? `${quoteIdent(dbName)}.${quoteIdent(tableName)}`
    : quoteIdent(tableName)
  return `SELECT COUNT(*) AS n FROM ${target}`
}

/**
 * BACKEND_HARD_CAP must stay in sync with `maxQueryRows` in app.go (currently
 * 1000).  We reject page sizes above this because the backend will truncate
 * and the grid would silently drop rows.
 */
const BACKEND_HARD_CAP = 1000

/**
 * buildColumnMetaSql — returns a query that lists every column of `tableName`
 * together with the EXTRA and COLUMN_DEFAULT fields from
 * `INFORMATION_SCHEMA.COLUMNS`.  The result is used to identify columns that
 * the database fills automatically (AUTO_INCREMENT, CURRENT_TIMESTAMP,
 * generated, etc.) so Duplicate-Row can leave them blank.
 *
 * We embed the literals as quoted strings rather than using parameter binds
 * because the existing runQuery() bridge has no parameter passing.  Both
 * `dbName` and `tableName` come from trusted local sources (the schema
 * cache + selected tab), but we still escape any embedded single quote as
 * a defensive measure.
 */
function buildColumnMetaSql(dbName, tableName) {
  const esc = (s) => String(s).replace(/'/g, "''")
  return (
    "SELECT COLUMN_NAME, EXTRA, COLUMN_DEFAULT " +
    "FROM INFORMATION_SCHEMA.COLUMNS " +
    `WHERE TABLE_SCHEMA = '${esc(dbName)}' AND TABLE_NAME = '${esc(tableName)}' ` +
    "ORDER BY ORDINAL_POSITION"
  )
}

/**
 * isAutoFilledColumn — heuristic for "the database will fill this in for me
 * if I omit it during INSERT".  Used to decide which columns to skip when
 * duplicating a row so the new row gets fresh ids/timestamps instead of a
 * stale copy.
 *
 * Matches:
 *   • EXTRA contains "auto_increment"        — surrogate PKs
 *   • EXTRA contains "default_generated"     — expression default
 *   • EXTRA contains "on update"             — updated_at columns
 *   • EXTRA contains "virtual" / "stored generated"
 *   • COLUMN_DEFAULT is CURRENT_TIMESTAMP / NOW() (any case, with optional
 *     parens or fractional-seconds spec like "CURRENT_TIMESTAMP(3)")
 */
function isAutoFilledColumn(extra, columnDefault) {
  const ex = String(extra ?? '').toLowerCase()
  if (
    ex.includes('auto_increment') ||
    ex.includes('default_generated') ||
    ex.includes('on update') ||
    ex.includes('virtual') ||
    ex.includes('stored generated')
  ) {
    return true
  }
  const def = String(columnDefault ?? '').trim().toLowerCase()
  if (!def) return false
  // Strip a single trailing "(n)" precision spec before matching keywords.
  const stripped = def.replace(/\s*\(\s*\d+\s*\)\s*$/, '')
  return (
    stripped === 'current_timestamp' ||
    stripped === 'now' ||
    stripped === 'now()' ||
    stripped === 'current_timestamp()' ||
    stripped === 'localtime' ||
    stripped === 'localtimestamp'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Data view — auto-loads on mount via runQuery IPC / mock
// ─────────────────────────────────────────────────────────────────────────────
function DataView({ tableName, dbName, connId, schema }) {
  const [dataResult,   setDataResult]   = useState(null)
  const [isLoading,    setIsLoading]    = useState(true)
  const [loadError,    setLoadError]    = useState('')
  // pageSize: rows per page ('all' clamps to BACKEND_HARD_CAP).
  // currentPage: 1-based; changing it refetches the corresponding slice.
  const [pageSize,     setPageSize]     = useState(100)
  const [currentPage,  setCurrentPage]  = useState(1)
  // Real table row count from SELECT COUNT(*) — the authoritative total for
  // pagination maths.  `null` while still loading / on error.
  const [totalRows,    setTotalRows]    = useState(null)
  const [isCounting,   setIsCounting]   = useState(true)
  const [countError,   setCountError]   = useState('')
  const [fetchStats,   setFetchStats]   = useState(null)
  const [saveError,    setSaveError]    = useState('')
  const [isSaving,     setIsSaving]     = useState(false)
  // Names of columns the database fills for us — informs Duplicate Row
  // behaviour.  Empty until the metadata query resolves; if the query
  // fails (no privileges on INFORMATION_SCHEMA, etc.) we degrade to
  // copying every cell, which is the historical behaviour.
  const [autoFilledColumns, setAutoFilledColumns] = useState(() => new Set())

  // Primary-key column name is required for UPDATE/DELETE; pulled from the
  // Properties schema so the applier can build precise WHERE clauses.
  const pkName = useMemo(() => {
    const pk = (schema?.columns ?? []).find((c) => c.key === 'PRI')
    return pk?.name ?? ''
  }, [schema])

  // SQL surfaced to the thin info bar: always reflects the next planned
  // fetch so operators can see exactly which LIMIT/OFFSET is in flight.
  const selectSql = buildSelectSql(dbName, tableName, pageSize, currentPage)

  // ── Count(*) — runs once per (connId, dbName, tableName) + on Refresh.
  // The count is the authoritative pagination total; we keep it separate
  // from the page fetch so the footer updates immediately when the user
  // changes pageSize/currentPage without re-counting. ─────────────────────
  const loadCount = useCallback(() => {
    let cancelled = false
    setIsCounting(true)
    setCountError('')

    runQuery(connId, buildCountSql(dbName, tableName))
      .then((result) => {
        if (cancelled) return
        if (result.error) {
          setCountError(result.error)
          setTotalRows(null)
          return
        }
        // Expect a single row with a single numeric cell.
        const n = Number(result.rows?.[0]?.[0])
        setTotalRows(Number.isFinite(n) ? n : null)
      })
      .catch((err) => {
        if (cancelled) return
        setCountError(String(err?.message ?? err))
        setTotalRows(null)
      })
      .finally(() => {
        if (!cancelled) setIsCounting(false)
      })

    return () => { cancelled = true }
  }, [connId, dbName, tableName])

  // ── Column metadata — fetched once per (connId, dbName, tableName).
  // Powers the Duplicate-Row "skip auto-filled columns" behaviour.  A
  // failure here is non-fatal: we just fall back to copying every cell.
  const loadColumnMeta = useCallback(() => {
    let cancelled = false
    runQuery(connId, buildColumnMetaSql(dbName, tableName))
      .then((result) => {
        if (cancelled) return
        if (result.error || !Array.isArray(result.rows)) {
          setAutoFilledColumns(new Set())
          return
        }
        const next = new Set()
        for (const r of result.rows) {
          const [name, extra, def] = r
          if (isAutoFilledColumn(extra, def)) next.add(name)
        }
        setAutoFilledColumns(next)
      })
      .catch(() => {
        if (!cancelled) setAutoFilledColumns(new Set())
      })
    return () => { cancelled = true }
  }, [connId, dbName, tableName])

  // ── Core load function: fetches a single page slice. ───────────────────
  const load = useCallback((size, page) => {
    let cancelled = false

    setIsLoading(true)
    setLoadError('')
    setDataResult(null)

    const sql = buildSelectSql(dbName, tableName, size, page)
    const fetchStart = performance.now()

    runQuery(connId, sql)
      .then((result) => {
        if (cancelled) return
        const fetchMs = Math.round(performance.now() - fetchStart)
        if (result.error) {
          setLoadError(result.error)
        } else {
          setDataResult(result)
          setFetchStats({
            rowCount:  result.rows?.length ?? 0,
            execMs:    result.execMs ?? 0,
            fetchMs,
            timestamp: new Date(),
          })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(String(err))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => { cancelled = true }
  }, [connId, tableName, dbName])

  // Tab identity change (new table / db / conn) — reset page, reload count,
  // and refresh the auto-filled-column set used by Duplicate Row.
  useEffect(() => {
    setCurrentPage(1)
    loadCount()
    loadColumnMeta()
  }, [loadCount, loadColumnMeta])

  // Fetch the current page slice whenever identity, page or size changes.
  useEffect(() => {
    load(pageSize, currentPage)
  }, [load, pageSize, currentPage])

  // ── Refresh handler: re-query count AND re-fetch current page. ─────────
  const handleRefresh = useCallback(() => {
    loadCount()
    load(pageSize, currentPage)
  }, [load, loadCount, pageSize, currentPage])

  // ── pageSize change (footer dropdown / manual input). ──────────────────
  // 'all' clamps to the backend's hard cap so we don't silently truncate.
  // Any numeric value above the cap is also clamped with a console warning.
  // If there are unsaved edits we ask before triggering a reload that would
  // otherwise wipe them, matching the page-navigation guard.
  const handleSetPageSize = useCallback((size) => {
    let next = size
    if (size !== 'all' && size > BACKEND_HARD_CAP) {
      console.warn(
        `[TableViewer] page size ${size} exceeds backend cap ${BACKEND_HARD_CAP}; clamping.`,
      )
      next = BACKEND_HARD_CAP
    }
    if (editStateRef.current?.isDirty) {
      const ok = typeof window !== 'undefined' && window.confirm
        ? window.confirm(
            'Changing page size will reload the grid and discard your ' +
            'unsaved changes.\n\nContinue?',
          )
        : true
      if (!ok) return
      editStateRef.current.cancel()
    }
    setPageSize(next)
    setCurrentPage(1)
  }, [])

  const cols = dataResult?.columns ?? []
  const rows = dataResult?.rows    ?? []

  // ── Edit state (Phase 6.8) ─────────────────────────────────────────────
  // dataResult is used as resetKey: every table reload clears pending edits.
  // autoFilledColumns tells the hook which columns Duplicate Row should
  // leave NULL (AUTO_INCREMENT, CURRENT_TIMESTAMP defaults, generated cols).
  const editState = useEditState(cols, rows, dataResult, { autoFilledColumns })

  // Stable ref so page-change guards can read isDirty / cancel() without
  // causing the guarded-setter to be recreated every keystroke.
  const editStateRef = useRef(editState)
  useEffect(() => { editStateRef.current = editState }, [editState])

  // ── Guarded page change: ask before discarding unsaved edits. ──────────
  // We wrap setCurrentPage so the footer's navigation arrows and jump input
  // route through the same confirmation logic.
  const guardedSetCurrentPage = useCallback((nextPage) => {
    // Accept both direct values and updater functions, mirroring useState.
    setCurrentPage((prev) => {
      const target = typeof nextPage === 'function' ? nextPage(prev) : nextPage
      if (target === prev) return prev
      if (editStateRef.current?.isDirty) {
        const ok = typeof window !== 'undefined' && window.confirm
          ? window.confirm(
              'You have unsaved changes on this page.\n' +
              'Navigating will discard them.\n\nContinue?',
            )
          : true
        if (!ok) return prev
        editStateRef.current.cancel()
      }
      return target
    })
  }, [])

  // ── Save handler — commit the grid diff via the Go applier ─────────────
  // We build the ChangeSet here (not inside useEditState) because the
  // connection / database / PK identity lives at the TableViewer level.
  // On success we clear the local diff, re-count (inserts / deletes change
  // the total) and re-fetch the current page so AUTO_INCREMENT ids and
  // server-side defaults become visible immediately.
  const handleSave = useCallback(async () => {
    setSaveError('')
    if (!pkName) {
      setSaveError(
        'This table has no primary key — inline edits cannot be applied safely. ' +
        'Add a primary key in the Properties tab first.',
      )
      return
    }
    const cs = editState.buildChangeSet({
      connectionId: connId,
      database:     dbName,
      tableName,
      primaryKey:   pkName,
    })
    if (!cs) return  // nothing to commit

    setIsSaving(true)
    try {
      const result = await applyChanges(cs)
      if (result?.error) {
        setSaveError(result.error)
        return
      }
      editState.clear()
      loadCount()
      load(pageSize, currentPage)
    } catch (err) {
      setSaveError(String(err?.message ?? err))
    } finally {
      setIsSaving(false)
    }
  }, [connId, dbName, tableName, pkName, editState, load, loadCount, pageSize, currentPage])

  const handleCancel = useCallback(() => {
    setSaveError('')
    editState.cancel()
  }, [editState])

  // ── Loading state ──────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-fg-muted">
        <div className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        <span className="text-[13px]">
          Loading{' '}
          <code className="text-syntax-keyword font-mono">{dbName ? `${dbName}.` : ''}{tableName}</code>
          {' '}…
        </span>
        <span className="text-[11px] text-fg-muted">{selectSql}</span>
      </div>
    )
  }

  // ── Error state ────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex flex-col p-6 gap-3">
        <div className="text-danger font-semibold text-[14px]">Failed to load data</div>
        <pre className="text-fg-primary text-[12px] font-mono whitespace-pre-wrap bg-elevated rounded p-3 border border-line-subtle">
          {loadError}
        </pre>
        <div className="text-fg-muted text-[12px]">
          Query: <code className="text-syntax-string">{selectSql}</code>
        </div>
        <button
          onClick={() => load(pageSize, currentPage)}
          className="self-start px-3 py-1.5 text-[12px] rounded border border-line
                     text-fg-secondary hover:bg-hover transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  // ── Total rows for the footer ──────────────────────────────────────────
  // Prefer the authoritative COUNT(*) from the server.  Fall back to the
  // fetched page size when the count failed so pagination still works in a
  // best-effort degraded mode (user sees "100 rows" instead of nothing).
  // During an active edit session the "+N new · -M deleted" delta is shown
  // via footer's dirty styling; we don't inflate the total here because
  // that would confuse pagination arithmetic.
  const effectiveTotal = totalRows ?? rows.length

  // ── Data view ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Thin query info bar — shows the SQL being executed + live total. */}
      <div className="flex items-center gap-3 px-3 py-1 bg-elevated border-b border-line-subtle
                      flex-shrink-0 text-[11px] text-fg-muted">
        <code className="text-syntax-string truncate">{selectSql}</code>
        <div className="flex-1" />
        {isCounting ? (
          <span className="text-fg-muted italic">counting…</span>
        ) : countError ? (
          <span className="text-danger" title={countError}>count failed</span>
        ) : totalRows !== null ? (
          <span className="text-fg-muted tabular-nums">
            {totalRows.toLocaleString()} rows total
          </span>
        ) : null}
      </div>

      {/* DataViewer: grid / text / record mode switching + inline editing */}
      <div className="flex-1 overflow-hidden min-h-0">
        <DataViewer
          columns={cols}
          rows={rows}
          execMs={dataResult?.execMs}
          exportFilename={`${tableName}.csv`}
          editState={editState}
        />
      </div>

      {/* Save-error banner (shown only while an error is present). */}
      {saveError && (
        <div className="flex items-start gap-2 px-3 py-1.5 bg-danger-bg border-t border-danger
                        text-danger text-[12px] flex-shrink-0">
          <span className="font-semibold">Save failed:</span>
          <span className="font-mono whitespace-pre-wrap break-all flex-1">{saveError}</span>
          <button
            onClick={() => setSaveError('')}
            className="text-danger hover:text-fg-primary transition-colors"
            aria-label="Dismiss error"
          >×</button>
        </div>
      )}

      {/* ActionFooter: tools + edit actions + status strip */}
      <ActionFooter
        pageSize={pageSize}           setPageSize={handleSetPageSize}
        currentPage={currentPage}     setCurrentPage={guardedSetCurrentPage}
        totalRows={effectiveTotal}
        onRefresh={handleRefresh}
        isRefreshing={isLoading || isSaving || isCounting}
        onExportCsv={() => cols.length && exportCsv(cols, rows, `${tableName}.csv`)}
        exportFilename={`${tableName}.csv`}
        fetchStats={fetchStats}
        isDirty={editState.isDirty}
        hasSelection={editState.selectedRow !== null}
        onAddRow={editState.addRow}
        onDuplicateRow={() => editState.duplicateRow()}
        onDeleteRow={() => editState.deleteRow()}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TableViewer — root component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ tableName: string, dbName: string, connId: string }} props
 *
 * State isolation: each instance has completely independent useState.
 * App.jsx keeps instances mounted (CSS display:none when tab is inactive)
 * so scrollPosition, selectedSection, and loaded dataResult are preserved
 * across tab switches without any external state management.
 */
/**
 * useTableSchema — loads Properties-panel data from the local SQLite cache.
 *
 * The Go backend's GetTableSchema reads only from the local SQLite mirror so
 * it returns in < 1 ms without touching the live database.  This is the
 * correct architecture for the Properties panel:
 *
 *   WRONG  → SHOW TABLE STATUS WHERE Name = ?          (network + disk I/O)
 *   RIGHT  → SELECT … FROM metadata_columns WHERE …    (local SQLite, < 1 ms)
 *
 * Falls back to getMockSchema when the cache is not yet synced (found=false).
 * In that case a badge on the Properties tab signals that data is stale.
 */
function useTableSchema(connId, dbName, tableName) {
  const [schemaState, setSchemaState] = useState({
    schema:    getMockSchema(tableName), // optimistic default while loading
    loading:   true,
    fromCache: false,   // true  → data comes from SQLite; false → using mock
  })
  // Bumping reloadNonce forces the SQLite read to re-run even when the
  // table identity hasn't changed (used after a successful ALTER TABLE so
  // the Columns panel reflects the new server state).
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false   // ← local closure flag, never shared across renders

    setSchemaState((s) => ({ ...s, loading: true }))

    getTableSchema(connId, dbName, tableName)
      .then((cached) => {
        if (cancelled) return

        if (!cached.found || !cached.columns?.length) {
          // Cache not yet synced — keep mock data but mark it
          setSchemaState({ schema: getMockSchema(tableName), loading: false, fromCache: false })
          return
        }

        // Build the schema shape expected by PropertiesView from SQLite
        // data.  Phase 24: Engine / Charset / Collation / AutoIncrement
        // are now real server-side values captured during the sync
        // crawl; we prefer them over the mock whenever the cache has a
        // non-empty / non-nil value.  Falling back to the mock keeps old
        // griplite.db files (pre-migration) rendering gracefully until
        // the next sync completes.
        const mock = getMockSchema(tableName)
        const merged = {
          ...mock,
          info: {
            ...mock.info,
            // Use the server-side table name verbatim; the mock uses the
            // requested name anyway, but this survives future renames.
            name:          tableName,
            comment:       cached.comment ?? '',
            engine:        cached.engine    || mock.info?.engine    || '',
            charset:       cached.charset   || mock.info?.charset   || '',
            collation:     cached.collation || mock.info?.collation || '',
            autoIncrement: cached.autoIncrement ?? mock.info?.autoIncrement ?? null,
          },
          // Columns overridden with real SQLite data.
          // Comment comes from COLUMN_COMMENT — defaults to '' for robustness.
          columns: cached.columns.map((c) => ({
            ord:     c.ordinal,
            name:    c.name,
            type:    c.type,
            notNull: !c.nullable,
            ai:      false,          // not stored in cache — acceptable limitation
            key:     c.isPrimaryKey ? 'PRI' : '',
            default: null,           // not stored in cache
            comment: c.comment ?? '',
          })),
        }
        setSchemaState({ schema: merged, loading: false, fromCache: true })
      })
      .catch(() => {
        if (!cancelled) {
          setSchemaState({ schema: getMockSchema(tableName), loading: false, fromCache: false })
        }
      })

    return () => { cancelled = true }
  }, [connId, dbName, tableName, reloadNonce])  // re-runs when the tab's identity changes OR reload() is called

  return { ...schemaState, reload }
}

/**
 * defaultView: 'properties' | 'data'
 *   When set to 'data' the viewer opens directly on the Data tab.
 *   This prop is consumed once on mount; subsequent changes are ignored
 *   because the component owns its own tab state after that.
 */
export default function TableViewer({ tableName = 'users', dbName = 'db1', connId = 'mock-conn', defaultView }) {
  const [mainTab, setMainTab] = useState(defaultView === 'data' ? 'data' : 'properties')
  const { schema, loading: schemaLoading, fromCache, reload: reloadSchema } = useTableSchema(connId, dbName, tableName)

  const TabBtn = ({ id, label, badge }) => (
    <button
      onClick={() => setMainTab(id)}
      className={[
        'flex items-center gap-1.5 px-4 py-2 text-[13px] border-r border-line-subtle',
        'transition-colors select-none',
        mainTab === id
          ? 'bg-app text-fg-primary border-t-2 border-t-accent'
          : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
      ].join(' ')}>
      {label}
      {badge && <span className="text-[10px] px-1 py-px bg-line rounded text-fg-muted">{badge}</span>}
    </button>
  )

  return (
    <div className="flex flex-col h-full bg-app">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 bg-elevated border-b border-line-subtle
                      flex-shrink-0 text-[12px] text-fg-muted">
        <span>📋</span>
        <span className="text-syntax-keyword">{dbName}</span>
        <span>/</span>
        <span className="text-fg-primary font-semibold">{tableName}</span>
      </div>

      {/* Main tab bar */}
      <div className="flex items-center bg-titlebar border-b border-line-subtle flex-shrink-0">
        <TabBtn
          id="properties"
          label="Properties"
          badge={
            schemaLoading ? '…'
            : fromCache   ? null
            :               '⚠ mock'
          }
        />
        <TabBtn id="data" label="Data" badge="100 rows" />
        {fromCache && (
          <span className="ml-auto mr-3 text-[10px] text-success select-none">
            ✓ SQLite cache
          </span>
        )}
      </div>

      {/* Tab content — BOTH panels stay mounted; only CSS visibility changes.
          This preserves scroll position, selected section, grid state, etc.   */}
      <div className="flex-1 overflow-hidden" style={{ display: mainTab === 'properties' ? 'flex' : 'none', flexDirection: 'column' }}>
        <PropertiesView
          schema={schema}
          connId={connId}
          dbName={dbName}
          tableName={tableName}
          onSchemaChanged={reloadSchema}
        />
      </div>
      <div className="flex-1 overflow-hidden" style={{ display: mainTab === 'data' ? 'flex' : 'none', flexDirection: 'column' }}>
        <DataView tableName={tableName} dbName={dbName} connId={connId} schema={schema} />
      </div>
    </div>
  )
}
