/**
 * toast.jsx — a tiny, zero-dependency toast system.
 *
 * Why not `sonner` / `react-hot-toast`?
 *   • The Wails bundle is already warning at >500 KiB; adding another
 *     runtime would make the hot reload slower for little gain.
 *   • We need full theme-token integration (light / dark / system) —
 *     writing 80 lines here is cheaper than re-skinning a library.
 *
 * Public API (matches the common toast() shape so it's trivial to swap
 * in sonner later if we ever want):
 *
 *     import { toast, Toaster } from '../lib/toast'
 *
 *     toast('Saved')                   // default style
 *     toast.success('Row inserted')    // green
 *     toast.error('Save failed: …')    // red
 *     toast.info('Synced 4 tables')    // blue
 *
 *     // options: toast('msg', { duration: 6000, id: 'sync' })
 *     // Passing `id` will REPLACE an existing toast with the same id —
 *     // useful for progressive updates ("Saving…" → "Saved").
 *
 *     toast.dismiss(id)                // remove a specific one
 *     toast.clear()                    // wipe all
 *
 * Mount <Toaster /> ONCE near the root of the app.
 */

import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'

// ─────────────────────────────────────────────────────────────────────────
// Store (module singleton) — a mini pub/sub so any component can dispatch.
// ─────────────────────────────────────────────────────────────────────────

let toastSeq = 0
const listeners = new Set()
let state = []   // [{ id, kind, message, duration }]

const emit = (next) => {
  state = next
  listeners.forEach((l) => l(state))
}

const push = (kind, message, opts = {}) => {
  const id = opts.id ?? `t${++toastSeq}`
  const duration = opts.duration ?? (kind === 'error' ? 6000 : 3500)
  const entry = { id, kind, message: String(message ?? ''), duration }
  // If an id already exists, replace in place to keep stacking order.
  const existing = state.findIndex((t) => t.id === id)
  if (existing >= 0) {
    const next = state.slice()
    next[existing] = entry
    emit(next)
  } else {
    emit([...state, entry])
  }
  return id
}

// ─────────────────────────────────────────────────────────────────────────
// Public handle
// ─────────────────────────────────────────────────────────────────────────

function base(message, opts) { return push('default', message, opts) }
base.success = (message, opts) => push('success', message, opts)
base.error   = (message, opts) => push('error',   message, opts)
base.info    = (message, opts) => push('info',    message, opts)
base.warn    = (message, opts) => push('warn',    message, opts)
base.dismiss = (id) => emit(state.filter((t) => t.id !== id))
base.clear   = () => emit([])

export const toast = base

// ─────────────────────────────────────────────────────────────────────────
// Toaster component — renders the stack in a portal at the bottom right.
// ─────────────────────────────────────────────────────────────────────────

const KIND_STYLES = {
  default: { bg: 'var(--bg-elevated)', border: 'var(--border)',           fg: 'var(--fg-primary)', icon: '•' },
  success: { bg: 'var(--bg-elevated)', border: 'color-mix(in srgb, var(--success) 50%, transparent)', fg: 'var(--success)',    icon: '✓' },
  error:   { bg: 'var(--danger-bg)',   border: 'color-mix(in srgb, var(--danger) 50%, transparent)',  fg: 'var(--danger)',     icon: '✕' },
  info:    { bg: 'var(--bg-elevated)', border: 'color-mix(in srgb, var(--accent) 45%, transparent)',  fg: 'var(--accent-text)',icon: 'i' },
  warn:    { bg: 'var(--warn-bg)',     border: 'color-mix(in srgb, var(--warn) 50%, transparent)',    fg: 'var(--warn)',       icon: '!' },
}

export function Toaster() {
  const [toasts, setToasts] = useState(state)

  useEffect(() => {
    const listener = (next) => setToasts(next)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])

  // Render the portal target lazily so SSR / unit tests don't crash.
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 items-end pointer-events-none"
      // Don't let the toast stack trap focus or cover the whole screen.
      style={{ maxWidth: 'min(90vw, 420px)' }}
    >
      {toasts.map((t) => <ToastItem key={t.id} toast={t} />)}
    </div>,
    document.body,
  )
}

function ToastItem({ toast: t }) {
  const s = KIND_STYLES[t.kind] ?? KIND_STYLES.default
  const timerRef = useRef(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (t.duration <= 0) return
    timerRef.current = setTimeout(() => {
      setLeaving(true)
      // Let the CSS transition run before we actually remove.
      setTimeout(() => toast.dismiss(t.id), 180)
    }, t.duration)
    return () => clearTimeout(timerRef.current)
  }, [t.id, t.duration])

  return (
    <div
      role="status"
      onClick={() => toast.dismiss(t.id)}
      className={[
        'pointer-events-auto cursor-pointer select-text',
        'flex items-start gap-2 px-3 py-2 rounded shadow-xl border',
        'text-[12.5px] leading-snug font-mono',
        'transition-all duration-150',
        leaving ? 'opacity-0 translate-x-2' : 'opacity-100 translate-x-0',
      ].join(' ')}
      style={{
        background:   s.bg,
        borderColor:  s.border,
        color:        s.fg,
        maxWidth:     '420px',
        whiteSpace:   'pre-wrap',
        wordBreak:    'break-word',
      }}
    >
      <span className="flex-shrink-0 font-bold">{s.icon}</span>
      <span className="flex-1">{t.message}</span>
      <span
        className="text-[10px] opacity-40 hover:opacity-80 flex-shrink-0"
        title="Dismiss"
      >
        ×
      </span>
    </div>
  )
}
