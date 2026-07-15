/**
 * W2 S3 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §3.3, §7 S3, §8.2): MetaRecordInspector.vue -- the ARIA tab pattern completion this slice ships.
 * Pins: tab switching (click), the roving-tabindex "exactly one tabindex=0" invariant (survives every
 * switch, click- or keyboard-driven), aria-controls <-> role="tabpanel" pairing, panel-count
 * conservation (never 0, never 2), the Left/Right/Home/End keyboard cases (incl. wrap-around),
 * Escape-closes-the-inspector (guarded so it never fires when a descendant already consumed Escape,
 * and never swallows other keys so mod+z/mod+y/`?` still reach an ancestor's own keydown handler),
 * and OD-W2-2's context-driven default (today: always 'details'/fields -- the resolver's single live
 * branch; see MetaRecordInspector.vue's file-header comment for the S4 extension seam). A final
 * "delegation" describe block proves this ARIA completion survives MetaRecordDrawer.vue's thin-shell
 * delegation (OD-W2-7=b) -- not just when Inspector is mounted directly.
 *
 * Pre-existing drawer specs (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts) stay
 * green UNMODIFIED (frozen baseline) -- they already pin the header actions / lock banner / tab TEXT
 * content this shell renders; this file's job is the NEW ARIA surface those specs never asserted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const FIELDS = [{ id: 'fld_title', name: 'Title', type: 'string' }] as unknown as MetaField[]
const RECORD = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } } as unknown as MetaRecord

function fakeApiClient() {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({ subscribed: true, subscription: null }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    listRecordHistory: vi.fn().mockResolvedValue([]),
  }
}

interface HarnessOptions {
  record?: MetaRecord | null
  fields?: MetaField[]
  onClose?: () => void
}

function mountInspector(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: 'record' in options ? options.record : RECORD,
        fields: options.fields ?? FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: 'sheet_1',
        apiClient: fakeApiClient() as any,
        ...(options.onClose ? { onClose: options.onClose } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

function mountDrawer(): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordDrawer, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
      })
    },
  })
  app.mount(container)
  return { container, app }
}

function tabButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
}

function activeTabButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
}

function tabPanel(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="tabpanel"]')
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

describe('MetaRecordInspector (W2 S3 shell)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    useLocale().setLocale('en')
  })

  describe('tab structure + ARIA pairing', () => {
    it('renders a tablist with 2 tabs and exactly 1 rendered tabpanel', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      expect(container.querySelector('[role="tablist"]')).toBeTruthy()
      expect(tabButtons(container)).toHaveLength(2)
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
      app.unmount()
    })

    it('defaults to the fields ("details") tab active (OD-W2-2 -- single live branch today)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const active = activeTabButton(container)!
      expect(active.textContent?.trim()).toBe('Details')
      app.unmount()
    })

    it('aria-controls on the active tab points to the rendered tabpanel id; tabpanel aria-labelledby points back', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const active = activeTabButton(container)!
      const panel = tabPanel(container)!
      expect(active.id).toBeTruthy()
      expect(panel.id).toBeTruthy()
      expect(active.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.getAttribute('aria-labelledby')).toBe(active.id)
      app.unmount()
    })

    it('clicking the inactive tab switches the active tab + re-pairs aria-controls/aria-labelledby, panel count stays 1', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      historyTab.click()
      await flushUi()
      expect(historyTab.getAttribute('aria-selected')).toBe('true')
      expect(detailsTab.getAttribute('aria-selected')).toBe('false')
      const panel = tabPanel(container)!
      expect(historyTab.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.getAttribute('aria-labelledby')).toBe(historyTab.id)
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
      app.unmount()
    })
  })

  describe('roving tabindex invariant', () => {
    it('exactly one tab carries tabindex="0" on mount', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const zeros = tabButtons(container).filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeros).toHaveLength(1)
      expect(zeros[0].getAttribute('aria-selected')).toBe('true')
      app.unmount()
    })

    it('the invariant survives a click-driven switch', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      tabButtons(container)[1].click()
      await flushUi()
      const zeros = tabButtons(container).filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeros).toHaveLength(1)
      expect(zeros[0]).toBe(tabButtons(container)[1])
      app.unmount()
    })

    it('the invariant survives arrow-key-driven switches', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      let zeros = tabButtons(container).filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeros).toHaveLength(1)
      tabButtons(container)[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await flushUi()
      zeros = tabButtons(container).filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeros).toHaveLength(1)
      app.unmount()
    })
  })

  describe('keyboard: Left/Right/Home/End', () => {
    it('ArrowRight moves focus AND activates the next tab', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(historyTab.getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(historyTab)
      app.unmount()
    })

    it('ArrowLeft from the first tab WRAPS to the last tab (not clamped)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await flushUi()
      expect(historyTab.getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(historyTab)
      app.unmount()
    })

    it('ArrowRight from the last tab WRAPS to the first tab (not clamped)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      historyTab.click()
      await flushUi()
      historyTab.focus()
      historyTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(detailsTab)
      app.unmount()
    })

    it('Home jumps to the first tab, End jumps to the last', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await flushUi()
      expect(historyTab.getAttribute('aria-selected')).toBe('true')
      historyTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await flushUi()
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      app.unmount()
    })

    it('arrow/Home/End keys inside the tablist call preventDefault (so the browser does not also scroll)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab] = tabButtons(container)
      detailsTab.focus()
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      detailsTab.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      // Settle the switch's async focus-move (moveTabFocusTo's `await nextTick()`) before unmounting —
      // Vue's flush scheduler is a single global queue shared across every createApp() instance in
      // this file; leaving it pending here would dangle into a LATER test's flush cycles (a genuine,
      // observed cross-test race, not hypothetical -- see git history / PR body for the repro).
      await flushUi()
      app.unmount()
    })

    // Gate P2 regression golden (PR #4327 verdict): the single root keydown handler receives EVERY
    // keydown in the inspector subtree, so its arrow-nav branch MUST be scoped to events originating
    // from a `[role="tab"]` (the `withinTablist` guard in onInspectorKeydown). The gate empirically
    // proved that guard is load-bearing — removing it makes arrows typed anywhere in a panel hijack
    // tab navigation — yet no test pinned it (neuterable with all tests green = untested guard).
    // These two cases red immediately if the `if (!withinTablist) return` line is removed.
    it('ArrowRight/ArrowLeft from a text input INSIDE the active tabpanel do NOT change the active tab (arrow-scoping guard)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab] = tabButtons(container)
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      // The default harness (string field + canEdit) renders the fields panel's text input — a real
      // in-panel editing surface where arrow keys mean "move the caret", never "switch tabs".
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__input')!
      expect(input).not.toBeNull()
      input.focus()
      const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      input.dispatchEvent(right)
      await flushUi()
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      // And the event must NOT be preventDefault-ed either — the browser's own caret movement in the
      // input must survive (a swallowed-but-not-switching variant would still be a regression).
      expect(right.defaultPrevented).toBe(false)
      const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      input.dispatchEvent(left)
      await flushUi()
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      expect(left.defaultPrevented).toBe(false)
      app.unmount()
    })

    it('ArrowRight/Home/End from the tabpanel element itself do NOT change the active tab (arrow-scoping guard, non-input target)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab] = tabButtons(container)
      const panel = tabPanel(container)!
      panel.focus() // the tabpanel carries tabindex="0" — a keyboard user can land focus on it directly
      for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        panel.dispatchEvent(event)
        await flushUi()
        expect(detailsTab.getAttribute('aria-selected')).toBe('true')
        expect(event.defaultPrevented).toBe(false)
      }
      app.unmount()
    })
  })

  describe('Escape closes the inspector', () => {
    it('bare Escape emits close', async () => {
      const onClose = vi.fn()
      const { container, app } = mountInspector({ onClose })
      await flushUi()
      const [detailsTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(onClose).toHaveBeenCalledTimes(1)
      app.unmount()
    })

    it('Escape combined with a modifier key (ctrl/meta/alt) is ignored', async () => {
      const onClose = vi.fn()
      const { container, app } = mountInspector({ onClose })
      await flushUi()
      const [detailsTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true, bubbles: true, cancelable: true }))
      await flushUi()
      expect(onClose).not.toHaveBeenCalled()
      app.unmount()
    })

    it('does NOT fire when a descendant already consumed Escape (event.defaultPrevented) -- proves the guard against double-firing (e.g. MetaRichLongTextEditor cancel-on-Escape)', async () => {
      const onClose = vi.fn()
      const { container, app } = mountInspector({ onClose })
      await flushUi()
      const panel = tabPanel(container)!
      const consumer = document.createElement('button')
      consumer.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault() })
      panel.appendChild(consumer)
      consumer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(onClose).not.toHaveBeenCalled()
      app.unmount()
    })

    it('does not swallow mod+z / mod+y / ? -- a listener above the shell (simulating the workbench root) still receives them, and none of them close the inspector', async () => {
      // Ancestor listener is attached via native document.addEventListener, NOT another Vue-bound
      // `@keydown`/`onKeydown` prop on a wrapping component. Two independently Vue-bound `@keydown`
      // listeners at different levels of the SAME render tree are what triggers the harness race
      // documented on MetaRecordInspector.vue's onInspectorKeydown (reproduced in isolation); a plain
      // `document.addEventListener` sits entirely outside Vue's own event-patching machinery, so it
      // reproduces the real invariant under test (does the keydown bubble past the shell to an
      // ancestor?) without re-introducing that unrelated race into this test itself.
      const onClose = vi.fn()
      const outerSpy = vi.fn()
      document.addEventListener('keydown', outerSpy)
      try {
        const { container, app } = mountInspector({ onClose })
        await flushUi()
        const detailsTab = container.querySelector<HTMLButtonElement>('[role="tab"]')!
        detailsTab.focus()
        detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
        detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true, cancelable: true }))
        detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))
        await flushUi()
        expect(outerSpy).toHaveBeenCalledTimes(3)
        expect(onClose).not.toHaveBeenCalled()
        app.unmount()
      } finally {
        document.removeEventListener('keydown', outerSpy)
      }
    })
  })

  describe('panel-count conservation', () => {
    it('never renders 0 or 2 tabpanels across mount + several switches (click- and keyboard-driven)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const counts: number[] = [container.querySelectorAll('[role="tabpanel"]').length]
      const [detailsTab, historyTab] = tabButtons(container)
      historyTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      detailsTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      expect(counts).toHaveLength(4)
      expect(counts.every((c) => c === 1)).toBe(true)
      app.unmount()
    })
  })

  describe('HI-1: no new client/fetch/api calls beyond the pre-shell sanctioned set', () => {
    it('source scan: every apiClient.<method>( call in the shell is one of the 3 sanctioned subscription methods', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const calls = Array.from(src.matchAll(/apiClient\.(\w+)\(/g)).map((m) => m[1])
      const sanctioned = new Set(['getRecordSubscriptionStatus', 'subscribeRecord', 'unsubscribeRecord'])
      const unexpected = calls.filter((c) => !sanctioned.has(c))
      expect(unexpected).toEqual([])
      // Positive control: the scan actually found the sanctioned calls (an empty/broken regex would
      // vacuously "pass" the assertion above with zero matches).
      expect(calls.length).toBeGreaterThan(0)
    })

    it('source scan: no bare fetch( or client. call appears in the shell', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      expect(src).not.toMatch(/[^.]\bfetch\(/)
      expect(src).not.toMatch(/(?<!api)client\.\w+\(/)
    })
  })

  describe('delegation: MetaRecordDrawer (deprecated thin shell) renders the same ARIA structure', () => {
    it('mounting MetaRecordDrawer produces the identical tablist/tabpanel pairing + roving tabindex', async () => {
      const { container, app } = mountDrawer()
      await flushUi()
      expect(tabButtons(container)).toHaveLength(2)
      const active = activeTabButton(container)!
      const panel = tabPanel(container)!
      expect(active.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.getAttribute('aria-labelledby')).toBe(active.id)
      const zeros = tabButtons(container).filter((b) => b.getAttribute('tabindex') === '0')
      expect(zeros).toHaveLength(1)
      app.unmount()
    })

    it('mounting MetaRecordDrawer still supports keyboard tab navigation through the delegated Inspector', async () => {
      const { container, app } = mountDrawer()
      await flushUi()
      const [detailsTab, historyTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(historyTab.getAttribute('aria-selected')).toBe('true')
      app.unmount()
    })
  })
})
