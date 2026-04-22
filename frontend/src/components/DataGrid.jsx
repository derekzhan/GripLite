/**
 * DataGrid.jsx — shared canvas data grid primitives for GripLite.
 *
 * Exports:
 *   useGlideTheme     – returns a Glide theme object derived from CSS vars,
 *                       reactively rebuilt whenever the active light/dark
 *                       theme changes
 *   AutoSizedGrid     – ResizeObserver wrapper; fills its container exactly
 *   deriveColumns     – converts QueryResult columns → Glide GridColumn specs
 *   useCellContent    – hook that returns a stable getCellContent callback
 *
 * Both ResultPanel and TableViewer import from here so the visual language
 * stays consistent across all grid instances in the app.
 *
 * Theme implementation
 * ────────────────────
 * Glide DataEditor renders to <canvas>, so it can't pick up CSS custom
 * properties via class selectors — every colour has to be a concrete
 * string at draw time.  We read the relevant CSS variables off
 * <html> (where ThemeProvider sets `.dark`) and assemble a fresh theme
 * object each time the active theme flips.  All callers re-render then
 * because the returned object has a new identity.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { DataEditor, GridCellKind } from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { useTheme } from '../theme/ThemeProvider'

// ─────────────────────────────────────────────────────────────────────────────
// CSS-var → Glide theme bridge
// ─────────────────────────────────────────────────────────────────────────────

// ─── Palette tables ──────────────────────────────────────────────────────
// Glide DataEditor paints to a <canvas>, so the theme must be resolved to
// *concrete colour strings* before the first paint.  Reading CSS custom
// properties via getComputedStyle() is fragile because of React's render /
// commit ordering (useMemo runs during render, but a theme toggle only
// updates `<html>.dark` inside useLayoutEffect, so the first canvas paint
// can land with the wrong palette).  We therefore maintain two in-code
// palettes and pick one based on `resolvedTheme`.
//
// Values here mirror the `--grid-*` and `--fg-*` tokens in style.css.  If
// you change one side, update the other so the Tailwind utilities and
// the canvas grid stay visually consistent.
const LIGHT_PALETTE = {
  accent:        '#0969da',
  accentSubtle:  'rgba(9,105,218,0.10)',
  fgPrimary:     '#1f2328',
  fgSecondary:   '#57606a',
  fgMuted:       '#8c959f',
  fgFaint:       '#afb8c1',
  bgElevated:    '#fafbfc',
  syntaxKeyword: '#cf222e',
  success:       '#1a7f37',
  gridBg:        '#ffffff',
  gridBgAlt:     '#fafbfc',
  gridBgHeader:  '#f6f8fa',
  gridBgHeaderH: '#eef0f3',
  gridBorder:    '#d0d7de',
  gridBorderH:   '#e4e7eb',
}

const DARK_PALETTE = {
  accent:        '#007acc',
  accentSubtle:  'rgba(0,122,204,0.18)',
  fgPrimary:     '#d4d4d4',
  fgSecondary:   '#cccccc',
  fgMuted:       '#858585',
  fgFaint:       '#6e6e6e',
  bgElevated:    '#2d2d2d',
  syntaxKeyword: '#569cd6',
  success:       '#4ec9b0',
  gridBg:        '#1e1e1e',
  gridBgAlt:     '#1e1e1e',
  gridBgHeader:  '#252526',
  gridBgHeaderH: '#2a2d2e',
  gridBorder:    '#3c3c3c',
  gridBorderH:   '#2d2d2d',
}

function buildThemeFromPalette(p) {
  return {
    accentColor:           p.accent,
    accentLight:           p.accentSubtle,
    textDark:              p.fgPrimary,
    textMedium:            p.fgSecondary,
    textLight:             p.fgMuted,
    textBubble:            p.fgPrimary,
    bgIconHeader:          p.bgElevated,
    fgIconHeader:          p.fgMuted,
    textHeader:            p.syntaxKeyword,
    textGroupHeader:       p.syntaxKeyword,
    bgCell:                p.gridBg,
    bgCellMedium:          p.gridBgAlt,
    bgHeader:              p.gridBgHeader,
    bgHeaderHasFocus:      p.gridBgHeaderH,
    bgHeaderHovered:       p.gridBgHeaderH,
    bgBubble:              p.bgElevated,
    bgBubbleSelected:      p.accent,
    bgSearchResult:        p.accentSubtle,
    borderColor:           p.gridBorder,
    horizontalBorderColor: p.gridBorderH,
    drilldownBorder:       p.gridBorder,
    linkColor:             p.success,
    cellHorizontalPadding: 10,
    cellVerticalPadding:   4,
    headerFontStyle:       '600 13px',
    baseFontStyle:         '13px',
    fontFamily:            '"JetBrains Mono","Fira Code",Consolas,"Courier New",monospace',
    editorFontSize:        '13px',
    lineHeight:            1.6,
  }
}

/**
 * useGlideTheme — returns a Glide theme object for the active light /
 * dark theme.  The palette is resolved from a hand-maintained table
 * rather than getComputedStyle() because the DataEditor canvas must
 * receive concrete colours on its *very first paint*, before any CSS
 * custom-property toggle has had a chance to flush.
 */
