import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaFieldManager from '../src/multitable/components/MetaFieldManager.vue'
import { LOSSLESS_RETYPE, RETYPE_EXCLUDED_TARGET_TYPES, losslessRetypeTargets } from '../src/multitable/utils/field-retype'

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

  it('emits multiSelect field properties when creating a configured field', async () => {
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
    nameInput.value = 'Tags'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'multiSelect'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const optionInputs = Array.from(container.querySelectorAll('.meta-field-mgr__option-row .meta-field-mgr__input')) as HTMLInputElement[]
    optionInputs[0].value = 'Urgent'
    optionInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
    optionInputs[1].value = '#f56c6c'
    optionInputs[1].dispatchEvent(new Event('input', { bubbles: true }))

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await nextTick()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Tags',
      type: 'multiSelect',
      property: {
        options: [{ value: 'Urgent', color: '#f56c6c' }],
      },
    })

    app.unmount()
  })

  it('emits longText field creation without requiring an options panel', async () => {
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
    nameInput.value = 'Notes'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'longText'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add'))
      ?.click()
    await nextTick()

    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Notes',
      type: 'longText',
      property: {},
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

  it('renders the validation panel when configuring a text field', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string', property: {} },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    // The validation panel itself must render and expose its
    // text-field-specific rule rows (data-rule-type hooks are stable
    // markers on the panel template).
    expect(container.querySelector('.meta-field-mgr__validation')).not.toBeNull()
    expect(container.querySelector('[data-rule-toggle="required"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="minLength"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="pattern"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="min"]')).toBeNull()

    app.unmount()
  })

  it('renders the text validation panel for longText fields', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_notes', name: 'Notes', type: 'longText', property: {} },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    expect(container.querySelector('.meta-field-mgr__validation')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="minLength"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="pattern"]')).not.toBeNull()
    expect(container.querySelector('[data-rule-type="min"]')).toBeNull()

    app.unmount()
  })

  it('hydrates stored engine-shape validation rules into the panel when opening', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            {
              id: 'fld_bio',
              name: 'Bio',
              type: 'string',
              property: {
                validation: [
                  { type: 'required', message: 'Bio required' },
                  { type: 'maxLength', params: { value: 200 } },
                ],
              },
            },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const requiredToggle = container.querySelector('[data-rule-toggle="required"]') as HTMLInputElement
    expect(requiredToggle.checked).toBe(true)

    const maxLengthInput = container.querySelector('[data-rule-value="maxLength"]') as HTMLInputElement
    expect(maxLengthInput.value).toBe('200')

    app.unmount()
  })

  it('does not emit update-field when closing the validation panel without edits', async () => {
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
            { id: 'fld_name', name: 'Name', type: 'string', property: {} },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    // User opened the panel but didn't touch anything. Clicking save
    // must be a no-op — otherwise we would wipe `property` back to
    // `{}` on the server and clobber engine defaults like the
    // string `maxLength: 10000`.
    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  it('blocks adding a field whose name duplicates an existing one (case-insensitive)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [{ id: 'fld_status', name: 'Status', type: 'string', property: {} }],
          onCreateField: createSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'status'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const inlineError = container.querySelector('[data-test="add-conflict-error"]') as HTMLElement | null
    expect(inlineError).not.toBeNull()
    expect(inlineError?.textContent).toContain('already exists')
    expect(nameInput.getAttribute('aria-invalid')).toBe('true')

    const addButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add')) as HTMLButtonElement
    expect(addButton.disabled).toBe(true)
    addButton.click()
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(createSpy).not.toHaveBeenCalled()

    // Resolve the conflict by giving the new field a unique name.
    nameInput.value = 'Priority'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('[data-test="add-conflict-error"]')).toBeNull()
    expect(addButton.disabled).toBe(false)

    addButton.click()
    await nextTick()
    expect(createSpy).toHaveBeenCalledWith({
      sheetId: 'sheet_1',
      name: 'Priority',
      type: 'string',
    })

    app.unmount()
  })

  it('blocks renaming a field to an existing name and excludes the field itself', async () => {
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
            { id: 'fld_status', name: 'Status', type: 'string', property: {} },
            { id: 'fld_priority', name: 'Priority', type: 'string', property: {} },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    // Open rename for the second field (Priority).
    const renameButtons = Array.from(
      container.querySelectorAll('.meta-field-mgr__action[title="Rename"]'),
    ) as HTMLButtonElement[]
    renameButtons[1].click()
    await nextTick()

    const renameInput = container.querySelector('.meta-field-mgr__rename') as HTMLInputElement
    expect(renameInput.value).toBe('Priority')

    // Try to rename Priority → Status (conflicts with first field).
    renameInput.value = 'status'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const inlineError = container.querySelector('[data-test="rename-conflict-error"]') as HTMLElement | null
    expect(inlineError).not.toBeNull()
    expect(renameInput.getAttribute('aria-invalid')).toBe('true')

    const okButton = container.querySelector('.meta-field-mgr__action--ok') as HTMLButtonElement
    expect(okButton.disabled).toBe(true)
    renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(updateSpy).not.toHaveBeenCalled()

    // Editing the field's own current name (Priority) must NOT flag a conflict.
    renameInput.value = 'Priority'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('[data-test="rename-conflict-error"]')).toBeNull()

    // A unique name proceeds normally.
    renameInput.value = 'Urgency'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(container.querySelector('[data-test="rename-conflict-error"]')).toBeNull()

    const okButtonAfterFix = container.querySelector('.meta-field-mgr__action--ok') as HTMLButtonElement
    expect(okButtonAfterFix.disabled).toBe(false)
    okButtonAfterFix.click()
    await nextTick()
    expect(updateSpy).toHaveBeenCalledWith('fld_priority', { name: 'Urgency' })

    app.unmount()
  })

  it('does not flag the add-row when the input is empty or whitespace', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [{ id: 'fld_status', name: 'Status', type: 'string', property: {} }],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = '   '
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(container.querySelector('[data-test="add-conflict-error"]')).toBeNull()
    expect(nameInput.getAttribute('aria-invalid')).not.toBe('true')

    app.unmount()
  })

  it('emits engine-shape validation rules in the property payload on save', async () => {
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
            { id: 'fld_name', name: 'Name', type: 'string', property: {} },
          ],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    // Flip required on, set minLength to 3.
    const requiredToggle = container.querySelector('[data-rule-toggle="required"]') as HTMLInputElement
    requiredToggle.checked = true
    requiredToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const minLengthInput = container.querySelector('[data-rule-value="minLength"]') as HTMLInputElement
    minLengthInput.value = '3'
    minLengthInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    const [emittedFieldId, emittedPayload] = updateSpy.mock.calls[0]
    expect(emittedFieldId).toBe('fld_name')
    expect(emittedPayload.property).toMatchObject({
      validation: [
        { type: 'required' },
        { type: 'minLength', params: { value: 3 } },
      ],
    })

    app.unmount()
  })

  it('locks single-record link mode when the field is used as a hierarchy parent', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_2', name: 'Related' }],
          fields: [
            {
              id: 'fld_parent',
              name: 'Parent',
              type: 'link',
              property: { foreignSheetId: 'sheet_2', limitSingleRecord: true },
            },
          ],
          hierarchyParentFieldIds: ['fld_parent'],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const singleToggle = container.querySelector('[data-test="link-single-record-toggle"]') as HTMLInputElement
    expect(singleToggle.disabled).toBe(true)
    expect(singleToggle.checked).toBe(true)
    expect(container.querySelector('[data-test="hierarchy-parent-link-lock"]')?.textContent).toContain('hierarchy parent')

    // Even a synthetic event cannot downgrade the emitted property.
    singleToggle.checked = false
    singleToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_parent', {
      property: {
        foreignSheetId: 'sheet_2',
        foreignDatasheetId: 'sheet_2',
        limitSingleRecord: true,
      },
    })

    app.unmount()
  })

  it('locks single-record person link mode when the user field is used as a hierarchy parent', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_1', name: 'Current' }],
          fields: [
            {
              id: 'fld_user_parent',
              name: 'Owner',
              type: 'link',
              property: { refKind: 'user', limitSingleRecord: true },
            },
          ],
          hierarchyParentFieldIds: ['fld_user_parent'],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const singleToggle = container.querySelector('[data-test="person-single-record-toggle"]') as HTMLInputElement
    expect(singleToggle.disabled).toBe(true)
    expect(singleToggle.checked).toBe(true)
    expect(container.querySelector('[data-test="hierarchy-parent-link-lock"]')?.textContent).toContain('hierarchy parent')

    // Even a synthetic event cannot downgrade the emitted person/user link property.
    singleToggle.checked = false
    singleToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_user_parent', {
      property: {
        limitSingleRecord: true,
      },
    })

    app.unmount()
  })

  it('still allows unrelated link fields to switch to multi-record mode', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [{ id: 'sheet_2', name: 'Related' }],
          fields: [
            {
              id: 'fld_vendor',
              name: 'Vendor',
              type: 'link',
              property: { foreignSheetId: 'sheet_2', limitSingleRecord: true },
            },
          ],
          hierarchyParentFieldIds: ['fld_parent'],
          onUpdateField: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const singleToggle = container.querySelector('[data-test="link-single-record-toggle"]') as HTMLInputElement
    expect(singleToggle.disabled).toBe(false)
    singleToggle.checked = false
    singleToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('fld_vendor', {
      property: {
        foreignSheetId: 'sheet_2',
        foreignDatasheetId: 'sheet_2',
        limitSingleRecord: false,
      },
    })

    app.unmount()
  })
})

