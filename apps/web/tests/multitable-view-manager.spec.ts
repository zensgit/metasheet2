import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'

describe('MetaViewManager', () => {
  it('emits persisted timeline config when saving view settings', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_timeline',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_owner', name: 'Owner', type: 'string' },
          ],
          views: [
            { id: 'view_timeline', sheetId: 'sheet_1', name: 'Roadmap', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', zoom: 'week' } },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButton = container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null
    configureButton?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    expect(selects).toHaveLength(4)
    selects[2].value = 'fld_owner'
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    selects[3].value = 'month'
    selects[3].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_owner',
        zoom: 'month',
      },
    })

    app.unmount()
    container.remove()
  })

  it('drops stale drafts after close and rehydrates from latest props on reopen', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const visible = ref(true)
        const views = ref([
          {
            id: 'view_timeline',
            sheetId: 'sheet_1',
            name: 'Roadmap',
            type: 'timeline',
            config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' },
          },
        ])
        return {
          visible,
          views,
          onClose: () => {
            visible.value = false
          },
          onUpdateView: updateSpy,
        }
      },
      render() {
        return h(MetaViewManager, {
          visible: this.visible,
          sheetId: 'sheet_1',
          activeViewId: 'view_timeline',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_owner', name: 'Owner', type: 'string' },
          ],
          views: this.views,
          onClose: this.onClose,
          onUpdateView: this.onUpdateView,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    const configureButton = container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null
    configureButton?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    selects[2].value = 'fld_owner'
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    selects[3].value = 'month'
    selects[3].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const closeButton = container.querySelector('.meta-view-mgr__close') as HTMLButtonElement | null
    closeButton?.click()
    await nextTick()

    vm.views = [
      {
        id: 'view_timeline',
        sheetId: 'sheet_1',
        name: 'Roadmap',
        type: 'timeline',
        config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'day' },
      },
    ]
    vm.visible = true
    await nextTick()

    const reopenedConfigureButton = container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null
    reopenedConfigureButton?.click()
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_name',
        zoom: 'day',
      },
    })

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('clears new-view draft state after closing and reopening the manager', async () => {
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
        return h(MetaViewManager, {
          visible: this.visible,
          sheetId: 'sheet_1',
          activeViewId: 'view_grid',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          views: [{ id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }],
          onClose: this.onClose,
          onCreateView: vi.fn(),
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    const nameInput = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__input') as HTMLInputElement
    const typeSelect = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__select') as HTMLSelectElement
    nameInput.value = 'Ops Gallery'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'gallery'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    ;(container.querySelector('.meta-view-mgr__close') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.visible = true
    await nextTick()

    const reopenedNameInput = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__input') as HTMLInputElement
    const reopenedTypeSelect = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__select') as HTMLSelectElement
    expect(reopenedNameInput.value).toBe('')
    expect(reopenedTypeSelect.value).toBe('grid')

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('drops stale field references when fields props change before save', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_start', name: 'Start', type: 'date' },
          { id: 'fld_end', name: 'End', type: 'date' },
          { id: 'fld_owner', name: 'Owner', type: 'string' },
        ])
        return {
          fields,
          onUpdateView: updateSpy,
        }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_timeline',
          fields: this.fields,
          views: [
            { id: 'view_timeline', sheetId: 'sheet_1', name: 'Roadmap', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_owner', zoom: 'week' } },
          ],
          onUpdateView: this.onUpdateView,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.fields = [
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_start', name: 'Start', type: 'date' },
      { id: 'fld_end', name: 'End', type: 'date' },
    ]
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: null,
        zoom: 'week',
      },
    })

    app.unmount()
    container.remove()
  })

  it('reconciles latest view config while clean and reloads latest when draft becomes stale', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_start', name: 'Start', type: 'date' },
          { id: 'fld_end', name: 'End', type: 'date' },
          { id: 'fld_owner', name: 'Owner', type: 'string' },
        ])
        const views = ref([
          { id: 'view_timeline', sheetId: 'sheet_1', name: 'Roadmap', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' } },
        ])
        return {
          fields,
          views,
          onUpdateView: updateSpy,
        }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_timeline',
          fields: this.fields,
          views: this.views,
          onUpdateView: this.onUpdateView,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.views = [
      { id: 'view_timeline', sheetId: 'sheet_1', name: 'Roadmap', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_owner', zoom: 'day' } },
    ]
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_owner',
        zoom: 'day',
      },
    })

    updateSpy.mockClear()
    ;(container.querySelector('.meta-view-mgr__action') as HTMLButtonElement | null)?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    selects[3].value = 'month'
    selects[3].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    vm.views = [
      { id: 'view_timeline', sheetId: 'sheet_1', name: 'Roadmap', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' } },
    ]
    await nextTick()

    expect(container.textContent).toContain('This view changed in the background')

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Reload latest'))
      ?.click()
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_name',
        zoom: 'week',
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
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_grid',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          views: [{ id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }],
          onClose: closeSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const nameInput = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__input') as HTMLInputElement
    nameInput.value = 'Unsaved View'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__close') as HTMLButtonElement | null)?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved view manager changes?')
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
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_files', name: 'Files', type: 'attachment' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
          ],
          views: [
            { id: 'view_gallery', sheetId: 'sheet_1', name: 'Gallery', type: 'gallery', config: { titleFieldId: 'fld_name', columns: 2 } },
            { id: 'view_timeline', sheetId: 'sheet_1', name: 'Timeline', type: 'timeline', config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' } },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configButtons = Array.from(container.querySelectorAll('.meta-view-mgr__action'))
      .filter((button) => (button as HTMLButtonElement).title === 'Configure') as HTMLButtonElement[]
    configButtons[0]?.click()
    await nextTick()

    const columnsInput = Array.from(container.querySelectorAll('.meta-view-mgr__config .meta-view-mgr__input'))
      .find((input) => (input as HTMLInputElement).type === 'number') as HTMLInputElement
    columnsInput.value = '4'
    columnsInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    configButtons[1]?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved view manager changes?')
    expect(container.textContent).toContain('Configure Gallery')
    expect(container.textContent).not.toContain('Configure Timeline')

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
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_grid',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          views: [
            { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
            { id: 'view_gallery', sheetId: 'sheet_1', name: 'Gallery', type: 'gallery' },
          ],
        })
      },
    })

    app.mount(container)
    await nextTick()

    const renameButtons = Array.from(container.querySelectorAll('.meta-view-mgr__action'))
      .filter((button) => (button as HTMLButtonElement).title === 'Rename') as HTMLButtonElement[]
    renameButtons[0]?.click()
    await nextTick()

    const renameInput = container.querySelector('.meta-view-mgr__rename') as HTMLInputElement
    renameInput.value = 'Primary Grid'
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    renameButtons[1]?.click()
    await nextTick()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved view manager changes?')
    expect((container.querySelector('.meta-view-mgr__rename') as HTMLInputElement | null)?.value).toBe('Primary Grid')

    confirmSpy.mockRestore()
    app.unmount()
    container.remove()
  })

  it('closes config and clears stale warning when configured view disappears from props', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const closeSpy = vi.fn()
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_files', name: 'Files', type: 'attachment' },
        ])
        const views = ref([
          { id: 'view_gallery', sheetId: 'sheet_1', name: 'Gallery', type: 'gallery', config: { titleFieldId: 'fld_name', coverFieldId: 'fld_files', columns: 2, cardSize: 'medium' } },
          { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
        ])
        return { fields, views }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onClose: closeSpy,
          onUpdateView: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const columnsInput = Array.from(container.querySelectorAll('.meta-view-mgr__config .meta-view-mgr__input'))
      .find((input) => (input as HTMLInputElement).type === 'number') as HTMLInputElement
    columnsInput.value = '4'
    columnsInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    vm.views = [{ id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }]
    await nextTick()

    expect(container.querySelector('.meta-view-mgr__config')).toBeNull()
    expect(container.querySelector('.meta-view-mgr__warning')).toBeNull()
    expect(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')).some((button) => button.textContent?.includes('Save view settings'))).toBe(false)
    expect(container.textContent).toContain('Grid')
    expect(container.textContent).not.toContain('Gallery')
    expect(container.querySelector('.meta-view-mgr__add-row')).not.toBeNull()
    expect(closeSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('tracks upstream field renames inside view config options without warning while clean', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_files', name: 'Files', type: 'attachment' },
        ])
        const views = ref([
          { id: 'view_gallery', sheetId: 'sheet_1', name: 'Gallery', type: 'gallery', config: { titleFieldId: 'fld_name', coverFieldId: 'fld_files', columns: 2, cardSize: 'medium' } },
        ])
        return { fields, views }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onUpdateView: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.fields = [
      { id: 'fld_name', name: 'Title', type: 'string' },
      { id: 'fld_files', name: 'Files', type: 'attachment' },
    ]
    await nextTick()

    const titleSelect = Array.from(container.querySelectorAll('.meta-view-mgr__config select'))[0] as HTMLSelectElement
    const titleOptions = Array.from(titleSelect.options).map((option) => option.textContent)
    expect(titleOptions).toContain('Title')
    expect(titleOptions).not.toContain('Name')
    expect(container.querySelector('.meta-view-mgr__warning')).toBeNull()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_gallery', {
      config: {
        titleFieldId: 'fld_name',
        coverFieldId: 'fld_files',
        fieldIds: [],
        columns: 2,
        cardSize: 'medium',
      },
    })

    app.unmount()
    container.remove()
  })

  it('blocks save until reload when a selected view field becomes invalid upstream', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const Harness = defineComponent({
      setup() {
        const fields = ref([
          { id: 'fld_name', name: 'Name', type: 'string' },
          { id: 'fld_files', name: 'Files', type: 'attachment' },
        ])
        const views = ref([
          { id: 'view_gallery', sheetId: 'sheet_1', name: 'Gallery', type: 'gallery', config: { titleFieldId: 'fld_name', coverFieldId: 'fld_files', columns: 2, cardSize: 'medium' } },
        ])
        return { fields, views }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onUpdateView: updateSpy,
        })
      },
    })

    const app = createApp(Harness)
    const vm = app.mount(container) as any
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const columnsInput = Array.from(container.querySelectorAll('.meta-view-mgr__config .meta-view-mgr__input'))
      .find((input) => (input as HTMLInputElement).type === 'number') as HTMLInputElement
    columnsInput.value = '4'
    columnsInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    vm.fields = [
      { id: 'fld_name', name: 'Name', type: 'string' },
      { id: 'fld_files', name: 'Files', type: 'string' },
    ]
    await nextTick()

    expect(container.textContent).toContain('A selected cover field is no longer an attachment field. Reload latest before saving.')
    const saveButton = (Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings')) as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
    saveButton.click()
    await nextTick()
    expect(updateSpy).not.toHaveBeenCalled()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Reload latest'))
      ?.click()
    await nextTick()

    const coverSelect = Array.from(container.querySelectorAll('.meta-view-mgr__config select'))[1] as HTMLSelectElement
    expect(coverSelect.value).toBe('')
    expect(container.querySelector('.meta-view-mgr__warning')).toBeNull()

    const reloadedSaveButton = (Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings')) as HTMLButtonElement
    expect(reloadedSaveButton.disabled).toBe(false)
    reloadedSaveButton.click()
    await nextTick()

    expect(updateSpy).toHaveBeenLastCalledWith('view_gallery', {
      config: {
        titleFieldId: 'fld_name',
        coverFieldId: null,
        fieldIds: [],
        columns: 2,
        cardSize: 'medium',
      },
    })

    app.unmount()
    container.remove()
  })
})
