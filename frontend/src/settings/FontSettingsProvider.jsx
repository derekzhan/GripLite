/**
 * FontSettingsProvider — console (Monaco editor) and interface (app UI) font
 * preferences, applied live.
 *
 *   const {
 *     editorFontFamily, editorFontSize,
 *     uiFontFamily, uiFontSize, uiZoom,
 *     setEditorFontFamily, setEditorFontSize,
 *     setUiFontFamily, setUiFontSize,
 *   } = useFontSettings()
 *
 * Interface size scales the whole UI via `zoom` on #root (the app uses many
 * fixed-px sizes that a root font-size alone wouldn't affect). The SQL console
 * divides its Monaco font size by `uiZoom` so its text keeps its configured
 * pixel size without a counter-zoom (which clipped the editor). All four values
 * persist to localStorage.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  DEFAULT_GRID_FONT_SIZE,
  loadEditorFontFamily, saveEditorFontFamily,
  loadEditorFontSize, saveEditorFontSize,
  loadUiFontFamily, saveUiFontFamily,
  loadUiFontSize, saveUiFontSize,
  loadGridFontFamily, saveGridFontFamily,
  loadGridFontSize, saveGridFontSize,
  resolveUiFontStack,
  uiZoomForSize,
} from '../lib/settings'

const FontSettingsContext = createContext(null)

/** Apply the interface font + zoom to the document. Idempotent. */
function applyInterfaceFont(uiFontFamily, uiFontSize) {
  if (typeof document === 'undefined') return
  const zoom = uiZoomForSize(uiFontSize)
  const root = document.getElementById('root') ?? document.documentElement
  root.style.setProperty('--app-font-family', resolveUiFontStack(uiFontFamily))
  // #root style reads --app-font-family (see style.css); zoom scales everything.
  // The SQL console divides its Monaco font size by this zoom so it keeps its
  // own configured pixel size without a counter-zoom that would clip the editor.
  root.style.zoom = String(zoom)
}

export function FontSettingsProvider({ children }) {
  const [editorFontFamily, setEditorFontFamilyState] = useState(() => loadEditorFontFamily())
  const [editorFontSize, setEditorFontSizeState]     = useState(() => loadEditorFontSize())
  const [uiFontFamily, setUiFontFamilyState]         = useState(() => loadUiFontFamily())
  const [uiFontSize, setUiFontSizeState]             = useState(() => loadUiFontSize())
  const [gridFontFamily, setGridFontFamilyState]     = useState(() => loadGridFontFamily())
  const [gridFontSize, setGridFontSizeState]         = useState(() => loadGridFontSize())

  // Apply interface font/zoom before paint so the first frame is correct.
  useLayoutEffect(() => { applyInterfaceFont(uiFontFamily, uiFontSize) }, [uiFontFamily, uiFontSize])

  const setEditorFontFamily = useCallback((v) => setEditorFontFamilyState(saveEditorFontFamily(v)), [])
  const setEditorFontSize   = useCallback((v) => setEditorFontSizeState(saveEditorFontSize(v)), [])
  const setUiFontFamily     = useCallback((v) => setUiFontFamilyState(saveUiFontFamily(v)), [])
  const setUiFontSize       = useCallback((v) => setUiFontSizeState(saveUiFontSize(v)), [])
  const setGridFontFamily   = useCallback((v) => setGridFontFamilyState(saveGridFontFamily(v)), [])
  const setGridFontSize     = useCallback((v) => setGridFontSizeState(saveGridFontSize(v)), [])

  const value = useMemo(() => ({
    editorFontFamily, editorFontSize, uiFontFamily, uiFontSize, gridFontFamily, gridFontSize,
    uiZoom: uiZoomForSize(uiFontSize),
    setEditorFontFamily, setEditorFontSize, setUiFontFamily, setUiFontSize,
    setGridFontFamily, setGridFontSize,
  }), [
    editorFontFamily, editorFontSize, uiFontFamily, uiFontSize, gridFontFamily, gridFontSize,
    setEditorFontFamily, setEditorFontSize, setUiFontFamily, setUiFontSize,
    setGridFontFamily, setGridFontSize,
  ])

  return <FontSettingsContext.Provider value={value}>{children}</FontSettingsContext.Provider>
}

export function useFontSettings() {
  const ctx = useContext(FontSettingsContext)
  if (!ctx) {
    // Defaults keep components usable even if a provider is missing (e.g. an
    // isolated test render), rather than throwing.
    return {
      editorFontFamily: '', editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
      uiFontFamily: '', uiFontSize: DEFAULT_UI_FONT_SIZE, uiZoom: 1,
      gridFontFamily: '', gridFontSize: DEFAULT_GRID_FONT_SIZE,
      setEditorFontFamily: () => {}, setEditorFontSize: () => {},
      setUiFontFamily: () => {}, setUiFontSize: () => {},
      setGridFontFamily: () => {}, setGridFontSize: () => {},
    }
  }
  return ctx
}
