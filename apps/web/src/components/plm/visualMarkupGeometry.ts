/**
 * Pointer mapping for the markup stage. Y points down. CSS rotate() is
 * clockwise: [cos -sin; sin cos], then zoom about the viewport center.
 */

export interface Point {
  x: number
  y: number
}

export interface RectGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface ArrowGeometry {
  x1: number
  y1: number
  x2: number
  y2: number
}

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export const KEYBOARD_PIN_STEP = 0.01
export const KEYBOARD_PIN_STEP_FAST = 0.05

const MIN_SPAN = 1e-4

export interface ClientMappingInput {
  clientX: number
  clientY: number
  viewportLeft: number
  viewportTop: number
  viewportWidth: number
  viewportHeight: number
  assetWidth: number
  assetHeight: number
  zoom: number
  rotation: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function roundUnit(value: number): number {
  return Math.round(clamp01(value) * 1e6) / 1e6
}

function turnIndex(rotation: number): number {
  return ((Math.round(rotation / 90) % 4) + 4) % 4
}

export function fittedContentSize(
  viewportWidth: number,
  viewportHeight: number,
  assetWidth: number,
  assetHeight: number,
  rotation: number,
): { contentWidth: number; contentHeight: number } {
  if (viewportWidth <= 0 || viewportHeight <= 0) return { contentWidth: 0, contentHeight: 0 }
  const sideways = turnIndex(rotation) % 2 === 1
  const scale = sideways
    ? Math.min(viewportWidth / assetHeight, viewportHeight / assetWidth)
    : Math.min(viewportWidth / assetWidth, viewportHeight / assetHeight)
  return { contentWidth: scale * assetWidth, contentHeight: scale * assetHeight }
}

export function clientToNormalized(input: ClientMappingInput): Point | null {
  const { contentWidth, contentHeight } = fittedContentSize(
    input.viewportWidth,
    input.viewportHeight,
    input.assetWidth,
    input.assetHeight,
    input.rotation,
  )
  if (contentWidth <= 0 || contentHeight <= 0) return null
  const index = turnIndex(input.rotation)
  const cos = [1, 0, -1, 0][index]
  const sin = [0, 1, 0, -1][index]
  const screenX = (input.clientX - (input.viewportLeft + input.viewportWidth / 2)) / input.zoom
  const screenY = (input.clientY - (input.viewportTop + input.viewportHeight / 2)) / input.zoom
  return {
    x: (screenX * cos + screenY * sin + contentWidth / 2) / contentWidth,
    y: (-screenX * sin + screenY * cos + contentHeight / 2) / contentHeight,
  }
}

export function finalizePoint(point: Point): Point | null {
  if (point.x < -1e-6 || point.y < -1e-6 || point.x > 1 + 1e-6 || point.y > 1 + 1e-6) return null
  return { x: roundUnit(point.x), y: roundUnit(point.y) }
}

export function rectangleFromPoints(start: Point, end: Point): RectGeometry | null {
  const left = clamp01(Math.min(start.x, end.x))
  const top = clamp01(Math.min(start.y, end.y))
  const right = clamp01(Math.max(start.x, end.x))
  const bottom = clamp01(Math.max(start.y, end.y))
  const x = roundUnit(left)
  const y = roundUnit(top)
  let width = Math.round((right - left) * 1e6) / 1e6
  let height = Math.round((bottom - top) * 1e6) / 1e6
  if (x + width > 1) width = Math.round((1 - x) * 1e6) / 1e6
  if (y + height > 1) height = Math.round((1 - y) * 1e6) / 1e6
  if (width <= MIN_SPAN || height <= MIN_SPAN) return null
  return { x, y, width, height }
}

export function arrowFromPoints(start: Point, end: Point): ArrowGeometry | null {
  const arrow = { x1: roundUnit(start.x), y1: roundUnit(start.y), x2: roundUnit(end.x), y2: roundUnit(end.y) }
  if (Math.hypot(arrow.x2 - arrow.x1, arrow.y2 - arrow.y1) <= MIN_SPAN) return null
  return arrow
}

const SCREEN_STEPS: Record<number, Record<ArrowKey, [number, number]>> = {
  0: { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] },
  1: { ArrowRight: [0, -1], ArrowLeft: [0, 1], ArrowDown: [1, 0], ArrowUp: [-1, 0] },
  2: { ArrowRight: [-1, 0], ArrowLeft: [1, 0], ArrowDown: [0, -1], ArrowUp: [0, 1] },
  3: { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [-1, 0], ArrowUp: [1, 0] },
}

export function nudgeNormalizedPoint(point: Point, key: ArrowKey, rotation: number, step: number): Point {
  const [dx, dy] = SCREEN_STEPS[turnIndex(rotation)][key]
  return { x: roundUnit(point.x + dx * step), y: roundUnit(point.y + dy * step) }
}
