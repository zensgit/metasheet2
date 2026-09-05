/**
 * Record inspector v3 (2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md,
 * PR-A §1.2 header + §1.5 keyboard). New surface this PR-A slice adds to MetaRecordInspector.vue:
 * the Row A toolbar (icon-only, never wraps) + kebab menu, the Row B title block (eyebrow +
 * primary-field value, editable when permitted), the prev/next keyboard chord, and the §3.3
 * tab-switch focus split. Pre-existing header/menu-item-gate/click-emit coverage already rewritten
 * in multitable-record-drawer-t5-migration.spec.ts (opens the kebab, asserts gates/classes/clicks
 * per item) is NOT duplicated here — this file's job is the NEW behaviors that spec never asserted:
 * toolbar structure, kebab a11y wiring + roving + Escape-refocus, title editing, the chord, and
 * tab-switch focus.
 *
 * i18n discipline: every string assertion below reads through `recordLabel`/`metaCoreLabel` (the
 * SAME helpers the component itself calls), never a hardcoded copy literal — so this file can never
 * drift from the label tables it is meant to test against.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App, type VNodeChild } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { recordLabel } from '../src/multitable/utils/meta-record-labels'
import { metaCoreLabel } from '../src/multitable/utils/meta-core-labels'
import { formatRecordFieldValue, resolvePrimaryField } from '../src/multitable/utils/recordDisplay'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

const TITLE_FIELD: MetaField = { id: 'fld_title', name: 'Title', type: 'string' } as MetaField
const NOTES_FIELD: MetaField = { id: 'fld_notes', name: 'Notes', type: 'longText' } as MetaField
const FIELDS: MetaField[] = [TITLE_FIELD, NOTES_FIELD]
const RECORD: MetaRecord = { id: 'rec_1', version: 1, data: { fld_title: 'Alpha', fld_notes: '' } } as MetaRecord

function fakeApiClient() {
  return {
    getRecordSubscriptionStatus: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
    subscribeRecord: vi.fn().mockResolvedValue({ subscribed: true, subscription: null }),
    unsubscribeRecord: vi.fn().mockResolvedValue({ subscribed: false, subscription: null }),
  }
}

interface HarnessOptions {
  record?: MetaRecord | null
  fields?: MetaField[]
  recordIds?: string[]
  canEdit?: boolean
  // P3-1 (2026-09-05, header-overflow-bound follow-up): every one of these defaults to `false` (the
  // pre-existing default shape every OTHER test in this file already relies on) unless a test opts
  // in — so adding them here changes no existing test's rendered output.
  canComment?: boolean
  canDelete?: boolean
  canCreate?: boolean
  canManageAutomation?: boolean
  canManageRecordPermissions?: boolean
  rowActions?: Record<string, unknown> | null
  fieldPermissions?: Record<string, unknown> | null
  openerEl?: HTMLElement | null
  onClose?: () => void
  onNavigate?: (id: string) => void
  onPatch?: (fieldId: string, value: unknown) => void
}

// Tracked so `afterEach` can PROPERLY `app.unmount()` every mounted app (not just wipe
// `document.body.innerHTML`, which several sibling spec files in this repo do — that leaves
// MtPopover's `document.addEventListener('mousedown'/'keydown', ...)` listeners from the just-wiped
// instance still live, referencing detached elements; a later test's own keydown dispatch then also
// re-fires those stale handlers, observed as cross-test focus/console-error contamination when
// several kebab-opening tests in this file ran back to back). MtMenu/MtPopover mounted more than
// once per file makes correct teardown load-bearing here in a way most single-mount specs never hit.
const mountedApps: App[] = []

// F3 (2026-09-05, round 3): the ONE `createApp({ render })` in this file. `vue/one-component-per-file`
// counts every `createApp({...})` / `defineComponent({...})` object literal as a component and reports
// ALL of them once a file holds more than one — this file held three (mountInspector,
// mountToggleableInspector, and the record-prop re-sync test's inline app). Every mount now routes
// through this single factory with a render CLOSURE; reactive harness state lives in `ref`s the
// closure reads (so a later `someRef.value = …` re-renders exactly as the old `data()`-based inline
// component did). One component definition per file — no disable comment needed.
function mountApp(render: () => VNodeChild): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render })
  app.mount(container)
  mountedApps.push(app)
  return { container, app }
}

function mountInspector(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  return mountApp(() =>
    h(MetaRecordInspector, {
      visible: true,
      record: 'record' in options ? options.record : RECORD,
      fields: options.fields ?? FIELDS,
      canEdit: options.canEdit ?? true,
      canComment: options.canComment ?? false,
      canDelete: options.canDelete ?? false,
      canCreate: options.canCreate ?? false,
      canManageAutomation: options.canManageAutomation ?? false,
      canManageRecordPermissions: options.canManageRecordPermissions ?? false,
      recordIds: options.recordIds ?? ['rec_1'],
      rowActions: options.rowActions as any,
      fieldPermissions: options.fieldPermissions as any,
      sheetId: 'sheet_1',
      apiClient: fakeApiClient() as any,
      openerEl: options.openerEl,
      ...(options.onClose ? { onClose: options.onClose } : {}),
      ...(options.onNavigate ? { onNavigate: options.onNavigate } : {}),
      ...(options.onPatch ? { onPatch: options.onPatch } : {}),
    }),
  )
}

// P1 (2026-09-05, focus capture/restore fix): the REAL workbench mounts this component's instance
// ONCE and toggles `visible` false→true→false→true→… over and over for every real open/close cycle
// (`mountInspector` above — like several OTHER pre-existing specs in this file — instead mounts
// with `visible` already `true` and unmounts the whole app for "close", which only exercises this
// file's onMounted/onBeforeUnmount FALLBACK path, never the live `watch(() => props.visible, ...)`
// mechanism the real workbench actually depends on). This harness reproduces the real shape: ONE
// persistent component instance, `visible` and `openerEl` both reactive so a test can drive the
// exact false→true→false→true sequence the finding names.
function mountToggleableInspector(): { container: HTMLElement; app: App; setVisible: (v: boolean) => void; setOpener: (el: HTMLElement | null) => void } {
  // F3 (round 3): `ref`s read inside the render closure replace the previous inline component's
  // `data()` — same reactivity (a write re-renders the ONE persistent MetaRecordInspector instance),
  // without a second `createApp({...})` object literal in this file. `apiClient` is created once here
  // rather than per render so its identity stays stable across the visible/opener toggles, matching
  // how the real workbench passes a single long-lived client.
  const visible = ref(false)
  const openerEl = ref<HTMLElement | null>(null)
  const apiClient = fakeApiClient() as any
  const { container, app } = mountApp(() =>
    h(MetaRecordInspector, {
      visible: visible.value,
      record: RECORD,
      fields: FIELDS,
      canEdit: true,
      canComment: false,
      canDelete: false,
      recordIds: ['rec_1'],
      sheetId: 'sheet_1',
      apiClient,
      openerEl: openerEl.value,
    }),
  )
  return {
    container,
    app,
    setVisible: (v: boolean) => { visible.value = v },
    setOpener: (el: HTMLElement | null) => { openerEl.value = el },
  }
}

afterEach(() => {
  while (mountedApps.length > 0) {
    try { mountedApps.pop()!.unmount() } catch { /* already unmounted by the test itself */ }
  }
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

