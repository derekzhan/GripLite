/**
 * ActionFooter — high-density bottom bar for the data grid (Phase 6.5 / 6.8).
 *
 * Layout (two rows):
 *
 *   ┌─ Action bar (36px) ────────────────────────────────────────────────────┐
 *   │ [↻▾] │ [+] [⧉Dup] [−] [✓] [✗] │ [|<] [<] 1/5 [>] [>|]  │  [↓▾] [200] 1-200/1k │
 *   └────────────────────────────────────────────────────────────────────────┘
 *   ┌─ Status strip (18px) ──────────────────────────────────────────────────┐
 *   │ 1,000 row(s) fetched — 0.145s (0.892s fetch), on 2026-04-16 at 14:23  │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Props:
 *   pageSize          number | 'all'     current page / fetch size
 *   setPageSize       (v) => void
 *   currentPage       number             1-based
 *   setCurrentPage    (n) => void
 *   totalRows         number             total rows in the full result set
 *
 *   onRefresh?        () => void         called by the Refresh button
 *   isRefreshing?     boolean            shows spinner on the Refresh button
 *
 *   onExportCsv?      () => void         triggered by Export → CSV
 *   exportFilename?   string             used in the Export tooltip
 *
 *   fetchStats?       {                  set after a successful fetch
 *                       rowCount: number,
 *                       execMs:   number,   ← backend SQL execution time
 *                       fetchMs:  number,   ← full JS round-trip time
 *                       timestamp: Date,
 *                     }
 *
 * Edit action props (Phase 6.8 — wired to useEditState):
 *   isDirty?          boolean           true when unsaved edits exist
 *   hasSelection?     boolean           true when a row is selected
 *   onAddRow?         () => void
 *   onDuplicateRow?   () => void
 *   onDeleteRow?      () => void
 *   onSave?           () => void
 *   onCancel?         () => void
 */