describe('MetaFieldManager — foreign-field picker (3c)', () => {
  const foreignFields = [
    { id: 'fld_status', name: 'Status', type: 'select', property: {} },
    { id: 'fld_amount', name: 'Amount', type: 'number', property: {} },
  ]
  // Rollup field FIRST so the first .meta-field-mgr__action[title="Configure"] opens ITS config; the link
  // field is present so linkFieldForeignSheetId resolves the foreign sheet from property.foreignSheetId.
  function rollupProps(extra: Record<string, unknown> = {}) {
    return {
      visible: true,
      sheetId: 'sheet_1',
      sheets: [],
      fields: [
        { id: 'fld_rollup', name: 'Roll', type: 'rollup', property: { linkFieldId: 'fld_link', targetFieldId: 'fld_status', aggregation: 'concatenate' } },
        { id: 'fld_link', name: 'Link', type: 'link', property: { foreignSheetId: 'sheet_foreign' } },
      ],
      ...extra,
    }
  }
  async function settle() { await nextTick(); await new Promise((r) => setTimeout(r)); await nextTick() }

  it('renders the rollup target as a PICKER populated from listForeignFieldsFn (resolved foreign sheet)', async () => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const listForeignFieldsFn = vi.fn(async () => foreignFields)
    const app = createApp({ render() { return h(MetaFieldManager, rollupProps({ listForeignFieldsFn })) } })
    app.mount(container); await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await settle()
    expect(listForeignFieldsFn).toHaveBeenCalledWith('sheet_foreign')
    const optionText = (Array.from(container.querySelectorAll('.meta-field-mgr__config select')) as HTMLSelectElement[])
      .flatMap((s) => Array.from(s.options).map((o) => o.textContent))
    expect(optionText).toContain('Status')
    expect(optionText).toContain('Amount')
    app.unmount(); container.remove()
  })

  it('falls back to a typed-id input when no listForeignFieldsFn is wired', async () => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const app = createApp({ render() { return h(MetaFieldManager, rollupProps()) } })
    app.mount(container); await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await settle()
    const inputs = Array.from(container.querySelectorAll('.meta-field-mgr__config .meta-field-mgr__input')) as HTMLInputElement[]
    expect(inputs.some((i) => i.getAttribute('placeholder') === 'fld_target')).toBe(true)
    app.unmount(); container.remove()
  })
})

