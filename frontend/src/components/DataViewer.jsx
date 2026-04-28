/**
 * DataViewer.jsx — three-mode result viewer for GripLite.
 *
 * Modes
 * ─────
 *   Grid   – canvas-based Glide Data Grid; default mode.
 *   Text   – plain-text render (MySQL table format or JSON array) inside a
 *            scrollable <pre>; one-click copy-to-clipboard.
 *   Record – split view: left panel is a numbered row list, right panel shows
 *            the selected row's fields stacked vertically (key : value).
 *
 * Row-selection linkage
 * ──────────────────────
 * `selectedRow` is lifted to DataViewer state.  Clicking a cell in Grid mode
 * updates it; clicking a row in the Record list also updates it.  Switching
 * from Grid → Record therefore automatically focuses the last-clicked row,
 * and switching back keeps the highlight in the grid.
 *
 * Props
 * ─────
 *   columns  – ColumnMeta[] from QueryResult  (required)
 *   rows     – any[][]    current page or all rows  (required)
 *   execMs   – number     query time in ms (optional, shown in toolbar)
 *   truncated – boolean   show a warning badge (optional)
 */
import { useState, useCallback, useRef, useEffect, useMemo, forwardRef } from 'react'
import { GridCellKind } from '@glideapps/glide-data-grid'
import { PanelRightOpen } from 'lucide-react'
import { AutoSizedGrid, deriveColumns, useRowOverrides } from './DataGrid'
import ValuePanel from './ValuePanel'
import { saveTextFile } from '../lib/bridge'
import { useTheme } from '../theme/ThemeProvider'

