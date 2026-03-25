import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'

describe('MetaFieldManager', () => {
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
    container.remove()
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

    const configureButton = container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null
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
    container.remove()
  })

  it('lets users cancel new-field configuration without changing the selected type', async () => {
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

    expect(container.querySelector('.meta-field-mgr__config')).not.toBeNull()

    const optionInputs = Array.from(container.querySelectorAll('.meta-field-mgr__option-row .meta-field-mgr__input')) as HTMLInputElement[]
    optionInputs[0].value = 'Open'
    optionInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    optionInputs[1].value = '#409eff'
    optionInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
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
    const reopenedOptionInputs = Array.from(container.querySelectorAll('.meta-field-mgr__option-row .meta-field-mgr__input')) as HTMLInputElement[]
    expect(reopenedOptionInputs[0]?.value).toBe('')
    expect(reopenedOptionInputs[1]?.value).toBe('')

    app.unmount()
    container.remove()
  })

  it('re-hydrates latest field properties after closing and reopening the manager', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const fields = ref([
          { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 1, acceptedMimeTypes: ['image/png'] } },
        ])
        return {
          visible,
          fields,
          onClose: () => {
            visible.value = false
          },
          onUpdateField: updateSpy,
        }
      },
      render() {
        return h(MetaFieldManager, {
          visible: this.visible,
          sheetId: 'sheet_1',
          sheets: [],
          fields: this.fields,
          onClose: this.onClose,
          onUpdateField: this.onUpdateField,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

    const configInputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    configInputs[0].value = '4'
    configInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    configInputs[1].value = 'image/png,application/pdf'
    configInputs[1].dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;(container.querySelector('.meta-field-mgr__close') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.fields = [
      { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/jpeg'] } },
    ]
    vm.visible = true
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

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

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('clears new-field draft state after closing and reopening the manager', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        return {
          visible,
          onClose: () => {
            visible.value = false
          },
        }
      },
      render() {
        return h(MetaFieldManager, {
          visible: this.visible,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_2', name: 'Related' }],
          fields: [],
          onClose: this.onClose,
          onCreateField: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    nameInput.value = 'Owner'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'person'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    expect(container.querySelector('.meta-field-mgr__config')).not.toBeNull()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;(container.querySelector('.meta-field-mgr__close') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.visible = true
    await nextTick()

    const reopenedNameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    const reopenedTypeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    expect(reopenedNameInput.value).toBe('')
    expect(reopenedTypeSelect.value).toBe('string')
    expect(container.querySelector('.meta-field-mgr__config')).toBeNull()

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
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

    ;(container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null)?.click()
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
    container.remove()
  })

  it('reconciles latest field config while clean and reloads latest when draft becomes stale', async () => {
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

    ;(container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.fields = [
      { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/jpeg'] } },
    ]
    await nextTick()

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
    ;(container.querySelector('.meta-field-mgr__action') as HTMLButtonElement | null)?.click()
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
    container.remove()
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

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('asks before switching config target when current draft is dirty', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2 } },
            { id: 'fld_assets', name: 'Assets', type: 'attachment', property: { maxFiles: 5 } },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action'))
      .filter((button) => (button as HTMLButtonElement).title === 'Configure') as HTMLButtonElement[]
    configButtons[0]?.click()
    await nextTick()

    const maxFilesInput = container.querySelector('.meta-field-mgr__config .meta-field-mgr__input') as HTMLInputElement
    maxFilesInput.value = '4'
    maxFilesInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    configButtons[1]?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved field manager changes?')
    expect(container.textContent).toContain('Configure Files')
    expect(container.textContent).not.toContain('Configure Assets')

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('asks before switching rename target when current rename draft is dirty', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_notes', name: 'Notes', type: 'string' },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const renameButtons = Array.from(container.querySelectorAll('.meta-field-mgr__action'))
      .filter((button) => (button as HTMLButtonElement).title === 'Rename') as HTMLButtonElement[]
    renameButtons[0]?.click()
    await nextTick()

    const renameInput = container.querySelector('.meta-field-mgr__rename') as HTMLInputElement
    renameInput.value = 'Renamed Name'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    renameButtons[1]?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved field manager changes?')
    expect((container.querySelector('.meta-field-mgr__rename') as HTMLInputElement | null)?.value).toBe('Renamed Name')

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('closes config and clears stale warning when configured field disappears from props', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2 } },
          { id: 'fld_notes', name: 'Notes', type: 'string' },
        ])
        return { fields }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: this.fields,
          onClose: closeSpy,
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

    vm.fields = [{ id: 'fld_notes', name: 'Notes', type: 'string' }]
    await nextTick()

    expect(container.querySelector('.meta-field-mgr__config')).toBeNull()
    expect(container.querySelector('.meta-field-mgr__warning')).toBeNull()
    expect(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')).some((button) => button.textContent?.includes('Save field settings'))).toBe(false)
    expect(container.textContent).toContain('Notes')
    expect(container.textContent).not.toContain('Files')
    expect(container.querySelector('.meta-field-mgr__add-row')).not.toBeNull()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('tracks an upstream rename for the configured field without overwriting the new name', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_files', name: 'Files', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/png'] } },
          { id: 'fld_notes', name: 'Notes', type: 'string' },
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

    vm.fields = [
      { id: 'fld_files', name: 'Documents', type: 'attachment', property: { maxFiles: 2, acceptedMimeTypes: ['image/png'] } },
      { id: 'fld_notes', name: 'Notes', type: 'string' },
    ]
    await nextTick()

    expect(container.textContent).toContain('Configure Documents')
    expect(container.textContent).not.toContain('Configure Files')
    expect(container.querySelector('.meta-field-mgr__warning')).toBeNull()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('fld_files', {
      property: {
        maxFiles: 2,
        acceptedMimeTypes: ['image/png'],
      },
    })

    app.unmount()
    container.remove()
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
    expect(container.textContent).toContain('Configure Owner')
    expect(container.textContent).toContain('attachment')
    expect(container.querySelector('.meta-field-mgr__field')?.textContent).toContain('Max files')

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
    const reloadedSaveButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings')) as HTMLButtonElement
    expect(reloadedSaveButton.disabled).toBe(false)

    app.unmount()
    container.remove()
  })
})