// Layer-2 visibility keys are CARRIED OPAQUELY through a field-config Save.
//
// `update-field` REPLACES `property` wholesale, and `currentDraftProperty` rebuilds it as a closed literal
// for several types (the person branch is literally `{ limitSingleRecord }`). So without an explicit carry,
// any unrelated Save — flip person single/multi, rename a button, edit a validation rule — silently DROPPED
// a stored `hidden: true` and UN-HID the field for everyone. This is the same hazard the component already
// guards for `actionConfig` ("the form doesn't edit it, so re-emit it intact").
//
// The form has no hide/un-hide control anywhere (the FE has no writer of these keys at all — only the
// reader in utils/field-permissions.ts), so re-emitting them cannot block an un-hide.
describe('MetaFieldManager — layer-2 visibility keys survive a config Save', () => {
  function saveConfigFor(field: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: [field], onUpdateField: updateSpy,
        })
      },
    })
    app.mount(container)
    return { container, updateSpy, app }
  }

  async function openAndSave(container: HTMLElement) {
    await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()
    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings'))
      ?.click()
    await nextTick()
  }

  it('a HIDDEN person field stays hidden after an unrelated config Save', async () => {
    const { container, updateSpy, app } = saveConfigFor({
      id: 'fld_p', name: 'People', type: 'person', property: { hidden: true, limitSingleRecord: true },
    })
    try {
      await openAndSave(container)
      expect(updateSpy).toHaveBeenCalled()
      const [, payload] = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]
      // the hide SURVIVES the wholesale property replacement…
      expect(payload.property.hidden).toBe(true)
      // …alongside the type-specific key the form actually edits
      expect(payload.property.limitSingleRecord).toBe(true)
    } finally { app.unmount(); container.remove() }
  })

  it('`visible: false` (the other half of the predicate) survives too', async () => {
    const { container, updateSpy, app } = saveConfigFor({
      id: 'fld_p2', name: 'People', type: 'person', property: { visible: false },
    })
    try {
      await openAndSave(container)
      const [, payload] = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]
      expect(payload.property.visible).toBe(false)
    } finally { app.unmount(); container.remove() }
  })

  it('NON-VACUOUS: a field with no visibility keys does not gain them', async () => {
    const { container, updateSpy, app } = saveConfigFor({
      id: 'fld_p3', name: 'People', type: 'person', property: { limitSingleRecord: false },
    })
    try {
      await openAndSave(container)
      const [, payload] = updateSpy.mock.calls[updateSpy.mock.calls.length - 1]
      expect(payload.property.hidden).toBeUndefined()
      expect(payload.property.visible).toBeUndefined()
    } finally { app.unmount(); container.remove() }
  })
})

