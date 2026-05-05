export const DEFAULT_COPY_BATCH_SIZE = 1000

export function buildCopyDatabaseConfig({
  source,
  target,
  copyStructure = true,
  copyData = true,
  dropTargetIfExists = false,
  batchSize = DEFAULT_COPY_BATCH_SIZE,
  scope = 'database',
  tables = [],
}) {
  return {
    sourceConnId: source?.connId ?? '',
    sourceDb: source?.dbName ?? '',
    targetConnId: target?.connId ?? '',
    targetDb: target?.dbName ?? '',
    copyStructure,
    copyData,
    dropTargetIfExists,
    batchSize: Number(batchSize) > 0 ? Number(batchSize) : DEFAULT_COPY_BATCH_SIZE,
    scope,
    tables: Array.isArray(tables) ? tables : [],
  }
}

export function tableNamesForCopySelection(tables = []) {
  return (tables ?? [])
    .map((table) => {
      if (typeof table === 'string') return table
      return table?.name ?? table?.tableName ?? ''
    })
    .map((name) => String(name).trim())
    .filter(Boolean)
}

export function copyProgressPercent(progress) {
  const total = Number(progress?.totalRows ?? 0)
  const processed = Number(progress?.processedRows ?? 0)
  if (total <= 0 || processed <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
}
