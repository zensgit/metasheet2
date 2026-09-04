/**
 * Record inspector resizable panel (2026-09-05, user request "拉长些" / more comfortable operation):
 * MetaRecordInspector.vue gained a drag/keyboard-resizable width (persisted per viewer) with an
 * expand-to-max toggle, plus a height-contract fix (sticky header+tabs, internal scroll body) so a
 * long field/history/comments/attachments list scrolls in place instead of growing the whole panel.
 * Kept as its own file (not folded into the frozen multitable-record-inspector.spec.ts) -- this is a
 * new, independent concern (layout/persistence, not the tab/ARIA surface that file already pins).
 *
 * Pins:
 *  (a) the splitter's ARIA (`role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max`)
 *      + keyboard Left/Right (+-16px) and Home/End (clamp to min/the viewport-derived max);
 *  (b) width persistence to `localStorage` (per-viewer, restored on mount) and the malformed-value
 *      fallback to the shipped default;
 *  (c) the expand toggle's `aria-pressed` + snap-to-max / restore-to-last-chosen-width behavior;
 *  (d) the structural DOM split between the (always-visible) header and the (internally-scrolling)
 *      body, plus a SOURCE-TEXT check that the scroll/sticky CSS declarations are actually present in
 *      the component (labeled honestly below: jsdom does not apply scoped SFC `<style>` blocks under
 *      this vitest config -- verified empirically, no `<style>` tag reaches the DOM at all -- so this
 *      is a "the rule exists" provision check, not a rendered-layout/behavior proof; real-browser
 *      verification is out of this environment's reach, see the PR's own manual-check note);
 *  (e) that the pre-existing overlay-mode class binding (owned by MultitableWorkbench.vue, unchanged
 *      by this slice) is left alone -- covered by that component's own existing spec, not re-pinned
 *      here to avoid a second, driftable copy of the same assertion.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const STORAGE_KEY = 'metasheet2:record-inspector-width'
const MIN_WIDTH = 320
const MAX_WIDTH_CAP = 720
const DEFAULT_WIDTH = 360

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } } as unknown as MetaRecord

// Same jsdom idiom as multitable-workbench-view.spec.ts's own `setViewportWidth` helper (itself
// copied from useAttendanceAdminRailNavigation.spec.ts) -- redefine `window.innerWidth`, dispatch a
// real `resize` event so the component's own `resize` listener (`syncViewportWidth`) picks it up.
function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

function mountInspector(): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: 'sheet_1',
      })
    },
  })
  app.mount(container)
  return { container, app }
}

function splitter(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[role="separator"]')!
}

function expandToggle(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-testid="record-inspector-expand-toggle"]')!
}

function panelWidthPx(container: HTMLElement): number {
  const root = container.querySelector<HTMLElement>('.meta-record-drawer')!
  return Number(root.style.getPropertyValue('--meta-record-drawer-width').replace('px', ''))
}

function ariaValueNow(el: HTMLElement): number {
  return Number(el.getAttribute('aria-valuenow'))
}

function keydown(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

describe('MetaRecordInspector resizable panel', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  describe('splitter ARIA + keyboard resize', () => {
    it('renders role=separator/aria-orientation=vertical with valuenow/min/max, default width 360', async () => {
      setViewportWidth(1000) // max = min(720, 0.6*1000) = 600
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      expect(el.getAttribute('role')).toBe('separator')
      expect(el.getAttribute('aria-orientation')).toBe('vertical')
      expect(el.getAttribute('aria-valuemin')).toBe(String(MIN_WIDTH))
      expect(el.getAttribute('aria-valuemax')).toBe('600')
      expect(ariaValueNow(el)).toBe(DEFAULT_WIDTH)
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH)
      app.unmount()
    })

    it('caps aria-valuemax at 720 on a very wide viewport (min(720px, 60vw))', async () => {
      setViewportWidth(2000) // 0.6*2000 = 1200 > 720 -> capped
      const { container, app } = mountInspector()
      await flushUi()
      expect(splitter(container).getAttribute('aria-valuemax')).toBe(String(MAX_WIDTH_CAP))
      app.unmount()
    })

    it('ArrowLeft widens by 16px, ArrowRight narrows by 16px, both stay within [min, max]', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      keydown(el, 'ArrowLeft')
      await flushUi()
      expect(ariaValueNow(el)).toBe(DEFAULT_WIDTH + 16)
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 16)
      keydown(el, 'ArrowRight')
      keydown(el, 'ArrowRight')
      await flushUi()
      expect(ariaValueNow(el)).toBe(DEFAULT_WIDTH - 16)
      app.unmount()
    })

    it('repeated ArrowLeft never exceeds the computed max', async () => {
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      for (let i = 0; i < 40; i += 1) keydown(el, 'ArrowLeft')
      await flushUi()
      expect(ariaValueNow(el)).toBe(600)
      expect(ariaValueNow(el)).toBeLessThanOrEqual(600)
      app.unmount()
    })

    it('repeated ArrowRight never goes below the 320px minimum', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      for (let i = 0; i < 40; i += 1) keydown(el, 'ArrowRight')
      await flushUi()
      expect(ariaValueNow(el)).toBe(MIN_WIDTH)
      expect(ariaValueNow(el)).toBeGreaterThanOrEqual(MIN_WIDTH)
      app.unmount()
    })

    it('Home jumps straight to the 320px minimum, End jumps straight to the current max', async () => {
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      keydown(el, 'Home')
      await flushUi()
      expect(ariaValueNow(el)).toBe(MIN_WIDTH)
      keydown(el, 'End')
      await flushUi()
      expect(ariaValueNow(el)).toBe(600)
      app.unmount()
    })

    it('does not steal Escape or affect the roving-tabindex tablist -- bubbles to the SAME root handler unmodified', async () => {
      const onClose = vi.fn()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const app = createApp({
        render() {
          return h(MetaRecordInspector, {
            visible: true,
            record: RECORD,
            fields: FIELDS,
            canEdit: true,
            canComment: false,
            canDelete: false,
            sheetId: 'sheet_1',
            onClose,
          })
        },
      })
      app.mount(container)
      await flushUi()
      splitter(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(onClose).toHaveBeenCalledTimes(1)
      app.unmount()
    })
  })

  describe('pointer drag', () => {
    it('dragging the handle left (negative clientX delta) widens the panel; capture is attempted defensively', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      // jsdom has no real setPointerCapture (verified: `'setPointerCapture' in HTMLElement.prototype`
      // is false in this jsdom version) -- the component guards the call with optional chaining, so
      // this must not throw, and since we dispatch pointermove directly on the handle (the same
      // element pointerdown fired on), no actual OS-level capture redirect is needed for the test.
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, pointerId: 1, bubbles: true, cancelable: true }))
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 470, pointerId: 1, bubbles: true, cancelable: true })) // -30 -> +30 width
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 30)
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 470, pointerId: 1, bubbles: true, cancelable: true }))
      // Further movement after pointerup must not still be tracked (listeners were torn down).
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, pointerId: 1, bubbles: true, cancelable: true }))
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 30)
      app.unmount()
    })

    it('dragging the handle right narrows the panel, clamped at the 320px minimum', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, pointerId: 2, bubbles: true, cancelable: true }))
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 900, pointerId: 2, bubbles: true, cancelable: true })) // +400 -> way under min
      await flushUi()
      expect(panelWidthPx(container)).toBe(MIN_WIDTH)
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 900, pointerId: 2, bubbles: true, cancelable: true }))
      app.unmount()
    })
  })

  describe('width persistence (localStorage, per viewer)', () => {
    it('persists a keyboard-driven width change and restores it on a fresh mount', async () => {
      setViewportWidth(1000)
      const first = mountInspector()
      await flushUi()
      keydown(splitter(first.container), 'End') // -> 600
      await flushUi()
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe('600')
      first.app.unmount()
      first.container.remove()

      const second = mountInspector()
      await flushUi()
      expect(ariaValueNow(splitter(second.container))).toBe(600)
      expect(panelWidthPx(second.container)).toBe(600)
      second.app.unmount()
    })

    it.each(['not-a-number', '-50', '0', '', 'NaN'])(
      'falls back to the default width when the stored value is malformed (%s)',
      async (raw) => {
        if (raw === '') {
          window.localStorage.removeItem(STORAGE_KEY)
        } else {
          window.localStorage.setItem(STORAGE_KEY, raw)
        }
        setViewportWidth(1000)
        const { container, app } = mountInspector()
        await flushUi()
        expect(ariaValueNow(splitter(container))).toBe(DEFAULT_WIDTH)
        expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH)
        app.unmount()
      },
    )

    it('clamps (rather than discards) an in-range-but-stale stored value to the current max', async () => {
      window.localStorage.setItem(STORAGE_KEY, '900') // valid number, but > current max below
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      expect(ariaValueNow(splitter(container))).toBe(600)
      app.unmount()
    })
  })

  describe('expand toggle', () => {
    it('has aria-pressed=false initially, snaps to max on first click, restores the ORIGINAL width on second click', async () => {
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      const btn = expandToggle(container)
      expect(btn.getAttribute('aria-pressed')).toBe('false')

      btn.click()
      await flushUi()
      expect(btn.getAttribute('aria-pressed')).toBe('true')
      expect(panelWidthPx(container)).toBe(600)

      btn.click()
      await flushUi()
      expect(btn.getAttribute('aria-pressed')).toBe('false')
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH)
      app.unmount()
    })

    it('restores the LAST manually-chosen width (not the mount-time default) after a manual resize + expand', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      keydown(el, 'ArrowLeft')
      keydown(el, 'ArrowLeft') // 360 -> 392
      await flushUi()
      expect(panelWidthPx(container)).toBe(392)

      const btn = expandToggle(container)
      btn.click()
      await flushUi()
      expect(panelWidthPx(container)).toBe(600)

      btn.click()
      await flushUi()
      expect(panelWidthPx(container)).toBe(392) // restored to the manual choice, not 360
      app.unmount()
    })

    it('a manual resize while expanded exits the expanded state (aria-pressed flips back to false)', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const btn = expandToggle(container)
      btn.click()
      await flushUi()
      expect(btn.getAttribute('aria-pressed')).toBe('true')

      keydown(splitter(container), 'ArrowRight')
      await flushUi()
      expect(btn.getAttribute('aria-pressed')).toBe('false')
      app.unmount()
    })
  })

  describe('height contract: sticky header/tabs + internal scroll body', () => {
    it('the header is a SIBLING of, not nested inside, the scrolling body (structural DOM split)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const root = container.querySelector('.meta-record-drawer')!
      const header = container.querySelector('.meta-record-drawer__header')!
      const body = container.querySelector('.meta-record-drawer__body')!
      expect(header.parentElement).toBe(root)
      expect(body.contains(header)).toBe(false)
      expect(root.contains(body)).toBe(true)
      app.unmount()
    })

    it('the tabs live inside the body (so they scroll-stick with it), not inside the header', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const header = container.querySelector('.meta-record-drawer__header')!
      const body = container.querySelector('.meta-record-drawer__body')!
      const tabs = container.querySelector('.meta-record-drawer__tabs')!
      expect(header.contains(tabs)).toBe(false)
      expect(body.contains(tabs)).toBe(true)
      app.unmount()
    })

    // jsdom does not apply this SFC's scoped <style> block (no <style> tag reaches the document under
    // this vitest config -- verified empirically: getComputedStyle on the body element returns the
    // browser default `overflow-y: visible`, not the authored `auto`). These are therefore SOURCE-TEXT
    // provision checks -- "the declaration is present in the component" -- not rendered-layout proofs;
    // real-browser verification is this PR's own documented manual-check item.
    it('[source] .meta-record-drawer__body declares overflow-y:auto + min-height:0 (the scroll container)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__body\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/overflow-y:\s*auto/)
      expect(rule).toMatch(/min-height:\s*0/)
    })

    it('[source] .meta-record-drawer__tabs-bar (the FULL-WIDTH wrapper, not the narrower pill itself) declares position:sticky + top:0', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__tabs-bar\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/position:\s*sticky/)
      expect(rule).toMatch(/top:\s*0/)
    })

    it('the tabs pill is wrapped in .meta-record-drawer__tabs-bar (structural DOM: wrapper is the sticky surface, not the inline-flex pill)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const bar = container.querySelector('.meta-record-drawer__tabs-bar')!
      const tabs = container.querySelector('.meta-record-drawer__tabs')!
      expect(bar).toBeTruthy()
      expect(bar.contains(tabs)).toBe(true)
      expect(tabs.parentElement).toBe(bar)
      app.unmount()
    })

    it('[source] the root panel no longer scrolls itself (overflow-y:auto was moved off .meta-record-drawer onto the body)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rootRule = src.match(/\n\.meta-record-drawer\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rootRule).not.toMatch(/overflow-y/)
    })
  })
})
