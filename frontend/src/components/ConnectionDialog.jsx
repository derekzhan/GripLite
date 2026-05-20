/**
 * ConnectionDialog — DataGrip-style "Data Source Properties" modal.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────┐
 *   │  [+] [-]  Saved connections list  │  Name / Comment   │
 *   │  ─────────────────────────────────│  ─────────────────│
 *   │  > localhost (dev)                │  [General][SSH]   │
 *   │    My Remote DB                   │  [Options][Adv]   │
 *   │                                   │  ‹ tab content ›  │
 *   │                                   │                   │
 *   │                                   │  [Test] [OK] [✕]  │
 *   └────────────────────────────────────────────────────────┘
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { X, Plus, Trash2, CheckCircle, XCircle, Loader2, FolderOpen, Database, Leaf } from 'lucide-react'
import {
  listSavedConnections,
  getSavedConnection,
  saveConnection,
  deleteSavedConnection,
  testConnection,
  openFileDialog,
} from '../lib/bridge'
import { toast } from '../lib/toast'
import { normalizeError } from '../lib/errors'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ADVANCED = [
  { key: 'allowMultiQueries',   value: 'true',  enabled: false },
  { key: 'characterEncoding',   value: 'UTF-8', enabled: false },
  { key: 'useSSL',              value: 'false', enabled: false },
  { key: 'serverTimezone',      value: 'UTC',   enabled: false },
  { key: 'connectTimeout',      value: '30000', enabled: false },
  { key: 'socketTimeout',       value: '60000', enabled: false },
  { key: 'autoReconnect',       value: 'true',  enabled: false },
  { key: 'allowPublicKeyRetrieval', value: 'true', enabled: false },
]
const MONGO_CONNECTION_MODE_PARAM = '_gripliteMongoConnectionMode'
const COLOR_PRESETS = ['', '#6b7280', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899']

function getMongoConnectionMode(form) {
  return form.advancedParams?.find((p) => p.key === MONGO_CONNECTION_MODE_PARAM && p.enabled)?.value === 'srv'
    ? 'srv'
    : 'standard'
}

function setMongoConnectionMode(form, mode) {
  const params = (form.advancedParams ?? []).filter((p) => p.key !== MONGO_CONNECTION_MODE_PARAM)
  return {
    ...form,
    advancedParams: [
      ...params,
      { key: MONGO_CONNECTION_MODE_PARAM, value: mode === 'srv' ? 'srv' : 'standard', enabled: true },
    ],
  }
}

function switchConnectionKind(form, kind) {
  if (kind === form.kind) return form
  if (kind === 'mongodb') {
    return setMongoConnectionMode({
      ...form,
      kind,
      host: form.host === '127.0.0.1' ? 'localhost' : form.host,
      port: 27017,
      username: form.username === 'root' ? '' : form.username,
      tls: true,
      advancedParams: [],
    }, 'standard')
  }
  return {
    ...form,
    kind: 'mysql',
    host: form.host === 'localhost' ? '127.0.0.1' : form.host,
    port: 3306,
    username: form.username || 'root',
    tls: false,
    advancedParams: DEFAULT_ADVANCED.map((p) => ({ ...p })),
  }
}

function makeBlankForm(id) {
  return {
    id:       id ?? crypto.randomUUID(),
    name:     'New Connection',
    comment:  '',
    color:    '',
    readOnly: false,
    kind:     'mysql',
    host:    '127.0.0.1',
    port:    3306,
    username: 'root',
    password: '',
    database: '',
    tls:     false,
    ssh: {
      enabled:        false,
      host:           '',
      port:           22,
      user:           '',
      authType:       'password',
      password:       '',
      privateKeyPath: '',
    },
    advancedParams: DEFAULT_ADVANCED.map((p) => ({ ...p })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function Label({ children }) {
  return (
    <label className="block text-xs text-fg-muted mb-1">{children}</label>
  )
}

function Input({ value, onChange, type = 'text', placeholder, readOnly, className = '' }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={onChange}
      placeholder={placeholder}
      readOnly={readOnly}
      className={`w-full bg-sunken border border-line rounded px-2 py-1 text-sm text-fg-primary
        focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent
        placeholder:text-fg-faint ${readOnly ? 'opacity-60 cursor-not-allowed' : ''} ${className}`}
    />
  )
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={onChange}
      className="w-full bg-sunken border border-line rounded px-2 py-1 text-sm text-fg-primary
        focus:outline-none focus:border-accent"
    >
      {children}
    </select>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <div
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}
      >
        <div
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-fg-on-accent rounded-full shadow transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </div>
      <span className="text-sm text-fg-secondary">{label}</span>
    </label>
  )
}

function SourceIcon({ kind, selected }) {
  const cls = selected ? 'text-fg-on-accent' : 'text-fg-muted'
  if (kind === 'mongodb') return <Leaf size={14} className={cls} />
  return <Database size={14} className={cls} />
}

function ToolbarIconButton({ title, onClick, disabled, children, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={[
        'w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors',
        danger
          ? 'text-fg-muted hover:text-danger hover:bg-hover'
          : 'text-fg-muted hover:text-accent hover:bg-hover',
        disabled ? 'opacity-30 cursor-not-allowed hover:bg-transparent' : '',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab pages
// ─────────────────────────────────────────────────────────────────────────────

function GeneralTab({ form, setForm }) {
  const setField = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))
  const customColorInputRef = useRef(null)

  const isMongo = form.kind === 'mongodb'
  const mongoMode = getMongoConnectionMode(form)
  const isCustomColor = !!form.color && !COLOR_PRESETS.includes(form.color)
  const previewUrl = isMongo
    ? `${mongoMode === 'srv' ? 'mongodb+srv' : 'mongodb'}://${form.host || 'host'}${mongoMode === 'srv' ? '' : `:${form.port || 27017}`}/${form.database || ''}`
    : `jdbc:mysql://${form.host || 'host'}:${form.port || 3306}/${form.database || ''}`

  return (
    <div className="space-y-3">
      {/* Driver kind */}
      <div>
        <Label>Driver</Label>
        <Select
          value={form.kind ?? 'mysql'}
          onChange={(e) => setForm((f) => switchConnectionKind(f, e.target.value))}
        >
          <option value="mysql">MySQL</option>
          <option value="mongodb">MongoDB</option>
        </Select>
      </div>

      {isMongo && (
        <div>
          <Label>Connection type</Label>
          <Select
            value={mongoMode}
            onChange={(e) => setForm((f) => setMongoConnectionMode({
              ...f,
              port: e.target.value === 'srv' ? 27017 : (f.port || 27017),
              tls: e.target.value === 'srv' ? true : f.tls,
            }, e.target.value))}
          >
            <option value="standard">Default</option>
            <option value="srv">MongoDB Atlas (SRV protocol)</option>
          </Select>
        </div>
      )}

      {/* Row 1: Host + Port */}
      <div className="flex gap-3">
        <div className="flex-1">
          <Label>Host</Label>
          <Input value={form.host} onChange={setField('host')} placeholder={isMongo ? 'cluster.example.mongodb.net' : '127.0.0.1'} />
        </div>
        <div className={`w-24 ${isMongo && mongoMode === 'srv' ? 'opacity-50' : ''}`}>
          <Label>Port</Label>
          <Input
            type="number"
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
            placeholder={isMongo ? '27017' : '3306'}
            readOnly={isMongo && mongoMode === 'srv'}
          />
        </div>
      </div>

      {/* Authentication type */}
      <div>
        <Label>Authentication</Label>
        <Select
          value={form.authType ?? 'userpass'}
          onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))}
        >
          <option value="userpass">User &amp; Password</option>
          <option value="none">No auth</option>
        </Select>
      </div>

      {/* Row 2: User + Password */}
      <div className="flex gap-3">
        <div className="flex-1">
          <Label>User</Label>
          <Input value={form.username} onChange={setField('username')} placeholder={isMongo ? 'username' : 'root'} />
        </div>
        <div className="flex-1">
          <Label>Password</Label>
          <Input type="password" value={form.password} onChange={setField('password')} placeholder="••••••••" />
        </div>
      </div>

      {/* Database */}
      <div>
        <Label>Database</Label>
        <Input value={form.database} onChange={setField('database')} placeholder="(optional)" />
      </div>

      {/* TLS toggle */}
      <Toggle
        checked={form.tls}
        onChange={(val) => setForm((f) => ({ ...f, tls: val }))}
        label={isMongo ? 'Require TLS/SSL (recommended for Atlas)' : 'Require TLS/SSL'}
      />

      {/* Color label */}
      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-fg-secondary">Color label</label>
        <div className="flex items-center gap-2">
          {COLOR_PRESETS.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => setForm(f => ({ ...f, color }))}
              title={color || 'Default (no color)'}
              className={[
                'w-5 h-5 rounded-full border-2 transition-all',
                (form.color ?? '') === color
                  ? 'border-fg-primary scale-110'
                  : 'border-transparent hover:border-fg-secondary',
                color === '' ? 'bg-line border border-line-subtle' : '',
              ].join(' ')}
              style={color ? { backgroundColor: color } : {}}
            />
          ))}
          <button
            type="button"
            title="Custom color"
            onClick={() => customColorInputRef.current?.click()}
            className={[
              'relative w-5 h-5 rounded-full border-2 transition-all overflow-hidden',
              isCustomColor
                ? 'border-fg-primary scale-110'
                : 'border-transparent hover:border-fg-secondary',
            ].join(' ')}
            style={{
              background: isCustomColor
                ? form.color
                : 'linear-gradient(135deg, #ef4444 0%, #f97316 18%, #eab308 34%, #22c55e 50%, #06b6d4 66%, #3b82f6 82%, #8b5cf6 100%)',
            }}
          />
          <input
            ref={customColorInputRef}
            type="color"
            value={form.color || '#3b82f6'}
            onChange={(e) => setForm(f => ({ ...f, color: e.target.value }))}
            className="sr-only"
            tabIndex={-1}
            aria-label="Custom color picker"
          />
        </div>
      </div>

      {/* Read-only mode */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!form.readOnly}
            onChange={(e) => setForm(f => ({ ...f, readOnly: e.target.checked }))}
            className="accent-accent w-4 h-4"
          />
          <span className="text-[12px] text-fg-secondary">Read-only mode</span>
        </label>
        <span className="text-[10px] text-fg-muted">
          {isMongo ? 'Blocks MongoDB write/admin operations' : 'Blocks write operations (INSERT/UPDATE/DELETE/DDL)'}
        </span>
      </div>

      {/* Live URL preview */}
      <div>
        <Label>Connection URL (preview)</Label>
        <Input value={previewUrl} readOnly className="font-mono text-xs text-accent" />
      </div>
    </div>
  )
}

