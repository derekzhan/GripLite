/**
 * ripple.js — pure geometry for the Ripple press effect.
 *
 * Kept free of React so it can be unit-tested in plain Node. The Ripple
 * component imports `rippleGeometry` from here.
 */

/**
 * Geometry for a ripple given the host's bounding rect and the pointer
 * position. The circle is sized to cover the host from any click point
 * (diameter = 2 × the longest side) and centered on the pointer.
 *
 * @param {{left:number, top:number, width:number, height:number}} rect
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{ size:number, x:number, y:number }}
 */
export function rippleGeometry(rect, clientX, clientY) {
  const size = Math.max(rect.width, rect.height) * 2
  return {
    size,
    x: clientX - rect.left - size / 2,
    y: clientY - rect.top - size / 2,
  }
}
