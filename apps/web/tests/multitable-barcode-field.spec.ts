import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('barcode field UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders barcode values as copy-friendly monospace text', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_barcode', name: 'Barcode', type: 'barcode' },
          value: '6901234567890',
        })
      },
    })

    app.mount(container)
    await flushUi()

    const value = container.querySelector('.meta-cell-renderer__barcode') as HTMLElement | null
    expect(value).not.toBeNull()
    expect(value?.textContent).toBe('6901234567890')

    app.unmount()
    container.remove()
  })

  it('uses a text-backed cell editor for barcode values', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_barcode', name: 'Barcode', type: 'barcode' },
          modelValue: '6901234567890',
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[placeholder="Scan or enter barcode"]') as HTMLInputElement | null
    expect(input?.type).toBe('text')
    input!.value = 'ABC-123'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith('ABC-123')
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('creates barcode fields from the field manager without configurable property', async () => {
    const createSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [],
          onCreateField: createSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    expect(Array.from(typeSelect.options).map((option) => option.value)).toContain('barcode')

    nameInput.value = 'Barcode'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'barcode'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Barcode',
      type: 'barcode',
    })

    app.unmount()
    container.remove()
  })

  it('submits barcode values from form view', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_barcode', name: 'Barcode', type: 'barcode' }],
          record: { id: 'rec_1', version: 1, data: { fld_barcode: 'OLD' } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#field_fld_barcode') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Scan or enter barcode')
    input!.value = 'NEW-123'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_barcode: 'NEW-123' })

    app.unmount()
    container.remove()
  })

  it('patches barcode values from the record drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: { id: 'rec_1', version: 1, data: { fld_barcode: 'OLD' } },
          fields: [{ id: 'fld_barcode', name: 'Barcode', type: 'barcode' }],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#drawer_field_fld_barcode') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Scan or enter barcode')
    input!.value = 'DRAWER-123'
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_barcode', 'DRAWER-123')

    app.unmount()
    container.remove()
  })
})
