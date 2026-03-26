import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'

describe('MetaFieldManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('emits select field properties when creating a configured field', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_2', name: 'Related' }],
          fields: [],
          onCreateField: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    nameInput.value = 'Status'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'select'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const optionInputs = Array.from(container.querySelectorAll('.meta-field-mgr__option-row .meta-field-mgr__input')) as HTMLInputElement[]
    optionInputs[0].value = 'Open'
    optionInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    optionInputs[1].value = '#409eff'
    optionInputs[1].dispatchEvent(new Event('input', { bubbles: true }))

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await nextTick()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Status',
      type: 'select',
      property: {
        options: [{ value: 'Open', color: '#409eff' }],
      },
    })

    app.unmount()
  })

  it('emits attachment field property updates from the config panel', async () => {
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
            { id: 'fld_files', name: 'Files', type: 'attachment', property: {} },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButton = container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null
    configureButton?.click()
    await nextTick()

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    configInputs[0].value = '3'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    configInputs[1].value = 'image/png,application/pdf'
    configInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_files', {
      property: {
        maxFiles: 3,
        acceptedMimeTypes: ['image/png', 'application/pdf'],
      },
    })

    app.unmount()
  })

  it('keeps new-field config gated behind configured defaults after cancel', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_2', name: 'Related' }],
          fields: [],
          onCreateField: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    typeSelect.value = 'select'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-cancel')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Cancel'))
      ?.click()
    await nextTick()

    expect(typeSelect.value).toBe('select')
    expect(container.querySelector('.meta-field-mgr__config')).toBeNull()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'Status'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await nextTick()

    expect(createSpy).not.toHaveBeenCalled()
    expect(container.querySelector('.meta-field-mgr__config')).not.toBeNull()

    app.unmount()
  })

  it('rejects stale link targets after sheets props change while config stays open', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const sheets = ref([
          { id: 'sheet_1', name: 'Current' },
          { id: 'sheet_2', name: 'Related' },
        ])
        return {
          sheets,
          onUpdateField: updateSpy,
        }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: this.sheets,
          fields: [{ id: 'fld_link', name: 'Related', type: 'link', property: {} }],
          onUpdateField: this.onUpdateField,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const targetSheetSelect = container.querySelector('.meta-field-mgr__config .meta-field-mgr__select') as HTMLSelectElement
    targetSheetSelect.value = 'sheet_2'
    targetSheetSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    vm.sheets = [{ id: 'sheet_1', name: 'Current' }]
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Choose a target sheet for link fields')

    app.unmount()
  })

  it('shows a live refresh cue while clean and reloads latest when draft becomes stale', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 1, acceptedMimeTypes: ['image/png'] } },
        ])
        return {
          fields,
          onUpdateField: updateSpy,
        }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: this.fields,
          onUpdateField: this.onUpdateField,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.fields = [
      { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/jpeg'] } },
    ]
    await nextTick()

    expect(container.textContent).toContain('Latest field metadata loaded from the sheet context.')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Dismiss'))
      ?.click()
    await nextTick()

    expect(container.textContent).not.toContain('Latest field metadata loaded from the sheet context.')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('fld_files', {
      property: {
        maxFiles: 2,
        acceptedMimeTypes: ['image/jpeg'],
      },
    })

    updateSpy.mockClear()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    configInputs[0].value = '4'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    vm.fields = [
      { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 3, acceptedMimeTypes: ['application/pdf'] } },
    ]
    await nextTick()

    expect(container.textContent).toContain('This field changed in the background')
    expect(container.textContent).not.toContain('Latest field metadata loaded from the sheet context.')

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Reload latest'))
      ?.click()
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('fld_files', {
      property: {
        maxFiles: 3,
        acceptedMimeTypes: ['application/pdf'],
      },
    })

    app.unmount()
  })

  it('asks before closing when manager has unsaved drafts', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [],
          onClose: closeSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'Unsaved'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__close') as HTMLButtonElement | null)?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved field manager changes?')
    expect(closeSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  it('emits dirty state while field manager drafts are unsaved', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dirtySpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [],
          'onUpdate:dirty': dirtySpy,
        })
      },
    })

    app.mount(container)
    await nextTick()
    expect(dirtySpy).toHaveBeenLastCalledWith(false)

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'Unsaved'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(dirtySpy).toHaveBeenLastCalledWith(true)

    app.unmount()
  })

  it('blocks save until reload when configured field changes type upstream mid-edit', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/png'] } },
        ])
        return { fields }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: this.fields,
          onUpdateField: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const maxFilesInput = container.querySelector('.meta-field-mgr__config .meta-field-mgr__input') as HTMLInputElement
    maxFilesInput.value = '5'
    maxFilesInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    vm.fields = [
      { id: 'fld_files', name: 'Owner', type: 'link', property: { refKind: 'user', limitSingleRecord: false } },
    ]
    await nextTick()

    expect(container.textContent).toContain('This field changed type in the background. Reload latest before saving.')
    const saveButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings')) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    saveButton.click()
    await nextTick()
    expect(updateSpy).not.toHaveBeenCalled()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Reload latest'))
      ?.click()
    await nextTick()

    expect(container.textContent).toContain('person')
    expect(container.textContent).toContain('Limit to a single person')
    expect(container.textContent).not.toContain('Max files')

    app.unmount()
  })
})
