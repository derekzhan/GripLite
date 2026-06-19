/**
 * SettingsModal — user preferences dialog (opened from the menu bar).
 *
 * Currently hosts the Database Explorer ordering preference; structured so more
 * settings can be appended as additional rows without reworking the layout.
 * Theme-aware via the same --card-bg / --fg-* CSS variables as the other
 * modals.
 */
import { useEffect, useState } from 'react'
import { X, Settings as SettingsIcon, Sun, Moon, Monitor } from 'lucide-react'
import {
  DEFAULT_TABLE_USAGE_TOP_N,
  MIN_TABLE_USAGE_TOP_N,
  MAX_TABLE_USAGE_TOP_N,
  clampTableUsageTopN,
  saveTableUsageTopN,
  EDITOR_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  GRID_FONT_OPTIONS,
  MIN_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MIN_UI_FONT_SIZE,
  MAX_UI_FONT_SIZE,
  MIN_GRID_FONT_SIZE,
  MAX_GRID_FONT_SIZE,
} from '../lib/settings'
import { useTheme } from '../theme/ThemeProvider'
import { useFontSettings } from '../settings/FontSettingsProvider'

const THEME_OPTIONS = [
  { id: 'light',  label: 'Light',  Icon: Sun },
  { id: 'dark',   label: 'Dark',   Icon: Moon },
  { id: 'system', label: 'System', Icon: Monitor },
]

/** A labelled font-family select + size stepper, applied live on change. */
function FontRow({ label, options, family, size, minSize, maxSize, onFamily, onSize }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label className="text-[12px] font-medium text-[color:var(--fg-primary)] w-24 shrink-0">
        {label}
      </label>
      <div className="flex items-center gap-2 flex-1 justify-end">
        <select
          value={family}
          onChange={(e) => onFamily(e.target.value)}
          className="min-w-0 flex-1 max-w-[200px] px-2 py-1 rounded text-[12px]
                     bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)]
                     border border-[color:var(--border-strong)]
                     outline-none focus:border-[color:var(--accent)]"
        >
          {options.map((o) => (
            <option key={o.label} value={o.value}>{o.label}</option>
          ))}
        </select>
        <input
          type="number"
          min={minSize}
          max={maxSize}
          step={1}
          value={size}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n)) onSize(n)
          }}
          title="Font size (px)"
          className="shrink-0 w-16 px-2 py-1 rounded text-[12px] text-right tabular-nums
                     bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)]
                     border border-[color:var(--border-strong)]
                     outline-none focus:border-[color:var(--accent)]"
        />
        <span className="text-[11px] text-[color:var(--fg-muted)] w-3">px</span>
      </div>
    </div>
  )
}

