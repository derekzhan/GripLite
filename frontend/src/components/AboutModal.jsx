/**
 * AboutModal — Phase 18 "Help → About GripLite" dialog.
 *
 * Layout
 * ──────
 *   ┌───────────────────────────────────────────────┐
 *   │           ⚡  GripLite                         │
 *   │   Lightweight Cross-Platform Database Client  │
 *   ├───────────────────────────────────────────────┤
 *   │  Version      v0.1.1                          │
 *   │  Build Date   2026-04-16                      │
 *   │  Platform     Wails + React / Go              │
 *   │  License      MIT                             │
 *   ├───────────────────────────────────────────────┤
 *   │         GitHub  •  zhanweichun@gmail.com        │
 *   │                    [ Close ]                  │
 *   └───────────────────────────────────────────────┘
 *
 * The modal is fully theme-aware — background, text, and border colours all
 * come from the --card-bg / --fg-* CSS variables defined in style.css.
 */
import { useEffect, useState } from 'react'
import { X, ExternalLink, Mail, Zap } from 'lucide-react'
// Note: lucide-react v1.x bundled with this project does not ship a GitHub
// logo icon, so we use the generic ExternalLink glyph for the repo link.
// When we upgrade to lucide-react >= 0.3xx we can swap this for Github.
import { getBuildInfo } from '../lib/bridge'
import { normalizeError } from '../lib/errors'

export default function AboutModal({ isOpen, onClose }) {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState('')

  // Load build info whenever the modal is opened.  We re-fetch each open so
  // users see fresh data after a hot-reload in dev.
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    getBuildInfo()
      .then((b) => { if (!cancelled) setInfo(b) })
      .catch((e) => { if (!cancelled) setError(normalizeError(e)) })
    return () => { cancelled = true }
  }, [isOpen])

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const openExternal = async (href) => {
    try {
      if (window?.runtime?.BrowserOpenURL) {
        const { BrowserOpenURL } = await import('../../wailsjs/runtime/runtime')
        BrowserOpenURL(href)
        return
      }
      window.open(href, '_blank', 'noopener,noreferrer')
    } catch {
      try { window.location.href = href } catch { /* ignore */ }
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="modal-enter w-[420px] max-w-[92vw] rounded-lg overflow-hidden
                   bg-[color:var(--card-bg)]
                   border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        {/* Close button (no header bar — keeps the card clean) */}
        <div className="relative">
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="absolute right-2 top-2 w-7 h-7 flex items-center justify-center rounded
                       text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)]
                       hover:bg-black/5 dark:hover:bg-white/10 transition-colors z-10"
          >
            <X size={15} />
          </button>

          {/* ── Hero ─────────────────────────────────────────────────── */}
          <div className="px-8 pt-8 pb-5 text-center">
            <div className="w-14 h-14 mx-auto flex items-center justify-center rounded-xl
                            bg-gradient-to-br from-[#0e639c] to-[#1fb6d1]
                            shadow-lg shadow-[#0e639c]/30">
              <Zap size={28} className="text-white" strokeWidth={2} />
            </div>

            <h2 className="mt-4 text-[20px] font-semibold text-[color:var(--fg-primary)]">
              {info?.name ?? 'GripLite'}
            </h2>
            <p className="mt-1 text-[12px] text-[color:var(--fg-muted)] leading-relaxed">
              Lightweight Cross-Platform Database Client
            </p>
          </div>

          {/* ── Version table ────────────────────────────────────────── */}
          <div className="px-8 pb-5">
            <div className="rounded-md border border-[color:var(--border-subtle)]
                            bg-black/[0.02] dark:bg-white/[0.02] px-4 py-3">
              {error ? (
                <div className="text-[12px] text-red-500">Failed to load build info: {error}</div>
              ) : !info ? (
                <div className="text-[12px] text-[color:var(--fg-muted)] text-center py-2">Loading…</div>
              ) : (
                <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 gap-x-3 text-[12px]">
                  <InfoRow label="Version"    value={info.version} mono />
                  <InfoRow label="Build Date" value={info.buildDate} mono />
                  <InfoRow label="Platform"   value={info.platform} />
                  <InfoRow label="Runtime"    value={info.goVersion} mono subtle />
                  <InfoRow label="License"    value={info.license} />
                </dl>
              )}
            </div>
          </div>

          {/* ── Links ────────────────────────────────────────────────── */}
          <div className="px-8 pb-6 flex flex-col items-center gap-2.5">
            <div className="flex items-center gap-2">
              <LinkChip
                Icon={ExternalLink}
                label="GitHub"
                onClick={() => info?.homepage && openExternal(info.homepage)}
                disabled={!info?.homepage}
              />
              <LinkChip
                Icon={Mail}
                label={info?.email ?? ''}
                onClick={() => info?.email && openExternal(`mailto:${info.email}`)}
                disabled={!info?.email}
              />
            </div>

            <button
              onClick={onClose}
              className="mt-2 px-6 py-1.5 rounded text-[12px] font-medium
                         bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)]
                         text-[color:var(--fg-on-accent)] transition-colors"
            >
              Close
            </button>
          </div>

          {/* Tiny footer */}
          <div className="border-t border-[color:var(--border-subtle)] px-8 py-2
                          text-center text-[10px] text-[color:var(--fg-muted)]">
            © {new Date().getFullYear()} {info?.author ?? 'derek'} — Made with ❤ for DBAs everywhere
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentational helpers (co-located so there's nothing to export here)
// ─────────────────────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono = false, subtle = false }) {
  return (
    <>
      <dt className="text-[color:var(--fg-muted)] font-medium">{label}</dt>
      <dd className={[
        subtle ? 'text-[color:var(--fg-muted)]' : 'text-[color:var(--fg-primary)]',
        mono ? 'font-mono tabular-nums text-[11.5px]' : '',
        'truncate',
      ].join(' ')} title={value ?? ''}>
        {value || '—'}
      </dd>
    </>
  )
}

function LinkChip({ Icon, label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex items-center gap-1.5 px-3 py-1 rounded-full text-[11.5px]',
        'border border-[color:var(--border-strong)]',
        'bg-black/[0.02] dark:bg-white/[0.03]',
        'transition-colors',
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-accent)] hover:border-[color:var(--accent)] cursor-pointer',
        'text-[color:var(--fg-secondary)]',
      ].join(' ')}
    >
      <Icon size={12} strokeWidth={1.8} />
      <span className="max-w-[180px] truncate">{label}</span>
    </button>
  )
}
