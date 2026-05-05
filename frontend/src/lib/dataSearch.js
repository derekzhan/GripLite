export function getVisibleColumnIndices(columnCount, hiddenCols = new Set()) {
  return Array.from({ length: columnCount }, (_, i) => i)
    .filter((i) => !hiddenCols.has(i))
}

export function projectVisibleRows(rows, visibleColumnIndices) {
  return rows.map((row) => visibleColumnIndices.map((sourceCol) => row?.[sourceCol]))
}