export default function SettingsModal({ isOpen, onClose, tableUsageTopN, onChangeTableUsageTopN }) {
  const { theme, setTheme } = useTheme()
  const {
    editorFontFamily, editorFontSize, uiFontFamily, uiFontSize, gridFontFamily, gridFontSize,
    setEditorFontFamily, setEditorFontSize, setUiFontFamily, setUiFontSize,
    setGridFontFamily, setGridFontSize,
  } = useFontSettings()
  const [draft, setDraft] = useState(String(tableUsageTopN ?? DEFAULT_TABLE_USAGE_TOP_N))

  // Re-sync the input whenever the modal opens or the external value changes.
  useEffect(() => {
    if (isOpen) setDraft(String(tableUsageTopN ?? DEFAULT_TABLE_USAGE_TOP_N))
  }, [isOpen, tableUsageTopN])

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // Persist + lift the clamped value, and snap the input back to it.
  const commitTopN = (raw) => {
    const n = clampTableUsageTopN(raw)
    saveTableUsageTopN(n)
    onChangeTableUsageTopN?.(n)
    setDraft(String(n))
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center overlay-enter"
      style={{ background: 'var(--bg-overlay)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}
    >
      <div
        className="modal-enter w-[460px] max-w-[92vw] rounded-lg overflow-hidden
                   bg-[color:var(--card-bg)]
                   border border-[color:var(--border-strong)]"
        style={{ boxShadow: 'var(--card-shadow)' }}
      >
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3
                        border-b border-[color:var(--border-subtle)]">
          <div className="flex items-center gap-2 text-[color:var(--fg-primary)]">
            <SettingsIcon size={15} strokeWidth={2} />
            <h2 className="text-[13px] font-semibold">Settings</h2>
          </div>
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="w-7 h-7 flex items-center justify-center rounded
                       text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)]
                       hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div className="px-5 py-4 space-y-5">
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide
                           text-[color:var(--fg-muted)] mb-2">
              Appearance
            </h3>

            <div className="flex items-center justify-between gap-4">
              <label className="text-[12px] font-medium text-[color:var(--fg-primary)]">
                Theme
              </label>
              <div className="flex items-center gap-1 p-0.5 rounded-md
                              bg-black/[0.04] dark:bg-white/[0.04]
                              border border-[color:var(--border-subtle)]">
                {THEME_OPTIONS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    onClick={() => setTheme(id)}
                    title={label}
                    className={[
                      'flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-colors',
                      theme === id
                        ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-accent)]'
                        : 'text-[color:var(--fg-secondary)] hover:text-[color:var(--fg-primary)] hover:bg-black/5 dark:hover:bg-white/10',
                    ].join(' ')}
                  >
                    <Icon size={13} strokeWidth={1.8} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide
                           text-[color:var(--fg-muted)] mb-2">
              Fonts
            </h3>
            <div className="space-y-2.5">
              <FontRow
                label="Console"
                options={EDITOR_FONT_OPTIONS}
                family={editorFontFamily}
                size={editorFontSize}
                minSize={MIN_EDITOR_FONT_SIZE}
                maxSize={MAX_EDITOR_FONT_SIZE}
                onFamily={setEditorFontFamily}
                onSize={setEditorFontSize}
              />
              <FontRow
                label="Interface"
                options={UI_FONT_OPTIONS}
                family={uiFontFamily}
                size={uiFontSize}
                minSize={MIN_UI_FONT_SIZE}
                maxSize={MAX_UI_FONT_SIZE}
                onFamily={setUiFontFamily}
                onSize={setUiFontSize}
              />
              <FontRow
                label="Result grid"
                options={GRID_FONT_OPTIONS}
                family={gridFontFamily}
                size={gridFontSize}
                minSize={MIN_GRID_FONT_SIZE}
                maxSize={MAX_GRID_FONT_SIZE}
                onFamily={setGridFontFamily}
                onSize={setGridFontSize}
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
              Changes apply instantly. Interface size scales the whole app; the
              console and result grid keep their own sizes independently.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide
                           text-[color:var(--fg-muted)] mb-2">
              Database Explorer
            </h3>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label
                  htmlFor="settings-table-top-n"
                  className="block text-[12px] font-medium text-[color:var(--fg-primary)]"
                >
                  Pin most-used tables to top
                </label>
                <p className="mt-0.5 text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
                  The top tables by usage frequency stay pinned; everything else
                  is listed alphabetically by name.
                </p>
              </div>

              <input
                id="settings-table-top-n"
                type="number"
                min={MIN_TABLE_USAGE_TOP_N}
                max={MAX_TABLE_USAGE_TOP_N}
                step={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => commitTopN(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { commitTopN(e.target.value); e.currentTarget.blur() }
                }}
                className="shrink-0 w-20 px-2 py-1 rounded text-[12px] text-right tabular-nums
                           bg-[color:var(--bg-elev-2)] text-[color:var(--fg-primary)]
                           border border-[color:var(--border-strong)]
                           outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/25"
              />
            </div>
          </section>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div className="flex justify-end px-5 py-3 border-t border-[color:var(--border-subtle)]">
          <button
            onClick={onClose}
            className="px-5 py-1.5 rounded text-[12px] font-medium
                       bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)]
                       text-[color:var(--fg-on-accent)] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
