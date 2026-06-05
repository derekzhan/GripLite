export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 100000

const PAGE_SIZE_STORAGE_KEY = 'griplite_result_page_size_v1'

export function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const n = Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_PAGE_SIZE)
}

// Persist the user's preferred result fetch size so it survives reruns and
// restarts. Returns `fallback` when nothing is stored or storage is unavailable.
export function loadPreferredPageSize(fallback = DEFAULT_PAGE_SIZE) {
  try {
    const raw = localStorage.getItem(PAGE_SIZE_STORAGE_KEY)
    if (raw == null) return fallback
    return normalizePageSize(raw, fallback)
  } catch {
    return fallback
  }
}

export function savePreferredPageSize(value) {
  const n = normalizePageSize(value, DEFAULT_PAGE_SIZE)
  try {
    localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n))
  } catch { /* ignore */ }
  return n
}

export function pageSlice(rows, pageSize, currentPage) {
  if (pageSize === 'all') return rows
  const start = (currentPage - 1) * pageSize
  return rows.slice(start, start + pageSize)
}

export function appendResultPage(current, page, { offset = 0, pageSize = DEFAULT_PAGE_SIZE, source = null } = {}) {
  const isAppend = offset > 0
  const existingRows = isAppend ? (current?.rows ?? []) : []
  const rows = [...existingRows, ...(page?.rows ?? [])]
  // On append keep the first page's columns: later pages' rows are aligned to
  // that column order (this matters for schemaless results like MongoDB, where
  // each page infers its own columns).
  const columns = isAppend && current?.columns?.length
    ? current.columns
    : (page?.columns ?? current?.columns ?? [])
  return {
    ...(current ?? {}),
    ...(page ?? {}),
    columns,
    rows,
    rowCount: rows.length,
    pageSize,
    nextOffset: rows.length,
    hasMore: Boolean(page?.truncated),
    loadingMore: false,
    source: source ?? current?.source ?? null,
  }
}

export function shouldLoadMore({ lastVisibleRow, loadedRows, hasMore, loadingMore, threshold = 30 }) {
  if (!hasMore || loadingMore || loadedRows <= 0) return false
  return lastVisibleRow >= loadedRows - threshold
}
