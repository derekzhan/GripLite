/**
 * ThemeProvider — Phase 18 light / dark / system theme (hand-rolled).
 *
 * Why not next-themes?
 * ────────────────────
 * next-themes targets Next.js and couples its hydration model to SSR.  In a
 * Wails + Vite SPA we don't need any of that — a small context provider
 * keeps the bundle slimmer and avoids a "use client" directive warning in
 * the Vite build output (see build log from Phase 17).
 *
 * Behaviour
 * ─────────
 *   • setTheme('light' | 'dark' | 'system') is persisted to localStorage.
 *   • 'system' follows prefers-color-scheme and reacts live when the OS
 *     toggles its dark mode (the MediaQueryList "change" listener below).
 *   • The resolved theme flips `.dark` on <html>, which is what
 *     tailwind.config.js `darkMode: 'class'` looks for.
 *
 * Consumers
 * ─────────
 *   const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme()
 *
 *   - theme          — user preference, possibly 'system'
 *   - resolvedTheme  — 'light' | 'dark' (what's actually painted)
 *   - setTheme(t)    — explicit set ('light'|'dark'|'system')
 *   - toggleTheme()  — flips between light and dark (resets 'system')
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'griplite.theme'
const ThemeContext = createContext(null)

// Media-query helper.  Wrapped in a function so `matchMedia` is only touched
// inside the browser (SSR-safe, harmless here but keeps the hook tidy).
const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

/** Resolve 'system' into the concrete light/dark value. */
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref
  return systemPrefersDark() ? 'dark' : 'light'
}

/** Apply the resolved theme to <html>.  Idempotent. */
function applyThemeClass(resolved) {
  const html = document.documentElement
  if (!html) return
  html.classList.toggle('dark', resolved === 'dark')
  // Hint for native form controls / scrollbars so they pick the right skin.
  html.style.colorScheme = resolved
}

export function ThemeProvider({ children, defaultTheme = 'dark' }) {
  // Read initial preference from localStorage (sync, so the app doesn't
  // flash the wrong theme on the first paint).
  const [theme, setThemeState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
    } catch { /* storage blocked — fall through to defaults */ }
    return defaultTheme
  })

  const [resolvedTheme, setResolvedTheme] = useState(() => {
    const r = resolveTheme(theme)
    // Apply the class synchronously during the initial module evaluation
    // so the very first render (and any component that reads CSS vars
    // via getComputedStyle, e.g. the Glide Data Grid canvas theme) sees
    // the correct palette.  Without this the app paints one frame with
    // the wrong tokens before useEffect catches up.
    if (typeof document !== 'undefined') applyThemeClass(r)
    return r
  })

  // Keep <html> in sync on subsequent changes.  The useLayoutEffect
  // variant runs before paint so downstream useMemo(resolvedTheme) deps
  // that read computed styles always observe the post-toggle values.
  useLayoutEffect(() => { applyThemeClass(resolvedTheme) }, [resolvedTheme])

  // Recompute resolvedTheme whenever `theme` changes.
  useEffect(() => {
    setResolvedTheme(resolveTheme(theme))
  }, [theme])

  // Listen for OS-level theme changes while `theme === 'system'`.
  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e) => setResolvedTheme(e.matches ? 'dark' : 'light')
    // Safari <14 uses addListener/removeListener — guard for both.
    if (mq.addEventListener) mq.addEventListener('change', handler)
    else mq.addListener(handler)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler)
      else mq.removeListener(handler)
    }
  }, [theme])

  // Persist whenever the user changes the preference.
  const setTheme = useCallback((next) => {
    setThemeState(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
  }, [])

  // Toggle between light and dark regardless of current mode.  Convenience
  // handler used by the title-bar Sun/Moon icon.
  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }, [resolvedTheme, setTheme])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    // Fail loudly instead of returning undefined — this is exclusively a
    // component-time error, not a data error, so a throw is appropriate.
    throw new Error('useTheme must be used inside <ThemeProvider>')
  }
  return ctx
}
