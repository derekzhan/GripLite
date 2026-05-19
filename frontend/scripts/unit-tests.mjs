import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildNonEmptyColumnSet,
  columnNameMatchesSearch,
  filterColumnPickerEntries,
  hiddenColumnsForNonEmptyFilter,
  invertColumnPickerSelection,
  selectColumnPickerEntries,
} from '../src/lib/columnPicker.js'
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
import { databaseScopeFromSelection, tablesFolderIdForScope } from '../src/lib/explorerSearch.js'
import { buildMongoCollectionFindQuery, getMongoFieldSuggestions } from '../src/lib/mongoQuery.js'
import { appendResultPage, normalizePageSize, pageSlice, shouldLoadMore } from '../src/lib/queryPaging.js'
import {
  closeAllTabsInWorkspace,
  closeTabInWorkspace,
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

function testExplorerSearchScopeUsesSelectedDatabase() {
  assert.deepEqual(
    databaseScopeFromSelection('db::conn-1::orders', [], ''),
    { connId: 'conn-1', dbName: 'orders' },
  )
  assert.deepEqual(
    databaseScopeFromSelection('folder::tables::conn-1::orders', [], ''),
    { connId: 'conn-1', dbName: 'orders' },
  )
  assert.deepEqual(
    databaseScopeFromSelection('tbl::conn-1::orders::order_items', [], ''),
    { connId: 'conn-1', dbName: 'orders' },
  )
}

function testExplorerSearchScopeFallsBackToConnectionDatabase() {
  const connections = [
    { id: 'conn-1', database: 'default_db' },
    { id: 'conn-2', database: 'other_db' },
  ]

  assert.deepEqual(
    databaseScopeFromSelection('conn::conn-2', connections, 'conn-1'),
    { connId: 'conn-2', dbName: 'other_db' },
  )
  assert.deepEqual(
    databaseScopeFromSelection('', connections, 'conn-1'),
    { connId: 'conn-1', dbName: 'default_db' },
  )
  assert.equal(tablesFolderIdForScope({ connId: 'conn-1', dbName: 'default_db' }), 'folder::tables::conn-1::default_db')
}

function testCloseCurrentWorkspaceTabActivatesNeighbor() {
  const tabs = [
    { id: 'console-1', type: 'console', label: 'SQL Console' },
    { id: 'table-1', type: 'table', label: 'users' },
    { id: 'query-1', type: 'query', label: 'Status' },
  ]

  const next = closeTabInWorkspace(tabs, 'table-1', 'table-1')

  assert.deepEqual(next.tabs.map((tab) => tab.id), ['console-1', 'query-1'])
  assert.equal(next.activeTabId, 'console-1')
}

function testCloseInactiveWorkspaceTabKeepsActiveTab() {
  const tabs = [
    { id: 'console-1', type: 'console', label: 'SQL Console' },
    { id: 'table-1', type: 'table', label: 'users' },
  ]

  const next = closeTabInWorkspace(tabs, 'console-1', 'table-1')

  assert.deepEqual(next.tabs.map((tab) => tab.id), ['console-1'])
  assert.equal(next.activeTabId, 'console-1')
}

function testCloseAllWorkspaceTabsClearsActiveTab() {
  const next = closeAllTabsInWorkspace()

  assert.deepEqual(next.tabs, [])
  assert.equal(next.activeTabId, '')
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

function testConnectionDialogHasExplicitDatabaseCreateEntries() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  assert.match(source, />\s*New MySQL\s*</)
  assert.match(source, />\s*New MongoDB\s*</)
  assert.match(source, /handleNew =/)
  assert.match(source, /handleNewMongoDB/)
}

function testMongoCollectionTextModeHidesMySQLFormatToggle() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /textFormatOptions/)
  assert.match(tableViewer, /textFormatOptions=\{isCollection \? \[\s*\{\s*id: 'json'/m)
}

function testMongoTableViewerInfersCollectionFromConnectionKind() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(app, /tableConnectionKind === 'mongodb' \? 'collection' : 'table'/)
  assert.match(app, /connectionKind=\{tableConnectionKind\}/)
  assert.match(tableViewer, /connectionKind = 'mysql'/)
  assert.match(tableViewer, /objectKind === 'collection' \|\| connectionKind === 'mongodb'/)
}

function testMongoCollectionInlineEditingUsesMongoApplier() {
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(bridge, /export async function applyMongoChanges/)
  assert.match(tableViewer, /applyChanges, applyMongoChanges/)
  assert.match(tableViewer, /const effectivePkName = isCollection \? '_id' : pkName/)
  assert.doesNotMatch(tableViewer, /editState=\{isCollection \? undefined : editState\}/)
  assert.match(tableViewer, /const result = isCollection \? await applyMongoChanges\(cs\) : await applyChanges\(cs\)/)
}

function testMongoCollectionFindQueryBuildsDatagripStyleFilterAndSort() {
  assert.equal(
    buildMongoCollectionFindQuery('prm_order', 100, 0, '{ status: "paid" }', '{ createdAt: -1 }'),
    'db.getCollection("prm_order").find({ status: "paid" }).sort({ createdAt: -1 }).limit(100)',
  )
  assert.equal(
    buildMongoCollectionFindQuery('prm_order', 100, 100, '{}', ''),
    'db.getCollection("prm_order").find({}).skip(100).limit(100)',
  )
}

function testMongoFieldSuggestionsUseCollectionFields() {
  assert.deepEqual(
    getMongoFieldSuggestions({
      value: '{tn',
      cursorPos: 3,
      columns: [{ name: 'tno', type: 'BSON' }, { name: 'tracking', type: 'BSON' }],
    }).map((s) => s.text),
    ['tno'],
  )
}

function testMongoCollectionDefaultsToGridAndLabelsRecordMode() {
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(tableViewer, /\{ id: 'grid',\s+icon: '⊞', label: 'Grid' \},\s*\{ id: 'record', icon: '▤', label: 'Record' \},\s*\{ id: 'text',\s+icon: '≡', label: 'Text' \}/m)
  assert.match(tableViewer, /\{ id: 'record', icon: '▤', label: 'Record' \}/)
  assert.match(tableViewer, /const \[viewerMode,\s+setViewerMode\]\s+= useState\('grid'\)/)
}

function testRecordViewRendersJsonValuesVisually() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /function parseDisplayJsonValue/)
  assert.match(dataViewer, /function JsonValueTree/)
  assert.match(dataViewer, /function JsonExpandableValue/)
  assert.match(dataViewer, /const \[expanded, setExpanded\] = useState\(false\)/)
  assert.match(dataViewer, /expanded \? \(\s*<JsonValueTree value=\{parsedJson\} showRootSummary=\{false\} \/>/)
  assert.match(dataViewer, /text-\[16px\]/)
  assert.match(dataViewer, /String\(value\)/)
  const jsonExpandable = dataViewer.match(/function JsonExpandableValue[\s\S]*?\n}\n\n\/\*\*/)?.[0] ?? ''
  assert.doesNotMatch(jsonExpandable, /<summary[\s\S]*String\(value\)/)
  assert.doesNotMatch(dataViewer, /parsedJson \? \(\s*<JsonValueTree value=\{parsedJson\}/)
}

