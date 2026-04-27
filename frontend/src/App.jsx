/**
 * App.jsx — GripLite root component.
 *
 * Tab model
 * ─────────
 * Every entry in `tabs` is one of:
 *   { id, type: 'console',   label }
 *   { id, type: 'table',     label, tableName, dbName, connId }
 *   { id, type: 'dbviewer',  label, dbName, connId }
 *
 * SQL-console tabs carry their own queryResult / isRunning inside a
 * `consolesData` map so that switching tabs never loses the result set.
 *
 * TableViewer and DatabaseViewer tabs manage ALL of their own state internally.
 * App.jsx only needs to know about them at a structural level.
 *
 * State isolation strategy
 * ────────────────────────
 * All tab types are kept permanently mounted; only `display` CSS changes
 * when switching tabs. React therefore never unmounts any component on a
 * tab switch, so every piece of internal state is preserved automatically.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import SplitPane          from './components/SplitPane'
import DatabaseExplorer   from './components/DatabaseExplorer'
import SqlEditor          from './components/SqlEditor'
import ResultPanel        from './components/ResultPanel'
import TableViewer        from './components/TableViewer'
import DatabaseViewer     from './components/DatabaseViewer'
import QueryTabView       from './components/QueryTabView'
import ConnectionDialog   from './components/ConnectionDialog'
import MenuBar            from './components/MenuBar'
import ThemeToggle        from './components/ThemeToggle'
import AboutModal              from './components/AboutModal'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'
import ErrorBoundary      from './components/ErrorBoundary'
import { Toaster, toast } from './lib/toast'
import { normalizeError } from './lib/errors'
import { runQuery, runQueryPage, listConnections, getBuildInfo } from './lib/bridge'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CONN_ID = 'mock-conn'
let   nextConsoleSeq  = 1

function makeConsoleTab() {
  const seq = nextConsoleSeq++
  return {
    id:    `console-${seq}`,
    type:  'console',
    label: seq === 1 ? 'SQL Console' : `SQL Console ${seq}`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Connection state (Phase 13) ──────────────────────────────────────────
  //
  // The whole app shares one list of connections so that saving a new
  // connection in ConnectionDialog can refresh the DatabaseExplorer tree
  // without either component owning the other's state.
  //
  //   connections        — ConnectionInfo[] shown in the Explorer tree.
  //   activeConnId       — the connection currently highlighted/used by
  //                        SQL consoles (first entry after boot, then
  //                        whichever connection the user most recently
  //                        saved/connected via the Properties dialog).
  //   connectionsReloadKey — opaque int that bumps whenever the list should
  //                        be re-fetched; DatabaseExplorer listens to it.
  const [connections,          setConnections]          = useState([])
  const [activeConnId,         setActiveConnId]         = useState(DEFAULT_CONN_ID)
  const [connectionsReloadKey, setConnectionsReloadKey] = useState(0)
  const connIdRef = useRef(DEFAULT_CONN_ID)

  /** Trigger Explorer + local connection list refresh. */
  const reloadConnections = useCallback(() => {
    setConnectionsReloadKey((n) => n + 1)
  }, [])

  // Load connections on mount and whenever reloadKey changes.
  useEffect(() => {
    let cancelled = false
    listConnections()
      .then((conns) => {
        if (cancelled) return
        setConnections(conns)
        // Preserve the currently-selected connection if it still exists;
        // otherwise fall back to the first entry (or the default mock id).
        setActiveConnId((prev) => {
          if (conns.some((c) => c.id === prev)) return prev
          const next = conns[0]?.id ?? DEFAULT_CONN_ID
          connIdRef.current = next
          return next
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [connectionsReloadKey])

  // Keep the legacy ref in sync with activeConnId.
  useEffect(() => { connIdRef.current = activeConnId }, [activeConnId])

  const connInfo = connections.find((c) => c.id === activeConnId) ?? null

  // ── Tab state ─────────────────────────────────────────────────────────────
  // Phase 13 / Task 1: No demo tab on cold start.  The workspace opens on the
  // WelcomePane (see below) until the user explicitly opens a console, table,
  // or database tab.
  const [tabs,        setTabs]        = useState([])
  const [activeTabId, setActiveTabId] = useState('')

  /**
   * consolesData: {
   *   [tabId]: {
   *     resultSets:     [{ id, label, sql, queryResult }],
   *     activeResultId: string | null,
   *     isRunning:      boolean,
   *   }
   * }
   *
   * Single-run queries always produce one resultSet.  "Run all" populates
   * one resultSet per statement and lets the ResultPanel render sub-tabs.
   * Keeping the list per-console means switching tabs never loses results.
   */
  const [consolesData, setConsolesData] = useState({})

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Monotonic id generator for result-set sub-tabs.  Module-level counter is
  // fine — we only need uniqueness within a single session.
  const resultIdRef = useRef(0)
  const nextResultId = () => `r${++resultIdRef.current}`

  // Trim long SQL to a compact label for the result sub-tab.
  const labelForSql = (sql) => {
    const compact = sql.replace(/\s+/g, ' ').trim()
    return compact.length > 60 ? compact.slice(0, 57) + '…' : compact
  }

  /**
   * handleRunQuery — execute one or many SQL statements for a SQL Console.
   *
   *   @param sqlOrList  string | string[]
   *   @param consoleId  tab id; defaults to active tab
   *   @param opts.multi true ⇒ sqlOrList is an array, run sequentially and
   *                     produce one result sub-tab per statement.
   *
   * The function is async and intentionally serial (no Promise.all) because
   * statement N+1 often depends on the outcome of N — e.g. USE before a
   * SELECT.  Results are appended to resultSets as they complete so the
   * user sees progress instead of a spinner until the whole batch finishes.
   */
  const handleRunQuery = useCallback(async (sqlOrList, consoleId, opts = {}) => {
    const tabId = consoleId ?? activeTabId

    const list = opts.multi && Array.isArray(sqlOrList)
      ? sqlOrList.filter((s) => s && s.trim())
      : [String(sqlOrList ?? '').trim()].filter(Boolean)

    if (list.length === 0) return

    setConsolesData((prev) => ({
      ...prev,
      [tabId]: {
        resultSets:     [],
        activeResultId: null,
        isRunning:      true,
      },
    }))

    for (const sql of list) {
      const rid = nextResultId()
      let queryResult
      try {
        queryResult = await runQuery(connIdRef.current, opts.dbName ?? '', sql)
      } catch (err) {
        // Two separate hardening steps here:
        //   1. normalizeError() guarantees a string → React cannot crash
        //      when we inline `queryResult.error` into JSX (prevents the
        //      "Objects are not valid as a React child" white-screen).
        //   2. A toast surfaces the failure even if the result panel is
        //      collapsed or pointing at a different sub-tab.
        const msg = normalizeError(err)
        toast.error(`Query failed: ${msg}`)
        queryResult = {
          columns: [], rows: [], rowCount: 0, truncated: false,
          rowsAffected: 0, execMs: 0, error: msg,
        }
      }
      const entry = { id: rid, label: labelForSql(sql), sql, queryResult }

      setConsolesData((prev) => {
        const prevTab = prev[tabId] ?? { resultSets: [], activeResultId: null, isRunning: true }
        const nextSets = [...prevTab.resultSets, entry]
        return {
          ...prev,
          [tabId]: {
            resultSets:     nextSets,
            // Always focus the latest result so the grid scrolls into view.
            activeResultId: rid,
            isRunning:      true,
          },
        }
      })
    }

    setConsolesData((prev) => ({
      ...prev,
      [tabId]: { ...prev[tabId], isRunning: false },
    }))
  }, [activeTabId])

  const handleSelectResult = useCallback((consoleId, resultId) => {
    setConsolesData((prev) => {
      const d = prev[consoleId]
      if (!d) return prev
      return { ...prev, [consoleId]: { ...d, activeResultId: resultId } }
    })
  }, [])

  // ── Load More (offset pagination) ─────────────────────────────────────────
  const handleLoadMore = useCallback(async (consoleId, resultId) => {
    const data   = consolesData[consoleId]
    if (!data) return
    const entry  = data.resultSets?.find((r) => r.id === resultId)
    if (!entry || !entry.queryResult?.truncated) return
    const offset = entry.queryResult.rows?.length ?? 0
    if (offset === 0) return

    // Mark loading state
    setConsolesData((prev) => ({
      ...prev,
      [consoleId]: { ...prev[consoleId], loadingMore: true },
    }))

    try {
      const pageResult = await runQueryPage(
        connIdRef.current,
        entry.queryResult.dbName ?? '',
        entry.sql,
        offset,
        1000,
      )
      if (!pageResult?.error && Array.isArray(pageResult?.rows)) {
        setConsolesData((prev) => {
          const d = prev[consoleId]
          if (!d) return prev
          const nextSets = d.resultSets.map((r) => {
            if (r.id !== resultId) return r
            const merged = {
              ...r.queryResult,
              rows:      [...(r.queryResult.rows ?? []), ...pageResult.rows],
              rowCount:  (r.queryResult.rows?.length ?? 0) + pageResult.rows.length,
              truncated: pageResult.truncated,
            }
            return { ...r, queryResult: merged }
          })
          return { ...d, resultSets: nextSets, loadingMore: false }
        })
      }
    } catch {
      // ignore load-more errors
    } finally {
      setConsolesData((prev) => {
        const d = prev[consoleId]
        if (!d) return prev
        return { ...prev, [consoleId]: { ...d, loadingMore: false } }
      })
    }
  }, [consolesData])

  // ── Table open ────────────────────────────────────────────────────────────
  /**
   * handleTableOpen — opens or activates a TableViewer tab.
   *
   * @param {{ tableName, dbName, connId, defaultView? }} opts
   *   defaultView: 'properties' | 'data'  (only applied on first open;
   *   after that the tab owns its own internal state).
   */
  const handleTableOpen = useCallback(({ tableName, dbName, connId, defaultView }) => {
    const effectiveConnId = connId ?? connIdRef.current
    const tabId = `table:${effectiveConnId}:${dbName}:${tableName}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev   // already open → just switch
      return [...prev, {
        id: tabId, type: 'table', label: tableName,
        tableName, dbName,
        connId:      effectiveConnId,
        defaultView: defaultView ?? 'properties',
      }]
    })
    setActiveTabId(tabId)
  }, [])

  // ── Read-only query tab open (Phase 22) ───────────────────────────────────
  /**
   * handleQueryOpen — opens a tab that runs a fixed SQL once and renders the
   * result via ResultPanel.  Used by the Database Explorer's System Info,
   * Users, and Administer leaves so the user gets immediate feedback (e.g.
   * `SHOW PROCESSLIST`) without having to spawn a SQL console and type the
   * statement themselves.
   *
   * `key` makes tabs from different sources de-duplicate independently:
   * opening "Session Status" twice activates the same tab, but opening
   * "Session Status" + "Global Status" creates two tabs because their keys
   * differ.
   *
   * @param {{ key: string, label: string, sql: string, connId?: string }} opts
   */
  const handleQueryOpen = useCallback(({ key, label, sql, connId }) => {
    const effectiveConnId = connId ?? connIdRef.current
    const tabId = `query:${effectiveConnId}:${key}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev
      return [...prev, {
        id: tabId, type: 'query', label,
        sql, connId: effectiveConnId,
      }]
    })
    setActiveTabId(tabId)
  }, [])

  // ── Database viewer open ──────────────────────────────────────────────────
  const handleDatabaseOpen = useCallback(({ dbName, connId }) => {
    const effectiveConnId = connId ?? connIdRef.current
    const tabId = `db:${effectiveConnId}:${dbName}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev   // already open → activate
      return [...prev, {
        id: tabId, type: 'dbviewer',
        label: `${dbName} — Tables`,
        dbName,
        connId: effectiveConnId,
      }]
    })
    setActiveTabId(tabId)
  }, [])

  // ── New SQL console ───────────────────────────────────────────────────────
  //
  // Optional opts.initialSql lets callers (e.g. the Explorer's "Browse from
  // here" / "Create New Table" actions) seed the freshly-spawned console
  // with template SQL.  The string is stored on the tab descriptor and
  // forwarded to <SqlEditor initialSql={...}/> when the tab mounts.
  const handleNewConsole = useCallback((opts) => {
    const tab = makeConsoleTab()
    if (opts?.initialSql) tab.initialSql = opts.initialSql
    if (opts?.label)      tab.label      = opts.label
    if (opts?.defaultDb)  tab.defaultDb  = opts.defaultDb
    setTabs((prev) => [...prev, tab])
    // NOTE: this seed MUST match the shape expected by the ResultPanel
    // render path (see `activeResult` derivation below).  The old shape
    // had `queryResult` only; forgetting to migrate this seed causes a
    // `Cannot read properties of undefined (reading 'find')` crash the
    // first time a new console tab is rendered → white screen.
    setConsolesData((prev) => ({
      ...prev,
      [tab.id]: { resultSets: [], activeResultId: null, isRunning: false },
    }))
    setActiveTabId(tab.id)
  }, [])

  // ── Tab close ─────────────────────────────────────────────────────────────
  //
  // Phase 13 / Task 1: closing the last tab now leaves tabs=[] and returns the
  // user to the WelcomePane instead of spawning a replacement console.
  const handleTabClose = useCallback((e, tabId) => {
    e.stopPropagation()
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId)
      setActiveTabId((cur) => {
        if (cur !== tabId) return cur
        const idx = prev.findIndex((t) => t.id === tabId)
        return next[Math.max(0, idx - 1)]?.id ?? next[0]?.id ?? ''
      })
      return next
    })
    setConsolesData((prev) => {
      const { [tabId]: _dropped, ...rest } = prev
      return rest
    })
  }, [])

  // ── Connection dialog state ────────────────────────────────────────────────
  const [connDialogOpen,  setConnDialogOpen]  = useState(false)
  const [connDialogInitId, setConnDialogInitId] = useState(null)

  // ── Phase 18: About modal ──────────────────────────────────────────────────
  const [aboutOpen,  setAboutOpen]  = useState(false)
  const [docsOpen,   setDocsOpen]   = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getBuildInfo().then((info) => setAppVersion(info?.version ?? '')).catch(() => {})
  }, [])

  const handleNewConnectionOpen = useCallback(() => {
    setConnDialogInitId(null)
    setConnDialogOpen(true)
  }, [])

  const handlePropertiesOpen = useCallback((connId) => {
    setConnDialogInitId(connId ?? null)
    setConnDialogOpen(true)
  }, [])

  /**
   * handleDialogSaved — fired by ConnectionDialog after EVERY successful
   * save (Apply, OK, or Test+Save), regardless of whether a live connection
   * was opened.  Reloads the explorer tree and auto-selects the just-saved
   * entry so the user never has to hunt for it.
   */
  const handleDialogSaved = useCallback((connId) => {
    if (connId) setActiveConnId(connId)
    reloadConnections()
  }, [reloadConnections])

  // ── Derived ───────────────────────────────────────────────────────────────
  const connLabel   = connInfo ? `${connInfo.host}:${connInfo.port} / ${connInfo.database}` : 'Not connected'
  const connVersion = connInfo?.serverVersion ?? ''
  const anyRunning  = Object.values(consolesData).some((d) => d.isRunning)

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ background: 'var(--bg-app)', color: 'var(--fg-primary)' }}
    >

      {/* ── Title bar (Phase 18) ──────────────────────────────────────────
          Hosts the custom menu bar on the left and the theme toggle on the
          right.  Empty space stays draggable (WebkitAppRegion: 'drag') so
          the user can still move the frameless window by grabbing the bar.
      */}
      <header
        className="flex items-center h-9 px-3 gap-3 flex-shrink-0 bg-titlebar border-b border-line-subtle"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' }}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--fg-primary)' }}>
            GripLite
          </span>
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
            — Lightweight Database IDE
          </span>
        </div>

        {/* Menu bar (Help → About, extensible) */}
        <div className="h-full ml-1">
          <MenuBar onAbout={() => setAboutOpen(true)} onDocs={() => setDocsOpen(true)} />
        </div>

        {/* Draggable filler — lets the user move the window */}
        <div className="flex-1 h-full" />

        {anyRunning && (
          <span
            className="text-[11px] animate-pulse"
            style={{ color: 'var(--accent)', WebkitAppRegion: 'no-drag' }}
          >
            Running…
          </span>
        )}

        {/* Theme toggle (Sun / Moon / System) */}
        <ThemeToggle />
      </header>

      {/* ── Main layout ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <SplitPane direction="horizontal" initialSize={240} minSize={160} maxSize={480}>

          {/* Left: Database Explorer */}
          <ErrorBoundary label="Database Explorer">
            <DatabaseExplorer
              connections={connections}
              reloadKey={connectionsReloadKey}
              selectedConnId={activeConnId}
              onSelectConn={setActiveConnId}
              onNewConnection={handleNewConnectionOpen}
              onTableOpen={handleTableOpen}
              onDatabaseOpen={handleDatabaseOpen}
              onQueryOpen={handleQueryOpen}
              onConsoleOpen={handleNewConsole}
              onPropertiesOpen={handlePropertiesOpen}
              onConnectionsChanged={reloadConnections}
            />
          </ErrorBoundary>

          {/* Right: Tab strip + content */}
          <div className="flex flex-col h-full overflow-hidden">

            {/* ── Tab bar ──────────────────────────────────────────────── */}
            <TabBar
              tabs={tabs}
              activeTabId={activeTabId}
              consolesData={consolesData}
              onSwitch={setActiveTabId}
              onClose={handleTabClose}
              onNewConsole={handleNewConsole}
            />

            {/* ── Tab content area ─────────────────────────────────────── */}
            <div className="flex-1 overflow-hidden relative">

              {/* Welcome pane — shown when no tabs are open (Phase 13). */}
              {tabs.length === 0 && (
                <WelcomePane
                  hasConnections={connections.length > 0}
                  onNewConsole={handleNewConsole}
                  onNewConnection={handleNewConnectionOpen}
                />
              )}

              {/* SQL Console tabs — ALL kept mounted, CSS-switched */}
              {tabs.filter((t) => t.type === 'console').map((tab) => {
                // Defensive normalisation — any pre-existing console data
                // that was seeded with the legacy shape ({queryResult,
                // isRunning}) still has `resultSets === undefined`, which
                // would crash .find() below and take the whole App down
                // ("white screen").  Coerce every field to a sane default
                // before touching it.
                const raw  = consolesData[tab.id] ?? {}
                const data = {
                  resultSets:     Array.isArray(raw.resultSets) ? raw.resultSets : [],
                  activeResultId: raw.activeResultId ?? null,
                  isRunning:      !!raw.isRunning,
                }
                // Pick the active result — falling back to the last one so a
                // freshly-finished batch surfaces without an extra click.
                const activeResult = data.resultSets.find((r) => r.id === data.activeResultId)
                  ?? data.resultSets[data.resultSets.length - 1]
                  ?? null
                return (
                  <div
                    key={tab.id}
                    className="absolute inset-0"
                    style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                  >
                    <ErrorBoundary label={`SQL Console · ${tab.label ?? tab.id}`}>
                      <SplitPane direction="vertical" initialSize={340} minSize={120} maxSize={600}>
                        <SqlEditor
                          onRunQuery={(sql, meta) => handleRunQuery(sql, tab.id, meta)}
                          isRunning={data.isRunning}
                          connectionId={connIdRef.current}
                          initialSql={tab.initialSql}
                          defaultDb={tab.defaultDb ?? connInfo?.database ?? ''}
                          connectionLabel={connInfo
                            ? (connInfo.name || `${connInfo.host}:${connInfo.port}`)
                            : ''}
                        />
                        <ResultPanel
                          queryResult={activeResult?.queryResult ?? null}
                          isRunning={data.isRunning}
                          resultSets={data.resultSets}
                          activeResultId={activeResult?.id ?? null}
                          onSelectResult={(rid) => handleSelectResult(tab.id, rid)}
                          onLoadMore={activeResult
                            ? () => handleLoadMore(tab.id, activeResult.id)
                            : undefined}
                          loadingMore={!!data.loadingMore}
                        />
                      </SplitPane>
                    </ErrorBoundary>
                  </div>
                )
              })}

              {/* Table viewer tabs — ALL kept mounted, CSS-switched */}
              {tabs.filter((t) => t.type === 'table').map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                >
                  <ErrorBoundary label={`Table · ${tab.dbName}.${tab.tableName}`}>
                    <TableViewer
                      tableName={tab.tableName}
                      dbName={tab.dbName}
                      connId={tab.connId}
                      defaultView={tab.defaultView}
                    />
                  </ErrorBoundary>
                </div>
              ))}

              {/* Read-only query tabs (Phase 22 — Explorer system info) */}
              {tabs.filter((t) => t.type === 'query').map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                >
                  <ErrorBoundary label={`Query · ${tab.label ?? tab.id}`}>
                    <QueryTabView
                      sql={tab.sql}
                      connId={tab.connId}
                      label={tab.label}
                    />
                  </ErrorBoundary>
                </div>
              ))}

              {/* Database viewer tabs — ALL kept mounted, CSS-switched */}
              {tabs.filter((t) => t.type === 'dbviewer').map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                >
                  <ErrorBoundary label={`Database · ${tab.dbName}`}>
                    <DatabaseViewer
                      dbName={tab.dbName}
                      connId={tab.connId}
                      onTableOpen={handleTableOpen}
                    />
                  </ErrorBoundary>
                </div>
              ))}

            </div>
          </div>
        </SplitPane>
      </div>

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <footer
        className="flex items-center h-6 px-3 gap-4 flex-shrink-0"
        style={{ background: 'var(--bg-statusbar)', color: 'var(--fg-on-accent)' }}
      >
        <span className="text-[11px] font-medium">
          {!connInfo
            ? '○ No connection'
            : connInfo.connected === false
              ? '✗ Disconnected'
              : '✓ Connected'}
        </span>
        <span className="text-[11px] opacity-80">{connLabel}</span>
        {connVersion && <span className="text-[11px] opacity-60">{connVersion}</span>}
        {activeTab?.type === 'table' && (
          <span className="text-[11px] opacity-80 ml-2">
            📋 {activeTab.dbName}.{activeTab.tableName}
          </span>
        )}
        {activeTab?.type === 'dbviewer' && (
          <span className="text-[11px] opacity-80 ml-2">
            🗄 {activeTab.dbName} — overview
          </span>
        )}
        <button
          onClick={() => setAboutOpen(true)}
          title="About GripLite"
          className="ml-auto text-[11px] opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
        >
          GripLite {appVersion}
        </button>
      </footer>

      {/* ── Connection properties dialog ────────────────────────────── */}
      <ConnectionDialog
        isOpen={connDialogOpen}
        initialId={connDialogInitId}
        onClose={() => setConnDialogOpen(false)}
        onSaved={handleDialogSaved}
      />

      {/* ── About modal (Phase 18) ──────────────────────────────────── */}
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* ── Keyboard Shortcuts modal ─────────────────────────────────── */}
      <KeyboardShortcutsModal isOpen={docsOpen} onClose={() => setDocsOpen(false)} />

      {/* ── Global toast stack (Phase 21) ────────────────────────────
          Mounted once at the root so any component can dispatch via
          `import { toast } from '../lib/toast'` without threading a
          context.  Portal-renders into <body>. */}
      <Toaster />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WelcomePane — shown when no tabs are open (Phase 13)
// ─────────────────────────────────────────────────────────────────────────────
function WelcomePane({ hasConnections, onNewConsole, onNewConnection }) {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center select-none"
      style={{ color: 'var(--fg-muted)' }}
    >
      <div className="max-w-md px-8 text-center">
        <div className="text-[72px] leading-none mb-4 opacity-50">⚡</div>
        <div className="text-[20px] font-semibold mb-1" style={{ color: 'var(--fg-primary)' }}>
          GripLite
        </div>
        <div className="text-[12px] mb-6" style={{ color: 'var(--fg-muted)' }}>
          Lightweight database IDE — Wails + React
        </div>

        <div className="flex flex-col gap-2 text-[12px]">
          {!hasConnections && (
            <button
              onClick={onNewConnection}
              className="py-2 px-4 rounded transition-colors font-medium text-white"
              style={{ background: 'var(--accent)' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--accent-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--accent)')}
            >
              + Add your first connection
            </button>
          )}

          <div className="flex items-center gap-2 text-[11px] my-1" style={{ color: 'var(--fg-muted)' }}>
            <div className="flex-1 h-px" style={{ background: 'var(--border-strong)' }} />
            <span>or</span>
            <div className="flex-1 h-px" style={{ background: 'var(--border-strong)' }} />
          </div>

          <button
            onClick={onNewConsole}
            className="py-2 px-4 rounded border transition-colors"
            style={{
              background: 'var(--bg-elev-2)',
              color: 'var(--fg-secondary)',
              borderColor: 'var(--border-strong)',
            }}
          >
            + New SQL Console
          </button>
        </div>

        <div className="mt-8 text-[11px] space-y-1" style={{ color: 'var(--fg-muted)' }}>
          <div>
            <kbd
              className="px-1.5 py-0.5 rounded text-[10px] font-mono border"
              style={{ background: 'var(--bg-elev-2)', borderColor: 'var(--border-strong)' }}
            >
              ⌘ + Enter
            </kbd>
            <span className="ml-2">Run selected SQL</span>
          </div>
          <div>
            <span className="opacity-70">Double-click a table</span>
            <span className="ml-2">Open data view</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TabBar
// ─────────────────────────────────────────────────────────────────────────────
function TabBar({ tabs, activeTabId, consolesData, onSwitch, onClose, onNewConsole }) {
  return (
    <div className="flex items-stretch bg-titlebar border-b border-line-subtle flex-shrink-0 overflow-x-auto min-h-[36px]">
      {tabs.map((tab) => {
        const active     = tab.id === activeTabId
        const isTable    = tab.type === 'table'
        const isDbViewer = tab.type === 'dbviewer'
        const isConsole  = tab.type === 'console'
        const data       = consolesData[tab.id]
        const running    = isConsole && data?.isRunning

        const tabIcon = isTable    ? '📋'
                      : isDbViewer ? '🗄'
                      : '⚡'

        return (
          <div
            key={tab.id}
            onClick={() => onSwitch(tab.id)}
            title={tab.label}
            className={[
              'flex items-center gap-1.5 px-3 py-0 text-[13px] cursor-pointer select-none',
              'border-r border-line-subtle flex-shrink-0 min-w-[100px] max-w-[240px]',
              'transition-colors group relative',
              active
                ? 'bg-panel text-fg-primary border-t-2 border-t-accent'
                : 'text-fg-muted hover:text-fg-secondary hover:bg-hover',
            ].join(' ')}
          >
            {/* Tab icon */}
            <span className="text-[10px] flex-shrink-0 opacity-70">{tabIcon}</span>

            {/* Label */}
            <span className="truncate flex-1 text-[12px]">{tab.label}</span>

            {/* Running pulse (SQL consoles only) */}
            {running && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
            )}

            {/* Close button — all non-console tabs, plus extra consoles */}
            {(isTable || isDbViewer || tabs.filter((t) => t.type === 'console').length > 1) && (
              <button
                onClick={(e) => onClose(e, tab.id)}
                className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded
                           text-fg-faint hover:text-fg-secondary hover:bg-line transition-colors
                           opacity-0 group-hover:opacity-100"
                title="Close tab"
              >
                ×
              </button>
            )}
          </div>
        )
      })}

      {/* New console button */}
      <button
        onClick={onNewConsole}
        title="Open new SQL console"
        className="flex items-center justify-center w-8 px-0 text-[16px] text-fg-faint
                   hover:text-fg-secondary hover:bg-hover transition-colors flex-shrink-0
                   border-r border-line-subtle select-none"
      >
        +
      </button>

      {/* Spacer */}
      <div className="flex-1" />
    </div>
  )
}
