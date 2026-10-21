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
 *      here to avoid a second, driftable copy of the same assertion;
 *  (f) P3-1: `maxPanelWidth` re-clamps `panelWidth` (and the ARIA/inline-var it drives) on a live
 *      viewport SHRINK, and pins the expanded state to the NEW max rather than the stale old one;
 *  (g) P3-4 coverage: the splitter is keyboard-focusable (tabindex), the window `resize` listener is
 *      live after mount (not just at some earlier point), the splitter's pointerdown
 *      `preventDefault()`, and the primary-mouse-button guard (a non-primary mouse button neither
 *      prevents default nor starts a drag);
 *  (h) NIT-1: width persists to `localStorage` on RELEASE (pointerup/pointercancel, keyup, the expand
 *      toggle click) rather than on every intermediate pointermove/keydown step;
 *  (i) NIT-2: the pointerup handler's `removeEventListener` teardown (and the NIT-1 release-time
 *      persist) still run when `releasePointerCapture` throws;
 *  (j) NIT-3/P3-2/P3-3 source-text provision checks for the splitter hit-area position, the sticky
 *      tabs bar's `scroll-padding-top` wiring, and the header/actions wrap + title-ellipsis rules --
 *      same jsdom-cannot-render-CSS honesty discipline as (d) above.
 *
 * 2026-09-05 follow-up (real-browser measurements at a 1512px Chromium viewport surfaced two defects
 * this jsdom-only suite could not itself catch -- verifier P2/P3; see MetaRecordInspector.vue's own
 * file-header comment for the full mechanics of each fix):
 *  (k) P2: `.meta-record-drawer__tabs` wraps instead of overflowing the panel at its minimum width
 *      (raised 320 -> 360, see MIN_WIDTH's own comment for what that changes in this file);
 *  (l) P3-A: the sticky tabs bar covers the full 12px strip above it once stuck (moved from the
 *      body's own top padding onto the bar's own painted `padding-top`), including the `58px`
 *      real-browser-measured `scroll-padding-top` fallback number;
 *  (m) P3-B: an expanded panel follows the viewport max UP on a GROW, not just down on a shrink, and
 *      `toggleExpand` persists to `localStorage` on both its expand and collapse click (a release
 *      point NIT-1 named but no test before this one actually exercised);
 *  (n) NIT-A: the tabs-bar's ResizeObserver is constructed once and never torn down/reconstructed
 *      across repeat re-renders of the mounted component, despite its ref binding staying an inline
 *      arrow (kept, not hoisted -- see the component's own comment for why);
 *  (o) NIT-B: the splitter's keyup-triggered persistence is scoped to the four resize keys -- a Tab
 *      keyup (pure focus movement) must not write to `localStorage`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const STORAGE_KEY = 'metasheet2:record-inspector-width'
// P2 (2026-09-05 follow-up, verifier P2): MIN_PANEL_WIDTH raised 320 -> 360 in the component (see its
// own comment) -- the un-wrapped 4-tab pill overflowed the panel's right edge at the old 320px floor
// in a real browser (jsdom cannot render CSS/layout and did not catch this). 360 is not a new number:
// it is the pre-existing DEFAULT_WIDTH below, so MIN_WIDTH === DEFAULT_WIDTH is intentional, not a
// typo -- see the "malformed stored value" describe block below for the one place this coincidence
// changes what a test can actually discriminate.
const MIN_WIDTH = 360
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

// NIT-1: a real keyboard always fires a matching keyup after a keydown -- tests that assert
// persistence after a keyboard-driven resize must dispatch it too (persistence now happens on keyup,
// not on the keydown-apply itself; see the component's `onInspectorKeyup`).
function keyup(el: HTMLElement, key: string) {
  el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
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

    // P2 (2026-09-05 follow-up): originally widened once then narrowed TWICE, asserting a landing
    // value of `DEFAULT_WIDTH - 16` -- valid back when MIN_WIDTH (320) sat 40px below DEFAULT_WIDTH
    // (360). Now that MIN_WIDTH === DEFAULT_WIDTH (both 360, see MIN_WIDTH's own comment), that same
    // two-narrow sequence would land BELOW the new floor and get clamped to 360, not 344 -- so this
    // now narrows only ONCE, back to exactly `DEFAULT_WIDTH`, landing well clear of the min boundary
    // while still exercising both the widen and the narrow step at the same fixed 16px size.
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
      await flushUi()
      expect(ariaValueNow(el)).toBe(DEFAULT_WIDTH)
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH)
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

    it('repeated ArrowRight never goes below the 360px minimum', async () => {
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

    it('Home jumps straight to the 360px minimum, End jumps straight to the current max', async () => {
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

    // P3-4a: coverage gap -- the splitter's `tabindex="0"` (in the template) was never itself
    // asserted. A mutation dropping that attribute would leave the splitter unreachable by Tab
    // without any existing test noticing.
    it('P3-4a: the splitter is keyboard-focusable (tabindex=0)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      expect(el.getAttribute('tabindex')).toBe('0')
      el.focus()
      expect(document.activeElement).toBe(el)
      app.unmount()
    })

    // P3-4b: coverage gap -- every existing viewport-width test called `setViewportWidth` BEFORE
    // `mountInspector()`, so none of them proved the `resize` listener added in `onMounted` is what
    // is actually reacting (a component that only read `window.innerWidth` once, at module/setup
    // time, would pass those tests identically). This changes the viewport AFTER mount.
    it('P3-4b: the window resize listener is live after mount (a post-mount viewport change updates aria-valuemax)', async () => {
      setViewportWidth(1000) // max = min(720, 0.6*1000) = 600
      const { container, app } = mountInspector()
      await flushUi()
      expect(splitter(container).getAttribute('aria-valuemax')).toBe('600')
      setViewportWidth(2000) // set AFTER mount -- max = min(720, 0.6*2000) = 720
      await flushUi()
      expect(splitter(container).getAttribute('aria-valuemax')).toBe('720')
      app.unmount()
    })
  })

  describe('viewport-tracked max (P3-1)', () => {
    it('re-clamps panelWidth (and ARIA/the inline width var) when a viewport shrink lowers the computed max', async () => {
      setViewportWidth(2000) // max 720
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      keydown(el, 'End') // -> 720
      keyup(el, 'End')
      await flushUi()
      expect(ariaValueNow(el)).toBe(720)
      expect(panelWidthPx(container)).toBe(720)

      setViewportWidth(600) // max = min(720, 0.6*600) = 360, set AFTER the panel was widened to 720
      await flushUi()
      const newMax = Number(el.getAttribute('aria-valuemax'))
      expect(newMax).toBe(360)
      expect(ariaValueNow(el)).toBeLessThanOrEqual(newMax)
      expect(ariaValueNow(el)).toBe(360)
      expect(panelWidthPx(container)).toBe(360)
      app.unmount()
    })

    it('a viewport shrink while expanded keeps the panel pinned to the NEW max, not the old one (aria-pressed stays consistent)', async () => {
      setViewportWidth(2000) // max 720
      const { container, app } = mountInspector()
      await flushUi()
      expandToggle(container).click()
      await flushUi()
      expect(panelWidthPx(container)).toBe(720)
      expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')

      setViewportWidth(1000) // max 600
      await flushUi()
      expect(panelWidthPx(container)).toBe(600)
      expect(ariaValueNow(splitter(container))).toBe(600)
      expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
      app.unmount()
    })

    // P3-B (2026-09-05 follow-up): the two tests above only ever SHRINK the viewport after expanding
    // -- neither proves the OTHER direction of the same `watch(maxPanelWidth, ...)` branch: an
    // expanded panel following the max back UP on a viewport GROW. The watcher's `if (isExpanded.value)
    // { panelWidth.value = max; return }` branch is unconditional (it always re-pins to the new max,
    // grow or shrink alike) -- but the SECOND branch (`if (panelWidth.value > max) ...`) only fires
    // when the current width EXCEEDS the new max, which a grow never triggers (a wider max is never
    // less than the current width). So deleting the `isExpanded` branch entirely leaves a grow
    // silently unhandled (the second branch's condition is simply false, doing nothing) while a
    // shrink-while-expanded test could still, in principle, be satisfied by some other code path --
    // this test is what actually pins the `isExpanded` branch's existence, not just its shrink-time
    // effect.
    it('P3-B: a viewport GROW while expanded follows the max UP too, not just down', async () => {
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      expandToggle(container).click()
      await flushUi()
      expect(panelWidthPx(container)).toBe(600)
      expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')

      setViewportWidth(2000) // max = min(720, 0.6*2000) = 720, set AFTER expanding at the smaller max
      await flushUi()
      expect(panelWidthPx(container)).toBe(720)
      expect(ariaValueNow(splitter(container))).toBe(720)
      expect(expandToggle(container).getAttribute('aria-pressed')).toBe('true')
      app.unmount()
    })
  })

  describe('pointer drag', () => {
    it('pointerdown on the splitter calls preventDefault (blocks text-selection during the drag)', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      const event = new PointerEvent('pointerdown', { clientX: 500, pointerId: 3, bubbles: true, cancelable: true })
      el.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      app.unmount()
    })

    it('primary-button guard: a non-primary mouse button (right-click) neither preventDefaults nor starts a drag', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      const event = new PointerEvent('pointerdown', {
        clientX: 500,
        pointerId: 4,
        pointerType: 'mouse',
        button: 2,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 4, bubbles: true, cancelable: true }))
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH)
      app.unmount()
    })


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

    it('dragging the handle right narrows the panel, clamped at the 360px minimum', async () => {
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

    it('NIT-1: does not persist to localStorage on pointermove, writes exactly once on pointerup', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      // Storage.prototype spies do not record under this jsdom setup (tests/setup/localstorage.ts
      // installs a fresh plain-object Storage POLYFILL per test, not a real `Storage` instance, so a
      // prototype-level spy never sees calls made through it) -- spy the per-test INSTANCE instead.
      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      const el = splitter(container)
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, pointerId: 5, bubbles: true, cancelable: true }))
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 470, pointerId: 5, bubbles: true, cancelable: true })) // +30 width
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 460, pointerId: 5, bubbles: true, cancelable: true })) // +40 width
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 40)
      expect(setItemSpy).not.toHaveBeenCalled()
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 460, pointerId: 5, bubbles: true, cancelable: true }))
      await flushUi()
      expect(setItemSpy).toHaveBeenCalledTimes(1)
      expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, String(DEFAULT_WIDTH + 40))
      app.unmount()
    })

    it('NIT-2: the removeEventListener teardown (and the release-time persist) still run when releasePointerCapture throws', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      // jsdom has no real `releasePointerCapture` on the prototype (same as `setPointerCapture`, see
      // the pointer-drag describe block's own comment) -- assigning an own-property stub is what
      // makes `handle.releasePointerCapture?.(...)` find and call a throwing function.
      el.releasePointerCapture = () => {
        throw new Error('boom (deliberate -- proves cleanup runs despite the throw)')
      }
      // The throw propagates out of the `pointerup` listener; jsdom does not let it escape
      // `dispatchEvent` synchronously (DOM spec), but reports it as a `window` `error` event, which
      // vitest otherwise surfaces as an unhandled error and fails the run even with every assertion
      // green. Swallow it HERE, scoped to this one test -- the throw itself is the point of the test,
      // not a bug to hide.
      const swallowExpectedThrow = (event: ErrorEvent) => event.preventDefault()
      window.addEventListener('error', swallowExpectedThrow)
      el.dispatchEvent(new PointerEvent('pointerdown', { clientX: 500, pointerId: 9, bubbles: true, cancelable: true }))
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 470, pointerId: 9, bubbles: true, cancelable: true })) // +30 width
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 30)
      el.dispatchEvent(new PointerEvent('pointerup', { clientX: 470, pointerId: 9, bubbles: true, cancelable: true }))
      await flushUi()
      window.removeEventListener('error', swallowExpectedThrow)
      // The release-time persist (inside the same `finally`) must still have run despite the throw.
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DEFAULT_WIDTH + 30))
      // A later bare pointermove must NOT still be tracked -- proves the three removeEventListener
      // calls ran despite releasePointerCapture throwing (without try/finally they'd be skipped,
      // leaving onMove permanently attached).
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 200, pointerId: 9, bubbles: true, cancelable: true }))
      await flushUi()
      expect(panelWidthPx(container)).toBe(DEFAULT_WIDTH + 30)
      app.unmount()
    })
  })

  describe('width persistence (localStorage, per viewer)', () => {
    it('persists a keyboard-driven width change and restores it on a fresh mount', async () => {
      setViewportWidth(1000)
      const first = mountInspector()
      await flushUi()
      const firstEl = splitter(first.container)
      keydown(firstEl, 'End') // -> 600
      keyup(firstEl, 'End') // NIT-1: persistence happens on release (keyup), not the keydown-apply itself
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

    // P2 (2026-09-05 follow-up) ledger note, honestly stated rather than silently absorbed: now that
    // MIN_WIDTH === DEFAULT_WIDTH (both 360), the '-50' and '0' cases below no longer independently
    // prove `readStoredPanelWidth`'s own `parsed <= 0` guard does anything -- ANY parsed value below
    // 360 (guard-rejected or not) clamps to the SAME 360 floor via `clampPanelWidth`, so removing that
    // guard entirely would leave these two assertions passing unchanged (verified: mutating the guard
    // away does not red these two). 'not-a-number' and 'NaN' still fully discriminate (parsed is NaN,
    // `Number.isFinite` fails, and `Math.max`/`Math.min` propagate NaN through the clamp rather than
    // landing on 360) and '' still discriminates the separate `!raw`/absent-value branch, which this
    // guard removal does not touch. This is a real, structural loss of two cases' mutation-sensitivity
    // caused by the MIN raise, not something this change was asked to independently fix -- recorded
    // here rather than left implicit.
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

    // P3-B (2026-09-05 follow-up): NIT-1's own tests (pointer/keyboard release) never covered the
    // THIRD release point that comment names -- the expand-toggle click itself. `toggleExpand`'s own
    // final line (`persistPanelWidth(panelWidth.value)`) is untested by every other test in this file:
    // they all assert the resulting `panelWidth`/ARIA, never whether that width was actually WRITTEN
    // to `localStorage`. Same per-test-instance spy discipline as the pointer-drag NIT-1 test above
    // (see its own comment for why a `Storage.prototype` spy would not see calls made through the
    // per-test polyfill instance).
    it('P3-B: toggleExpand persists the new width to localStorage on both the expand and the collapse click', async () => {
      setViewportWidth(1000) // max 600
      const { container, app } = mountInspector()
      await flushUi()
      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      const btn = expandToggle(container)

      btn.click()
      await flushUi()
      expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, '600')

      btn.click()
      await flushUi()
      expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, String(DEFAULT_WIDTH))
      expect(setItemSpy).toHaveBeenCalledTimes(2)
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

    // P3-2: jsdom performs no layout (no `<style>` tag reaches the DOM under this vitest config, see
    // this file's own header comment), so a rendered-scroll-behavior test cannot exercise
    // `scroll-padding-top` (there is nothing to scroll to in a jsdom document). This is a
    // source-text provision check, same honesty discipline as the other `[source]` tests above.
    // P3-A (2026-09-05 follow-up, verifier P3): also pins the `58px` fallback NUMBER (real-browser-
    // measured, Chromium at 1512px -- see the rule's own comment) and `padding-top: 0` on this same
    // rule -- a real-browser probe found the ORIGINAL `12px 16px` (non-zero top) shorthand left a
    // 12px strip of scrolled content visible above the sticky bar once it engaged, because the bar's
    // own opaque background only ever covered ITS box, not this element's leading padding above it.
    // Without this second assertion, reverting `padding-top` back to 12px (or reverting the fallback
    // number back to 48) would leave the FIRST assertion (`scroll-padding-top: var(...)` still being
    // present) green -- the var reference surviving is not the same as the fix it names surviving.
    it('[source] .meta-record-drawer__body declares scroll-padding-top (58px fallback) and zero top padding, so a scrolled-into-view field is not hidden under the sticky tabs bar (P3-2/P3-A)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__body\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/scroll-padding-top:\s*var\(--meta-record-tabs-bar-height,\s*58px\)/)
      expect(rule).toMatch(/padding:\s*0\s+16px\s+12px/)
    })

    // P3-A (2026-09-05 follow-up, verifier P3): companion pin for the OTHER half of the same fix --
    // the 12px the body's own top padding lost (just above) must have moved onto THIS rule's own
    // `padding-top`, not simply vanished (which would remove the visual gap above the tab pill
    // entirely rather than moving it inside the bar's own painted box). Real-browser-verified (see
    // the rule's own comment for a REJECTED alternative -- a negative `margin-top` on this same
    // element -- that measured as having no effect on the sticky position in Chromium and was
    // deliberately not used).
    it('[source] .meta-record-drawer__tabs-bar declares padding-top:12px (the 12px moved off .meta-record-drawer__body, not dropped) (P3-A)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__tabs-bar\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/padding:\s*12px\s+16px\s+14px/)
    })

    it('the tabs-bar wrapper mounts through the ResizeObserver ref callback that publishes --meta-record-tabs-bar-height, without throwing across mount/unmount', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      // This only proves the ref-callback wiring itself is safe across mount/unmount (mirroring
      // MetaChartRenderer.vue's own `ensureResizeObserver` guard-for-absence idiom) -- it does NOT
      // prove the measured-height branch, which never fires under jsdom (no ResizeObserver callback
      // is ever invoked without real layout); the `58px` CSS fallback pinned above (P3-A 2026-09-05
      // follow-up: was `48px`) is what is actually live in this harness, and the measured branch is
      // unverified here (see that code's own comment).
      const bar = container.querySelector('.meta-record-drawer__tabs-bar')!
      expect(bar).toBeTruthy()
      app.unmount()
    })

    // Record inspector v3 (2026-09-05, PR-A §1.2) superseded this pin's own premise: moving every
    // labeled action button into the kebab menu means Row A (`__toolbar`) is built ONLY from
    // non-shrinking 28px icon buttons + the nav group, so it CANNOT overflow at any supported width
    // and no longer wraps — "Header can no longer overflow by construction" (the design's own
    // framing) replaces the old wrap-to-fit mitigation. The title's own overflow handling still
    // exists, just renamed (`__title-text`, the read-only half of the new Row B title block).
    it('[source] .meta-record-drawer__toolbar never wraps and .meta-record-drawer__title-text ellipsizes, so nothing overflows at the panel minimum width (P3-3, superseded by PR-A §1.2)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const toolbarRule = src.match(/\.meta-record-drawer__toolbar\s*\{[^}]*\}/)?.[0] ?? ''
      // Two separate rules share the class: `.meta-record-drawer__title-input, .meta-record-drawer__
      // title-text { ... min-width:0 ... }` (shared sizing) and a standalone `.meta-record-drawer__
      // title-text { overflow/ellipsis/nowrap ... }` (the ellipsis behavior) — the lookbehind below
      // excludes the FIRST (comma-joined) occurrence so `titleTextOnlyRule` captures the second.
      const titleTextRule = src.match(/\.meta-record-drawer__title-input,\s*\.meta-record-drawer__title-text\s*\{[^}]*\}/)?.[0] ?? ''
      const titleTextOnlyRule = src.match(/(?<!, )\.meta-record-drawer__title-text\s*\{[^}]*\}/)?.[0] ?? ''
      expect(toolbarRule).toMatch(/flex-wrap:\s*nowrap/)
      expect(titleTextRule).toMatch(/min-width:\s*0/)
      expect(titleTextOnlyRule).toMatch(/text-overflow:\s*ellipsis/)
      expect(titleTextOnlyRule).toMatch(/white-space:\s*nowrap/)
      expect(titleTextOnlyRule).toMatch(/overflow:\s*hidden/)
    })

    it('[source] the splitter hit area sits inside the panel edge (left:0, width:6px), not straddling into the grid column to its left (NIT-3)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__splitter\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/left:\s*0;/)
      expect(rule).not.toMatch(/left:\s*-/)
      expect(rule).toMatch(/width:\s*6px/)
    })

    // P2 (2026-09-05 follow-up, verifier P2): real-browser measurement found the un-wrapped 4-tab
    // pill (355px) overflowing the panel's right edge at the (then-320px, now 360px) minimum width,
    // forcing a page-level horizontal scrollbar -- jsdom cannot render CSS/layout and did not catch
    // this (same honesty discipline as the other `[source]` tests in this block). `display: inline-
    // flex` is asserted to still be PRESENT (not switched to a block-level `flex`) because that is
    // what keeps the pill hugging its own content -- not spanning the full row -- at normal/wide
    // panel widths; see the rule's own comment for why a block-level `flex` would break that.
    it('[source] .meta-record-drawer__tabs wraps (flex-wrap:wrap) instead of overflowing the panel at its minimum width, while staying inline-flex so it still reads as a pill at normal widths (P2)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__tabs\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/display:\s*inline-flex/)
      expect(rule).toMatch(/flex-wrap:\s*wrap/)
    })
  })

  describe('NIT-A: tabs-bar ResizeObserver identity guard, no churn on re-render', () => {
    // NIT-A (2026-09-05 follow-up): the tabs-bar element ref is bound as an inline arrow function
    // (`:ref="(el) => setTabsBarRef(el as HTMLElement | null)"`, unchanged -- see the component's own
    // template comment for why a stable top-level reference was tried and deliberately reverted). An
    // inline arrow is a new function value every render, so Vue's compiler cannot hoist this vnode into
    // a static/skippable one -- `setTabsBarRef` genuinely IS called again on every re-render of this
    // component (e.g. every pointermove during a drag), each time with the SAME already-mounted
    // element (measured directly, not assumed: no intermediate `null` call happens between renders).
    // Before this fix, EVERY one of those repeat calls unconditionally tore down and reconstructed the
    // ResizeObserver even though the target element never changed; `setTabsBarRef` now tracks which
    // element its live observer is attached to and early-returns when a call's element already matches
    // it, turning every repeat call into a no-op. jsdom has no real ResizeObserver (verified elsewhere
    // in this file/repo -- `typeof ResizeObserver === 'undefined'` under this vitest config), so this
    // test stubs a counting fake onto the global for its own duration, restoring the original
    // afterward.
    it('constructs the ResizeObserver exactly once across N re-renders of the component', async () => {
      let constructedCount = 0
      class CountingResizeObserver {
        constructor(_cb: ResizeObserverCallback) {
          constructedCount += 1
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      const original = (globalThis as any).ResizeObserver
      ;(globalThis as any).ResizeObserver = CountingResizeObserver as unknown as typeof ResizeObserver
      try {
        setViewportWidth(1000)
        const { container, app } = mountInspector()
        await flushUi()
        expect(constructedCount).toBe(1)
        const el = splitter(container)
        // Five separate re-renders of the component (each ArrowLeft applies a live width/ARIA update,
        // which re-renders and re-patches every vnode in the tree, INCLUDING re-invoking the tabs-bar's
        // function ref -- the element itself never changes, so a churning implementation would
        // reconstruct the observer five more times here).
        for (let i = 0; i < 5; i += 1) {
          keydown(el, 'ArrowLeft')
          await flushUi()
        }
        expect(constructedCount).toBe(1)
        app.unmount()
      } finally {
        ;(globalThis as any).ResizeObserver = original
      }
    })
  })

  describe('NIT-B: splitter keyup persistence is scoped to the resize keys', () => {
    // NIT-B (2026-09-05 follow-up): `onInspectorKeyup` used to fire (and persist to localStorage) on
    // ANY keyup whose target sat inside the splitter -- including a bare Tab, which only MOVES focus
    // onto or off the splitter and never touches `panelWidth` via `applyPanelWidth` at all. Scoped to
    // the same four keys `onSplitterKeydown` itself acts on (ArrowLeft/ArrowRight/Home/End).
    it('a Tab keyup on the splitter does not write to localStorage', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      keyup(splitter(container), 'Tab')
      await flushUi()
      expect(setItemSpy).not.toHaveBeenCalled()
      app.unmount()
    })

    it('an ArrowLeft keyup on the splitter still writes (the four resize keys are unaffected by the Tab-scoping fix)', async () => {
      setViewportWidth(1000)
      const { container, app } = mountInspector()
      await flushUi()
      const el = splitter(container)
      const setItemSpy = vi.spyOn(window.localStorage, 'setItem')
      keydown(el, 'ArrowLeft')
      keyup(el, 'ArrowLeft')
      await flushUi()
      expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, String(DEFAULT_WIDTH + 16))
      app.unmount()
    })
  })
})
