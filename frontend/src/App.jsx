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
 * Recently used tab contents stay mounted and are CSS-switched; older inactive
 * tabs are unmounted to keep Monaco/DataGrid memory bounded.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import SplitPane          from './components/SplitPane'
import DatabaseExplorer   from './components/DatabaseExplorer'
import SqlEditor          from './components/SqlEditor'
import ResultPanel        from './components/ResultPanel'
import TableViewer        from './components/TableViewer'
import DatabaseViewer     from './components/DatabaseViewer'
import QueryTabView       from './components/QueryTabView'
import RedisKeyViewer     from './components/RedisKeyViewer'
import RedisServerView    from './components/RedisServerView'
import ConnectionDialog   from './components/ConnectionDialog'
import CopyDataModal      from './components/CopyDataModal'
import MenuBar            from './components/MenuBar'
import SavedConsolesMenu  from './components/SavedConsolesMenu'
import SaveConsoleModal   from './components/SaveConsoleModal'
import AboutModal              from './components/AboutModal'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'
import SettingsModal          from './components/SettingsModal'
import ErrorBoundary      from './components/ErrorBoundary'
import { loadTableUsageTopN } from './lib/settings'
import { readConsoleEditorContent, findOpenConsoleForSaved } from './lib/savedConsoles'
import { Database, Leaf, Zap } from 'lucide-react'
import { Key, Server } from 'lucide-react'
import { Toaster, toast } from './lib/toast'
import { normalizeError } from './lib/errors'
import { runQuery, runQueryPage, cancelQuery, listConnections, getBuildInfo, getPlatform, onMenuAction, listSavedConsoles, saveConsole, deleteSavedConsole } from './lib/bridge'
import { appendResultPage, DEFAULT_PAGE_SIZE, loadPreferredPageSize, savePreferredPageSize } from './lib/queryPaging'
import { stripLeadingSqlComments } from './lib/sqlText'
import {
  closeAllTabsInWorkspace,
  closeTabInWorkspace,
  getNextConsoleSeqFromTabs,
  loadWorkspaceState,
  makeWorkspaceSnapshot,
  saveWorkspaceState,
} from './lib/workspaceState'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CONN_ID = 'mock-conn'
const DEFAULT_RESULT_PAGE_SIZE = DEFAULT_PAGE_SIZE
const MAX_MOUNTED_TABS = 8
let   nextConsoleSeq  = 1

function isPageableSql(sql) {
  const trimmed = String(sql ?? '').trim().replace(/;+$/g, '').trim()
  if (!trimmed || trimmed.includes(';')) return false
  const executable = stripLeadingSqlComments(trimmed)
  return /^(select|with)\b/i.test(executable)
}

