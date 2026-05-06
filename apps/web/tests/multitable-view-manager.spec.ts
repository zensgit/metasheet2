import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'

describe('MetaViewManager', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

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
            {
              id: 'view_timeline',
              sheetId: 'sheet_1',
              name: 'Roadmap',
              type: 'timeline',
              config: { startFieldId: 'fld_start', endFieldId: 'fld_end', zoom: 'week' },
            },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    const configureButton = container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null
    configureButton?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    expect(selects.length).toBeGreaterThanOrEqual(4)
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
  })

  it('emits persisted Gantt dependency field config when saving view settings', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gantt',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_start', name: 'Start', type: 'date' },
            { id: 'fld_end', name: 'End', type: 'date' },
            { id: 'fld_deps', name: 'Depends on', type: 'link' },
            { id: 'fld_status', name: 'Status', type: 'select' },
          ],
          views: [
            {
              id: 'view_gantt',
              sheetId: 'sheet_1',
              name: 'Gantt',
              type: 'gantt',
              config: { startFieldId: 'fld_start', endFieldId: 'fld_end', titleFieldId: 'fld_name', zoom: 'week' },
            },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    expect(selects.map((select) => Array.from(select.options).map((option) => option.value))).toContainEqual(['', 'fld_name', 'fld_deps'])
    selects[5].value = 'fld_deps'
    selects[5].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('view_gantt', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        titleFieldId: 'fld_name',
        progressFieldId: null,
        groupFieldId: null,
        dependencyFieldId: 'fld_deps',
        zoom: 'week',
      },
    })

    app.unmount()
  })

  it('emits persisted hierarchy config when saving view settings', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_hierarchy',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_parent', name: 'Parent', type: 'link' },
            { id: 'fld_alt_parent', name: 'Alt Parent', type: 'link' },
          ],
          views: [
            {
              id: 'view_hierarchy',
              sheetId: 'sheet_1',
              name: 'Hierarchy',
              type: 'hierarchy',
              config: { parentFieldId: 'fld_parent', titleFieldId: 'fld_name', defaultExpandDepth: 1, orphanMode: 'root' },
            },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    selects[0].value = 'fld_alt_parent'
    selects[0].dispatchEvent(new Event('change', { bubbles: true }))
    selects[2].value = 'hidden'
    selects[2].dispatchEvent(new Event('change', { bubbles: true }))
    const depthInput = container.querySelector('.meta-view-mgr__config input[type="number"]') as HTMLInputElement
    depthInput.value = '3'
    depthInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('view_hierarchy', {
      config: {
        parentFieldId: 'fld_alt_parent',
        titleFieldId: 'fld_name',
        defaultExpandDepth: 3,
        orphanMode: 'hidden',
      },
    })

    app.unmount()
  })

  it('preserves conditional formatting rules when saving view settings', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()
    const rules = [
      {
        id: 'rule_overdue',
        order: 0,
        fieldId: 'fld_start',
        operator: 'is_overdue',
        style: { backgroundColor: '#fce4e4' },
        enabled: true,
      },
    ]

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
          ],
          views: [
            {
              id: 'view_timeline',
              sheetId: 'sheet_1',
              name: 'Roadmap',
              type: 'timeline',
              config: {
                startFieldId: 'fld_start',
                endFieldId: 'fld_end',
                zoom: 'week',
                conditionalFormattingRules: rules,
              },
            },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('view_timeline', {
      config: {
        startFieldId: 'fld_start',
        endFieldId: 'fld_end',
        labelFieldId: 'fld_name',
        zoom: 'week',
        conditionalFormattingRules: rules,
      },
    })

    app.unmount()
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
          {
            id: 'view_timeline',
            sheetId: 'sheet_1',
            name: 'Roadmap',
            type: 'timeline',
            config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' },
          },
        ])
        return { fields, views, onUpdateView: updateSpy }
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

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    vm.views = [
      {
        id: 'view_timeline',
        sheetId: 'sheet_1',
        name: 'Roadmap',
        type: 'timeline',
        config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_owner', zoom: 'day' },
      },
    ]
    await nextTick()

    expect(container.textContent).toContain('Latest view metadata loaded from the sheet context.')

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
    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    const selects = Array.from(container.querySelectorAll('.meta-view-mgr__config select')) as HTMLSelectElement[]
    selects[3].value = 'month'
    selects[3].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    vm.views = [
      {
        id: 'view_timeline',
        sheetId: 'sheet_1',
        name: 'Roadmap',
        type: 'timeline',
        config: { startFieldId: 'fld_start', endFieldId: 'fld_end', labelFieldId: 'fld_name', zoom: 'week' },
      },
    ]
    await nextTick()

    expect(container.textContent).toContain('This view changed in the background')
    expect(container.textContent).not.toContain('Latest view metadata loaded from the sheet context.')

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

    app.unmount()
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

    app.unmount()
  })

  it('emits dirty state while view manager drafts are unsaved', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const dirtySpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_grid',
          fields: [{ id: 'fld_name', name: 'Name', type: 'string' }],
          views: [{ id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' }],
          'onUpdate:dirty': dirtySpy,
        })
      },
    })

    app.mount(container)
    await nextTick()
    expect(dirtySpy).toHaveBeenLastCalledWith(false)

    const nameInput = container.querySelector('.meta-view-mgr__add-row .meta-view-mgr__input') as HTMLInputElement
    nameInput.value = 'Unsaved View'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    expect(dirtySpy).toHaveBeenLastCalledWith(true)

    app.unmount()
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

    app.unmount()
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
        return { fields, views, onClose: closeSpy, onUpdateView: updateSpy }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onClose: this.onClose,
          onUpdateView: this.onUpdateView,
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
    expect(closeSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()

    app.unmount()
  })

  it('tracks upstream field renames without warning while clean', async () => {
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
        return { fields, views, onUpdateView: updateSpy }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onUpdateView: this.onUpdateView,
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
    expect(container.textContent).toContain('Latest field metadata loaded from the sheet context.')

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Dismiss'))
      ?.click()
    await nextTick()

    expect(container.textContent).not.toContain('Latest field metadata loaded from the sheet context.')

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
        return { fields, views, onUpdateView: updateSpy }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onUpdateView: this.onUpdateView,
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
  })

  it('reloads latest field labels after a dirty gallery draft becomes stale', async () => {
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
        return { fields, views, onUpdateView: updateSpy }
      },
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_gallery',
          fields: this.fields,
          views: this.views,
          onUpdateView: this.onUpdateView,
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
      { id: 'fld_name', name: 'Title', type: 'string' },
      { id: 'fld_files', name: 'Files', type: 'string' },
    ]
    await nextTick()

    expect(container.textContent).toContain('A selected cover field is no longer an attachment field. Reload latest before saving.')

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Reload latest'))
      ?.click()
    await nextTick()

    const titleSelectAfterReload = Array.from(container.querySelectorAll('.meta-view-mgr__config select'))[0] as HTMLSelectElement
    const titleOptionsAfterReload = Array.from(titleSelectAfterReload.options).map((option) => option.textContent)
    const coverSelectAfterReload = Array.from(container.querySelectorAll('.meta-view-mgr__config select'))[1] as HTMLSelectElement

    expect(titleOptionsAfterReload).toContain('Title')
    expect(titleOptionsAfterReload).not.toContain('Name')
    expect(coverSelectAfterReload.value).toBe('')
    expect(container.querySelector('.meta-view-mgr__warning')).toBeNull()

    app.unmount()
  })

  it('emits visual filter sort and group settings from the shared builder', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const updateSpy = vi.fn()

    const app = createApp({
      render() {
        return h(MetaViewManager, {
          visible: true,
          sheetId: 'sheet_1',
          activeViewId: 'view_grid',
          fields: [
            { id: 'fld_name', name: 'Name', type: 'string' },
            { id: 'fld_status', name: 'Status', type: 'select' },
            { id: 'fld_due', name: 'Due', type: 'date' },
          ],
          views: [
            { id: 'view_grid', sheetId: 'sheet_1', name: 'Grid', type: 'grid' },
          ],
          onUpdateView: updateSpy,
        })
      },
    })

    app.mount(container)
    await nextTick()

    ;(container.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement | null)?.click()
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add filter'))
      ?.click()
    await nextTick()

    const filterRow = container.querySelector('.meta-view-mgr__rule-row--filter') as HTMLElement
    const filterSelects = Array.from(filterRow.querySelectorAll('select')) as HTMLSelectElement[]
    filterSelects[0].value = 'fld_status'
    filterSelects[0].dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    filterSelects[1].value = 'is'
    filterSelects[1].dispatchEvent(new Event('change', { bubbles: true }))
    const filterInput = filterRow.querySelector('input') as HTMLInputElement
    filterInput.value = 'Open'
    filterInput.dispatchEvent(new Event('change', { bubbles: true }))

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-inline')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('+ Add sort'))
      ?.click()
    await nextTick()

    const sortRow = Array.from(container.querySelectorAll('.meta-view-mgr__rule-row'))
      .find((row) => !row.classList.contains('meta-view-mgr__rule-row--filter')) as HTMLElement
    const sortSelects = Array.from(sortRow.querySelectorAll('select')) as HTMLSelectElement[]
    sortSelects[0].value = 'fld_due'
    sortSelects[0].dispatchEvent(new Event('change', { bubbles: true }))
    sortSelects[1].value = 'desc'
    sortSelects[1].dispatchEvent(new Event('change', { bubbles: true }))

    const groupSelects = Array.from(container.querySelectorAll('.meta-view-mgr__common > label select')) as HTMLSelectElement[]
    const groupSelect = groupSelects[groupSelects.length - 1]
    groupSelect.value = 'fld_status'
    groupSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()

    ;(Array.from(container.querySelectorAll('.meta-view-mgr__btn-add')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Save view settings'))
      ?.click()
    await nextTick()

    expect(updateSpy).toHaveBeenCalledWith('view_grid', {
      filterInfo: {
        conjunction: 'and',
        conditions: [{ fieldId: 'fld_status', operator: 'is', value: 'Open' }],
      },
      sortInfo: {
        rules: [{ fieldId: 'fld_due', desc: true }],
      },
      groupInfo: { fieldId: 'fld_status' },
    })

    app.unmount()
  })
})
