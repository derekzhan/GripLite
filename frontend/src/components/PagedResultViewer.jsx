import DataViewer, { exportCsv } from './DataViewer'
import ActionFooter from './ActionFooter'

function makeStatus({ shown, hasMore, loadingMore, capped }) {
  if (shown === 0) return 'No data'
  if (loadingMore) return `${shown.toLocaleString()} rows shown · loading more...`
  if (capped) return `${shown.toLocaleString()} rows shown · result limit reached`
  if (hasMore) return `${shown.toLocaleString()} rows shown · scroll to load more`
  return `${shown.toLocaleString()} rows shown · complete`
}

export default function PagedResultViewer({
  columns = [],
  rows = [],
  execMs,
  truncated = false,
  hasMore = false,
  loadingMore = false,
  capped = false,
  exportFilename = 'query_result.csv',
  fetchStats = null,
  onLoadMore,
  onRefresh,
  isRefreshing = false,
  editState,
  onHeaderClicked,
  sortConfig,
  isDirty = false,
  hasSelection = false,
  onAddRow,
  onDuplicateRow,
  onDeleteRow,
  onSave,
  onCancel,
}) {
  const statusLabel = makeStatus({
    shown: rows.length,
    hasMore,
    loadingMore,
    capped,
  })

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden">
      <div className="flex-1 overflow-hidden min-h-0">
        <DataViewer
          columns={columns}
          rows={rows}
          execMs={execMs}
          truncated={truncated && capped}
          exportFilename={exportFilename}
          editState={editState}
          onHeaderClicked={onHeaderClicked}
          sortConfig={sortConfig}
          onNearBottom={onLoadMore}
        />
      </div>
      <ActionFooter
        mode="infinite"
        pageSize="all"
        setPageSize={() => {}}
        currentPage={1}
        setCurrentPage={() => {}}
        totalRows={rows.length}
        statusLabel={statusLabel}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing || loadingMore}
        onExportCsv={() => columns.length && rows.length && exportCsv(columns, rows, exportFilename)}
        exportFilename={exportFilename}
        fetchStats={fetchStats}
        isDirty={isDirty}
        hasSelection={hasSelection}
        onAddRow={onAddRow}
        onDuplicateRow={onDuplicateRow}
        onDeleteRow={onDeleteRow}
        onSave={onSave}
        onCancel={onCancel}
      />
    </div>
  )
}
