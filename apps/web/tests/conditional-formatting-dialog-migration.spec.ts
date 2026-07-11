import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import ConditionalFormattingDialog from '../src/multitable/components/ConditionalFormattingDialog.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: ConditionalFormattingDialog's six SHARED-class `cf-dlg__btn` action controls
// (per-rule up/down/remove, addRule, footer cancel/save) were migrated from bespoke <button>s to the
// shared MtButton primitive (variant primary/danger/ghost). Because the class was shared across migrated
// AND would-be-left buttons, ALL sharers were migrated at once and the bespoke hex CSS removed — so the
// token primitive is not double-styled. Behavior-preservation proof: they stay native, keyboard-operable
// <button>s; :disabled bindings survive; clicking still runs the same handlers / emits the same events.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.cf-dlg__overlay').length).toBe(0) // residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(ConditionalFormattingDialog, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

const baseProps = () => ({ visible: true, fields: [{ id: 'f1', name: 'Status', type: 'singleLineText' }], viewConfig: {} })
const footerCancel = (r: HTMLElement) =>
  Array.from(r.querySelectorAll('.cf-dlg__footer .cf-dlg__btn')).find((b) => !b.classList.contains('cf-dlg__btn--primary')) as HTMLButtonElement
const footerSave = (r: HTMLElement) => r.querySelector('.cf-dlg__footer .cf-dlg__btn--primary') as HTMLButtonElement
const addRule = (r: HTMLElement) =>
  Array.from(r.querySelectorAll('.cf-dlg__btn--primary')).find((b) => !b.closest('.cf-dlg__footer')) as HTMLButtonElement

describe('ConditionalFormattingDialog — MtButton migration (UI-P2-1c)', () => {
  it('renders footer cancel/save + addRule as native <button>s; save disabled until dirty', () => {
    const root = mount(baseProps())
    expect(footerCancel(root).tagName).toBe('BUTTON') // keyboard-operable, not a bare div
    expect(footerSave(root).tagName).toBe('BUTTON')
    expect(addRule(root).tagName).toBe('BUTTON')
    expect(footerSave(root).disabled).toBe(true) // :disabled="!dirty" — clean baseline
  })

  it('clicking cancel on a clean (non-dirty) dialog emits `close` (unchanged)', () => {
    const onClose = vi.fn()
    const root = mount(baseProps(), { onClose })
    footerCancel(root).click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('addRule → per-rule up/down/remove render as native buttons; save emits `save`; remove drops the rule', async () => {
    const onSave = vi.fn()
    const root = mount(baseProps(), { onSave })
    addRule(root).click()
    await nextTick()
    const removeBtn = root.querySelector('.cf-dlg__btn--danger') as HTMLButtonElement
    const moveBtns = root.querySelectorAll('.cf-dlg__rule-row--actions .cf-dlg__btn--ghost')
    expect(removeBtn?.tagName).toBe('BUTTON') // danger MtButton
    expect(moveBtns.length).toBe(2) // up + down ghost MtButtons
    expect(Array.from(moveBtns).every((b) => b.tagName === 'BUTTON')).toBe(true)
    expect(footerSave(root).disabled).toBe(false) // adding a rule made it dirty → :disabled binding preserved
    footerSave(root).click()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(Array.isArray(onSave.mock.calls[0][0])).toBe(true)
    expect(onSave.mock.calls[0][0].length).toBe(1) // the rule we added
    removeBtn.click() // @click="removeRule(index)" preserved
    await nextTick()
    expect(root.querySelector('.cf-dlg__btn--danger')).toBeNull() // rule row gone
  })
})
