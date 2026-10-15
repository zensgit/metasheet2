import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlmVisualMarkupCanvas from '../src/components/plm/PlmVisualMarkupCanvas.vue'
import {
  arrowFromPoints,
  clientToNormalized,
  nudgeNormalizedPoint,
  rectangleFromPoints,
} from '../src/components/plm/visualMarkupGeometry'

interface VisualAnnotation {
  id: string
  body: string
  markup_type: 'pin' | 'rectangle' | 'arrow' | 'callout'
  geometry: Record<string, number>
}

interface ViewportBox {
  left: number
  top: number
  width: number
  height: number
}

interface CanvasState {
  imageUrl: string
  filename: string
  assetWidth: number
  assetHeight: number
  annotations: VisualAnnotation[]
  writable: boolean
  selectedId: string | null
}

const VIEWPORT: ViewportBox = { left: 0, top: 0, width: 200, height: 100 }

function pointer(target: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    pointerId: 1,
  }))
}

function key(target: EventTarget, keyName: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: keyName, ...init }))
}

function mountCanvas(partial: Partial<CanvasState> = {}) {
  const state = reactive<CanvasState>({
    imageUrl: 'https://example.test/raster.png',
    filename: 'raster.png',
    assetWidth: 200,
    assetHeight: 100,
    annotations: [],
    writable: true,
    selectedId: null,
    ...partial,
  })
  const onCreate = vi.fn()
  const onSelect = vi.fn()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app: App = createApp({
    setup() {
      return () => h(PlmVisualMarkupCanvas, {
        imageUrl: state.imageUrl,
        filename: state.filename,
        assetWidth: state.assetWidth,
        assetHeight: state.assetHeight,
        annotations: state.annotations,
        writable: state.writable,
        selectedId: state.selectedId,
        onCreate,
        onSelect,
      })
    },
  })
  app.mount(host)
  const stage = host.querySelector('[data-testid="markup-stage"]') as HTMLElement
  const useViewport = (box: ViewportBox) => {
    stage.getBoundingClientRect = () => ({
      x: box.left,
      y: box.top,
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON() { return {} },
    })
  }
  useViewport(VIEWPORT)
  return { app, host, state, onCreate, onSelect, stage, useViewport }
}

