import { useState, useEffect, useRef } from 'react'
import PagedResultViewer from './PagedResultViewer'
import { useEditState } from '../hooks/useEditState'

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helpers
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ResultPanel
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_TABS = ['Result', 'Messages', 'Plan']

/**
 * @param {object} props
 * @param {object|null} props.queryResult
 *   The active result set's payload (already extracted by the caller).
 * @param {boolean} props.isRunning
 *   Whether a batch is still executing — controls the "Running…" label.
 * @param {Array}   [props.resultSets]
 *   Optional list of {id,label,sql,queryResult} entries.  When more than
 *   one is present, ResultPanel renders a sub-tab strip under the status
 *   tabs so the user can hop between per-statement results (Run All).
 * @param {string|null} [props.activeResultId]
 *   Which entry from `resultSets` is currently surfaced.  When omitted,
 *   the strip defaults to the last entry.
 * @param {Function} [props.onSelectResult]
 *   Called with `(resultId)` when the user clicks a sub-tab.
 */
export default function ResultPanel({
  queryResult    = null,
  isRunning      = false,
  resultSets     = null,
  activeResultId = null,
  onSelectResult,
  onLoadMore,
}) {
  const [activeTab,    setActiveTab]    = useState('Result')
  const [fetchStats,   setFetchStats]   = useState(null)

  // ── Timing tracking ────────────────────────────────────────────────────
  // Record the JS-side start time when isRunning flips to true, then compute
  // fetchMs (total round-trip) when the result arrives.
  const fetchStartRef = useRef(null)

  useEffect(() => {
    if (isRunning) {
      fetchStartRef.current = performance.now()
    }
  }, [isRunning])

  useEffect(() => {
    if (!isRunning && queryResult && !queryResult.error && fetchStartRef.current !== null) {
      const fetchMs = Math.round(performance.now() - fetchStartRef.current)
      setFetchStats({
        rowCount:  queryResult.rows?.length ?? 0,
        execMs:    queryResult.execMs ?? 0,
        fetchMs,
        timestamp: new Date(),
      })
      fetchStartRef.current = null
    }
    if (!isRunning && queryResult?.error) {
      // Clear stale stats on error
      fetchStartRef.current = null
    }
  }, [queryResult, isRunning])

  const hasResult = queryResult !== null
  const hasError  = hasResult && !!queryResult.error
  // Wails marshals Go's nil slices as JSON `null`.  Statements that have no
  // result set (USE, SET, CREATE/DROP, most DML) therefore come back with
  // `columns: null, rows: null` — coerce both to [] so every downstream
  // array access (.length, .map, .forEach) is safe.
  const cols      = hasResult && !hasError && Array.isArray(queryResult.columns) ? queryResult.columns : []
  const allRows   = hasResult && !hasError && Array.isArray(queryResult.rows)    ? queryResult.rows    : []
  const totalRows = allRows.length
  // A statement is "result-set-less" when it executed fine but produced no
  // grid (USE, CREATE TABLE, SET …, most DML).  We show a tidy success
  // panel instead of an empty DataViewer so the user gets confirmation.
  const isEmptyResultSet = hasResult && !hasError && cols.length === 0

  const execMs    = hasResult ? queryResult.execMs : 0

  // ── Edit state (Phase 6.8) ─────────────────────────────────────────────
  // queryResult is used as resetKey: every new query clears all pending edits.
  const editState = useEditState(cols, allRows, queryResult)

  return (
    <div className="flex flex-col h-full bg-app border-t border-line">

      {/* ── Status tab bar ───────────────────────────────────────────── */}
      <div className="flex items-center bg-titlebar border-b border-line-subtle flex-shrink-0">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={[
              'px-4 py-2 text-[13px] border-r border-line-subtle transition-colors select-none',
              tab === activeTab
                ? 'bg-app text-fg-primary border-t-2 border-t-accent'
                : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
            ].join(' ')}
          >
            {tab}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-3 px-3 text-[11px] text-fg-muted">
          {isRunning && <span className="text-accent animate-pulse">Running…</span>}
          {activeTab === 'Result' && hasResult && !hasError && !isEmptyResultSet && (
            <span className={queryResult.truncated && !queryResult.hasMore ? 'text-warn' : ''}>
              {totalRows.toLocaleString()} rows shown
              {queryResult.hasMore ? ' · scroll to load more' : queryResult.truncated ? ' · limit reached' : ''}
              {' · '}{cols.length} cols
            </span>
          )}
          {activeTab === 'Result' && isEmptyResultSet && queryResult.rowsAffected > 0 && (
            <span className="text-success">
              {queryResult.rowsAffected.toLocaleString()} row(s) affected
            </span>
          )}
          {hasResult && <span>{execMs} ms</span>}
        </div>
      </div>

      {/* ── Multi-result sub-tab strip ──────────────────────────────────
          Visible only when Run All produced more than one result set.
          Each sub-tab corresponds to one statement and shows a small
          status glyph: ✓ success, ✗ error, … still running. */}
      {Array.isArray(resultSets) && resultSets.length > 1 && activeTab === 'Result' && (
        <div className="flex items-center bg-elevated border-b border-line-subtle flex-shrink-0 overflow-x-auto">
          {resultSets.map((r, idx) => {
            const err   = r.queryResult?.error
            const glyph = err ? '✗' : '✓'
            const color = err ? 'text-danger' : 'text-success'
            const active = r.id === activeResultId
            return (
              <button
                key={r.id}
                onClick={() => onSelectResult?.(r.id)}
                title={r.sql}
                className={[
                  'flex items-center gap-2 px-3 py-1 text-[11px] border-r border-line-subtle',
                  'select-none flex-shrink-0 transition-colors',
                  active
                    ? 'bg-app text-fg-primary border-t-2 border-t-accent'
                    : 'text-fg-muted hover:text-fg-primary hover:bg-hover',
                ].join(' ')}
              >
                <span className={color}>{glyph}</span>
                <span>Result {idx + 1}</span>
                <span className="text-fg-muted truncate max-w-[140px]">{r.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Panel body ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">

        {/* ── Result tab ──────────────────────────────────────────────── */}
        {activeTab === 'Result' && (
          <>
            {isRunning && (
              <div className="flex-1 flex items-center justify-center text-fg-muted text-[13px]">
                <span className="animate-pulse">Executing query…</span>
              </div>
            )}
            {!isRunning && !hasResult && (
              <div className="flex-1 flex items-center justify-center text-fg-muted text-[13px] select-none gap-2">
                Press
                <kbd className="px-1.5 py-0.5 bg-elevated border border-line-subtle rounded text-[11px] text-accent-text">Cmd+Enter</kbd>
                to run the query
              </div>
            )}
            {!isRunning && hasError && (
              <div className="flex-1 p-4 font-mono text-[13px] overflow-auto">
                <div className="text-danger font-semibold mb-1">Query error</div>
                <pre className="text-fg-primary whitespace-pre-wrap">{queryResult.error}</pre>
              </div>
            )}
            {!isRunning && isEmptyResultSet && (
              <div className="flex-1 p-4 font-mono text-[13px] overflow-auto select-text">
                <div className="text-success font-semibold mb-1">
                  ✓ Statement executed successfully
                </div>
                <div className="text-fg-primary">
                  {queryResult.rowsAffected > 0
                    ? `${queryResult.rowsAffected.toLocaleString()} row(s) affected`
                    : 'No rows affected'}
                  {' · '}{execMs} ms
                </div>
                <div className="text-fg-muted text-[11px] mt-2">
                  This statement returned no result set.
                </div>
              </div>
            )}
            {!isRunning && hasResult && !hasError && !isEmptyResultSet && (
              <PagedResultViewer
                columns={cols}
                rows={allRows}
                execMs={execMs}
                truncated={queryResult.truncated}
                hasMore={!!queryResult.hasMore}
                loadingMore={!!queryResult.loadingMore}
                capped={queryResult.truncated && !queryResult.hasMore}
                onLoadMore={onLoadMore}
                exportFilename="query_result.csv"
                fetchStats={fetchStats}
                editState={editState}
                isDirty={editState.isDirty}
                hasSelection={editState.selectedRow !== null}
                onAddRow={editState.addRow}
                onDuplicateRow={() => editState.duplicateRow()}
                onDeleteRow={() => editState.deleteRow()}
                // Ad-hoc query results (possibly joins / aliases) lack a
                // single owning table, so inline-save is disabled here.
                // Open the table via the Explorer to get an editable grid.
                onSave={undefined}
                onCancel={editState.cancel}
              />
            )}
          </>
        )}

        {/* ── Messages tab ────────────────────────────────────────────── */}
        {activeTab === 'Messages' && (
          <div className="p-4 font-mono text-[13px] space-y-1 overflow-auto">
            {!hasResult
              ? <div className="text-fg-muted">No query run yet.</div>
              : hasError
                ? (
                  <>
                    <div className="text-danger font-semibold">✗ Error</div>
                    <pre className="text-fg-primary whitespace-pre-wrap text-[12px]">{queryResult.error}</pre>
                  </>
                )
                : (
                  <>
                    <div className="text-success">✓ Query executed successfully</div>
                    <div className="text-fg-primary">
                      {totalRows.toLocaleString()} row(s) in {execMs} ms
                      {queryResult.hasMore && <span className="text-fg-muted"> — scroll to load more</span>}
                      {queryResult.truncated && !queryResult.hasMore && <span className="text-warn"> — result limited to {totalRows.toLocaleString()} rows</span>}
                    </div>
                    {queryResult.rowsAffected > 0 && (
                      <div className="text-fg-primary">{queryResult.rowsAffected.toLocaleString()} row(s) affected</div>
                    )}
                    <div className="text-fg-muted mt-2">Connection: localhost:3306 / db1</div>
                    {fetchStats && (
                      <div className="text-fg-muted text-[11px] mt-1">
                        JS fetch time: {fetchStats.fetchMs} ms (backend: {fetchStats.execMs} ms)
                      </div>
                    )}
                  </>
                )
            }
          </div>
        )}

        {/* ── Plan tab ────────────────────────────────────────────────── */}
        {activeTab === 'Plan' && (
          <div className="p-4 font-mono text-[13px] text-fg-muted">
            No execution plan available. Prefix your query with{' '}
            <span className="text-accent-text font-semibold">EXPLAIN</span> to see the plan.
          </div>
        )}
      </div>
    </div>
  )
}
