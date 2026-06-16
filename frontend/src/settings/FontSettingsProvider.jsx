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
 * fixed-px sizes that a root font-size alone wouldn't affect). The console
 * editor counter-zooms (--editor-unzoom = 1/uiZoom) so its font size stays
 * independent of the interface scale. All four values persist to localStorage.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import {
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_UI_FONT_SIZE,
  loadEditorFontFamily, saveEditorFontFamily,
  loadEditorFontSize, saveEditorFontSize,
  loadUiFontFamily, saveUiFontFamily,
  loadUiFontSize, saveUiFontSize,
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
  root.style.zoom = String(zoom)
  // Editors counter-zoom so their configured px size is honoured 1:1.
  document.documentElement.style.setProperty('--editor-unzoom', String(1 / zoom))
}

export function FontSettingsProvider({ children }) {
  const [editorFontFamily, setEditorFontFamilyState] = useState(() => loadEditorFontFamily())
  const [editorFontSize, setEditorFontSizeState]     = useState(() => loadEditorFontSize())
  const [uiFontFamily, setUiFontFamilyState]         = useState(() => loadUiFontFamily())
  const [uiFontSize, setUiFontSizeState]             = useState(() => loadUiFontSize())

  // Apply interface font/zoom before paint so the first frame is correct.
  useLayoutEffect(() => { applyInterfaceFont(uiFontFamily, uiFontSize) }, [uiFontFamily, uiFontSize])

  const setEditorFontFamily = useCallback((v) => setEditorFontFamilyState(saveEditorFontFamily(v)), [])
  const setEditorFontSize   = useCallback((v) => setEditorFontSizeState(saveEditorFontSize(v)), [])
  const setUiFontFamily     = useCallback((v) => setUiFontFamilyState(saveUiFontFamily(v)), [])
  const setUiFontSize       = useCallback((v) => setUiFontSizeState(saveUiFontSize(v)), [])

  const value = useMemo(() => ({
    editorFontFamily, editorFontSize, uiFontFamily, uiFontSize,
    uiZoom: uiZoomForSize(uiFontSize),
    setEditorFontFamily, setEditorFontSize, setUiFontFamily, setUiFontSize,
  }), [
    editorFontFamily, editorFontSize, uiFontFamily, uiFontSize,
    setEditorFontFamily, setEditorFontSize, setUiFontFamily, setUiFontSize,
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
      setEditorFontFamily: () => {}, setEditorFontSize: () => {},
      setUiFontFamily: () => {}, setUiFontSize: () => {},
    }
  }
  return ctx
}
