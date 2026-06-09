/**
 * tableUsage.js — pure helpers for the Database Explorer's "frequently-used
 * tables float to the top" ordering.
 *
 * The authoritative usage data lives in the backend SQLite file (griplite.db)
 * via the GetTableUsage / RecordTableUsage IPC calls (see lib/bridge.js), so it
 * survives app reinstalls just like saved connections and query history. The
 * functions here are intentionally storage-free and side-effect-free:
 *
 *   - bumpTableUsage   — optimistic in-memory increment for instant reordering
 *   - sortTablesByUsage — order table nodes most-used-first
 *
 * Usage map shape: { "<connId>::<dbName>::<tableName>": { count, lastUsedAt } }
 */

/** Composite key scoping usage to a single (connection, database, table). */
export function usageKey(connId, dbName, tableName) {
  return `${connId ?? ''}::${dbName ?? ''}::${tableName ?? ''}`
}

/**
 * bumpTableUsage — return a NEW usage map with the given table's open count
 * incremented and its lastUsedAt stamped. Pure: no storage, no mutation. Used
 * for the optimistic UI update so the tree reorders the instant a table opens,
 * before the backend write round-trips.
 *
 * @param {object} usage  current map
 * @param {{connId:string, dbName:string, tableName:string}} ref
 * @param {number} [now]  injectable timestamp for deterministic tests
 */
export function bumpTableUsage(usage, ref, now = Date.now()) {
  if (!ref?.tableName) return usage ?? {}
  const key = usageKey(ref.connId, ref.dbName, ref.tableName)
  const prev = usage?.[key]
  return {
    ...(usage ?? {}),
    [key]: { count: (prev?.count ?? 0) + 1, lastUsedAt: now },
  }
}

function tableLabel(node) {
  return String(node?.tableName ?? node?.label ?? node?.name ?? '')
}

/**
 * sortTablesByUsage — pin the `topN` most-used tables to the top (ordered by
 * open frequency), then list every other table in dictionary order by name.
 *
 * "Other tables" means both never-opened tables AND used tables ranked beyond
 * the top-N cut-off, so the alphabetical tail stays predictable. The `topN`
 * threshold is user-configurable (see lib/settings.js). The input array is not
 * mutated.
 *
 * Pinned ranking: higher open count wins; ties broken by more-recent use, then
 * by original order for full determinism.
 *
 * @param {Array} children  table nodes
 * @param {object} usage    "<conn>::<db>::<table>" → { count, lastUsedAt }
 * @param {number} [topN=10]  how many frequent tables to pin to the top
 */
export function sortTablesByUsage(children, usage, topN = 10) {
  if (!Array.isArray(children) || children.length === 0) return children
  const limit = Number.isFinite(topN) ? Math.max(0, Math.floor(topN)) : 0
  const stats = (node) => usage?.[usageKey(node.connId, node.dbName, node.tableName)]

  // The top-N most-used tables, ranked by frequency (then recency).
  const pinned = limit === 0 ? [] : children
    .map((node, index) => ({ node, index, s: stats(node) }))
    .filter((e) => (e.s?.count ?? 0) > 0)
    .sort((a, b) => {
      const ca = a.s.count
      const cb = b.s.count
      if (ca !== cb) return cb - ca
      const la = a.s.lastUsedAt ?? 0
      const lb = b.s.lastUsedAt ?? 0
      if (la !== lb) return lb - la
      return a.index - b.index
    })
    .slice(0, limit)
    .map((e) => e.node)

  const pinnedSet = new Set(pinned)

  // Everything else sorts alphabetically (dictionary order) by table name.
  const rest = children
    .filter((node) => !pinnedSet.has(node))
    .sort((a, b) => tableLabel(a).localeCompare(tableLabel(b), undefined, { sensitivity: 'base', numeric: true }))

  return [...pinned, ...rest]
}
