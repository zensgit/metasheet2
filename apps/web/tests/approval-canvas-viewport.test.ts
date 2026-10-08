import { describe, expect, it } from 'vitest'
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clampCanvasZoom,
  clientToCanvasPoint,
  computeMinimapFrame,
  fitCanvasZoom,
  stepCanvasZoom,
} from '../src/approvals/canvasViewport'

describe('approval canvas viewport math', () => {
  it('clamps and steps zoom without escaping the supported range', () => {
    expect(clampCanvasZoom(0)).toBe(CANVAS_ZOOM_MIN)
    expect(clampCanvasZoom(99)).toBe(CANVAS_ZOOM_MAX)
    expect(clampCanvasZoom(Number.NaN)).toBe(1)
    expect(stepCanvasZoom(CANVAS_ZOOM_MAX, 'in')).toBe(CANVAS_ZOOM_MAX)
    expect(stepCanvasZoom(CANVAS_ZOOM_MIN, 'out')).toBe(CANVAS_ZOOM_MIN)
    expect(stepCanvasZoom(1, 'in')).toBeGreaterThan(1)
    expect(stepCanvasZoom(1, 'out')).toBeLessThan(1)
  })

  it('maps client points back into logical canvas coordinates at every zoom', () => {
    const rect = { left: 100, top: 40, width: 800, height: 600 }
    expect(clientToCanvasPoint(200, 90, rect, 0.5)).toEqual({ x: 200, y: 100 })
    expect(clientToCanvasPoint(300, 140, rect, 2)).toEqual({ x: 100, y: 50 })
  })

  it('fits the complete layout inside the viewport and respects zoom bounds', () => {
    expect(fitCanvasZoom({ width: 1000, height: 500 }, { width: 540, height: 290 }, 20)).toBe(0.5)
    expect(fitCanvasZoom({ width: 100, height: 50 }, { width: 1200, height: 900 })).toBe(CANVAS_ZOOM_MAX)
    expect(fitCanvasZoom({ width: 10000, height: 10000 }, { width: 100, height: 100 })).toBe(CANVAS_ZOOM_MIN)
  })

  it('derives and clamps the minimap viewport from scroll and zoom', () => {
    const frame = computeMinimapFrame(
      { width: 1000, height: 500 },
      { width: 400, height: 200, scrollLeft: 300, scrollTop: 150 },
      2,
      { width: 220, height: 120 },
      10,
    )
    expect(frame).toMatchObject({ scale: 0.2, offsetX: 10, offsetY: 10 })
    expect(frame.viewport).toEqual({ x: 40, y: 25, width: 40, height: 20 })

    const clamped = computeMinimapFrame(
      { width: 1000, height: 500 },
      { width: 400, height: 200, scrollLeft: 99999, scrollTop: 99999 },
      1,
      { width: 220, height: 120 },
      10,
    )
    expect(clamped.viewport.x + clamped.viewport.width).toBe(210)
    expect(clamped.viewport.y + clamped.viewport.height).toBe(110)
  })
})
