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
import { DEFAULT_MONGO_SORT, buildMongoCollectionFindQuery, getMongoFieldSuggestions, classifyMongoConsoleContext, detectMongoCollectionName, MONGO_COLLECTION_METHODS } from '../src/lib/mongoQuery.js'
import { appendResultPage, normalizePageSize, pageSlice, shouldLoadMore } from '../src/lib/queryPaging.js'
import { stripLeadingSqlComments } from '../src/lib/sqlText.js'
import { bumpTableUsage, sortTablesByUsage } from '../src/lib/tableUsage.js'
import { buildKeyTree, classifyRedisCommand, formatTTL, DECODE_FORMATS, REDIS_COMMANDS } from '../src/lib/redisClient.js'
import { loadTableUsageTopN, saveTableUsageTopN, clampTableUsageTopN } from '../src/lib/settings.js'
import { rippleGeometry } from '../src/lib/ripple.js'
import {
  loadEditorFontSize, saveEditorFontSize,
  loadUiFontSize, saveUiFontSize,
  loadEditorFontFamily, saveEditorFontFamily,
  loadUiFontFamily, saveUiFontFamily,
  loadGridFontSize, saveGridFontSize,
  loadGridFontFamily, saveGridFontFamily,
  resolveEditorFontStack, resolveUiFontStack, resolveGridFontStack,
  uiZoomForSize,
  DEFAULT_EDITOR_FONT_SIZE, DEFAULT_UI_FONT_SIZE, DEFAULT_GRID_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE, MIN_UI_FONT_SIZE, MAX_GRID_FONT_SIZE, MIN_GRID_FONT_SIZE,
  DEFAULT_EDITOR_FONT_STACK, DEFAULT_UI_FONT_STACK, DEFAULT_GRID_FONT_STACK,
} from '../src/lib/settings.js'
import {
  closeAllTabsInWorkspace,
  closeOtherTabsInWorkspace,
  closeTabInWorkspace,
  closeTabsToSideInWorkspace,
  getNextConsoleSeqFromTabs,
  loadWorkspaceState,
  makeWorkspaceSnapshot,
  normalizeWorkspaceState,
  saveWorkspaceState,
} from '../src/lib/workspaceState.js'
import {
  consoleEditorStorageKey,
  readConsoleEditorContent,
  findOpenConsoleForSaved,
} from '../src/lib/savedConsoles.js'

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
      { id: 'console-3', type: 'console', label: 'SQL Console 3', initialSql: 'select 1', connId: 'conn', connectionKind: 'mongodb' },
      { id: 'table:conn:db:users', type: 'table', label: 'users', connId: 'conn', dbName: 'db', tableName: 'users', defaultView: 'data', objectKind: 'collection', connectionKind: 'mongodb', connectionName: 'QA' },
    ],
    activeTabId: 'table:conn:db:users',
    activeConnId: 'conn',
  })

  assert.equal(snapshot.tabs[0].connId, 'conn')
  assert.equal(snapshot.tabs[0].connectionKind, 'mongodb')
  assert.equal(snapshot.tabs[1].objectKind, 'collection')
  assert.equal(snapshot.tabs[1].connectionKind, 'mongodb')
  assert.equal(snapshot.tabs[1].connectionName, 'QA')
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
  assert.deepEqual(next.removedIds, [])
}

function testCloseOtherWorkspaceTabsKeepsOnlyAnchor() {
  const tabs = [
    { id: 'console-1', type: 'console', label: 'SQL Console' },
    { id: 'table-1', type: 'table', label: 'users' },
    { id: 'query-1', type: 'query', label: 'Status' },
  ]

  const next = closeOtherTabsInWorkspace(tabs, 'table-1')

  assert.deepEqual(next.tabs.map((t) => t.id), ['table-1'])
  assert.equal(next.activeTabId, 'table-1')
  assert.deepEqual(next.removedIds.sort(), ['console-1', 'query-1'])

  // Unknown anchor is a no-op (nothing removed).
  const noop = closeOtherTabsInWorkspace(tabs, 'nope')
  assert.deepEqual(noop.tabs.map((t) => t.id), ['console-1', 'table-1', 'query-1'])
  assert.deepEqual(noop.removedIds, [])
}