import { useState, useRef, useCallback } from 'react'
import {
  RefreshCw, ChevronDown,
  Plus, Copy, Trash2, Check, X,
  ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight,
  Download,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_SIZE_PRESETS = [20, 50, 100, 200, 500, 1000]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function totalPages(pageSize, totalRows) {
  if (pageSize === 'all') return 1
  return Math.max(1, Math.ceil(totalRows / pageSize))
}

function fmtSec(ms) {
  if (ms == null) return '—'
  return (ms / 1000).toFixed(3) + 's'
}

function fmtStatus({ rowCount, execMs, fetchMs, timestamp }) {
  const dt   = new Date(timestamp)
  const date = dt.toISOString().slice(0, 10)
  const time = dt.toTimeString().slice(0, 8)
  return `${rowCount.toLocaleString()} row(s) fetched — ${fmtSec(execMs)} (${fmtSec(fetchMs)} fetch), on ${date} at ${time}`
}

// Offset + last-row for the range label
function rowRange(pageSize, currentPage, totalRows) {
  if (totalRows === 0) return { first: 0, last: 0 }
  if (pageSize === 'all') return { first: 1, last: totalRows }
  const first = (currentPage - 1) * pageSize + 1
  const last  = Math.min(currentPage * pageSize, totalRows)
  return { first, last }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small UI primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact icon-button used across the footer.
 *
 * variant:
 *   'default' – gray, highlights blue on active
 *   'save'    – teal/green; used for the Save (✓) button when isDirty
 *   'danger'  – orange/red; used for the Cancel (✗) button when isDirty
 */
function IconBtn({ icon: Icon, label, onClick, disabled = false, active = false, variant = 'default' }) {
  const colors = {
    default: disabled
      ? 'text-fg-faint cursor-not-allowed'
      : active
        ? 'text-fg-on-accent bg-accent'
        : 'text-fg-muted hover:text-fg-primary hover:bg-hover active:bg-accent',
    save: disabled
      ? 'text-fg-faint cursor-not-allowed'
      : 'text-success hover:text-fg-on-accent hover:bg-success/30 active:bg-success/50',
    danger: disabled
      ? 'text-fg-faint cursor-not-allowed'
      : 'text-danger hover:text-fg-on-accent hover:bg-danger/30 active:bg-danger/50',
  }

  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={label}
      className={[
        'flex items-center justify-center w-7 h-7 rounded transition-colors select-none',
        colors[variant] ?? colors.default,
      ].join(' ')}
    >
      <Icon size={13} strokeWidth={1.8} />
    </button>
  )
}

/** 1-px vertical separator */
function Sep() {
  return <span className="h-4 w-px bg-line mx-0.5 flex-shrink-0" />
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh button — plain button + tiny dropdown for quick-size presets
// ─────────────────────────────────────────────────────────────────────────────
function RefreshBtn({ onRefresh, isRefreshing, pageSize, setPageSize, setCurrentPage }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const pick = (size) => {
    setPageSize(size)
    setCurrentPage(1)
    setOpen(false)
    onRefresh?.()
  }

  // Close on outside click
  const onBlur = useCallback((e) => {
    if (ref.current && !ref.current.contains(e.relatedTarget)) setOpen(false)
  }, [])

  return (
    <div ref={ref} className="relative flex" onBlur={onBlur}>
      {/* Main refresh button */}
      <button
        onClick={() => onRefresh?.()}
        disabled={isRefreshing}
        title="Refresh (Ctrl+R)"
        className="flex items-center gap-1 pl-1.5 pr-1 h-7 rounded-l text-[11px]
                   text-fg-muted hover:text-fg-primary hover:bg-hover transition-colors select-none
                   disabled:text-fg-faint disabled:cursor-default"
      >
        <RefreshCw
          size={12}
          strokeWidth={2}
          className={isRefreshing ? 'animate-spin text-accent' : ''}
        />
        <span className="hidden sm:inline">Refresh</span>
      </button>

      {/* Dropdown toggle */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Refresh options"
        className="flex items-center justify-center w-5 h-7 rounded-r
                   text-fg-faint hover:text-fg-primary hover:bg-hover transition-colors select-none"
      >
        <ChevronDown size={10} strokeWidth={2} />
      </button>

      {/* Dropdown menu */}
      {open && (
        <div className="absolute left-0 top-full mt-0.5 z-50 min-w-[160px]
                        bg-panel border border-line rounded shadow-xl shadow-black/50 overflow-hidden">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted border-b border-line-subtle select-none">
            Refresh with fetch size
          </div>
          {PAGE_SIZE_PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => pick(n)}
              className={[
                'flex items-center w-full px-3 py-1.5 text-[12px] transition-colors text-left',
                pageSize === n
                  ? 'bg-accent text-fg-on-accent'
                  : 'text-fg-secondary hover:bg-hover',
              ].join(' ')}
            >
              {n} rows
            </button>
          ))}
          <button
            onClick={() => pick('all')}
            className={[
              'flex items-center w-full px-3 py-1.5 text-[12px] transition-colors text-left border-t border-line-subtle',
              pageSize === 'all'
                ? 'bg-accent text-fg-on-accent'
                : 'text-fg-secondary hover:bg-hover',
            ].join(' ')}
          >
            All rows
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Export dropdown
// ─────────────────────────────────────────────────────────────────────────────
function ExportBtn({ onExportCsv, exportFilename }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const onBlur = useCallback((e) => {
    if (ref.current && !ref.current.contains(e.relatedTarget)) setOpen(false)
  }, [])

  return (
    <div ref={ref} className="relative flex" onBlur={onBlur}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Export data"
        className="flex items-center gap-1 px-1.5 h-7 rounded text-[11px]
                   text-fg-muted hover:text-fg-primary hover:bg-hover transition-colors select-none"
      >
        <Download size={12} strokeWidth={1.8} />
        <ChevronDown size={10} strokeWidth={2} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-0.5 z-50 min-w-[160px]
                        bg-panel border border-line rounded shadow-xl shadow-black/50 overflow-hidden">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-muted border-b border-line-subtle select-none">
            Export current page
          </div>
          <button
            onClick={() => { onExportCsv?.(); setOpen(false) }}
            className="flex items-center w-full px-3 py-1.5 text-[12px] text-fg-secondary hover:bg-hover transition-colors text-left"
          >
            CSV {exportFilename ? `(${exportFilename})` : ''}
          </button>
          <button
            onClick={() => { console.log('[ActionFooter] Export JSON — not yet implemented'); setOpen(false) }}
            className="flex items-center w-full px-3 py-1.5 text-[12px] text-fg-muted hover:bg-hover transition-colors text-left"
          >
            JSON (coming soon)
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ActionFooter
// ─────────────────────────────────────────────────────────────────────────────
export default function ActionFooter({
  pageSize,
  setPageSize,
  currentPage,
  setCurrentPage,
  totalRows,
  mode = 'paged',
  statusLabel = '',
  onRefresh,
  isRefreshing = false,
  onExportCsv,
  exportFilename,
  fetchStats,
  // ── Edit action props (Phase 6.8) ──────────────────────────────────────
  isDirty      = false,
  hasSelection = false,
  onAddRow,
  onDuplicateRow,
  onDeleteRow,
  onSave,
  onCancel,
}) {
  const [jumpValue, setJumpValue] = useState('')
  const total = totalPages(pageSize, totalRows)
  const { first: firstRow, last: lastRow } = rowRange(pageSize, currentPage, totalRows)
  const isInfinite = mode === 'infinite'

  const goTo = useCallback((p) => {
    setCurrentPage(Math.max(1, Math.min(total, p)))
  }, [total, setCurrentPage])

  // Fetch-size number input → update pageSize
  const onFetchSizeChange = (e) => {
    const raw = e.target.value.trim()
    if (raw === '' || raw === '0') return
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n > 0) {
      setPageSize(n)
      setCurrentPage(1)
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  const atFirst = currentPage <= 1
  const atLast  = currentPage >= total

  return (
    <div className="flex flex-col flex-shrink-0 bg-titlebar border-t border-line-subtle select-none">

      {/* ── Action bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center h-9 px-1 gap-0.5">

        {/* ── LEFT GROUP ─────────────────────────────────────────────── */}

        {/* Refresh button */}
        <RefreshBtn
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
          pageSize={pageSize}
          setPageSize={setPageSize}
          setCurrentPage={setCurrentPage}
        />

        <Sep />

        {/* ── CRUD buttons (Phase 6.8 edit actions) ──────────────────── */}
        <IconBtn
          icon={Plus}
          label="Add new row"
          onClick={onAddRow}
          disabled={!onAddRow}
        />
        <IconBtn
          icon={Copy}
          label="Duplicate selected row"
          onClick={onDuplicateRow}
          disabled={!onDuplicateRow || !hasSelection}
        />
        <IconBtn
          icon={Trash2}
          label={isDirty && hasSelection ? 'Delete selected row' : 'Delete row (select a row first)'}
          onClick={onDeleteRow}
          disabled={!onDeleteRow || !hasSelection}
          variant={isDirty && hasSelection ? 'danger' : 'default'}
        />
        <IconBtn
          icon={Check}
          label={isDirty ? 'Save changes' : 'No unsaved changes'}
          onClick={onSave}
          disabled={!isDirty || !onSave}
          variant={isDirty ? 'save' : 'default'}
        />
        <IconBtn
          icon={X}
          label={isDirty ? 'Discard all changes' : 'No changes to discard'}
          onClick={onCancel}
          disabled={!isDirty || !onCancel}
          variant={isDirty ? 'danger' : 'default'}
        />

        <Sep />

        {/* Pagination navigation */}
        {!isInfinite && (
          <>
            <IconBtn icon={ChevronsLeft}  label="First page" onClick={() => goTo(1)}                disabled={atFirst} />
            <IconBtn icon={ChevronLeft}   label="Previous page" onClick={() => goTo(currentPage - 1)} disabled={atFirst} />

            {/* Page indicator */}
            {pageSize !== 'all' && (
              <div className="flex items-center gap-1 px-1">
                <input
                  type="text"
                  inputMode="numeric"
                  value={jumpValue !== '' ? jumpValue : currentPage}
                  onChange={(e) => setJumpValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    const n = parseInt(jumpValue, 10)
                    if (!isNaN(n)) goTo(n)
                    setJumpValue('')
                  }}
                  onBlur={() => setJumpValue('')}
                  className="w-10 text-center bg-elevated text-fg-primary border border-line
                             rounded px-1 py-0.5 text-[11px] tabular-nums outline-none
                             focus:border-accent transition-colors"
                />
                <span className="text-[11px] text-fg-muted tabular-nums">/</span>
                <span className="text-[11px] text-fg-secondary tabular-nums">{total.toLocaleString()}</span>
              </div>
            )}

            <IconBtn icon={ChevronRight}  label="Next page" onClick={() => goTo(currentPage + 1)} disabled={atLast} />
            <IconBtn icon={ChevronsRight} label="Last page" onClick={() => goTo(total)}            disabled={atLast} />
          </>
        )}

        {/* ── Spacer ────────────────────────────────────────────────── */}
        <div className="flex-1" />

        {/* ── RIGHT GROUP ────────────────────────────────────────────── */}

        {/* Export dropdown */}
        <ExportBtn onExportCsv={onExportCsv} exportFilename={exportFilename} />

        <Sep />

        {!isInfinite && (
          <>
            {/* Fetch-size input */}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-fg-muted uppercase tracking-wider">Fetch</span>
              <input
                type="number"
                min={1}
                max={100000}
                defaultValue={typeof pageSize === 'number' ? pageSize : 200}
                onBlur={onFetchSizeChange}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
                className="w-16 text-center bg-elevated text-fg-primary border border-line
                           rounded px-1 py-0.5 text-[11px] tabular-nums outline-none
                           focus:border-accent transition-colors
                           [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>

            <Sep />
          </>
        )}

        {/* Row range indicator */}
        <span className="text-[11px] text-fg-secondary tabular-nums px-1 whitespace-nowrap">
          {totalRows === 0 ? (
            <span className="text-fg-muted">No data</span>
          ) : (
            <>
              {isInfinite ? (
                <span>{statusLabel || `${totalRows.toLocaleString()} rows shown`}</span>
              ) : (
                <>
                  <span className="text-fg-primary">{firstRow.toLocaleString()}</span>
                  {' – '}
                  <span className="text-fg-primary">{lastRow.toLocaleString()}</span>
                  {' of '}
                  <span>{totalRows.toLocaleString()}</span>
                </>
              )}
            </>
          )}
        </span>
      </div>

      {/* ── Status strip ───────────────────────────────────────────────── */}
      {fetchStats && (
        <div className="flex items-center h-[18px] px-2 border-t border-line-subtle
                        bg-sunken">
          <span className="text-[10px] text-fg-muted tabular-nums truncate">
            {fmtStatus(fetchStats)}
          </span>
        </div>
      )}
    </div>
  )
}
