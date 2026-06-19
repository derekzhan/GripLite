/**
 * Ripple — a subtle, Apple-tasteful water-ripple press effect.
 *
 * Drop it in as the LAST child of a `position: relative` host (e.g. a button or
 * a clickable row). It listens to the host's pointerdown and expands a tinted
 * circle from the pointer, clipped to the host's shape:
 *
 *   <button className="relative overflow-hidden press">
 *     Label
 *     <Ripple />
 *   </button>
 *
 * - `color` — ripple tint (defaults to the host's currentColor, so it picks up
 *   white on accent-filled buttons and the text color on subtle rows).
 * - `duration` — match the CSS animation length (default 480ms).
 *
 * Honors prefers-reduced-motion via CSS (.aqua-ripple is hidden), and a timeout
 * fallback guarantees ripples are cleaned up even if animationend never fires.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rippleGeometry } from '../lib/ripple'

export { rippleGeometry }

export default function Ripple({ color, duration = 480 }) {
  const holderRef = useRef(null)
  const [ripples, setRipples] = useState([])

  const remove = useCallback((id) => {
    setRipples((rs) => rs.filter((r) => r.id !== id))
  }, [])

  useEffect(() => {
    const host = holderRef.current?.parentElement
    if (!host) return undefined

    const onDown = (e) => {
      const rect = host.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const { size, x, y } = rippleGeometry(rect, e.clientX, e.clientY)
      const id = `${Date.now()}-${Math.random()}`
      setRipples((rs) => [...rs, { id, size, x, y }])
      // Fallback cleanup in case animationend doesn't fire (reduced motion).
      setTimeout(() => remove(id), duration + 120)
    }

    host.addEventListener('pointerdown', onDown)
    return () => host.removeEventListener('pointerdown', onDown)
  }, [duration, remove])

  return (
    <span
      ref={holderRef}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        borderRadius: 'inherit',
        pointerEvents: 'none',
      }}
    >
      {ripples.map((r) => (
        <span
          key={r.id}
          className="aqua-ripple"
          style={{ width: r.size, height: r.size, left: r.x, top: r.y, color }}
          onAnimationEnd={() => remove(r.id)}
        />
      ))}
    </span>
  )
}
