export const WORKSPACE_STORAGE_KEY = 'griplite_workspace_v1'

const TAB_TYPES = new Set(['console', 'table', 'dbviewer', 'query', 'rediskey', 'redisserver'])
const CONNECTION_KINDS = new Set(['mysql', 'mongodb', 'redis'])
const OBJECT_KINDS = new Set(['table', 'collection'])

function cleanConnectionFields(tab) {
  const out = {}
  if (tab.connId) out.connId = String(tab.connId)
  if (CONNECTION_KINDS.has(tab.connectionKind)) out.connectionKind = tab.connectionKind
  if (tab.connectionName) out.connectionName = String(tab.connectionName)
  return out
}

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
        ...cleanConnectionFields(tab),
        initialSql: tab.initialSql ?? undefined,
        defaultDb: tab.defaultDb ?? undefined,
      }
    case 'table':
      if (!tab.connId || !tab.dbName || !tab.tableName) return null
      return {
        ...base,
        connId: String(tab.connId),
        ...cleanConnectionFields(tab),
        dbName: String(tab.dbName),
        tableName: String(tab.tableName),
        defaultView: tab.defaultView === 'data' ? 'data' : 'properties',
        objectKind: OBJECT_KINDS.has(tab.objectKind) ? tab.objectKind : undefined,
      }
    case 'dbviewer':
      if (!tab.connId || !tab.dbName) return null
      return {
        ...base,
        connId: String(tab.connId),
        ...cleanConnectionFields(tab),
        dbName: String(tab.dbName),
      }
    case 'query':
      if (!tab.connId || !tab.sql) return null
      return {
        ...base,
        connId: String(tab.connId),
        ...cleanConnectionFields(tab),
        sql: String(tab.sql),
      }
    case 'rediskey':
      if (!tab.connId || !tab.redisKey) return null
      return {
        ...base,
        connId: String(tab.connId),
        ...cleanConnectionFields(tab),
        dbIndex: Number.isFinite(Number(tab.dbIndex)) ? Number(tab.dbIndex) : 0,
        redisKey: String(tab.redisKey),
        readOnly: !!tab.readOnly,
      }
    case 'redisserver':
      if (!tab.connId) return null
      return {
        ...base,
        connId: String(tab.connId),
        ...cleanConnectionFields(tab),
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

export function closeTabInWorkspace(tabs, activeTabId, tabId) {
  const list = Array.isArray(tabs) ? tabs : []
  const idx = list.findIndex((tab) => tab.id === tabId)
  if (idx < 0) {
    return { tabs: list, activeTabId }
  }

  const nextTabs = list.filter((tab) => tab.id !== tabId)
  const nextActiveTabId = activeTabId === tabId
    ? (nextTabs[Math.max(0, idx - 1)]?.id ?? nextTabs[0]?.id ?? '')
    : activeTabId

  return { tabs: nextTabs, activeTabId: nextActiveTabId }
}

export function closeAllTabsInWorkspace() {
  return { tabs: [], activeTabId: '' }
}
