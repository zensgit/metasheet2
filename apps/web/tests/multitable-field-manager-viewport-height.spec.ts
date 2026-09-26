// #5864 ② (customer feedback 2026-09-18 #6: "字段列表与设置面板高度固定，浏览不便，需可拉伸或随窗口高度自适应").
//
// MetaFieldManager.vue is the only place the multitable「管理字段」field list and its field-config
// pane render (MultitableWorkbench.vue mounts it as a full-viewport overlay). r8-B already made the
// split resizable; what was still NOT tied to the window height, and what this file pins:
//   - the frame capped at `84vh` instead of using the window minus a gutter;
//   - the config pane height was a px snapshot: a window that shrank and grew back left it clamped,
//     a stored height larger than the current ceiling was clamped at READ time and lost, and the
//     untouched default never followed the window after mount;
//   - the ceiling ignored the add-field footer / delete confirmation (a hardcoded 160px guess);
//   - the pane was flex-shrinkable, so with tall content it rendered smaller than the splitter said.
// jsdom lays nothing out, so this file proves the STATE machine and the measured-row arithmetic
// (with offsetHeight stubbed), plus the CSS contract at source level. The rendered layout at 800px /
// 1080px windows is proven in a real browser by apps/web/verification/field-manager-viewport.spec.ts.
//
// Registration: its own token `multitable-field-manager-viewport-height` sits in the sorted exec
// block of apps/web/scripts/run-required-web-tests.sh (the always-on required web lane). The older
// `multitable-field-manager` token there and on multitable-web-guard.yml's vitest line is a path
// SUBSTRING filter that also collects this file, so the path-filtered guard runs it too without a
// workflow edit (same arrangement as multitable-field-manager-link-target.spec.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'

const SFC_SOURCE = readFileSync(join(__dirname, '../src/multitable/components/MetaFieldManager.vue'), 'utf8')
const STYLE_BLOCK = SFC_SOURCE.slice(SFC_SOURCE.indexOf('<style scoped>'))
/** The <style> block with every comment removed, so prose that NAMES an old value cannot satisfy or fail a check. */
const STYLE_DECLARATIONS = STYLE_BLOCK.replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return STYLE_DECLARATIONS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}
function scriptConstant(name: string): number {
  const match = SFC_SOURCE.match(new RegExp(`const ${name} = (\\d+)\\b`))
  expect(match, `script constant ${name}`).toBeTruthy()
  return Number(match![1])
}

const CONFIG_PANE_STORAGE_KEY = 'metasheet.fieldManager.configPaneHeight'
const CONFIG_PANE_MIN = 120
const CONFIG_PANE_STEP = 16
const GUTTER = 32
const SPLITTER = 6
const LIST_FLOOR = 96
const FALLBACK_ROWS = 131

/** The component's ceiling for a given window height and total fixed-row height (header + footer + confirm). */
function ceiling(viewport: number, rows: number): number {
  return Math.max(CONFIG_PANE_MIN, Math.round(viewport - GUTTER - rows - SPLITTER - LIST_FLOOR))
}
function defaultSplit(viewport: number, rows: number): number {
  const available = viewport - GUTTER - rows - SPLITTER
  return Math.max(CONFIG_PANE_MIN, Math.min(ceiling(viewport, rows), Math.round(available / 2)))
}

function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
  window.dispatchEvent(new Event('resize'))
}

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/** Per-class offsetHeight stub: jsdom reports 0 for every element, which is the "unmeasurable" path. */
const rowHeights: Record<string, number> = {}
function stubRowHeights(heights: Record<string, number>) {
  Object.assign(rowHeights, heights)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offsetHeight(this: HTMLElement) {
    for (const [className, height] of Object.entries(rowHeights)) {
      if (this.classList.contains(className)) return height
    }
    return 0
  })
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  disconnected = false
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element) { this.observed.add(target) }
  unobserve(target: Element) { this.observed.delete(target) }
  disconnect() { this.disconnected = true; this.observed.clear() }
  trigger() { this.callback([], this as unknown as ResizeObserver) }
}

