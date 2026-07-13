import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaPersonPicker from '../src/multitable/components/MetaPersonPicker.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaPersonPicker's two footer action controls (cancel / confirm) were migrated from
// bespoke <button>s to the shared MtButton primitive (confirm = variant="primary", matching the
// #409eff filled-blue precedent landed for MetaBulkEditDialog in #3826). Behavior-preservation
// proof: they stay native, keyboard-operable <button>s; clicking cancel still emits `close`; and
// clicking confirm still emits `confirm` with the SAME { userIds, summaries } payload as the
// pre-migration onConfirm. The `watch(() => props.visible, …)` is non-immediate, so mounting with
// visible:true does NOT trigger loadMembers() — no directory API to stub, selection stays empty.
// The dialog is an inline v-if overlay (not teleported), but we query `document` for robustness.
//
// UI-P2-1c T1 batch-3: the header close-× (`.meta-person-picker__close`) was ALSO migrated, from a
// bespoke <button>&times;</button> to the shared MtIconButton primitive (T1 design-lock recommendation:
// keep the &times; glyph, only collapse padding/hover/focus-ring onto tokens — token-normalized, not
// zero-visual-change; see #4130/#4133 wording precedent). It stays a native, keyboard-operable
// <button>, keeps the SAME aria-label (`pp('personPicker.close')`) and the SAME @click="emit('close')"
// (no payload). `.meta-person-picker__close` is the sole sharer of that class in this file — its
// bespoke CSS was removed outright (no double-styling risk).
// Left untouched per the classifier: the chip-remove × glyphs (`@click="removeSelected(id)"` — a
// "remove this chip" action, not a dismiss/close — and the Clear button) stay bespoke <button>s.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-person-picker__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaPersonPicker, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

const baseProps = () => ({ visible: true, sheetId: 's1' })
const cancelBtn = () => document.querySelector('.meta-person-picker__cancel') as HTMLButtonElement
const confirmBtn = () => document.querySelector('.meta-person-picker__confirm') as HTMLButtonElement
const closeBtn = () => document.querySelector('.meta-person-picker__close') as HTMLButtonElement

describe('MetaPersonPicker — MtButton migration (UI-P2-1c)', () => {
  it('renders cancel + confirm as native, enabled <button>s (keyboard-operable, not bare divs)', () => {
    mount(baseProps())
    expect(cancelBtn().tagName).toBe('BUTTON')
    expect(confirmBtn().tagName).toBe('BUTTON')
    // no :disabled binding on either footer control — both are active on initial mount
    expect(cancelBtn().disabled).toBe(false)
    expect(confirmBtn().disabled).toBe(false)
    // data-test hook survives the migration (existing person-picker suite queries it)
    expect(confirmBtn().getAttribute('data-test')).toBe('person-picker-confirm')
  })

  it('clicking cancel emits `close` (unchanged from pre-migration @click="emit(\'close\')")', () => {
    const onClose = vi.fn()
    mount(baseProps(), { onClose })
    cancelBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clicking confirm emits `confirm` with the same { userIds, summaries } payload (onConfirm intact)', () => {
    const onConfirm = vi.fn()
    mount(baseProps(), { onConfirm })
    confirmBtn().click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    // selection empty (loadMembers never ran) → onConfirm emits empty arrays, exactly as before
    expect(onConfirm).toHaveBeenCalledWith({ userIds: [], summaries: [] })
  })

  it('T1 batch-3: renders the header close-× as a native <button> (MtIconButton) keeping class + aria-label + glyph', () => {
    useLocale().setLocale('en')
    mount(baseProps())
    const btn = closeBtn()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('meta-person-picker__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close people picker')
    expect(btn.textContent?.trim()).toBe('×')
  })

  it('T1 batch-3: renders the localized (zh) aria-label unchanged on the close-×', () => {
    useLocale().setLocale('zh')
    mount(baseProps())
    expect(closeBtn().getAttribute('aria-label')).toBe('关闭人员选择器')
  })

  it('T1 batch-3: clicking the header close-× emits `close` with no payload (unchanged from pre-migration @click="emit(\'close\')")', () => {
    const onClose = vi.fn()
    mount(baseProps(), { onClose })
    closeBtn().click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