// ---------------------------------------------------------------------------
// #3 — the '+ Add' button's disabled predicate has TWO legs
// (`!newFieldName.trim() || addNameConflict`) and only the duplicate leg ever had a
// visible reason. These pin the empty-name leg: a quiet inline hint + a button title,
// wired to aria-describedby exactly like the duplicate leg.
// ---------------------------------------------------------------------------
describe('MetaFieldManager — empty-name add hint', () => {
  function mountManager(fields: Record<string, unknown>[] = []) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render() {
        return h(MetaFieldManager, { visible: true, sheetId: 'sheet_1', sheets: [], fields })
      },
    })
    app.mount(container)
    return { container, app }
  }

  it('shows a quiet hint + button title while the name is empty, and drops both once typed', async () => {
    const { container, app } = mountManager()
    try {
      await nextTick()
      const hint = container.querySelector('[data-test="add-name-required-hint"]') as HTMLElement | null
      expect(hint).not.toBeNull()
      expect(hint!.textContent).toContain('Enter a field name to add')
      // quiet: muted inline line, NOT the boxed __hint info block, and not an alert
      expect(hint!.className).toContain('meta-field-mgr__inline-hint')
      expect(hint!.className).not.toContain('meta-field-mgr__hint ')
      expect(hint!.getAttribute('role')).toBeNull()

      const button = container.querySelector('[data-test="add-field-submit"]') as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('title')).toBe('Enter a field name to add')

      const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
      expect(nameInput.getAttribute('aria-describedby')).toBe('meta-field-mgr-add-name-required')
      expect(hint!.id).toBe('meta-field-mgr-add-name-required')

      nameInput.value = 'Amount'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()

      expect(container.querySelector('[data-test="add-name-required-hint"]')).toBeNull()
      expect(button.disabled).toBe(false)
      expect(button.getAttribute('title')).toBeNull()
      expect(nameInput.getAttribute('aria-describedby')).toBeNull()
    } finally { app.unmount(); container.remove() }
  })

  it('a whitespace-only name still counts as empty (same predicate as :disabled)', async () => {
    const { container, app } = mountManager()
    try {
      await nextTick()
      const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
      nameInput.value = '   '
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      expect(container.querySelector('[data-test="add-name-required-hint"]')).not.toBeNull()
      expect((container.querySelector('[data-test="add-field-submit"]') as HTMLButtonElement).disabled).toBe(true)
    } finally { app.unmount(); container.remove() }
  })

  it('the duplicate leg keeps ITS own message (hint is empty-name only)', async () => {
    const { container, app } = mountManager([{ id: 'fld_a', name: 'Status', type: 'string', property: {} }])
    try {
      await nextTick()
      const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
      nameInput.value = 'status'
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      expect(container.querySelector('[data-test="add-name-required-hint"]')).toBeNull()
      expect(container.querySelector('[data-test="add-conflict-error"]')).not.toBeNull()
      const button = container.querySelector('[data-test="add-field-submit"]') as HTMLButtonElement
      expect(button.getAttribute('title')).toBe('A field named "status" already exists')
      expect(nameInput.getAttribute('aria-describedby')).toBe('meta-field-mgr-add-error')
    } finally { app.unmount(); container.remove() }
  })
})

