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
        canComment: false,
        canDelete: false,
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

  describe('label sourcing sanity (i18n discipline)', () => {
    it('grid.openRecord resolves through metaCoreLabel, not a hardcoded literal in this file', () => {
      expect(metaCoreLabel('grid.openRecord', false)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', true)).toBeTruthy()
      expect(metaCoreLabel('grid.openRecord', false)).not.toBe(metaCoreLabel('grid.openRecord', true))
    })
  })
})
