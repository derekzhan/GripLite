/**
 * useEditState — diff-based cell-edit state for the data grid (Phase 6.8).
 *
 * Architecture decision:
 *   The hook NEVER copies the full row dataset into mutable state.
 *   It only tracks the *delta*:
 *     • edits       – modified cells (original rows)
 *     • addedRows   – brand-new / duplicated rows
 *     • deletedRows – row indices marked for removal
 *
 * Row indices in `edits` and `deletedRows` are relative to the `rows` array
 * that was passed on the last reset.  Added rows are appended logically
 * after the original rows (index >= rows.length).
 *
 * @param {object[]}  columns    – column metadata array ({ name, type, … })
 * @param {any[][]}   rows       – current page / result slice (read-only source)
 * @param {any}       resetKey   – when this value changes, all edits are cleared
 *                                 (pass queryResult or tableName+connId)
 * @param {object}    [opts]
 * @param {Set<string>} [opts.autoFilledColumns]
 *        Column NAMES that the database fills automatically and that
 *        Duplicate Row should leave blank (e.g. AUTO_INCREMENT primary
 *        keys, `created_at` / `updated_at` columns whose default is
 *        CURRENT_TIMESTAMP, or any column with EXTRA containing
 *        DEFAULT_GENERATED).  When omitted the hook copies every cell
 *        verbatim, which is the safe pre-Phase-21 behaviour.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'

export function useEditState(columnsArg, rowsArg, resetKey, opts = {}) {
  // Wails serialises Go nil slices as JSON `null`, not `[]`.  A DDL / DML /
  // utility statement such as `USE db`, `CREATE TABLE …`, or `SET @x = 1`
  // comes back with `columns === null` and `rows === null`, and every array
  // method in this hook must tolerate that or the whole render tree crashes
  // to a white screen.  Normalise once here so the rest of the file can
  // assume real arrays.
  const columns = Array.isArray(columnsArg) ? columnsArg : []
  const rows    = Array.isArray(rowsArg)    ? rowsArg    : []

  // Look up by column name during duplicate; we keep this stable across
  // renders so duplicateRow's useCallback identity only changes on schema
  // updates, not on every keystroke.
  const autoFilledColumns = opts.autoFilledColumns ?? null

  const autoFilledColIdxSet = useMemo(() => {
    if (!autoFilledColumns || autoFilledColumns.size === 0) return null
    const s = new Set()
    columns.forEach((c, i) => { if (autoFilledColumns.has(c.name)) s.add(i) })
    return s
  }, [columns, autoFilledColumns])

  // ── Core diff state ────────────────────────────────────────────────────
  //  edits       : { "rowIdx-colIdx" : newValue }
  //  addedRows   : Array<{ [colIdx]: value }>   (sparse object, null = empty)
  //  deletedRows : Set<number>                  (original row indices)
  const [edits,       setEdits]       = useState({})
  const [addedRows,   setAddedRows]   = useState([])
  const [deletedRows, setDeletedRows] = useState(new Set())
  const [selectedRow, setSelectedRow] = useState(null)

  // ── Reset whenever a new query result or table changes ─────────────────
  useEffect(() => {
    setEdits({})
    setAddedRows([])
    setDeletedRows(new Set())
    setSelectedRow(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  // ── Derived state ──────────────────────────────────────────────────────
  const isDirty = (
    Object.keys(edits).length > 0 ||
    addedRows.length > 0 ||
    deletedRows.size > 0
  )

  const totalDisplayRows = rows.length + addedRows.length

  // ── Helpers ────────────────────────────────────────────────────────────
  const isDeleted = useCallback(
    (row) => row < rows.length && deletedRows.has(row),
    [rows.length, deletedRows],
  )

  const isAdded = useCallback(
    (row) => row >= rows.length && row < rows.length + addedRows.length,
    [rows.length, addedRows.length],
  )

  const isEdited = useCallback(
    (col, row) => row < rows.length && (`${row}-${col}`) in edits,
    [rows.length, edits],
  )

  /**
   * getCellValue — returns the *effective* display value for a cell,
   * merging original data with the edits / addedRows overlay.
   */
  const getCellValue = useCallback(
    (col, row) => {
      if (row >= rows.length) {
        // Added row
        return addedRows[row - rows.length]?.[col] ?? null
      }
      const key = `${row}-${col}`
      return key in edits ? edits[key] : (rows[row]?.[col] ?? null)
    },
    [rows, addedRows, edits],
  )

  // ── Actions ────────────────────────────────────────────────────────────

  /** Update a single cell value. Works for both original and added rows. */
  const editCell = useCallback(
    (col, row, value) => {
      if (row >= rows.length) {
        const addedIdx = row - rows.length
        setAddedRows((prev) => {
          const next = [...prev]
          next[addedIdx] = { ...next[addedIdx], [col]: value }
          return next
        })
      } else {
        setEdits((prev) => ({ ...prev, [`${row}-${col}`]: value }))
      }
    },
    [rows.length],
  )

  /** Insert an empty row at the end of addedRows. */
  const addRow = useCallback(() => {
    setAddedRows((prev) => {
      const emptyRow = {}
      columns.forEach((_, i) => { emptyRow[i] = null })
      const next = [...prev, emptyRow]
      setSelectedRow(rows.length + next.length - 1)
      return next
    })
  }, [columns, rows.length])

  /**
   * Deep-clone the currently selected row (merging original data + edits)
   * and append it to addedRows.
   *
   * Auto-filled columns (AUTO_INCREMENT PKs, CURRENT_TIMESTAMP defaults,
   * generated columns) are intentionally left as null so the database
   * assigns fresh values on INSERT instead of receiving a duplicate that
   * would either fail uniqueness or carry stale timestamps.
   */
  const duplicateRow = useCallback(
    (rowIdx) => {
      const src = rowIdx ?? selectedRow
      if (src === null || src === undefined) return

      const copy = {}
      columns.forEach((_, col) => {
        copy[col] = autoFilledColIdxSet?.has(col)
          ? null
          : getCellValue(col, src)
      })

      setAddedRows((prev) => {
        const next = [...prev, copy]
        setSelectedRow(rows.length + next.length - 1)
        return next
      })
    },
    [columns, rows.length, selectedRow, getCellValue, autoFilledColIdxSet],
  )

  /**
   * Delete a row:
   *   - For added rows  → remove from addedRows array.
   *   - For original rows → add index to deletedRows set (shown as strikethrough).
   */
  const deleteRow = useCallback(
    (rowIdx) => {
      const target = rowIdx ?? selectedRow
      if (target === null || target === undefined) return

      if (target >= rows.length) {
        const addedIdx = target - rows.length
        setAddedRows((prev) => prev.filter((_, i) => i !== addedIdx))
        setSelectedRow(null)
      } else {
        setDeletedRows((prev) => new Set([...prev, target]))
      }
    },
    [rows.length, selectedRow],
  )

  /**
   * buildChangeSet — convert the in-memory diff (edits / addedRows /
   * deletedRows) into the ChangeSet shape expected by the Go applier.
   *
   * The caller owns the connection/database identity and the primary-key
   * column name; we only transform row indices into `{column: value}` maps.
   *
   *   { connectionId, database, tableName, primaryKey }
   *
   * Returns `null` when there are no pending mutations (isDirty == false).
   */
  const buildChangeSet = useCallback(
    ({ connectionId, database, tableName, primaryKey }) => {
      if (!isDirty) return null
      const colNames = columns.map((c) => c.name)
      const pkIdx = primaryKey ? colNames.indexOf(primaryKey) : -1

      // UPDATEs: each row must carry the PK so the WHERE clause can be built.
      // We group edits by row so a single UPDATE covers all changed columns.
      const byRow = new Map()
      for (const [key, newValue] of Object.entries(edits)) {
        const [row, col] = key.split('-').map(Number)
        if (!byRow.has(row)) byRow.set(row, {})
        byRow.get(row)[colNames[col] ?? `col_${col}`] = newValue
      }
      const editedRows = []
      for (const [row, patch] of byRow.entries()) {
        if (pkIdx >= 0 && !(primaryKey in patch)) {
          patch[primaryKey] = rows[row]?.[pkIdx] ?? null
        }
        editedRows.push(patch)
      }

      // INSERTs: translate sparse {colIdx: val} to {colName: val}, skipping
      // columns whose value is still null (MySQL will apply defaults).
      const addedRowsOut = addedRows.map((r) => {
        const out = {}
        for (const [colStr, val] of Object.entries(r)) {
          const col = Number(colStr)
          if (val === null || val === undefined || val === '') continue
          out[colNames[col] ?? `col_${col}`] = val
        }
        return out
      })

      // DELETEs: map original row index → PK value.
      const deletedIds = []
      if (pkIdx >= 0) {
        for (const row of deletedRows) {
          const pk = rows[row]?.[pkIdx]
          if (pk !== null && pk !== undefined) deletedIds.push(pk)
        }
      }

      return {
        connectionId,
        database: database ?? '',
        tableName,
        primaryKey: primaryKey ?? '',
        deletedIds,
        addedRows: addedRowsOut,
        editedRows,
      }
    },
    [isDirty, columns, rows, edits, addedRows, deletedRows],
  )

  /** Clear the in-memory diff; called after a successful ApplyChanges. */
  const clear = useCallback(() => {
    setEdits({})
    setAddedRows([])
    setDeletedRows(new Set())
    setSelectedRow(null)
  }, [])

  /**
   * cancel — alias of clear; discards all local changes and snaps the grid
   * back to the original data.
   */
  const cancel = clear

  return {
    // State (read-only)
    edits,
    addedRows,
    deletedRows,
    selectedRow,
    isDirty,
    totalDisplayRows,
    // Helpers
    isDeleted,
    isAdded,
    isEdited,
    getCellValue,
    // Actions
    editCell,
    addRow,
    duplicateRow,
    deleteRow,
    buildChangeSet,
    clear,
    cancel,
    setSelectedRow,
  }
}