async function mountWithConfigOpen(viewportHeight: number) {
  setViewportHeight(viewportHeight)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaFieldManager, {
        visible: true,
        sheetId: 'sheet_1',
        sheets: [],
        fields: [
          { id: 'fld_qty', name: 'Qty', type: 'number', property: {} },
          { id: 'fld_note', name: 'Note', type: 'string', property: {} },
        ],
      })
    },
  })
  app.mount(container)
  await flushUi()
  const row = Array.from(container.querySelectorAll('.meta-field-mgr__row'))
    .find((r) => r.querySelector('.meta-field-mgr__name')?.textContent === 'Qty')
  ;(row!.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement).click()
  await flushUi()
  return { container, app }
}

function splitter(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[data-test="field-mgr-splitter"]')!
}
function published(container: HTMLElement): number {
  const root = container.querySelector<HTMLElement>('.meta-field-mgr')!
  return Number(root.style.getPropertyValue('--meta-field-mgr-config-height').replace('px', ''))
}
function aria(container: HTMLElement) {
  const el = splitter(container)
  return { now: Number(el.getAttribute('aria-valuenow')), max: Number(el.getAttribute('aria-valuemax')) }
}
function keydown(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}
function keyup(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const key of Object.keys(rowHeights)) delete rowHeights[key]
  FakeResizeObserver.instances = []
  window.localStorage.clear()
  setViewportHeight(768)
})