function kebabTrigger(root: HTMLElement): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>('[data-testid="record-inspector-menu"]')!
}
async function openKebab(root: HTMLElement) {
  // jsdom does NOT move focus on `.click()` the way a real browser does for a mouse click on a
  // focusable button — an explicit `.focus()` first keeps `document.activeElement` at click time
  // truthful to a real click, which MtMenu's own "capture the trigger to restore focus to it later"
  // logic (see that file's own comment) depends on.
  const trigger = kebabTrigger(root)
  trigger.focus()
  // N3 (2026-09-05, round 3): identical exposure to the race fixed in
  // multitable-record-drawer-t5-migration.spec.ts's `openKebabMenu` (see its comment for the full
  // mechanism and the Date.now()-pinned proof): Vue's DOM event invoker drops the click at MtPopover's
  // OUTER trigger handler whenever the click lands in the same millisecond that handler was attached,
  // because the inner MtButton `@click` stamps the event first. Not yet observed failing in THIS file,
  // but every kebab-opening test here mounts the same component and clicks the same MtIconButton the
  // same way, so the latent flake is closed here too: let ≥1ms of real time elapse before clicking.
  await new Promise<void>((resolve) => setTimeout(resolve, 2))
  trigger.click()
  await flushUi()
}
function menuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.mt-menu [role^="menuitem"]'))
}

// P3-1 (2026-09-05, header-overflow-bound follow-up): the pinned allow-list for
// "toolbar holds only icon buttons + nav" (the design's own framing for why Row A "can never
// overflow by construction", MetaRecordInspector.vue's file-header comment). `.mt-popover__trigger`
// is MtMenu's own rendered trigger wrapper (the kebab `MtIconButton`) — see MtPopover.vue's template.
const ALLOWED_TOOLBAR_CHILD_SELECTOR = [
  '.meta-record-drawer__nav',
  '.meta-record-drawer__toolbar-spacer',
  '.meta-record-drawer__btn--comment',
  '[data-testid="record-inspector-copy-link"]',
  '.meta-record-drawer__expand',
  '.mt-popover__trigger',
  '.meta-record-drawer__close',
].join(', ')
function assertToolbarChildSetIsClosed(toolbar: Element) {
  for (const child of Array.from(toolbar.children)) {
    expect(child.matches(ALLOWED_TOOLBAR_CHILD_SELECTOR)).toBe(true)
  }
}

