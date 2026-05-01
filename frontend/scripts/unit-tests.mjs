import assert from 'node:assert/strict'

import { getWhereFilterSuggestions } from '../src/lib/filterAutocomplete.js'
import { appendResultPage, pageSlice, shouldLoadMore } from '../src/lib/queryPaging.js'
import {
  getNextConsoleSeqFromTabs,
  loadWorkspaceState,
  makeWorkspaceSnapshot,
  normalizeWorkspaceState,
  saveWorkspaceState,
} from '../src/lib/workspaceState.js'

class MemoryStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed))
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null
  }
  setItem(key, value) {
    this.map.set(key, String(value))
  }
  removeItem(key) {
    this.map.delete(key)
  }
}

function testFilterAutocompleteUsesLateColumns() {
  assert.deepEqual(
    getWhereFilterSuggestions({
      value: 'sta',
      cursorPos: 3,
      columns: [],
    }),
    [],
  )

  const suggestions = getWhereFilterSuggestions({
    value: 'sta',
    cursorPos: 3,
    columns: [
      { name: 'id', type: 'int' },
      { name: 'status', type: "enum('active','inactive')" },
      { name: 'started_at', type: 'datetime' },
    ],
  })

  assert.deepEqual(
    suggestions.map((s) => [s.text, s.kind]),
    [['status', 'column'], ['started_at', 'column']],
  )
}

function testWorkspaceSnapshotRoundTrip() {
  const storage = new MemoryStorage()
  const snapshot = makeWorkspaceSnapshot({
    tabs: [
      { id: 'console-3', type: 'console', label: 'SQL Console 3', initialSql: 'select 1' },
      { id: 'table:conn:db:users', type: 'table', label: 'users', connId: 'conn', dbName: 'db', tableName: 'users', defaultView: 'data' },
    ],
    activeTabId: 'table:conn:db:users',
    activeConnId: 'conn',
  })

  saveWorkspaceState(storage, snapshot)
  assert.deepEqual(loadWorkspaceState(storage), snapshot)
  assert.equal(getNextConsoleSeqFromTabs(snapshot.tabs), 4)
}

function testWorkspaceStateDropsInvalidActiveTab() {
  const state = normalizeWorkspaceState({
    tabs: [{ id: 'console-1', type: 'console', label: 'SQL Console' }],
    activeTabId: 'missing',
    activeConnId: 'conn',
  })

  assert.equal(state.activeTabId, 'console-1')
}

function testPageSliceKeepsLocalPaginationOnly() {
  const rows = Array.from({ length: 1000 }, (_, i) => [i + 1])
  assert.deepEqual(pageSlice(rows, 200, 1)[0], [1])
  assert.deepEqual(pageSlice(rows, 200, 5)[0], [801])
  assert.equal(pageSlice(rows, 'all', 1).length, 1000)
}

function testAppendResultPagePreservesMetadata() {
  const current = {
    columns: [{ name: 'id' }],
    rows: [[1], [2]],
    source: { sql: 'select * from t', dbName: 'db', pageSize: 2 },
  }
  const next = appendResultPage(current, {
    columns: [{ name: 'id' }],
    rows: [[3], [4]],
    truncated: true,
    execMs: 4,
  }, { offset: 2, pageSize: 2 })

  assert.deepEqual(next.rows, [[1], [2], [3], [4]])
  assert.equal(next.rowCount, 4)
  assert.equal(next.hasMore, true)
  assert.deepEqual(next.source, current.source)
}

function testNearBottomTrigger() {
  assert.equal(shouldLoadMore({ lastVisibleRow: 170, loadedRows: 200, hasMore: true, loadingMore: false }), true)
  assert.equal(shouldLoadMore({ lastVisibleRow: 100, loadedRows: 200, hasMore: true, loadingMore: false }), false)
  assert.equal(shouldLoadMore({ lastVisibleRow: 199, loadedRows: 200, hasMore: true, loadingMore: true }), false)
  assert.equal(shouldLoadMore({ lastVisibleRow: 199, loadedRows: 200, hasMore: false, loadingMore: false }), false)
}

testFilterAutocompleteUsesLateColumns()
testWorkspaceSnapshotRoundTrip()
testWorkspaceStateDropsInvalidActiveTab()
testPageSliceKeepsLocalPaginationOnly()
testAppendResultPagePreservesMetadata()
testNearBottomTrigger()

console.log('unit tests passed')
