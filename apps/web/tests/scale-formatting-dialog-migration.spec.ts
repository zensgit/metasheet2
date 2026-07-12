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
// UI-P2-1c T1 batch-5 (multitable-ui-p2-1c-tail-resolution-designlock-20260707.md §2-T1, RATIFIED): the
// header close-× (`.scf-dlg__close`) was additionally migrated from a bespoke <button>&times;</button>
// to the shared MtIconButton primitive — the &times; glyph passes through MtIconButton's default-slot
// icon fallback (glyph char preserved, size token-normalized to the icon control, consistent with the
// existing glyph-MtIconButton controls already on main — this is the same class/handler shape as
// ConditionalFormattingDialog's `.cf-dlg__close`, migrated in #4133). Behavior-preservation proof: it
// stays a native, keyboard-operable <button>, keeps the SAME aria-label (`ml('formatting.close')`), and
// clicking it still calls the SAME close() — including the window.confirm dirty-guard (verified below;
// this dialog has no dedicated i18n spec exercising that path the way
// conditional-formatting-dialog-i18n.spec.ts does for the CF twin, so the guard is asserted directly
// here). This is the only sharer of `.scf-dlg__close` (single button, single file, no chip/remove ×
// sibling exists on this dialog — verified via repo-wide grep) — its bespoke CSS was removed outright,
// no double-styling risk.

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
const closeBtn = (r: HTMLElement) => r.querySelector('.scf-dlg__close') as HTMLButtonElement

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

  it('renders the header close-× as a native <button> (MtIconButton) keeping the class + aria-label + glyph', () => {
    const root = mount(baseProps())
    const btn = closeBtn(root)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.classList.contains('scf-dlg__close')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('Close')
    expect(btn.textContent?.trim()).toBe('×') // × glyph char preserved (size token-normalized)
  })

  it('clicking the header close-× on a clean (non-dirty) dialog emits `close` (unchanged — same close() as footer cancel)', () => {
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    closeBtn(root).click()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith()
  })

  it('clicking the header close-× on a dirty dialog still routes through the SAME window.confirm dirty-guard (declined → no close)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    addRuleBtn(root).click() // makes the draft dirty
    await nextTick()
    closeBtn(root).click()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled() // guard declined → close() returns early, unchanged behavior
    confirmSpy.mockRestore()
  })

  it('clicking the header close-× on a dirty dialog emits `close` once the SAME window.confirm dirty-guard is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    addRuleBtn(root).click() // makes the draft dirty
    await nextTick()
    closeBtn(root).click()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
  })
})