// G1 (2026-09-05, round 3): the DIRECT-child allow-list above bounds which boxes sit in the toolbar
// row, but a labelled control NESTED inside an allowed container (e.g. a stray `<button>` inside
// `.meta-record-drawer__nav`) sails through it. This closes that hole: EVERY interactive descendant
// of the toolbar (`button`, `a`, `[role="button"]`, at any depth) must be one of the seven known
// controls — identified by data-testid / class, or, for the two nav MtIconButtons (which carry
// neither), by their `aria-label` read through `recordLabel` so the pin follows the label table.
// `expectedCount` pins the set's SIZE too, so a duplicate of an allowed control is also caught.
// Mutation: add `<button aria-label="x">` inside `.meta-record-drawer__nav` in the component template
// → `offenders` is non-empty here (and the count is off by one) → red.
function allowedToolbarControlSelector(): string {
  return [
    `.meta-record-drawer__nav > button[aria-label="${recordLabel('record.previous', false)}"]`,
    `.meta-record-drawer__nav > button[aria-label="${recordLabel('record.next', false)}"]`,
    '.meta-record-drawer__btn--comment',
    '[data-testid="record-inspector-copy-link"]',
    '[data-testid="record-inspector-expand-toggle"]',
    '[data-testid="record-inspector-menu"]',
    '.meta-record-drawer__close',
  ].join(', ')
}
function assertToolbarControlSetIsClosed(toolbar: Element, expectedCount: number) {
  const controls = Array.from(toolbar.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
  const offenders = controls.filter((el) => !el.matches(allowedToolbarControlSelector())).map((el) => el.outerHTML)
  expect(offenders).toEqual([])
  expect(controls).toHaveLength(expectedCount)
}

describe('MetaRecordInspector header v3 (PR-A §1.2)', () => {
  describe('Row A toolbar structure', () => {
    it('renders exactly one .meta-record-drawer__toolbar row', async () => {
      const { container } = mountInspector()
      await flushUi()
      expect(container.querySelectorAll('.meta-record-drawer__toolbar')).toHaveLength(1)
    })

    it('the toolbar child set is {nav, comment-chip?, copy-link, expand, menu, close} — comment chip absent when canComment is false (this harness)', async () => {
      const { container } = mountInspector({ recordIds: ['rec_0', 'rec_1', 'rec_2'] })
      await flushUi()
      const toolbar = container.querySelector('.meta-record-drawer__toolbar')!
      expect(toolbar.querySelector('.meta-record-drawer__nav')).toBeTruthy()
      expect(toolbar.querySelector('.meta-record-drawer__btn--comment')).toBeNull() // canComment: false
      expect(toolbar.querySelector('[data-testid="record-inspector-copy-link"]')).toBeTruthy()
      expect(toolbar.querySelector('[data-testid="record-inspector-expand-toggle"]')).toBeTruthy()
      expect(toolbar.querySelector('[data-testid="record-inspector-menu"]')).toBeTruthy()
      expect(toolbar.querySelector('.meta-record-drawer__close')).toBeTruthy()
      // G1: with canComment false the interactive descendant set is exactly {prev, next, copy-link,
      // expand, kebab, close} — six, at any depth, nothing else.
      assertToolbarControlSetIsClosed(toolbar, 6)
    })

    // [source] jsdom performs no layout, so an actual overflow/wrap can't be observed here — this
    // proves the DECLARATION exists (real-browser verification is §3 PR-A's own remit, see the
    // Chromium checklist run separately).
    it('[source] .meta-record-drawer__toolbar declares flex-wrap: nowrap (jsdom cannot verify the resulting layout)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rule = src.match(/\.meta-record-drawer__toolbar\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rule).toMatch(/flex-wrap:\s*nowrap/)
    })

    // P3-1 (2026-09-05): with EVERY optional header affordance present at once (the real overflow
    // risk profile — the previous test above always mounts with `canComment: false`, which can never
    // exercise the comment chip's own contribution to the row at all), the toolbar's direct child set
    // must still match the pinned allow-list exactly — nothing else may sneak in. Mutation: append a
    // stray labeled `<button>Preview</button>` inside `.meta-record-drawer__toolbar` in
    // MetaRecordInspector.vue's template → this test (and ONLY this test) reds.
    it('with ALL header gates true, the toolbar child set still matches the "icon buttons + nav only" allow-list exactly — no stray content', async () => {
      const { container } = mountInspector({
        recordIds: ['rec_0', 'rec_1', 'rec_2'],
        canComment: true,
        canDelete: true,
        canCreate: true,
        canManageAutomation: true,
        canManageRecordPermissions: true,
      })
      await flushUi()
      const toolbar = container.querySelector('.meta-record-drawer__toolbar')!
      // Sanity: prove the gates actually engaged (a vacuous pass with every gate silently ignored
      // would trivially satisfy the allow-list below for the wrong reason).
      expect(toolbar.querySelector('.meta-record-drawer__btn--comment')).toBeTruthy()
      expect(toolbar.children.length).toBeGreaterThanOrEqual(6)
      assertToolbarChildSetIsClosed(toolbar)
      // G1: every gate on → the interactive descendant set is exactly the seven known controls
      // (prev, next, comment chip, copy-link, expand, kebab, close), at any depth — a labelled
      // control smuggled INSIDE an allowed container (the direct-child check's blind spot) reds here.
      assertToolbarControlSetIsClosed(toolbar, 7)
    })

    // P3-1 (2026-09-05): the allow-list test above bounds WHICH elements the toolbar may contain
    // (the "stray element" failure mode, mutation-proven above) — it does NOT, by itself, bound how
    // WIDE an ALLOWED child may render (jsdom performs no layout, so an allowed child growing
    // arbitrarily wide is invisible to it). This is the source-text pin for the two CSS bounds that
    // cover THAT failure mode instead: the position-text span and the comment-chip button both carry
    // a `max-width` + overflow/ellipsis backstop, so neither can push the (non-shrinking, `flex-wrap:
    // nowrap`) toolbar row wider than the panel even if its content is unexpectedly long — see each
    // rule's own comment for why (compact-number formatting for the former, "no badge to cap" for
    // the latter). Real-browser verification of the resulting layout is out of scope for this pin,
    // same as this file's other CSS claims.
    it('[source] .meta-record-drawer__nav-pos and .meta-record-drawer__btn--comment both carry a max-width + overflow bound (jsdom cannot verify the resulting layout)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const navPosRule = src.match(/\.meta-record-drawer__nav-pos\s*\{[^}]*\}/)?.[0] ?? ''
      expect(navPosRule).toMatch(/max-width:\s*64px/)
      expect(navPosRule).toMatch(/text-overflow:\s*ellipsis/)
      // G2 (2026-09-05, round 3): `text-overflow: ellipsis` is inert without BOTH `overflow: hidden`
      // (the box must actually clip) and `white-space: nowrap` (the text must stay on the one line
      // that overflows) — pinning `max-width` + `text-overflow` alone would let either be dropped
      // with every assertion here still green. Mutation: delete `overflow: hidden` from the
      // `.meta-record-drawer__nav-pos` rule → the first line below reds.
      expect(navPosRule).toMatch(/overflow:\s*hidden/)
      expect(navPosRule).toMatch(/white-space:\s*nowrap/)
      const commentBtnRule = src.match(/\.meta-record-drawer__btn--comment\s*\{[^}]*\}/)?.[0] ?? ''
      expect(commentBtnRule).toMatch(/max-width:\s*140px/)
    })

    // N2 (2026-09-05, round 3; real-browser measured by the reviewer — Chromium, 560px panel, long
    // label injected: the chip's inline-flex root grew to the label's 239px while the 140px button
    // clipped it, so the label never overflowed ITSELF and `text-overflow: ellipsis` never rendered).
    // The fix lives entirely in this component's scoped `:deep()` rules (MetaCommentActionChip.vue is
    // comment-affordance-locked and untouched): the chip root becomes a block-level `flex` box capped
    // at `max-width: 100%` of the button's content box, and the label a `flex: 1 1 auto; min-width: 0`
    // item that overflows itself — the box the ellipsis renders on. Source-text pin ONLY: jsdom cannot
    // lay out, so the rendered ellipsis (label clientWidth < scrollWidth, button ≤ 140px, toolbar one
    // row) is re-measured in a real browser by the reviewer, not by this test.
    it('[source] the comment-chip :deep() rules bound the chip root (flex, min-width 0, max-width 100%) and make the label an overflowing flex item (jsdom cannot verify the rendered ellipsis)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const rootRule = src.match(/\.meta-record-drawer__btn--comment :deep\(\.meta-comment-action-chip\)\s*\{[^}]*\}/)?.[0] ?? ''
      expect(rootRule).toMatch(/display:\s*flex/)
      expect(rootRule).toMatch(/min-width:\s*0/)
      expect(rootRule).toMatch(/max-width:\s*100%/)
      const labelRule = src.match(/\.meta-record-drawer__btn--comment :deep\(\.meta-comment-action-chip__label\)\s*\{[^}]*\}/)?.[0] ?? ''
      expect(labelRule).toMatch(/flex:\s*1 1 auto/)
      expect(labelRule).toMatch(/min-width:\s*0/)
      expect(labelRule).toMatch(/overflow:\s*hidden/)
      expect(labelRule).toMatch(/text-overflow:\s*ellipsis/)
      expect(labelRule).toMatch(/white-space:\s*nowrap/)
    })

    // P2-A (2026-09-05, design brief §1.3): `.meta-record-drawer__tabs-bar` is the container-query
    // container, and below 420px both the tabs pill and each tab get `flex: 1; min-width: 0` so all
    // four stay on one row at the 360px panel floor. Source-text pin only — jsdom implements neither
    // layout nor CSS Container Queries, so the resulting one-row layout itself is NOT verified here
    // (same caveat this file's sibling flex-wrap pin above already discloses); real-browser
    // verification is this PR's own checklist item "four tabs on one row at 360".
    it('[source] .meta-record-drawer__tabs-bar is a container, and @container (width < 420px) sets flex:1/min-width:0 on both the tabs pill and each tab (jsdom cannot verify the resulting one-row layout)', () => {
      const src = readSrc('src/multitable/components/MetaRecordInspector.vue')
      const tabsBarRule = src.match(/\.meta-record-drawer__tabs-bar\s*\{[^}]*\}/)?.[0] ?? ''
      expect(tabsBarRule).toMatch(/container-type:\s*inline-size/)
      const query = src.match(/@container \(width < 420px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
      expect(query).toBeTruthy()
      const tabsRule = query.match(/\.meta-record-drawer__tabs\s*\{[^}]*\}/)?.[0] ?? ''
      expect(tabsRule).toMatch(/flex:\s*1/)
      expect(tabsRule).toMatch(/min-width:\s*0/)
      const tabRule = query.match(/\.meta-record-drawer__tab\s*\{[^}]*\}/)?.[0] ?? ''
      expect(tabRule).toMatch(/flex:\s*1/)
      expect(tabRule).toMatch(/min-width:\s*0/)

      // Placement (real-browser-verified defect, caught before landing — see the @container block's
      // own comment): the block must come AFTER the UNCONDITIONAL base `.meta-record-drawer__tab`
      // rule (`min-width: 76px`), not before it. The `flex:1`/`min-width:0` assertions above alone
      // do NOT catch a regression that moves the block back above that base rule — both strings
      // would still be present, just in the wrong relative order, and same-specificity CSS cascade
      // order (a `@container` wrapper adds none of its own) would then let the LATER, unconditional
      // `min-width: 76px` win at every width, silently reintroducing the exact defect this PR fixed.
      const baseTabRuleIndex = src.indexOf('.meta-record-drawer__tab { min-width: 76px')
      const containerQueryIndex = src.indexOf('@container (width < 420px)')
      expect(baseTabRuleIndex).toBeGreaterThan(0)
      expect(containerQueryIndex).toBeGreaterThan(baseTabRuleIndex)
    })
  })

  describe('kebab menu a11y wiring', () => {
    it('trigger carries aria-haspopup=menu and aria-expanded flips false -> true on open', async () => {
      const { container } = mountInspector()
      await flushUi()
      const trigger = kebabTrigger(container)
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      trigger.click()
      await flushUi()
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
    })

    it('comment-inbox item present iff resolvedCanComment && hasRouter — absent here (router-less, canComment false)', async () => {
      const { container } = mountInspector()
      await openKebab(container)
      expect(document.querySelector('.meta-record-drawer__inbox-link')).toBeNull()
    })
  })

  describe('MtMenu roving + Escape', () => {
    it('ArrowDown/ArrowUp/Home/End move focus among menu items', async () => {
      const { container } = mountInspector({ canEdit: true, rowActions: null })
      // canManageAutomation/canManageRecordPermissions/canCreate default false, canDelete false,
      // canLoadSubscription needs apiClient+sheetId+record.id (all present) -> watch item renders.
      // Settle the subscription-status fetch FIRST — MtMenu's own auto-focus-first-item logic
      // excludes `:disabled` items, and the watch row is `disabled` while `subscriptionLoading` is
      // still true; opening the menu before that resolves would find zero enabled items to focus.
      await flushUi()
      await openKebab(container)
      const items = menuItems()
      expect(items.length).toBeGreaterThan(0)
      expect(document.activeElement).toBe(items[0]) // auto-focused on open

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[items.length > 1 ? 1 : 0])

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[items.length - 1])

      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(items[0])
    })

    it('Escape (dispatched inside the open menu) closes it and returns focus to the trigger', async () => {
      const { container } = mountInspector()
      const trigger = kebabTrigger(container)
      await flushUi() // settle the subscription fetch before opening — see the roving test's own comment
      await openKebab(container)
      const items = menuItems()
      expect(items.length).toBeGreaterThan(0)
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(menuItems()).toHaveLength(0) // Teleported panel removed
      expect(document.activeElement).toBe(trigger)
    })
  })

  describe('root Escape dispatch order (§1.5 item 1: kebab open -> close menu, not the panel)', () => {
    it('Escape dispatched on the (still-focused) trigger while the menu is open closes the menu and emits no close', async () => {
      const onClose = vi.fn()
      const { container } = mountInspector({ onClose })
      const trigger = kebabTrigger(container)
      await openKebab(container)
      // The realistic race this covers: focus has not yet moved off the trigger onto the first item
      // (MtMenu's own auto-focus is a nextTick later) — dispatch straight on the trigger, which IS
      // inside `.meta-record-drawer` so it reaches `onInspectorKeydown`. See that function's own
      // comment for why the common "focus already on a menu item" case never reaches this listener
      // at all (Teleport breaks bubbling) and is covered by MtMenu's own Escape handling instead.
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(menuItems()).toHaveLength(0)
      expect(onClose).not.toHaveBeenCalled()
    })

    // Round 3 (2026-09-05, refuter finding on round 2): the COMMON real-world Escape path — focus on a
    // menu ITEM (MtMenu auto-focused it on open), not on the trigger — was asserted for "menu closed +
    // focus back on the trigger" on MtMenu in isolation (multitable-ui-p2-1b-overlays.spec.ts) and in
    // this file's `MtMenu roving + Escape` block, but never together with (c) "the REAL inspector did
    // NOT emit close". Mechanism as implemented (read before writing this): the menu content is
    // Teleported to `document.body`, so this keydown never bubbles into `.meta-record-drawer` and
    // never reaches the root `onInspectorKeydown` at all — MtMenu's own `.mt-menu` handler consumes
    // it (`preventDefault` + `isOpen=false` + a nextTick refocus of the trigger it captured at open);
    // the root handler's `defaultPrevented` early-return is an independent second guard for a
    // non-Teleported Escape. `defaultPrevented` is asserted below so the MECHANISM is pinned, not
    // just the outcome. Mutation: delete the `trigger.focus()` refocus in MtMenu.vue's Escape branch
    // → assertion (b) reds (activeElement is `body`, not the kebab) while the menu still closes.
    it('Escape dispatched on the FOCUSED MENU ITEM closes the menu, returns focus to the kebab trigger, and emits NO close (real MetaRecordInspector)', async () => {
      const onClose = vi.fn()
      const { container } = mountInspector({ onClose })
      const trigger = kebabTrigger(container)
      await flushUi() // settle the subscription fetch before opening — see the roving test's own comment
      await openKebab(container)
      const items = menuItems()
      expect(items.length).toBeGreaterThan(0)
      const focusedItem = document.activeElement as HTMLElement
      expect(items).toContain(focusedItem) // discriminating setup: focus IS on a menu item…
      expect(focusedItem).not.toBe(trigger) // …not on the trigger (the sibling test above covers that)

      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      focusedItem.dispatchEvent(escape)
      expect(escape.defaultPrevented).toBe(true) // MtMenu consumed it — the mechanism itself
      await flushUi()

      expect(menuItems()).toHaveLength(0) // (a) menu closed — Teleported panel removed
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(trigger) // (b) focus returned to the kebab trigger
      expect(onClose).not.toHaveBeenCalled() // (c) the PANEL did not close
      expect(container.querySelector('.meta-record-drawer')).toBeTruthy() // still rendered
    })

    it('positive control: Escape with the menu CLOSED emits close exactly once', async () => {
      const onClose = vi.fn()
      const { container } = mountInspector({ onClose })
      await flushUi()
      container.querySelector('.meta-record-drawer')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      )
      await flushUi()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('Row B title block', () => {
    it('renders the eyebrow (record.title) and the primary-field value as an editable input when canEditField(primary) && type===string', async () => {
      const { container } = mountInspector()
      await flushUi()
      const eyebrow = container.querySelector('.meta-record-drawer__eyebrow')
      expect(eyebrow?.textContent).toBe(recordLabel('record.title', false))
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')
      expect(input).toBeTruthy()
      expect(input!.value).toBe('Alpha')
      expect(input!.getAttribute('aria-label')).toBe(recordLabel('record.titleFieldAria', false))
    })

    it('renders a read-only title-text div when the primary field is not editable (canEdit false)', async () => {
      const { container } = mountInspector({ canEdit: false })
      await flushUi()
      expect(container.querySelector('.meta-record-drawer__title-input')).toBeNull()
      const text = container.querySelector('.meta-record-drawer__title-text')
      expect(text).toBeTruthy()
      expect(text!.textContent).toBe('Alpha')
    })

    it('change commits via the same patch sink as every other field editor', async () => {
      const onPatch = vi.fn()
      const { container } = mountInspector({ onPatch })
      await flushUi()
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')!
      input.value = 'Beta'
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi()
      expect(onPatch).toHaveBeenCalledWith('fld_title', 'Beta')
    })

    it('Escape reverts the displayed value, emits no patch, and does not close the panel (root sees defaultPrevented)', async () => {
      const onPatch = vi.fn()
      const onClose = vi.fn()
      const { container } = mountInspector({ onPatch, onClose })
      await flushUi()
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')!
      input.value = 'Typed but not committed'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await flushUi()
      expect(input.value).toBe('Alpha')
      expect(onPatch).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('prop change (record.data) re-syncs the input value (server-rejection revert)', async () => {
      // F3 (round 3): a `ref` read by the render closure replaces this test's former inline
      // `data()`/`created()` component (see `mountApp`'s own comment) — identical reactivity.
      const record = ref<MetaRecord>(RECORD)
      const apiClient = fakeApiClient() as any
      const { container, app } = mountApp(() =>
        h(MetaRecordInspector, {
          visible: true,
          record: record.value,
          fields: FIELDS,
          canEdit: true,
          canComment: false,
          canDelete: false,
          recordIds: ['rec_1'],
          sheetId: 'sheet_1',
          apiClient,
        }),
      )
      await flushUi()
      record.value = { id: 'rec_1', version: 2, data: { fld_title: 'Reverted', fld_notes: '' } } as MetaRecord
      await flushUi()
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')!
      expect(input.value).toBe('Reverted')
      app.unmount()
    })
  })

  describe('prev/next chord (§1.5 item 3)', () => {
    it('mod+shift+Comma/Period from inside a text control emits navigate with the neighbour id', async () => {
      const onNavigate = vi.fn()
      const { container } = mountInspector({ recordIds: ['rec_0', 'rec_1', 'rec_2'], onNavigate })
      await flushUi()
      const textarea = container.querySelector('.meta-record-drawer__textarea') as HTMLTextAreaElement
      expect(textarea).toBeTruthy()
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: '<', code: 'Comma', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }))
      expect(onNavigate).toHaveBeenCalledWith('rec_0')
      textarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: '>', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }))
      expect(onNavigate).toHaveBeenCalledWith('rec_2')
    })

    it('bounds: chord at the first/last record emits nothing', async () => {
      const onNavigate = vi.fn()
      const { container } = mountInspector({ recordIds: ['rec_1'], onNavigate })
      await flushUi()
      container.querySelector('.meta-record-drawer')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: '<', code: 'Comma', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }))
      container.querySelector('.meta-record-drawer')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: '>', code: 'Period', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }))
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('chord without Shift is ignored (not treated as the prev/next chord)', async () => {
      const onNavigate = vi.fn()
      const { container } = mountInspector({ recordIds: ['rec_0', 'rec_1', 'rec_2'], onNavigate })
      await flushUi()
      container.querySelector('.meta-record-drawer')!.dispatchEvent(new KeyboardEvent('keydown', {
        key: ',', code: 'Comma', ctrlKey: true, shiftKey: false, bubbles: true, cancelable: true,
      }))
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('bare ArrowUp/ArrowDown outside the tablist/splitter emit nothing (not hijacked by the chord or tab logic)', async () => {
      const onNavigate = vi.fn()
      const { container } = mountInspector({ recordIds: ['rec_0', 'rec_1', 'rec_2'], onNavigate })
      await flushUi()
      const input = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')!
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('mod+z still bubbles untouched (never defaultPrevented by this root handler)', async () => {
      const { container } = mountInspector({ recordIds: ['rec_0', 'rec_1', 'rec_2'] })
      await flushUi()
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
      container.querySelector('.meta-record-drawer')!.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    })
  })

  describe('§3.3 tab-switch focus', () => {
    it('pointer activation (click) focuses the first focusable control in the new tabpanel', async () => {
      const { container } = mountInspector()
      await flushUi()
      const historyTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        .find((b) => b.textContent === recordLabel('record.history', false))!
      historyTab.click()
      await flushUi()
      const panel = container.querySelector('[role="tabpanel"]')!
      expect(panel.getAttribute('aria-labelledby')).toBe(historyTab.id)
      // The active element is either a focusable control inside the panel, or the panel itself
      // (tabindex=0 fallback) — never the tab button that was clicked.
      expect(document.activeElement).not.toBe(historyTab)
      expect(panel === document.activeElement || panel.contains(document.activeElement)).toBe(true)
    })

    it('arrow activation keeps focus ON the tab (APG), not the panel', async () => {
      const { container } = mountInspector()
      await flushUi()
      const [detailsTab] = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      detailsTab.focus()
      detailsTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
      await flushUi()
      const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      const historyTab = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!
      expect(document.activeElement).toBe(historyTab)
    })
  })

  describe('splitter DOM order (§1.2)', () => {
    it('the splitter is the LAST focusable element in DOM order (not the first)', async () => {
      const { container } = mountInspector()
      await flushUi()
      const root = container.querySelector('.meta-record-drawer')!
      const focusable = Array.from(root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="tab"], [role="separator"]',
      ))
      expect(focusable.length).toBeGreaterThan(1)
      expect(focusable[focusable.length - 1].getAttribute('role')).toBe('separator')
    })
  })

  describe('focus capture/restore (openerEl)', () => {
    it('a connected openerEl is refocused when the inspector unmounts', async () => {
      const opener = document.createElement('button')
      document.body.appendChild(opener)
      const { app } = mountInspector({ openerEl: opener })
      await flushUi()
      app.unmount()
      expect(document.activeElement).toBe(opener)
      opener.remove()
    })

    it('a detached openerEl does not throw and falls back to .meta-grid', async () => {
      const gridRoot = document.createElement('div')
      gridRoot.className = 'meta-grid'
      gridRoot.tabIndex = -1
      document.body.appendChild(gridRoot)
      const opener = document.createElement('button') // never appended -> isConnected === false
      const { app } = mountInspector({ openerEl: opener })
      await flushUi()
      expect(() => app.unmount()).not.toThrow()
      expect(document.activeElement).toBe(gridRoot)
      gridRoot.remove()
    })

    it('no openerEl at all falls back to .meta-grid', async () => {
      const gridRoot = document.createElement('div')
      gridRoot.className = 'meta-grid'
      gridRoot.tabIndex = -1
      document.body.appendChild(gridRoot)
      const { app } = mountInspector({ openerEl: null })
      await flushUi()
      app.unmount()
      expect(document.activeElement).toBe(gridRoot)
      gridRoot.remove()
    })
  })

  // P1 (2026-09-05, verified finding): the two tests directly above mount with `visible` already
  // `true` and unmount the whole app for "close" — that exercises only this component's
  // onMounted/onBeforeUnmount FALLBACK path (see MetaRecordInspector.vue's own file-header comment
  // on the two). In the REAL workbench this instance is created ONCE and `visible` toggles
  // false→true→false→true→… for every real open/close — this describe block reproduces exactly
  // that, through `mountToggleableInspector` above.
  describe('P1: focus capture/restore fires on EVERY open/close, not just the first (real-workbench shape)', () => {
    it('autofocuses the title and restores focus to the CURRENT opener on every open/close cycle, not only the first', async () => {
      const opener1 = document.createElement('button')
      opener1.textContent = 'opener-1'
      document.body.appendChild(opener1)
      const opener2 = document.createElement('button')
      opener2.textContent = 'opener-2'
      document.body.appendChild(opener2)

      const { container, setVisible, setOpener } = mountToggleableInspector()
      await flushUi()
      expect(container.querySelector('.meta-record-drawer')).toBeNull() // starts closed

      // --- open #1 ---
      setOpener(opener1)
      setVisible(true)
      await flushUi()
      const titleInputAfterOpen1 = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')
      expect(titleInputAfterOpen1).toBeTruthy()
      expect(document.activeElement).toBe(titleInputAfterOpen1) // autofocus on open #1

      // --- close #1 ---
      setVisible(false)
      await flushUi()
      expect(container.querySelector('.meta-record-drawer')).toBeNull()
      expect(document.activeElement).toBe(opener1) // restore on close #1

      // --- open #2, with a DIFFERENT opener --- this is the case the finding names: under the
      // reverted (onMounted-only) implementation, onMounted already fired once, at the instance's
      // FIRST-EVER creation (with `visible` still false) — it never fires again, so this second
      // open would leave focus wherever it already was, not on the title.
      setOpener(opener2)
      setVisible(true)
      await flushUi()
      const titleInputAfterOpen2 = container.querySelector<HTMLInputElement>('.meta-record-drawer__title-input')
      expect(titleInputAfterOpen2).toBeTruthy()
      expect(document.activeElement).toBe(titleInputAfterOpen2) // autofocus on open #2 too

      // --- close #2 --- restores to opener2 (the CURRENT open's opener), not opener1 (stale).
      setVisible(false)
      await flushUi()
      expect(document.activeElement).toBe(opener2)

      opener1.remove()
      opener2.remove()
    })
  })

  // F1 (2026-09-05, round 3): `resolvePrimaryField(fields)` is literally `fields[0]` — and THIS
  // component reads it over its `fields` PROP, which the workbench binds as `scopedAllFields` (SHEET
  // order, view-hidden fields still present; only per-subject field-permission-hidden fields removed).
  // The three WB label call sites (`bulkFillRecordName` / `captureSelectionLabels` / `batchRecordLabel`)
  // read the SAME helper over `grid.visibleFields` (VIEW order, view-hidden removed) — so the two
  // answers diverge whenever a view hides or reorders sheet-field 0. This pins what the inspector
  // actually does today (sheet-order field 0, even a hidden, non-text one), so the divergence is
  // documented behavior with a test attached (see recordDisplay.ts's F1 comment), not an assumption.
  describe('F1: title reads the sheet-order first field (fields[0]) — not the first view-visible text field', () => {
    it('with fields[0] a property-hidden number field, the title shows ITS formatted value, not the string field a hidden-filtered (view) order would pick', async () => {
      const HIDDEN_NUMBER = { id: 'fld_amount', name: 'Amount', type: 'number', property: { hidden: true } } as unknown as MetaField
      const fields: MetaField[] = [HIDDEN_NUMBER, TITLE_FIELD, NOTES_FIELD]
      const record = { id: 'rec_1', version: 1, data: { fld_amount: 42, fld_title: 'Alpha', fld_notes: '' } } as unknown as MetaRecord

      // The helper itself: position 0 — no type filter, no hidden filter.
      expect(resolvePrimaryField(fields)?.id).toBe('fld_amount')
      // What a view that hides field 0 hands the WB label call sites instead — the divergence F1 names.
      const viewVisible = fields.filter((f) => !(f as { property?: { hidden?: boolean } }).property?.hidden)
      expect(resolvePrimaryField(viewVisible)?.id).toBe('fld_title')

      const { container } = mountInspector({ fields, record })
      await flushUi()
      // `number` is not `string` → no editable title input; the read-only title text renders field 0's
      // value through the SAME formatter the component uses.
      expect(container.querySelector('.meta-record-drawer__title-input')).toBeNull()
      const title = container.querySelector('.meta-record-drawer__title-text')!
      expect(title).toBeTruthy()
      expect(title.textContent).toBe(formatRecordFieldValue(HIDDEN_NUMBER, 42, { isZh: false }))
      expect(title.textContent).toContain('42')
      expect(title.textContent).not.toBe('Alpha') // NOT the first view-visible string field
    })
  })

  describe('label sourcing sanity (i18n discipline)', () => {
    it('grid.openRecord resolves through metaCoreLabel, not a hardcoded literal in this file', () => {
      expect(metaCoreLabel('grid.openRecord', false)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', true)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', false)).not.toBe(metaCoreLabel('grid.openRecord', true))
    })
  })
})