describe('visual markup geometry', () => {
  const asset = { assetWidth: 200, assetHeight: 100, zoom: 1, viewportLeft: 0, viewportTop: 0, viewportWidth: 200, viewportHeight: 100 }

  it('maps the fitted image at 0, 90, 180 and 270 degrees', () => {
    expect(clientToNormalized({ ...asset, rotation: 0, clientX: 0, clientY: 0 })).toEqual({ x: 0, y: 0 })
    expect(clientToNormalized({ ...asset, rotation: 0, clientX: 100, clientY: 50 })).toEqual({ x: 0.5, y: 0.5 })
    expect(clientToNormalized({ ...asset, rotation: 90, clientX: 125, clientY: 0 })).toEqual({ x: 0, y: 0 })
    expect(clientToNormalized({ ...asset, rotation: 90, clientX: 100, clientY: 50 })).toEqual({ x: 0.5, y: 0.5 })
    expect(clientToNormalized({ ...asset, rotation: 180, clientX: 200, clientY: 100 })).toEqual({ x: 0, y: 0 })
    expect(clientToNormalized({ ...asset, rotation: 270, clientX: 75, clientY: 100 })).toEqual({ x: 0, y: 0 })
  })

  it('keeps pointer mapping correct after zoom and after the viewport is resized', () => {
    expect(clientToNormalized({ ...asset, rotation: 0, zoom: 2, clientX: 0, clientY: 0 })).toEqual({ x: 0.25, y: 0.25 })
    expect(clientToNormalized({ ...asset, rotation: 90, zoom: 2, clientX: 150, clientY: -50 })).toEqual({ x: 0, y: 0 })
    expect(clientToNormalized({
      ...asset,
      rotation: 0,
      viewportWidth: 400,
      viewportHeight: 100,
      clientX: 100,
      clientY: 0,
    })).toEqual({ x: 0, y: 0 })
    expect(clientToNormalized({
      ...asset,
      rotation: 0,
      viewportLeft: 50,
      viewportTop: 30,
      clientX: 150,
      clientY: 80,
    })).toEqual({ x: 0.5, y: 0.5 })
  })

  it('normalizes rectangle and arrow geometry and rejects degenerates', () => {
    expect(rectangleFromPoints({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.2 })).toEqual({ x: 0.2, y: 0.2, width: 0.4, height: 0.6 })
    expect(rectangleFromPoints({ x: 0.2, y: 0.2 }, { x: -0.25, y: 2.5 })).toEqual({ x: 0, y: 0.2, width: 0.2, height: 0.8 })
    expect(rectangleFromPoints({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.9 })).toBeNull()
    expect(arrowFromPoints({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 })).toEqual({ x1: 0.8, y1: 0.7, x2: 0.2, y2: 0.1 })
    expect(arrowFromPoints({ x: 0.4, y: 0.4 }, { x: 0.4, y: 0.4 })).toBeNull()
  })

  it('nudges a keyboard pin along the screen direction after rotation', () => {
    expect(nudgeNormalizedPoint({ x: 0.5, y: 0.5 }, 'ArrowRight', 0, 0.01)).toEqual({ x: 0.51, y: 0.5 })
    expect(nudgeNormalizedPoint({ x: 0.5, y: 0.5 }, 'ArrowRight', 90, 0.01)).toEqual({ x: 0.5, y: 0.49 })
    expect(nudgeNormalizedPoint({ x: 0.5, y: 0.5 }, 'ArrowRight', 180, 0.01)).toEqual({ x: 0.49, y: 0.5 })
    expect(nudgeNormalizedPoint({ x: 0.5, y: 0.5 }, 'ArrowRight', 270, 0.01)).toEqual({ x: 0.5, y: 0.51 })
    expect(nudgeNormalizedPoint({ x: 0.01, y: 0.5 }, 'ArrowLeft', 0, 0.05)).toEqual({ x: 0, y: 0.5 })
  })
})

