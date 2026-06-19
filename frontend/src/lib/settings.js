/**
 * settings.js — lightweight, localStorage-backed user preferences.
 *
 * These are non-critical UI preferences (same spirit as the existing page-size
 * and theme preferences). Unlike table *usage* data — which lives in
 * griplite.db so it survives reinstalls — a preference reverting to its
 * sensible default after a rare reinstall is harmless, so localStorage is fine.
 *
 * A `storage` argument is injectable so the helpers can be unit-tested without
 * a real browser.
 */

// ─── Database Explorer: how many frequently-used tables to pin to the top ────
export const DEFAULT_TABLE_USAGE_TOP_N = 10
export const MIN_TABLE_USAGE_TOP_N = 0
export const MAX_TABLE_USAGE_TOP_N = 100
const TABLE_USAGE_TOP_N_KEY = 'griplite_table_usage_top_n_v1'

/** Coerce arbitrary input to an integer within [MIN, MAX], else `fallback`. */
export function clampTableUsageTopN(value, fallback = DEFAULT_TABLE_USAGE_TOP_N) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_TABLE_USAGE_TOP_N, Math.max(MIN_TABLE_USAGE_TOP_N, n))
}

/** Read the preferred top-N (defaults to 10 when unset or unparsable). */
export function loadTableUsageTopN(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(TABLE_USAGE_TOP_N_KEY)
    if (raw == null) return DEFAULT_TABLE_USAGE_TOP_N
    return clampTableUsageTopN(raw)
  } catch {
    return DEFAULT_TABLE_USAGE_TOP_N
  }
}

