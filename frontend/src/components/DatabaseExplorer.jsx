/**
 * DatabaseExplorer — lazy-loading database tree (B2).
 *
 * Tree structure & lazy-load strategy
 * ────────────────────────────────────
 *   connection ──(expand)──► fetchDatabases(connId)           [IPC / ~80 ms]
 *   database   ──(expand)──► fetchTables(connId, dbName)      [IPC / ~80 ms]
 *   table      ──(expand)──► getTableSchema(…).columns        [SQLite / < 1 ms]
 *   column     ──(leaf)────► no children
 *
 * Columns come from the local SQLite cache (getTableSchema) rather than the
 * live database, so expanding a table is always instant once the sync has run.
 *
 * State model
 * ───────────
 *   connections  — ConnectionInfo[] loaded once on mount
 *   expanded     — Set<nodeId>  (toggle on arrow click)
 *   nodeCache    — Map<nodeId, CacheEntry> where
 *                    CacheEntry = { status: 'loading'|'loaded'|'error', children: Node[], error: string }
 *   searchQuery  — substring search across loaded table (and related) node
 *                  labels, **only for connections with connected === true**;
 *                  When the field is empty the full connection list (including
 *                  disconnected) is shown as before.
 *
 * Cleanup
 * ───────
 * Each fetchChildren call uses a local `cancelled` flag so stale Promises
 * can never update state after a re-fetch or component unmount.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  LayoutGrid, Plus, Search, X,
  // Tree-node glyphs.  All of these are thin-stroke Lucide icons (strokeWidth
  // 1.7 by default in this palette) so the sidebar reads as a quiet,
  // consistent system — no more mixed-metric emoji that jump around when the
  // OS changes its emoji font.
  ChevronRight, ChevronDown, Loader2, AlertCircle,
  Plug, Database, Table2, Columns as ColumnsIcon,
  Eye, KeyRound, Users as UsersIcon, UserRound,
  Settings2, Info, Cable, RotateCw, Link2, Unplug,
  FolderOpen, FolderTree,
  ListChecks, Play, Zap, Bell, Code2,
} from 'lucide-react'
import {
  listConnections, fetchDatabases, fetchTables, getTableSchema,
  fetchRoutines, fetchTriggers, fetchEvents,
  runQuery, syncMetadata, connect, connectSaved, disconnect,
} from '../lib/bridge'
import { normalizeError } from '../lib/errors'
import { toast } from '../lib/toast'
import { formatBytes } from '../utils/formatters'

// ─────────────────────────────────────────────────────────────────────────────
// Node ID helpers — deterministic, readable
// ─────────────────────────────────────────────────────────────────────────────
const connNodeId  = (cid)                       => `conn::${cid}`
const groupId     = (cid, kind)                 => `group::${kind}::${cid}`
const dbNodeId    = (cid, db)                   => `db::${cid}::${db}`
const tableNodeId = (cid, db, tbl)              => `tbl::${cid}::${db}::${tbl}`
const colNodeId   = (cid, db, tbl, col)         => `col::${cid}::${db}::${tbl}::${col}`
const userNodeId  = (cid, user, host)           => `user::${cid}::${user}@${host}`
const sysInfoId   = (cid, key)                  => `sysinfo::${cid}::${key}`
const adminId     = (cid, key)                  => `admin::${cid}::${key}`

// ─────────────────────────────────────────────────────────────────────────────
// Tree icon system
//
// The tree used to mix emoji (🔌 🗄 ▦ 👥 ⚙ ℹ⋯) which looked inconsistent across
// macOS / Windows / Linux and changed metrics per-row, making the sidebar feel
// noisy.  We swap to a curated Lucide set with a distinct tint per node kind
// so the eye can scan the hierarchy quickly:
//
//   connection         Plug        teal   (#4ec9b0 — "live" colour)
//   group: databases   Database    green  (#4ec9b0)
//   database           Database    green  (#4ec9b0 — matches the label)
//   folder: tables     FolderTree  muted  (#858585)
//   folder: views      Eye         muted  (#858585)
//   table              Table2      soft   (#d4d4d4)
//   view               Eye         soft   (#d4d4d4)
//   column (normal)    Columns     blue   (#9cdcfe — matches label)
//   column (PK)        KeyRound    gold   (#dcdcaa)
//   group: users       Users       mauve  (#c586c0)
//   user leaf          UserRound   mauve  (#c586c0)
//   group: administer  Settings2   gold   (#dcdcaa)
//   administer leaf    Cable       blue   (#9cdcfe)
//   group: sysinfo     Info        blue   (#9cdcfe)
//   sysinfo leaf       Info        blue   (#9cdcfe)
//
// All helpers below reject unknown types to `null` so a future refactor can't
// silently render a weird placeholder.
// ─────────────────────────────────────────────────────────────────────────────
const NODE_ICON_SIZE        = 13
const NODE_ICON_STROKE      = 1.7
const CHEVRON_SIZE          = 11
const STATUS_INDICATOR_SIZE = 11

/**
 * TreeIcon — renders the correct Lucide icon + tint for a given tree node.
 * Props: { type, folderKind, groupKind, kind, isPK, className }
 *
 * Returns a 14×14 SVG wrapped in a flex-shrink-0 span so the column layout
 * stays stable whether or not we render a chevron before it.
 */
function TreeIcon({ type, folderKind, groupKind, kind, isPK, className = '' }) {
  let Cmp   = null
  // Use CSS custom properties so the icons re-tint when the theme changes.
  let color = 'var(--fg-muted)'  // default (folders, unknown)

  if (type === 'connection')                      { Cmp = Plug;       color = 'var(--success)' }
  else if (type === 'database')                   { Cmp = Database;   color = 'var(--success)' }
  else if (type === 'table' && kind === 'view')   { Cmp = Eye;        color = 'var(--fg-secondary)' }
  else if (type === 'table')                      { Cmp = Table2;     color = 'var(--fg-secondary)' }
  else if (type === 'column' && isPK)             { Cmp = KeyRound;   color = 'var(--syntax-pk)' }
  else if (type === 'column')                     { Cmp = ColumnsIcon;color = 'var(--syntax-keyword)' }
  else if (type === 'user')                       { Cmp = UserRound;  color = 'var(--syntax-user)' }
  else if (type === 'admin')                      { Cmp = Cable;      color = 'var(--syntax-keyword)' }
  else if (type === 'sysinfo')                    { Cmp = Info;       color = 'var(--syntax-keyword)' }
  else if (type === 'folder' && folderKind === 'tables')   { Cmp = FolderTree; color = 'var(--fg-muted)' }
  else if (type === 'folder' && folderKind === 'views')    { Cmp = Eye;        color = 'var(--fg-muted)' }
  else if (type === 'folder' && folderKind === 'routines') { Cmp = Code2;      color = 'var(--fg-muted)' }
  else if (type === 'folder' && folderKind === 'triggers') { Cmp = Zap;        color = 'var(--fg-muted)' }
  else if (type === 'folder' && folderKind === 'events')   { Cmp = Bell;       color = 'var(--fg-muted)' }
  else if (type === 'folder')                              { Cmp = FolderOpen; color = 'var(--fg-muted)' }
  else if (type === 'group' && groupKind === 'databases')  { Cmp = Database;  color = 'var(--success)' }
  else if (type === 'group' && groupKind === 'users')      { Cmp = UsersIcon; color = 'var(--syntax-user)' }
  else if (type === 'group' && groupKind === 'administer') { Cmp = Settings2; color = 'var(--syntax-pk)' }
  else if (type === 'group' && groupKind === 'sysinfo')    { Cmp = Info;      color = 'var(--syntax-keyword)' }

  if (!Cmp) return null
  return (
    <span className={`inline-flex items-center justify-center flex-shrink-0 ${className}`}
          style={{ width: 14, height: 14 }}>
      <Cmp size={NODE_ICON_SIZE} strokeWidth={NODE_ICON_STROKE} color={color} />
    </span>
  )
}