describe('PlmVisualMarkupCanvas', () => {
  let mounted: ReturnType<typeof mountCanvas> | null = null

  afterEach(() => {
    mounted?.app.unmount()
    mounted?.host.remove()
    mounted = null
  })

  function setup(partial: Partial<CanvasState> = {}) {
    mounted?.app.unmount()
    mounted?.host.remove()
    mounted = mountCanvas(partial)
    return mounted
  }

  function clickTool(host: HTMLElement, kind: 'pin' | 'rectangle' | 'arrow' | 'callout'): void {
    const button = host.querySelector(`[data-testid="markup-tool-${kind}"]`) as HTMLButtonElement
    button.click()
  }

  it('fits in layout pixels when CSS zoom doubles the rendered bounding rectangle', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200)
    const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200,
      toJSON() { return {} },
    })
    try {
      const current = setup()
      await nextTick()
      const content = current.host.querySelector('.content') as HTMLElement
      expect(content.style.width).toBe('200px')
      expect(content.style.height).toBe('100px')
      current.useViewport({ left: 0, top: 0, width: 400, height: 200 })
      pointer(current.stage, 'pointerdown', 100, 50)
      pointer(current.stage, 'pointerup', 100, 50)
      expect(current.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.25, y: 0.25 })
    } finally { width.mockRestore(); height.mockRestore(); bounds.mockRestore() }
  })

  it('keeps one annotation keyboard reachable after the selected annotation disappears', async () => {
    const current = setup({ annotations: [
      { id: 'a', body: 'first', markup_type: 'pin', geometry: { x: 0.2, y: 0.3 } },
      { id: 'b', body: 'second', markup_type: 'pin', geometry: { x: 0.4, y: 0.5 } },
    ], selectedId: 'b' })
    expect(current.host.querySelector('[tabindex="0"][role="option"]')?.textContent).toContain('second')
    current.state.annotations = current.state.annotations.slice(0, 1)
    await nextTick()
    const option = current.host.querySelector('[tabindex="0"][role="option"]') as HTMLElement
    expect(option).not.toBeNull()
    key(option, 'Enter')
    expect(current.onSelect).toHaveBeenLastCalledWith('a')
  })

  it('places each geometry once, frozen, and only when the gesture completes', async () => {
    const pin = setup()
    pointer(pin.stage, 'pointerdown', 100, 50)
    pointer(pin.stage, 'pointermove', 110, 50)
    expect(pin.onCreate).not.toHaveBeenCalled()
    pointer(pin.stage, 'pointerup', 100, 50)
    expect(pin.onCreate).toHaveBeenCalledTimes(1)
    const pinPayload = pin.onCreate.mock.calls[0][0]
    expect(pinPayload).toEqual({ markup_type: 'pin', geometry: { x: 0.5, y: 0.5 } })
    expect(Object.isFrozen(pinPayload)).toBe(true)
    expect(Object.isFrozen(pinPayload.geometry)).toBe(true)
    expect(Object.keys(pinPayload.geometry)).toEqual(['x', 'y'])

    const rectangle = setup()
    clickTool(rectangle.host, 'rectangle')
    pointer(rectangle.stage, 'pointerdown', 40, 20)
    pointer(rectangle.stage, 'pointermove', 120, 80)
    expect(rectangle.onCreate).not.toHaveBeenCalled()
    pointer(rectangle.stage, 'pointerup', 120, 80)
    expect(rectangle.onCreate.mock.calls[0][0]).toEqual({
      markup_type: 'rectangle',
      geometry: { x: 0.2, y: 0.2, width: 0.4, height: 0.6 },
    })

    const arrow = setup()
    clickTool(arrow.host, 'arrow')
    pointer(arrow.stage, 'pointerdown', 160, 70)
    pointer(arrow.stage, 'pointermove', 40, 10)
    pointer(arrow.stage, 'pointerup', 40, 10)
    expect(arrow.onCreate.mock.calls[0][0]).toEqual({
      markup_type: 'arrow',
      geometry: { x1: 0.8, y1: 0.7, x2: 0.2, y2: 0.1 },
    })

    const callout = setup()
    clickTool(callout.host, 'callout')
    pointer(callout.stage, 'pointerdown', 40, 20)
    pointer(callout.stage, 'pointerup', 40, 20)
    const calloutPayload = callout.onCreate.mock.calls[0][0] as { markup_type: string; geometry: Record<string, number>; body?: string }
    expect(calloutPayload.markup_type).toBe('callout')
    expect(calloutPayload.geometry).toEqual({ x: 0.2, y: 0.2 })
    expect(calloutPayload.body).toBeUndefined()
    expect(Object.keys(calloutPayload)).toEqual(['markup_type', 'geometry'])
  })

  it('clamps a rectangle into the image and ignores degenerate or outside pin gestures', () => {
    const rectangle = setup()
    clickTool(rectangle.host, 'rectangle')
    pointer(rectangle.stage, 'pointerdown', 40, 20)
    pointer(rectangle.stage, 'pointermove', -50, 250)
    pointer(rectangle.stage, 'pointerup', -50, 250)
    const geometry = rectangle.onCreate.mock.calls[0][0].geometry as { x: number; y: number; width: number; height: number }
    expect(geometry).toEqual({ x: 0, y: 0.2, width: 0.2, height: 0.8 })
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(1)
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(1)

    const missed = setup()
    pointer(missed.stage, 'pointerdown', -10, -10)
    pointer(missed.stage, 'pointerup', -10, -10)
    pointer(missed.stage, 'pointerdown', 100, 50)
    pointer(missed.stage, 'pointerup', -10, -10)
    clickTool(missed.host, 'rectangle')
    pointer(missed.stage, 'pointerdown', 80, 40)
    pointer(missed.stage, 'pointerup', 80, 40)
    expect(missed.onCreate).not.toHaveBeenCalled()
  })

  it('maps a dragged rectangle after rotation and a pin after zoom, fit and resize', async () => {
    const rotated = setup()
    ;(rotated.host.querySelector('[data-testid="markup-rotate"]') as HTMLButtonElement).click()
    await nextTick()
    expect(rotated.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('90°')
    clickTool(rotated.host, 'rectangle')
    pointer(rotated.stage, 'pointerdown', 112.5, 25)
    pointer(rotated.stage, 'pointermove', 87.5, 75)
    pointer(rotated.stage, 'pointerup', 87.5, 75)
    expect(rotated.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })

    const zoomed = setup()
    ;(zoomed.host.querySelector('[data-testid="markup-zoom-in"]') as HTMLButtonElement).click()
    await nextTick()
    expect(zoomed.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('125%')
    pointer(zoomed.stage, 'pointerdown', 0, 0)
    pointer(zoomed.stage, 'pointerup', 0, 0)
    expect(zoomed.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.1, y: 0.1 })
    ;(zoomed.host.querySelector('[data-testid="markup-fit"]') as HTMLButtonElement).click()
    await nextTick()
    pointer(zoomed.stage, 'pointerdown', 0, 0)
    pointer(zoomed.stage, 'pointerup', 0, 0)
    expect(zoomed.onCreate.mock.calls[1][0].geometry).toEqual({ x: 0, y: 0 })

    const resized = setup()
    resized.useViewport({ left: 50, top: 30, width: 400, height: 200 })
    pointer(resized.stage, 'pointerdown', 50, 30)
    pointer(resized.stage, 'pointerup', 50, 30)
    expect(resized.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0, y: 0 })
    pointer(resized.stage, 'pointerdown', 250, 130)
    pointer(resized.stage, 'pointerup', 250, 130)
    expect(resized.onCreate.mock.calls[1][0].geometry).toEqual({ x: 0.5, y: 0.5 })
  })

  it('blocks every create path while read-only and cancels an in-progress draft', async () => {
    const readOnly = setup({ writable: false })
    const pinButton = readOnly.host.querySelector('[data-testid="markup-tool-pin"]') as HTMLButtonElement
    expect(pinButton.disabled).toBe(true)
    expect(pinButton.getAttribute('aria-pressed')).toBe('false')
    expect(readOnly.host.querySelector('[data-testid="markup-keyboard-help"]')?.textContent).toContain('只读')
    pointer(readOnly.stage, 'pointerdown', 100, 50)
    pointer(readOnly.stage, 'pointerup', 100, 50)
    readOnly.stage.focus()
    key(readOnly.stage, 'Enter')
    ;(readOnly.host.querySelector('[data-testid="markup-rotate"]') as HTMLButtonElement).click()
    await nextTick()
    expect(readOnly.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('90°')
    expect(readOnly.onCreate).not.toHaveBeenCalled()

    const live = setup()
    clickTool(live.host, 'rectangle')
    pointer(live.stage, 'pointerdown', 40, 20)
    pointer(live.stage, 'pointermove', 120, 80)
    await nextTick()
    expect(live.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).not.toBeNull()
    live.state.writable = false
    await nextTick()
    expect(live.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).toBeNull()
    pointer(live.stage, 'pointerup', 120, 80)
    expect(live.onCreate).not.toHaveBeenCalled()
  })

  it('cancels a drag with Escape and pointercancel without emitting', async () => {
    const escaped = setup()
    clickTool(escaped.host, 'arrow')
    pointer(escaped.stage, 'pointerdown', 20, 20)
    pointer(escaped.stage, 'pointermove', 140, 70)
    await nextTick()
    expect(escaped.host.querySelector('[data-kind="arrow"][data-draft="true"]')).not.toBeNull()
    key(window, 'Escape')
    await nextTick()
    expect(escaped.host.querySelector('[data-kind="arrow"][data-draft="true"]')).toBeNull()
    pointer(escaped.stage, 'pointerup', 140, 70)
    expect(escaped.onCreate).not.toHaveBeenCalled()

    const cancelled = setup()
    clickTool(cancelled.host, 'rectangle')
    pointer(cancelled.stage, 'pointerdown', 30, 20)
    pointer(cancelled.stage, 'pointermove', 150, 80)
    await nextTick()
    const cancelButton = cancelled.host.querySelector('[data-testid="markup-cancel"]') as HTMLButtonElement
    expect(cancelButton.disabled).toBe(false)
    cancelButton.click()
    pointer(cancelled.stage, 'pointerup', 150, 80)
    pointer(cancelled.stage, 'pointerdown', 30, 20)
    pointer(cancelled.stage, 'pointermove', 150, 80)
    await nextTick()
    expect(cancelled.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).not.toBeNull()
    pointer(cancelled.stage, 'pointercancel', 150, 80)
    await nextTick()
    expect(cancelled.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).toBeNull()
    pointer(cancelled.stage, 'pointerup', 150, 80)
    expect(cancelled.onCreate).not.toHaveBeenCalled()
  })

  it('places a pin from the keyboard and follows the screen direction after rotation', async () => {
    const board = setup()
    const help = board.host.querySelector('[data-testid="markup-keyboard-help"]')
    expect(help?.textContent).toContain('方向键')
    expect(help?.textContent).toContain('Enter')
    board.stage.focus()
    expect(board.stage.getAttribute('aria-describedby')).toBe('plm-markup-pin-help')
    key(board.stage, 'ArrowRight')
    expect(board.onCreate).not.toHaveBeenCalled()
    key(board.stage, 'Enter')
    expect(board.onCreate.mock.calls[0][0]).toEqual({ markup_type: 'pin', geometry: { x: 0.51, y: 0.5 } })

    const fast = setup()
    fast.stage.focus()
    key(fast.stage, 'ArrowDown', { shiftKey: true })
    key(fast.stage, 'Enter')
    expect(fast.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.5, y: 0.55 })

    const turned = setup()
    ;(turned.host.querySelector('[data-testid="markup-rotate"]') as HTMLButtonElement).click()
    await nextTick()
    turned.stage.focus()
    key(turned.stage, 'ArrowRight')
    key(turned.stage, 'Enter')
    expect(turned.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.5, y: 0.49 })
  })

  it('selects annotations from the list without showing ids, coordinates or unescaped html', async () => {
    const annotations: VisualAnnotation[] = [
      { id: 'secret-pin-id', body: '<b>bold</b>', markup_type: 'pin', geometry: { x: 0.2, y: 0.3 } },
      { id: 'secret-callout-id', body: '引注正文', markup_type: 'callout', geometry: { x: 0.6, y: 0.4 } },
      { id: 'secret-rect-id', body: '区域说明', markup_type: 'rectangle', geometry: { x: 0.1, y: 0.15, width: 0.3, height: 0.25 } },
    ]
    const board = setup({ annotations, selectedId: 'secret-pin-id' })
    await nextTick()
    const text = board.host.querySelector('[data-testid="markup-list"]')?.textContent ?? ''
    expect(text).toContain('图钉')
    expect(text).toContain('<b>bold</b>')
    expect(text).toContain('引注')
    expect(text).toContain('引注正文')
    expect(text).toContain('矩形')
    expect(text).toContain('区域说明')
    expect(text).not.toContain('secret-pin-id')
    expect(text).not.toContain('secret-callout-id')
    expect(text).not.toContain('secret-rect-id')
    expect(text).not.toContain('0.2')
    expect(board.host.querySelector('b')).toBeNull()
    expect(board.host.innerHTML).toContain('&lt;b&gt;')
    expect(board.host.querySelector('svg')?.textContent).not.toContain('引注正文')
    expect(board.host.querySelector('[data-kind="rectangle"]')).not.toBeNull()
    expect(board.host.querySelector('[data-kind="pin"]')).not.toBeNull()
    expect(board.host.querySelector('[data-kind="callout"]')).not.toBeNull()
    expect(board.host.querySelector('.is-selected')).not.toBeNull()

    const options = board.host.querySelectorAll<HTMLElement>('[data-testid="markup-option"]')
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    options[0]?.focus()
    key(options[0]!, 'ArrowDown')
    expect(board.onSelect).toHaveBeenCalledWith('secret-callout-id')
    board.state.selectedId = 'secret-callout-id'
    await nextTick()
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    expect(board.host.querySelectorAll('.is-selected').length).toBeGreaterThan(0)
    options[1]?.focus()
    await nextTick()
    expect(board.host.querySelector('.is-focused')).not.toBeNull()
    expect(board.onCreate).not.toHaveBeenCalled()
    expect(JSON.stringify(annotations)).toBe(JSON.stringify([
      { id: 'secret-pin-id', body: '<b>bold</b>', markup_type: 'pin', geometry: { x: 0.2, y: 0.3 } },
      { id: 'secret-callout-id', body: '引注正文', markup_type: 'callout', geometry: { x: 0.6, y: 0.4 } },
      { id: 'secret-rect-id', body: '区域说明', markup_type: 'rectangle', geometry: { x: 0.1, y: 0.15, width: 0.3, height: 0.25 } },
    ]))
  })

  it('resets the draft, keyboard pin and view when the asset changes', async () => {
    const board = setup()
    clickTool(board.host, 'rectangle')
    pointer(board.stage, 'pointerdown', 40, 20)
    pointer(board.stage, 'pointermove', 120, 80)
    await nextTick()
    expect(board.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).not.toBeNull()
    ;(board.host.querySelector('[data-testid="markup-zoom-in"]') as HTMLButtonElement).click()
    ;(board.host.querySelector('[data-testid="markup-rotate"]') as HTMLButtonElement).click()
    await nextTick()
    expect(board.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('125%')
    expect(board.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('90°')
    board.state.imageUrl = 'https://example.test/other.png'
    board.state.filename = 'other.png'
    board.state.assetWidth = 320
    board.state.assetHeight = 240
    await nextTick()
    expect(board.host.querySelector('[data-kind="rectangle"][data-draft="true"]')).toBeNull()
    expect(board.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('100%')
    expect(board.host.querySelector('[data-testid="markup-view-status"]')?.textContent).toContain('0°')
    pointer(board.stage, 'pointerup', 120, 80)
    clickTool(board.host, 'pin')
    board.stage.focus()
    key(board.stage, 'ArrowRight')
    key(board.stage, 'Enter')
    expect(board.onCreate).toHaveBeenCalledTimes(1)
    expect(board.onCreate.mock.calls[0][0].geometry).toEqual({ x: 0.51, y: 0.5 })
  })

  it('exposes Chinese pressed tools, a stable stage ratio and reduced-motion rules', async () => {
    const board = setup()
    const rectangle = board.host.querySelector('[data-testid="markup-tool-rectangle"]') as HTMLButtonElement
    const pin = board.host.querySelector('[data-testid="markup-tool-pin"]') as HTMLButtonElement
    expect(pin.getAttribute('aria-pressed')).toBe('true')
    rectangle.click()
    await nextTick()
    expect(rectangle.getAttribute('aria-pressed')).toBe('true')
    expect(pin.getAttribute('aria-pressed')).toBe('false')
    expect(board.host.textContent).toContain('放大')
    expect(board.host.textContent).toContain('适应')
    const stage = board.host.querySelector('[data-testid="markup-stage"]') as HTMLElement
    expect(stage.style.aspectRatio).toBe('200 / 100')
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/components/plm/PlmVisualMarkupCanvas.vue'), 'utf8')
    expect(source).toContain('prefers-reduced-motion: reduce')
    expect(source).toContain('max-width: 560px')
    expect(source).not.toContain('v-html')
    expect(board.host.innerHTML).not.toContain('v-html')
  })
})
