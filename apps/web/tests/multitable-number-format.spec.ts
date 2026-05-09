import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MetaCellEditor from '../src/multitable/components/cells/MetaCellEditor.vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { formatFieldDisplay } from '../src/multitable/utils/field-display'

describe('multitable number format', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('formats number fields with decimals, thousands separators, and unit', () => {
    expect(formatFieldDisplay({
      field: {
        id: 'fld_weight',
        name: 'Weight',
        type: 'number',
        property: { decimals: 2, thousands: true, unit: 'kg' },
      },
      value: 12345.6,
    })).toBe('12,345.60 kg')
  })

  it('preserves legacy number display when no format property is configured', () => {
    expect(formatFieldDisplay({
      field: { id: 'fld_raw', name: 'Raw number', type: 'number', property: {} },
      value: 12345.678,
    })).toBe('12345.678')
  })

  it('creates number fields with display-format property from the field manager', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

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
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    nameInput.value = 'Weight'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'number'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    configInputs[0].value = '2'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    configInputs[1].value = 'kg'
    configInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    const thousandsCheckbox = container.querySelector('.meta-field-mgr__config input[type="checkbox"]') as HTMLInputElement
    thousandsCheckbox.checked = true
    thousandsCheckbox.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await nextTick()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Weight',
      type: 'number',
      property: {
        decimals: 2,
        thousands: true,
        unit: 'kg',
      },
    })

    app.unmount()
  })

  it('updates an existing number field without dropping validation rules', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            {
              id: 'fld_qty',
              name: 'Quantity',
              type: 'number',
              property: {
                decimals: 1,
                validation: [{ type: 'min', params: { value: 0 } }],
              },
            },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    expect(configInputs[0].value).toBe('1')
    configInputs[0].value = '3'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_qty', {
      property: {
        decimals: 3,
        thousands: false,
        validation: [{ type: 'min', params: { value: 0 } }],
      },
    })

    app.unmount()
  })

  it('uses the configured decimal precision as the number editor step', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaCellEditor, {
          field: { id: 'fld_score', name: 'Score', type: 'number', property: { decimals: 3 } },
          modelValue: 1.234,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.step).toBe('0.001')

    app.unmount()
  })
})