/**
 * labelColorFor — returns the CSS variable that should colour the label of
 * a tree node.  Kept symmetrical with TreeIcon so icon + label tints stay
 * consistent, and so a single token swap (e.g. when the theme flips) updates
 * both at once.
 */
function labelColorFor(node) {
  if (node.type === 'column' && node.isPK) return 'var(--syntax-pk)'
  if (node.type === 'column')               return 'var(--syntax-keyword)'
  if (node.type === 'table')                return 'var(--fg-primary)'
  if (node.type === 'database')             return 'var(--success)'
  if (node.type === 'folder')               return 'var(--fg-muted)'
  if (node.type === 'group')                return 'var(--fg-secondary)'
  if (node.type === 'user')                 return 'var(--syntax-user)'
  if (node.type === 'admin')                return 'var(--syntax-keyword)'
  if (node.type === 'sysinfo')              return 'var(--syntax-keyword)'
  return 'var(--fg-secondary)'
}

/**
 * MenuLabel — tiny wrapper used inside the right-click menu so each action
 * gets a proper 12×12 Lucide glyph instead of an ad-hoc emoji.  Kept separate
 * from TreeIcon because the menu has its own spacing conventions and never
 * needs coloured tints (the active row already paints everything white).
 */
function MenuLabel({ icon: Icon, text }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Icon size={13} strokeWidth={1.8} className="flex-shrink-0 opacity-80" />
      <span className="truncate">{text}</span>
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-connection top-level groups (Phase 22)
//
// Each connection expands into 4 fixed virtual folders.  Order matters: it
// determines the rendering sequence in the tree.
// ─────────────────────────────────────────────────────────────────────────────
const CONN_GROUPS = [
  { kind: 'databases',  label: 'Databases'   },
  { kind: 'users',      label: 'Users'       },
  { kind: 'administer', label: 'Administer'  },
  { kind: 'sysinfo',    label: 'System Info' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Static catalogues for the Administer / System Info groups.
//
// Each entry becomes a leaf node that opens a read-only QueryTabView when
// double-clicked.  `key` is used in the node id so different leaves never
// collide; `label` is what the user sees.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_ITEMS = [
  { key: 'session_manager', label: 'Session Manager', sql: 'SHOW FULL PROCESSLIST' },
]

const SYSINFO_ITEMS = [
  { key: 'session_status',    label: 'Session Status',    sql: 'SHOW SESSION STATUS'    },
  { key: 'global_status',     label: 'Global Status',     sql: 'SHOW GLOBAL STATUS'     },
  { key: 'session_variables', label: 'Session Variables', sql: 'SHOW SESSION VARIABLES' },
  { key: 'global_variables',  label: 'Global Variables',  sql: 'SHOW GLOBAL VARIABLES'  },
  { key: 'engines',           label: 'Engines',           sql: 'SHOW ENGINES'           },
  { key: 'charsets',          label: 'Charsets',          sql: 'SHOW CHARACTER SET'     },
  { key: 'user_privileges',   label: 'User Privileges',
    sql: 'SELECT * FROM information_schema.USER_PRIVILEGES' },
  { key: 'plugin',            label: 'Plugin',            sql: 'SHOW PLUGINS'           },
]

// ─────────────────────────────────────────────────────────────────────────────
// Filter helpers
//
// matchesLabel
//   Pure substring, case-insensitive.  Empty query always matches.
//
// subtreeMatches
//   Recursively determines whether `node` (or any of its already-loaded
//   descendants in nodeCache) contains a match for the query.  Used by
//   TreeBranch / ConnectionRow so that matching children keep their parent
//   chain visible even when the parent label itself does not match.
//
//   We intentionally only walk the already-loaded cache — we do NOT fire off
//   lazy fetches while the user types.  The tree is eagerly populated the
//   moment a user expands each connection, so in practice this catches every
//   visible schema once the connection has been clicked once.
// ─────────────────────────────────────────────────────────────────────────────
const matchesLabel = (text, q) =>
  !q || (text ?? '').toLowerCase().includes(q.toLowerCase())

function subtreeMatches(node, q, nodeCache) {
  if (!q) return true
  if (matchesLabel(node.label, q)) return true
  const cache = nodeCache.get(node.id)
  if (!cache || cache.status !== 'loaded') return false
  return cache.children.some((child) => subtreeMatches(child, q, nodeCache))
}

// ─────────────────────────────────────────────────────────────────────────────
// DatabaseExplorer
//
// Phase 13 props
// ──────────────
//   connections      — ConnectionInfo[] owned by the parent.  When provided,
//                      the Explorer renders from this list instead of its
//                      own fetch, which lets the parent refresh the tree the
//                      moment ConnectionDialog persists a new entry.
//                      (Undefined = legacy standalone mode, used by tests.)
//   reloadKey        — bump to force an explicit refresh (also used when the
//                      parent owns `connections`; the Explorer triggers its
//                      own loadConnections in that case as a belt-and-braces
//                      fallback for the legacy mode).
//   selectedConnId   — highlight this connection row (applied exactly once
//                      when it changes, so the user can still click around
//                      to inspect other connections afterwards).
//   onSelectConn     — fires when the user clicks a connection row in the
//                      tree so the rest of the app can follow along.
// ─────────────────────────────────────────────────────────────────────────────
export default function DatabaseExplorer({
  connections: externalConnections,
  reloadKey = 0,
  selectedConnId,
  onSelectConn,
  onNewConnection,
  onTableOpen,
  onDatabaseOpen,
  onQueryOpen,
  onConsoleOpen,
  onPropertiesOpen,
  onConnectionsChanged,
}) {
  const [ownConnections, setOwnConnections] = useState([])
  const [connLoading,  setConnLoading]  = useState(externalConnections === undefined)
  const [connError,    setConnError]    = useState('')
  const [expanded,     setExpanded]     = useState(new Set())
  const [nodeCache,    setNodeCache]    = useState(new Map()) // nodeId → CacheEntry
  const [searchQuery,  setSearchQuery]  = useState('')
  const [selected,     setSelected]     = useState(null)     // nodeId | null

  // Stable ref so fetchChildren (empty dep-array) can call the latest
  // onConnectionsChanged without being recreated on every render.
  const onConnectionsChangedRef = useRef(onConnectionsChanged)
  useEffect(() => { onConnectionsChangedRef.current = onConnectionsChanged }, [onConnectionsChanged])

  // When the parent supplies `connections`, use that as the source of truth;
  // otherwise fall back to the component's own fetched list (legacy mode,
  // plus a graceful degradation path).
  const connections = externalConnections ?? ownConnections

  // Subset used while `searchQuery` is active — the left search box is meant
  // to find tables only under live TCP connections, not in saved entries that
  // the user has not re-opened (connected === false).
  const connectedConnections = useMemo(
    () => connections.filter((c) => c.connected),
    [connections],
  )

  // Tree rows to show: every connection in browse mode, connected-only
  // while searching (disconnected data sources are hidden for the search UX).
  const treeConnections = searchQuery ? connectedConnections : connections

  // Right-click context menu — discriminated by `kind`:
  //   { kind: 'connection',    x, y, connId, connName }
  //   { kind: 'tables-folder', x, y, connId, dbName, nodeRef }
  // (One menu at a time, so a single state slot is enough.)
  const [contextMenu,     setContextMenu]     = useState(null)
  const [focusedMenuIdx,  setFocusedMenuIdx]  = useState(-1)
  const contextMenuRef    = useRef(null)
  const focusedMenuIdxRef = useRef(-1)

  // Keep the ref in sync so the keydown handler (closure) always reads the
  // latest index without requiring it to be in the effect's dep array.
  useEffect(() => { focusedMenuIdxRef.current = focusedMenuIdx }, [focusedMenuIdx])

  // Reset focus whenever a new menu opens.
  useEffect(() => { setFocusedMenuIdx(-1) }, [contextMenu])

  // Stable ref to nodeCache so callbacks always read the latest version
  // without re-creating themselves (avoids stale-closure bugs).
  const nodeCacheRef = useRef(nodeCache)
  useEffect(() => { nodeCacheRef.current = nodeCache }, [nodeCache])

  // ── Auto-collapse disconnected connections ────────────────────────────────
  //
  // When a connection transitions from connected→disconnected (detected by
  // comparing with the previous render's list), we wipe its subtree from
  // nodeCache and remove it from `expanded`.  This prevents stale database /
  // table nodes from lingering in the tree after the TCP pool is closed,
  // which avoids the UX confusion of a tree that looks live but isn't.
  const prevConnectionsRef = useRef([])
  useEffect(() => {
    const prevById = Object.fromEntries(
      prevConnectionsRef.current.map((c) => [c.id, c]),
    )
    const newlyDisconnected = connections.filter(
      (c) => !c.connected && prevById[c.id]?.connected === true,
    )

    if (newlyDisconnected.length > 0) {
      setNodeCache((prev) => {
        const next = new Map(prev)
        const drop = (id) => {
          const entry = next.get(id)
          next.delete(id)
          if (entry?.children) entry.children.forEach((ch) => drop(ch.id))
        }
        newlyDisconnected.forEach((conn) => drop(connNodeId(conn.id)))
        return next
      })
      setExpanded((prev) => {
        const next = new Set(prev)
        newlyDisconnected.forEach((conn) => next.delete(connNodeId(conn.id)))
        return next
      })
    }

    prevConnectionsRef.current = connections
  }, [connections])

  // ── Auto-expansion for search (Phase 17 / Task 3) ────────────────────────
  //
  // When `searchQuery` is non-empty we must keep every ancestor of a matching
  // node open so the match is actually visible.  We compute a memoised
  // "autoExpanded" set of nodeIds to union with the user-controlled
  // `expanded` state.  This keeps the user's collapse/expand choices intact
  // the moment they clear the search box.
  //
  //   effectiveExpanded = expanded ∪ autoExpanded
  //
  // We walk every *connected* connection's loaded subtree in nodeCache.  The
  // walk bails out as soon as a subtree has no match, so the worst case scales
  // with (# matching subtrees × subtree depth), which is tiny.
  const autoExpanded = useMemo(() => {
    const set = new Set()
    if (!searchQuery) return set

    const visit = (node) => {
      const cache = nodeCache.get(node.id)
      if (!cache || cache.status !== 'loaded') return false
      let anyChildMatches = false
      for (const child of cache.children) {
        const childHasMatch = matchesLabel(child.label, searchQuery) || visit(child)
        if (childHasMatch) anyChildMatches = true
      }
      if (anyChildMatches) set.add(node.id)
      return anyChildMatches
    }

    for (const conn of connectedConnections) {
      const root = { id: connNodeId(conn.id) }
      visit(root)
    }
    return set
  }, [searchQuery, nodeCache, connectedConnections])

  const isEffectivelyExpanded = useCallback(
    (nodeId) => expanded.has(nodeId) || autoExpanded.has(nodeId),
    [expanded, autoExpanded],
  )

  // Close context menu on outside click; full keyboard navigation when open.
  useEffect(() => {
    if (!contextMenu) return

    const close = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) {
        setContextMenu(null)
      }
    }

    const handleKey = (e) => {
      // Build items fresh each keystroke so actions are always current.
      const allItems  = buildMenuItems(contextMenu)
      const items     = allItems.filter((it) => !it.divider)
      const len       = items.length

      if (e.key === 'Escape') {
        setContextMenu(null)
        return
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedMenuIdx((prev) => (prev + 1) % len)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedMenuIdx((prev) => (prev - 1 + len) % len)
        return
      }

      if (e.key === 'Enter') {
        const idx = focusedMenuIdxRef.current
        if (idx >= 0 && idx < len) {
          e.preventDefault()
          items[idx].action()
          setContextMenu(null)
        }
        return
      }

      // Shortcut key (letter mnemonic or function key)
      const matched = items.find(
        (it) => it.key && it.key.toLowerCase() === e.key.toLowerCase()
      )
      if (matched) {
        e.preventDefault()
        matched.action()
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', close)
    document.addEventListener('keydown',   handleKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown',   handleKey)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextMenu])

  // ── Load connections on mount / on reloadKey bump ────────────────────────
  //
  // Only fetches when the parent has NOT supplied its own list.  The parent
  // owns `connections` in the Phase-13 flow, so `loadConnections` mostly
  // stays idle in production but remains functional for test harnesses and
  // the manual refresh button in the header.
  const loadConnections = useCallback(() => {
    if (externalConnections !== undefined) return undefined
    let cancelled = false
    setConnLoading(true)
    setConnError('')

    listConnections()
      .then((conns) => {
        if (!cancelled) setOwnConnections(conns)
      })
      .catch((err) => {
        if (!cancelled) setConnError(String(err))
      })
      .finally(() => {
        if (!cancelled) setConnLoading(false)
      })

    return () => { cancelled = true }
  }, [externalConnections])

  useEffect(() => loadConnections(), [loadConnections, reloadKey])

  // ── Sync local "selected" to the parent-controlled selectedConnId ────────
  //
  // Whenever the parent changes `selectedConnId` (e.g. after saving a new
  // connection through ConnectionDialog) the corresponding row should pop
  // into the highlighted state so the user sees their new entry at a glance.
  // We drop the sync if the user already has that row selected manually.
  useEffect(() => {
    if (!selectedConnId) return
    const targetId = connNodeId(selectedConnId)
    setSelected((cur) => (cur === targetId ? cur : targetId))
  }, [selectedConnId])

  // ── Lazy-fetch children for a node ───────────────────────────────────────
  //
  // For most node types only `nodeId`, `type`, and the IDs we need for the
  // upstream query are required.  We pass the full node so each branch can
  // pull whatever it needs (folderKind, groupKind, etc.) without long
  // positional argument lists.
  const fetchChildren = useCallback(async (node) => {
    const { id: nodeId, type, connId, dbName, tableName } = node

    // Skip if already fetching or fetched.
    const existing = nodeCacheRef.current.get(nodeId)
    if (existing?.status === 'loading' || existing?.status === 'loaded') return

    let cancelled = false

    setNodeCache((prev) => new Map([...prev, [nodeId, { status: 'loading', children: [], error: '' }]]))

    try {
      let children = []

      if (type === 'connection') {
        // Phase 22: a connection now exposes 4 fixed top-level groups that
        // mirror DBeaver's "navigator".  No backend call here — children are
        // synthesised locally and lazy-load their own contents on expansion.
        children = CONN_GROUPS.map((g) => ({
          id:        groupId(connId, g.kind),
          type:      'group',
          groupKind: g.kind,
          label:     g.label,
          connId,
          hasChildren: true,
        }))

      } else if (type === 'group' && node.groupKind === 'databases') {
        // Wails encodes Go's `nil` slices as JSON `null`, not `[]`.  Coerce
        // here so the .map() below never blows up on a server with zero
        // visible schemas (or a transient permission glitch).
        const dbs = (await fetchDatabases(connId)) ?? []
        if (cancelled) return
        // A successful fetchDatabases proves the connection is alive — refresh
        // the connection list so the status dot updates immediately.
        onConnectionsChangedRef.current?.()
        children = dbs.map((db) => ({
          id: dbNodeId(connId, db), type: 'database', label: db,
          connId, dbName: db, hasChildren: true,
        }))

      } else if (type === 'group' && node.groupKind === 'users') {
        // mysql.user lives in the system schema; we only ask for the columns
        // we render so the tree stays snappy on busy servers.
        const sql =
          'SELECT user, host FROM mysql.user ORDER BY user, host'
        const result = await runQuery(connId, '', sql)
        if (cancelled) return
        if (result?.error) throw new Error(result.error)
        children = (result.rows ?? []).map((row) => {
          const user = String(row[0] ?? '')
          const host = String(row[1] ?? '')
          return {
            id:    userNodeId(connId, user, host),
            type:  'user',
            label: `${user}@${host}`,
            connId,
            user,
            host,
            hasChildren: false,
          }
        })

      } else if (type === 'group' && node.groupKind === 'administer') {
        children = ADMIN_ITEMS.map((it) => ({
          id:    adminId(connId, it.key),
          type:  'admin',
          label: it.label,
          adminKey: it.key,
          sql:   it.sql,
          connId,
          hasChildren: false,
        }))

      } else if (type === 'group' && node.groupKind === 'sysinfo') {
        children = SYSINFO_ITEMS.map((it) => ({
          id:    sysInfoId(connId, it.key),
          type:  'sysinfo',
          label: it.label,
          sysKey: it.key,
          sql:   it.sql,
          connId,
          hasChildren: false,
        }))

      } else if (type === 'database') {
        // Databases show virtual folder nodes so the tree mirrors DBeaver.
        children = [
          {
            id: `folder::tables::${connId}::${dbName}`,
            type: 'folder', folderKind: 'tables', label: 'Tables',
            connId, dbName, hasChildren: true,
          },
          {
            id: `folder::routines::${connId}::${dbName}`,
            type: 'folder', folderKind: 'routines', label: 'Procedures & Functions',
            connId, dbName, hasChildren: true,
          },
          {
            id: `folder::triggers::${connId}::${dbName}`,
            type: 'folder', folderKind: 'triggers', label: 'Triggers',
            connId, dbName, hasChildren: true,
          },
          {
            id: `folder::events::${connId}::${dbName}`,
            type: 'folder', folderKind: 'events', label: 'Events',
            connId, dbName, hasChildren: true,
          },
        ]

      } else if (type === 'folder' && node.folderKind === 'tables') {
        const tables = (await fetchTables(connId, dbName)) ?? []
        if (cancelled) return
        children = tables.map((t) => ({
          id: tableNodeId(connId, dbName, t.name), type: 'table', label: t.name,
          kind: t.kind, rowCount: t.rowCount, sizeBytes: t.sizeBytes ?? -1,
          connId, dbName, tableName: t.name, hasChildren: true,
        }))

      } else if (type === 'folder' && node.folderKind === 'routines') {
        const routines = (await fetchRoutines(connId, dbName)) ?? []
        if (cancelled) return
        children = routines.length === 0
          ? [{ id: `${node.id}::empty`, type: 'sysinfo', label: 'No procedures or functions', connId, hasChildren: false }]
          : routines.map((r) => ({
              id: `routine::${connId}::${dbName}::${r.name}::${r.type}`,
              type: 'sysinfo',
              label: `${r.name}${r.type === 'FUNCTION' ? ' ()' : ''}`,
              connId, dbName,
              hasChildren: false,
              sql: r.type === 'FUNCTION'
                ? `SHOW CREATE FUNCTION \`${dbName}\`.\`${r.name}\``
                : `SHOW CREATE PROCEDURE \`${dbName}\`.\`${r.name}\``,
            }))

      } else if (type === 'folder' && node.folderKind === 'triggers') {
        const triggers = (await fetchTriggers(connId, dbName)) ?? []
        if (cancelled) return
        children = triggers.length === 0
          ? [{ id: `${node.id}::empty`, type: 'sysinfo', label: 'No triggers', connId, hasChildren: false }]
          : triggers.map((t) => ({
              id: `trigger::${connId}::${dbName}::${t.name}`,
              type: 'sysinfo',
              label: `${t.timing} ${t.event} on ${t.name}`,
              connId, dbName,
              hasChildren: false,
              sql: `SHOW CREATE TRIGGER \`${dbName}\`.\`${t.name}\``,
            }))

      } else if (type === 'folder' && node.folderKind === 'events') {
        const events = (await fetchEvents(connId, dbName)) ?? []
        if (cancelled) return
        children = events.length === 0
          ? [{ id: `${node.id}::empty`, type: 'sysinfo', label: 'No events', connId, hasChildren: false }]
          : events.map((e) => ({
              id: `event::${connId}::${dbName}::${e.name}`,
              type: 'sysinfo',
              label: `${e.name} (${e.status})`,
              connId, dbName,
              hasChildren: false,
              sql: `SHOW CREATE EVENT \`${dbName}\`.\`${e.name}\``,
            }))

      } else if (type === 'table') {
        // Column data comes from the local SQLite cache — sub-millisecond.
        const schema = await getTableSchema(connId, dbName, tableName)
        if (cancelled) return
        children = (schema.columns ?? []).map((c) => ({
          id: colNodeId(connId, dbName, tableName, c.name), type: 'column',
          label: c.name, detail: c.type, isPK: c.isPrimaryKey, nullable: c.nullable,
          connId, dbName, tableName, hasChildren: false,
        }))
      }

      if (!cancelled) {
        setNodeCache((prev) => new Map([...prev, [nodeId, { status: 'loaded', children, error: '' }]]))
      }
    } catch (err) {
      if (!cancelled) {
        setNodeCache((prev) => new Map([...prev, [nodeId, { status: 'error', children: [], error: normalizeError(err) }]]))
      }
    }

    // Cleanup marks this particular fetch as stale so any in-flight Promises
    // become no-ops (cancelled flag in closure above).
    return () => { cancelled = true }
  }, [])

  // ── Toggle expand / collapse ──────────────────────────────────────────────
  const toggleExpand = useCallback((node) => {
    if (!node.hasChildren) return

    const isOpen = expanded.has(node.id)
    setExpanded((prev) => {
      const next = new Set(prev)
      isOpen ? next.delete(node.id) : next.add(node.id)
      return next
    })

    if (!isOpen) {
      fetchChildren(node)
    }
  }, [expanded, fetchChildren])

  // ── Refresh a specific node ───────────────────────────────────────────────
  //
  // Recursively clears the cache entry for `node` and every loaded
  // descendant so that re-fetching the root really does rebuild the whole
  // visible subtree (otherwise stale `databases` / `tables` children would
  // linger and the user would see no effect from the refresh).
  const refreshNode = useCallback((node, e) => {
    e?.stopPropagation?.()

    setNodeCache((prev) => {
      const next = new Map(prev)
      const drop = (id) => {
        const entry = next.get(id)
        next.delete(id)
        if (entry?.children) entry.children.forEach((c) => drop(c.id))
      }
      drop(node.id)
      return next
    })

    fetchChildren(node)
  }, [fetchChildren])

  // ── Refresh an entire connection (Phase 22) ───────────────────────────────
  //
  // Triggers a backend SyncMetadata crawl AND drops the local tree cache so
  // the user sees the freshly-pulled databases/tables/columns when the tree
  // re-expands.  Errors from SyncMetadata are silent — the local refresh
  // still runs, which is the most-important half of the operation.
  const refreshConnection = useCallback(async (connId) => {
    try { await syncMetadata(connId) } catch { /* best-effort */ }

    const root = {
      id: connNodeId(connId), type: 'connection',
      connId, hasChildren: true,
    }
    refreshNode(root, null)
    onConnectionsChanged?.()
  }, [refreshNode, onConnectionsChanged])

  // ── Table open handler ────────────────────────────────────────────────────
  /**
   * openTable — open (or activate) the table's TableViewer tab.
   *
   * @param {object}  node
   * @param {Event|null} e
   * @param {'properties'|'data'} [defaultView='properties']
   *   Pass 'data' when the user wants to jump straight to the query result.
   */
  const openTable = useCallback((node, e, defaultView = 'properties') => {
    e?.stopPropagation()
    onTableOpen?.({ tableName: node.tableName, dbName: node.dbName, connId: node.connId, defaultView })
  }, [onTableOpen])

  // ── Database overview open handler ────────────────────────────────────────
  const openDatabase = useCallback((node, e) => {
    e?.stopPropagation()
    onDatabaseOpen?.({ dbName: node.dbName, connId: node.connId })
  }, [onDatabaseOpen])

  // ── Read-only query open handler (Phase 22) ───────────────────────────────
  //
  // Used for leaves under Users / Administer / System Info.  Each leaf carries
  // its own SQL plus a stable `key` so the host App can de-duplicate tabs
  // independently per source (e.g. opening "Session Status" twice activates
  // the same tab; opening Session + Global creates two).
  const openQuery = useCallback((node, e) => {
    e?.stopPropagation?.()
    if (!onQueryOpen || !node.sql) return
    onQueryOpen({
      key:    node.id,                // already unique per (connId, leaf)
      label:  node.label,
      sql:    node.sql,
      connId: node.connId,
    })
  }, [onQueryOpen])

  // ─────────────────────────────────────────────────────────────────────────
  // Render helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Row background + hover style based on selection */
  const rowCls = (nodeId) => [
    'flex items-center gap-1 px-2 py-[3px] rounded-sm cursor-pointer select-none group transition-colors',
    nodeId === selected
      ? 'bg-active text-fg-primary'
      : 'hover:bg-hover text-fg-secondary',
  ].join(' ')

  // ── Single node row ───────────────────────────────────────────────────────
  function NodeRow({ node, depth }) {
    const isOpen     = isEffectivelyExpanded(node.id)
    const cache      = nodeCache.get(node.id)
    const isLoading  = cache?.status === 'loading'
    const isErr      = cache?.status === 'error'
    const isTable    = node.type === 'table'
    const isFolder   = node.type === 'folder'
    const isView     = node.kind === 'view'

    // Visibility rule for search (Phase 17): show the node if its label
    // matches OR any descendant in the loaded cache matches.  Parents stay
    // visible as long as the subtree they guard has something to show.
    if (searchQuery && !subtreeMatches(node, searchQuery, nodeCache)) return null

    const isLeafQuery = node.type === 'sysinfo' || node.type === 'admin'

    // Phase 14 / Task 2: Split the click semantics for table nodes so the
    // browser's dblclick heuristic reliably sees two rapid clicks on the same
    // element.  If single-click also toggles expansion, the row's layout
    // shifts (children appear/disappear) between clicks and the browser can
    // abort the dblclick.  For tables we therefore:
    //   • row onClick         → select only
    //   • row onDoubleClick   → open Data view
    //   • arrow span onClick  → toggle expand (explicit & discoverable)
    // For other node types (connection/database/folder) keeping click=toggle
    // is fine because they have no "open" action on single click.
    const handleRowClick = (e) => {
      // Phase 14 / Task 2: always select on click, whatever the node type
      setSelected(node.id)
      // Tables never toggle on single-click; only the arrow does.
      if (!isTable) {
        toggleExpand(node)
      }
    }

    const handleArrowClick = (e) => {
      // Only tables route here; for other nodes the outer row handles toggle.
      e.stopPropagation()
      toggleExpand(node)
    }

    // Right-click on a database node pops a DBeaver-style context menu
    // (Create New Table / View Tables / Browse from here / Refresh).
    // Right-click on the Tables folder is intentionally left unhandled so
    // actions are discoverable in one consistent place: the database row.
    const handleContextMenu = (e) => {
      if (node.type === 'database') {
        e.preventDefault()
        e.stopPropagation()
        setSelected(node.id)
        setContextMenu({
          kind:    'database',
          x:       e.clientX,
          y:       e.clientY,
          connId:  node.connId,
          dbName:  node.dbName,
          nodeRef: node,
        })
      } else if (isTable) {
        e.preventDefault()
        e.stopPropagation()
        setSelected(node.id)
        setContextMenu({
          kind:      'table',
          x:         e.clientX,
          y:         e.clientY,
          connId:    node.connId,
          dbName:    node.dbName,
          tableName: node.tableName,
          tableKind: node.kind,
          nodeRef:   node,
        })
      }
    }

    return (
      <div
        className={rowCls(node.id)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={(e) => {
          // Phase 14 / Task 2: also call preventDefault so the browser does
          // NOT interpret the second click as a text selection — important
          // because on some platforms a missed dblclick-to-selection swap
          // would visibly flash a blue text range inside the tree.
          e.preventDefault()
          if (isTable) openTable(node, e, 'data')
          if (isFolder && node.folderKind === 'tables') openDatabase(node, e)
          if (isLeafQuery) openQuery(node, e)
        }}
      >
        {/* Expand chevron.  For table nodes the chevron owns its own click
            handler so single-clicking the row does NOT expand/collapse —
            only the chevron does.  This keeps dblclick-to-open-data
            reliable because the row's layout doesn't shift between clicks. */}
        {node.hasChildren ? (
          <span
            className={[
              'w-3.5 flex items-center justify-center flex-shrink-0 text-fg-muted',
              isTable ? 'cursor-pointer hover:text-fg-primary' : '',
            ].join(' ')}
            onClick={isTable ? handleArrowClick : undefined}
          >
            {isLoading ? (
              <Loader2 size={CHEVRON_SIZE} strokeWidth={2} className="animate-spin" />
            ) : isOpen ? (
              <ChevronDown size={CHEVRON_SIZE} strokeWidth={2} />
            ) : (
              <ChevronRight size={CHEVRON_SIZE} strokeWidth={2} />
            )}
          </span>
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        {/* Typed icon */}
        <TreeIcon
          type={node.type}
          folderKind={node.folderKind}
          groupKind={node.groupKind}
          kind={node.kind}
          isPK={node.isPK}
        />

        {/* Label — coloured by node type using theme tokens.  Inline style
            (rather than utility class) lets a single var() switch the colour
            cleanly under both light and dark themes. */}
        <span
          className="truncate text-[12px] flex-1"
          style={{ color: labelColorFor(node) }}
        >
          {node.label}
        </span>

        {/* Column type hint */}
        {node.type === 'column' && node.detail && (
          <span className="text-[10px] text-fg-muted flex-shrink-0 ml-1 font-mono truncate max-w-[70px]" title={node.detail}>
            {node.detail}
          </span>
        )}

        {/* Table size badge — always visible, distinct from row count hover hint */}
        {isTable && (() => {
          const sizeLabel = formatBytes(node.sizeBytes)
          return sizeLabel ? (
            <span
              className={[
                'flex-shrink-0 ml-1 px-1 py-px rounded text-[10px] tabular-nums leading-none select-none',
                'bg-sunken text-fg-muted',
                // When the row is selected the badge needs to remain readable.
                node.id === selected
                  ? 'bg-accent text-fg-on-accent'
                  : 'group-hover:bg-elevated group-hover:text-fg-secondary',
              ].join(' ')}
              title={`Disk size: ${node.sizeBytes.toLocaleString()} bytes`}
            >
              {sizeLabel}
            </span>
          ) : null
        })()}

        {/* "Open overview" button on the Tables folder */}
        {isFolder && node.folderKind === 'tables' && (
          <button
            title="Open database overview"
            onClick={(e) => openDatabase(node, e)}
            className="flex items-center justify-center w-5 h-5 text-fg-muted hover:text-success
                       flex-shrink-0 opacity-0 group-hover:opacity-100 ml-1 transition-colors"
          >
            <LayoutGrid size={11} strokeWidth={1.8} />
          </button>
        )}

        {/* Quick "open Data view" button (table nodes only, Phase 6.9)
            Visible on hover or when the node is selected. Clicking it is
            identical to double-clicking the table name: opens the TableViewer
            directly on the Data tab. e.stopPropagation() prevents the outer
            onClick from also triggering expand/collapse. */}
        {isTable && (
          <button
            title="Open table data"
            // Phase 14 / Task 2: stopPropagation prevents the outer row's
            // onClick / onDoubleClick from firing; preventDefault is a belt
            // for the rare case where the <button> default behaviour would
            // interfere (e.g. focus shifts triggering synthetic click events
            // that the dblclick detector might mis-pair with the row).
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              openTable(node, null, 'data')
            }}
            onDoubleClick={(e) => {
              // A fast double-click on the icon itself must not propagate
              // to the row's onDoubleClick either (which would double-open).
              e.stopPropagation()
              e.preventDefault()
            }}
            className={[
              'flex items-center justify-center w-5 h-5 rounded flex-shrink-0 ml-0.5',
              'transition-all duration-150',
              'text-fg-muted hover:text-accent hover:bg-hover',
              // Show when the row is hovered (group-hover) or when selected
              node.id === selected
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100',
            ].join(' ')}
          >
            <LayoutGrid size={12} strokeWidth={1.8} />
          </button>
        )}

        {/* Error state */}
        {isErr && (
          <span className="text-danger flex-shrink-0 flex items-center" title={cache.error}>
            <AlertCircle size={STATUS_INDICATOR_SIZE} strokeWidth={2} />
          </span>
        )}
      </div>
    )
  }

  // ── Recursive tree renderer ───────────────────────────────────────────────
  function TreeBranch({ node, depth }) {
    const isOpen  = isEffectivelyExpanded(node.id)
    const cache   = nodeCache.get(node.id)
    if (searchQuery && !subtreeMatches(node, searchQuery, nodeCache)) return null

    return (
      <>
        <NodeRow node={node} depth={depth} />
        {isOpen && cache?.status === 'loaded' && cache.children.map((child) => (
          <TreeBranch key={child.id} node={child} depth={depth + 1} />
        ))}
        {isOpen && cache?.status === 'loaded' && cache.children.length === 0 && (
          <div
            style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            className="py-0.5 text-[11px] italic text-fg-muted select-none"
          >
            (empty)
          </div>
        )}
        {isOpen && cache?.status === 'error' && (
          <div
            style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            className="flex items-center gap-1.5 py-1 text-[11px] text-danger"
          >
            <AlertCircle size={STATUS_INDICATOR_SIZE} strokeWidth={2} className="flex-shrink-0" />
            <span className="truncate">{cache.error}</span>
            <button
              onClick={(e) => refreshNode(node, e)}
              className="ml-1 text-fg-muted hover:text-fg-primary underline"
            >
              retry
            </button>
          </div>
        )}
      </>
    )
  }

  // ── Connection node row (has extra connected badge) ───────────────────────
  function ConnectionRow({ conn }) {
    const nodeId    = connNodeId(conn.id)
    const isOpen    = isEffectivelyExpanded(nodeId)
    const cache     = nodeCache.get(nodeId)
    const isLoading = cache?.status === 'loading'

    const connLabel = conn.name || `${conn.host}:${conn.port}`
    const node = {
      id: nodeId, type: 'connection', label: connLabel,
      connId: conn.id, hasChildren: true,
    }

    // Search visibility: the connection row stays if its label, the display
    // name, the host:port, the default database, OR any loaded descendant
    // matches.  This lets users type either a server name or a table name to
    // reveal the row.
    if (searchQuery) {
      const selfMatch =
        matchesLabel(connLabel, searchQuery) ||
        matchesLabel(`${conn.host}:${conn.port}`, searchQuery) ||
        matchesLabel(conn.database ?? '', searchQuery)
      if (!selfMatch && !subtreeMatches(node, searchQuery, nodeCache)) return null
    }

    const handleContextMenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ kind: 'connection', x: e.clientX, y: e.clientY, connId: conn.id, connName: conn.name })
    }

    return (
      <>
        <div
          className={rowCls(nodeId)}
          style={{ paddingLeft: '8px' }}
          onClick={() => {
            setSelected(nodeId)
            onSelectConn?.(conn.id)
            toggleExpand(node)
          }}
          onContextMenu={handleContextMenu}
        >
          <span className="w-3.5 flex items-center justify-center flex-shrink-0 text-fg-muted">
            {isLoading
              ? <Loader2 size={CHEVRON_SIZE} strokeWidth={2} className="animate-spin" />
              : isOpen ? <ChevronDown size={CHEVRON_SIZE} strokeWidth={2} />
                       : <ChevronRight size={CHEVRON_SIZE} strokeWidth={2} />}
          </span>
          <TreeIcon type="connection" />
          {conn.color && (
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0 -ml-0.5 mr-0.5 border border-black/10"
              style={{ backgroundColor: conn.color }}
              title={`Color label: ${conn.color}`}
            />
          )}
          <div className="flex-1 flex flex-col min-w-0">
            <span className="text-[12px] truncate text-fg-primary font-medium">
              {conn.name || `${conn.host}:${conn.port}`}
              {conn.readOnly && (
                <span className="ml-1.5 text-[9px] text-warn bg-warn/10 border border-warn/30 rounded px-1 select-none">RO</span>
              )}
            </span>
            {conn.database && (
              <span className="text-[10px] text-fg-muted truncate">{conn.database}</span>
            )}
          </div>
          {/* Connected status dot — a plain CSS dot is sharper than any
              Lucide glyph at this size (≈6px) and stays crisp on HiDPI. */}
          <span
            className={[
              'w-2 h-2 rounded-full flex-shrink-0 ml-1 transition-colors',
              conn.connected
                ? 'bg-success shadow-[0_0_4px_rgba(26,127,55,0.4)]'
                : 'bg-danger',
            ].join(' ')}
            title={conn.connected ? 'Connected' : 'Disconnected'}
          />
          {/* Refresh button — connection-wide reload (SyncMetadata + tree) */}
          <button
            title="Refresh connection"
            onClick={(e) => { e.stopPropagation(); refreshConnection(conn.id) }}
            className="flex items-center justify-center text-fg-muted hover:text-fg-primary opacity-0 group-hover:opacity-100 ml-1 transition-colors"
          >
            <RotateCw size={11} strokeWidth={2} />
          </button>
        </div>

        {isOpen && cache?.status === 'loaded' && cache.children.map((groupNode) => (
          <TreeBranch key={groupNode.id} node={groupNode} depth={1} />
        ))}
        {isOpen && cache?.status === 'error' && (
          <div className="pl-8 py-1 text-[11px] text-danger flex items-center gap-1.5">
            <AlertCircle size={STATUS_INDICATOR_SIZE} strokeWidth={2} className="flex-shrink-0" />
            <span className="truncate">{cache.error}</span>
            <button onClick={(e) => refreshNode(node, e)} className="ml-1 text-fg-muted hover:text-fg-primary underline">
              retry
            </button>
          </div>
        )}
      </>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-sunken border-r border-line-subtle overflow-hidden">

      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-line-subtle flex-shrink-0">
        <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider flex-1 select-none">
          Explorer
        </span>
        {/* New connection button */}
        <button
          title="New connection…"
          onClick={() => onNewConnection?.()}
          className="flex items-center justify-center w-5 h-5 text-fg-muted hover:text-success
                     hover:bg-hover rounded transition-colors"
        >
          <Plus size={13} />
        </button>
        <button
          title="Refresh connections"
          onClick={() => { setNodeCache(new Map()); loadConnections() }}
          className="flex items-center justify-center w-5 h-5 text-fg-muted hover:text-fg-primary hover:bg-hover rounded transition-colors"
        >
          <RotateCw size={12} strokeWidth={2} />
        </button>
      </div>

      {/* ── Search (Phase 17 / Task 3) ───────────────────────────────── */}
      {/*
        A sticky search input with a magnifier icon on the left and an
        optional clear-button on the right.  Typing narrows the tree to
        matching tables and auto-expands their parent Database / Connection
        nodes so results are immediately visible.
      */}
      <div className="px-2 py-1.5 border-b border-line-subtle flex-shrink-0">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setSearchQuery('') }}
            placeholder="Search tables in connected sources…"
            title="Only searches under live (connected) sources; saved but disconnected entries are excluded"
            className="w-full bg-panel text-fg-primary text-[12px] pl-7 pr-7 py-1
                       rounded border border-line outline-none
                       placeholder:text-fg-muted focus:border-accent transition-colors"
          />
          {searchQuery && (
            <button
              title="Clear search (Esc)"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2
                         w-4 h-4 flex items-center justify-center
                         text-fg-muted hover:text-fg-primary hover:bg-hover
                         rounded transition-colors"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* ── Tree body ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
        {connLoading && (
          <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-fg-muted">
            <Loader2 size={12} strokeWidth={2} className="animate-spin flex-shrink-0" />
            <span>Connecting…</span>
          </div>
        )}

        {connError && (
          <div className="px-3 py-2 text-[12px] text-danger">
            <div className="flex items-start gap-1.5">
              <AlertCircle size={STATUS_INDICATOR_SIZE} strokeWidth={2} className="flex-shrink-0 mt-[2px]" />
              <span>{connError}</span>
            </div>
            <button onClick={loadConnections} className="mt-1 text-fg-muted hover:text-fg-primary underline text-[11px]">
              retry
            </button>
          </div>
        )}

        {!connLoading && !connError && connections.length === 0 && (
          <div className="px-4 py-6 text-[12px] text-fg-muted text-center select-none">
            <div className="flex justify-center mb-2 opacity-50">
              <Plug size={28} strokeWidth={1.5} />
            </div>
            <div>No connections</div>
            <div className="text-[11px] mt-1">Add a connection to get started</div>
          </div>
        )}

        {treeConnections.map((conn) => (
          <ConnectionRow key={conn.id} conn={conn} />
        ))}

        {/*
          When searching: (1) no connected sources — prompt to connect first;
          (2) connected but nothing in the loaded cache matches the query.
        */}
        {!connLoading && !connError && searchQuery && connections.length > 0
          && connectedConnections.length === 0 && (
          <div className="px-4 py-6 text-[12px] text-fg-muted text-center select-none">
            <Unplug size={20} className="mx-auto mb-2 opacity-50" />
            <div>No connected data sources</div>
            <div className="text-[11px] mt-1 text-fg-faint">
              Connect a source first, then search for its tables here
            </div>
          </div>
        )}

        {!connLoading && !connError && searchQuery && connectedConnections.length > 0
          && autoExpanded.size === 0 &&
          !connectedConnections.some((c) =>
            matchesLabel(c.name || `${c.host}:${c.port}`, searchQuery) ||
            matchesLabel(`${c.host}:${c.port}`, searchQuery) ||
            matchesLabel(c.database ?? '', searchQuery),
          ) && (
            <div className="px-4 py-6 text-[12px] text-fg-muted text-center select-none">
              <div className="text-[20px] mb-1">🔍</div>
              <div>No results for &quot;{searchQuery}&quot;</div>
              <div className="text-[11px] mt-1 text-fg-faint">
                Search is limited to connected sources; expand a connection to load its tables
              </div>
            </div>
          )}
      </div>

      {/* ── Context menu (right-click on connection / database / table) ── */}
      {contextMenu && (() => {
        const allItems = buildMenuItems(contextMenu)
        if (!allItems || allItems.length === 0) return null
        // Build a flat index of non-divider items so focusedMenuIdx aligns
        // with the same position the keyboard handler uses.
        let nonDividerIdx = -1
        return (
          <div
            ref={contextMenuRef}
            style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 9999 }}
            className="bg-panel border border-line rounded shadow-xl py-1 min-w-[210px] text-[12px]"
          >
            {allItems.map((item, i) => {
              if (item.divider) {
                return <div key={i} className="border-t border-line-subtle my-1" />
              }
              nonDividerIdx++
              const isFocused = nonDividerIdx === focusedMenuIdx
              const idx = nonDividerIdx
              return (
                <button
                  key={i}
                  onClick={() => { item.action(); setContextMenu(null) }}
                  onMouseEnter={() => setFocusedMenuIdx(idx)}
                  className={[
                    'w-full text-left px-3 py-1.5 flex items-center justify-between gap-3 transition-colors',
                    isFocused
                      ? 'bg-selected text-fg-on-accent'
                      : 'text-fg-primary hover:bg-selected hover:text-fg-on-accent',
                  ].join(' ')}
                >
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.shortcut && (
                    <kbd className={[
                      'text-[10px] tabular-nums flex-shrink-0 px-1 py-0.5 rounded border font-mono',
                      isFocused
                        ? 'border-white/30 text-white/80 bg-white/10'
                        : 'border-line text-fg-muted bg-panel',
                    ].join(' ')}>
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              )
            })}
          </div>
        )
      })()}
    </div>
  )

  // ─── Context-menu item builder ────────────────────────────────────────────
  // Lives inside the component so it can close over openDatabase, refreshNode,
  // onConsoleOpen, etc.  Returns an array of { label, action, shortcut? } or
  // { divider: true }.  Returning [] hides the menu completely.
  function buildMenuItems(ctx) {
    if (!ctx) return []

    if (ctx.kind === 'table') {
      const { connId, dbName, tableName, tableKind, nodeRef } = ctx
      return [
        {
          label:    <MenuLabel icon={ListChecks} text="View Table" />,
          shortcut: 'F4', key: 'F4',
          action:   () => openTable(nodeRef, null, 'properties'),
        },
        { divider: true },
        {
          label:    <MenuLabel icon={Play} text="Export SQL Dump…" />,
          key: 'd',
          action:   async () => {
            try {
              const { exportDump } = await import('../lib/bridge')
              const sql = await exportDump(connId, dbName, tableName)
              const blob = new Blob([sql], { type: 'text/plain;charset=utf-8;' })
              const url  = URL.createObjectURL(blob)
              const a    = Object.assign(document.createElement('a'), {
                href: url, download: `${tableName}_dump.sql`,
              })
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
              toast.success(`Exported ${tableName}_dump.sql`)
            } catch (e) {
              toast.error(`Dump failed: ${normalizeError(e)}`)
            }
          },
        },
        {
          label:    <MenuLabel icon={Play} text="Copy SELECT" />,
          key: 's',
          action:   () => onConsoleOpen?.({
            initialSql: `SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT 100;`,
            label: `SELECT — ${tableName}`,
            defaultDb: dbName,
          }),
        },
      ]
    }

    if (ctx.kind === 'database') {
      const { connId, dbName, nodeRef } = ctx
      const newTableTemplate =
`-- Create a new table in ${dbName}

CREATE TABLE \`new_table\` (
  \`id\`         INT(11)      NOT NULL AUTO_INCREMENT,
  \`name\`       VARCHAR(128) NOT NULL,
  \`created_at\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`
      const browseTemplate = `-- Browse ${dbName}\n\n`
      return [
        {
          label:    <MenuLabel icon={Play}       text="Browse from here" />,
          shortcut: 'B', key: 'b',
          action:   () => onConsoleOpen?.({ initialSql: browseTemplate, label: `Browse — ${dbName}`, defaultDb: dbName }),
        },
        {
          label:    <MenuLabel icon={ListChecks} text="View Tables" />,
          shortcut: 'F4', key: 'F4',
          action:   () => openDatabase({ dbName, connId }, null),
        },
        {
          label:    <MenuLabel icon={Plus}       text="Create New Table…" />,
          shortcut: 'N', key: 'n',
          action:   () => onConsoleOpen?.({ initialSql: newTableTemplate, label: `New table — ${dbName}`, defaultDb: dbName }),
        },
        { divider: true },
        {
          label:    <MenuLabel icon={RotateCw}   text="Refresh" />,
          shortcut: 'F5', key: 'F5',
          action:   () => refreshNode(nodeRef ?? {
            id: `db::${connId}::${dbName}`,
            type: 'database',
            connId, dbName, hasChildren: true,
          }, null),
        },
      ]
    }

    if (ctx.kind === 'connection' || !ctx.kind) {
      // Resolve the underlying SavedConnection so Connect can hand the
      // backend the original config to re-establish the pool.
      const conn = connections.find((c) => c.id === ctx.connId) ?? null
      const handleConnect = async () => {
        if (!conn) return
        try {
          // Use connectSaved so the backend reads credentials from the secure
          // local store — ConnectionInfo intentionally omits username/password,
          // so constructing the config object here would always send empty
          // credentials and silently fail in the driver layer.
          await connectSaved(conn.id)
          toast.success(`Connected to ${conn.name || conn.id}`)
        } catch (e) {
          // Never let a rejected Promise fall back into React state as a
          // raw object — normalize and surface via toast so the tree
          // keeps rendering.
          console.error('[explorer] connect failed:', e)
          toast.error(`Connect failed: ${normalizeError(e)}`)
        }
        onConnectionsChanged?.()
        refreshConnection(conn.id)
      }
      const handleDisconnect = async () => {
        try {
          await disconnect(ctx.connId)
          toast.success(`Disconnected`)
        } catch (e) {
          toast.error(`Disconnect failed: ${normalizeError(e)}`)
        }
        refreshNode({
          id: connNodeId(ctx.connId), type: 'connection',
          connId: ctx.connId, hasChildren: true,
        }, null)
        onConnectionsChanged?.()
      }
      return [
        { label: <MenuLabel icon={Link2}     text="Connect" />,     shortcut: 'C', key: 'c', action: handleConnect },
        { label: <MenuLabel icon={Unplug}    text="Disconnect" />,  shortcut: 'D', key: 'd', action: handleDisconnect },
        { divider: true },
        { label: <MenuLabel icon={RotateCw}  text="Refresh" />,     shortcut: 'F5', key: 'F5', action: () => refreshConnection(ctx.connId) },
        { divider: true },
        { label: <MenuLabel icon={Settings2} text="Properties…" />, shortcut: 'P', key: 'p', action: () => onPropertiesOpen?.(ctx.connId) },
      ]
    }

    return []
  }
}

// ─── SQL identifier quoting helper (module-scope) ─────────────────────────
// Mirrors the backend's quoteIdent: doubles any embedded backtick and wraps
// the result in backticks.  Defined here so context-menu builders can quote
// db / table names without importing the (frontend-private) bridge helpers.
function quoteIdent(name) {
  return '`' + String(name ?? '').replace(/`/g, '``') + '`'
}