export function useGlideTheme() {
  const { resolvedTheme } = useTheme()
  return useMemo(
    () => buildThemeFromPalette(resolvedTheme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE),
    [resolvedTheme],
  )
}

// Back-compat: a few call sites still import { DARK_THEME } directly.
// Resolves to the dark palette at module-load time.
export const DARK_THEME = buildThemeFromPalette(DARK_PALETTE)

/**
 * Theme-aware overrides for the special row states (selected / deleted /
 * added / edited).  Glide overrides are partial themes merged on top of
 * the base, so we only need the colour swatches that differ.
 *
 * Returns a stable object per resolvedTheme change.
 */
export function useRowOverrides() {
  const { resolvedTheme } = useTheme()
  return useMemo(() => {
    if (resolvedTheme === 'dark') {
      return {
        selected: { bgCell: '#094771', bgCellMedium: '#094771', textDark: '#e8e8e8' },
        deleted:  { bgCell: '#2d1010', bgCellMedium: '#2d1010', textDark: '#804040' },
        added:    { bgCell: '#0d2010', bgCellMedium: '#0d2010', textDark: '#4a9a4a' },
        edited:   { bgCell: '#2a2700', bgCellMedium: '#2a2700' },
        nullText: '#555555',
      }
    }
    return {
      selected: { bgCell: '#dbeafe', bgCellMedium: '#dbeafe', textDark: '#0c2a4d' },
      deleted:  { bgCell: '#ffeef0', bgCellMedium: '#ffeef0', textDark: '#a4262c' },
      added:    { bgCell: '#dafbe1', bgCellMedium: '#dafbe1', textDark: '#1a7f37' },
      edited:   { bgCell: '#fff8c5', bgCellMedium: '#fff8c5' },
      nullText: '#afb8c1',
    }
  }, [resolvedTheme])
}

// ─────────────────────────────────────────────────────────────────────────────
// AutoSizedGrid
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AutoSizedGrid measures its container via ResizeObserver and passes the exact
 * pixel dimensions to Glide DataEditor (which requires explicit width/height
 * because it renders onto an HTML Canvas element).
 *
 * Props mirror a subset of DataEditor props, plus:
 *   columns         – Glide GridColumn[]
 *   getCellContentFn – (cell: [col, row]) => GridCell
 *   numRows         – total visible row count
 *   rowMarkers      – "number" | "none" (default "number")
 */
export function AutoSizedGrid({
  columns,
  getCellContentFn,
  numRows,
  rowMarkers = 'number',
  rowMarkerWidth = 64,
  smoothScrollX = true,
  smoothScrollY = true,
  // Any additional Glide DataEditor props (e.g. getRowThemeOverride, onCellClicked)
  // are forwarded via rest so callers never need to fork this component.
  ...rest
}) {
  const containerRef = useRef(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const theme = useGlideTheme()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setDims({ width: Math.floor(width), height: Math.floor(height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      {dims.width > 0 && dims.height > 0 && (
        <DataEditor
          {...rest}
          getCellContent={getCellContentFn}
          columns={columns}
          rows={numRows}
          width={dims.width}
          height={dims.height}
          smoothScrollX={smoothScrollX}
          smoothScrollY={smoothScrollY}
          theme={theme}
          rowMarkers={rowMarkers}
          rowMarkerWidth={rowMarkerWidth}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// deriveColumns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a QueryResult.columns array (ColumnMeta[]) into Glide GridColumn[].
 * Column width is heuristically derived from the column name length.
 */
export function deriveColumns(cols = []) {
  return cols.map((c) => ({
    title: c.name,
    width: Math.max(90, Math.min(300, c.name.length * 9 + 32)),
    id:    c.name,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// useCellContent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * useCellContent(rows) returns a stable getCellContent function.
 *
 * @param rows – The slice of rows currently visible (page or all rows).
 *               The function does a direct O(1) lookup: rows[row][col].
 *
 * NULL / undefined cells are rendered as "NULL" in a dim colour that
 * follows the active theme (fg-faint).
 */
export function useCellContent(rows) {
  const { nullText } = useRowOverrides()
  return useCallback(
    ([col, row]) => {
      const cell = rows?.[row]?.[col]
      const isNull = cell === null || cell === undefined
      const display = isNull ? 'NULL' : String(cell)
      return {
        kind:        GridCellKind.Text,
        data:        display,
        displayData: display,
        allowOverlay: false,
        ...(isNull ? { themeOverride: { textDark: nullText } } : {}),
      }
    },
    [rows, nullText],
  )
}
