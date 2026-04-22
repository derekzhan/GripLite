/**
 * DatabaseViewer — database-level overview panel (Phase 6.7).
 *
 * Layout:
 *
 *   ┌─ breadcrumb ──────────────────────────────────────────────────────────┐
 *   │ 🗄 db1                                                                │
 *   ├─ Top Panel (db metadata, read-only fields) ───────────────────────────┤
 *   │  [Database Name]  [Charset]  [Collation]  [Database Size]            │
 *   ├─ Bottom Split ────────────────────────────────────────────────────────┤
 *   │ │ Tables (5) │  ↕ Table Name | Kind | Row Count | Data Length | …   ││
 *   │ │ Views      │  users        | view | 1,024     | 128 K        | …  ││
 *   │ │ Indexes    │  …                                                    ││
 *   │ │ Procedures │                                                       ││
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Sorting is done entirely in the browser using useMemo — no extra backend
 * round-trips.  The sort key for "Data Length" is the raw sizeBytes integer,
 * not the formatted string, so numeric ordering is always correct.
 *
 * Clicking a column header cycles through: asc → desc → unsorted.
 *
 * Double-clicking a row opens the corresponding TableViewer (if onTableOpen
 * is provided).
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { GridCellKind }  from '@glideapps/glide-data-grid'
import { AutoSizedGrid, useRowOverrides } from './DataGrid'
import { fetchTables }   from '../lib/bridge'
import { normalizeError } from '../lib/errors'
import { formatBytes, formatRowCount } from '../utils/formatters'

// ─────────────────────────────────────────────────────────────────────────────
// Column definitions (order == getCellContent column index)
// ─────────────────────────────────────────────────────────────────────────────

const COL_DEFS = [
  { id: 'name',      title: 'Table Name',   width: 200, sortable: true  },
  { id: 'kind',      title: 'Kind',         width: 72,  sortable: true  },
  { id: 'rowCount',  title: 'Row Count',    width: 100, sortable: true  },
  { id: 'dataLen',   title: 'Data Length',  width: 110, sortable: true  },
  { id: 'engine',    title: 'Engine',       width: 80,  sortable: false },
  { id: 'partitioned', title: 'Partitioned', width: 90, sortable: false },
  { id: 'desc',      title: 'Description',  width: 260, sortable: false },
]

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar section list
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'tables',     label: 'Tables',     icon: '▦' },
  { id: 'views',      label: 'Views',      icon: '👁' },
  { id: 'indexes',    label: 'Indexes',    icon: '⚑' },
  { id: 'procedures', label: 'Procedures', icon: '⚡' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Cell value helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the display string for a given column in a table row.
 * Data Length is formatted via formatBytes; all other values are plain strings.
 *
 * Phase 15: `desc` renders the TABLE_COMMENT that flows through from the Go
 * crawler → SQLite cache → Wails IPC.  Null / undefined are coerced to an
 * empty string so the cell never shows "null".
 */