function testRecordViewContextMenuSupportsDatagripActions() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /function RecordValueContextMenu/)
  assert.match(dataViewer, /label="Edit"/)
  assert.match(dataViewer, /onEdit\(cell\)/)
  assert.doesNotMatch(dataViewer, /Show Record View/)
  assert.match(dataViewer, /Open in Value Editor/)
  assert.match(dataViewer, /Set NULL/)
  assert.match(dataViewer, /Copy/)
  assert.match(dataViewer, /window\.getSelection\(\)\?\.toString\(\)/)
  assert.match(dataViewer, /editRequestKey/)
  assert.match(dataViewer, /setEditRequest\(/)
}

function testGridContextMenuSeparatesRowMarkerAndDataCell() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /onCellContextMenu/)
  assert.match(dataViewer, /localX <= ROW_MARKER_CONTEXT_WIDTH/)
  assert.match(dataViewer, /onGridCellContextMenu/)
  assert.match(dataViewer, /kind: 'cell'/)
  assert.match(dataViewer, /RecordValueContextMenu/)
}

function testColumnPickerCanSearchAndFilterNonEmptyColumns() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /columnPickerSearch/)
  assert.match(dataViewer, /showNonEmptyColumnsOnly/)
  assert.match(dataViewer, /nonEmptyColumnSet/)
  assert.match(dataViewer, /filteredColumnPickerEntries/)
  assert.match(dataViewer, /placeholder="Search columns"/)
  assert.match(dataViewer, /Only non-empty/)

  const columns = [{ name: 'name_mark' }, { name: 'empty_col' }, { name: 'blank_col' }, { name: 'missing_col' }]
  const nonEmpty = buildNonEmptyColumnSet([
    ['Receiver', '', '   ', null],
    ['', null, undefined, 'N/A'],
  ], columns)
  assert.deepEqual([...nonEmpty], [0])
  assert.equal(columnNameMatchesSearch('name_mark', 'name'), true)
  assert.deepEqual(
    filterColumnPickerEntries({
      columns,
      search: 'name',
      showNonEmptyOnly: true,
      nonEmptyColumnSet: nonEmpty,
    }).map(({ col }) => col.name),
    ['name_mark'],
  )
  assert.deepEqual([...hiddenColumnsForNonEmptyFilter(columns, nonEmpty)], [1, 2, 3])
  assert.match(dataViewer, /hiddenColumnsForNonEmptyFilter/)
  assert.match(dataViewer, /const next = hiddenColumnsForNonEmptyFilter\(columns, nonEmptyColumnSet\)/)
  assert.match(dataViewer, /showNonEmptyColumnsOnly\)\s+\{/)
  assert.doesNotMatch(dataViewer, /else\s+\{\s*setHiddenCols\(\(prev\) => \(prev\.size === 0 \? prev : new Set\(\)\)\)\s*\}/)
  assert.match(dataViewer, /setShowNonEmptyColumnsOnly\(checked\)/)
  assert.match(dataViewer, /if \(!checked\) setHiddenCols\(new Set\(\)\)/)
}

