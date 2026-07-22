export const CANVAS_ZOOM_MIN = 0.25
export const CANVAS_ZOOM_MAX = 2
export const CANVAS_ZOOM_STEP = 1.25

export interface CanvasRectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface CanvasSize {
  width: number
  height: number
}

export interface CanvasViewportState extends CanvasSize {
  scrollLeft: number
  scrollTop: number
}

export interface MinimapFrame {
  scale: number
  offsetX: number
  offsetY: number
  viewport: {
    x: number
    y: number
    width: number
    height: number
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

function nonNegative(value: number): number {
  return Math.max(0, finiteOr(value, 0))
}

export function clampCanvasZoom(value: number): number {
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, finiteOr(value, 1)))
}

export function stepCanvasZoom(current: number, direction: 'in' | 'out'): number {
  const zoom = clampCanvasZoom(current)
  return clampCanvasZoom(direction === 'in' ? zoom * CANVAS_ZOOM_STEP : zoom / CANVAS_ZOOM_STEP)
}

export function fitCanvasZoom(layout: CanvasSize, viewport: CanvasSize, padding = 24): number {
  const safePadding = nonNegative(padding)
  const availableWidth = Math.max(1, nonNegative(viewport.width) - safePadding * 2)
  const availableHeight = Math.max(1, nonNegative(viewport.height) - safePadding * 2)
  const layoutWidth = Math.max(1, nonNegative(layout.width))
  const layoutHeight = Math.max(1, nonNegative(layout.height))
  return clampCanvasZoom(Math.min(availableWidth / layoutWidth, availableHeight / layoutHeight))
}

/** Converts a client-space pointer into unscaled canvas coordinates. */
export function clientToCanvasPoint(
  clientX: number,
  clientY: number,
  rect: CanvasRectLike,
  zoom: number,
): { x: number; y: number } {
  const safeZoom = clampCanvasZoom(zoom)
  return {
    x: (finiteOr(clientX, rect.left) - finiteOr(rect.left, 0)) / safeZoom,
    y: (finiteOr(clientY, rect.top) - finiteOr(rect.top, 0)) / safeZoom,
  }
}

export function computeMinimapFrame(
  layout: CanvasSize,
  viewport: CanvasViewportState,
  zoom: number,
  minimap: CanvasSize,
  padding = 8,
): MinimapFrame {
  const safePadding = nonNegative(padding)
  const layoutWidth = Math.max(1, nonNegative(layout.width))
  const layoutHeight = Math.max(1, nonNegative(layout.height))
  const minimapWidth = Math.max(1, nonNegative(minimap.width))
  const minimapHeight = Math.max(1, nonNegative(minimap.height))
  const contentWidth = Math.max(1, minimapWidth - safePadding * 2)
  const contentHeight = Math.max(1, minimapHeight - safePadding * 2)
  const scale = Math.min(contentWidth / layoutWidth, contentHeight / layoutHeight)
  const renderedWidth = layoutWidth * scale
  const renderedHeight = layoutHeight * scale
  const offsetX = (minimapWidth - renderedWidth) / 2
  const offsetY = (minimapHeight - renderedHeight) / 2
  const safeZoom = clampCanvasZoom(zoom)

  const logicalViewportWidth = Math.min(layoutWidth, nonNegative(viewport.width) / safeZoom)
  const logicalViewportHeight = Math.min(layoutHeight, nonNegative(viewport.height) / safeZoom)
  const maxScrollLeft = Math.max(0, layoutWidth - logicalViewportWidth)
  const maxScrollTop = Math.max(0, layoutHeight - logicalViewportHeight)
  const logicalLeft = Math.min(maxScrollLeft, nonNegative(viewport.scrollLeft) / safeZoom)
  const logicalTop = Math.min(maxScrollTop, nonNegative(viewport.scrollTop) / safeZoom)

  return {
    scale,
    offsetX,
    offsetY,
    viewport: {
      x: offsetX + logicalLeft * scale,
      y: offsetY + logicalTop * scale,
      width: logicalViewportWidth * scale,
      height: logicalViewportHeight * scale,
    },
  }
}