function OptionsTab() {
  return (
    <div className="flex flex-col items-center justify-center h-40 text-fg-muted text-sm">
      <p>Driver options coming soon.</p>
    </div>
  )
}

function SSHTab({ form, setForm, onBrowseKey }) {
  const ssh = form.ssh
  const setSSH = (key) => (e) =>
    setForm((f) => ({ ...f, ssh: { ...f.ssh, [key]: e.target.value } }))
  const setSSHBool = (key) => (val) =>
    setForm((f) => ({ ...f, ssh: { ...f.ssh, [key]: val } }))

  return (
    <div className="space-y-3">
      <Toggle
        checked={ssh.enabled}
        onChange={setSSHBool('enabled')}
        label="Use SSH Tunnel"
      />

      {ssh.enabled && (
        <div className="border border-line rounded p-3 space-y-3 mt-2">
          {/* Proxy host + port */}
          <div className="flex gap-3">
            <div className="flex-1">
              <Label>Proxy Host</Label>
              <Input value={ssh.host} onChange={setSSH('host')} placeholder="jump.example.com" />
            </div>
            <div className="w-24">
              <Label>Port</Label>
              <Input
                type="number"
                value={ssh.port}
                onChange={(e) =>
                  setForm((f) => ({ ...f, ssh: { ...f.ssh, port: Number(e.target.value) } }))
                }
                placeholder="22"
              />
            </div>
          </div>

          {/* Proxy user */}
          <div>
            <Label>Proxy User</Label>
            <Input value={ssh.user} onChange={setSSH('user')} placeholder="ubuntu" />
          </div>

          {/* Auth type */}
          <div>
            <Label>Auth Type</Label>
            <Select
              value={ssh.authType}
              onChange={(e) =>
                setForm((f) => ({ ...f, ssh: { ...f.ssh, authType: e.target.value } }))
              }
            >
              <option value="password">Password</option>
              <option value="keyPair">Key Pair</option>
            </Select>
          </div>

          {/* Password or key path */}
          {ssh.authType === 'password' ? (
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={ssh.password}
                onChange={setSSH('password')}
                placeholder="••••••••"
              />
            </div>
          ) : (
            <div>
              <Label>Private Key File</Label>
              <div className="flex gap-2">
                <Input
                  value={ssh.privateKeyPath}
                  onChange={setSSH('privateKeyPath')}
                  placeholder="/home/user/.ssh/id_rsa"
                  className="flex-1"
                />
                <button
                  onClick={onBrowseKey}
                  className="px-2 py-1 bg-elevated hover:bg-hover text-fg-secondary rounded text-sm flex items-center gap-1"
                >
                  <FolderOpen size={13} />
                  Browse
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AdvancedTab({ form, setForm }) {
  const params = (form.advancedParams ?? []).filter((p) => p.key !== MONGO_CONNECTION_MODE_PARAM)

  const setParam = (idx, key, value) =>
    setForm((f) => {
      const visible = (f.advancedParams ?? []).filter((p) => p.key !== MONGO_CONNECTION_MODE_PARAM)
      visible[idx] = { ...visible[idx], [key]: value }
      const hidden = (f.advancedParams ?? []).filter((p) => p.key === MONGO_CONNECTION_MODE_PARAM)
      const next = [...visible, ...hidden]
      return { ...f, advancedParams: next }
    })

  const addParam = () =>
    setForm((f) => ({
      ...f,
      advancedParams: [...(f.advancedParams ?? []), { key: '', value: '', enabled: true }],
    }))

  const removeParam = (idx) =>
    setForm((f) => {
      const visible = (f.advancedParams ?? []).filter((p) => p.key !== MONGO_CONNECTION_MODE_PARAM)
      visible.splice(idx, 1)
      const hidden = (f.advancedParams ?? []).filter((p) => p.key === MONGO_CONNECTION_MODE_PARAM)
      return { ...f, advancedParams: [...visible, ...hidden] }
    })

  return (
    <div>
      <p className="text-xs text-fg-muted mb-2">
        Key-value parameters appended to the driver DSN query string.
      </p>
      <div className="border border-line rounded overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[24px_1fr_1fr_24px] gap-0 bg-elevated border-b border-line-subtle">
          <div className="px-2 py-1" />
          <div className="px-2 py-1 text-xs font-medium text-fg-muted">Parameter</div>
          <div className="px-2 py-1 text-xs font-medium text-fg-muted">Value</div>
          <div className="px-2 py-1" />
        </div>
        {/* Rows */}
        <div className="max-h-52 overflow-y-auto">
          {params.map((p, i) => (
            <div
              key={i}
              className="grid grid-cols-[24px_1fr_1fr_24px] gap-0 border-b border-line-subtle hover:bg-hover"
            >
              {/* Enabled checkbox */}
              <div className="flex items-center justify-center px-1">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => setParam(i, 'enabled', e.target.checked)}
                  className="accent-[var(--accent)]"
                />
              </div>
              {/* Key */}
              <div className="px-1 py-0.5">
                <input
                  value={p.key}
                  onChange={(e) => setParam(i, 'key', e.target.value)}
                  className="w-full bg-transparent text-xs text-fg-primary outline-none px-1 py-0.5
                    focus:bg-sunken rounded"
                  placeholder="paramName"
                />
              </div>
              {/* Value */}
              <div className="px-1 py-0.5">
                <input
                  value={p.value}
                  onChange={(e) => setParam(i, 'value', e.target.value)}
                  className="w-full bg-transparent text-xs text-fg-primary outline-none px-1 py-0.5
                    focus:bg-sunken rounded"
                  placeholder="value"
                />
              </div>
              {/* Remove */}
              <div className="flex items-center justify-center px-1">
                <button
                  onClick={() => removeParam(i)}
                  className="text-fg-faint hover:text-danger transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <button
        onClick={addParam}
        className="mt-2 flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
      >
        <Plus size={12} />
        Add parameter
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dialog
// ─────────────────────────────────────────────────────────────────────────────

const TABS = ['General', 'Options', 'SSH/SSL', 'Advanced']

/**
 * Props
 * ─────
 *   isOpen     — controls visibility
 *   initialId  — pre-select a saved connection (null = blank form / new entry)
 *   onClose    — called when user dismisses the dialog
 *   onSaved    — called after EVERY successful save (Apply / OK) with the
 *                persisted connection's id.  Lets the parent refresh its
 *                DatabaseExplorer tree and auto-select the new entry.
 *                (Phase 13 / Task 2)
 *   onDeleted  — called after a saved connection is deleted so the parent can
 *                remove it from the Explorer immediately.
 *   onConnected — legacy callback kept for callers that treat OK as an
 *                accepted saved connection. OK no longer opens the database;
 *                users connect explicitly via Test / Explorer context menu.
 */
export default function ConnectionDialog({ isOpen, onClose, onSaved, onDeleted, onConnected, initialId, connections: externalConnections = [] }) {
  const [savedList,     setSavedList]     = useState([])
  const [selectedId,    setSelectedId]    = useState(null)
  const [form,          setForm]          = useState(() => makeBlankForm())
  const [activeTab,     setActiveTab]     = useState('General')
  const [testResult,    setTestResult]    = useState(null) // { ok: bool, msg: string }
  const [isTesting,     setIsTesting]     = useState(false)
  const [isSaving,      setIsSaving]      = useState(false)
  const [isDirty,       setIsDirty]       = useState(false)
  const [deletedIds,    setDeletedIds]    = useState(() => new Set())
  const [deleteConfirmId, setDeleteConfirmId] = useState(null)
  const [isDeleting,    setIsDeleting]    = useState(false)
  const prevFormRef     = useRef(null)
  const selectionRequestRef = useRef(0)
  const isOpenRef = useRef(false)

  useEffect(() => {
    isOpenRef.current = isOpen
    if (!isOpen) selectionRequestRef.current += 1
  }, [isOpen])

  // ── Load saved connections list ─────────────────────────────────────────
  const loadList = useCallback(async () => {
    const list = await listSavedConnections()
    setSavedList(list ?? [])
  }, [])
  const visibleConnections = useMemo(
    () => (savedList.length > 0 ? savedList : externalConnections).filter((conn) => !deletedIds.has(conn.id)),
    [deletedIds, externalConnections, savedList],
  )
  const deleteTarget = useMemo(
    () => visibleConnections.find((conn) => conn.id === deleteConfirmId) ?? null,
    [deleteConfirmId, visibleConnections],
  )

  const applyConnectionForm = useCallback((conn, { dirty = false } = {}) => {
    if (!conn) return
    const merged = {
      ...makeBlankForm(conn.id),
      ...conn,
      advancedParams:
        conn.advancedParams?.length > 0
          ? conn.advancedParams
          : DEFAULT_ADVANCED.map((p) => ({ ...p })),
    }
    setForm(merged)
    prevFormRef.current = JSON.stringify(merged)
    setIsDirty(dirty)
  }, [])

  const resetToBlank = useCallback(() => {
    selectionRequestRef.current += 1
    const blank = makeBlankForm()
    setForm(blank)
    setSelectedId(null)
    prevFormRef.current = JSON.stringify(blank)
    setIsDirty(false)
    setTestResult(null)
    setActiveTab('General')
    setDeleteConfirmId(null)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    loadList()
    // If an initialId was provided (right-click → Properties), pre-select it.
    if (initialId) {
      selectConnection(initialId)
    } else {
      resetToBlank()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialId])

  // ── Select a connection from the list ───────────────────────────────────
  const selectConnection = useCallback(async (id) => {
    const requestId = ++selectionRequestRef.current
    const fallback = visibleConnections.find((conn) => conn.id === id) ?? null
    setSelectedId(id)
    setDeleteConfirmId(null)
    setTestResult(null)
    setActiveTab('General')
    if (fallback) applyConnectionForm(fallback, { dirty: false })
    let full = null
    try {
      full = await getSavedConnection(id)
    } catch {
      full = fallback
    }
    if (requestId !== selectionRequestRef.current || !isOpenRef.current) return
    if (!full) return
    applyConnectionForm(full, { dirty: false })
  }, [applyConnectionForm, visibleConnections])

  // Track dirty state
  useEffect(() => {
    if (prevFormRef.current === null) {
      prevFormRef.current = JSON.stringify(form)
      return
    }
    setIsDirty(JSON.stringify(form) !== prevFormRef.current)
  }, [form])

  // ── Create new connection ───────────────────────────────────────────────
  const handleNew = () => {
    resetToBlank()
  }

  const handleNewMongoDB = () => {
    selectionRequestRef.current += 1
    const blank = switchConnectionKind(makeBlankForm(), 'mongodb')
    setForm({
      ...blank,
      name: 'New MongoDB Connection',
      database: 'admin',
    })
    setSelectedId(null)
    prevFormRef.current = JSON.stringify(blank)
    setIsDirty(true)
    setTestResult(null)
    setActiveTab('General')
    setDeleteConfirmId(null)
  }

  // ── Delete selected connection ──────────────────────────────────────────
  const handleDelete = () => {
    const id = selectedId
    if (!id) return
    setDeleteConfirmId(id)
  }

  const confirmDelete = async () => {
    const id = deleteConfirmId
    if (!id || isDeleting) return
    const previousSelection = visibleConnections.find((conn) => conn.id === id) ?? null
    setIsDeleting(true)
    setDeletedIds((prev) => new Set([...prev, id]))
    setSavedList((prev) => prev.filter((conn) => conn.id !== id))
    try {
      await deleteSavedConnection(id)
      await loadList()
      onDeleted?.(id)
      setDeleteConfirmId(null)
      toast.success(`Deleted "${previousSelection?.name || id}"`)
      onClose()
    } catch (err) {
      setDeletedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      if (previousSelection) selectConnection(id)
      toast.error(`Delete failed: ${normalizeError(err)}`)
    } finally {
      setIsDeleting(false)
    }
  }

  // ── Save (Apply button) ─────────────────────────────────────────────────
  const handleSave = async () => {
    setIsSaving(true)
    try {
      await saveConnection({ ...form })
      prevFormRef.current = JSON.stringify(form)
      setIsDirty(false)
      setSelectedId(form.id)
      loadList().catch(() => {})
      // Phase 13: notify parent so the Explorer tree can refresh and
      // auto-select the just-saved connection, even though the dialog
      // stays open.
      onSaved?.(form.id)
      toast.success(`Saved "${form.name || form.id}"`)
    } catch (err) {
      // Never feed a raw unknown into any UI: normalizeError always
      // returns a string, and toast avoids the modal-blocking alert().
      toast.error(`Save failed: ${normalizeError(err)}`)
    } finally {
      setIsSaving(false)
    }
  }

  // ── Test connection ─────────────────────────────────────────────────────
  const handleTest = async () => {
    setIsTesting(true)
    setTestResult(null)
    try {
      const msg = await testConnection(form)
      setTestResult({ ok: true, msg })
    } catch (err) {
      setTestResult({ ok: false, msg: normalizeError(err) })
    } finally {
      setIsTesting(false)
    }
  }

  // ── OK = Save + Close ───────────────────────────────────────────────────
  const handleOK = () => {
    if (!selectedId && !isDirty) {
      onClose()
      return
    }

    const payload = { ...form }
    prevFormRef.current = JSON.stringify(payload)
    setIsDirty(false)
    setSelectedId(payload.id)
    onClose()

    const savePromise = saveConnection(payload)
    savePromise
      .then(() => {
        onSaved?.(payload.id)
        onConnected?.(payload.id, payload.name)
        toast.success(`Saved "${payload.name || payload.id}"`)
      })
      .catch((err) => {
        toast.error(`Save failed: ${normalizeError(err)}`)
      })
  }

  // ── Browse for private key file ─────────────────────────────────────────
  const handleBrowseKey = async () => {
    const path = await openFileDialog('Select SSH Private Key')
    if (path) {
      setForm((f) => ({ ...f, ssh: { ...f.ssh, privateKeyPath: path } }))
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog surface */}
      <div className="relative z-10 flex w-[860px] h-[580px] bg-panel border border-line rounded-lg shadow-2xl overflow-hidden">

        {/* ── Left panel: saved connections list ─────────────────────────── */}
        <div className="w-56 flex-shrink-0 border-r border-line bg-titlebar flex flex-col">
          {/* List header */}
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line-subtle">
            <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider whitespace-nowrap">
              Data Sources
            </span>
            <div className="flex items-center gap-0.5">
              <ToolbarIconButton
                onClick={handleNew}
                title="New MySQL connection"
              >
                <Plus size={12} className="-mr-0.5" />
                <Database size={14} />
              </ToolbarIconButton>
              <ToolbarIconButton
                onClick={handleNewMongoDB}
                title="New MongoDB connection"
              >
                <Plus size={12} className="-mr-0.5" />
                <Leaf size={14} />
              </ToolbarIconButton>
              <ToolbarIconButton
                onClick={handleDelete}
                title="Remove selected"
                disabled={!selectedId || isDeleting}
                danger
              >
                {isDeleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
              </ToolbarIconButton>
            </div>
          </div>

          {/* Saved connections list */}
          <div className="flex-1 overflow-y-auto py-1">
            {visibleConnections.length === 0 && (
              <p className="text-xs text-fg-faint px-3 py-2 italic">No saved connections</p>
            )}
            {visibleConnections.map((c) => (
              <button
                key={c.id}
                onClick={() => selectConnection(c.id)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2
                  ${selectedId === c.id
                    ? 'bg-selected text-fg-on-accent border-l-2 border-accent'
                    : 'text-fg-secondary hover:bg-hover border-l-2 border-transparent'
                  }`}
              >
                <SourceIcon kind={c.kind} selected={selectedId === c.id} />
                <span className="truncate">{c.name || c.host}</span>
              </button>
            ))}
          </div>
        </div>

        {deleteConfirmId && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-connection-title"
              className="w-[340px] rounded-lg border border-line bg-panel shadow-2xl p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="delete-connection-title" className="text-sm font-semibold text-fg-primary">
                Delete data source?
              </h3>
              <p className="mt-2 text-xs text-fg-secondary">
                This will remove the saved connection from the Explorer.
              </p>
              <div className="mt-3 rounded bg-sunken border border-line px-2 py-1.5 text-xs text-fg-primary truncate">
                {deleteTarget?.name || deleteConfirmId}
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-3 py-1.5 rounded bg-elevated hover:bg-hover text-xs text-fg-secondary transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={confirmDelete}
                  className="px-3 py-1.5 rounded bg-danger text-fg-on-accent hover:brightness-110 text-xs transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isDeleting && <Loader2 size={12} className="animate-spin" />}
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Right panel: edit form ─────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Dialog title bar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-line-subtle">
            <h2 className="text-sm font-semibold text-fg-primary">Data Source Properties</h2>
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg-primary p-1 rounded hover:bg-hover transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          {/* Name + Comment */}
          <div className="px-4 pt-3 pb-2 border-b border-line-subtle grid grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="My Connection"
              />
            </div>
            <div>
              <Label>Comment</Label>
              <Input
                value={form.comment}
                onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
                placeholder="Optional note…"
              />
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex gap-0 border-b border-line-subtle px-4 pt-1">
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px
                  ${activeTab === tab
                    ? 'border-accent text-accent-text'
                    : 'border-transparent text-fg-muted hover:text-fg-primary'
                  }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {activeTab === 'General'  && <GeneralTab  form={form} setForm={setForm} />}
            {activeTab === 'Options'  && <OptionsTab />}
            {activeTab === 'SSH/SSL'  && <SSHTab form={form} setForm={setForm} onBrowseKey={handleBrowseKey} />}
            {activeTab === 'Advanced' && <AdvancedTab form={form} setForm={setForm} />}
          </div>

          {/* Test result banner */}
          {testResult && (
            <div
              className={`mx-4 mb-2 px-3 py-2 rounded text-xs flex items-start gap-2
                ${testResult.ok
                  ? 'bg-success/10 border border-success/40 text-success'
                  : 'bg-danger-bg border border-danger/40 text-danger'
                }`}
            >
              {testResult.ok
                ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" />
                : <XCircle    size={13} className="flex-shrink-0 mt-0.5" />
              }
              <span className="break-all">{testResult.msg}</span>
            </div>
          )}

          {/* Bottom action bar */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-line-subtle bg-titlebar">
            {/* Test connection */}
            <button
              onClick={handleTest}
              disabled={isTesting}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-elevated hover:bg-hover
                text-fg-primary rounded transition-colors disabled:opacity-50"
            >
              {isTesting
                ? <Loader2 size={12} className="animate-spin" />
                : <CheckCircle size={12} />
              }
              Test Connection
            </button>

            {/* Right: Save / OK / Cancel */}
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={isSaving || !isDirty}
                className="px-3 py-1.5 text-xs bg-elevated hover:bg-hover text-fg-primary rounded
                  transition-colors disabled:opacity-40"
              >
                {isSaving ? 'Saving…' : 'Apply'}
              </button>
              <button
                onClick={handleOK}
                disabled={isSaving}
                className="px-4 py-1.5 text-xs bg-accent hover:bg-accent-hover text-fg-on-accent rounded
                  transition-colors disabled:opacity-50 font-medium"
              >
                OK
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs bg-elevated hover:bg-hover text-fg-primary rounded
                  transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
