import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaCellRenderer from '../src/multitable/components/cells/MetaCellRenderer.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import MetaFormView from '../src/multitable/components/MetaFormView.vue'
import MetaRecordDrawer from '../src/multitable/components/MetaRecordDrawer.vue'
import { formatFieldDisplay, locationAddressValue, locationValueFromAddress } from '../src/multitable/utils/field-display'

async function flushUi(cycles = 3) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('location field UI', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('formats location values from address strings, objects, and coordinates', () => {
    const field = { id: 'fld_location', name: 'Location', type: 'location' as const }
    expect(formatFieldDisplay({ field, value: 'Shanghai Tower' })).toBe('Shanghai Tower')
    expect(formatFieldDisplay({ field, value: { address: 'Shanghai Tower', latitude: 31.2335, longitude: 121.5055 } })).toBe('Shanghai Tower')
    expect(formatFieldDisplay({ field, value: { latitude: 31.2335, longitude: 121.5055 } })).toBe('31.2335, 121.5055')
    expect(locationAddressValue({ lat: 31.2335, lng: 121.5055 })).toBe('31.2335, 121.5055')
    expect(locationValueFromAddress('  Shanghai Tower  ')).toEqual({ address: 'Shanghai Tower' })
    expect(locationValueFromAddress('   ')).toBeNull()
  })

  it('renders location values with a location-specific class', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellRenderer, {
          field: { id: 'fld_location', name: 'Location', type: 'location' },
          value: { address: 'Shanghai Tower', latitude: 31.2335, longitude: 121.5055 },
        })
      },
    })

    app.mount(container)
    await flushUi()

    const value = container.querySelector('.meta-cell-renderer__location') as HTMLElement | null
    expect(value).not.toBeNull()
    expect(value?.textContent).toBe('Shanghai Tower')

    app.unmount()
    container.remove()
  })

  it('uses an address-backed cell editor for location values', async () => {
    const updateSpy = vi.fn()
    const confirmSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_location', name: 'Location', type: 'location' },
          modelValue: { address: 'Old Address', latitude: 31.2335, longitude: 121.5055 },
          'onUpdate:modelValue': updateSpy,
          onConfirm: confirmSpy,
          onCancel: vi.fn(),
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('input[placeholder="Enter address"]') as HTMLInputElement | null
    expect(input?.type).toBe('text')
    expect(input?.value).toBe('Old Address')
    input!.value = 'New Address'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushUi()

    expect(updateSpy).toHaveBeenCalledWith({ address: 'New Address' })
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    app.unmount()
    container.remove()
  })

  it('creates location fields from the field manager without configurable property', async () => {
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
    expect(Array.from(typeSelect.options).map((option) => option.value)).toContain('location')

    nameInput.value = 'Location'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'location'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await flushUi()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Location',
      type: 'location',
    })

    app.unmount()
    container.remove()
  })

  it('submits location values from form view', async () => {
    const submitSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFormView, {
          fields: [{ id: 'fld_location', name: 'Location', type: 'location' }],
          record: { id: 'rec_1', version: 1, data: { fld_location: { address: 'Old Address' } } },
          loading: false,
          readOnly: false,
          onSubmit: submitSpy,
          onOpenLinkPicker: vi.fn(),
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#field_fld_location') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Enter address')
    expect(input?.value).toBe('Old Address')
    input!.value = 'New Address'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    container.querySelector('form')?.dispatchEvent(new Event('submit'))
    await flushUi()

    expect(submitSpy).toHaveBeenCalledWith({ fld_location: { address: 'New Address' } })

    app.unmount()
    container.remove()
  })

  it('patches location values from the record drawer', async () => {
    const patchSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaRecordDrawer, {
          visible: true,
          record: { id: 'rec_1', version: 1, data: { fld_location: { address: 'Old Address' } } },
          fields: [{ id: 'fld_location', name: 'Location', type: 'location' }],
          canEdit: true,
          canComment: false,
          canDelete: false,
          onPatch: patchSpy,
        })
      },
    })

    app.mount(container)
    await flushUi()

    const input = container.querySelector('#drawer_field_fld_location') as HTMLInputElement | null
    expect(input?.placeholder).toBe('Enter address')
    expect(input?.value).toBe('Old Address')
    input!.value = 'Drawer Address'
    input!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    expect(patchSpy).toHaveBeenCalledWith('fld_location', { address: 'Drawer Address' })

    app.unmount()
    container.remove()
  })
})