// ---------------------------------------------------------------------------
// #6 — select/multiSelect option colours were a bare hex text box whose placeholder
// (#409eff) looked identical to a set value. Palette swatches + native picker +
// auto-assigned colour for new options. The hand-typed hex box STAYS (last input).
// ---------------------------------------------------------------------------
describe('MetaFieldManager — select option colour palette', () => {
  async function openNewSelectField() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const createSpy = vi.fn()
    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: [], onCreateField: createSpy,
        })
      },
    })
    app.mount(container)
    await nextTick()
    const nameInput = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__input') as HTMLInputElement
    nameInput.value = 'Status'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    const typeSelect = container.querySelector('.meta-field-mgr__add-row .meta-field-mgr__select') as HTMLSelectElement
    typeSelect.value = 'select'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    return { container, app, createSpy }
  }

  const hexBoxes = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.meta-field-mgr__option-row--select')).map(
      (row) => (Array.from(row.querySelectorAll('.meta-field-mgr__input')) as HTMLInputElement[])[1],
    )

  it('clicking a preset swatch writes that hex into the option colour', async () => {
    const { container, app, createSpy } = await openNewSelectField()
    try {
      const swatch = container.querySelector('[data-test="option-swatch-0-#67c23a"]') as HTMLButtonElement
      expect(swatch).not.toBeNull()
      swatch.click()
      await nextTick()

      expect(hexBoxes(container)[0].value).toBe('#67c23a')
      expect(swatch.className).toContain('meta-field-mgr__swatch--active')
      // and it round-trips into the emitted property
      const valueInput = container.querySelector('.meta-field-mgr__option-row--select .meta-field-mgr__input') as HTMLInputElement
      valueInput.value = 'Open'
      valueInput.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      ;(container.querySelector('[data-test="add-field-submit"]') as HTMLButtonElement).click()
      await nextTick()
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
        property: { options: [{ value: 'Open', color: '#67c23a' }] },
      }))
    } finally { app.unmount(); container.remove() }
  })

  it('a newly added option gets an auto colour distinct from the previous row', async () => {
    const { container, app } = await openNewSelectField()
    try {
      const addOption = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-inline')) as HTMLButtonElement[])
        .find((b) => b.textContent?.includes('Add option')) as HTMLButtonElement
      addOption.click()
      await nextTick()
      addOption.click()
      await nextTick()

      const colors = hexBoxes(container).map((input) => input.value)
      expect(colors).toHaveLength(3)
      // row 0 is the pre-existing seeded option — untouched (still blank)
      expect(colors[0]).toBe('')
      expect(colors[1]).not.toBe('')
      expect(colors[2]).not.toBe('')
      expect(colors[2]).not.toBe(colors[1])
    } finally { app.unmount(); container.remove() }
  })

  it('a 3-digit hex is expanded for the native colour input (which rejects #rgb)', async () => {
    const { container, app } = await openNewSelectField()
    try {
      const hexBox = hexBoxes(container)[0]
      hexBox.value = '#0AF'
      hexBox.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()

      const picker = container.querySelector('[data-test="option-color-picker-0"]') as HTMLInputElement
      expect(picker.getAttribute('value')).toBe('#00aaff')
      // the preview is no longer in the "unset" state
      const preview = container.querySelector('[data-test="option-color-preview-0"]') as HTMLElement
      expect(preview.className).not.toContain('meta-field-mgr__color-preview--empty')
    } finally { app.unmount(); container.remove() }
  })

  it('an unset colour is visually distinct (empty preview + picker falls back)', async () => {
    const { container, app } = await openNewSelectField()
    try {
      const preview = container.querySelector('[data-test="option-color-preview-0"]') as HTMLElement
      expect(preview.className).toContain('meta-field-mgr__color-preview--empty')
      const picker = container.querySelector('[data-test="option-color-picker-0"]') as HTMLInputElement
      expect(picker.getAttribute('value')).toBe('#409eff')
      expect(hexBoxes(container)[0].value).toBe('')
    } finally { app.unmount(); container.remove() }
  })
})

