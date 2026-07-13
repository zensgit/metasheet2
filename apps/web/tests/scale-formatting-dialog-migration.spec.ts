import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import ScaleFormattingDialog from '../src/multitable/components/ScaleFormattingDialog.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: ScaleFormattingDialog's six SHARED-class `scf-dlg__btn` action controls (per-rule
// drop/add-mid-stop + remove, addRule, footer cancel/save) were migrated from bespoke <button>s to the
// shared MtButton primitive (variant primary/danger/ghost). Because the class was shared, ALL sharers were
// migrated at once and the bespoke hex CSS removed (no double-styling) — mirrors ConditionalFormattingDialog.
// Behavior-preservation proof: they stay native, keyboard-operable <button>s; :disabled bindings survive;
// clicking still runs the same handlers / emits the same events.
//
// UI-P2-1c T1 batch-3: the header close-× (`.scf-dlg__close`) was ALSO migrated, from a bespoke
// <button>&times;</button> to the shared MtIconButton primitive (T1 design-lock recommendation: keep
// the &times; glyph, only collapse padding/hover/focus-ring onto tokens — token-normalized, not
// zero-visual-change; see #4130/#4133 wording precedent). It stays a native, keyboard-operable
// <button>, keeps the SAME aria-label (`ml('formatting.close')`) and the SAME @click="close" — the
// local `close()` function (unsaved-dirty confirm guard, then `emit('close')`), unchanged by this
// migration. `.scf-dlg__close` is the sole sharer of that class in this file — its bespoke CSS was
// removed outright (no double-styling risk).

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.scf-dlg__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

const baseProps = () => ({ visible: true, fields: [{ id: 'f1', name: 'Score', type: 'number' }], viewConfig: {} })
function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(ScaleFormattingDialog, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}
const footerCancel = (r: HTMLElement) =>
  Array.from(r.querySelectorAll('.scf-dlg__footer .scf-dlg__btn')).find((b) => !b.classList.contains('scf-dlg__btn--primary')) as HTMLButtonElement
const footerSave = (r: HTMLElement) => r.querySelector('.scf-dlg__footer .scf-dlg__btn--primary') as HTMLButtonElement
const addRuleBtn = (r: HTMLElement) =>
  Array.from(r.querySelectorAll('.scf-dlg__btn--primary')).find((b) => !b.closest('.scf-dlg__footer')) as HTMLButtonElement
const headerCloseBtn = (r: HTMLElement) => r.querySelector('.scf-dlg__close') as HTMLButtonElement

describe('ScaleFormattingDialog — MtButton migration (UI-P2-1c)', () => {
  it('renders footer cancel/save + addRule as native <button>s; save disabled until a valid dirty rule', () => {
    const root = mount(baseProps())
    expect(footerCancel(root).tagName).toBe('BUTTON') // keyboard-operable
    expect(footerSave(root).tagName).toBe('BUTTON')
    expect(addRuleBtn(root).tagName).toBe('BUTTON')
    expect(footerSave(root).disabled).toBe(true) // :disabled="!dirty || hasInvalidRule" — clean baseline
  })

  it('clicking cancel on a clean (non-dirty) dialog emits `close` (unchanged)', () => {
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    footerCancel(root).click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('addRule → per-rule remove renders as a native button; save emits `save`; remove drops the rule', async () => {
    const onSave = vi.fn()
    const root = mount(baseProps(), { onSave })
    addRuleBtn(root).click() // pushes a valid default dataBar rule → dirty, not invalid
    await nextTick()
    const removeBtn = root.querySelector('.scf-dlg__btn--danger') as HTMLButtonElement
    expect(removeBtn?.tagName).toBe('BUTTON') // danger MtButton
    expect(footerSave(root).disabled).toBe(false) // dirty + valid → :disabled binding preserved
    footerSave(root).click()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(Array.isArray(onSave.mock.calls[0][0])).toBe(true)
    expect(onSave.mock.calls[0][0].length).toBe(1)
    removeBtn.click() // @click="removeRule(index)" preserved
    await nextTick()
    expect(root.querySelector('.scf-dlg__btn--danger')).toBeNull() // rule row gone
  })

  it('T1 batch-3: renders the header close-× as a native <button> (MtIconButton) keeping class + aria-label + glyph', () => {
    useLocale().setLocale('en')
    const root = mount(baseProps())
    const btn = headerCloseBtn(root)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('scf-dlg__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
    expect(btn.textContent?.trim()).toBe('×')
  })

  it('T1 batch-3: renders the localized (zh) aria-label unchanged on the close-×', () => {
    useLocale().setLocale('zh')
    const root = mount(baseProps())
    expect(headerCloseBtn(root).getAttribute('aria-label')).toBe('关闭')
  })

  it('T1 batch-3: clicking the header close-× on a clean (non-dirty) dialog emits `close` with no payload (unchanged @click="close")', () => {
    useLocale().setLocale('en')
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    headerCloseBtn(root).click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })
})
