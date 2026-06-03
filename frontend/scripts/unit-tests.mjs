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
import { DEFAULT_MONGO_SORT, buildMongoCollectionFindQuery, getMongoFieldSuggestions } from '../src/lib/mongoQuery.js'
import { appendResultPage, normalizePageSize, pageSlice, shouldLoadMore } from '../src/lib/queryPaging.js'
import { stripLeadingSqlComments } from '../src/lib/sqlText.js'
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
  assert.match(app, /import \{ runQuery, runQueryPage, cancelQuery, listConnections, getBuildInfo \} from '\.\/lib\/bridge'/)
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
testConnectionDialogDeleteUpdatesVisibleListAndParent()
testConnectionDialogOkDoesNotSavePristineBlankConnection()
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
testMongoCollectionDefaultsToGridAndLabelsRecordMode()
testRecordViewRendersJsonValuesVisually()
testRecordViewContextMenuSupportsDatagripActions()
testGridContextMenuSeparatesRowMarkerAndDataCell()
testColumnPickerCanSearchAndFilterNonEmptyColumns()
testColumnPickerSupportsSelectAllAndInvertForFilteredEntries()
testResultModeIsPreservedAcrossReloads()
testValuePanelToolbarUsesConsistentIcons()

console.log('unit tests passed')
