/**
 * Saved-console helpers — pure, storage-injectable functions used by App.jsx to
 * capture a console's live SQL and to decide whether a saved console is already
 * open. Kept free of React/DOM so they can be unit-tested in isolation.
 */

/** localStorage key under which SqlEditor persists a console tab's editor state. */
export function consoleEditorStorageKey(tabId) {
  return `griplite_sql_editor_${tabId}_v1`
}

/**
 * Read the live SQL + selected database for a console tab from the SqlEditor's
 * persisted editor state. The state shape is
 *   { tabs: [{ id, label, content }], activeTab, selectedDb }
 * and the "current" SQL is the content of the active sub-tab.
 *
 * @returns {{ sql: string, selectedDb: string }}
 */
export function readConsoleEditorContent(tabId, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(consoleEditorStorageKey(tabId))
    if (!raw) return { sql: '', selectedDb: '' }
    const parsed = JSON.parse(raw)
    const tabs = Array.isArray(parsed?.tabs) ? parsed.tabs : []
    const active = tabs.find((t) => t.id === parsed?.activeTab) ?? tabs[0] ?? null
    return {
      sql: String(active?.content ?? ''),
      selectedDb: String(parsed?.selectedDb ?? ''),
    }
  } catch {
    return { sql: '', selectedDb: '' }
  }
}

/**
 * Find an already-open console tab bound to a given saved-console id.
 * @returns the matching tab, or null.
 */
export function findOpenConsoleForSaved(tabs, savedConsoleId) {
  if (!savedConsoleId || !Array.isArray(tabs)) return null
  return tabs.find((t) => t.type === 'console' && t.savedConsoleId === savedConsoleId) ?? null
}
