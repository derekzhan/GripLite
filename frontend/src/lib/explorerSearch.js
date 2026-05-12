export function databaseScopeFromSelection(selectedNodeId, connections = [], selectedConnId = '') {
  const selected = String(selectedNodeId ?? '')
  const parts = selected.split('::')

  if (parts[0] === 'db' && parts.length >= 3) {
    return { connId: parts[1], dbName: parts.slice(2).join('::') }
  }

  if (parts[0] === 'folder' && parts.length >= 4) {
    return { connId: parts[2], dbName: parts.slice(3).join('::') }
  }

  if ((parts[0] === 'tbl' || parts[0] === 'col') && parts.length >= 4) {
    return { connId: parts[1], dbName: parts[2] }
  }

  const selectedConnFromNode = parts[0] === 'conn' ? parts.slice(1).join('::') : ''
  const connId = selectedConnFromNode || selectedConnId
  const conn = connections.find((c) => c.id === connId)
  if (conn?.database) {
    return { connId: conn.id, dbName: conn.database }
  }

  return null
}

export function tablesFolderIdForScope(scope) {
  if (!scope?.connId || !scope?.dbName) return ''
  return `folder::tables::${scope.connId}::${scope.dbName}`
}
