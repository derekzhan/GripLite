/**
 * ThemeToggle — compact Sun/Moon button for the top bar.
 *
 * Phase 18.  One click flips between light and dark; right-clicking opens a
 * tiny popover offering explicit Light / Dark / System choices so users who
 * want OS-sync can opt in without hunting through settings.
 *
 * The button is intentionally 24×24 px — matches the other chrome icons in
 * DatabaseExplorer / MenuBar.
 */
import { useEffect, useRef, useState } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme } from '../theme/ThemeProvider'

export default function ThemeToggle({ className = '' }) {
  const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef(null)

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onClick = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const Icon = resolvedTheme === 'dark' ? Moon : Sun

  return (
    <div ref={wrapperRef} className={`relative ${className}`} style={{ WebkitAppRegion: 'no-drag' }}>
      <button
        onClick={toggleTheme}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v) }}
        title={`Theme: ${theme}\nClick to toggle, right-click for options`}
        className="flex items-center justify-center w-6 h-6 rounded
                   text-[color:var(--fg-muted)] hover:text-[color:var(--fg-primary)]
                   hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
      >
        <Icon size={14} strokeWidth={1.8} />
      </button>

      {menuOpen && (
        <div
          className="absolute right-0 top-7 z-50 min-w-[140px] py-1
                     rounded shadow-xl modal-enter
                     bg-[color:var(--card-bg)]
                     border border-[color:var(--border-strong)]"
        >
          {[
            { id: 'light',  label: 'Light',  Icon: Sun },
            { id: 'dark',   label: 'Dark',   Icon: Moon },
            { id: 'system', label: 'System', Icon: Monitor },
          ].map(({ id, label, Icon: I }) => (
            <button
              key={id}
              onClick={() => { setTheme(id); setMenuOpen(false) }}
              className={[
                'flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px]',
                'hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-accent)]',
                'transition-colors',
                theme === id ? 'text-[color:var(--accent)] font-medium' : 'text-[color:var(--fg-primary)]',
              ].join(' ')}
            >
              <I size={13} strokeWidth={1.8} />
              <span className="flex-1">{label}</span>
              {theme === id && <span className="text-[10px] opacity-80">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