/** Persist and return the clamped top-N. */
export function saveTableUsageTopN(value, storage = globalThis.localStorage) {
  const n = clampTableUsageTopN(value)
  try {
    storage?.setItem(TABLE_USAGE_TOP_N_KEY, String(n))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  return n
}

// ─── Fonts: console (Monaco editor) + interface (app UI) ─────────────────────
//
// `''` font-family means "use the built-in default stack" (see the *_STACK
// constants below). Sizes are plain pixels. The interface size is applied as a
// zoom factor relative to UI_FONT_SIZE_BASE so it scales the whole UI uniformly
// (the app uses many fixed-px sizes that a root font-size alone wouldn't touch);
// the console editor counter-zooms so its size stays independent — see
// FontSettingsProvider.

export const DEFAULT_EDITOR_FONT_STACK = '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace'
export const DEFAULT_UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'

export const EDITOR_FONT_OPTIONS = [
  { label: 'Default (JetBrains Mono)', value: '' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", monospace' },
  { label: 'Courier New', value: '"Courier New", monospace' },
]

export const UI_FONT_OPTIONS = [
  { label: 'System Default', value: '' },
  // Sans-serif
  { label: 'Inter', value: '"Inter", sans-serif' },
  { label: 'San Francisco', value: '-apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Helvetica Neue', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Roboto', value: '"Roboto", sans-serif' },
  { label: 'Open Sans', value: '"Open Sans", sans-serif' },
  { label: 'Lato', value: '"Lato", sans-serif' },
  { label: 'Noto Sans', value: '"Noto Sans", sans-serif' },
  { label: 'Source Sans 3', value: '"Source Sans 3", "Source Sans Pro", sans-serif' },
  { label: 'Nunito', value: '"Nunito", sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif' },
  { label: 'system-ui', value: 'system-ui, sans-serif' },
  // Serif
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Merriweather', value: '"Merriweather", Georgia, serif' },
  // Monospace (some people prefer a mono UI too)
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  // CJK (中文)
  { label: 'PingFang SC (苹方)', value: '"PingFang SC", -apple-system, sans-serif' },
  { label: 'Microsoft YaHei (微软雅黑)', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: 'Hiragino Sans GB (冬青黑)', value: '"Hiragino Sans GB", sans-serif' },
  { label: 'Noto Sans SC (思源黑体)', value: '"Noto Sans SC", "Source Han Sans SC", sans-serif' },
]

// Result grid (Glide DataEditor) font. Default is the same mono stack the grid
// has always used; '' means "use that default".
export const DEFAULT_GRID_FONT_STACK = '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace'

export const GRID_FONT_OPTIONS = [
  { label: 'Default (JetBrains Mono)', value: '' },
  { label: 'System Sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { label: 'Inter', value: '"Inter", sans-serif' },
  { label: 'SF Mono', value: '"SF Mono", ui-monospace, monospace' },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", monospace' },
  { label: 'Helvetica Neue', value: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
]

export const DEFAULT_EDITOR_FONT_SIZE = 14
export const MIN_EDITOR_FONT_SIZE = 8
export const MAX_EDITOR_FONT_SIZE = 40

export const DEFAULT_UI_FONT_SIZE = 13
export const MIN_UI_FONT_SIZE = 10
export const MAX_UI_FONT_SIZE = 22
// Baseline the rest of the UI is designed around; interface zoom = size / base.
export const UI_FONT_SIZE_BASE = 13

export const DEFAULT_GRID_FONT_SIZE = 13
export const MIN_GRID_FONT_SIZE = 9
export const MAX_GRID_FONT_SIZE = 24

const EDITOR_FONT_FAMILY_KEY = 'griplite_editor_font_family_v1'
const EDITOR_FONT_SIZE_KEY = 'griplite_editor_font_size_v1'
const UI_FONT_FAMILY_KEY = 'griplite_ui_font_family_v1'
const UI_FONT_SIZE_KEY = 'griplite_ui_font_size_v1'
const GRID_FONT_FAMILY_KEY = 'griplite_grid_font_family_v1'
const GRID_FONT_SIZE_KEY = 'griplite_grid_font_size_v1'

/** Coerce to an integer within [min, max], else `fallback`. */
export function clampFontSize(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function loadInt(key, fallback, min, max, storage) {
  try {
    const raw = storage?.getItem(key)
    if (raw == null) return fallback
    return clampFontSize(raw, min, max, fallback)
  } catch {
    return fallback
  }
}

function saveInt(key, value, min, max, fallback, storage) {
  const n = clampFontSize(value, min, max, fallback)
  try { storage?.setItem(key, String(n)) } catch { /* ignore */ }
  return n
}

function loadStr(key, fallback, storage) {
  try {
    const raw = storage?.getItem(key)
    return typeof raw === 'string' ? raw : fallback
  } catch {
    return fallback
  }
}

function saveStr(key, value, storage) {
  const v = typeof value === 'string' ? value : ''
  try { storage?.setItem(key, v) } catch { /* ignore */ }
  return v
}

export const loadEditorFontFamily = (storage = globalThis.localStorage) => loadStr(EDITOR_FONT_FAMILY_KEY, '', storage)
export const saveEditorFontFamily = (v, storage = globalThis.localStorage) => saveStr(EDITOR_FONT_FAMILY_KEY, v, storage)
export const loadUiFontFamily = (storage = globalThis.localStorage) => loadStr(UI_FONT_FAMILY_KEY, '', storage)
export const saveUiFontFamily = (v, storage = globalThis.localStorage) => saveStr(UI_FONT_FAMILY_KEY, v, storage)

export const loadEditorFontSize = (storage = globalThis.localStorage) =>
  loadInt(EDITOR_FONT_SIZE_KEY, DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, storage)
export const saveEditorFontSize = (v, storage = globalThis.localStorage) =>
  saveInt(EDITOR_FONT_SIZE_KEY, v, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE, DEFAULT_EDITOR_FONT_SIZE, storage)
export const loadUiFontSize = (storage = globalThis.localStorage) =>
  loadInt(UI_FONT_SIZE_KEY, DEFAULT_UI_FONT_SIZE, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, storage)
export const saveUiFontSize = (v, storage = globalThis.localStorage) =>
  saveInt(UI_FONT_SIZE_KEY, v, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE, storage)

export const loadGridFontFamily = (storage = globalThis.localStorage) => loadStr(GRID_FONT_FAMILY_KEY, '', storage)
export const saveGridFontFamily = (v, storage = globalThis.localStorage) => saveStr(GRID_FONT_FAMILY_KEY, v, storage)
export const loadGridFontSize = (storage = globalThis.localStorage) =>
  loadInt(GRID_FONT_SIZE_KEY, DEFAULT_GRID_FONT_SIZE, MIN_GRID_FONT_SIZE, MAX_GRID_FONT_SIZE, storage)
export const saveGridFontSize = (v, storage = globalThis.localStorage) =>
  saveInt(GRID_FONT_SIZE_KEY, v, MIN_GRID_FONT_SIZE, MAX_GRID_FONT_SIZE, DEFAULT_GRID_FONT_SIZE, storage)

/** Resolve the effective UI font stack (the chosen value, or the default). */
export const resolveUiFontStack = (family) => (family && family.trim() ? family : DEFAULT_UI_FONT_STACK)
/** Resolve the effective editor font stack (the chosen value, or the default). */
export const resolveEditorFontStack = (family) => (family && family.trim() ? family : DEFAULT_EDITOR_FONT_STACK)
/** Resolve the effective result-grid font stack (the chosen value, or the default). */
export const resolveGridFontStack = (family) => (family && family.trim() ? family : DEFAULT_GRID_FONT_STACK)
/** Interface zoom factor for a given UI font size. */
export const uiZoomForSize = (size) => clampFontSize(size, MIN_UI_FONT_SIZE, MAX_UI_FONT_SIZE, DEFAULT_UI_FONT_SIZE) / UI_FONT_SIZE_BASE