function testColumnPickerSupportsSelectAllAndInvertForFilteredEntries() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  const entries = [{ index: 1 }, { index: 3 }]
  const hidden = new Set([0, 1, 2])

  assert.deepEqual([...selectColumnPickerEntries(hidden, entries)].sort(), [0, 2])
  assert.deepEqual([...invertColumnPickerSelection(hidden, entries)].sort(), [0, 2, 3])
  assert.match(dataViewer, /Select all/)
  assert.match(dataViewer, /Invert/)
  assert.match(dataViewer, /selectColumnPickerEntries\(prev, filteredColumnPickerEntries\)/)
  assert.match(dataViewer, /invertColumnPickerSelection\(prev, filteredColumnPickerEntries\)/)
}

function testResultModeIsPreservedAcrossReloads() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  const pagedViewer = readFileSync(new URL('../src/components/PagedResultViewer.jsx', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /onModeChange/)
  assert.match(dataViewer, /setModeState\(next\)/)
  assert.match(pagedViewer, /onModeChange=\{onModeChange\}/)
  assert.match(tableViewer, /const \[viewerMode,\s+setViewerMode\]\s+= useState\('grid'\)/)
  assert.match(tableViewer, /initialMode=\{viewerMode\}/)
  assert.match(tableViewer, /onModeChange=\{setViewerMode\}/)
}

function testValuePanelToolbarUsesConsistentIcons() {
  const valuePanel = readFileSync(new URL('../src/components/ValuePanel.jsx', import.meta.url), 'utf8')
  assert.match(valuePanel, /import \{ AlignJustify, Copy, Check, CornerDownLeft, X \} from 'lucide-react'/)
  assert.match(valuePanel, /const toolbarButtonClass =/)
  assert.match(valuePanel, /<AlignJustify size=\{16\}/)
  assert.match(valuePanel, /<Copy size=\{15\}/)
  assert.match(valuePanel, /<CornerDownLeft size=\{15\}/)
}

testFilterAutocompleteUsesLateColumns()
testFilterAutocompleteFallsBackToResultColumns()
testWorkspaceSnapshotRoundTrip()
testWorkspaceStateDropsInvalidActiveTab()
testExplorerSearchScopeUsesSelectedDatabase()
testExplorerSearchScopeFallsBackToConnectionDatabase()
testCloseCurrentWorkspaceTabActivatesNeighbor()
testCloseInactiveWorkspaceTabKeepsActiveTab()
testCloseAllWorkspaceTabsClearsActiveTab()
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
testConnectionDialogHasExplicitDatabaseCreateEntries()
testMongoCollectionTextModeHidesMySQLFormatToggle()
testMongoTableViewerInfersCollectionFromConnectionKind()
testMongoCollectionInlineEditingUsesMongoApplier()
testMongoCollectionFindQueryBuildsDatagripStyleFilterAndSort()
testMongoFieldSuggestionsUseCollectionFields()
testMongoCollectionDefaultsToGridAndLabelsRecordMode()
testRecordViewRendersJsonValuesVisually()
testRecordViewContextMenuSupportsDatagripActions()
testGridContextMenuSeparatesRowMarkerAndDataCell()
testColumnPickerCanSearchAndFilterNonEmptyColumns()
testColumnPickerSupportsSelectAllAndInvertForFilteredEntries()
testResultModeIsPreservedAcrossReloads()
testValuePanelToolbarUsesConsistentIcons()

console.log('unit tests passed')
