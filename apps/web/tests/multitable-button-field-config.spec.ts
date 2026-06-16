// B1-c: MetaFieldManager button-field config authoring.
// KEYSTONE: editing a button field's label must NOT drop a server-authored
// actionConfig (update-field replaces property wholesale; design-lock §3.4).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'

describe('MetaFieldManager — button field config (B1-c)', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('creates a button field with the default action + variant (panel opens, property built)', async () => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const createSpy = vi.fn()
    const app = createApp({
      render: () => h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], fields: [], onCreateField: createSpy }),
    })
    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    nameInput.value = 'Approve'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'button'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    // config panel must open for a new button field (requiresConfig)
    expect(container.querySelector('.meta-field-mgr__config')).toBeTruthy()
    // set a label via the first config text input
    const labelInput = container.querySelector('.meta-field-mgr__config input[type="text"]') as HTMLInputElement
    labelInput.value = 'Approve'
    labelInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('+ Add'))?.click()
    await nextTick()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Approve',
      type: 'button',
      property: { label: 'Approve', variant: 'secondary', actionType: 'record_click', confirm: { enabled: false, message: '' } },
    })
    app.unmount()
  })

  it('KEYSTONE: editing the label preserves the existing actionConfig', async () => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const updateSpy = vi.fn()
    const Harness = defineComponent({
      setup: () => ({ updateSpy }),
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [],
          fields: [{
            id: 'fld_btn', name: 'Run', type: 'button',
            property: { label: 'Go', variant: 'primary', actionType: 'record_click', actionConfig: { foo: 'bar', n: 1 }, confirm: { enabled: false, message: '' } },
          }],
          onUpdateField: this.updateSpy,
        })
      },
    })
    const app = createApp(Harness)
    app.mount(container)
    await nextTick()

    // open config for the existing button field
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    // change ONLY the label
    const labelInput = container.querySelector('.meta-field-mgr__config input[type="text"]') as HTMLInputElement
    expect(labelInput.value).toBe('Go') // hydrated from property
    labelInput.value = 'Renamed'
    labelInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings'))?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [fieldId, input] = updateSpy.mock.calls[0]
    expect(fieldId).toBe('fld_btn')
    // the keystone: actionConfig survived a label-only edit, byte-for-byte
    expect(input.property.actionConfig).toEqual({ foo: 'bar', n: 1 })
    expect(input.property.label).toBe('Renamed')
    expect(input.property.variant).toBe('primary')
    expect(input.property.actionType).toBe('record_click')
    app.unmount()
  })
})
