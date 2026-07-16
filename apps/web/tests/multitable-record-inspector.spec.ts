/**
 * W2 S3/S4/S5 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §3.3, §7 S3/S4/S5, §8.2): MetaRecordInspector.vue -- the ARIA tab pattern completion (S3), the
 * comments tab + context-driven default (S4), and the attachments tab (S5, the 4th and final tab per
 * lock §2's information architecture).
 * Pins: tab switching (click), the roving-tabindex "exactly one tabindex=0" invariant (survives every
 * switch, click- or keyboard-driven), aria-controls <-> role="tabpanel" pairing, panel-count
 * conservation (never 0, never 2, and now never anything but 1 across 4 tabs), the Left/Right/Home/End
 * keyboard cases (incl. wrap-around -- S4 moved the wrap-around "last tab" from history to comments;
 * S5 moves it again, from comments to attachments, the new 4th/last entry in TAB_ORDER),
 * Escape-closes-the-inspector (guarded so it never fires when a descendant already consumed Escape,
 * and never swallows other keys so mod+z/mod+y/`?` still reach an ancestor's own keydown handler), and
 * OD-W2-2's context-driven default -- S3 shipped the single 'details' branch; S4 makes it real:
 * `openComments` (the resolver's live signal, see MetaRecordInspector.vue's file-header comment) true
 * at mount -> comments tab default, false -> details; and a LATER true-transition (without remounting)
 * re-selects comments via the shell's watch. A final "delegation" describe block proves this ARIA
 * completion + the 4-tab surface survives MetaRecordDrawer.vue's thin-shell delegation (OD-W2-7=b) --
 * not just when Inspector is mounted directly.
 *
 * Pre-existing drawer specs (multitable-record-drawer*.spec.ts, meta-record-drawer-*.spec.ts,
 * multitable-comments-drawer.spec.ts, meta-comments-drawer-*.spec.ts) stay green UNMODIFIED (frozen
 * baseline) -- they already pin the header actions / lock banner / tab TEXT content / comments body
 * this shell renders (the last two via MetaCommentsDrawer's own now-thin-shell delegation); this
 * file's job is the NEW ARIA/tab surface those specs never asserted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
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
  openComments?: boolean
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
        ...(options.openComments !== undefined ? { openComments: options.openComments } : {}),
      })
    },
  })
  app.mount(container)
  return { container, app }
}

// S4: mounts with props that can be MUTATED after mount (app.mount returns the root instance, whose
// `$props` reflects a `reactive()`-wrapped copy of whatever was passed to `h()` at render time — but
// since this harness's `render()` closes over a plain options object, the idiomatic way to drive a
// LIVE prop change from a test is a small wrapper component with its own reactive `openComments` ref
// that the test can flip after the initial mount, proving the shell's `watch` (not just its one-time
// mount-time default) actually reacts.
function mountInspectorWithReactiveOpenComments(initial: boolean): {
  container: HTMLElement
  app: App
  setOpenComments: (value: boolean) => void
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let setter: (value: boolean) => void = () => {}
  const app = createApp({
    data() {
      return { openComments: initial }
    },
    created() {
      setter = (value: boolean) => { this.openComments = value }
    },
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: 'sheet_1',
        apiClient: fakeApiClient() as any,
        openComments: this.openComments,
      })
    },
  })
  app.mount(container)
  return { container, app, setOpenComments: (value) => setter(value) }
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

// S4: the inbox link (a real `<RouterLink>`) needs an actual router plugin installed -- unlike every
// other test in this file, which deliberately mount WITHOUT one (see MetaRecordInspector.vue's
// `hasRouter` guard comment: several PRE-EXISTING frozen specs mount this shell/its drawer with no
// router at all, and `<RouterLink>` throws without one). This is the one router-mounted harness,
// proving the link renders + resolves correctly when a router genuinely is present (real-app parity).
async function mountInspectorWithRouter(options: HarnessOptions = {}): Promise<{ container: HTMLElement; app: App }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'home', component: { render: () => h('div') } },
      { path: '/multitable/comments/inbox', name: 'multitable-comment-inbox', component: { render: () => h('div') } },
    ],
  })
  const app = createApp({
    render() {
      return h(MetaRecordInspector, {
        visible: true,
        record: 'record' in options ? options.record : RECORD,
        fields: options.fields ?? FIELDS,
        canEdit: true,
        canComment: true,
        canDelete: false,
        sheetId: 'sheet_1',
        apiClient: fakeApiClient() as any,
        commentUnreadCount: 3,
      })
    },
  })
  app.use(router)
  await router.push('/')
  await router.isReady()
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
    it('renders a tablist with 4 tabs (S5: details/history/comments/attachments) and exactly 1 rendered tabpanel', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      expect(container.querySelector('[role="tablist"]')).toBeTruthy()
      const tabs = tabButtons(container)
      expect(tabs).toHaveLength(4)
      expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Details', 'History', 'Comments', 'Attachments'])
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1)
      app.unmount()
    })

    it('S5: switching to the attachments tab mounts MetaRecordAttachmentsPanel', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const attachmentsTab = tabButtons(container).find((t) => t.textContent?.trim() === 'Attachments')!
      attachmentsTab.click()
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      // The default harness's FIELDS fixture has no attachment-type field, so the panel renders its
      // own empty state ("No attachments") rather than any group -- proves the child mounted and its
      // own mask-contract computed ran (an unmounted/crashed child would leave this text absent).
      expect(tabPanel(container)!.textContent).toContain('No attachments')
      app.unmount()
    })

    it('the comments tab is unconditional (present even when canComment is false, matching details/history — permission gates content, not tab presence)', async () => {
      // mountInspector()'s default harness already passes canComment: false — this test's whole point
      // is that the 3rd tab still renders under that exact condition (a regression here would silently
      // hide comments instead of just disabling the composer inside, which is the intended behavior).
      const { container, app } = mountInspector()
      await flushUi()
      const commentsTab = tabButtons(container).find((t) => t.textContent?.trim() === 'Comments')
      expect(commentsTab).toBeTruthy()
      app.unmount()
    })

    it('defaults to the fields ("details") tab active when openComments is absent/false', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const active = activeTabButton(container)!
      expect(active.textContent?.trim()).toBe('Details')
      app.unmount()
    })

    it('OD-W2-2: defaults to the comments tab when openComments is true at mount (commentId deep-link equivalent)', async () => {
      const { container, app } = mountInspector({ openComments: true })
      await flushUi()
      const active = activeTabButton(container)!
      expect(active.textContent?.trim()).toBe('Comments')
      app.unmount()
    })

    it('OD-W2-2: a LATER true-transition of openComments (no remount) re-selects the comments tab via the watch', async () => {
      const { container, app, setOpenComments } = mountInspectorWithReactiveOpenComments(false)
      await flushUi()
      expect(activeTabButton(container)!.textContent?.trim()).toBe('Details')

      setOpenComments(true)
      await flushUi()
      expect(activeTabButton(container)!.textContent?.trim()).toBe('Comments')
      app.unmount()
    })

    it('OD-W2-2: a manual switch away from comments is NOT undone by a later false-transition of openComments (sticky, matches S3 tab-persistence behavior)', async () => {
      const { container, app, setOpenComments } = mountInspectorWithReactiveOpenComments(true)
      await flushUi()
      expect(activeTabButton(container)!.textContent?.trim()).toBe('Comments')

      tabButtons(container)[0].click() // manually switch to Details
      await flushUi()
      expect(activeTabButton(container)!.textContent?.trim()).toBe('Details')

      setOpenComments(false)
      await flushUi()
      expect(activeTabButton(container)!.textContent?.trim()).toBe('Details')
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

    it('ArrowLeft from the first tab WRAPS to the last tab (S5: attachments is now the last tab, not clamped)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, , , attachmentsTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(attachmentsTab)
      app.unmount()
    })

    it('ArrowRight from the last tab WRAPS to the first tab (S5: from attachments, not clamped)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, , , attachmentsTab] = tabButtons(container)
      attachmentsTab.click()
      await flushUi()
      attachmentsTab.focus()
      attachmentsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(detailsTab.getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(detailsTab)
      app.unmount()
    })

    it('the OLD history<->details boundary from S3 is no longer a wrap point (ArrowRight from history moves to comments, not back to details)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [, historyTab, commentsTab] = tabButtons(container)
      historyTab.click()
      await flushUi()
      historyTab.focus()
      historyTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(commentsTab.getAttribute('aria-selected')).toBe('true')
      app.unmount()
    })

    it('S5: the comments<->attachments boundary -- ArrowRight from comments moves to attachments (the new last tab), not back to details', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [, , commentsTab, attachmentsTab] = tabButtons(container)
      commentsTab.click()
      await flushUi()
      commentsTab.focus()
      commentsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      app.unmount()
    })

    it('Home jumps to the first tab, End jumps to the last (S5: last is now attachments)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const [detailsTab, , , attachmentsTab] = tabButtons(container)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      attachmentsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
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

    // S5 extension of the same golden: the attachments tab's own edit surface (a file input, rendered
    // by MetaRecordAttachmentsPanel when its visible-attachment-field set is non-empty and canEdit) is
    // a second, independent real in-panel control -- proves the `withinTablist` scoping guard covers
    // the NEW 4th tabpanel too, not just the fields panel's text input the two cases above already
    // pin.
    it('S5: ArrowLeft/ArrowRight from the attachments tab\'s file input do NOT change the active tab (arrow-scoping guard, 4th tab)', async () => {
      const attachmentField = { id: 'fld_files', name: 'Files', type: 'attachment' } as unknown as MetaField
      const { container, app } = mountInspector({ fields: [...FIELDS, attachmentField] })
      await flushUi()
      const attachmentsTab = tabButtons(container).find((t) => t.textContent?.trim() === 'Attachments')!
      attachmentsTab.click()
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      const fileInput = container.querySelector<HTMLInputElement>('.meta-record-attachments-panel__file-input')!
      expect(fileInput).not.toBeNull()
      fileInput.focus()
      const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      fileInput.dispatchEvent(right)
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      expect(right.defaultPrevented).toBe(false)
      const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      fileInput.dispatchEvent(left)
      await flushUi()
      expect(attachmentsTab.getAttribute('aria-selected')).toBe('true')
      expect(left.defaultPrevented).toBe(false)
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
    it('never renders 0 or 2+ tabpanels across mount + several switches over all 4 tabs (click- and keyboard-driven)', async () => {
      const { container, app } = mountInspector()
      await flushUi()
      const counts: number[] = [container.querySelectorAll('[role="tabpanel"]').length]
      const [detailsTab, historyTab, commentsTab, attachmentsTab] = tabButtons(container)
      historyTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      commentsTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      attachmentsTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      detailsTab.click()
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      counts.push(container.querySelectorAll('[role="tabpanel"]').length)
      expect(counts).toHaveLength(6)
      expect(counts.every((c) => c === 1)).toBe(true)
      app.unmount()
    })
  })

  describe('S4: header inbox link (moved from MetaCommentsDrawer, lock §2 评论面板 row)', () => {
    it('router-less mount (the majority harness in this file) does NOT crash and does not render the inbox link', async () => {
      // Negative control paired with the positive one below: mountInspector() never installs a
      // router, matching several pre-existing frozen specs (multitable-record-drawer*.spec.ts,
      // meta-record-drawer-*.spec.ts) that ALSO don't. Before the `hasRouter` guard this crashed
      // (RouterLink's useLink() dereferences an absent injected router); this proves the guard holds.
      const { container, app } = mountInspector({ record: RECORD })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__inbox-link')).toBeNull()
      app.unmount()
    })

    it('with a router installed (real-app parity), renders the inbox link + unread badge and resolves to the comment-inbox route', async () => {
      const { container, app } = await mountInspectorWithRouter()
      await flushUi()
      const link = container.querySelector<HTMLAnchorElement>('.meta-record-drawer__inbox-link')
      expect(link).toBeTruthy()
      expect(link!.textContent).toContain('Inbox')
      expect(link!.getAttribute('href')).toBe('/multitable/comments/inbox')
      expect(container.querySelector('.meta-record-drawer__inbox-badge')?.textContent).toBe('3')
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
    it('mounting MetaRecordDrawer produces the identical tablist/tabpanel pairing + roving tabindex (S5: now 4 tabs)', async () => {
      const { container, app } = mountDrawer()
      await flushUi()
      expect(tabButtons(container)).toHaveLength(4)
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
