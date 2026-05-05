import assert from 'node:assert/strict'

import { buildCopyDatabaseConfig, copyProgressPercent, tableNamesForCopySelection } from '../src/lib/copyData.js'
import {
  MYSQL_COLUMN_TYPE_OPTIONS,
  buildCreateDatabaseSql,
  buildCreateTableSql,
  buildDropTableSql,
  buildRenameTableSql,
} from '../src/lib/databaseTemplates.js'
import { getVisibleColumnIndices, projectVisibleRows } from '../src/lib/dataSearch.js'
import { buildFilterSuggestionColumns, getWhereFilterSuggestions } from '../src/lib/filterAutocomplete.js'
import { appendResultPage, normalizePageSize, pageSlice, shouldLoadMore } from '../src/lib/queryPaging.js'
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

function testFilterAutocompleteFallsBackToResultColumns() {
  const columns = buildFilterSuggestionColumns([], [
    { name: 'created_at', type: 'datetime' },
    { name: 'customer_id', type: 'bigint' },
  ])

  const suggestions = getWhereFilterSuggestions({
    value: 'cre',
    cursorPos: 3,
    columns,
  })

  assert.deepEqual(
    suggestions.map((s) => [s.text, s.kind]),
    [['created_at', 'column']],
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

function testNormalizePageSize() {
  assert.equal(normalizePageSize('100', 200), 100)
  assert.equal(normalizePageSize('0', 200), 200)
  assert.equal(normalizePageSize('', 200), 200)
  assert.equal(normalizePageSize('abc', 200), 200)
  assert.equal(normalizePageSize('200000', 200), 100000)
}

function testVisibleRowsPreserveSourceColumnMapping() {
  const rows = [['hidden-a', 'shown-b', 'hidden-c', '107002']]
  const hiddenCols = new Set([0, 2])

  assert.deepEqual(getVisibleColumnIndices(4, hiddenCols), [1, 3])
  assert.deepEqual(projectVisibleRows(rows, [1, 3]), [['shown-b', '107002']])
}

function testCopyDatabaseConfigDefaults() {
  const cfg = buildCopyDatabaseConfig({
    source: { connId: 'src', dbName: 'shop' },
    target: { connId: 'dst', dbName: 'shop_copy' },
  })

  assert.deepEqual(cfg, {
    sourceConnId: 'src',
    sourceDb: 'shop',
    targetConnId: 'dst',
    targetDb: 'shop_copy',
    copyStructure: true,
    copyData: true,
    dropTargetIfExists: false,
    batchSize: 1000,
    scope: 'database',
    tables: [],
  })
}

function testCopyTableSelectionExtractsNames() {
  assert.deepEqual(
    tableNamesForCopySelection([
      { name: 'users' },
      { tableName: 'orders' },
      'products',
      { name: '' },
      null,
    ]),
    ['users', 'orders', 'products'],
  )
}

function testCopyProgressPercent() {
  assert.equal(copyProgressPercent({ processedRows: 25, totalRows: 100 }), 25)
  assert.equal(copyProgressPercent({ processedRows: 150, totalRows: 100 }), 100)
  assert.equal(copyProgressPercent({ processedRows: 10, totalRows: 0 }), 0)
}

function testCreateDatabaseTemplateQuotesIdentifiers() {
  const sql = buildCreateDatabaseSql({
    databaseName: 'new`db',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
  })

  assert.equal(sql, 'CREATE DATABASE IF NOT EXISTS `new``db` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;')
}

function testCreateTableSqlBuildsColumnsAndOptions() {
  const sql = buildCreateTableSql({
    dbName: 'shop',
    tableName: 'New`Table',
    engine: 'InnoDB',
    charset: 'utf8mb4',
    collation: 'utf8mb4_general_ci',
    comment: 'demo table',
    columns: [
      { name: 'id', type: 'INT', notNull: true, autoIncrement: true, key: 'PRIMARY', comment: 'pk' },
      { name: 'name', type: 'VARCHAR(128)', notNull: true, defaultValue: "'anonymous'" },
    ],
  })

  assert.equal(sql, [
    'CREATE TABLE `shop`.`New``Table` (',
    "  `id` INT NOT NULL AUTO_INCREMENT COMMENT 'pk',",
    "  `name` VARCHAR(128) NOT NULL DEFAULT 'anonymous',",
    '  PRIMARY KEY (`id`)',
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='demo table';",
  ].join('\n'))
}

function testColumnTypeOptionsIncludeCommonMySQLTypes() {
  assert.ok(MYSQL_COLUMN_TYPE_OPTIONS.includes('INT'))
  assert.ok(MYSQL_COLUMN_TYPE_OPTIONS.includes('VARCHAR(255)'))
  assert.ok(MYSQL_COLUMN_TYPE_OPTIONS.includes('DATETIME'))
  assert.ok(MYSQL_COLUMN_TYPE_OPTIONS.includes('JSON'))
}

function testRenameAndDropTableSqlQuoteIdentifiers() {
  assert.equal(
    buildRenameTableSql({ dbName: 'shop`db', oldTableName: 'old`name', newTableName: 'new`name' }),
    'RENAME TABLE `shop``db`.`old``name` TO `shop``db`.`new``name`;',
  )
  assert.equal(
    buildDropTableSql({ dbName: 'shop`db', tableName: 'old`name' }),
    'DROP TABLE `shop``db`.`old``name`;',
  )
}

testFilterAutocompleteUsesLateColumns()
testFilterAutocompleteFallsBackToResultColumns()
testWorkspaceSnapshotRoundTrip()
testWorkspaceStateDropsInvalidActiveTab()
testPageSliceKeepsLocalPaginationOnly()
testAppendResultPagePreservesMetadata()
testNearBottomTrigger()
testNormalizePageSize()
testVisibleRowsPreserveSourceColumnMapping()
testCopyDatabaseConfigDefaults()
testCopyTableSelectionExtractsNames()
testCopyProgressPercent()
testCreateDatabaseTemplateQuotesIdentifiers()
testCreateTableSqlBuildsColumnsAndOptions()
testColumnTypeOptionsIncludeCommonMySQLTypes()
testRenameAndDropTableSqlQuoteIdentifiers()

console.log('unit tests passed')
