/**
 * MenuBar — Phase 18 top-of-window menu.
 *
 * Design notes
 * ────────────
 *  • Sits inside the draggable title bar (WebkitAppRegion: drag) so the user
 *    can still grab empty space to move the window, but each interactive
 *    element opts out with `WebkitAppRegion: 'no-drag'`.
 *  • Only ships one menu (`Help`) in this phase — more menus (File, Edit,
 *    View, Tools) can be appended without schema changes: each entry is a
 *    { label, items: [{label, action, shortcut}] } record.
 *  • Dropdowns close on outside click, Escape, or selecting an item.
 *
 * Props
 * ─────
 *   onAbout  — fired when the user selects Help → About GripLite.
 */
import { useEffect, useRef, useState } from 'react'

export default function MenuBar({ onAbout }) {
  const [openMenu, setOpenMenu] = useState(null) // 'help' | null
  const containerRef = useRef(null)

  useEffect(() => {
    if (!openMenu) return
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpenMenu(null)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const menus = [
    {
      id: 'help',
      label: 'Help',
      items: [
        { label: 'About GripLite', action: () => { onAbout?.(); setOpenMenu(null) } },
      ],
    },
  ]

  return (
    <nav
      ref={containerRef}
      className="flex items-center h-full gap-0.5"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {menus.map((menu) => {
        const isOpen = openMenu === menu.id
        return (
          <div key={menu.id} className="relative h-full">
            <button
              onClick={() => setOpenMenu(isOpen ? null : menu.id)}
              onMouseEnter={() => { if (openMenu) setOpenMenu(menu.id) }}
              className={[
                'h-full px-3 text-[12px] font-medium select-none',
                'transition-colors rounded-sm',
                isOpen
                  ? 'bg-black/10 dark:bg-white/10 text-[color:var(--fg-primary)]'
                  : 'text-[color:var(--fg-secondary)] hover:bg-black/5 dark:hover:bg-white/5 hover:text-[color:var(--fg-primary)]',
              ].join(' ')}
            >
              {menu.label}
            </button>

            {isOpen && (
              <div
                className="absolute left-0 top-full mt-0.5 z-50 min-w-[180px] py-1
                           rounded shadow-xl modal-enter
                           bg-[color:var(--card-bg)]
                           border border-[color:var(--border-strong)]"
              >
                {menu.items.map((item, i) => (
                  <button
                    key={i}
                    onClick={item.action}
                    className="flex items-center justify-between w-full text-left px-3 py-1.5 text-[12px]
                               text-[color:var(--fg-primary)]
                               hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-accent)]
                               transition-colors"
                  >
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span className="text-[10px] opacity-60 ml-6 font-mono">{item.shortcut}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}