function getCellValue(table, colId) {
  switch (colId) {
    case 'name':        return table.name ?? ''
    case 'kind':        return table.kind ?? 'table'
    case 'rowCount':    return table.rowCount >= 0 ? table.rowCount.toLocaleString() : '—'
    case 'dataLen':     return formatBytes(table.sizeBytes) ?? '—'
    case 'engine':      return table.engine ?? 'InnoDB'   // engine not yet in TableInfo
    case 'partitioned': return 'No'
    case 'desc':        return table.comment ?? ''
    default:            return ''
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sorting comparator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a sort comparison function for the given column id.
 *
 * IMPORTANT: Data Length is sorted by raw sizeBytes (integer), not by the
 * formatted string — so "1 M" comes before "10 M" as expected.
 */
function sortComparator(colId, direction) {
  const sign = direction === 'asc' ? 1 : -1
  return (a, b) => {
    let va, vb
    switch (colId) {
      case 'name':    va = (a.name    ?? '').toLowerCase(); vb = (b.name    ?? '').toLowerCase(); break
      case 'kind':    va = (a.kind    ?? '').toLowerCase(); vb = (b.kind    ?? '').toLowerCase(); break
      case 'rowCount': va = a.rowCount  ?? -1;              vb = b.rowCount  ?? -1;               break
      case 'dataLen':  va = a.sizeBytes ?? -1;              vb = b.sizeBytes ?? -1;               break
      default: return 0
    }
    if (typeof va === 'string') return sign * va.localeCompare(vb)
    return sign * (va - vb)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DatabaseViewer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   dbName:      string,
 *   connId:      string,
 *   onTableOpen: (info: {tableName:string, dbName:string, connId:string}) => void,
 * }} props
 */
export default function DatabaseViewer({ dbName, connId, onTableOpen }) {
  const [tables,        setTables]        = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [activeSection, setActiveSection] = useState('tables')
  const [sortConfig,    setSortConfig]    = useState({ colId: null, direction: 'asc' })
  const [selectedRow,   setSelectedRow]   = useState(null)

  // ── Load tables ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setTables([])
    setSelectedRow(null)
    setSortConfig({ colId: null, direction: 'asc' })

    fetchTables(connId, dbName)
      .then((list) => {
        if (!cancelled) setTables(list ?? [])
      })
      .catch((err) => {
        if (!cancelled) setError(normalizeError(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [connId, dbName])

  // ── Section filter ───────────────────────────────────────────────────────
  const sectionRows = useMemo(() => {
    if (activeSection === 'tables') return tables.filter((t) => t.kind !== 'view')
    if (activeSection === 'views')  return tables.filter((t) => t.kind === 'view')
    return []
  }, [tables, activeSection])

  // ── Sort (pure front-end, no backend round-trip) ─────────────────────────
  const sortedRows = useMemo(() => {
    const { colId, direction } = sortConfig
    if (!colId) return sectionRows
    return [...sectionRows].sort(sortComparator(colId, direction))
  }, [sectionRows, sortConfig])

  // ── Glide column objects with dynamic sort arrows ────────────────────────
  const glideColumns = useMemo(() =>
    COL_DEFS.map((col) => {
      const isActive = sortConfig.colId === col.id
      const arrow    = isActive ? (sortConfig.direction === 'asc' ? ' ↑' : ' ↓') : ''
      return { title: col.title + arrow, width: col.width, id: col.id }
    }),
  [sortConfig])

  // ── getCellContent ───────────────────────────────────────────────────────
  const getCellContent = useCallback(([col, row]) => {
    const table = sortedRows[row]
    const data  = table ? getCellValue(table, COL_DEFS[col]?.id ?? '') : ''
    return { kind: GridCellKind.Text, data, displayData: data, allowOverlay: false }
  }, [sortedRows])

  // ── Row theme (selected row highlight) ───────────────────────────────────
  const rowOverrides = useRowOverrides()
  const getRowThemeOverride = useCallback((row) =>
    row === selectedRow ? rowOverrides.selected : undefined,
  [selectedRow, rowOverrides])

  // ── Header click → cycle sort ────────────────────────────────────────────
  const onHeaderClicked = useCallback((colIndex) => {
    const colDef = COL_DEFS[colIndex]
    if (!colDef?.sortable) return
    const colId = colDef.id
    setSortConfig((prev) => {
      if (prev.colId !== colId)           return { colId, direction: 'asc'  }
      if (prev.direction === 'asc')       return { colId, direction: 'desc' }
      return { colId: null, direction: 'asc' }  // 3rd click → clear sort
    })
    setSelectedRow(null)
  }, [])

  // ── Cell click → select row ──────────────────────────────────────────────
  const onCellClicked = useCallback(([, row]) => setSelectedRow(row), [])

  // ── Cell double-click → open TableViewer ─────────────────────────────────
  const onCellActivated = useCallback(([, row]) => {
    const table = sortedRows[row]
    if (table && onTableOpen) {
      onTableOpen({ tableName: table.name, dbName, connId })
    }
  }, [sortedRows, dbName, connId, onTableOpen])

  // ── Derived stats for the top panel ─────────────────────────────────────
  const totalBytes   = useMemo(() =>
    tables.reduce((sum, t) => (t.sizeBytes > 0 ? sum + t.sizeBytes : sum), 0),
  [tables])
  const tableCount   = tables.filter((t) => t.kind !== 'view').length
  const viewCount    = tables.filter((t) => t.kind === 'view').length
  const sectionCount = activeSection === 'tables' ? tableCount
                     : activeSection === 'views'  ? viewCount : 0

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-app overflow-hidden">

      {/* ── Breadcrumb ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 bg-elevated border-b border-line-subtle
                      flex-shrink-0 text-[12px] text-fg-muted select-none">
        <span>🗄</span>
        <span className="text-success font-medium">{dbName}</span>
        <span className="text-fg-muted">— Overview</span>
        {loading && (
          <span className="ml-auto">
            <span className="inline-block animate-spin text-[10px] text-accent">⟳</span>
          </span>
        )}
      </div>

      {/* ── Top panel (database metadata) ───────────────────────────── */}
      <div className="flex-shrink-0 bg-titlebar border-b border-line-subtle px-4 py-3">
        <div className="grid grid-cols-4 gap-3">
          <DbField label="Database Name"    value={dbName} />
          <DbField label="Default Charset"  value="utf8mb4" />
          <DbField label="Default Collation" value="utf8mb4_unicode_ci" />
          <DbField
            label="Database Size"
            value={loading ? 'Loading…' : formatBytes(totalBytes) ?? '0 B'}
            highlight
          />
        </div>
        {/* Quick summary row */}
        {!loading && (
          <div className="mt-2 flex items-center gap-4 text-[11px] text-fg-muted">
            <span>{tableCount} table{tableCount !== 1 ? 's' : ''}</span>
            {viewCount > 0 && <span>· {viewCount} view{viewCount !== 1 ? 's' : ''}</span>}
            <span>· {tables.length} total objects</span>
          </div>
        )}
      </div>

      {/* ── Bottom split ─────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">

        {/* ── Sidebar ─────────────────────────────────────────────── */}
        <div className="w-40 flex-shrink-0 border-r border-line-subtle bg-titlebar flex flex-col overflow-y-auto">
          {SECTIONS.map((sec) => {
            const count = sec.id === 'tables' ? tableCount
                        : sec.id === 'views'  ? viewCount : null
            return (
              <button
                key={sec.id}
                onClick={() => { setActiveSection(sec.id); setSelectedRow(null) }}
                className={[
                  'flex items-center gap-2 px-3 py-2 text-[12px] text-left transition-colors select-none',
                  'border-b border-line-subtle w-full',
                  activeSection === sec.id
                    ? 'bg-active text-fg-on-accent border-l-2 border-l-accent'
                    : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
                ].join(' ')}
              >
                <span className="text-[11px] opacity-70">{sec.icon}</span>
                <span className="flex-1">{sec.label}</span>
                {count != null && (
                  <span className="text-[10px] tabular-nums text-fg-muted">{count}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* ── Right content ────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">

          {/* Section header */}
          <div className="flex items-center gap-3 px-3 py-1 bg-elevated border-b border-line-subtle
                          flex-shrink-0 text-[11px] text-fg-muted select-none">
            <span className="text-fg-secondary font-medium">
              {SECTIONS.find((s) => s.id === activeSection)?.label}
            </span>
            <span>{sectionCount} object{sectionCount !== 1 ? 's' : ''}</span>
            {sortConfig.colId && (
              <span className="text-accent">
                sorted by {COL_DEFS.find((c) => c.id === sortConfig.colId)?.title}
                {sortConfig.direction === 'asc' ? ' ↑' : ' ↓'}
              </span>
            )}
            {sortConfig.colId && (
              <button
                onClick={() => setSortConfig({ colId: null, direction: 'asc' })}
                className="text-fg-muted hover:text-fg-primary underline"
              >
                clear
              </button>
            )}
            <span className="ml-auto text-fg-faint italic">
              double-click row to open table
            </span>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden min-h-0">
            {loading && (
              <div className="flex items-center justify-center h-full gap-3 text-fg-muted">
                <span className="inline-block animate-spin">⟳</span>
                <span className="text-[13px]">Loading table metadata…</span>
              </div>
            )}
            {!loading && error && (
              <div className="p-6 text-danger text-[13px]">
                <div className="font-semibold mb-2">Failed to load tables</div>
                <pre className="text-[12px] font-mono whitespace-pre-wrap text-fg-primary">{error}</pre>
              </div>
            )}
            {!loading && !error && (activeSection === 'indexes' || activeSection === 'procedures') && (
              <div className="flex items-center justify-center h-full text-fg-muted text-[13px] italic select-none">
                {activeSection === 'indexes'    && 'Index metadata is not yet cached for this database.'}
                {activeSection === 'procedures' && 'Stored procedure metadata is not yet supported.'}
              </div>
            )}
            {!loading && !error && sortedRows.length === 0 && (activeSection === 'tables' || activeSection === 'views') && (
              <div className="flex items-center justify-center h-full text-fg-muted text-[13px] italic select-none">
                No {activeSection} found in <span className="text-syntax-keyword mx-1 not-italic">{dbName}</span>.
              </div>
            )}
            {!loading && !error && sortedRows.length > 0 && (
              <AutoSizedGrid
                columns={glideColumns}
                getCellContentFn={getCellContent}
                numRows={sortedRows.length}
                getRowThemeOverride={getRowThemeOverride}
                onCellClicked={onCellClicked}
                onCellActivated={onCellActivated}
                onHeaderClicked={onHeaderClicked}
                // Glide needs this to know headers are clickable (shows pointer cursor)
                headerIcons={undefined}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DbField — read-only field in the top metadata panel
// ─────────────────────────────────────────────────────────────────────────────

function DbField({ label, value, highlight = false }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-0.5 select-none">
        {label}
      </div>
      <input
        readOnly
        value={value ?? ''}
        className={[
          'w-full bg-elevated border border-line-subtle rounded px-2 py-1',
          'text-[12px] font-mono outline-none focus:border-accent',
          highlight ? 'text-success' : 'text-fg-primary',
        ].join(' ')}
      />
    </div>
  )
}
