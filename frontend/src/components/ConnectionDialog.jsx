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
import { useState, useEffect, useCallback, useRef } from 'react'
import { X, Plus, Trash2, CheckCircle, XCircle, Loader2, FolderOpen } from 'lucide-react'
import {
  listSavedConnections,
  getSavedConnection,
  saveConnection,
  deleteSavedConnection,
  testConnection,
  connectSaved,
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

function makeBlankForm(id) {
  return {
    id:      id ?? crypto.randomUUID(),
    name:    'New Connection',
    comment: '',
    kind:    'mysql',
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

// ─────────────────────────────────────────────────────────────────────────────
// Tab pages
// ─────────────────────────────────────────────────────────────────────────────

function GeneralTab({ form, setForm }) {
  const setField = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const jdbcUrl = `jdbc:mysql://${form.host || 'host'}:${form.port || 3306}/${form.database || ''}`

  return (
    <div className="space-y-3">
      {/* Row 1: Host + Port */}
      <div className="flex gap-3">
        <div className="flex-1">
          <Label>Host</Label>
          <Input value={form.host} onChange={setField('host')} placeholder="127.0.0.1" />
        </div>
        <div className="w-24">
          <Label>Port</Label>
          <Input
            type="number"
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: Number(e.target.value) }))}
            placeholder="3306"
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
          <Input value={form.username} onChange={setField('username')} placeholder="root" />
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
        label="Require TLS/SSL"
      />

      {/* Live URL preview */}
      <div>
        <Label>Connection URL (preview)</Label>
        <Input value={jdbcUrl} readOnly className="font-mono text-xs text-accent" />
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
  const params = form.advancedParams ?? []

  const setParam = (idx, key, value) =>
    setForm((f) => {
      const next = [...f.advancedParams]
      next[idx] = { ...next[idx], [key]: value }
      return { ...f, advancedParams: next }
    })

  const addParam = () =>
    setForm((f) => ({
      ...f,
      advancedParams: [...f.advancedParams, { key: '', value: '', enabled: true }],
    }))

  const removeParam = (idx) =>
    setForm((f) => {
      const next = [...f.advancedParams]
      next.splice(idx, 1)
      return { ...f, advancedParams: next }
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
 *   onConnected — called after successful OK (save + live connect).  Fires
 *                AFTER onSaved and receives the same connId.  Kept separate
 *                because the parent may want to distinguish "saved to disk"
 *                from "actually dialled" (e.g. for status-bar messaging).
 */
export default function ConnectionDialog({ isOpen, onClose, onSaved, onConnected, initialId }) {
  const [savedList,     setSavedList]     = useState([])
  const [selectedId,    setSelectedId]    = useState(null)
  const [form,          setForm]          = useState(() => makeBlankForm())
  const [activeTab,     setActiveTab]     = useState('General')
  const [testResult,    setTestResult]    = useState(null) // { ok: bool, msg: string }
  const [isTesting,     setIsTesting]     = useState(false)
  const [isSaving,      setIsSaving]      = useState(false)
  const [isDirty,       setIsDirty]       = useState(false)
  const prevFormRef     = useRef(null)

  // ── Load saved connections list ─────────────────────────────────────────
  const loadList = useCallback(async () => {
    const list = await listSavedConnections()
    setSavedList(list ?? [])
  }, [])

  const resetToBlank = useCallback(() => {
    const blank = makeBlankForm()
    setForm(blank)
    setSelectedId(null)
    prevFormRef.current = JSON.stringify(blank)
    setIsDirty(false)
    setTestResult(null)
    setActiveTab('General')
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
    const full = await getSavedConnection(id)
    if (!full) return
    // Merge any missing advancedParams presets
    const merged = {
      ...makeBlankForm(full.id),
      ...full,
      advancedParams:
        full.advancedParams?.length > 0
          ? full.advancedParams
          : DEFAULT_ADVANCED.map((p) => ({ ...p })),
    }
    setSelectedId(id)
    setForm(merged)
    prevFormRef.current = JSON.stringify(merged)
    setIsDirty(false)
    setTestResult(null)
  }, [])

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

  // ── Delete selected connection ──────────────────────────────────────────
  const handleDelete = async () => {
    if (!selectedId) return
    if (!window.confirm('Remove this saved connection?')) return
    await deleteSavedConnection(selectedId)
    await loadList()
    handleNew()
  }

  // ── Save (Apply button) ─────────────────────────────────────────────────
  const handleSave = async () => {
    setIsSaving(true)
    try {
      await saveConnection({ ...form })
      prevFormRef.current = JSON.stringify(form)
      setIsDirty(false)
      setSelectedId(form.id)
      await loadList()
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

  // ── OK = Save + Connect ─────────────────────────────────────────────────
  const handleOK = async () => {
    setIsSaving(true)
    try {
      await saveConnection({ ...form })
      // Phase 13: notify parent of the save *before* dialling the live
      // connection so the tree already reflects the new entry by the time
      // the connect call resolves.
      onSaved?.(form.id)
      const connId = await connectSaved(form.id)
      onConnected?.(connId, form.name)
      toast.success(`Connected to ${form.name || form.id}`)
      onClose()
    } catch (err) {
      toast.error(`Connect failed: ${normalizeError(err)}`)
    } finally {
      setIsSaving(false)
    }
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
          <div className="flex items-center justify-between px-3 py-2 border-b border-line-subtle">
            <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
              Data Sources
            </span>
            <div className="flex gap-1">
              <button
                onClick={handleNew}
                title="New connection"
                className="p-0.5 text-fg-muted hover:text-accent hover:bg-hover rounded transition-colors"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={handleDelete}
                title="Remove selected"
                disabled={!selectedId}
                className="p-0.5 text-fg-muted hover:text-danger hover:bg-hover rounded transition-colors disabled:opacity-30"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {/* Saved connections list */}
          <div className="flex-1 overflow-y-auto py-1">
            {savedList.length === 0 && (
              <p className="text-xs text-fg-faint px-3 py-2 italic">No saved connections</p>
            )}
            {savedList.map((c) => (
              <button
                key={c.id}
                onClick={() => selectConnection(c.id)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2
                  ${selectedId === c.id
                    ? 'bg-selected text-accent-text border-l-2 border-accent'
                    : 'text-fg-secondary hover:bg-hover border-l-2 border-transparent'
                  }`}
              >
                <span className="text-xs">🔌</span>
                <span className="truncate">{c.name || c.host}</span>
              </button>
            ))}
          </div>
        </div>

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
