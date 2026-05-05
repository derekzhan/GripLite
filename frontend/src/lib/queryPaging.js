export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 100000

export function normalizePageSize(value, fallback = DEFAULT_PAGE_SIZE) {
  const n = Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_PAGE_SIZE)
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
