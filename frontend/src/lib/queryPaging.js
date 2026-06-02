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
  const existingRows = offset > 0 ? (current?.rows ?? []) : []
  const rows = [...existingRows, ...(page?.rows ?? [])]
  return {
    ...(current ?? {}),
    ...(page ?? {}),
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
