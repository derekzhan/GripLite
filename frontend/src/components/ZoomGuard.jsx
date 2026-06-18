/**
 * ZoomGuard — neutralises the interface `zoom` for a subtree.
 *
 * The whole app is scaled by `zoom` on #root (interface font size). That works
 * for plain DOM, but Monaco editors (and other components that size themselves
 * from getBoundingClientRect) double-scale under CSS zoom: they measure the
 * already-zoomed box and then render zoomed again, overflowing their panel.
 *
 * This wrapper counter-zooms by 1/uiZoom and pre-enlarges its box by uiZoom, so
 * it still fills its parent exactly but its contents render at a *net* zoom of
 * 1 — i.e. true CSS pixels — which Monaco measures and lays out correctly.
 *
 * Place it INSIDE the sized/flex parent (not as the flex item itself), e.g.:
 *   <div className="flex-1 overflow-hidden">
 *     <ZoomGuard><Editor … /></ZoomGuard>
 *   </div>
 */
import { useFontSettings } from '../settings/FontSettingsProvider'

export default function ZoomGuard({ children, style }) {
  const { uiZoom } = useFontSettings()

  // At 100% interface scale there is nothing to undo — render a plain filler so
  // we never touch `zoom` (zero risk on the default path).
  if (!uiZoom || uiZoom === 1) {
    return <div style={{ width: '100%', height: '100%', ...style }}>{children}</div>
  }

  return (
    <div
      style={{
        zoom: 1 / uiZoom,
        width: `calc(100% * ${uiZoom})`,
        height: `calc(100% * ${uiZoom})`,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