// MongoDB console queries are JavaScript shell expressions.  Only `find`
// queries can be scroll-paged (the backend windows them with skip/limit);
// aggregate / write / admin ops are single-shot.
function isPageableMongo(sql) {
  const trimmed = String(sql ?? '').trim().replace(/;+$/g, '').trim()
  if (!trimmed) return false
  return /\.find\s*\(/.test(trimmed)
}

function makeConsoleTab() {
  const seq = nextConsoleSeq++
  return {
    id:    `console-${seq}`,
    type:  'console',
    label: seq === 1 ? 'SQL Console' : `SQL Console ${seq}`,
  }
}

function connectionDisplayName(conn, fallbackId = '') {
  if (!conn) return fallbackId || ''
  return conn.name || conn.host || conn.id || fallbackId || ''
}

function buildTableTabLabel(connectionName, dbName, tableName) {
  return [connectionName, dbName, tableName].filter(Boolean).join(' / ')
}

function defaultDatabaseForNewConsole(tab, fallbackDb = '') {
  if (tab?.type === 'table' || tab?.type === 'dbviewer') return tab.dbName ?? fallbackDb
  return fallbackDb
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const initialWorkspaceRef = useRef(null)
  if (initialWorkspaceRef.current === null) {
    const restored = loadWorkspaceState()
    if (restored?.tabs?.length) {
      nextConsoleSeq = Math.max(nextConsoleSeq, getNextConsoleSeqFromTabs(restored.tabs))
    }
    initialWorkspaceRef.current = restored
  }

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
  const [activeConnId,         setActiveConnId]         = useState(
    () => initialWorkspaceRef.current?.activeConnId || DEFAULT_CONN_ID,
  )
  const [connectionsReloadKey, setConnectionsReloadKey] = useState(0)
  const connIdRef = useRef(initialWorkspaceRef.current?.activeConnId || DEFAULT_CONN_ID)
  // Remembered result fetch size — seeded from localStorage and updated
  // whenever the user changes the page size in the result footer.
  const preferredPageSizeRef = useRef(loadPreferredPageSize(DEFAULT_RESULT_PAGE_SIZE))

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
  const connectionKindById = useMemo(
    () => new Map(connections.map((conn) => [conn.id, conn.kind ?? 'mysql'])),
    [connections],
  )
  const connectionNameById = useMemo(
    () => new Map(connections.map((conn) => [conn.id, connectionDisplayName(conn)])),
    [connections],
  )

  // ── Tab state ─────────────────────────────────────────────────────────────
  // Phase 13 / Task 1: No demo tab on cold start.  The workspace opens on the
  // WelcomePane (see below) until the user explicitly opens a console, table,
  // or database tab.
  const [tabs,        setTabs]        = useState(() => initialWorkspaceRef.current?.tabs ?? [])
  const [activeTabId, setActiveTabId] = useState(() => initialWorkspaceRef.current?.activeTabId ?? '')
  const activeTabIdRef = useRef(activeTabId)
  const [mountedTabIds, setMountedTabIds] = useState(() => {
    const ids = (initialWorkspaceRef.current?.tabs ?? []).map((tab) => tab.id)
    const active = initialWorkspaceRef.current?.activeTabId ?? ''
    const ordered = active ? [...ids.filter((id) => id !== active), active] : ids
    return ordered.slice(-MAX_MOUNTED_TABS)
  })

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
  const [consolesData, setConsolesData] = useState(() => {
    const restored = initialWorkspaceRef.current?.tabs ?? []
    const out = {}
    for (const tab of restored) {
      if (tab.type === 'console') {
        out[tab.id] = { resultSets: [], activeResultId: null, isRunning: false }
      }
    }
    return out
  })

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Always-fresh mirror of `tabs` for callbacks that must dedup against the
  // latest tab list synchronously (e.g. opening a saved console), without
  // waiting for a closure to be recreated.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])

  useEffect(() => {
    setMountedTabIds((prev) => {
      const open = new Set(tabs.map((tab) => tab.id))
      const next = prev.filter((id) => open.has(id) && id !== activeTabId)
      if (activeTabId && open.has(activeTabId)) next.push(activeTabId)
      const bounded = next.slice(-MAX_MOUNTED_TABS)
      if (bounded.length === prev.length && bounded.every((id, idx) => id === prev[idx])) return prev
      return bounded
    })
  }, [activeTabId, tabs])

  const shouldMountTab = useCallback((tabId) => (
    tabId === activeTabId || mountedTabIds.includes(tabId)
  ), [activeTabId, mountedTabIds])

  useEffect(() => {
    saveWorkspaceState(undefined, makeWorkspaceSnapshot({ tabs, activeTabId, activeConnId }))
  }, [tabs, activeTabId, activeConnId])

  useEffect(() => {
    if (connections.length === 0) return
    setTabs((prev) => prev.map((tab) => {
      if (tab.type !== 'table') return tab
      const tableConnectionName = connectionNameById.get(tab.connId) ?? tab.connectionName ?? ''
      const tableConnectionKind = connectionKindById.get(tab.connId) ?? tab.connectionKind ?? 'mysql'
      const label = buildTableTabLabel(tableConnectionName, tab.dbName, tab.tableName)
      if (tab.connectionName === tableConnectionName && tab.connectionKind === tableConnectionKind && tab.label === label) return tab
      return { ...tab, connectionName: tableConnectionName, connectionKind: tableConnectionKind, label }
    }))
  }, [connectionKindById, connectionNameById, connections.length])

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
    const consoleTab = tabs.find((tab) => tab.id === tabId)
    const queryConnId = consoleTab?.connId ?? connIdRef.current

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
      const isMongoConsole = consoleTab?.connectionKind === 'mongodb'
      const pageable = !opts.multi && (isMongoConsole ? isPageableMongo(sql) : isPageableSql(sql))
      try {
        if (pageable) {
          const pageSize = preferredPageSizeRef.current
          const page = await runQueryPage(queryConnId, opts.dbName ?? '', sql, 0, preferredPageSizeRef.current, tabId)
          queryResult = appendResultPage(null, page, {
            offset: 0,
            pageSize,
            source: { sql, dbName: opts.dbName ?? '', connId: queryConnId, pageSize },
          })
        } else {
          queryResult = await runQuery(queryConnId, opts.dbName ?? '', sql, tabId)
        }
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
      const entry = {
        id: rid,
        label: labelForSql(sql),
        sql,
        queryResult: { ...queryResult, dbName: opts.dbName ?? '' },
      }

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
  }, [activeTabId, tabs])

  const handleSelectResult = useCallback((consoleId, resultId) => {
    setConsolesData((prev) => {
      const d = prev[consoleId]
      if (!d) return prev
      return { ...prev, [consoleId]: { ...d, activeResultId: resultId } }
    })
  }, [])

  const handleLoadNextResultPage = useCallback(async (consoleId, resultId) => {
    let target = null
    setConsolesData((prev) => {
      const d = prev[consoleId]
      const entry = d?.resultSets?.find((r) => r.id === resultId)
      const qr = entry?.queryResult
      if (!d || !entry || !qr?.hasMore || qr.loadingMore || !qr.source) return prev
      target = { entry, queryResult: qr }
      return {
        ...prev,
        [consoleId]: {
          ...d,
          resultSets: d.resultSets.map((r) => r.id === resultId
            ? { ...r, queryResult: { ...qr, loadingMore: true } }
            : r),
        },
      }
    })
    if (!target) return

    const qr = target.queryResult
    const source = qr.source
    const offset = qr.nextOffset ?? qr.rows?.length ?? 0
    try {
      const page = await runQueryPage(source.connId ?? connIdRef.current, source.dbName ?? '', source.sql, offset, source.pageSize ?? DEFAULT_RESULT_PAGE_SIZE, `${consoleId}:${resultId}:page`)
      setConsolesData((prev) => {
        const d = prev[consoleId]
        if (!d) return prev
        return {
          ...prev,
          [consoleId]: {
            ...d,
            resultSets: d.resultSets.map((r) => {
              if (r.id !== resultId) return r
              return {
                ...r,
                queryResult: appendResultPage(r.queryResult, page, {
                  offset,
                  pageSize: source.pageSize ?? DEFAULT_RESULT_PAGE_SIZE,
                  source,
                }),
              }
            }),
          },
        }
      })
    } catch (err) {
      const msg = normalizeError(err)
      toast.error(`Load next page failed: ${msg}`)
      setConsolesData((prev) => {
        const d = prev[consoleId]
        if (!d) return prev
        return {
          ...prev,
          [consoleId]: {
            ...d,
            resultSets: d.resultSets.map((r) => r.id === resultId
              ? { ...r, queryResult: { ...r.queryResult, loadingMore: false, error: msg } }
              : r),
          },
        }
      })
    }
  }, [])

  const handleResultPageSizeChange = useCallback(async (consoleId, resultId, pageSize) => {
    let target = null
    setConsolesData((prev) => {
      const d = prev[consoleId]
      const entry = d?.resultSets?.find((r) => r.id === resultId)
      const qr = entry?.queryResult
      if (!d || !entry || !qr?.source || qr.loadingMore) return prev
      target = { queryResult: qr }
      return {
        ...prev,
        [consoleId]: {
          ...d,
          resultSets: d.resultSets.map((r) => r.id === resultId
            ? { ...r, queryResult: { ...qr, loadingMore: true } }
            : r),
        },
      }
    })
    if (!target) return

    // Remember the chosen fetch size for subsequent queries / sessions.
    preferredPageSizeRef.current = savePreferredPageSize(pageSize)

    const source = target.queryResult.source
    const nextSource = { ...source, pageSize }
    try {
      const page = await runQueryPage(source.connId ?? connIdRef.current, source.dbName ?? '', source.sql, 0, pageSize, `${consoleId}:${resultId}:page-size`)
      setConsolesData((prev) => {
        const d = prev[consoleId]
        if (!d) return prev
        return {
          ...prev,
          [consoleId]: {
            ...d,
            resultSets: d.resultSets.map((r) => {
              if (r.id !== resultId) return r
              const queryResult = appendResultPage(null, page, {
                offset: 0,
                pageSize,
                source: nextSource,
              })
              return {
                ...r,
                queryResult: { ...queryResult, dbName: source.dbName ?? '' },
              }
            }),
          },
        }
      })
    } catch (err) {
      const msg = normalizeError(err)
      toast.error(`Reload page failed: ${msg}`)
      setConsolesData((prev) => {
        const d = prev[consoleId]
        if (!d) return prev
        return {
          ...prev,
          [consoleId]: {
            ...d,
            resultSets: d.resultSets.map((r) => r.id === resultId
              ? { ...r, queryResult: { ...r.queryResult, loadingMore: false, error: msg } }
              : r),
          },
        }
      })
    }
  }, [])

  // ── Table open ────────────────────────────────────────────────────────────
  /**
   * handleTableOpen — opens or activates a TableViewer tab.
   *
   * @param {{ tableName, dbName, connId, defaultView? }} opts
   *   defaultView: 'properties' | 'data'  (only applied on first open;
   *   after that the tab owns its own internal state).
   */
  const handleTableOpen = useCallback(({ tableName, dbName, connId, defaultView, objectKind }) => {
    const effectiveConnId = connId ?? connIdRef.current
    const connectionKind = connectionKindById.get(effectiveConnId) ?? 'mysql'
    const tableConnectionName = connectionNameById.get(effectiveConnId) ?? effectiveConnId
    const tabId = `table:${effectiveConnId}:${dbName}:${tableName}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev   // already open → just switch
      return [...prev, {
        id: tabId, type: 'table', label: buildTableTabLabel(tableConnectionName, dbName, tableName),
        tableName, dbName,
        connId:         effectiveConnId,
        connectionKind,
        connectionName: tableConnectionName,
        defaultView:    defaultView ?? 'properties',
        objectKind:     objectKind ?? (connectionKind === 'mongodb' ? 'collection' : 'table'),
      }]
    })
    setActiveTabId(tabId)
  }, [connectionKindById, connectionNameById])

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
    const connectionKind = connectionKindById.get(effectiveConnId) ?? 'mysql'
    const tabId = `query:${effectiveConnId}:${key}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev
      return [...prev, {
        id: tabId, type: 'query', label,
        sql, connId: effectiveConnId, connectionKind,
      }]
    })
    setActiveTabId(tabId)
  }, [connectionKindById])

  // ── Redis key open ────────────────────────────────────────────────────────
  /**
   * handleRedisKeyOpen — open (or activate) a RedisKeyViewer tab for a single
   * key.  De-duplicates per (connId, db, key); readOnly is inherited from the
   * connection's readOnly flag.
   */
  const handleRedisKeyOpen = useCallback((connId, dbIndex, key) => {
    const effectiveConnId = connId ?? connIdRef.current
    const connectionKind = connectionKindById.get(effectiveConnId) ?? 'redis'
    const conn = connections.find((c) => c.id === effectiveConnId)
    const tabId = `rediskey::${effectiveConnId}::${dbIndex}::${key}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev
      return [...prev, {
        id: tabId, type: 'rediskey', label: key,
        connId: effectiveConnId, connectionKind,
        dbIndex, redisKey: key, readOnly: !!conn?.readOnly,
      }]
    })
    setActiveTabId(tabId)
  }, [connectionKindById, connections])

  // ── Redis server view open ────────────────────────────────────────────────
  const handleRedisServerOpen = useCallback((connId) => {
    const effectiveConnId = connId ?? connIdRef.current
    const connectionKind = connectionKindById.get(effectiveConnId) ?? 'redis'
    const conn = connections.find((c) => c.id === effectiveConnId)
    const name = conn?.name || conn?.host || effectiveConnId
    const tabId = `redisserver::${effectiveConnId}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev
      return [...prev, {
        id: tabId, type: 'redisserver', label: `${name} — Server`,
        connId: effectiveConnId, connectionKind,
      }]
    })
    setActiveTabId(tabId)
  }, [connectionKindById, connections])

  // ── Database viewer open ──────────────────────────────────────────────────
  const handleDatabaseOpen = useCallback(({ dbName, connId }) => {
    const effectiveConnId = connId ?? connIdRef.current
    const connectionKind = connectionKindById.get(effectiveConnId) ?? 'mysql'
    const tabId = `db:${effectiveConnId}:${dbName}`
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev   // already open → activate
      return [...prev, {
        id: tabId, type: 'dbviewer',
        label: `${dbName} — Tables`,
        dbName,
        connId: effectiveConnId,
        connectionKind,
      }]
    })
    setActiveTabId(tabId)
  }, [connectionKindById])

  const [copyModalSource, setCopyModalSource] = useState(null)

  const handleDatabaseCopyOpen = useCallback(({ dbName, connId }) => {
    setCopyModalSource({ dbName, connId: connId ?? connIdRef.current })
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
    if (opts?.savedConsoleId)   tab.savedConsoleId   = opts.savedConsoleId
    if (opts?.savedConsoleName) tab.savedConsoleName = opts.savedConsoleName
    const effectiveConnId = opts?.connId ?? activeTab?.connId ?? connIdRef.current
    const defaultDb = opts?.defaultDb ?? defaultDatabaseForNewConsole(activeTab, connInfo?.database ?? '')
    tab.defaultDb = defaultDb
    tab.connId = effectiveConnId
    tab.connectionKind = opts?.connectionKind ?? connectionKindById.get(effectiveConnId) ?? 'mysql'
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
  }, [activeTab, connectionKindById, connInfo?.database])

  // Open the console for a given connection+database, reusing an already-open
  // console if one matches; otherwise spawn a fresh one (seeded with initialSql).
  const handleOpenOrFocusConsole = useCallback((opts) => {
    const targetConnId = opts?.connId ?? activeTab?.connId ?? connIdRef.current
    const targetDb = opts?.defaultDb ?? ''
    const existing = tabs.find(
      (t) => t.type === 'console'
        && (t.connId ?? connIdRef.current) === targetConnId
        && (t.defaultDb ?? '') === targetDb,
    )
    if (existing) {
      setActiveTabId(existing.id)
      return
    }
    handleNewConsole(opts)
  }, [tabs, activeTab, handleNewConsole])

  // Rebind a console tab to a different connection (DataGrip-style). Resets the
  // default database to the new connection's default; SqlEditor re-fetches its
  // database list off the changed connectionId prop.
  const handleConsoleConnectionChange = useCallback((tabId, newConnId) => {
    if (!newConnId) return
    const target = connections.find((c) => c.id === newConnId)
    setTabs((prev) => prev.map((t) => (
      t.id === tabId
        ? {
            ...t,
            connId: newConnId,
            connectionKind: connectionKindById.get(newConnId) ?? target?.kind ?? 'mysql',
            defaultDb: target?.database ?? '',
          }
        : t
    )))
  }, [connections, connectionKindById])

  // ── Saved consoles (DBeaver-style named SQL scripts) ───────────────────────
  const [savedConsoles, setSavedConsoles] = useState([])
  // Save dialog state: { tabId, initialName, busy, error } or null.
  const [saveConsoleState, setSaveConsoleState] = useState(null)

  const reloadSavedConsoles = useCallback(async () => {
    try {
      setSavedConsoles((await listSavedConsoles()) ?? [])
    } catch (e) {
      console.warn('[consoles] list failed:', e)
    }
  }, [])

  useEffect(() => { reloadSavedConsoles() }, [reloadSavedConsoles])

  // Open the name dialog for the active console tab. The actual SQL is captured
  // at save time from the editor's persisted state (performSaveConsole).
  const handleSaveCurrentConsole = useCallback(() => {
    if (activeTab?.type !== 'console') {
      // Reachable from the always-enabled native macOS menu item.
      toast.error('Open a console first, then save it.')
      return
    }
    setSaveConsoleState({
      tabId: activeTab.id,
      initialName: activeTab.savedConsoleName ?? activeTab.label ?? '',
      busy: false,
      error: '',
    })
  }, [activeTab])

  const performSaveConsole = useCallback(async (name) => {
    const target = saveConsoleState
    if (!target?.tabId) return
    const tab = tabs.find((t) => t.id === target.tabId)
    if (!tab) { setSaveConsoleState(null); return }
    const { sql, selectedDb } = readConsoleEditorContent(tab.id)
    setSaveConsoleState((s) => (s ? { ...s, busy: true, error: '' } : s))
    try {
      const saved = await saveConsole({
        id: tab.savedConsoleId ?? '',
        name,
        sql,
        connId: tab.connId ?? '',
        dbName: selectedDb || tab.defaultDb || '',
        connectionKind: tab.connectionKind ?? 'mysql',
      })
      // Bind the tab to the saved console so re-saving updates in place, and
      // surface the saved name as the tab label.
      setTabs((prev) => prev.map((t) => (
        t.id === tab.id
          ? { ...t, savedConsoleId: saved.id, savedConsoleName: saved.name, label: saved.name }
          : t
      )))
      setSaveConsoleState(null)
      toast.success(`Saved console “${saved.name}”`)
      reloadSavedConsoles()
    } catch (e) {
      setSaveConsoleState((s) => (s ? { ...s, busy: false, error: normalizeError(e) } : s))
    }
  }, [saveConsoleState, tabs, reloadSavedConsoles])

  // Open a saved console — focus an already-open tab bound to it, else spawn one.
  // Dedup reads tabsRef (always current) so repeated clicks on the same saved
  // console never spawn more than one tab.
  const handleOpenSavedConsole = useCallback((saved) => {
    if (!saved?.id) return
    const existing = findOpenConsoleForSaved(tabsRef.current, saved.id)
    if (existing) { setActiveTabId(existing.id); return }
    handleNewConsole({
      initialSql: saved.sql ?? '',
      label: saved.name,
      connId: saved.connId || undefined,
      defaultDb: saved.dbName ?? '',
      connectionKind: saved.connectionKind || undefined,
      savedConsoleId: saved.id,
      savedConsoleName: saved.name,
    })
  }, [handleNewConsole])

  const handleDeleteSavedConsole = useCallback(async (saved) => {
    if (!saved?.id) return
    try {
      await deleteSavedConsole(saved.id)
      // Unbind any open tab that pointed at this saved console.
      setTabs((prev) => prev.map((t) => (
        t.savedConsoleId === saved.id
          ? { ...t, savedConsoleId: undefined, savedConsoleName: undefined }
          : t
      )))
      reloadSavedConsoles()
    } catch (e) {
      toast.error(`Delete failed: ${normalizeError(e)}`)
    }
  }, [reloadSavedConsoles])

  // Rename a console from its tab's right-click menu. Opens the name dialog for
  // that specific tab; saving upserts in place when it's already a saved console
  // (so it renames), or saves it for the first time otherwise.
  const handleRenameConsole = useCallback((tabId) => {
    const tab = tabsRef.current.find((t) => t.id === tabId)
    if (!tab || tab.type !== 'console') return
    setSaveConsoleState({
      tabId: tab.id,
      initialName: tab.savedConsoleName ?? tab.label ?? '',
      busy: false,
      error: '',
    })
  }, [])

  // Open a saved console by id (used by the native macOS Consoles menu).
  const openSavedConsoleById = useCallback((id) => {
    const saved = savedConsoles.find((c) => c.id === id)
    if (saved) handleOpenSavedConsole(saved)
  }, [savedConsoles, handleOpenSavedConsole])

  // The native-menu subscription effect runs once with [] deps, so route the
  // (state-dependent) console actions through a ref kept fresh each render.
  const consoleMenuActionsRef = useRef({ save: () => {}, openById: () => {} })
  useEffect(() => {
    consoleMenuActionsRef.current = { save: handleSaveCurrentConsole, openById: openSavedConsoleById }
  }, [handleSaveCurrentConsole, openSavedConsoleById])

  // ── Tab close ─────────────────────────────────────────────────────────────
  //
  // Phase 13 / Task 1: closing the last tab now leaves tabs=[] and returns the
  // user to the WelcomePane instead of spawning a replacement console.
  const removePersistedTabState = useCallback((tabId) => {
    try {
      localStorage.removeItem(`griplite_sql_editor_${tabId}_v1`)
    } catch { /* ignore */ }
  }, [])

  const handleCloseTabById = useCallback((tabId) => {
    removePersistedTabState(tabId)
    setTabs((prev) => {
      const next = closeTabInWorkspace(prev, activeTabIdRef.current, tabId)
      activeTabIdRef.current = next.activeTabId
      setActiveTabId(next.activeTabId)
      return next.tabs
    })
    setConsolesData((prev) => {
      const { [tabId]: _dropped, ...rest } = prev
      return rest
    })
  }, [removePersistedTabState])

  const handleTabClose = useCallback((e, tabId) => {
    e?.stopPropagation()
    handleCloseTabById(tabId)
  }, [handleCloseTabById])

  const handleCloseAllTabs = useCallback(() => {
    setTabs((prev) => {
      for (const tab of prev) removePersistedTabState(tab.id)
      const next = closeAllTabsInWorkspace()
      activeTabIdRef.current = next.activeTabId
      setActiveTabId(next.activeTabId)
      return next.tabs
    })
    setConsolesData({})
  }, [removePersistedTabState])

  // ── Connection dialog state ────────────────────────────────────────────────
  const [connDialogOpen,  setConnDialogOpen]  = useState(false)
  const [connDialogInitId, setConnDialogInitId] = useState(null)

  // ── Phase 18: About modal ──────────────────────────────────────────────────
  const [aboutOpen,    setAboutOpen]    = useState(false)
  const [docsOpen,     setDocsOpen]     = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // On macOS, Tools/Help live in the native top-of-screen menu bar and the
  // window's title bar is hidden, so the in-app strip insets for the traffic
  // lights and skips the MenuBar. Seed from a synchronous platform guess to
  // avoid a launch flash; the IPC check below confirms it.
  const [nativeMenu,   setNativeMenu]   = useState(
    () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || ''),
  )
  // How many frequently-used tables the Explorer pins to the top (the rest are
  // listed alphabetically). User-adjustable via Tools → Settings.
  const [tableUsageTopN, setTableUsageTopN] = useState(() => loadTableUsageTopN())
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    getBuildInfo().then((info) => setAppVersion(info?.version ?? '')).catch(() => {})
  }, [])

  // On macOS the native menu bar hosts Tools/Help; subscribe to its clicks and
  // hide the in-app MenuBar there. On Windows/Linux the in-app bar stays.
  useEffect(() => {
    // onMenuAction is async; if this effect is torn down (e.g. React StrictMode
    // double-invoke in dev) before the promise resolves, unsubscribe as soon as
    // it does — otherwise a leaked listener fires menu events twice, opening
    // duplicate console tabs.
    let off = null
    let cancelled = false
    getPlatform().then((platform) => setNativeMenu(platform === 'darwin')).catch(() => {})
    onMenuAction({
      settings:     () => setSettingsOpen(true),
      shortcuts:    () => setDocsOpen(true),
      about:        () => setAboutOpen(true),
      consoleSave:  () => consoleMenuActionsRef.current.save(),
      consoleOpen:  (id) => consoleMenuActionsRef.current.openById(id),
    }).then((unsub) => {
      if (cancelled) { try { unsub?.() } catch { /* ignore */ } } else { off = unsub }
    }).catch(() => {})
    return () => { cancelled = true; if (off) { try { off() } catch { /* ignore */ } } }
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

  const handleDialogDeleted = useCallback((connId) => {
    if (!connId) {
      reloadConnections()
      return
    }
    setConnections((prev) => {
      const next = prev.filter((conn) => conn.id !== connId)
      setActiveConnId((active) => {
        if (active !== connId) return active
        const fallback = next[0]?.id ?? DEFAULT_CONN_ID
        connIdRef.current = fallback
        return fallback
      })
      return next
    })
    reloadConnections()
  }, [reloadConnections])

  // ── Derived ───────────────────────────────────────────────────────────────
  const connLabel   = connInfo ? `${connInfo.host}:${connInfo.port} / ${connInfo.database}` : 'Not connected'
  const connVersion = connInfo?.serverVersion ?? ''

  return (
    <div
      className="flex flex-col w-full h-full overflow-hidden"
      style={{ background: 'var(--bg-app)', color: 'var(--fg-primary)' }}
    >

      {/* ── App title bar ─────────────────────────────────────────────────
          The native macOS title bar is hidden (transparent + full-size
          content), so this themed strip *is* the title bar — its colour tracks
          the Light/Dark theme via `bg-titlebar`. It also hosts the window drag
          region and the branding. On macOS we inset the left edge to clear the
          traffic-light buttons and Tools/Help live in the native menu bar; on
          Windows/Linux the in-app MenuBar hosts them here instead.
      */}
      <header
        className="flex items-center h-9 gap-3 flex-shrink-0 bg-titlebar border-b border-line-subtle"
        style={{ '--wails-draggable': 'drag', WebkitAppRegion: 'drag', paddingLeft: nativeMenu ? 78 : 12, paddingRight: 12 }}
      >
        <div className="flex items-center gap-2" style={{ '--wails-draggable': 'no-drag', WebkitAppRegion: 'no-drag' }}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--fg-primary)' }}>
            GripLite
          </span>
          <span className="text-[11px]" style={{ color: 'var(--fg-muted)' }}>
            — Lightweight Database IDE
          </span>
        </div>

        {/* Tools / Help — only when there's no global menu bar (non-macOS). */}
        {!nativeMenu && (
          <div className="h-full ml-1" style={{ '--wails-draggable': 'no-drag', WebkitAppRegion: 'no-drag' }}>
            <MenuBar onAbout={() => setAboutOpen(true)} onDocs={() => setDocsOpen(true)} onSettings={() => setSettingsOpen(true)} />
          </div>
        )}

        {/* Saved consoles. On macOS this lives in the native menu bar next to
            Tools (see menu.go); on Windows/Linux it sits here next to the
            in-app MenuBar. */}
        {!nativeMenu && (
          <div className="h-full" style={{ '--wails-draggable': 'no-drag', WebkitAppRegion: 'no-drag' }}>
            <SavedConsolesMenu
              consoles={savedConsoles}
              canSave={activeTab?.type === 'console'}
              onSaveCurrent={handleSaveCurrentConsole}
              onOpen={handleOpenSavedConsole}
              onDelete={handleDeleteSavedConsole}
            />
          </div>
        )}

        {/* Draggable filler — lets the user move the window */}
        <div className="flex-1 h-full" />
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
              onDatabaseCopyOpen={handleDatabaseCopyOpen}
              onQueryOpen={handleQueryOpen}
              onConsoleOpen={handleNewConsole}
              onPropertiesOpen={handlePropertiesOpen}
              onConnectionsChanged={reloadConnections}
              onRedisKeyOpen={handleRedisKeyOpen}
              onRedisServerOpen={handleRedisServerOpen}
              tableUsageTopN={tableUsageTopN}
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
              onCloseTab={handleCloseTabById}
              onCloseAll={handleCloseAllTabs}
              onNewConsole={handleNewConsole}
              onRenameConsole={handleRenameConsole}
              connectionKindById={connectionKindById}
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

              {/* SQL Console tabs — bounded keep-alive, CSS-switched */}
              {tabs.filter((t) => t.type === 'console' && shouldMountTab(t.id)).map((tab) => {
                const consoleConnId = tab.connId ?? connIdRef.current
                const consoleConnInfo = connections.find((conn) => conn.id === consoleConnId)
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
                          connectionId={consoleConnId}
                          queryId={tab.id}
                          initialSql={tab.initialSql}
                          defaultDb={tab.defaultDb ?? consoleConnInfo?.database ?? ''}
                          connectionLabel={consoleConnInfo
                            ? (consoleConnInfo.name || `${consoleConnInfo.host}:${consoleConnInfo.port}`)
                            : ''}
                          storageKey={`griplite_sql_editor_${tab.id}_v1`}
                          connectionKind={tab.connectionKind ?? consoleConnInfo?.kind ?? 'mysql'}
                          connections={connections}
                          onConnectionChange={(cid) => handleConsoleConnectionChange(tab.id, cid)}
                        />
                        <ResultPanel
                          queryResult={activeResult?.queryResult ?? null}
                          isRunning={data.isRunning}
                          resultSets={data.resultSets}
                          activeResultId={activeResult?.id ?? null}
                          connectionId={activeResult?.queryResult?.source?.connId ?? consoleConnId}
                          fallbackDb={tab.defaultDb ?? consoleConnInfo?.database ?? ''}
                          onSelectResult={(rid) => handleSelectResult(tab.id, rid)}
                          onLoadMore={() => activeResult?.id && handleLoadNextResultPage(tab.id, activeResult.id)}
                          onPageSizeChange={(size) => activeResult?.id && handleResultPageSizeChange(tab.id, activeResult.id, size)}
                          onCancelQuery={() => cancelQuery(tab.id)}
                        />
                      </SplitPane>
                    </ErrorBoundary>
                  </div>
                )
              })}

              {/* Table viewer tabs — bounded keep-alive, CSS-switched */}
              {tabs.filter((t) => t.type === 'table' && shouldMountTab(t.id)).map((tab) => {
                const tableConnectionKind = connectionKindById.get(tab.connId) ?? 'mysql'
                const tableObjectKind = tab.objectKind ?? (tableConnectionKind === 'mongodb' ? 'collection' : 'table')
                const tableConnectionName = tab.connectionName ?? connectionNameById.get(tab.connId) ?? ''
                return (
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
                        connectionName={tableConnectionName}
                        defaultView={tab.defaultView}
                        objectKind={tableObjectKind}
                        connectionKind={tableConnectionKind}
                        isActive={activeTabId === tab.id}
                        onOpenConsole={handleOpenOrFocusConsole}
                      />
                    </ErrorBoundary>
                  </div>
                )
              })}

              {/* Read-only query tabs (Phase 22 — Explorer system info) */}
              {tabs.filter((t) => t.type === 'query' && shouldMountTab(t.id)).map((tab) => (
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

              {/* Database viewer tabs — bounded keep-alive, CSS-switched */}
              {tabs.filter((t) => t.type === 'dbviewer' && shouldMountTab(t.id)).map((tab) => (
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

              {/* Redis key viewer tabs — bounded keep-alive, CSS-switched */}
              {tabs.filter((t) => t.type === 'rediskey' && shouldMountTab(t.id)).map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                >
                  <ErrorBoundary label={`Redis Key · ${tab.redisKey}`}>
                    <RedisKeyViewer
                      connId={tab.connId}
                      dbIndex={tab.dbIndex}
                      redisKey={tab.redisKey}
                      connectionKind={tab.connectionKind}
                      readOnly={tab.readOnly}
                    />
                  </ErrorBoundary>
                </div>
              ))}

              {/* Redis server view tabs — bounded keep-alive, CSS-switched */}
              {tabs.filter((t) => t.type === 'redisserver' && shouldMountTab(t.id)).map((tab) => (
                <div
                  key={tab.id}
                  className="absolute inset-0"
                  style={{ display: activeTabId === tab.id ? 'flex' : 'none', flexDirection: 'column' }}
                >
                  <ErrorBoundary label={`Redis Server · ${tab.connId}`}>
                    <RedisServerView connId={tab.connId} />
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
            📋 {activeTab.connectionName ? `${activeTab.connectionName} / ` : ''}{activeTab.dbName}.{activeTab.tableName}
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
        connections={connections}
        onClose={() => setConnDialogOpen(false)}
        onSaved={handleDialogSaved}
        onDeleted={handleDialogDeleted}
      />

      <CopyDataModal
        isOpen={!!copyModalSource}
        source={copyModalSource}
        connections={connections}
        onClose={() => setCopyModalSource(null)}
      />

      {/* ── About modal (Phase 18) ──────────────────────────────────── */}
      <AboutModal isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* ── Keyboard Shortcuts modal ─────────────────────────────────── */}
      <KeyboardShortcutsModal isOpen={docsOpen} onClose={() => setDocsOpen(false)} />

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        tableUsageTopN={tableUsageTopN}
        onChangeTableUsageTopN={setTableUsageTopN}
      />

      <SaveConsoleModal
        isOpen={!!saveConsoleState}
        initialName={saveConsoleState?.initialName ?? ''}
        isSaving={!!saveConsoleState?.busy}
        error={saveConsoleState?.error ?? ''}
        onCancel={() => { if (!saveConsoleState?.busy) setSaveConsoleState(null) }}
        onSave={performSaveConsole}
      />

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
function TabIcon({ tab, connectionKindById }) {
  const kind = tab.connectionKind ?? connectionKindById.get(tab.connId) ?? 'mysql'
  const className = 'flex-shrink-0 opacity-75'
  if (tab.type === 'redisserver') {
    return <Server size={12} strokeWidth={1.8} className={className} />
  }
  if (tab.type === 'rediskey' || kind === 'redis') {
    return <Key size={12} strokeWidth={1.8} className={className} />
  }
  if (kind === 'mongodb' || tab.objectKind === 'collection') {
    return <Leaf size={12} strokeWidth={1.8} className={className} />
  }
  if (tab.connectionKind || tab.connId) {
    return <Database size={12} strokeWidth={1.8} className={className} />
  }
  if (tab.type === 'console') return <Zap size={12} strokeWidth={1.8} className={className} />
  return <Database size={12} strokeWidth={1.8} className={className} />
}

function TabBar({ tabs, activeTabId, consolesData, onSwitch, onClose, onCloseTab, onCloseAll, onNewConsole, onRenameConsole, connectionKindById }) {
  const [contextMenu, setContextMenu] = useState(null)
  const activeTabRef = useRef(null)

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'end',
      behavior: 'smooth',
    })
  }, [activeTabId, tabs.length])

  useEffect(() => {
    if (!contextMenu) return undefined
    const close = () => setContextMenu(null)
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('click', close)
    document.addEventListener('contextmenu', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('contextmenu', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const openContextMenu = (e, tabId) => {
    e.preventDefault()
    e.stopPropagation()
    onSwitch(tabId)
    setContextMenu({ tabId, x: e.clientX, y: e.clientY })
  }

  const closeMenu = () => setContextMenu(null)

  return (
    <div className="flex items-stretch bg-titlebar border-b border-line-subtle flex-shrink-0 overflow-x-auto min-h-[36px]">
      {tabs.map((tab) => {
        const active     = tab.id === activeTabId
        const isConsole  = tab.type === 'console'
        const data       = consolesData[tab.id]
        const running    = isConsole && data?.isRunning

        return (
          <div
            key={tab.id}
            ref={active ? activeTabRef : null}
            data-tab-id={tab.id}
            onClick={() => onSwitch(tab.id)}
            onContextMenu={(e) => openContextMenu(e, tab.id)}
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
            <TabIcon tab={tab} connectionKindById={connectionKindById} />

            {/* Label */}
            <span className="truncate flex-1 text-[12px]">{tab.label}</span>

            {/* Running pulse (SQL consoles only) */}
            {running && (
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse flex-shrink-0" />
            )}

            {/* Close button — all non-console tabs, plus extra consoles */}
            {(tab.type !== 'console' || tabs.filter((t) => t.type === 'console').length > 1) && (
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

      {contextMenu && (
        <div
          className="fixed z-50 min-w-[140px] py-1 rounded-md border border-line bg-panel shadow-xl text-[12px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {tabs.find((t) => t.id === contextMenu.tabId)?.type === 'console' && (
            <>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-fg-secondary hover:bg-hover hover:text-fg-primary"
                onClick={() => {
                  onRenameConsole?.(contextMenu.tabId)
                  closeMenu()
                }}
              >
                Rename…
              </button>
              <div className="my-1 border-t border-line-subtle" />
            </>
          )}
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left text-fg-secondary hover:bg-hover hover:text-fg-primary"
            onClick={() => {
              onCloseTab(contextMenu.tabId)
              closeMenu()
            }}
          >
            Close Current Tab
          </button>
          <button
            type="button"
            className="w-full px-3 py-1.5 text-left text-fg-secondary hover:bg-hover hover:text-fg-primary"
            onClick={() => {
              onCloseAll()
              closeMenu()
            }}
          >
            Close All Tabs
          </button>
        </div>
      )}
    </div>
  )
}
