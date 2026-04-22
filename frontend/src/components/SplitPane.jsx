import { useState, useRef, useCallback, useEffect } from 'react'

/**
 * SplitPane – draggable two-pane divider.
 *
 * Props:
 *   direction  – "horizontal" (side-by-side) | "vertical" (stacked)
 *   initialSize – initial size of the first pane in pixels
 *   minSize    – minimum size of the first pane in pixels
 *   maxSize    – maximum size of the first pane in pixels
 *   children   – exactly two children: [pane1, pane2]
 */
export default function SplitPane({
  direction = 'horizontal',
  initialSize = 240,
  minSize = 120,
  maxSize,
  children,
}) {
  const [size, setSize] = useState(initialSize)
  const containerRef = useRef(null)
  const dragging = useRef(false)

  const isHorizontal = direction === 'horizontal'

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [isHorizontal])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      let newSize = isHorizontal
        ? e.clientX - rect.left
        : e.clientY - rect.top
      const max = maxSize ?? (isHorizontal ? rect.width * 0.6 : rect.height * 0.8)
      newSize = Math.max(minSize, Math.min(max, newSize))
      setSize(newSize)
    }

    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [isHorizontal, minSize, maxSize])

  const containerStyle = {
    display: 'flex',
    flexDirection: isHorizontal ? 'row' : 'column',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
  }

  const pane1Style = isHorizontal
    ? { width: size, flexShrink: 0, overflow: 'hidden' }
    : { height: size, flexShrink: 0, overflow: 'hidden' }

  const pane2Style = { flex: 1, overflow: 'hidden' }

  const resizerClass = [
    'split-pane-resizer',
    isHorizontal ? 'w-1' : 'h-1',
    isHorizontal ? '' : 'split-pane-resizer-vertical',
  ].join(' ')

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={pane1Style}>{children[0]}</div>
      <div
        className={resizerClass}
        onMouseDown={onMouseDown}
      />
      <div style={pane2Style}>{children[1]}</div>
    </div>
  )
}
