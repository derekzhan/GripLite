export function isNonEmptyColumnValue(value) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed !== '' && trimmed.toUpperCase() !== 'N/A'
  }
  return true
}

export function buildNonEmptyColumnSet(rows = [], columns = []) {
  const next = new Set()
  rows.forEach((row) => {
    columns.forEach((_, colIdx) => {
      if (isNonEmptyColumnValue(row?.[colIdx])) next.add(colIdx)
    })
  })
  return next
}

export function columnNameMatchesSearch(name, query) {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q) return true
  const raw = String(name ?? '').toLowerCase()
  const compact = raw.replace(/[\s_-]+/g, '')
  const qCompact = q.replace(/[\s_-]+/g, '')
  return raw.includes(q) || compact.includes(qCompact)
}

export function filterColumnPickerEntries({ columns = [], search = '', showNonEmptyOnly = false, nonEmptyColumnSet = new Set() }) {
  return columns
    .map((col, index) => ({ col, index }))
    .filter(({ col, index }) => {
      if (showNonEmptyOnly && !nonEmptyColumnSet.has(index)) return false
      return columnNameMatchesSearch(col?.name, search)
    })
}

export function hiddenColumnsForNonEmptyFilter(columns = [], nonEmptyColumnSet = new Set()) {
  const hidden = new Set()
  columns.forEach((_, index) => {
    if (!nonEmptyColumnSet.has(index)) hidden.add(index)
  })
  return hidden
}

export function selectColumnPickerEntries(hiddenCols = new Set(), entries = []) {
  const next = new Set(hiddenCols)
  entries.forEach(({ index }) => next.delete(index))
  return next
}

export function invertColumnPickerSelection(hiddenCols = new Set(), entries = []) {
  const next = new Set(hiddenCols)
  entries.forEach(({ index }) => {
    if (next.has(index)) next.delete(index)
    else next.add(index)
  })
  return next
}