// ─────────────────────────────────────────────────────────────────────────────
// INSERT SQL generator
// ─────────────────────────────────────────────────────────────────────────────
function generateInsertSql(columns, rows, tableName = 'table_name') {
  const quoteIdent = (s) => '`' + String(s).replace(/`/g, '``') + '`'
  const quoteVal = (v) => {
    if (v === null || v === undefined) return 'NULL'
    if (typeof v === 'number') return String(v)
    if (typeof v === 'boolean') return v ? '1' : '0'
    return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'"
  }
  const colList = columns.map(c => quoteIdent(c.name)).join(', ')
  return rows.map(row =>
    `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${row.map(quoteVal).join(', ')});`
  ).join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV export (E2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * exportCsv — generates a RFC-4180-compliant CSV file in the browser and
 * triggers a download without passing data through the backend.
 *
 * This is correct for the current row cap (≤ 1 000 rows).  For very large
 * tables the PRD calls for a Go-side streaming export (E2 future iteration).
 *
 * Quoting rules:
 *   - Fields that contain a comma, double-quote, or newline are wrapped in "…"
 *   - Internal double-quotes are escaped as ""
 *   - NULL values are written as the literal string NULL (un-quoted)
 */
export function exportCsv(columns, rows, filename = 'export.csv') {
  const quoteField = (val) => {
    if (val === null || val === undefined) return 'NULL'
    const s = String(val)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }

  const header = columns.map((c) => quoteField(c.name)).join(',')
  const body   = rows.map((row) => row.map(quoteField).join(',')).join('\r\n')
  const csv    = '\uFEFF' + header + '\r\n' + body  // BOM for Excel

  return saveTextFile(filename, csv)
}

// ─────────────────────────────────────────────────────────────────────────────
// Text formatters
// ─────────────────────────────────────────────────────────────────────────────
const MAX_CELL_WIDTH = 60 // cap very long values in MySQL table format

function toMysqlTable(columns, rows) {
  if (!columns.length) return '(no columns)'
  const colWidths = columns.map((col, i) => {
    let w = col.name.length
    for (const row of rows) {
      const s = row[i] === null || row[i] === undefined ? 'NULL' : String(row[i])
      w = Math.max(w, Math.min(s.length, MAX_CELL_WIDTH))
    }
    return w
  })

  const sep    = '+' + colWidths.map((w) => '-'.repeat(w + 2)).join('+') + '+'
  const header = '|' + columns.map((c, i) => ` ${c.name.padEnd(colWidths[i])} `).join('|') + '|'
  const body   = rows.map((row) =>
    '|' + columns.map((c, i) => {
      const raw = row[i] === null || row[i] === undefined ? 'NULL' : String(row[i])
      const val = raw.length > MAX_CELL_WIDTH ? raw.slice(0, MAX_CELL_WIDTH - 1) + '…' : raw
      return ` ${val.padEnd(colWidths[i])} `
    }).join('|') + '|'
  ).join('\n')

  return [sep, header, sep, ...(body ? [body] : []), sep].join('\n')
    + `\n${rows.length} row${rows.length !== 1 ? 's' : ''} in set`
}

function toJson(columns, rows) {
  const objs = rows.map((row) =>
    Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null]))
  )
  return JSON.stringify(objs, null, 2)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared toolbar primitives
// ─────────────────────────────────────────────────────────────────────────────
function ToggleGroup({ options, value, onChange }) {
  return (
    <div className="flex items-stretch rounded border border-line overflow-hidden text-[11px]">
      {options.map((opt, i) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          title={opt.label}
          className={[
            'flex items-center gap-1 px-2.5 py-1 transition-colors select-none',
            i > 0 ? 'border-l border-line' : '',
            value === opt.id
              ? 'bg-accent text-fg-on-accent'
              : 'text-fg-secondary hover:text-fg-primary hover:bg-hover',
          ].join(' ')}
        >
          {opt.icon && <span className="font-mono text-[12px]">{opt.icon}</span>}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GridCanvas — pure canvas wrapper (row highlight + cell-click forwarding)
//
// When `editState` is provided (Phase 6.8) the grid becomes fully editable:
//   • getCellContent merges original data with the edits / addedRows overlay.
//   • getRowThemeOverride colours deleted rows (red), added rows (green), and
//     the selected row (blue).
//   • Edited cells receive a subtle yellow cell-level themeOverride.
//   • onCellEdited writes the new value back into editState.
// ─────────────────────────────────────────────────────────────────────────────
// Column comparator that handles numbers, dates, and strings.
function compareValues(a, b) {
  // Nulls last
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  const na = Number(a)
  const nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * GridCanvas — canvas grid with integrated column-header sort.
 *
 * Sort behaviour:
 *   - When `onHeaderClicked` is NOT supplied by the parent the grid manages its
 *     own client-side sort (suitable for result sets that are fully in memory).
 *   - When `onHeaderClicked` IS supplied the parent owns the sort logic
 *     (e.g. TableViewer reloads with ORDER BY).  The `sortConfig` prop
 *     (`{ colIdx, dir }`) drives the ↑ / ↓ indicator in that case.
 *
 * Cycling: first click → ASC, second click → DESC, third click → clear.
 */
function GridCanvas({
  columns,
  rows,
  selectedRow,
  onCellClick,
  editState,
  // External sort — supplied by TableViewer for server-side ORDER BY.
  onHeaderClicked:  externalOnHeaderClicked,
  sortConfig:       externalSortConfig = null,
  // Row colorization: Map<sourceRowIndex, cssColorString>
  rowColors,
  // Right-click: (sourceRowIndex, x, y) => void
  onRowContextMenu,
}) {
  const rowOverrides = useRowOverrides()
  const { nullText } = rowOverrides

  // ── Internal (client-side) sort state ────────────────────────────────
  const isExternal = !!externalOnHeaderClicked
  const [internalSort, setInternalSort] = useState(null) // {colIdx, dir}
  const sortConfig = isExternal ? externalSortConfig : internalSort
  const numRows = editState ? editState.totalDisplayRows : rows.length

  // Visual row order inside the grid. We keep selection/edit state keyed by
  // source-row index, then map display row -> source row after sorting.
  const rowOrder = useMemo(() => {
    const order = Array.from({ length: numRows }, (_, i) => i)
    if (isExternal || !internalSort) return order
    const { colIdx, dir } = internalSort
    order.sort((a, b) => {
      const aValue = editState ? editState.getCellValue(colIdx, a) : rows?.[a]?.[colIdx]
      const bValue = editState ? editState.getCellValue(colIdx, b) : rows?.[b]?.[colIdx]
      const cmp = compareValues(aValue, bValue)
      return dir === 'asc' ? cmp : -cmp
    })
    return order
  }, [numRows, isExternal, internalSort, editState, rows])

  const mapDisplayRow = useCallback(
    (displayRow) => rowOrder[displayRow] ?? displayRow,
    [rowOrder],
  )

  // ── Column objects with sort indicator appended to title ──────────────
  const glideCols = useMemo(() =>
    deriveColumns(columns).map((col, i) => {
      const active = sortConfig?.colIdx === i
      const arrow  = active ? (sortConfig.dir === 'asc' ? ' ↑' : ' ↓') : ''
      return { ...col, title: col.title + arrow }
    }),
  [columns, sortConfig])

  // ── Header click: internal or delegate to parent ───────────────────────
  const handleHeaderClicked = useCallback((colIndex) => {
    if (isExternal) {
      externalOnHeaderClicked(colIndex)
    } else {
      setInternalSort((prev) => {
        if (prev?.colIdx !== colIndex) return { colIdx: colIndex, dir: 'asc' }
        if (prev.dir === 'asc')        return { colIdx: colIndex, dir: 'desc' }
        return null // 3rd click clears sort
      })
    }
  }, [isExternal, externalOnHeaderClicked])

  // ── Cell content (read-only or edit-aware) ────────────────────────────
  const stdGetCellContent = useCallback(
    ([col, displayRow]) => {
      const sourceRow = mapDisplayRow(displayRow)
      const cell = rows?.[sourceRow]?.[col]
      const isNull = cell === null || cell === undefined
      const display = isNull ? 'NULL' : String(cell)
      return {
        kind:        GridCellKind.Text,
        data:        display,
        displayData: display,
        allowOverlay: false,
        ...(isNull ? { themeOverride: { textDark: nullText } } : {}),
      }
    },
    [rows, mapDisplayRow, nullText],
  )

  const editGetCellContent = useCallback(
    ([col, displayRow]) => {
      const sourceRow = mapDisplayRow(displayRow)
      const deleted    = editState.isDeleted(sourceRow)
      const edited     = editState.isEdited(col, sourceRow)
      const isSelected = sourceRow === selectedRow
      const raw  = editState.getCellValue(col, sourceRow)
      const text = raw === null || raw === undefined ? '' : String(raw)
      return {
        kind:         GridCellKind.Text,
        data:         text,
        displayData:  text,
        allowOverlay: !deleted,
        readonly:     deleted,
        style:        deleted ? 'faded' : 'normal',
        themeOverride: (!isSelected && edited && !deleted)
          ? rowOverrides.edited
          : undefined,
      }
    },
    [editState, selectedRow, rowOverrides, mapDisplayRow],
  )

  const getCellContent = editState ? editGetCellContent : stdGetCellContent

  // ── Row-level colour themes ────────────────────────────────────────────
  const getRowThemeOverride = useCallback(
    (displayRow) => {
      const sourceRow = mapDisplayRow(displayRow)
      if (sourceRow === selectedRow)         return rowOverrides.selected
      if (editState?.isDeleted(sourceRow))   return rowOverrides.deleted
      if (editState?.isAdded(sourceRow))     return rowOverrides.added
      // User-assigned row colour
      const userColor = rowColors?.get(sourceRow)
      if (userColor) return { bgCell: userColor, bgCellMedium: userColor }
      return undefined
    },
    [selectedRow, editState, rowOverrides, mapDisplayRow, rowColors],
  )

  // ── Right-click on a cell ─────────────────────────────────────────────
  // Wrapper div ref — used to convert Glide's canvas-local coords to viewport coords.
  const canvasWrapperRef = useRef(null)

  const handleCellContextMenu = useCallback(
    ([, displayRow], event) => {
      event.preventDefault()
      const sourceRow = mapDisplayRow(displayRow)
      // Glide gives localEventX/Y relative to the canvas element, not the viewport.
      // Add the canvas container's viewport offset to get the correct fixed position.
      const rect = canvasWrapperRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
      onRowContextMenu?.(sourceRow, rect.left + event.localEventX, rect.top + event.localEventY)
    },
    [mapDisplayRow, onRowContextMenu],
  )

  // ── Edit committed by user in the overlay editor ───────────────────────
  const handleCellEdited = useCallback(
    ([col, displayRow], newValue) => {
      if (editState && newValue.kind === GridCellKind.Text) {
        editState.editCell(col, mapDisplayRow(displayRow), newValue.data)
      }
    },
    [editState, mapDisplayRow],
  )

  const handleCellClicked = useCallback(
    ([col, displayRow]) => onCellClick(col, mapDisplayRow(displayRow)),
    [onCellClick, mapDisplayRow],
  )

  // ── Imperative cell invalidation after sort ───────────────────────────
  // Glide DataEditor v6 redraws column headers when `columns` changes but
  // does NOT re-fetch cell content unless explicitly told to.
  // We keep a ref to the DataEditor and call updateCells() after every
  // internal sort change to force Glide to repaint every data cell.
  const gridRef = useRef(null)
  useEffect(() => {
    if (isExternal || !gridRef.current || numRows === 0 || !glideCols.length) return
    const damage = []
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < glideCols.length; col++) {
        damage.push({ cell: [col, row] })
      }
    }
    gridRef.current.updateCells(damage)
  // Run whenever internalSort changes (covers both set and clear).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [internalSort])

  return (
    <div ref={canvasWrapperRef} style={{ width: '100%', height: '100%' }}>
      <AutoSizedGrid
        ref={gridRef}
        columns={glideCols}
        getCellContentFn={getCellContent}
        numRows={numRows}
        getRowThemeOverride={getRowThemeOverride}
        onCellClicked={handleCellClicked}
        onHeaderClicked={handleHeaderClicked}
        onCellEdited={editState ? handleCellEdited : undefined}
        onCellContextMenu={onRowContextMenu ? handleCellContextMenu : undefined}
        {...(editState ? { getCellsForSelection: true } : {})}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// GridWithPanel — grid + draggable Value Panel (Phase 6.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GridWithPanel wraps GridCanvas and manages the Value Panel lifecycle.
 *
 * Layout when panel is open:
 *
 *   ┌───────────────────────────┬─┬───────────────────────────┬───┐
 *   │  Glide Data Grid (flex-1) │▌│  ValuePanel (resizable)   │ R │
 *   └───────────────────────────┴─┴───────────────────────────┴───┘
 *                                ↑ drag handle               ↑ rail
 *
 * The right-most rail is a DBeaver-style slim strip that's always visible.
 * Its first button toggles the Value Panel.  When the panel is closed,
 * clicking a grid cell only updates which cell is "focused" (so the panel
 * shows that cell when re-opened) — it no longer auto-opens the panel.
 *
 * Panel width is controlled by a drag handle (onMouseDown on the divider).
 * The AutoSizedGrid's ResizeObserver re-measures the grid container whenever
 * the panel opens/closes or is resized, keeping the canvas perfectly fitted.
 *
 * State:
 *   panelOpen    – whether the ValuePanel is currently visible
 *   panelWidth   – current panel width in px (default 340)
 *   panelCell    – { col, row, value, colName } of the last clicked cell
 */
// ─────────────────────────────────────────────────────────────────────────────
// RowContextMenu
// ─────────────────────────────────────────────────────────────────────────────

// ── Colour swatches for row colouring (DataGrip-style) ──────────────────────
const ROW_COLORS = [
  { label: 'Red',    value: '#fde8e8', dark: '#3b1010' },
  { label: 'Orange', value: '#fef3e2', dark: '#3b2010' },
  { label: 'Yellow', value: '#fef9c3', dark: '#3b3010' },
  { label: 'Green',  value: '#dcfce7', dark: '#0d2a15' },
  { label: 'Cyan',   value: '#cffafe', dark: '#0a2a30' },
  { label: 'Blue',   value: '#dbeafe', dark: '#0a1f3b' },
  { label: 'Purple', value: '#ede9fe', dark: '#1e1040' },
  { label: 'Pink',   value: '#fce7f3', dark: '#2d0a20' },
]

/**
 * RowContextMenu — floating right-click menu for a grid row.
 * Positioned absolutely inside the GridWithPanel's relative container.
 */
const RowContextMenu = forwardRef(function RowContextMenu(
  { x, y, row, rows, columns, exportFilename, rowColors, isDark, onSetRowColor, onClose },
  ref
) {
  const rowData  = rows[row] ?? []
  const hasRow   = rowData.length > 0

  const copyInsertRow = () => {
    if (!hasRow) return
    const quoteIdent = (s) => '`' + String(s).replace(/`/g, '``') + '`'
    const quoteVal = (v) => {
      if (v === null || v === undefined) return 'NULL'
      if (typeof v === 'number') return String(v)
      if (typeof v === 'boolean') return v ? '1' : '0'
      return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'"
    }
    const tbl = (exportFilename ?? 'table_name').replace(/\.csv$/, '')
    const cols = columns.map(c => quoteIdent(c.name)).join(', ')
    const vals = rowData.map(quoteVal).join(', ')
    navigator.clipboard.writeText(`INSERT INTO ${quoteIdent(tbl)} (${cols}) VALUES (${vals});`)
    onClose()
  }

  const exportRowJson = async () => {
    if (!hasRow) return
    const obj = Object.fromEntries(columns.map((c, i) => [c.name, rowData[i] ?? null]))
    await saveTextFile(
      (exportFilename ?? 'row').replace(/\.csv$/, '') + `_row${row}.json`,
      JSON.stringify(obj, null, 2)
    )
    onClose()
  }

  const exportRowCsv = async () => {
    if (!hasRow) return
    const q = (v) => {
      const s = v === null || v === undefined ? 'NULL' : String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const header = columns.map(c => q(c.name)).join(',')
    const body   = rowData.map(q).join(',')
    await saveTextFile(
      (exportFilename ?? 'row').replace(/\.csv$/, '') + `_row${row}.csv`,
      '\uFEFF' + header + '\r\n' + body
    )
    onClose()
  }

  const currentColor = rowColors?.get(row)

  const menuStyle = {
    position: 'fixed',
    left: x,
    top: y,
    zIndex: 9999,
  }

  return (
    <div
      ref={ref}
      style={menuStyle}
      className="min-w-[200px] rounded-lg border border-[color:var(--border-strong)]
                 bg-[color:var(--card-bg)] shadow-lg py-1 text-[12px]
                 text-[color:var(--fg-primary)] select-none"
    >
      {/* Generate SQL section */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-muted)]">
        Generate SQL
      </div>
      <CtxItem label="Copy row as INSERT" onClick={copyInsertRow} disabled={!hasRow} />
      <div className="my-1 border-t border-[color:var(--border-subtle)]" />

      {/* Export section */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-muted)]">
        Export row
      </div>
      <CtxItem label="Export row as JSON…" onClick={exportRowJson} disabled={!hasRow} />
      <CtxItem label="Export row as CSV…"  onClick={exportRowCsv}  disabled={!hasRow} />
      <div className="my-1 border-t border-[color:var(--border-subtle)]" />

      {/* Row colour section */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--fg-muted)]">
        Row color
      </div>
      <div className="px-3 py-1.5 flex items-center gap-1.5 flex-wrap">
        {ROW_COLORS.map((c) => {
          const isActive = currentColor === (isDark ? c.dark : c.value)
          return (
            <button
              key={c.label}
              title={c.label}
              onClick={() => onSetRowColor(c)}
              className="w-5 h-5 rounded-full border-2 transition-transform hover:scale-110"
              style={{
                background: isDark ? c.dark : c.value,
                borderColor: isActive ? 'var(--accent)' : 'var(--border-strong)',
              }}
            />
          )
        })}
        {currentColor && (
          <button
            title="Clear color"
            onClick={() => onSetRowColor(null)}
            className="w-5 h-5 rounded-full border-2 flex items-center justify-center
                       text-[9px] text-[color:var(--fg-muted)] hover:text-danger
                       border-[color:var(--border-strong)] hover:border-danger transition-colors"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
})

function CtxItem({ label, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={[
        'w-full text-left px-3 py-1.5 transition-colors',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-[color:var(--hover)] cursor-pointer',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

function GridWithPanel({ columns, rows, selectedRow, onSelectRow, editState, onHeaderClicked, sortConfig, exportFilename }) {
  const [panelOpen,  setPanelOpen]  = useState(false)
  const [panelWidth, setPanelWidth] = useState(340)
  const [panelCell,  setPanelCell]  = useState({ col: 0, row: 0, value: null, colName: '' })

  // ── Row colours (user-assigned) ─────────────────────────────────────────
  const [rowColors, setRowColors] = useState(() => new Map())
  const { resolvedTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  const setRowColor = useCallback((rowIdx, colorEntry) => {
    setRowColors((prev) => {
      const next = new Map(prev)
      if (colorEntry === null) {
        next.delete(rowIdx)
      } else {
        next.set(rowIdx, isDark ? colorEntry.dark : colorEntry.value)
      }
      return next
    })
  }, [isDark])

  // ── Context menu state ────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState(null) // { x, y, row }
  const ctxRef = useRef(null)

  const openContextMenu = useCallback((row, x, y) => {
    setCtxMenu({ x, y, row })
  }, [])

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e) => {
      if (!ctxRef.current?.contains(e.target)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  // ── Cell click: update selected row + which cell the panel reflects.
  // We deliberately do NOT auto-open the panel here (DBeaver behaviour):
  // the user toggles visibility via the right-rail button.  When the panel
  // IS open it re-reads panelCell on every render so subsequent cell clicks
  // immediately switch its content. ────────────────────────────────────────
  const handleCellClick = useCallback((col, row) => {
    onSelectRow(row)
    editState?.setSelectedRow(row)
    const value   = editState ? editState.getCellValue(col, row) : (rows[row]?.[col] ?? null)
    const colName = columns[col]?.name ?? `col_${col}`
    setPanelCell({ col, row, value, colName })
  }, [rows, columns, onSelectRow, editState])

  // ── Drag-to-resize the ValuePanel ────────────────────────────────────────
  const isDragging  = useRef(false)
  const dragStartX  = useRef(0)
  const dragStartW  = useRef(0)

  const onDividerMouseDown = useCallback((e) => {
    e.preventDefault()
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartW.current = panelWidth

    const onMove = (ev) => {
      if (!isDragging.current) return
      // Dragging LEFT increases panel width (panel is on the right side).
      const delta = dragStartX.current - ev.clientX
      setPanelWidth(Math.max(220, Math.min(700, dragStartW.current + delta)))
    }

    const onUp = () => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  }, [panelWidth])

  return (
    <div className="flex h-full overflow-hidden relative">
      {/* ── Grid area — grows to fill available space ───────────────── */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <GridCanvas
          columns={columns}
          rows={rows}
          selectedRow={selectedRow}
          onCellClick={handleCellClick}
          editState={editState}
          onHeaderClicked={onHeaderClicked}
          sortConfig={sortConfig}
          rowColors={rowColors}
          onRowContextMenu={openContextMenu}
        />
      </div>

      {/* ── Drag handle — visible only when panel is open ──────────── */}
      {panelOpen && (
        <div
          onMouseDown={onDividerMouseDown}
          className="w-1 flex-shrink-0 cursor-col-resize bg-line
                     hover:bg-accent transition-colors select-none"
          title="Drag to resize"
        />
      )}

      {/* ── Value Panel ─────────────────────────────────────────────── */}
      {panelOpen && (
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{ width: panelWidth }}
        >
          {/* When editState is present we re-read the effective value on
              every render so the panel reflects the current overlay (a cell
              edited via Record mode or the Grid overlay editor shows up
              here immediately). */}
          <ValuePanel
            value={editState
              ? editState.getCellValue(panelCell.col, panelCell.row)
              : panelCell.value}
            columnName={panelCell.colName}
            rowIndex={panelCell.row}
            onClose={() => setPanelOpen(false)}
            editState={editState}
            col={panelCell.col}
            row={panelCell.row}
          />
        </div>
      )}

      {/* ── Right-side panel rail (always visible) ──────────────────── */}
      <PanelRail
        valuePanelOpen={panelOpen}
        onToggleValuePanel={() => {
          // When opening the panel without any prior cell click, seed it
          // with the (0,0) cell so the user sees something meaningful
          // instead of a stale `null`.  panelCell is then refreshed by
          // every subsequent cell click.
          if (!panelOpen && panelCell.value === null && panelCell.col === 0 && panelCell.row === 0) {
            const value   = editState ? editState.getCellValue(0, 0) : (rows[0]?.[0] ?? null)
            const colName = columns[0]?.name ?? 'col_0'
            setPanelCell({ col: 0, row: 0, value, colName })
          }
          setPanelOpen((o) => !o)
        }}
      />

      {/* ── Row context menu ─────────────────────────────────────────── */}
      {ctxMenu && (
        <RowContextMenu
          ref={ctxRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          row={ctxMenu.row}
          rows={rows}
          columns={columns}
          exportFilename={exportFilename}
          rowColors={rowColors}
          isDark={isDark}
          onSetRowColor={(entry) => { setRowColor(ctxMenu.row, entry); setCtxMenu(null) }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

/**
 * PanelRail — slim vertical strip on the right edge of the data area, à la
 * DBeaver / VS Code's right activity bar.  Hosts toggle buttons for every
 * side panel.  Today only the Value Panel button is wired; the other slots
 * are placeholders that hint at future panels (filters, references, etc.).
 *
 * The rail is always visible regardless of panel state so users always have
 * a way back to the panels — discoverability matters more than the few
 * pixels of grid width it costs.
 */
function PanelRail({ valuePanelOpen, onToggleValuePanel }) {
  return (
    <div
      className="flex-shrink-0 w-7 flex flex-col items-stretch
                 bg-app border-l border-line-subtle select-none"
    >
      {/* Vertical "Panels" caption — orientation matches the screenshot */}
      <div
        className="flex items-center justify-center text-[10px] text-fg-muted
                   uppercase tracking-wider py-2 border-b border-line-subtle"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
        title="Side panels"
      >
        Panels
      </div>

      <button
        onClick={onToggleValuePanel}
        title={valuePanelOpen ? 'Hide value panel' : 'Show value panel'}
        className={[
          'flex items-center justify-center h-8 transition-colors',
          valuePanelOpen
            ? 'text-accent bg-titlebar'
            : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
        ].join(' ')}
      >
        <PanelRightOpen size={14} strokeWidth={1.8} />
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TextView
// ─────────────────────────────────────────────────────────────────────────────
function TextView({ columns, rows, format }) {
  const [copied, setCopied] = useState(false)

  const text = format === 'json' ? toJson(columns, rows) : toMysqlTable(columns, rows)

  const copy = () =>
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex justify-end items-center px-3 py-1 bg-titlebar border-b border-line-subtle flex-shrink-0">
        <button
          onClick={copy}
          className="text-[11px] text-fg-secondary hover:text-fg-primary px-2 py-0.5 rounded
                     hover:bg-hover transition-colors select-none"
        >
          {copied ? '✓ Copied' : '⎘ Copy all'}
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 bg-sunken">
        <pre className="text-[12px] leading-[1.65] font-mono text-fg-primary whitespace-pre">
          {text}
        </pre>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// RecordView
// ─────────────────────────────────────────────────────────────────────────────

/** Build a short preview label from the first few non-null cells of a row. */
function rowPreview(rowData) {
  if (!rowData) return ''
  for (let i = 0; i < Math.min(rowData.length, 3); i++) {
    if (rowData[i] !== null && rowData[i] !== undefined) {
      const s = String(rowData[i])
      return s.length > 28 ? s.slice(0, 27) + '…' : s
    }
  }
  return '—'
}

/**
 * InlineValueCell — DBeaver-style double-click editor for Record mode.
 *
 * Display state: a read-only <span> showing the value (or NULL placeholder).
 * Edit state (on double-click): an auto-grown <textarea> the user can type in.
 *   - Enter  ⇒ commit (Shift+Enter inserts a newline)
 *   - Esc    ⇒ revert to the original value
 *   - blur   ⇒ commit
 *
 * We never short-circuit "unchanged" commits back into editState because the
 * grid side already does the same — sending `editCell(col, row, sameValue)`
 * produces a no-op edit (isDirty stays true only if the value actually
 * differs from the source row).
 */
function InlineValueCell({ value, onCommit, onSetNull, readOnly, edited }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState('')
  const taRef                 = useRef(null)

  const isNull = value === null || value === undefined
  const isLong = !isNull && String(value).length > 200

  // Auto-grow the textarea to fit its content while editing.
  useEffect(() => {
    if (!editing) return
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 400) + 'px'
  }, [editing, draft])

  const startEdit = () => {
    if (readOnly) return
    setDraft(isNull ? '' : String(value))
    setEditing(true)
    // Defer focus + caret-to-end to next tick so the textarea exists.
    requestAnimationFrame(() => {
      const el = taRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  const commit = () => {
    setEditing(false)
    onCommit(draft)
  }
  const cancel = () => setEditing(false)

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
  }

  if (editing) {
    return (
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        rows={1}
        className="w-full resize-none bg-panel border border-accent rounded px-2 py-1
                   font-mono text-[12px] text-fg-primary leading-[1.5]
                   outline-none focus:ring-1 focus:ring-accent"
        // Overlay editors are single logical values — disable OS autocorrect
        // even though the global shim covers this; extra belt-and-braces.
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
      />
    )
  }

  return (
    <div className="flex items-start gap-2 group">
      <div
        onDoubleClick={startEdit}
        title={readOnly ? 'Row is marked for deletion' : 'Double-click to edit'}
        className={[
          'flex-1 min-w-0 rounded px-1 -mx-1 py-0.5 cursor-text',
          readOnly ? 'cursor-not-allowed opacity-50' : 'hover:bg-hover',
          edited ? 'bg-warn/15 ring-1 ring-warn/40' : '',
        ].join(' ')}
      >
        {isNull ? (
          <span className="text-fg-muted">NULL</span>
        ) : isLong ? (
          <details>
            <summary className="text-fg-primary cursor-pointer select-none">
              {String(value).slice(0, 120)}…
              <span className="ml-2 text-fg-muted text-[10px]">({String(value).length} chars)</span>
            </summary>
            <span className="text-fg-primary break-all block mt-1 whitespace-pre-wrap">
              {String(value)}
            </span>
          </details>
        ) : (
          <span className="text-fg-primary break-words whitespace-pre-wrap">
            {String(value)}
          </span>
        )}
      </div>

      {/* Action chips — only when editing is possible. */}
      {!readOnly && onSetNull && !isNull && (
        <button
          onClick={onSetNull}
          title="Set to NULL"
          className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px]
                     px-1.5 py-0.5 rounded border border-line text-fg-muted
                     hover:text-fg-primary hover:border-accent select-none"
        >
          NULL
        </button>
      )}
    </div>
  )
}

function RecordView({ columns, rows, selectedIdx, onSelectIdx, editState }) {
  const [copied,    setCopied]    = useState(false)
  const [fieldSort, setFieldSort] = useState(null) // null | 'asc' | 'desc'

  const cycleFieldSort = () =>
    setFieldSort((s) => (s === null ? 'asc' : s === 'asc' ? 'desc' : null))

  // Sorted column index mapping for the detail table only.
  // Does NOT affect row data — `row[i]` is still indexed by original column order.
  const sortedIndices = useMemo(() => {
    const base = columns.map((_, i) => i)
    if (!fieldSort) return base
    return [...base].sort((a, b) => {
      const cmp = columns[a].name.localeCompare(columns[b].name, undefined, { sensitivity: 'base' })
      return fieldSort === 'asc' ? cmp : -cmp
    })
  }, [columns, fieldSort])

  // When editState is active, the effective row set includes added (draft)
  // rows as well as the original rows.  Otherwise fall back to the prop.
  const totalRows = editState ? editState.totalDisplayRows : rows.length
  const idx       = Math.min(Math.max(selectedIdx ?? 0, 0), Math.max(totalRows - 1, 0))
  const hasRow    = totalRows > 0 && idx < totalRows

  const getCellValue = useCallback(
    (col, row) => {
      if (editState) return editState.getCellValue(col, row)
      return rows[row]?.[col] ?? null
    },
    [editState, rows],
  )

  const row = hasRow
    ? columns.map((_, i) => getCellValue(i, idx))
    : null

  const deleted = !!editState?.isDeleted(idx)
  const added   = !!editState?.isAdded(idx)

  const copyRow = () => {
    if (!row) return
    const text = columns.map((c, i) => `${c.name}: ${row[i] ?? 'NULL'}`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // Keyboard navigation in the left list
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onSelectIdx(Math.min(idx + 1, totalRows - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); onSelectIdx(Math.max(idx - 1, 0)) }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left: row list ──────────────────────────────────────────── */}
      <div
        className="flex flex-col w-52 flex-shrink-0 border-r border-line-subtle bg-titlebar overflow-hidden"
        onKeyDown={onKeyDown}
        tabIndex={0}
      >
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-muted border-b border-line-subtle flex-shrink-0 select-none">
          {totalRows} records · row {Math.min(idx + 1, totalRows)} of {totalRows}
        </div>
        <div className="flex-1 overflow-y-auto">
          {Array.from({ length: totalRows }).map((_, rowIdx) => {
            const rowData  = columns.map((_, c) => getCellValue(c, rowIdx))
            const isAdded  = !!editState?.isAdded(rowIdx)
            const isDelRow = !!editState?.isDeleted(rowIdx)
            return (
              <div
                key={rowIdx}
                onClick={() => onSelectIdx(rowIdx)}
                className={[
                  'flex items-center gap-2.5 px-3 py-1.5 cursor-pointer transition-colors',
                  'border-b border-line-subtle select-none',
                  rowIdx === idx
                    ? 'bg-active text-fg-primary'
                    : isDelRow
                      ? 'bg-danger-bg text-danger line-through'
                      : isAdded
                        ? 'bg-success/15 text-success'
                        : 'text-fg-secondary hover:bg-hover hover:text-fg-primary',
                ].join(' ')}
              >
                <span className="text-[10px] tabular-nums text-fg-muted w-6 text-right flex-shrink-0 font-mono">
                  {rowIdx + 1}
                </span>
                <span className="truncate text-[12px]">
                  {isAdded && rowData.every((v) => v === null || v === undefined || v === '')
                    ? <span className="italic">new row</span>
                    : rowPreview(rowData)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right: field : value detail ─────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden bg-panel">
        {/* Detail toolbar */}
        <div className="flex items-center justify-between px-4 py-1.5 bg-titlebar border-b border-line-subtle flex-shrink-0 text-[11px]">
          <span className="text-fg-secondary flex items-center gap-2">
            <span>{columns.length} fields</span>
            {row && <span className="text-fg-muted">— row {idx + 1}</span>}
            {added   && <span className="text-success">· new</span>}
            {deleted && <span className="text-danger">· marked for deletion</span>}
            {editState && !deleted && (
              <span className="text-fg-muted">· double-click a value to edit</span>
            )}
          </span>
          <button
            onClick={copyRow}
            disabled={!row}
            className="text-fg-secondary hover:text-fg-primary px-2 py-0.5 rounded hover:bg-hover transition-colors disabled:opacity-30 select-none"
          >
            {copied ? '✓ Copied' : '⎘ Copy record'}
          </button>
        </div>

        {!row ? (
          <div className="flex items-center justify-center flex-1 text-fg-muted text-[13px] italic select-none">
            {totalRows === 0 ? 'No rows to display.' : 'Select a row from the list.'}
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <colgroup>
                <col style={{ width: '220px' }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th
                    onClick={cycleFieldSort}
                    title="Click to sort fields A→Z / Z→A"
                    className="sticky top-0 z-10 bg-titlebar px-4 py-2 text-left text-[11px] font-semibold
                               uppercase tracking-wider text-fg-muted border-b border-r border-line-subtle
                               cursor-pointer select-none hover:text-fg-primary transition-colors"
                  >
                    Field
                    {fieldSort === 'asc'  && <span className="ml-1 text-accent">↑</span>}
                    {fieldSort === 'desc' && <span className="ml-1 text-accent">↓</span>}
                    {fieldSort === null   && <span className="ml-1 opacity-30">↕</span>}
                  </th>
                  <th className="sticky top-0 z-10 bg-titlebar px-4 py-2 text-left text-[11px] font-semibold
                                 uppercase tracking-wider text-fg-muted border-b border-line-subtle">
                    Value
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedIndices.map((i) => {
                  const col     = columns[i]
                  const val     = row[i]
                  const isEdited = !!editState?.isEdited(i, idx)
                  return (
                    <tr key={col.name} className="hover:bg-hover transition-colors group">
                      <td className="px-4 py-1.5 border-r border-b border-line-subtle font-mono text-[12px]
                                     text-syntax-keyword font-medium align-top whitespace-nowrap select-none">
                        {col.name}
                        {col.type && (
                          <span className="ml-1.5 text-fg-muted text-[10px] font-normal">{col.type}</span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 border-b border-line-subtle font-mono text-[12px] align-top">
                        {editState ? (
                          <InlineValueCell
                            value={val}
                            edited={isEdited}
                            readOnly={deleted}
                            onCommit={(next) => editState.editCell(i, idx, next)}
                            onSetNull={() => editState.editCell(i, idx, null)}
                          />
                        ) : val === null || val === undefined ? (
                          <span className="text-fg-muted italic not-italic">NULL</span>
                        ) : String(val).length > 200 ? (
                          <details>
                            <summary className="text-fg-primary cursor-pointer select-none">
                              {String(val).slice(0, 120)}…
                              <span className="ml-2 text-fg-muted text-[10px]">({String(val).length} chars)</span>
                            </summary>
                            <span className="text-fg-primary break-all block mt-1">{String(val)}</span>
                          </details>
                        ) : (
                          <span className="text-fg-primary break-words">{String(val)}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DataViewer — public API
// ─────────────────────────────────────────────────────────────────────────────
const MODES = [
  { id: 'grid',   icon: '⊞', label: 'Grid'   },
  { id: 'text',   icon: '≡',  label: 'Text'   },
  { id: 'record', icon: '▤',  label: 'Record' },
]

const TEXT_FORMATS = [
  { id: 'table', label: 'MySQL' },
  { id: 'json',  label: 'JSON'  },
]

export default function DataViewer({
  columns = [],
  rows    = [],
  execMs,
  truncated,
  exportFilename,
  /**
   * editState — returned by useEditState().  When provided the grid becomes
   * fully editable (Phase 6.8).  When omitted the grid is read-only.
   */
  editState,
  /**
   * onHeaderClicked / sortConfig — optional server-side sort integration.
   * When supplied (e.g. by TableViewer) clicking a column header calls
   * onHeaderClicked(colIndex) and the ↑ / ↓ indicator is driven by sortConfig.
   * When omitted the grid sorts its rows in-memory.
   */
  onHeaderClicked,
  sortConfig,
}) {
  const [mode,        setMode]        = useState('grid')
  const [textFormat,  setTextFormat]  = useState('table')
  const [csvFlash,    setCsvFlash]    = useState(false)
  const [insertFlash, setInsertFlash] = useState(false)
  const [jsonFlash,   setJsonFlash]   = useState(false)
  const [tblName,     setTblName]     = useState('table_name')
  const [hiddenCols,  setHiddenCols]  = useState(new Set())
  const [showColPicker, setShowColPicker] = useState(false)
  const colPickerRef = useRef(null)
  /**
   * selectedRow is the shared cursor between Grid and Record modes.
   *   Grid  → onCellClicked updates selectedRow
   *   Record → clicking the left list updates selectedRow
   * Switching Grid → Record therefore focuses the last-clicked grid row.
   * When editState is active we delegate to editState.selectedRow instead so
   * that the edit operations (Duplicate, Delete) know which row is focused.
   */
  const [_selectedRow, _setSelectedRow] = useState(0)

  const selectedRow    = editState ? (editState.selectedRow ?? 0) : _selectedRow
  const setSelectedRow = editState
    ? (r) => { _setSelectedRow(r); editState.setSelectedRow(r) }
    : _setSelectedRow

  // Two distinct empty states (DBeaver semantics):
  //   noColumns → schema is unknown, the result is genuinely degenerate
  //               (e.g. a DDL statement that returned nothing).  Show a text
  //               placeholder because there's no header row to render.
  //   noRows    → schema IS known, the table is just empty.  We MUST still
  //               render the grid so the user sees the column headers,
  //               column types, and row-marker — exactly like DBeaver /
  //               TablePlus / Sequel Ace do.  Otherwise an empty table looks
  //               indistinguishable from a broken query.
  const noColumns = !columns.length
  const noRows    = !rows.length
  const canExport = !noColumns && !noRows

  const handleExportCsv = () => {
    if (!canExport) return
    exportCsv(columns, rows, exportFilename ?? 'query_result.csv')
    setCsvFlash(true)
    setTimeout(() => setCsvFlash(false), 2000)
  }

  const handleCopyInsert = () => {
    if (!canExport) return
    const name = window.prompt('Table name for INSERT statements:', tblName) ?? tblName
    if (!name) return
    setTblName(name)
    const sql = generateInsertSql(columns, rows, name)
    navigator.clipboard.writeText(sql).then(() => {
      setInsertFlash(true)
      setTimeout(() => setInsertFlash(false), 2000)
    })
  }

  const handleExportJson = async () => {
    if (!canExport) return
    const objs = rows.map(row => Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null])))
    const json = JSON.stringify(objs, null, 2)
    const filename = (exportFilename ?? 'export').replace(/\.csv$/, '') + '.json'
    const saved = await saveTextFile(filename, json)
    if (saved) {
      setJsonFlash(true)
      setTimeout(() => setJsonFlash(false), 2000)
    }
  }

  // Reset selected row when hidden columns change to avoid out-of-bounds.
  useEffect(() => {
    setSelectedRow(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenCols])

  // Close the column picker on outside click.
  useEffect(() => {
    if (!showColPicker) return
    const handle = (e) => {
      if (!e.target.closest('[data-col-picker]')) setShowColPicker(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [showColPicker])

  const visibleColumns = columns.filter((_, i) => !hiddenCols.has(i))
  const visibleRows    = rows.map(row => row.filter((_, i) => !hiddenCols.has(i)))

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-titlebar border-b border-line-subtle
                      flex-shrink-0">
        {/* Mode toggle */}
        <ToggleGroup options={MODES} value={mode} onChange={setMode} />

        {/* Text format sub-toggle (only when in text mode) */}
        {mode === 'text' && !noColumns && (
          <ToggleGroup options={TEXT_FORMATS} value={textFormat} onChange={setTextFormat} />
        )}

        {/* Column visibility picker (grid mode only) */}
        {mode === 'grid' && !noColumns && (
          <div className="relative" data-col-picker ref={colPickerRef}>
            <button
              onClick={() => setShowColPicker(p => !p)}
              title="Show/hide columns"
              className={[
                'text-[11px] px-2 py-0.5 rounded border transition-colors select-none',
                showColPicker || hiddenCols.size > 0
                  ? 'border-accent text-accent'
                  : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
              ].join(' ')}
            >
              Columns{hiddenCols.size > 0 ? ` (${columns.length - hiddenCols.size}/${columns.length})` : ''}
            </button>
            {showColPicker && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-panel border border-line rounded
                              shadow-md min-w-[180px] max-h-[320px] overflow-y-auto py-1">
                <div className="flex items-center justify-between px-2 py-1 border-b border-line-subtle">
                  <span className="text-[10px] uppercase tracking-wider text-fg-muted select-none">Columns</span>
                  <button
                    onClick={() => setHiddenCols(new Set())}
                    className="text-[10px] text-accent hover:underline select-none"
                  >
                    Show all
                  </button>
                </div>
                {columns.map((col, i) => (
                  <label
                    key={i}
                    className="flex items-center gap-2 px-2 py-1.5 hover:bg-hover cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={!hiddenCols.has(i)}
                      onChange={() => {
                        setHiddenCols(prev => {
                          const next = new Set(prev)
                          if (next.has(i)) next.delete(i)
                          else next.add(i)
                          return next
                        })
                      }}
                      className="accent-accent"
                    />
                    <span className="text-[12px] text-fg-primary font-mono truncate">{col.name}</span>
                    {col.type && <span className="text-[10px] text-fg-muted ml-auto">{col.type}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Stats */}
        <span className="text-[11px] text-fg-muted tabular-nums select-none flex items-center gap-2">
          {truncated && <span className="text-warn font-medium">⚠ capped</span>}
          <span>{rows.length.toLocaleString()} rows</span>
          {execMs !== undefined && <span>· {execMs} ms</span>}
          {mode === 'record' && !noColumns && !noRows && (
            <span className="text-fg-secondary">
              · row {Math.min(selectedRow + 1, rows.length)} of {rows.length}
            </span>
          )}
        </span>

        {/* CSV export button — disabled until we have BOTH columns and rows. */}
        <button
          onClick={handleExportCsv}
          disabled={!canExport}
          title={canExport ? 'Export to CSV' : 'Nothing to export'}
          className={[
            'text-[11px] px-2 py-0.5 rounded border transition-colors select-none',
            !canExport
              ? 'border-line-subtle text-fg-faint cursor-not-allowed'
              : csvFlash
                ? 'border-success text-success'
                : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
          ].join(' ')}
        >
          {csvFlash ? '✓ Saved' : '↓ CSV'}
        </button>

        {/* JSON export button */}
        <button
          onClick={handleExportJson}
          disabled={!canExport}
          title={canExport ? 'Export to JSON' : 'Nothing to export'}
          className={[
            'text-[11px] px-2 py-0.5 rounded border transition-colors select-none',
            !canExport
              ? 'border-line-subtle text-fg-faint cursor-not-allowed'
              : jsonFlash
                ? 'border-success text-success'
                : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
          ].join(' ')}
        >
          {jsonFlash ? '✓ Saved' : '↓ JSON'}
        </button>

        {/* Copy as INSERT SQL button */}
        <button
          onClick={handleCopyInsert}
          disabled={!canExport}
          title={canExport ? 'Copy rows as INSERT SQL' : 'Nothing to copy'}
          className={[
            'text-[11px] px-2 py-0.5 rounded border transition-colors select-none',
            !canExport
              ? 'border-line-subtle text-fg-faint cursor-not-allowed'
              : insertFlash
                ? 'border-success text-success'
                : 'border-line text-fg-secondary hover:border-accent hover:text-fg-primary',
          ].join(' ')}
        >
          {insertFlash ? '✓ Copied' : '⇥ INSERT'}
        </button>
      </div>

      {/* ── Content area ────────────────────────────────────────────────
           noColumns  → fall back to a centred placeholder; there's no
                        meaningful header row to draw.
           otherwise  → always mount the active view.  Each view is
                        responsible for its own "no rows" affordance:
                          • Grid   — Glide DataEditor renders the column
                                     headers + an empty body when rows = 0,
                                     matching DBeaver / TablePlus.
                          • Text   — toMysqlTable() produces a header-only
                                     ASCII table (which is what users want
                                     for a quick `\d`-style schema peek).
                          • Record — already shows "No rows to display"
                                     inline in its right pane and keeps
                                     the field list visible.
       ─────────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        {noColumns ? (
          <div className="flex items-center justify-center h-full text-fg-muted text-[13px] italic select-none">
            No columns.
          </div>
        ) : (
          <>
            {mode === 'grid' && (
              <GridWithPanel
                columns={visibleColumns}
                rows={visibleRows}
                selectedRow={selectedRow}
                onSelectRow={setSelectedRow}
                editState={editState}
                onHeaderClicked={onHeaderClicked}
                sortConfig={sortConfig}
                exportFilename={exportFilename}
              />
            )}
            {mode === 'text' && (
              <TextView columns={columns} rows={rows} format={textFormat} />
            )}
            {mode === 'record' && (
              <RecordView
                columns={columns}
                rows={rows}
                selectedIdx={selectedRow}
                onSelectIdx={setSelectedRow}
                editState={editState}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
