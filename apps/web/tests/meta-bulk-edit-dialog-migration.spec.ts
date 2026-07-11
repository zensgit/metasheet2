import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaBulkEditDialog from '../src/multitable/components/MetaBulkEditDialog.vue'
import { useLocale } from '../src/composables/useLocale'

// UI-P2-1c: MetaBulkEditDialog's two action controls (cancel / apply) were migrated from bespoke
// <button>s to the shared MtButton primitive (apply = variant="primary"). Behavior-preservation
// proof: they stay native, keyboard-operable <button>s; the disabled binding survives; and clicking
// them still emits the SAME `cancel` / `apply` events with the SAME payload. The dialog teleports to
// <body>, so queries hit `document`, not the mount container.

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
afterEach(() => {
  while (mounts.length) { const m = mounts.pop()!; m.app.unmount(); m.container.remove() }
  expect(document.querySelectorAll('.meta-bulk-edit-overlay').length).toBe(0) // teleport residue guard
  useLocale().setLocale('en')
})

function mount(props: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const app = createApp({ setup: () => () => h(MetaBulkEditDialog, { ...props, ...handlers }) })
  app.mount(container)
  mounts.push({ app, container })
}

// clear mode: canSubmit only needs a chosen field (no cell value), so the apply path is exercisable
// without mounting MetaCellEditor. `text` is bulk-editable (not system / not a NON_BULK_EDITABLE type).
const baseProps = () => ({
  visible: true,
  mode: 'clear' as const,
  fields: [{ id: 'f1', name: 'Notes', type: 'text' }],
  canEdit: true,
  recordIds: ['r1', 'r2'],
})

const actionBtns = () =>
  Array.from(document.querySelectorAll('.meta-bulk-edit__actions .meta-bulk-edit__btn')) as HTMLElement[]
const applyBtn = () => document.querySelector('.meta-bulk-edit__btn--primary') as HTMLButtonElement

describe('MetaBulkEditDialog — MtButton migration (UI-P2-1c)', () => {
  it('renders cancel + apply as native <button>s; apply disabled until a field is chosen', () => {
    mount(baseProps())
    const btns = actionBtns()
    expect(btns.length).toBe(2)
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true) // keyboard-operable, not bare divs
    expect(applyBtn().disabled).toBe(true) // :disabled="!canSubmit || busy" — no field selected yet
  })

  it('clicking cancel emits `cancel` (unchanged from pre-migration onCancel)', () => {
    const onCancel = vi.fn()
    mount(baseProps(), { onCancel })
    const cancel = actionBtns().find((b) => !b.classList.contains('meta-bulk-edit__btn--primary')) as HTMLButtonElement
    cancel.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('choosing a field then clicking apply emits `apply` with the same payload (unchanged)', async () => {
    const onApply = vi.fn()
    mount(baseProps(), { onApply })
    const select = document.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'f1'
    select.dispatchEvent(new Event('change'))
    await nextTick()
    expect(applyBtn().disabled).toBe(false)
    applyBtn().click()
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({ mode: 'clear', fieldId: 'f1', value: null, recordIds: ['r1', 'r2'] })
  })
})