// ----------------------------------------------------------------------------------------------
// Source level: the CSS half of the contract (jsdom parses no <style scoped>).
// ----------------------------------------------------------------------------------------------
describe('MetaFieldManager <style> — frame, fixed rows and config pane follow the window (#5864 ②)', () => {
  it('sizes the frame to the window minus the gutter; the old 84vh cap is gone', () => {
    const frame = ruleBody('.meta-field-mgr')
    expect(frame).not.toBe('')
    expect(frame).toMatch(/max-height:\s*calc\(100vh - 32px\)/)
    expect(frame).toMatch(/max-height:\s*calc\(100dvh - 32px\)/)
    // Comments stripped: only a live declaration could reintroduce the old cap.
    expect(STYLE_DECLARATIONS).not.toMatch(/84vh/)
  })

  it('keeps the frame out of the scroll business: only the list and the config pane scroll', () => {
    const frame = ruleBody('.meta-field-mgr')
    expect(frame).not.toMatch(/overflow/)
    expect(ruleBody('.meta-field-mgr__body')).toMatch(/overflow-y:\s*auto/)
    expect(ruleBody('.meta-field-mgr__config--scrollable')).toMatch(/overflow-y:\s*auto/)
  })

  it('never shrinks the header, the add-field footer or the delete confirmation', () => {
    for (const selector of ['.meta-field-mgr__header', '.meta-field-mgr__add-section', '.meta-field-mgr__confirm']) {
      expect(ruleBody(selector), selector).toMatch(/flex-shrink:\s*0/)
    }
  })

  it('renders the config pane at exactly the published height (border-box, not flex-shrinkable)', () => {
    const pane = ruleBody('.meta-field-mgr__config--scrollable')
    expect(pane).toMatch(/box-sizing:\s*border-box/)
    expect(pane).toMatch(/flex-shrink:\s*0/)
    expect(pane).toMatch(/max-height:\s*var\(--meta-field-mgr-config-height,/)
  })

  it('keeps every script constant equal to the CSS literal it mirrors', () => {
    const gutter = STYLE_DECLARATIONS.match(/\.meta-field-mgr\s*\{[^}]*max-height:\s*calc\(100vh - (\d+)px\)/)?.[1]
    expect(scriptConstant('FRAME_VIEWPORT_GUTTER')).toBe(Number(gutter))
    // The frame's width uses the same gutter as its height.
    expect(ruleBody('.meta-field-mgr')).toMatch(new RegExp(`max-width:\\s*calc\\(100vw - ${gutter}px\\)`))
    expect(scriptConstant('FIELD_LIST_MIN_HEIGHT')).toBe(Number(ruleBody('.meta-field-mgr__body').match(/min-height:\s*(\d+)px/)?.[1]))
    expect(scriptConstant('SPLITTER_HEIGHT')).toBe(Number(ruleBody('.meta-field-mgr__splitter').match(/(?:^|[\s;])height:\s*(\d+)px/)?.[1]))
    // The CSS fallback (used only if the inline var is absent) is the script's default split.
    const fallback = ruleBody('.meta-field-mgr__config--scrollable').match(/calc\(\(100vh - (\d+)px\) \/ 2\)/)?.[1]
    expect(Number(fallback)).toBe(
      scriptConstant('FRAME_VIEWPORT_GUTTER') + scriptConstant('FALLBACK_CHROME_HEIGHT') + scriptConstant('SPLITTER_HEIGHT'),
    )
  })
})

// ----------------------------------------------------------------------------------------------
// Mounted: the ceiling is the window minus the MEASURED rows.
// ----------------------------------------------------------------------------------------------
describe('MetaFieldManager — config pane ceiling from measured rows (#5864 ②)', () => {
  it('uses the real header + footer heights, not a guess', async () => {
    stubRowHeights({ 'meta-field-mgr__header': 60, 'meta-field-mgr__add-section': 80 })
    const { container, app } = await mountWithConfigOpen(900)
    try {
      expect(aria(container).max).toBe(ceiling(900, 140))
      expect(aria(container).now).toBe(defaultSplit(900, 140))
      expect(published(container)).toBe(defaultSplit(900, 140))
    } finally {
      app.unmount()
    }
  })

  it('falls back to the documented 131px only when nothing can be measured', async () => {
    const { container, app } = await mountWithConfigOpen(900)
    try {
      expect(aria(container).max).toBe(ceiling(900, FALLBACK_ROWS))
      expect(aria(container).now).toBe(defaultSplit(900, FALLBACK_ROWS))
    } finally {
      app.unmount()
    }
  })

  it('counts the delete confirmation row while it is shown, and gives the room back when it goes', async () => {
    stubRowHeights({ 'meta-field-mgr__header': 60, 'meta-field-mgr__add-section': 80, 'meta-field-mgr__confirm': 50 })
    const { container, app } = await mountWithConfigOpen(900)
    try {
      expect(aria(container).max).toBe(ceiling(900, 140))
      ;(container.querySelector('.meta-field-mgr__row .meta-field-mgr__action--danger') as HTMLButtonElement).click()
      await flushUi()
      expect(container.querySelector('.meta-field-mgr__confirm')).toBeTruthy()
      expect(aria(container).max).toBe(ceiling(900, 190))
      ;(container.querySelector('.meta-field-mgr__confirm .meta-field-mgr__btn-cancel') as HTMLElement).click()
      await flushUi()
      expect(container.querySelector('.meta-field-mgr__confirm')).toBeFalsy()
      expect(aria(container).max).toBe(ceiling(900, 140))
    } finally {
      app.unmount()
    }
  })

  it('re-measures when a row resizes (ResizeObserver), and disconnects on unmount', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    stubRowHeights({ 'meta-field-mgr__header': 60, 'meta-field-mgr__add-section': 80 })
    const { container, app } = await mountWithConfigOpen(900)
    const live = FakeResizeObserver.instances.filter((observer) => !observer.disconnected)
    expect(live).toHaveLength(1)
    const observed = [...live[0].observed].map((el) => (el as HTMLElement).className)
    expect(observed.some((name) => name.includes('meta-field-mgr__header'))).toBe(true)
    expect(observed.some((name) => name.includes('meta-field-mgr__add-section'))).toBe(true)

    // The footer's "name required" hint disappears once a name is typed: the row gets shorter.
    rowHeights['meta-field-mgr__add-section'] = 59
    live[0].trigger()
    await flushUi()
    expect(aria(container).max).toBe(ceiling(900, 119))

    app.unmount()
    expect(FakeResizeObserver.instances.every((observer) => observer.disconnected)).toBe(true)
  })

  it('without ResizeObserver, a window resize still re-measures the rows (a narrower window can re-wrap them)', async () => {
    stubRowHeights({ 'meta-field-mgr__header': 60, 'meta-field-mgr__add-section': 80 })
    const { container, app } = await mountWithConfigOpen(900)
    try {
      expect(typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver).toBe('undefined')
      expect(aria(container).max).toBe(ceiling(900, 140))
      rowHeights['meta-field-mgr__add-section'] = 104
      // Same height, so only the re-measure (not the viewport arithmetic) can move the ceiling.
      setViewportHeight(900)
      await flushUi()
      expect(aria(container).max).toBe(ceiling(900, 164))
    } finally {
      app.unmount()
    }
  })
})