function testCloseTabsToSideRemovesCorrectSide() {
  const tabs = [
    { id: 'a', type: 'console', label: 'A' },
    { id: 'b', type: 'table', label: 'B' },
    { id: 'c', type: 'query', label: 'C' },
    { id: 'd', type: 'table', label: 'D' },
  ]

  // Left of 'c' → removes a, b; keeps c, d.
  const left = closeTabsToSideInWorkspace(tabs, 'a', 'c', 'left')
  assert.deepEqual(left.tabs.map((t) => t.id), ['c', 'd'])
  assert.deepEqual(left.removedIds.sort(), ['a', 'b'])
  // Active 'a' was removed → falls back to the anchor 'c'.
  assert.equal(left.activeTabId, 'c')

  // Right of 'b' → removes c, d; keeps a, b. Active 'a' survives.
  const right = closeTabsToSideInWorkspace(tabs, 'a', 'b', 'right')
  assert.deepEqual(right.tabs.map((t) => t.id), ['a', 'b'])
  assert.deepEqual(right.removedIds.sort(), ['c', 'd'])
  assert.equal(right.activeTabId, 'a')

  // No tabs on the requested side → no-op.
  const none = closeTabsToSideInWorkspace(tabs, 'a', 'a', 'left')
  assert.deepEqual(none.tabs.map((t) => t.id), ['a', 'b', 'c', 'd'])
  assert.deepEqual(none.removedIds, [])
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

function testAppendResultPageKeepsFirstPageColumns() {
  // Schemaless results (MongoDB) infer columns per page; appending must keep
  // the first page's column order so later rows stay aligned.
  const current = {
    columns: [{ name: '_id' }, { name: 'a' }],
    rows: [['1', 'x']],
    source: { sql: 'db.t.find({})', pageSize: 1 },
  }
  const next = appendResultPage(current, {
    columns: [{ name: '_id' }, { name: 'b' }],
    rows: [['2', 'y']],
    truncated: false,
  }, { offset: 1, pageSize: 1 })
  assert.deepEqual(next.columns, current.columns)
  assert.deepEqual(next.rows, [['1', 'x'], ['2', 'y']])

  // The first page (offset 0) still adopts the incoming page's columns.
  const first = appendResultPage(null, {
    columns: [{ name: '_id' }],
    rows: [['1']],
    truncated: true,
  }, { offset: 0, pageSize: 1 })
  assert.deepEqual(first.columns, [{ name: '_id' }])
}

function testMongoFindQueriesArePageable() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  // A mongo console uses isPageableMongo (find-only) instead of isPageableSql.
  assert.match(app, /function isPageableMongo\(sql\)/)
  assert.ok(app.includes('/\\.find\\s*\\(/.test(trimmed)'))
  assert.match(app, /const isMongoConsole = consoleTab\?\.connectionKind === 'mongodb'/)
  assert.match(app, /isMongoConsole \? isPageableMongo\(sql\) : isPageableSql\(sql\)/)

  // The backend exposes mongo paging through the PagedQueryDriver interface.
  const appGo = readFileSync(new URL('../../app.go', import.meta.url), 'utf8')
  assert.match(appGo, /driver\.PagedQueryDriver/)
  assert.match(appGo, /ExecutePagedQueryOnDB\(cancelCtx, dbName, sqlText/)
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
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(source, /title="New MySQL connection"/)
  assert.match(source, /title="New MongoDB connection"/)
  assert.match(source, /connections: externalConnections = \[\]/)
  assert.match(source, /const \[deletedIds,\s+setDeletedIds\]\s+= useState\(\(\) => new Set\(\)\)/)
  assert.match(source, /const visibleConnections = useMemo\([\s\S]*\(savedList\.length > 0 \? savedList : externalConnections\)\.filter/)
  assert.match(app, /connections=\{connections\}/)
  assert.match(source, /aria-label=\{title\}/)
  assert.match(source, /<Database size=\{14\}/)
  assert.match(source, /<Leaf size=\{14\}/)
  assert.doesNotMatch(source, />\s*New MySQL\s*</)
  assert.doesNotMatch(source, />\s*New MongoDB\s*</)
  assert.doesNotMatch(source, />🔌</)
  assert.match(source, /text-fg-on-accent/)
  assert.match(explorer, /Leaf/)
  assert.match(explorer, /type === 'connection' && kind === 'mongodb'/)
  assert.match(explorer, /<TreeIcon type="connection" kind=\{conn\.kind\}/)
  assert.doesNotMatch(explorer, /Cmp = Plug/)
  assert.match(source, /handleNew =/)
  assert.match(source, /handleNewMongoDB/)
}

function testConnectionDialogDeleteUpdatesVisibleListAndParent() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const handleDelete = source.match(/const handleDelete = (?:async )?\(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  const confirmDelete = source.match(/const confirmDelete = async \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  const handleDialogDeleted = app.match(/const handleDialogDeleted = useCallback\(\(connId\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/)?.[0] ?? ''
  assert.match(source, /deleteConfirmId/)
  assert.match(source, /isDeleting/)
  assert.match(confirmDelete, /await deleteSavedConnection\(id\)/)
  assert.doesNotMatch(confirmDelete, /handleNew\(\)/)
  assert.match(confirmDelete, /onClose\(\)/)
  assert.doesNotMatch(source, /window\.confirm/)
  assert.match(handleDelete, /const id = selectedId/)
  assert.match(handleDelete, /setDeleteConfirmId\(id\)/)
  assert.match(source, /setDeletedIds\(\(prev\) => new Set\(\[\.\.\.prev, id\]\)\)/)
  assert.match(source, /setSavedList\(\(prev\) => prev\.filter\(\(conn\) => conn\.id !== id\)\)/)
  assert.match(source, /onDeleted\?\.\(id\)/)
  assert.match(app, /onDeleted=\{handleDialogDeleted\}/)
  assert.match(handleDialogDeleted, /const next = prev\.filter\(\(conn\) => conn\.id !== connId\)/)
  assert.match(handleDialogDeleted, /return next/)
  assert.match(handleDialogDeleted, /reloadConnections\(\)/)
  assert.match(source, /setDeletedIds\(\(prev\) => \{/)
  assert.match(source, /role="dialog"/)
  assert.match(source, /Delete data source\?/)
  assert.doesNotMatch(source, /m-2 rounded-md border border-danger\/30/)
}

function testConnectionDialogOkDoesNotSavePristineBlankConnection() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  const handleOK = source.match(/const handleOK = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.match(handleOK, /if \(!selectedId && !isDirty\) \{/)
  assert.match(handleOK, /onClose\(\)/)
  assert.match(handleOK, /return/)
  assert.match(handleOK, /saveConnection\(payload\)/)
}

function testConnectionDialogSupportsDuplicate() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  const handleDuplicate = source.match(/const handleDuplicate = \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  // Clone the current form into a fresh, unsaved, dirty connection.
  assert.match(handleDuplicate, /if \(!selectedId\) return/)
  assert.match(handleDuplicate, /id:\s*crypto\.randomUUID\(\)/)
  assert.match(handleDuplicate, /name: `\$\{source\.name \|\| 'Connection'\} copy`/)
  // The clone is optimistically inserted into the list and becomes selected.
  assert.match(handleDuplicate, /setSavedList\(\(\) => \{/)
  assert.match(handleDuplicate, /\.splice\(idx === -1 \? next\.length : idx \+ 1, 0, dup\)/)
  assert.match(handleDuplicate, /setSelectedId\(dup\.id\)/)
  assert.match(handleDuplicate, /setIsDirty\(true\)/)
  // A toolbar button exposes it, enabled only when a connection is selected.
  assert.match(source, /onClick=\{handleDuplicate\}/)
  assert.match(source, /title="Duplicate selected"/)
}

function testConnectionDialogSupportsCustomColorPicker() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../../app.go', import.meta.url), 'utf8')
  assert.match(source, /useRef/)
  assert.match(source, /customColorInputRef/)
  assert.match(source, /type="color"/)
  assert.match(source, /pickColor\(form\.color \|\| '#3b82f6'\)/)
  assert.match(source, /customColorInputRef\.current\?\.click\(\)/)
  assert.match(source, /title="Custom color"/)
  assert.match(source, /relative flex h-5 w-5 items-center justify-center/)
  assert.match(bridge, /export async function pickColor/)
  assert.match(bridge, /PickColor\(initialColor\)/)
  assert.match(app, /func \(a \*App\) PickColor\(initialColor string\) \(string, error\)/)
  assert.match(app, /choose color default color/)
  assert.match(source, /onChange=\{\(e\) => setForm\(f => \(\{ \.\.\.f, color: e\.target\.value \}\)\)\}/)
  assert.doesNotMatch(source, /showCustomColorPalette/)
  assert.doesNotMatch(source, /CUSTOM_COLOR_SWATCHES/)
}

function testDatabaseExplorerDoesNotExposeConnectionGroups() {
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')

  assert.match(explorer, /\bPlug\b/)
  assert.doesNotMatch(bridge, /export async function listConnectionGroups/)
  assert.doesNotMatch(bridge, /export async function createConnectionGroup/)
  assert.doesNotMatch(bridge, /export async function renameConnectionGroup/)
  assert.doesNotMatch(bridge, /export async function deleteConnectionGroup/)
  assert.doesNotMatch(bridge, /export async function moveConnectionToGroup/)
  assert.doesNotMatch(explorer, /ConnectionGroupActionModal/)
  assert.doesNotMatch(explorer, /New Group/)
  assert.doesNotMatch(explorer, /Rename Group/)
  assert.doesNotMatch(explorer, /Delete Group/)
  assert.doesNotMatch(explorer, /kind: 'blank'/)
  assert.doesNotMatch(explorer, /handleConnectionDrop/)
  assert.doesNotMatch(explorer, /moveConnectionToGroup/)
}

function testConnectionDialogSelectionAndSaveAreResponsive() {
  const source = readFileSync(new URL('../src/components/ConnectionDialog.jsx', import.meta.url), 'utf8')
  const handleOK = source.match(/const handleOK = (?:async )?\(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''
  const handleSave = source.match(/const handleSave = async \(\) => \{[\s\S]*?\n  \}/)?.[0] ?? ''

  assert.match(source, /selectionRequestRef/)
  assert.match(source, /isOpenRef/)
  assert.match(source, /const requestId = \+\+selectionRequestRef\.current/)
  assert.match(source, /const fallback = visibleConnections\.find\(\(conn\) => conn\.id === id\) \?\? null/)
  assert.match(source, /if \(fallback\) applyConnectionForm\(fallback, \{ dirty: false \}\)/)
  assert.match(source, /if \(requestId !== selectionRequestRef\.current \|\| !isOpenRef\.current\) return/)
  assert.doesNotMatch(handleOK, /connectSaved/)
  assert.doesNotMatch(handleOK, /await saveConnection/)
  assert.match(handleOK, /const payload = \{ \.\.\.form \}/)
  assert.match(handleOK, /const savePromise = saveConnection\(payload\)/)
  assert.match(handleOK, /onClose\(\)/)
  assert.doesNotMatch(handleSave, /await loadList\(\)/)
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
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  assert.match(app, /tableConnectionKind === 'mongodb' \? 'collection' : 'table'/)
  assert.match(app, /connectionKind=\{tableConnectionKind\}/)
  assert.match(tableViewer, /connectionKind = 'mysql'/)
  assert.match(tableViewer, /objectKind === 'collection' \|\| connectionKind === 'mongodb'/)
  assert.match(explorer, /function groupsForConnectionKind/)
  assert.match(explorer, /kind === 'mongodb' \? CONN_GROUPS\.filter\(\(g\) => g\.kind === 'databases'\) : CONN_GROUPS/)
  assert.match(explorer, /groupsForConnectionKind\(connectionKind\)/)
  assert.match(explorer, /function databaseFoldersForConnectionKind/)
  assert.match(explorer, /kind === 'mongodb' \? DATABASE_FOLDERS\.filter\(\(f\) => f\.kind === 'tables'\) : DATABASE_FOLDERS/)
  assert.match(explorer, /const connectionKind = node\.kind \?\? connectionKindByIdRef\.current\.get\(connId\) \?\? 'mysql'/)
  assert.match(explorer, /const connectionKind = node\.connectionKind \?\? connectionKindByIdRef\.current\.get\(connId\) \?\? 'mysql'/)
  assert.match(explorer, /connectionKind, hasChildren: true/)
  assert.match(explorer, /kind: conn\.kind/)
  assert.match(explorer, /databaseFoldersForConnectionKind\(connectionKind\)/)
}

function testTableTabsAndBreadcrumbIncludeConnectionName() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(app, /const tableConnectionName =/)
  assert.match(app, /label: buildTableTabLabel\(tableConnectionName, dbName, tableName\)/)
  assert.match(app, /connectionName=\{tableConnectionName\}/)
  assert.match(app, /📋 \{activeTab\.connectionName \? `\$\{activeTab\.connectionName\} \/ ` : ''\}\{activeTab\.dbName\}\.\{activeTab\.tableName\}/)
  assert.match(tableViewer, /connectionName = ''/)
  assert.match(tableViewer, /connectionName && \(\s*<>\s*<span className="text-syntax-keyword">\{connectionName\}<\/span>/)
}

function testTabBarScrollsActiveTabAndShowsDriverIcons() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /import \{ Database, Leaf, Zap \} from 'lucide-react'/)
  assert.match(app, /\bconnectionKind,\s*\n/)
  assert.match(app, /connectionKindById=\{connectionKindById\}/)
  assert.match(app, /const activeTabRef = useRef\(null\)/)
  assert.match(app, /activeTabRef\.current\?\.scrollIntoView\(\{\s*block: 'nearest',\s*inline: 'end'/m)
  assert.match(app, /ref=\{active \? activeTabRef : null\}/)
  assert.match(app, /data-tab-id=\{tab\.id\}/)
  assert.match(app, /function TabIcon/)
  assert.match(app, /kind === 'mongodb'/)
  assert.match(app, /return <Leaf/)
  assert.match(app, /return <Database/)
}

function testTabsUseBoundedKeepAliveMounting() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /const MAX_MOUNTED_TABS = \d+/)
  assert.match(app, /const \[mountedTabIds, setMountedTabIds\] = useState/)
  assert.match(app, /next\.slice\(-MAX_MOUNTED_TABS\)/)
  assert.match(app, /const shouldMountTab = useCallback/)
  assert.match(app, /tabs\.filter\(\(t\) => t\.type === 'console' && shouldMountTab\(t\.id\)\)/)
  assert.match(app, /tabs\.filter\(\(t\) => t\.type === 'table' && shouldMountTab\(t\.id\)\)/)
  assert.match(app, /tabs\.filter\(\(t\) => t\.type === 'query' && shouldMountTab\(t\.id\)\)/)
  assert.match(app, /tabs\.filter\(\(t\) => t\.type === 'dbviewer' && shouldMountTab\(t\.id\)\)/)
}

function testConsoleQueriesUseTabScopedQueryIds() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')
  const sqlEditor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')

  assert.match(app, /import \{ stripLeadingSqlComments \} from '\.\/lib\/sqlText'/)
  assert.match(app, /const executable = stripLeadingSqlComments\(trimmed\)/)
  assert.match(app, /return \/\^\(select\|with\)\\b\/i\.test\(executable\)/)
  assert.match(bridge, /export async function runQuery\(connectionID, dbName, sql, queryID = ''\)/)
  assert.match(bridge, /RunQueryWithID\(queryID, connectionID, dbName \?\? '', sql\)/)
  assert.match(bridge, /export async function cancelQuery\(queryID\)/)
  assert.match(app, /const queryConnId = consoleTab\?\.connId \?\? connIdRef\.current/)
  assert.match(app, /runQuery\(queryConnId, opts\.dbName \?\? '', sql, tabId\)/)
  assert.match(app, /runQueryPage\(queryConnId, opts\.dbName \?\? '', sql, 0, preferredPageSizeRef\.current, tabId\)/)
  assert.match(app, /queryId=\{tab\.id\}/)
  assert.match(sqlEditor, /queryId/)
  assert.match(sqlEditor, /cancelQuery\(queryId \|\| connectionId\)/)
}

function testSqlCommentStrippingKeepsCommentedSelectEditable() {
  const resultPanel = readFileSync(new URL('../src/components/ResultPanel.jsx', import.meta.url), 'utf8')
  assert.equal(
    stripLeadingSqlComments('-- GripLite SQL Console\n-- Tip\n\nselect * from uni_config where id = 340'),
    'select * from uni_config where id = 340',
  )
  assert.equal(
    stripLeadingSqlComments('/* heading */\nWITH cte AS (SELECT 1) SELECT * FROM cte'),
    'WITH cte AS (SELECT 1) SELECT * FROM cte',
  )
  assert.match(resultPanel, /import \{ stripLeadingSqlComments \} from '\.\.\/lib\/sqlText'/)
  assert.match(resultPanel, /const text = stripLeadingSqlComments\(sql\)\.replace\(/)
}

function testNewConsoleInheritsActiveDatabaseContext() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  assert.match(app, /function defaultDatabaseForNewConsole\(tab, fallbackDb = ''\)/)
  assert.match(app, /if \(tab\?\.type === 'table' \|\| tab\?\.type === 'dbviewer'\) return tab\.dbName \?\? fallbackDb/)
  assert.match(app, /const effectiveConnId = opts\?\.connId \?\? activeTab\?\.connId \?\? connIdRef\.current/)
  assert.match(app, /const defaultDb = opts\?\.defaultDb \?\? defaultDatabaseForNewConsole\(activeTab, connInfo\?\.database \?\? ''\)/)
  assert.match(app, /tab\.defaultDb = defaultDb/)
  assert.match(app, /const consoleConnId = tab\.connId \?\? connIdRef\.current/)
  assert.match(app, /connectionId=\{consoleConnId\}/)
  assert.match(app, /defaultDb=\{tab\.defaultDb \?\? consoleConnInfo\?\.database \?\? ''\}/)

  // The explorer must pass the RIGHT-CLICKED connection (not just the db) when
  // opening a console; otherwise handleNewConsole falls back to the previously
  // active console's connId.
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  assert.match(explorer, /initialSql: browseTemplate, label: `Browse — \$\{dbName\}`, connId, defaultDb: dbName/)
  assert.match(explorer, /label: `SELECT — \$\{tableName\}`,\s*connId,\s*defaultDb: dbName/)
}

function testSqlConsoleResultEditsCanBeSavedForSimpleSelects() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const resultPanel = readFileSync(new URL('../src/components/ResultPanel.jsx', import.meta.url), 'utf8')

  assert.match(app, /source: \{ sql, dbName: opts\.dbName \?\? '', connId: queryConnId, pageSize \}/)
  assert.match(app, /connectionId=\{activeResult\?\.queryResult\?\.source\?\.connId \?\? consoleConnId\}/)
  assert.match(resultPanel, /import \{ applyChanges \} from '\.\.\/lib\/bridge'/)
  assert.match(resultPanel, /function inferSimpleSelectTarget\(sql, columns, fallbackDb = ''\)/)
  assert.match(resultPanel, /const activeResultSql = activeResultEntry\?\.sql \?\? ''/)
  assert.match(resultPanel, /queryResult\?\.source\?\.sql \?\? activeResultSql/)
  assert.match(resultPanel, /const canSaveQueryEdits = !!queryEditTarget && !!connectionId/)
  assert.match(resultPanel, /const handleSaveQueryEdits = useCallback\(async \(\) =>/)
  assert.match(resultPanel, /editState\.buildChangeSet\(\{\s*connectionId,\s*database: queryEditTarget\.dbName,\s*tableName: queryEditTarget\.tableName,\s*primaryKey: queryEditTarget\.primaryKey,/m)
  assert.match(resultPanel, /const result = await applyChanges\(changeSet\)/)
  assert.match(resultPanel, /onSave=\{canSaveQueryEdits \? handleSaveQueryEdits : undefined\}/)
}

function testResultPanelPreservesValuePanelOpenStateAcrossRuns() {
  const resultPanel = readFileSync(new URL('../src/components/ResultPanel.jsx', import.meta.url), 'utf8')
  const pagedViewer = readFileSync(new URL('../src/components/PagedResultViewer.jsx', import.meta.url), 'utf8')
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')

  assert.match(resultPanel, /const activeResultPanelKey = String\(Math\.max\(activeResultIndex, 0\)\)/)
  assert.match(resultPanel, /const \[valuePanelStateByResult, setValuePanelStateByResult\] = useState\(\{\}\)/)
  assert.match(resultPanel, /const valuePanelState = valuePanelStateByResult\[activeResultPanelKey\] \?\? \{\}/)
  assert.match(resultPanel, /valuePanelOpen=\{!!valuePanelState\.open\}/)
  assert.match(resultPanel, /onValuePanelOpenChange=\{setActiveValuePanelOpen\}/)
  assert.match(resultPanel, /valuePanelCell=\{valuePanelState\.cell \?\? null\}/)
  assert.match(resultPanel, /onValuePanelCellChange=\{setActiveValuePanelCell\}/)
  assert.match(resultPanel, /\[activeResultPanelKey\]: \{ \.\.\.prev\[activeResultPanelKey\], open \}/)
  assert.match(resultPanel, /\[activeResultPanelKey\]: \{ \.\.\.prev\[activeResultPanelKey\], cell \}/)
  assert.match(pagedViewer, /valuePanelOpen/)
  assert.match(pagedViewer, /onValuePanelOpenChange/)
  assert.match(pagedViewer, /valuePanelCell/)
  assert.match(pagedViewer, /onValuePanelCellChange/)
  assert.match(dataViewer, /valuePanelOpen,\s+onValuePanelOpenChange,/)
  assert.match(dataViewer, /valuePanelCell,\s+onValuePanelCellChange,/)
  assert.match(dataViewer, /const isPanelOpenControlled = typeof valuePanelOpen === 'boolean'/)
  assert.match(dataViewer, /const panelOpen = isPanelOpenControlled \? valuePanelOpen : internalPanelOpen/)
  assert.match(dataViewer, /onValuePanelOpenChange\?\.\(resolved\)/)
  assert.match(dataViewer, /const displayColByName = columns\.findIndex\(\(col\) => col\?\.name === cell\?\.colName\)/)
  assert.match(dataViewer, /const panelCell = isPanelCellControlled \? \(valuePanelCell \?\? defaultPanelCell\) : internalPanelCell/)
  assert.match(dataViewer, /onValuePanelCellChange\?\.\(resolved\)/)
}

function testRecordViewSupportsCtrlFHighlightSearch() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  // A reusable highlighter wraps matches in <mark>.
  assert.match(dataViewer, /function HighlightedText/)
  assert.match(dataViewer, /<mark/)
  // Ctrl/Cmd+F opens the in-record search.
  assert.match(dataViewer, /\(e\.metaKey \|\| e\.ctrlKey\) && \(e\.key === 'f' \|\| e\.key === 'F'\)/)
  // Matches cover both field names and values.
  assert.match(dataViewer, /searchRe\.test\(name\)/)
  assert.match(dataViewer, /recordValueSearchText\(row\[i\]\)/)
  // Highlight props are threaded into both readonly and editable value cells.
  assert.match(dataViewer, /<ReadonlyRecordValue value=\{val\} searchRe=\{searchRe\} searchActive=\{valueActive\} \/>/)
  assert.match(dataViewer, /<HighlightedText text=\{col\.name\} re=\{searchRe\} active=\{fieldActive\} \/>/)
}

function testMongoCollectionExpandsIntoFieldsAndIndexes() {
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  // A collection (kind === 'collection') expands into two sub-folders.
  assert.match(explorer, /type === 'table' && node\.kind === 'collection'/)
  assert.match(explorer, /folderKind: 'fields', label: 'fields', count: fieldCount/)
  assert.match(explorer, /folderKind: 'indexes', label: 'indexes', count: indexCount/)
  // Each sub-folder lazy-loads its own contents.
  assert.match(explorer, /type === 'collfolder' && node\.folderKind === 'fields'/)
  assert.match(explorer, /type === 'collfolder' && node\.folderKind === 'indexes'/)
  // Indexes come from the live advanced-properties call and render their keys.
  assert.match(explorer, /getTableAdvancedProperties/)
  assert.match(explorer, /type: 'index', label: ix\.name/)
  assert.match(explorer, /\(\$\{ix\.columns\.join\(', '\)\}\)/)
}

function testIndexNodeContextMenuSupportsDelete() {
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  // Right-clicking an index node opens a dedicated context menu.
  assert.match(explorer, /node\.type === 'index'/)
  assert.match(explorer, /kind:\s*'index'/)
  // The menu offers a Delete action that stages the index for confirmation.
  assert.match(explorer, /ctx\.kind === 'index'/)
  assert.match(explorer, /text="Delete Index\.\.\."/)
  assert.match(explorer, /setIndexAction\(\{ connId, dbName, tableName, indexName/)
  // Confirming drops the index via the shell dropIndex command and refreshes.
  assert.match(explorer, /dropIndex\(\$\{JSON\.stringify\(indexName\)\}\)/)
  assert.match(explorer, /folderKind: 'indexes', label: 'indexes'/)
  // The confirmation modal is wired up.
  assert.match(explorer, /<IndexActionModal/)
  assert.match(explorer, /onConfirm=\{handleDropIndex\}/)

  const modal = readFileSync(new URL('../src/components/IndexActionModal.jsx', import.meta.url), 'utf8')
  // The dialog is a yes/no destructive confirmation.
  assert.match(modal, /Delete index/)
  assert.match(modal, /'Deleting\.\.\.' : 'Yes'/)
  assert.match(modal, /^\s*No\s*$/m)
}

function testIndexesFolderContextMenuSupportsAddIndex() {
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  // Right-clicking the `indexes` sub-folder opens an "Add Index" menu.
  assert.match(explorer, /node\.type === 'collfolder' && node\.folderKind === 'indexes'/)
  assert.match(explorer, /kind:\s*'indexes-folder'/)
  assert.match(explorer, /ctx\.kind === 'indexes-folder'/)
  assert.match(explorer, /text="Add Index\.\.\."/)
  assert.match(explorer, /setCreateIndexTarget\(\{ connId, dbName, tableName \}\)/)
  // Confirming builds an ordered createIndex shell command (compound-safe) and
  // forwards unique + name options.
  assert.match(explorer, /createIndex\(\{ \$\{keySpec\} \}/)
  assert.match(explorer, /\$\{JSON\.stringify\(k\.name\)\}: \$\{k\.dir\}/)
  assert.match(explorer, /opts\.push\('unique: true'\)/)
  assert.match(explorer, /<CreateIndexModal/)
  assert.match(explorer, /onConfirm=\{handleCreateIndex\}/)

  const modal = readFileSync(new URL('../src/components/CreateIndexModal.jsx', import.meta.url), 'utf8')
  // The dialog loads collection fields and lets the user order compound keys
  // with per-key direction toggles + a unique option.
  assert.match(modal, /getTableSchema\(target\.connId, target\.dbName, target\.tableName\)/)
  assert.match(modal, /\[\.\.\.prev, \{ name: fieldName, dir: 1 \}\]/)
  assert.match(modal, /onConfirm\?\.\(\{ keys, unique, name: name\.trim\(\) \}\)/)
  assert.match(modal, /setDir\(k\.name, 1\)/)
  assert.match(modal, /setDir\(k\.name, -1\)/)
  assert.match(modal, /^\s*ASC\s*$/m)
  assert.match(modal, /^\s*DESC\s*$/m)
}

function testGridAndTextModesSupportHighlightSearch() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  // A shared helper builds highlighted nodes and marks the current match.
  assert.match(dataViewer, /function buildHighlightNodes/)
  // Text mode renders highlighted nodes and opens search on Ctrl/Cmd+F.
  assert.match(dataViewer, /placeholder="Find in text"/)
  assert.match(dataViewer, /<pre[^>]*>\s*\{nodes\}\s*<\/pre>/)
  // Grid mode has its OWN Ctrl/Cmd+F find overlay — independent of the toolbar
  // value-filter box.
  assert.match(dataViewer, /placeholder="Find in grid"/)
  assert.match(dataViewer, /if \(!isFind \|\| mode !== 'grid'\) return/)
  assert.match(dataViewer, /setGridFindOpen\(true\)/)
  // The grid find searches both field names (headers) and value cells.
  assert.match(dataViewer, /out\.push\(\{ kind: 'header', col: c \}\)/)
  assert.match(dataViewer, /out\.push\(\{ kind: 'cell', row: r, col: c \}\)/)
  // Matching headers are highlighted, with the current header emphasised.
  assert.match(dataViewer, /const headerMatch = searchHeaderCols\?\.has\(i\)/)
  assert.match(dataViewer, /const isCurrentHeader = currentHeaderCol === i/)
  // The grid find drives the canvas highlight (not the toolbar box).
  assert.match(dataViewer, /searchMatchCells=\{gridFindOpen \? gridFindMatchCells : searchMatchCells\}/)
  assert.match(dataViewer, /searchHeaderCols=\{gridFindOpen \? gridFindHeaderCols : null\}/)
}

function testColumnSuggestionsAreScopedToReferencedTables() {
  const sqlEditor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')
  // A helper extracts the tables referenced in FROM/JOIN clauses.
  assert.match(sqlEditor, /function extractReferencedTables/)
  // The general completion path computes referenced tables for the current
  // statement.
  assert.match(sqlEditor, /const referencedTables = extractReferencedTables/)
  assert.match(sqlEditor, /referencedTables\.length > 0/)
  // Columns are fetched per referenced table (so a global LIMIT can't crowd
  // out the typed column) and filtered by the typed prefix.
  assert.match(sqlEditor, /referencedTables\.map\(\(t\) =>/)
  assert.match(sqlEditor, /it\.label\.toLowerCase\(\)\.startsWith\(kwLower\)/)
  // Columns rank ahead of table names when tables are referenced.
  assert.match(sqlEditor, /const colRank\s+= referencedTables\.length > 0 \? '0' : '1'/)
  assert.match(sqlEditor, /const tableRank = referencedTables\.length > 0 \? '2' : '0'/)
  // Table suggestions only appear where a table name is expected (after
  // FROM/JOIN/etc.) — not in the SELECT projection / WHERE clause.
  assert.match(sqlEditor, /const expectingTable = .*FROM\|JOIN\|UPDATE\|INTO\|TABLE/)
  assert.match(sqlEditor, /const showTables = expectingTable \|\| referencedTables\.length === 0/)
}

// Multi-table FROM lists with aliases (`FROM a x, b`) must still scope columns
// to every table and keep table completion active for the trailing table.
// Regression for: second table in `from a i, <cursor>` got no suggestions.
function testMultiTableFromWithAliasesIsRecognised() {
  const sqlEditor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')

  // Pull the real FROM-parsing helpers out of the source and execute them so
  // the test exercises the shipped code, not a copy.  resolveTableAlias and
  // extractReferencedTables both delegate to extractTableRefs, so all three
  // are evaluated together.
  const boundary = sqlEditor.match(/const FROM_LIST_BOUNDARY = '[^']+'/)
  const refsSrc  = sqlEditor.match(/function extractTableRefs\(sql\) \{[\s\S]*?\n\}/)
  const aliasSrc = sqlEditor.match(/function resolveTableAlias\(sql, alias\) \{[\s\S]*?\n\}/)
  const tablesSrc = sqlEditor.match(/function extractReferencedTables\(sql\) \{[\s\S]*?\n\}/)
  assert.ok(boundary && refsSrc && aliasSrc && tablesSrc, 'FROM helpers not found')
  const { resolveTableAlias, extractReferencedTables } = new Function(
    `${boundary[0]}\n${refsSrc[0]}\n${aliasSrc[0]}\n${tablesSrc[0]}\n` +
    'return { resolveTableAlias, extractReferencedTables }',
  )()

  // Pull the real expectingTable regex literal out of the source.
  const reLit = sqlEditor.match(/const expectingTable = (\/.*\/i)\.test\(textUntilCursor\)/)
  assert.ok(reLit, 'expectingTable regex not found')
  // eslint-disable-next-line no-new-func
  const expectingTableRe = new Function(`return ${reLit[1]}`)()
  const expectingTable = (t) => expectingTableRe.test(t)

  // The reported case: typing the 2nd table after an aliased 1st table.
  assert.deepEqual(
    extractReferencedTables('select * from ecs_order_info i, uni_tracking_info'),
    ['ecs_order_info', 'uni_tracking_info'],
  )
  assert.equal(expectingTable('select * from ecs_order_info i, uni_tracking_info'), true)

  // Right after the comma (no table typed yet) tables are still offered.
  assert.equal(expectingTable('select * from ecs_order_info i, '), true)

  // Aliases with AS, db-qualified names and JOINs all resolve to table names.
  assert.deepEqual(
    extractReferencedTables('select * from `db`.uni_tracking_spath s, orders o'),
    ['uni_tracking_spath', 'orders'],
  )
  assert.deepEqual(
    extractReferencedTables('select * from a JOIN b ON a.x = b.y'),
    ['a', 'b'],
  )

  // In the WHERE clause / while typing an alias we want columns, not tables.
  assert.equal(expectingTable('select * from a x, b y where '), false)
  assert.equal(expectingTable('select * from ecs_order_info i'), false)

  // `alias.column` completion must resolve the alias of ANY table in the list,
  // including the 2nd table declared with AS (the reported screenshot case).
  const multi = 'select i.order_id as oid, a. from ecs_order_info i , uni_tracking_info as a where i.order_id = a.order_id limit 10'
  assert.equal(resolveTableAlias(multi, 'a'), 'uni_tracking_info')
  assert.equal(resolveTableAlias(multi, 'i'), 'ecs_order_info')
  // A bare table name (no alias declared) still resolves to itself.
  assert.equal(resolveTableAlias('select * from de_approval where de_approval.id', 'de_approval'), 'de_approval')
  // An unknown qualifier (e.g. a column alias) resolves to null so the caller
  // can fall back to treating the token as a literal table name.
  assert.equal(resolveTableAlias(multi, 'oid'), null)
}

function testAliasDotCompletionUsesFullTableSchema() {
  const sqlEditor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')

  // `alias.partial` completion must fetch the exact table schema, not the
  // search-completion endpoint. SearchCompletions is limited/ranked for global
  // autocomplete and can omit matching columns from wide tables.
  assert.match(sqlEditor, /import \{[^}]*getTableSchema[^}]*\} from '\.\.\/lib\/bridge'/)
  assert.match(sqlEditor, /const schema = await getTableSchema\(connectionId, selectedDbRef\.current, tableName\)/)
  assert.match(sqlEditor, /col\.name\.toLowerCase\(\)\.startsWith\(partialLower\)/)
  assert.match(sqlEditor, /insertText: col\.name/)

  const dotBlock = sqlEditor.match(/\/\/ ── Dot-completion:[\s\S]*?\/\/ ── SHOW sub-command completion/)
  assert.ok(dotBlock, 'dot-completion block not found')
  assert.doesNotMatch(dotBlock[0], /searchCompletions\(connectionId, selectedDbRef\.current, tableName\)/)
}

function testBumpTableUsageCountsAndStampsImmutably() {
  let usage = {}
  const next = bumpTableUsage(usage, { connId: 'c1', dbName: 'db1', tableName: 'orders' }, 1000)
  // Pure: original map is untouched, a new map is returned.
  assert.deepEqual(usage, {})
  assert.equal(next['c1::db1::orders'].count, 1)
  assert.equal(next['c1::db1::orders'].lastUsedAt, 1000)

  usage = bumpTableUsage(next, { connId: 'c1', dbName: 'db1', tableName: 'orders' }, 2000)
  assert.equal(usage['c1::db1::orders'].count, 2)
  assert.equal(usage['c1::db1::orders'].lastUsedAt, 2000)

  // Distinct connections/databases never collide.
  usage = bumpTableUsage(usage, { connId: 'c2', dbName: 'db1', tableName: 'orders' }, 3000)
  assert.equal(usage['c2::db1::orders'].count, 1)
  assert.equal(usage['c1::db1::orders'].count, 2)

  // A missing table name is a no-op (defensive).
  assert.equal(bumpTableUsage(usage, { connId: 'c1', dbName: 'db1', tableName: '' }), usage)
}

function testSortTablesByUsagePutsFrequentFirst() {
  const usage = {
    'c1::db1::orders': { count: 5, lastUsedAt: 100 },
    'c1::db1::users':  { count: 5, lastUsedAt: 200 },
    'c1::db1::logs':   { count: 1, lastUsedAt: 300 },
  }
  const children = [
    { tableName: 'audit',  connId: 'c1', dbName: 'db1' },
    { tableName: 'logs',   connId: 'c1', dbName: 'db1' },
    { tableName: 'orders', connId: 'c1', dbName: 'db1' },
    { tableName: 'users',  connId: 'c1', dbName: 'db1' },
    { tableName: 'zebra',  connId: 'c1', dbName: 'db1' },
  ]

  // Generous topN → every used table is pinned. users & orders tie on count
  // (5) → more-recently-used (users) wins; then logs (count 1); then the unused
  // tables (audit, zebra) follow in dictionary order.
  const sorted = sortTablesByUsage(children, usage, 10).map((c) => c.tableName)
  assert.deepEqual(sorted, ['users', 'orders', 'logs', 'audit', 'zebra'])
}

function testSortTablesByUsagePinsTopNThenAlphabetises() {
  const usage = {
    'c1::db1::orders': { count: 9, lastUsedAt: 100 },
    'c1::db1::users':  { count: 8, lastUsedAt: 200 },
    'c1::db1::logs':   { count: 7, lastUsedAt: 300 }, // used, but ranked 3rd
  }
  const children = [
    { tableName: 'zebra',  connId: 'c1', dbName: 'db1' },
    { tableName: 'logs',   connId: 'c1', dbName: 'db1' },
    { tableName: 'orders', connId: 'c1', dbName: 'db1' },
    { tableName: 'apple',  connId: 'c1', dbName: 'db1' },
    { tableName: 'users',  connId: 'c1', dbName: 'db1' },
  ]
  // topN = 2 → only orders & users pin (by frequency). logs, despite being
  // used, ranks 3rd so it drops into the alphabetical tail with apple & zebra.
  const sorted = sortTablesByUsage(children, usage, 2).map((c) => c.tableName)
  assert.deepEqual(sorted, ['orders', 'users', 'apple', 'logs', 'zebra'])
}

function testSortTablesByUsageAlphabetisesUnused() {
  const children = [
    { tableName: 'b', connId: 'c', dbName: 'd' },
    { tableName: 'a', connId: 'c', dbName: 'd' },
    { tableName: 'c', connId: 'c', dbName: 'd' },
  ]
  // No usage data → every table is "other", listed in dictionary order.
  assert.deepEqual(
    sortTablesByUsage(children, {}).map((c) => c.tableName),
    ['a', 'b', 'c'],
  )
  // topN = 0 → nothing pinned, pure alphabetical even with usage present.
  assert.deepEqual(
    sortTablesByUsage(children, { 'c::d::c': { count: 99, lastUsedAt: 1 } }, 0).map((c) => c.tableName),
    ['a', 'b', 'c'],
  )
}

function testTableUsageTopNSettingRoundTrips() {
  const storage = new MemoryStorage()
  // Default when unset.
  assert.equal(loadTableUsageTopN(storage), 10)
  // Save clamps to [0,100] and persists.
  assert.equal(saveTableUsageTopN(25, storage), 25)
  assert.equal(loadTableUsageTopN(storage), 25)
  assert.equal(saveTableUsageTopN(999, storage), 100)
  assert.equal(saveTableUsageTopN(-5, storage), 0)
  assert.equal(saveTableUsageTopN(3.9, storage), 3)
  // Garbage falls back to default.
  assert.equal(clampTableUsageTopN('abc'), 10)
}

function testTableTreeSortsTablesFolderByUsage() {
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')

  // Pure sort/bump helpers come from tableUsage; persistence comes from bridge.
  assert.match(explorer, /import \{ bumpTableUsage, sortTablesByUsage \} from '\.\.\/lib\/tableUsage'/)
  assert.match(explorer, /getTableUsage, recordTableUsage,/)
  // Usage is loaded from the backend (griplite.db) once on mount.
  assert.match(explorer, /getTableUsage\(\)\.then\(\(m\) => \{ if \(alive\) setTableUsage\(m \?\? \{\}\) \}\)/)
  // Opening a table optimistically bumps in-memory AND persists to the backend.
  assert.match(explorer, /setTableUsage\(\(prev\) => bumpTableUsage\(prev, \{ connId: node\.connId, dbName: node\.dbName, tableName: node\.tableName \}\)\)/)
  assert.match(explorer, /recordTableUsage\(node\.connId, node\.dbName, node\.tableName\)/)
  // The tables folder's children are sorted by usage (with the configurable
  // top-N threshold) before rendering.
  assert.match(explorer, /node\.folderKind === 'tables'\s*\n?\s*\?\s*sortTablesByUsage\(cache\.children, tableUsage, tableUsageTopN\)/)
  // The top-N threshold arrives as a prop (defaulting to 10).
  assert.match(explorer, /tableUsageTopN = 10,/)

  // The bridge persists usage to griplite.db in Wails, localStorage in dev.
  assert.match(bridge, /export async function getTableUsage\(\)/)
  assert.match(bridge, /const \{ GetTableUsage \} = await import/)
  assert.match(bridge, /export async function recordTableUsage\(connectionID, dbName, tableName\)/)
  assert.match(bridge, /const \{ RecordTableUsage \} = await import/)
}

function testSettingsModalWiredIntoApp() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const menu = readFileSync(new URL('../src/components/MenuBar.jsx', import.meta.url), 'utf8')
  const modal = readFileSync(new URL('../src/components/SettingsModal.jsx', import.meta.url), 'utf8')

  // App loads the persisted preference, threads it to the Explorer, and lets
  // the Settings modal update it.
  assert.match(app, /import \{ loadTableUsageTopN \} from '\.\/lib\/settings'/)
  assert.match(app, /useState\(\(\) => loadTableUsageTopN\(\)\)/)
  assert.match(app, /tableUsageTopN=\{tableUsageTopN\}/)
  assert.match(app, /onChangeTableUsageTopN=\{setTableUsageTopN\}/)
  assert.match(app, /onSettings=\{\(\) => setSettingsOpen\(true\)\}/)

  // The menu exposes a Settings entry that triggers onSettings.
  assert.match(menu, /onSettings/)
  assert.match(menu, /Settings…/)

  // The modal persists the clamped value via the settings helper.
  assert.match(modal, /saveTableUsageTopN/)
  assert.match(modal, /onChangeTableUsageTopN/)

  // The theme/skin picker now lives in Settings (moved out of the title bar).
  assert.match(modal, /import \{ useTheme \} from '\.\.\/theme\/ThemeProvider'/)
  assert.match(modal, /const \{ theme, setTheme \} = useTheme\(\)/)
  assert.match(modal, /THEME_OPTIONS/)
  assert.match(modal, /Appearance/)

  // App no longer renders the title-bar ThemeToggle (theme is in Settings).
  assert.ok(!/ThemeToggle/.test(app), 'App.jsx should not reference ThemeToggle anymore')
}

function testNativeMenuWiredIntoApp() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')

  // App detects the platform and subscribes to native menu clicks.
  assert.match(app, /getPlatform, onMenuAction/)
  assert.match(app, /setNativeMenu\(platform === 'darwin'\)/)
  assert.match(app, /onMenuAction\(\{/)
  assert.match(app, /settings:\s*\(\) => setSettingsOpen\(true\)/)
  assert.match(app, /shortcuts:\s*\(\) => setDocsOpen\(true\)/)
  assert.match(app, /about:\s*\(\) => setAboutOpen\(true\)/)
  // The in-app MenuBar is hidden when the native menu is active.
  assert.match(app, /\{!nativeMenu && \(/)
  // The themed title strip insets for the macOS traffic-light buttons so it can
  // double as the (hidden) native title bar without overlapping them.
  assert.match(app, /paddingLeft: nativeMenu \? 78 : 12/)

  // Bridge exposes platform detection and the menu event subscription.
  assert.match(bridge, /export async function getPlatform\(\)/)
  assert.match(bridge, /const \{ Environment \} = await import/)
  assert.match(bridge, /export async function onMenuAction\(handlers = \{\}\)/)
  assert.match(bridge, /EventsOn\('menu:settings',/)
  assert.match(bridge, /EventsOn\('menu:shortcuts',/)
  assert.match(bridge, /EventsOn\('menu:about',/)
}

function testSqlEditorRendersSuggestWidgetOnTop() {
  const sqlEditor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')
  // fixedOverflowWidgets escapes the editor's overflow-hidden container so the
  // completion popup is not clipped by the result panel below it.
  assert.match(sqlEditor, /fixedOverflowWidgets:\s*true/)
}

function testResultPageSizePreferenceIsRemembered() {
  const paging = readFileSync(new URL('../src/lib/queryPaging.js', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  // queryPaging exposes persistence helpers backed by localStorage.
  assert.match(paging, /export function loadPreferredPageSize/)
  assert.match(paging, /export function savePreferredPageSize/)
  assert.match(paging, /localStorage\.getItem\(PAGE_SIZE_STORAGE_KEY\)/)
  assert.match(paging, /localStorage\.setItem\(PAGE_SIZE_STORAGE_KEY/)

  // App seeds a remembered page size and uses it for new console queries.
  assert.match(app, /loadPreferredPageSize/)
  assert.match(app, /savePreferredPageSize/)
  assert.match(app, /preferredPageSizeRef/)
  // The hard-coded default must no longer drive the pageable query branch.
  assert.match(app, /runQueryPage\(queryConnId, opts\.dbName \?\? '', sql, 0, preferredPageSizeRef\.current, tabId\)/)
}

function testResultPanelOffersCancelWhileQueryIsRunning() {
  const resultPanel = readFileSync(new URL('../src/components/ResultPanel.jsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  // ResultPanel accepts an onCancelQuery callback and exposes a cancel control
  // while the query is executing.
  assert.match(resultPanel, /onCancelQuery/)
  assert.match(resultPanel, /isRunning && onCancelQuery && \(/)
  assert.match(resultPanel, /onClick=\{onCancelQuery\}/)
  // App wires the cancel handler to the tab-scoped cancelQuery bridge call.
  assert.match(app, /import \{ runQuery, runQueryPage, cancelQuery, listConnections, getBuildInfo[^}]*\} from '\.\/lib\/bridge'/)
  assert.match(app, /onCancelQuery=\{\(\) => cancelQuery\(tab\.id\)\}/)
}

function testValuePanelSyncsMonacoReadOnlyWhenEditabilityChanges() {
  const valuePanel = readFileSync(new URL('../src/components/ValuePanel.jsx', import.meta.url), 'utf8')
  assert.match(valuePanel, /editorRef\.current\?\.updateOptions\(\{\s*readOnly:\s*!editable,\s*domReadOnly:\s*!editable,/m)
  assert.match(valuePanel, /renderLineHighlight:\s*editable \? 'line' : 'none'/)
  assert.match(valuePanel, /\}, \[editable\]\)/)
}

function testTableDataViewAndSchemaRefreshAreActiveOnly() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')

  assert.match(app, /isActive=\{activeTabId === tab\.id\}/)
  assert.match(tableViewer, /isActive = true/)
  assert.match(tableViewer, /useTableSchema\(connId, dbName, tableName, isActive\)/)
  assert.match(tableViewer, /if \(!isActive \|\| document\.visibilityState !== 'visible'\) return/)
  assert.match(tableViewer, /hasVisitedData/)
  assert.match(tableViewer, /setHasVisitedData\(true\)/)
  assert.match(tableViewer, /\{hasVisitedData && \(/)
}

function testTableViewerDoesNotExposeMockBadgeInReleaseUI() {
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tableViewer, /⚠ mock/)
  assert.doesNotMatch(tableViewer, /badge=\{\s*schemaLoading \? '…'\s*:\s*fromCache\s*\?\s*null\s*:\s*'[^']*mock[^']*'/m)
}

function testTableViewerDataTabDoesNotShowStaticRowBadge() {
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tableViewer, /<TabBtn id="data" label="Data" badge="100 rows" \/>/)
  assert.match(tableViewer, /<TabBtn id="data" label="Data" \/>/)
}

function testTableViewerFallbackSchemaHasUsefulColumnsForUnknownTables() {
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(tableViewer, /function genericFallbackColumns\(\)/)
  assert.match(tableViewer, /columns: genericFallbackColumns\(\)/)
  assert.doesNotMatch(tableViewer, /columns: \[\], indexes: \[\], constraints: \[\], foreignKeys: \[\]/)
}

function testDataViewerAvoidsIdleFullTableScans() {
  const dataViewer = readFileSync(new URL('../src/components/DataViewer.jsx', import.meta.url), 'utf8')
  assert.match(dataViewer, /const needsNonEmptyColumnSet = showColPicker \|\| showNonEmptyColumnsOnly/)
  assert.match(dataViewer, /needsNonEmptyColumnSet\s*\?\s*buildNonEmptyColumnSet\(rows, columns\)\s*:\s*new Set\(\)/m)
  assert.match(dataViewer, /const hasHiddenColumns = hiddenCols\.size > 0/)
  assert.match(dataViewer, /hasHiddenColumns \? projectVisibleRows\(rows, visibleColumnIndices\) : rows/)
  assert.match(dataViewer, /return null\s*\n\s*\}/)
  assert.match(dataViewer, /const filteredSourceSet = useMemo\(\(\) => filteredSourceRows \? new Set\(filteredSourceRows\) : null/)
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
    'db.getCollection("prm_order").find({}).sort({ _id: -1 }).skip(100).limit(100)',
  )
  assert.equal(DEFAULT_MONGO_SORT, '{ _id: -1 }')
}

function testMongoCollectionDefaultsSortByIdAndFocusesInsideFindBraces() {
  const tableViewer = readFileSync(new URL('../src/components/TableViewer.jsx', import.meta.url), 'utf8')
  assert.match(tableViewer, /import \{ buildMongoCollectionFindQuery, DEFAULT_MONGO_SORT,/)
  assert.match(tableViewer, /const \[mongoSortClause, setMongoSortClause\] = useState\(DEFAULT_MONGO_SORT\)/)
  assert.match(tableViewer, /const \[mongoSortDraft,\s+setMongoSortDraft\]\s+= useState\(DEFAULT_MONGO_SORT\)/)
  assert.match(tableViewer, /setMongoSortClause\(DEFAULT_MONGO_SORT\)/)
  assert.match(tableViewer, /setMongoSortDraft\(DEFAULT_MONGO_SORT\)/)
  assert.match(tableViewer, /placeholder=("\{ _id: -1 \}"|'\{ _id: -1 \}')/)
  assert.match(tableViewer, /focusInsideBracesOnFocus/)
  assert.match(tableViewer, /if \(focusInsideBracesOnFocus && e\.target\.value === '\{\}'\)/)
  assert.match(tableViewer, /e\.target\.setSelectionRange\(1, 1\)/)
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

function testMongoConsoleProvidesShellAutocomplete() {
  // db.<partial> → collection-name context.
  assert.deepEqual(
    classifyMongoConsoleContext('db.prm'),
    { type: 'collectionName', partial: 'prm' },
  )
  // db.coll. → collection methods.
  assert.equal(classifyMongoConsoleContext('db.prm_order.').type, 'collectionMethod')
  assert.equal(classifyMongoConsoleContext('db.getCollection("prm_order").fi').type, 'collectionMethod')
  // …). → chainable cursor methods.
  assert.equal(classifyMongoConsoleContext('db.prm_order.find({}).').type, 'cursorMethod')
  // $ → query operators.
  assert.equal(classifyMongoConsoleContext('db.x.find({ a: { $g').partial, '$g')
  assert.equal(classifyMongoConsoleContext('db.x.find({ a: { $g').type, 'operator')
  // Inside a filter, a bare word resolves to the collection's fields.
  const fieldCtx = classifyMongoConsoleContext('db.prm_order.find({ tn')
  assert.equal(fieldCtx.type, 'field')
  assert.equal(fieldCtx.collection, 'prm_order')
  assert.equal(fieldCtx.partial, 'tn')
  // Collection detection handles both access styles, picking the nearest one.
  assert.equal(detectMongoCollectionName('db.getCollection("orders").aggregate(['), 'orders')
  assert.equal(detectMongoCollectionName('db.users.find({})'), 'users')
  // The supported collection methods are advertised.
  const labels = MONGO_COLLECTION_METHODS.map((m) => m.label)
  for (const name of ['find', 'aggregate', 'insertOne', 'updateMany', 'createIndex', 'dropIndex']) {
    assert.ok(labels.includes(name), `expected ${name} in collection methods`)
  }

  // The editor registers a javascript (not sql) provider for mongo + silences
  // the JS worker's semantic squiggles.
  const editor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')
  assert.match(editor, /registerCompletionItemProvider\('javascript'/)
  assert.match(editor, /classifyMongoConsoleContext\(textUntilCursor\)/)
  assert.match(editor, /noSemanticValidation:\s*true/)
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
  assert.match(dataViewer, /hover:bg-hover hover:text-fg-primary/)
  assert.match(dataViewer, /focus-visible:bg-hover focus-visible:text-fg-primary/)
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
testCloseOtherWorkspaceTabsKeepsOnlyAnchor()
testCloseTabsToSideRemovesCorrectSide()
testPageSliceKeepsLocalPaginationOnly()
testAppendResultPagePreservesMetadata()
testAppendResultPageKeepsFirstPageColumns()
testMongoFindQueriesArePageable()
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
testConnectionDialogDeleteUpdatesVisibleListAndParent()
testConnectionDialogOkDoesNotSavePristineBlankConnection()
testConnectionDialogSupportsDuplicate()
testConnectionDialogSupportsCustomColorPicker()
testDatabaseExplorerDoesNotExposeConnectionGroups()
testConnectionDialogSelectionAndSaveAreResponsive()
testMongoCollectionTextModeHidesMySQLFormatToggle()
testMongoTableViewerInfersCollectionFromConnectionKind()
testTableTabsAndBreadcrumbIncludeConnectionName()
testTabBarScrollsActiveTabAndShowsDriverIcons()
testTabsUseBoundedKeepAliveMounting()
testConsoleQueriesUseTabScopedQueryIds()
testSqlCommentStrippingKeepsCommentedSelectEditable()
testNewConsoleInheritsActiveDatabaseContext()
testSqlConsoleResultEditsCanBeSavedForSimpleSelects()
testResultPanelPreservesValuePanelOpenStateAcrossRuns()
testResultPanelOffersCancelWhileQueryIsRunning()
testResultPageSizePreferenceIsRemembered()
testSqlEditorRendersSuggestWidgetOnTop()
testColumnSuggestionsAreScopedToReferencedTables()
testMultiTableFromWithAliasesIsRecognised()
testAliasDotCompletionUsesFullTableSchema()
testBumpTableUsageCountsAndStampsImmutably()
testSortTablesByUsagePutsFrequentFirst()
testSortTablesByUsagePinsTopNThenAlphabetises()
testSortTablesByUsageAlphabetisesUnused()
testTableUsageTopNSettingRoundTrips()
testTableTreeSortsTablesFolderByUsage()
testSettingsModalWiredIntoApp()
testNativeMenuWiredIntoApp()
testRecordViewSupportsCtrlFHighlightSearch()
testGridAndTextModesSupportHighlightSearch()
testMongoCollectionExpandsIntoFieldsAndIndexes()
testIndexNodeContextMenuSupportsDelete()
testIndexesFolderContextMenuSupportsAddIndex()
testValuePanelSyncsMonacoReadOnlyWhenEditabilityChanges()
testTableDataViewAndSchemaRefreshAreActiveOnly()
testTableViewerDoesNotExposeMockBadgeInReleaseUI()
testTableViewerDataTabDoesNotShowStaticRowBadge()
testTableViewerFallbackSchemaHasUsefulColumnsForUnknownTables()
testDataViewerAvoidsIdleFullTableScans()
testMongoCollectionInlineEditingUsesMongoApplier()
testMongoCollectionFindQueryBuildsDatagripStyleFilterAndSort()
testMongoCollectionDefaultsSortByIdAndFocusesInsideFindBraces()
testMongoFieldSuggestionsUseCollectionFields()
testMongoConsoleProvidesShellAutocomplete()
testMongoCollectionDefaultsToGridAndLabelsRecordMode()
testRecordViewRendersJsonValuesVisually()
testRecordViewContextMenuSupportsDatagripActions()
testGridContextMenuSeparatesRowMarkerAndDataCell()
testColumnPickerCanSearchAndFilterNonEmptyColumns()
testColumnPickerSupportsSelectAllAndInvertForFilteredEntries()
testResultModeIsPreservedAcrossReloads()
testValuePanelToolbarUsesConsistentIcons()

function testRedisBuildKeyTreeFoldsNamespaces() {
  const tree = buildKeyTree(['user:1', 'user:2', 'cache:home', 'plain'], ':')
  const user = tree.find((n) => n.label === 'user')
  const cache = tree.find((n) => n.label === 'cache')
  assert.ok(user && Array.isArray(user.children), 'user folder exists')
  assert.equal(user.children.length, 2, 'user has two leaf children')
  assert.ok(user.children.every((c) => c.leaf), 'children are leaves')
  assert.equal(user.children[0].key, 'user:1', 'leaf keeps full key')
  assert.ok(cache, 'cache folder exists')
  const plain = tree.find((n) => n.label === 'plain')
  assert.ok(plain && plain.leaf, 'separator-less key is a leaf at root')
}

function testRedisBuildKeyTreeIsStableAndSorted() {
  const a = buildKeyTree(['b:2', 'a:1', 'a:0'], ':')
  const b = buildKeyTree(['a:0', 'b:2', 'a:1'], ':')
  assert.deepEqual(a.map((n) => n.label), b.map((n) => n.label), 'order independent of input order')
  assert.deepEqual(a.map((n) => n.label), ['a', 'b'], 'folders sorted alphabetically')
}

function testRedisClassifyCommandDetectsWrites() {
  assert.deepEqual(classifyRedisCommand('get foo'), { name: 'GET', isWrite: false })
  assert.deepEqual(classifyRedisCommand('  set a b '), { name: 'SET', isWrite: true })
  assert.equal(classifyRedisCommand('FLUSHALL').isWrite, true)
  assert.equal(classifyRedisCommand('ttl k').isWrite, false)
  assert.ok(REDIS_COMMANDS.includes('SUBSCRIBE'), 'autocomplete list populated')
}

function testRedisDecodeFormatsCoverAllRequested() {
  const ids = DECODE_FORMATS.map((f) => f.id)
  for (const want of ['text', 'json', 'hex', 'binary', 'gzip', 'deflate', 'brotli', 'lz4', 'snappy', 'zstd', 'msgpack', 'protobuf', 'pickle', 'php']) {
    assert.ok(ids.includes(want), `format ${want} present`)
  }
}

function testRedisFormatTTL() {
  assert.equal(formatTTL(-1), 'No expiry')
  assert.equal(formatTTL(-2), 'Key missing')
  assert.equal(formatTTL(30), '30s')
  assert.equal(formatTTL(90), '1m 30s')
}

testRedisBuildKeyTreeFoldsNamespaces()
testRedisBuildKeyTreeIsStableAndSorted()
testRedisClassifyCommandDetectsWrites()
testRedisDecodeFormatsCoverAllRequested()
testRedisFormatTTL()

function testReadConsoleEditorContentReadsActiveSubTab() {
  const storage = new MemoryStorage()
  storage.setItem(consoleEditorStorageKey('console-1'), JSON.stringify({
    tabs: [
      { id: 't1', label: 'Query 1', content: 'SELECT 1' },
      { id: 't2', label: 'Query 2', content: 'SELECT 2' },
    ],
    activeTab: 't2',
    selectedDb: 'shop',
  }))
  assert.deepEqual(
    readConsoleEditorContent('console-1', storage),
    { sql: 'SELECT 2', selectedDb: 'shop' },
  )
  // Missing key → empty capture (never throws).
  assert.deepEqual(readConsoleEditorContent('missing', storage), { sql: '', selectedDb: '' })
  // Malformed JSON → empty capture.
  storage.setItem(consoleEditorStorageKey('bad'), '{not json')
  assert.deepEqual(readConsoleEditorContent('bad', storage), { sql: '', selectedDb: '' })
  // Falls back to first sub-tab when activeTab is unknown.
  storage.setItem(consoleEditorStorageKey('console-2'), JSON.stringify({
    tabs: [{ id: 't1', content: 'SELECT first' }],
    activeTab: 'gone',
    selectedDb: '',
  }))
  assert.equal(readConsoleEditorContent('console-2', storage).sql, 'SELECT first')
}

function testFindOpenConsoleForSaved() {
  const tabs = [
    { id: 'console-1', type: 'console', savedConsoleId: 'sc-1' },
    { id: 'table-1', type: 'table' },
    { id: 'console-2', type: 'console' },
  ]
  assert.equal(findOpenConsoleForSaved(tabs, 'sc-1')?.id, 'console-1')
  assert.equal(findOpenConsoleForSaved(tabs, 'sc-missing'), null)
  assert.equal(findOpenConsoleForSaved(tabs, ''), null)
  assert.equal(findOpenConsoleForSaved(null, 'sc-1'), null)
}

function testWorkspacePersistsSavedConsoleBinding() {
  const storage = new MemoryStorage()
  const snapshot = makeWorkspaceSnapshot({
    tabs: [
      { id: 'console-3', type: 'console', label: 'orders report', connId: 'conn', connectionKind: 'mysql', savedConsoleId: 'sc-9', savedConsoleName: 'orders report' },
    ],
    activeTabId: 'console-3',
    activeConnId: 'conn',
  })
  assert.equal(snapshot.tabs[0].savedConsoleId, 'sc-9')
  assert.equal(snapshot.tabs[0].savedConsoleName, 'orders report')
  saveWorkspaceState(storage, snapshot)
  assert.deepEqual(loadWorkspaceState(storage), snapshot)
}

function testSavedConsolesFeatureWiredIntoApp() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')
  const menu = readFileSync(new URL('../src/components/SavedConsolesMenu.jsx', import.meta.url), 'utf8')

  // Bridge exposes the three saved-console calls with a localStorage mock.
  assert.match(bridge, /export async function listSavedConsoles\(\)/)
  assert.match(bridge, /export async function saveConsole\(payload\)/)
  assert.match(bridge, /export async function deleteSavedConsole\(id\)/)
  assert.match(bridge, /const SAVED_CONSOLES_KEY = 'griplite_saved_consoles_v1'/)

  // App imports + renders the menu/modal and wires the handlers.
  assert.match(app, /import SavedConsolesMenu\s+from '\.\/components\/SavedConsolesMenu'/)
  assert.match(app, /import SaveConsoleModal\s+from '\.\/components\/SaveConsoleModal'/)
  assert.match(app, /listSavedConsoles, saveConsole, deleteSavedConsole/)
  assert.match(app, /const handleSaveCurrentConsole = useCallback/)
  assert.match(app, /const performSaveConsole = useCallback/)
  assert.match(app, /const handleOpenSavedConsole = useCallback/)
  assert.match(app, /<SavedConsolesMenu/)
  assert.match(app, /canSave=\{activeTab\?\.type === 'console'\}/)
  // Re-saving binds the tab to the saved console id (upsert in place).
  assert.match(app, /id: tab\.savedConsoleId \?\? ''/)

  // The menu offers save + per-row delete.
  assert.match(menu, /Save current console…/)
  assert.match(menu, /onDelete\?\.\(c\)/)
}

function testSavedConsolesUseNativeMenuOnMac() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')

  // On macOS the in-app dropdown is suppressed (native menu hosts it).
  assert.match(app, /\{!nativeMenu && \(\s*<div className="h-full"[\s\S]*?<SavedConsolesMenu/m)
  // Native menu events are wired through a ref to dodge stale [] -dep closures.
  assert.match(app, /consoleSave:\s*\(\) => consoleMenuActionsRef\.current\.save\(\)/)
  assert.match(app, /consoleOpen:\s*\(id\) => consoleMenuActionsRef\.current\.openById\(id\)/)
  assert.match(app, /const openSavedConsoleById = useCallback/)
  // Bridge subscribes to the new native menu events.
  assert.match(bridge, /EventsOn\('menu:console-save',\s*handlers\.consoleSave\)/)
  assert.match(bridge, /EventsOn\('menu:console-open',\s*\(id\) => handlers\.consoleOpen\(id\)\)/)
}

function testSavedConsoleOpenDedupsAndTabRename() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  // Dedup reads an always-fresh tabsRef (not a stale closure) so repeated opens
  // focus the single existing tab instead of spawning duplicates.
  assert.match(app, /const tabsRef = useRef\(tabs\)/)
  assert.match(app, /tabsRef\.current = tabs/)
  assert.match(app, /findOpenConsoleForSaved\(tabsRef\.current, saved\.id\)/)

  // The async menu subscription must not leak a listener (the duplicate-tab
  // root cause): unsubscribe even if torn down before the promise resolves.
  assert.match(app, /let cancelled = false/)
  assert.match(app, /if \(cancelled\) \{ try \{ unsub\?\.\(\) \}/)

  // Right-click rename on a console tab opens the name dialog for that tab.
  assert.match(app, /const handleRenameConsole = useCallback/)
  assert.match(app, /onRenameConsole=\{handleRenameConsole\}/)
  // The menu routes every action through run(fn), which calls fn(contextMenu.tabId).
  assert.match(app, /const run = \(fn\) => \{ fn\?\.\(contextMenu\.tabId\); closeMenu\(\) \}/)
  assert.match(app, /run\(onRenameConsole\)/)
  assert.match(app, />\s*Rename…\s*</)
}

function testTabContextMenuCloseOthersAndSides() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')

  // Handlers exist and route to the workspace helpers via an always-fresh ref.
  assert.match(app, /const handleCloseOtherTabs = useCallback/)
  assert.match(app, /closeOtherTabsInWorkspace\(tabsRef\.current, tabId\)/)
  assert.match(app, /const handleCloseTabsToLeft = useCallback/)
  assert.match(app, /closeTabsToSideInWorkspace\(tabsRef\.current, activeTabIdRef\.current, tabId, 'left'\)/)
  assert.match(app, /const handleCloseTabsToRight = useCallback/)
  assert.match(app, /closeTabsToSideInWorkspace\(tabsRef\.current, activeTabIdRef\.current, tabId, 'right'\)/)

  // Wired into the TabBar.
  assert.match(app, /onCloseOthers=\{handleCloseOtherTabs\}/)
  assert.match(app, /onCloseLeft=\{handleCloseTabsToLeft\}/)
  assert.match(app, /onCloseRight=\{handleCloseTabsToRight\}/)

  // Menu renders all of the new items, with left/right/others disabled when N/A.
  assert.match(app, />\s*Close Tabs to the Left\s*</)
  assert.match(app, />\s*Close Tabs to the Right\s*</)
  assert.match(app, />\s*Close Other Tabs\s*</)
  assert.match(app, /const hasLeft = ctxIdx > 0/)
  assert.match(app, /const hasRight = ctxIdx >= 0 && ctxIdx < tabs\.length - 1/)
  assert.match(app, /const hasOthers = tabs\.length > 1/)

  // The tab context menu is portaled to <body> so the tab bar's backdrop-filter
  // (material-bar) + overflow doesn't clip the fixed-position menu (the
  // "menu opens but is invisible" bug).
  assert.match(app, /import \{ createPortal \} from 'react-dom'/)
  assert.match(app, /return createPortal\(/)
  assert.match(app, /document\.body,\s*\)/)
}

function testTitleBarDoubleClickMaximises() {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../src/lib/bridge.js', import.meta.url), 'utf8')

  // Double-clicking the custom title bar zooms the window (the OS can't do it
  // for a frameless/full-size-content title bar), ignoring interactive controls.
  assert.match(app, /onDoubleClick=\{\(e\) => \{/)
  assert.match(app, /e\.target\.closest\('button, input, select, a, \[role="menu"\], \[role="menuitem"\]'\)/)
  assert.match(app, /toggleMaximiseWindow\(\)/)

  // Bridge helper calls the Wails runtime and is a no-op in the browser.
  assert.match(bridge, /export async function toggleMaximiseWindow\(\)/)
  assert.match(bridge, /WindowToggleMaximise\(\)/)
}

testReadConsoleEditorContentReadsActiveSubTab()
testFindOpenConsoleForSaved()
testWorkspacePersistsSavedConsoleBinding()
testSavedConsolesFeatureWiredIntoApp()
testSavedConsolesUseNativeMenuOnMac()
testSavedConsoleOpenDedupsAndTabRename()
testTabContextMenuCloseOthersAndSides()
testTitleBarDoubleClickMaximises()

function testFontSettingsRoundTripAndClamp() {
  const storage = new MemoryStorage()
  // Defaults when unset.
  assert.equal(loadEditorFontSize(storage), DEFAULT_EDITOR_FONT_SIZE)
  assert.equal(loadUiFontSize(storage), DEFAULT_UI_FONT_SIZE)
  assert.equal(loadGridFontSize(storage), DEFAULT_GRID_FONT_SIZE)
  assert.equal(loadEditorFontFamily(storage), '')
  assert.equal(loadUiFontFamily(storage), '')
  assert.equal(loadGridFontFamily(storage), '')

  // Sizes clamp to their ranges and persist.
  assert.equal(saveEditorFontSize(18, storage), 18)
  assert.equal(loadEditorFontSize(storage), 18)
  assert.equal(saveEditorFontSize(999, storage), MAX_EDITOR_FONT_SIZE)
  assert.equal(saveUiFontSize(1, storage), MIN_UI_FONT_SIZE)
  assert.equal(saveGridFontSize(17, storage), 17)
  assert.equal(loadGridFontSize(storage), 17)
  assert.equal(saveGridFontSize(999, storage), MAX_GRID_FONT_SIZE)
  assert.equal(saveGridFontSize(1, storage), MIN_GRID_FONT_SIZE)

  // Families persist as-is.
  assert.equal(saveEditorFontFamily('Menlo, monospace', storage), 'Menlo, monospace')
  assert.equal(loadEditorFontFamily(storage), 'Menlo, monospace')
  assert.equal(saveUiFontFamily('"Inter", sans-serif', storage), '"Inter", sans-serif')
  assert.equal(loadUiFontFamily(storage), '"Inter", sans-serif')
  assert.equal(saveGridFontFamily('"Inter", sans-serif', storage), '"Inter", sans-serif')
  assert.equal(loadGridFontFamily(storage), '"Inter", sans-serif')

  // Empty family resolves to the default stack; a set family wins.
  assert.equal(resolveEditorFontStack(''), DEFAULT_EDITOR_FONT_STACK)
  assert.equal(resolveUiFontStack(''), DEFAULT_UI_FONT_STACK)
  assert.equal(resolveGridFontStack(''), DEFAULT_GRID_FONT_STACK)
  assert.equal(resolveEditorFontStack('Menlo, monospace'), 'Menlo, monospace')
  assert.equal(resolveGridFontStack('"Inter", sans-serif'), '"Inter", sans-serif')

  // Interface size maps to a zoom factor relative to the 13px baseline,
  // clamped to the supported range.
  assert.equal(uiZoomForSize(13), 1)
  assert.ok(uiZoomForSize(20) > 1)
  assert.ok(uiZoomForSize(10) < 1)
  assert.equal(uiZoomForSize(999), 22 / 13) // clamps to MAX_UI_FONT_SIZE
}

function testFontSettingsWiredIntoUi() {
  const provider = readFileSync(new URL('../src/settings/FontSettingsProvider.jsx', import.meta.url), 'utf8')
  const editor = readFileSync(new URL('../src/components/SqlEditor.jsx', import.meta.url), 'utf8')
  const modal = readFileSync(new URL('../src/components/SettingsModal.jsx', import.meta.url), 'utf8')
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

  // Provider applies the UI font + zoom (no counter-zoom var — that clipped the editor).
  assert.match(provider, /root\.style\.setProperty\('--app-font-family'/)
  assert.match(provider, /root\.style\.zoom = String\(zoom\)/)
  assert.doesNotMatch(provider, /--editor-unzoom/)

  // Monaco consumes the editor font live and is wrapped in ZoomGuard so the
  // interface `zoom` doesn't double-scale it (the white-overflow bug).
  assert.match(editor, /const \{ editorFontFamily, editorFontSize \} = useFontSettings\(\)/)
  assert.match(editor, /fontSize: editorFontSize/)
  assert.match(editor, /fontFamily: resolveEditorFontStack\(editorFontFamily\)/)
  assert.match(editor, /<ZoomGuard>[\s\S]*<Editor/)

  // ZoomGuard neutralises the interface zoom (net zoom 1) for its subtree.
  const guard = readFileSync(new URL('../src/components/ZoomGuard.jsx', import.meta.url), 'utf8')
  assert.match(guard, /zoom: 1 \/ uiZoom/)
  assert.match(guard, /calc\(100% \* \$\{uiZoom\}\)/)

  // Every Monaco editor in the app is guarded, not just the console.
  for (const f of ['ValuePanel.jsx', 'TableViewer.jsx', 'ReviewSqlModal.jsx']) {
    const src = readFileSync(new URL(`../src/components/${f}`, import.meta.url), 'utf8')
    assert.match(src, /import ZoomGuard from '\.\/ZoomGuard'/, `${f} imports ZoomGuard`)
    assert.match(src, /<ZoomGuard>[\s\S]*<Editor/, `${f} wraps its Editor`)
  }

  // Settings modal hosts all three font rows and uses the context setters.
  assert.match(modal, /const \{[\s\S]*?setEditorFontFamily[\s\S]*?\} = useFontSettings\(\)/)
  assert.match(modal, /label="Console"/)
  assert.match(modal, /label="Interface"/)
  assert.match(modal, /label="Result grid"/)
  assert.match(modal, /setGridFontFamily/)
  assert.match(modal, /setGridFontSize/)

  // The canvas data grid consumes the grid font live (family + size) and
  // derives row/header heights from the size so larger fonts don't clip.
  const grid = readFileSync(new URL('../src/components/DataGrid.jsx', import.meta.url), 'utf8')
  assert.match(grid, /const \{ gridFontFamily, gridFontSize \} = useFontSettings\(\)/)
  assert.match(grid, /resolveGridFontStack\(font\.family\)/)
  assert.match(grid, /gridMetricsForFontSize/)
  assert.match(grid, /rowHeight=\{rest\.rowHeight \?\? metrics\.rowHeight\}/)

  // The cell value inspector follows the same "Result grid" font (it's part of
  // viewing a result), not the SQL console font.
  const valuePanel = readFileSync(new URL('../src/components/ValuePanel.jsx', import.meta.url), 'utf8')
  assert.match(valuePanel, /const \{ gridFontFamily, gridFontSize \} = useFontSettings\(\)/)
  assert.match(valuePanel, /fontSize:\s+gridFontSize/)
  assert.match(valuePanel, /fontFamily:\s+resolveGridFontStack\(gridFontFamily\)/)

  // App is wrapped in the provider; #root reads the font-family var.
  assert.match(main, /<FontSettingsProvider>/)
  assert.match(css, /font-family: var\(--app-font-family/)
}

testFontSettingsRoundTripAndClamp()
testFontSettingsWiredIntoUi()

function testRippleGeometryCoversAndCentersOnPointer() {
  // 200×40 host, click at its center (100, 20) within the rect at origin.
  const rect = { left: 0, top: 0, width: 200, height: 40 }
  const g = rippleGeometry(rect, 100, 20)
  // Diameter = 2 × longest side so the circle always blankets the host.
  assert.equal(g.size, 400)
  // Centered on the pointer: offset back by half the diameter.
  assert.equal(g.x, 100 - 200)
  assert.equal(g.y, 20 - 200)

  // Honors the host's page offset (rect not at origin).
  const offset = rippleGeometry({ left: 50, top: 10, width: 80, height: 80 }, 90, 50)
  assert.equal(offset.size, 160)
  assert.equal(offset.x, 90 - 50 - 80)
  assert.equal(offset.y, 50 - 10 - 80)
}

function testAquaRefreshTokensAndPrimitivesWired() {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
  // Apple system blue accent in both themes.
  assert.match(css, /--accent:\s*#007aff/i)
  assert.match(css, /--accent:\s*#0a84ff/i)
  // New scales + materials + ripple primitive exist.
  assert.match(css, /--radius-lg:/)
  assert.match(css, /--shadow-2:/)
  assert.match(css, /\.material-bar\s*\{/)
  assert.match(css, /@keyframes aquaRipple/)
  assert.match(css, /\.press:active/)
  // Reduced-motion is respected.
  assert.match(css, /prefers-reduced-motion: reduce/)

  // Tailwind exposes the new radius/shadow tokens.
  const tw = readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8')
  assert.match(tw, /borderRadius:/)
  assert.match(tw, /boxShadow:/)

  // Ripple is wired into the key surfaces.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  assert.match(app, /import Ripple\s+from '\.\/components\/Ripple'/)
  assert.match(app, /material-bar/)
  const explorer = readFileSync(new URL('../src/components/DatabaseExplorer.jsx', import.meta.url), 'utf8')
  assert.match(explorer, /import Ripple from '\.\/Ripple'/)
  assert.match(explorer, /<Ripple \/>/)
}

testRippleGeometryCoversAndCentersOnPointer()
testAquaRefreshTokensAndPrimitivesWired()

console.log('unit tests passed')