// ---------------------------------------------------------------------------
// #9 — the edit panel's type was a read-only <span>; the backend PATCH has accepted
// `type` all along. FE now opens ONLY the lossless directions (utils/field-retype.ts),
// behind an explicit confirm. Background drift still blocks (see the older spec above).
// ---------------------------------------------------------------------------
describe('MetaFieldManager — lossless retype in the edit panel', () => {
  function mountWithField(field: Record<string, unknown>) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: [field], onUpdateField: updateSpy,
        })
      },
    })
    app.mount(container)
    return { container, app, updateSpy }
  }

  async function openConfig(container: HTMLElement) {
    await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()
  }

  function clickSave(container: HTMLElement) {
    ;(Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings'))
      ?.click()
  }

  it('a number field offers exactly [number, text] — no link/formula/computed targets', async () => {
    const { container, app } = mountWithField({ id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2 } })
    try {
      await openConfig(container)
      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      expect(select).not.toBeNull()
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['number', 'string'])
      expect(select.value).toBe('number')
    } finally { app.unmount(); container.remove() }
  })

  it('a link field keeps the read-only type label (no dropdown at all)', async () => {
    const { container, app } = mountWithField({
      id: 'fld_link', name: 'Owner', type: 'link', property: { foreignSheetId: 'sheet_2' },
    })
    try {
      await openConfig(container)
      expect(container.querySelector('[data-test="config-type-select"]')).toBeNull()
    } finally { app.unmount(); container.remove() }
  })

  it('picking text and confirming emits update-field with type:string', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, app, updateSpy } = mountWithField({
      id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2, hidden: true },
    })
    try {
      await openConfig(container)
      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      select.value = 'string'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()

      // the consequence is stated BEFORE the save, not only in the confirm
      const notice = container.querySelector('[data-test="retype-notice"]') as HTMLElement
      expect(notice.textContent).toContain('Changing to text clears the current format settings')
      // a user retype must NOT be reported as background drift
      expect(container.textContent).not.toContain('Reload latest before saving')

      clickSave(container)
      await nextTick()

      expect(confirmSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).toHaveBeenCalledTimes(1)
      const [fieldId, payload] = updateSpy.mock.calls[0]
      expect(fieldId).toBe('fld_qty')
      expect(payload.type).toBe('string')
      // the layer-2 visibility carry still applies on the retype path
      expect(payload.property.hidden).toBe(true)
      // the number-only formatting is NOT re-sent under the new type
      expect(payload.property.decimals).toBeUndefined()
    } finally { app.unmount(); container.remove() }
  })

  it('declining the confirm emits nothing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container, app, updateSpy } = mountWithField({ id: 'fld_qty', name: 'Qty', type: 'number', property: {} })
    try {
      await openConfig(container)
      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      select.value = 'string'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      clickSave(container)
      await nextTick()
      expect(confirmSpy).toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
    } finally { app.unmount(); container.remove() }
  })

  it('a plain settings save on a retypeable field still carries NO type key', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, app, updateSpy } = mountWithField({
      id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2 },
    })
    try {
      await openConfig(container)
      clickSave(container)
      await nextTick()
      expect(confirmSpy).not.toHaveBeenCalled()
      const [, payload] = updateSpy.mock.calls[0]
      expect('type' in payload).toBe(false)
    } finally { app.unmount(); container.remove() }
  })

  it('text -> long text survives the string/longText no-op skip', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container, app, updateSpy } = mountWithField({ id: 'fld_note', name: 'Note', type: 'string', property: {} })
    try {
      await openConfig(container)
      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['string', 'longText'])
      select.value = 'longText'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      clickSave(container)
      await nextTick()
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy.mock.calls[0][1].type).toBe('longText')
    } finally { app.unmount(); container.remove() }
  })
})

