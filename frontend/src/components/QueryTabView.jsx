/**
 * QueryTabView — read-only result pane for a single, predefined SQL.
 *
 * Used by the Database Explorer for "system info" leaves like
 *   • Session Status      → SHOW SESSION STATUS
 *   • Global Variables    → SHOW GLOBAL VARIABLES
 *   • Engines             → SHOW ENGINES
 *   • Session Manager     → SHOW PROCESSLIST
 *   • Users               → SELECT user, host FROM mysql.user
 *
 * The component re-runs the query whenever (connId, sql) changes — usually
 * once per tab lifetime, but a refresh button at the top lets the user
 * re-issue it on demand without closing/reopening the tab.
 *
 * Shows a small toolbar with the query (read-only) + a Refresh button, then
 * delegates the actual rendering to <ResultPanel/> so behaviour matches
 * SQL-console results (sort, search, export, value panel, etc.).
 */
import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import { runQuery } from '../lib/bridge'
import { normalizeError } from '../lib/errors'
import ResultPanel from './ResultPanel'

export default function QueryTabView({ sql, connId, label }) {
  const [queryResult, setQueryResult] = useState(null)
  const [isRunning,   setIsRunning]   = useState(true)

  const execute = useCallback(() => {
    if (!sql || !connId) return
    let cancelled = false
    setIsRunning(true)
    runQuery(connId, '', sql)
      .then((result) => {
        if (cancelled) return
        setQueryResult(result)
      })
      .catch((err) => {
        if (cancelled) return
        setQueryResult({
          columns: [], rows: [], rowCount: 0, truncated: false,
          rowsAffected: 0, execMs: 0,
          error: normalizeError(err),
        })
      })
      .finally(() => {
        if (!cancelled) setIsRunning(false)
      })
    return () => { cancelled = true }
  }, [sql, connId])

  useEffect(() => execute(), [execute])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Read-only SQL bar with Refresh */}
      <div className="flex items-center gap-2 px-3 py-1 bg-elevated border-b border-line-subtle
                      flex-shrink-0 text-[11px]">
        <span className="text-fg-muted uppercase tracking-wider text-[10px]">Query</span>
        <code className="text-syntax-string truncate flex-1" title={sql}>{sql}</code>
        <button
          onClick={execute}
          disabled={isRunning}
          title={`Re-run ${label ?? 'query'}`}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-fg-muted
                     hover:text-fg-primary hover:bg-hover transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <RefreshCw size={11} className={isRunning ? 'animate-spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      <div className="flex-1 overflow-hidden">
        <ResultPanel queryResult={queryResult} isRunning={isRunning} />
      </div>
    </div>
  )
}
