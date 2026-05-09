import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaBulkEditDialog from '../src/multitable/components/MetaBulkEditDialog.vue'
import type { MetaField } from '../src/multitable/types'

const baseFields: MetaField[] = [
  { id: 'fld_name', name: 'Name', type: 'string', property: {} },
  { id: 'fld_notes', name: 'Notes', type: 'longText', property: {} },
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
  { id: 'fld_status', name: 'Status', type: 'select', property: { options: [{ value: 'Open' }] } },
  { id: 'fld_link', name: 'Linked', type: 'link', property: {} },
  { id: 'fld_attach', name: 'Files', type: 'attachment', property: {} },
  { id: 'fld_formula', name: 'Calc', type: 'formula', property: {} },
  { id: 'fld_lookup', name: 'Lookup', type: 'lookup', property: {} },
  { id: 'fld_rollup', name: 'Rollup', type: 'rollup', property: {} },
  { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true } },
  { id: 'fld_hidden', name: 'Hidden', type: 'string', property: { hidden: true } },
  { id: 'fld_auto', name: 'AutoNum', type: 'autoNumber', property: {} },
  { id: 'fld_created', name: 'Created', type: 'createdTime', property: {} },
]

function mountDialog(propsOverride: Partial<{
  mode: 'set' | 'clear'
  visible: boolean
  fields: MetaField[]
  canEdit: boolean
  fieldPermissions: Record<string, { readOnly?: boolean }>
  recordIds: string[]
  busy: boolean
  error: string | null
  resultMessage: string | null
  onApply: (...args: unknown[]) => unknown
  onCancel: (...args: unknown[]) => unknown
}> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const props = {
    visible: true,
    mode: 'set' as const,
    fields: baseFields,
    canEdit: true,
    fieldPermissions: {},
    recordIds: ['rec_1', 'rec_2', 'rec_3'],
    busy: false,
    error: null as string | null,
    resultMessage: null as string | null,
    onApply: vi.fn(),
    onCancel: vi.fn(),
    ...propsOverride,
  }
  const app = createApp({
    render() {
      return h(MetaBulkEditDialog, props)
    },
  })
  app.mount(container)
  return { app, container, props, root: document.body }
}

describe('MetaBulkEditDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('shows the set-mode title and summary when mode is set', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()
    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('Set field for selected records')
    expect(root.querySelector('.meta-bulk-edit__hint')?.textContent).toContain('Pick a field and a value')
    app.unmount()
  })

  it('shows the clear-mode title when mode is clear', async () => {
    const { app, root } = mountDialog({ mode: 'clear' })
    await nextTick()
    expect(root.querySelector('.meta-bulk-edit__header strong')?.textContent).toBe('Clear field for selected records')
    app.unmount()
  })

  it('field picker excludes system, derived, link, attachment, hidden, and readonly fields', async () => {
    const { app, root } = mountDialog()
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).toEqual(['fld_name', 'fld_notes', 'fld_amount', 'fld_status'])
    expect(options).not.toContain('fld_link')
    expect(options).not.toContain('fld_attach')
    expect(options).not.toContain('fld_formula')
    expect(options).not.toContain('fld_lookup')
    expect(options).not.toContain('fld_rollup')
    expect(options).not.toContain('fld_locked')
    expect(options).not.toContain('fld_hidden')
    expect(options).not.toContain('fld_auto')
    expect(options).not.toContain('fld_created')
    app.unmount()
  })

  it('field picker also respects explicit fieldPermissions readOnly map', async () => {
    const { app, root } = mountDialog({
      fieldPermissions: { fld_name: { readOnly: true } },
    })
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).not.toContain('fld_name')
    expect(options).toContain('fld_notes')
    app.unmount()
  })

  it('field picker is empty when canEdit is false', async () => {
    const { app, root } = mountDialog({ canEdit: false })
    await nextTick()
    const options = Array.from(root.querySelectorAll('.meta-bulk-edit__select option'))
      .map((option) => (option as HTMLOptionElement).value)
      .filter((value) => value.length > 0)
    expect(options).toEqual([])
    expect(root.querySelector('.meta-bulk-edit__hint--muted')?.textContent).toContain('No bulk-editable fields')
    app.unmount()
  })

  it('emits apply with set-mode payload after picking a field and value', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({ mode: 'set', onApply })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=text]') as HTMLInputElement
    input.value = 'Alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    submit.click()
    await nextTick()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      mode: 'set',
      fieldId: 'fld_name',
      value: 'Alpha',
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('emits apply with clear-mode payload (value: null) without a value editor', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({ mode: 'clear', onApply })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_notes'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(root.querySelector('.meta-bulk-edit__value-wrap input')).toBeNull()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    submit.click()
    await nextTick()

    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply).toHaveBeenCalledWith({
      mode: 'clear',
      fieldId: 'fld_notes',
      value: null,
      recordIds: ['rec_1', 'rec_2', 'rec_3'],
    })
    app.unmount()
  })

  it('Apply is disabled in set mode until a value is entered', async () => {
    const { app, root } = mountDialog({ mode: 'set' })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    app.unmount()
  })

  it('renders an error message when the parent passes a conflict / failure', async () => {
    const onApply = vi.fn()
    const { app, root } = mountDialog({
      mode: 'set',
      error: 'Some records were modified elsewhere. Reload and retry.',
      onApply,
    })
    await nextTick()

    const errorBlock = root.querySelector('.meta-bulk-edit__error')
    expect(errorBlock).not.toBeNull()
    expect(errorBlock?.textContent).toContain('modified elsewhere')
    app.unmount()
  })

  it('disables Apply while busy is true (re-entrancy guard)', async () => {
    const { app, root } = mountDialog({ mode: 'set', busy: true })
    await nextTick()

    const select = root.querySelector('.meta-bulk-edit__select') as HTMLSelectElement
    select.value = 'fld_name'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const input = root.querySelector('.meta-bulk-edit__value-wrap input[type=text]') as HTMLInputElement
    input.value = 'Alpha'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const submit = Array.from(root.querySelectorAll('.meta-bulk-edit__btn--primary'))[0] as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    app.unmount()
  })

  it('emits cancel when the close button is clicked', async () => {
    const onCancel = vi.fn()
    const { app, root } = mountDialog({ onCancel })
    await nextTick()

    const close = root.querySelector('.meta-bulk-edit__close') as HTMLButtonElement
    close.click()
    await nextTick()

    expect(onCancel).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