// The split between "the user picked a new type" and "the stored type moved" is what
// keeps a retype savable: ANY upstream field change while the panel is dirty flips
// fieldConfigOutdated, and the old single `fieldConfigSchemaChanged` predicate would
// then read the user's own pick as background drift and block the save forever
// (with a "Reload latest" that discards the pick).
describe('MetaFieldManager — user retype vs background drift', () => {
  it('an unrelated upstream field change does not turn the user retype into a block', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2 } },
          { id: 'fld_note', name: 'Note', type: 'string', property: {} },
        ])
        return { fields }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: this.fields, onUpdateField: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement).click()
    await nextTick()

    const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
    select.value = 'string'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    // someone renames a DIFFERENT field upstream -> the source signature changes
    vm.fields = [
      { id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2 } },
      { id: 'fld_note', name: 'Notes', type: 'string', property: {} },
    ]
    await nextTick()

    expect(container.textContent).not.toContain('Reload latest before saving')
    const saveButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings')) as HTMLButtonElement
    expect(saveButton.disabled).toBe(false)
    saveButton.click()
    await nextTick()
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][1].type).toBe('string')

    app.unmount()
    container.remove()
  })

  it('the STORED type moving still blocks, even while the user has a retype pending', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([{ id: 'fld_qty', name: 'Qty', type: 'number', property: { decimals: 2 } }])
        return { fields }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: this.fields, onUpdateField: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()
    ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement).click()
    await nextTick()

    const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
    select.value = 'string'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    // …and meanwhile the field itself is re-typed in the background
    vm.fields = [{ id: 'fld_qty', name: 'Qty', type: 'rating', property: { max: 5 } }]
    await nextTick()

    expect(container.textContent).toContain('This field changed type in the background. Reload latest before saving.')
    const saveButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
      .find((b) => b.textContent?.includes('Save field settings')) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    saveButton.click()
    await nextTick()
    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })
})

