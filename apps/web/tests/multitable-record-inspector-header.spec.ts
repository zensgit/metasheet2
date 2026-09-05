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
import { createApp, h, nextTick, type App } from 'vue'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'
import { recordLabel } from '../src/multitable/utils/meta-record-labels'
import { metaCoreLabel } from '../src/multitable/utils/meta-core-labels'

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

function mountInspector(options: HarnessOptions = {}): { container: HTMLElement; app: App } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({
    render() {
      return h(MetaRecordInspector, {
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
      })
    },
  })
  app.mount(container)
  mountedApps.push(app)
  return { container, app }
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
  const container = document.createElement('div')
  document.body.appendChild(container)
  let setVisible: (v: boolean) => void = () => {}
  let setOpener: (el: HTMLElement | null) => void = () => {}
  const app = createApp({
    data() {
      return { visible: false, openerEl: null as HTMLElement | null }
    },
    created() {
      setVisible = (v: boolean) => { this.visible = v }
      setOpener = (el: HTMLElement | null) => { this.openerEl = el }
    },
    render() {
      return h(MetaRecordInspector, {
        visible: this.visible,
        record: RECORD,
        fields: FIELDS,
        canEdit: true,
        canComment: false,
        canDelete: false,
        recordIds: ['rec_1'],
        sheetId: 'sheet_1',
        apiClient: fakeApiClient() as any,
        openerEl: this.openerEl,
      })
    },
  })
  app.mount(container)
  mountedApps.push(app)
  return { container, app, setVisible, setOpener }
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
      const commentBtnRule = src.match(/\.meta-record-drawer__btn--comment\s*\{[^}]*\}/)?.[0] ?? ''
      expect(commentBtnRule).toMatch(/max-width:\s*140px/)
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
      const container = document.createElement('div')
      document.body.appendChild(container)
      let setRecord: (r: MetaRecord) => void = () => {}
      const app = createApp({
        data() {
          return { record: RECORD }
        },
        created() {
          setRecord = (r: MetaRecord) => { this.record = r }
        },
        render() {
          return h(MetaRecordInspector, {
            visible: true,
            record: this.record,
            fields: FIELDS,
            canEdit: true,
            canComment: false,
            canDelete: false,
            recordIds: ['rec_1'],
            sheetId: 'sheet_1',
            apiClient: fakeApiClient() as any,
          })
        },
      })
      app.mount(container)
      await flushUi()
      setRecord({ id: 'rec_1', version: 2, data: { fld_title: 'Reverted', fld_notes: '' } } as MetaRecord)
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

  describe('label sourcing sanity (i18n discipline)', () => {
    it('grid.openRecord resolves through metaCoreLabel, not a hardcoded literal in this file', () => {
      expect(metaCoreLabel('grid.openRecord', false)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', true)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', false)).not.toBe(metaCoreLabel('grid.openRecord', true))
    })
  })
})
