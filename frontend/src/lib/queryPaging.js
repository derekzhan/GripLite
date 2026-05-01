export function pageSlice(rows, pageSize, currentPage) {
  if (pageSize === 'all') return rows
  const start = (currentPage - 1) * pageSize
  return rows.slice(start, start + pageSize)
}

export function appendResultPage(current, page, { offset = 0, pageSize = 200, source = null } = {}) {
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