// ---------------------------------------------------------------------------
// The string -> longText direction is the one retype the draft serializer CANNOT
// see: serializeFieldDraft returns the identical {validation, aiShortcut} bytes for
// both types (MetaFieldManager.vue:1924), so before `userRetypeRequested` was wired
// into `fieldConfigDirty` the 1.2s metadata poll re-hydrated the panel on any
// upstream change and reset the dropdown to `string` — after which Save took the
// string/longText no-op skip and closed the dialog with nothing emitted.
// ---------------------------------------------------------------------------
describe('MetaFieldManager — retype survives the background metadata refresh', () => {
  it('string -> longText is kept when an unrelated field is renamed upstream', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_note', name: 'Note', type: 'string', property: {} },
          { id: 'fld_owner', name: 'Owner', type: 'string', property: {} },
        ])
        return { fields }
      },
      render() {
        return h(MetaFieldManager, {
          visible: true, sheetId: 'sheet_1', sheets: [], fields: this.fields, onUpdateField: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    try {
      await nextTick()
      ;(container.querySelector('.meta-field-mgr__action[title="Configure"]') as HTMLButtonElement).click()
      await nextTick()

      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      select.value = 'longText'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()

      // the workbench poll delivers a fresh props.fields where a DIFFERENT field was renamed
      vm.fields = [
        { id: 'fld_note', name: 'Note', type: 'string', property: {} },
        { id: 'fld_owner', name: 'Owners', type: 'string', property: {} },
      ]
      await nextTick()

      // the pick survives, and the panel says "outdated" rather than silently reloading
      const selectAfter = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      expect(selectAfter.value).toBe('longText')
      expect(container.textContent).not.toContain('Latest field metadata loaded')
      // …and it is still savable (only a STORED type move blocks)
      expect(container.textContent).not.toContain('Reload latest before saving')

      const saveButton = (Array.from(container.querySelectorAll('.meta-field-mgr__btn-add')) as HTMLButtonElement[])
        .find((b) => b.textContent?.includes('Save field settings')) as HTMLButtonElement
      expect(saveButton.disabled).toBe(false)
      saveButton.click()
      await nextTick()

      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(updateSpy.mock.calls[0][1].type).toBe('longText')
    } finally { app.unmount(); container.remove() }
  })

  it('a pending retype counts as an unsaved draft (dirty + discard confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dirtySpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaFieldManager, {
          visible: true,
          sheetId: 'sheet_1',
          sheets: [],
          fields: [
            { id: 'fld_note', name: 'Note', type: 'string', property: {} },
            { id: 'fld_owner', name: 'Owner', type: 'string', property: {} },
          ],
          'onUpdate:dirty': dirtySpy,
        })
      },
    })
    app.mount(container)
    try {
      await nextTick()
      const configureButtons = Array.from(
        container.querySelectorAll('.meta-field-mgr__action[title="Configure"]'),
      ) as HTMLButtonElement[]
      configureButtons[0].click()
      await nextTick()

      const select = container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement
      select.value = 'longText'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()

      expect(dirtySpy).toHaveBeenCalledWith(true)

      // switching to another field asks first, and the declined switch keeps the pick
      configureButtons[1].click()
      await nextTick()
      expect(confirmSpy).toHaveBeenCalled()
      expect((container.querySelector('[data-test="config-type-select"]') as HTMLSelectElement).value)
        .toBe('longText')
    } finally { app.unmount(); container.remove() }
  })
})

// ---------------------------------------------------------------------------
// Whole-table golden for the retype whitelist. The per-type assertions above only
// prove the rows they name, so a careless ADD to LOSSLESS_RETYPE (multiSelect, date,
// longText -> string …) used to land with every test still green. The table IS the
// safety boundary — the backend PATCH does a raw UPDATE with no value migration — so
// widening it must require editing this golden.
// ---------------------------------------------------------------------------
describe('LOSSLESS_RETYPE table shape', () => {
  it('contains exactly the owner-approved source rows and targets', () => {
    expect(LOSSLESS_RETYPE).toEqual({
      number: ['string'],
      currency: ['number', 'string'],
      percent: ['number', 'string'],
      rating: ['number', 'string'],
      select: ['string'],
      url: ['string'],
      email: ['string'],
      phone: ['string'],
      barcode: ['string'],
      string: ['longText'],
    })
    expect(Object.keys(LOSSLESS_RETYPE).sort()).toEqual([
      'barcode', 'currency', 'email', 'number', 'percent', 'phone', 'rating', 'select', 'string', 'url',
    ])
    // every offered target is itself a plain scalar the raw UPDATE keeps readable
    const targets = new Set(Object.values(LOSSLESS_RETYPE).flat())
    expect(Array.from(targets).sort()).toEqual(['longText', 'number', 'string'])
  })

  it('offers nothing for the directions the module documents as excluded', () => {
    // array <-> scalar, rich-HTML exposure, display-semantics changes
    expect(losslessRetypeTargets('multiSelect')).toEqual([])
    expect(losslessRetypeTargets('date')).toEqual([])
    expect(losslessRetypeTargets('dateTime')).toEqual([])
    expect(losslessRetypeTargets('longText')).toEqual([])
    // computed / structural types are never a source either
    for (const excluded of RETYPE_EXCLUDED_TARGET_TYPES) {
      expect(losslessRetypeTargets(excluded)).toEqual([])
    }
    expect(losslessRetypeTargets(null)).toEqual([])
    expect(losslessRetypeTargets('nope')).toEqual([])
  })

  it('never surfaces a backend-excluded type as a target, even if the table says so', () => {
    for (const [source, declared] of Object.entries(LOSSLESS_RETYPE)) {
      for (const target of declared) {
        expect(RETYPE_EXCLUDED_TARGET_TYPES.has(target)).toBe(false)
      }
      expect(losslessRetypeTargets(source)).not.toContain(source)
    }
  })
})