// ----------------------------------------------------------------------------------------------
// Mounted: the rendered height is derived from (window, manual choice), never a stale snapshot.
// ----------------------------------------------------------------------------------------------
describe('MetaFieldManager — config pane height follows the window both ways (#5864 ②)', () => {
  it('an untouched split follows the window up and down', async () => {
    const { container, app } = await mountWithConfigOpen(1000)
    try {
      expect(published(container)).toBe(defaultSplit(1000, FALLBACK_ROWS))
      setViewportHeight(1400)
      await flushUi()
      expect(published(container)).toBe(defaultSplit(1400, FALLBACK_ROWS))
      expect(aria(container).now).toBe(defaultSplit(1400, FALLBACK_ROWS))
      setViewportHeight(700)
      await flushUi()
      expect(published(container)).toBe(defaultSplit(700, FALLBACK_ROWS))
    } finally {
      app.unmount()
    }
  })

  it('a manual height is clamped by a short window and comes back in full when the window grows again', async () => {
    const { container, app } = await mountWithConfigOpen(1000)
    try {
      const el = splitter(container)
      for (let i = 0; i < 5; i += 1) keydown(el, 'ArrowUp')
      keyup(el, 'ArrowUp')
      await flushUi()
      const chosen = defaultSplit(1000, FALLBACK_ROWS) + 5 * CONFIG_PANE_STEP
      expect(published(container)).toBe(chosen)

      setViewportHeight(500)
      await flushUi()
      expect(chosen).toBeGreaterThan(ceiling(500, FALLBACK_ROWS))
      expect(published(container)).toBe(ceiling(500, FALLBACK_ROWS))
      expect(aria(container).now).toBeLessThanOrEqual(aria(container).max)

      setViewportHeight(1000)
      await flushUi()
      expect(published(container)).toBe(chosen)
      expect(aria(container).now).toBe(chosen)
      // A window change is not a user choice: nothing new was written.
      expect(window.localStorage.getItem(CONFIG_PANE_STORAGE_KEY)).toBe(String(chosen))
    } finally {
      app.unmount()
    }
  })

  it('a stored height above the current ceiling is kept, not clamped away at read time', async () => {
    window.localStorage.setItem(CONFIG_PANE_STORAGE_KEY, '700')
    const { container, app } = await mountWithConfigOpen(800)
    try {
      expect(published(container)).toBe(ceiling(800, FALLBACK_ROWS))
      setViewportHeight(1200)
      await flushUi()
      expect(published(container)).toBe(700)
    } finally {
      app.unmount()
    }
  })

  it('writes nothing to localStorage while no height was ever chosen (enlarge/collapse included)', async () => {
    const { container, app } = await mountWithConfigOpen(1000)
    try {
      const setItem = vi.spyOn(window.localStorage, 'setItem')
      const toggle = container.querySelector<HTMLButtonElement>('[data-test="field-mgr-config-expand"]')!
      toggle.click()
      await flushUi()
      expect(published(container)).toBe(ceiling(1000, FALLBACK_ROWS))
      toggle.click()
      await flushUi()
      expect(published(container)).toBe(defaultSplit(1000, FALLBACK_ROWS))
      expect(setItem).not.toHaveBeenCalled()
      // ...so the untouched split keeps following the window afterwards.
      setViewportHeight(1300)
      await flushUi()
      expect(published(container)).toBe(defaultSplit(1300, FALLBACK_ROWS))
    } finally {
      app.unmount()
    }
  })
})
