export const WORKSPACE_STORAGE_KEY = 'griplite_workspace_v1'

const TAB_TYPES = new Set(['console', 'table', 'dbviewer', 'query'])

function cleanTab(tab) {
  if (!tab || typeof tab !== 'object') return null
  if (!TAB_TYPES.has(tab.type) || !tab.id) return null

  const base = {
    id: String(tab.id),
    type: tab.type,
    label: String(tab.label ?? tab.id),
  }

  switch (tab.type) {
    case 'console':
      return {
        ...base,
        initialSql: tab.initialSql ?? undefined,
        defaultDb: tab.defaultDb ?? undefined,
      }
    case 'table':
      if (!tab.connId || !tab.dbName || !tab.tableName) return null
      return {
        ...base,
        connId: String(tab.connId),
        dbName: String(tab.dbName),
        tableName: String(tab.tableName),
        defaultView: tab.defaultView === 'data' ? 'data' : 'properties',
      }
    case 'dbviewer':
      if (!tab.connId || !tab.dbName) return null
      return {
        ...base,
        connId: String(tab.connId),
        dbName: String(tab.dbName),
      }
    case 'query':
      if (!tab.connId || !tab.sql) return null
      return {
        ...base,
        connId: String(tab.connId),
        sql: String(tab.sql),
      }
    default:
      return null
  }
}

export function normalizeWorkspaceState(input) {
  const tabs = Array.isArray(input?.tabs)
    ? input.tabs.map(cleanTab).filter(Boolean)
    : []
  const activeTabId = tabs.some((tab) => tab.id === input?.activeTabId)
    ? input.activeTabId
    : (tabs[0]?.id ?? '')

  return {
    version: 1,
    tabs,
    activeTabId,
    activeConnId: String(input?.activeConnId ?? ''),
  }
}

export function makeWorkspaceSnapshot({ tabs, activeTabId, activeConnId }) {
  return normalizeWorkspaceState({ tabs, activeTabId, activeConnId })
}

export function loadWorkspaceState(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(WORKSPACE_STORAGE_KEY)
    if (!raw) return null
    return normalizeWorkspaceState(JSON.parse(raw))
  } catch {
    return null
  }
}

export function saveWorkspaceState(storage = globalThis.localStorage, state) {
  try {
    storage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(normalizeWorkspaceState(state)))
  } catch {
    // Local storage can be unavailable in hardened WebViews; persistence is best-effort.
  }
}

export function getNextConsoleSeqFromTabs(tabs) {
  let max = 0
  for (const tab of tabs ?? []) {
    const match = String(tab?.id ?? '').match(/^console-(\d+)$/)
    if (match) max = Math.max(max, Number(match[1]) || 0)
  }
  return max + 1
}
