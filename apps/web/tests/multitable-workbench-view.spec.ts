import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, reactive, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
}))

vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => ({
    canRead: ref(true),
    canCreateRecord: ref(true),
    canEditRecord: ref(true),
    canDeleteRecord: ref(true),
    canManageFields: ref(true),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: vi.fn(),
    addComment: vi.fn(),
    resolveComment: vi.fn(),
  }),
}))

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: vi.fn(),
}))

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({
  default: defineComponent({
    name: 'MetaViewTabBar',
    emits: ['create-sheet', 'select-sheet', 'select-view'],
    render() {
      return h('div', [
        h(
          'button',
          {
            'data-create-sheet': 'true',
            onClick: () => this.$emit('create-sheet', 'Sheet 2'),
          },
          'create-sheet',
        ),
        h(
          'button',
          {
            'data-select-sheet': 'sheet_sales',
            onClick: () => this.$emit('select-sheet', 'sheet_sales'),
          },
          'select-sheet',
        ),
        h(
          'button',
          {
            'data-select-view': 'view_gallery',
            onClick: () => this.$emit('select-view', 'view_gallery'),
          },
          'select-view',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({
  default: defineComponent({
    name: 'MetaToolbar',
    emits: ['import'],
    render() {
      return h(
        'button',
        {
          'data-open-import': 'true',
          onClick: () => this.$emit('import'),
        },
        'open-import',
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    emits: ['select-record'],
    render() {
      return h('div', [
        h(
          'button',
          {
            'data-select-record': 'rec_1',
            onClick: () => this.$emit('select-record', 'rec_1'),
          },
          'select-record-1',
        ),
        h(
          'button',
          {
            'data-select-record': 'rec_2',
            onClick: () => this.$emit('select-record', 'rec_2'),
          },
          'select-record-2',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({
  default: defineComponent({
    name: 'MetaFormView',
    emits: ['update:dirty'],
    render() {
      return h('div', [
        h(
          'button',
          {
            'data-form-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'form-dirty',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaRecordDrawer',
    props: {
      visible: { type: Boolean, default: false },
      record: { type: Object, default: null },
    },
    emits: ['close', 'toggle-comments', 'navigate'],
    render() {
      if (!this.$props.visible) return null
      const recordId = (this.$props.record as { id?: string } | null)?.id ?? ''
      return h('div', { 'data-record-drawer': recordId }, [
        h(
          'button',
          {
            'data-close-drawer': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-drawer',
        ),
        h(
          'button',
          {
            'data-toggle-comments': 'true',
            onClick: () => this.$emit('toggle-comments'),
          },
          'toggle-comments',
        ),
        h(
          'button',
          {
            'data-navigate-record': 'rec_2',
            onClick: () => this.$emit('navigate', 'rec_2'),
          },
          'navigate-record',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaCommentsDrawer',
    props: {
      visible: { type: Boolean, default: false },
    },
    emits: ['close', 'update:draft'],
    render() {
      if (!this.$props.visible) return null
      return h('div', [
        h(
          'button',
          {
            'data-set-comment-draft': 'true',
            onClick: () => this.$emit('update:draft', 'Need review'),
          },
          'set-comment-draft',
        ),
        h(
          'button',
          {
            'data-close-comments': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-comments',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({
  default: defineComponent({
    name: 'MetaFieldManager',
    emits: ['create-field', 'update:dirty'],
    render() {
      return h(
        'div',
        [
          h(
            'button',
            {
              'data-create-person-field': 'true',
              onClick: () => this.$emit('create-field', { sheetId: 'sheet_orders', name: 'Owner', type: 'person' }),
            },
            'create-person-field',
          ),
          h(
            'button',
            {
              'data-create-person-field-multi': 'true',
              onClick: () => this.$emit('create-field', {
                sheetId: 'sheet_orders',
                name: 'Approvers',
                type: 'person',
                property: { limitSingleRecord: false },
              }),
            },
            'create-person-field-multi',
          ),
          h(
            'button',
            {
              'data-field-manager-dirty': 'true',
              onClick: () => this.$emit('update:dirty', true),
            },
            'field-manager-dirty',
          ),
          h(
            'button',
            {
              'data-field-manager-clean': 'true',
              onClick: () => this.$emit('update:dirty', false),
            },
            'field-manager-clean',
          ),
        ],
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({
  default: defineComponent({
    name: 'MetaViewManager',
    props: {
      visible: { type: Boolean, default: false },
    },
    emits: ['close', 'update:dirty'],
    render() {
      if (!this.$props.visible) return null
      return h('div', { 'data-view-manager': 'true' }, [
        h(
          'button',
          {
            'data-view-manager-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'view-manager-dirty',
        ),
        h(
          'button',
          {
            'data-close-view-manager': 'true',
            onClick: () => this.$emit('close'),
          },
          'close-view-manager',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({
  default: defineComponent({
    name: 'MetaGalleryView',
    props: {
      viewConfig: { type: Object, default: null },
    },
    emits: ['update-view-config'],
    render() {
      return h(
        'button',
        {
          'data-gallery-config': JSON.stringify(this.$props.viewConfig ?? null),
          onClick: () => this.$emit('update-view-config', {
            config: {
              titleFieldId: 'fld_title',
              coverFieldId: 'fld_cover',
              fieldIds: ['fld_status'],
              columns: 4,
              cardSize: 'large',
            },
          }),
        },
        'gallery-config',
      )
    },
  }),
}))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({
  default: defineComponent({
    name: 'MetaTimelineView',
    props: {
      viewConfig: { type: Object, default: null },
    },
    emits: ['update-view-config', 'patch-dates'],
    render() {
      return h('div', [
        h(
          'button',
          {
            'data-timeline-config': JSON.stringify(this.$props.viewConfig ?? null),
            onClick: () => this.$emit('update-view-config', {
              config: {
                startFieldId: 'fld_start',
                endFieldId: 'fld_end',
                labelFieldId: 'fld_title',
                zoom: 'month',
              },
            }),
          },
          'timeline-config',
        ),
        h(
          'button',
          {
            'data-timeline-patch': 'true',
            onClick: () => this.$emit('patch-dates', {
              recordId: 'rec_1',
              version: 3,
              startFieldId: 'fld_start',
              endFieldId: 'fld_end',
              startValue: '2026-03-25',
              endValue: '2026-03-27',
            }),
          },
          'timeline-patch',
        ),
      ])
    },
  }),
}))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({
  default: defineComponent({
    name: 'MetaImportModal',
    props: {
      visible: { type: Boolean, default: false },
    },
    emits: ['update:dirty', 'close', 'cancel-import', 'import'],
    render() {
      if (!this.$props.visible) return null
      return h('div', [
        h(
          'button',
          {
            'data-import-dirty': 'true',
            onClick: () => this.$emit('update:dirty', true),
          },
          'import-dirty',
        ),
      ])
    },
  }),
}))

vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({
  default: defineComponent({
    name: 'MetaBasePicker',
    props: {
      activeBaseId: { type: String, default: '' },
    },
    emits: ['select'],
    render() {
      return h(
        'button',
        {
          'data-select-base': 'base_sales',
          'data-active-base-id': this.$props.activeBaseId,
          onClick: () => this.$emit('select', 'base_sales'),
        },
        this.$props.activeBaseId || 'no-base',
      )
    },
  }),
}))

vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        showError: showErrorSpy,
        showSuccess: showSuccessSpy,
      })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
    { id: 'view_gallery', sheetId: 'sheet_orders', name: 'Gallery', type: 'gallery', config: { columns: 3 } },
    { id: 'view_timeline', sheetId: 'sheet_orders', name: 'Timeline', type: 'timeline', config: { zoom: 'week' } },
  ])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [
          { id: 'base_ops', name: 'Ops Base' },
          { id: 'base_sales', name: 'Sales Base' },
        ],
      }),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      updateView: vi.fn(),
      deleteView: vi.fn(),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([]),
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false,
    }),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((baseId: string) => { activeBaseId.value = baseId }),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
}

function createGridMock() {
  return {
    fields: ref([]),
    rows: ref([
      { id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } },
      { id: 'rec_2', version: 1, data: { fld_title: 'Beta' } },
    ]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref([]),
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null),
    groupField: ref(null),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    conflict: ref(null),
    error: ref<string | null>(null),
    sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(),
    addSortRule: vi.fn(),
    removeSortRule: vi.fn(),
    addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(),
    removeFilterRule: vi.fn(),
    clearFilters: vi.fn(),
    applySortFilter: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setGroupField: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    loadViewData: vi.fn(),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench view wiring', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.useRealTimers()
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  function mountWorkbench(initialProps?: { baseId?: string; sheetId?: string; viewId?: string }) {
    let hostState!: { baseId?: string; sheetId?: string; viewId?: string }
    workbenchMock.activeBaseId.value = initialProps?.baseId ?? 'base_ops'
    workbenchMock.activeSheetId.value = initialProps?.sheetId ?? 'sheet_orders'
    workbenchMock.activeViewId.value = initialProps?.viewId ?? 'view_grid'
    const Host = defineComponent({
      setup() {
        hostState = reactive({
          baseId: initialProps?.baseId ?? 'base_ops',
          sheetId: initialProps?.sheetId ?? 'sheet_orders',
          viewId: initialProps?.viewId ?? 'view_grid',
        })
        return () => h(MultitableWorkbench as Component, hostState)
      },
    })

    app = createApp(Host)
    app.mount(container!)
    return hostState
  }

  it('syncs external base/sheet/view props after mount', async () => {
    const hostState = mountWorkbench()
    await flushUi()

    workbenchMock.syncExternalContext.mockClear()

    hostState.baseId = 'base_sales'
    hostState.sheetId = 'sheet_deals'
    hostState.viewId = 'view_board'
    await flushUi()

    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_deals',
      viewId: 'view_board',
    })
  })

  it('defers external prop-driven context sync until unsaved drafts are cleared', async () => {
    const hostState = mountWorkbench()
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    workbenchMock.syncExternalContext.mockClear()

    hostState.baseId = 'base_sales'
    hostState.sheetId = 'sheet_sales'
    hostState.viewId = 'view_gallery'
    await flushUi()

    expect(workbenchMock.syncExternalContext).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith('Host multitable context changed while unsaved drafts are open. Resolve or discard changes to continue.')

    container!.querySelector<HTMLButtonElement>('[data-field-manager-clean="true"]')!.click()
    await flushUi()

    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_sales',
      viewId: 'view_gallery',
    })
  })

  it('renders conflict recovery actions and wires reload / retry / dismiss', async () => {
    mountWorkbench()
    await flushUi()

    gridMock.conflict.value = {
      recordId: 'rec_1',
      fieldId: 'fld_title',
      attemptedValue: 'patched',
      message: 'Row changed elsewhere',
      serverVersion: 8,
    }
    gridMock.fields.value = [{ id: 'fld_title', name: 'Title', type: 'string' }]
    gridMock.retryConflict.mockResolvedValue(true)
    await flushUi()

    expect(container?.textContent).toContain('Update conflict')
    expect(container?.textContent).toContain('Title changed elsewhere. Latest version is 8.')

    ;(container?.querySelector('.mt-workbench__conflict-btn') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).toHaveBeenCalledWith('Loaded the latest row state')

    ;(container?.querySelector('.mt-workbench__conflict-btn--primary') as HTMLButtonElement | null)?.click()
    await flushUi()
    expect(gridMock.retryConflict).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).toHaveBeenLastCalledWith('Change reapplied')

    const dismissButton = Array.from(container?.querySelectorAll('.mt-workbench__conflict-btn') ?? []).find((button) =>
      (button as HTMLButtonElement).textContent?.includes('Dismiss'),
    ) as HTMLButtonElement | undefined
    dismissButton?.click()
    expect(gridMock.dismissConflict).toHaveBeenCalledTimes(1)
  })

  it('shows an error when user base switch fails', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.switchBase.mockImplementation(async () => {
      workbenchMock.error.value = 'base switch failed'
      return false
    })

    container!.querySelector<HTMLButtonElement>('[data-select-base="base_sales"]')!.click()
    await flushUi()

    expect(workbenchMock.switchBase).toHaveBeenCalledWith('base_sales')
    expect(showErrorSpy).toHaveBeenCalledWith('base switch failed')
  })

  it('prompts before switching sheets when context-level drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-sheet="sheet_sales"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved changes before leaving the current sheet or view?')
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled()
  })

  it('creates a new sheet inside the switched base and syncs into the created sheet context', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.switchBase.mockImplementation(async (baseId: string) => {
      workbenchMock.activeBaseId.value = baseId
      return true
    })
    workbenchMock.client.createSheet.mockResolvedValue({
      sheet: { id: 'sheet_new', baseId: 'base_sales', name: 'Sheet 2', seeded: true },
    })
    workbenchMock.syncExternalContext.mockResolvedValue(true)

    container!.querySelector<HTMLButtonElement>('[data-select-base="base_sales"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-create-sheet="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.createSheet).toHaveBeenCalledWith({
      name: 'Sheet 2',
      baseId: 'base_sales',
      seed: true,
    })
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({
      baseId: 'base_sales',
      sheetId: 'sheet_new',
    })
  })

  it('maps person field creation through the prepared link preset', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.client.preparePersonField.mockResolvedValue({
      targetSheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People' },
      fieldProperty: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })

    container!.querySelector<HTMLButtonElement>('[data-create-person-field="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.preparePersonField).toHaveBeenCalledWith('sheet_orders')
    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Owner',
      type: 'link',
      property: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })
  })

  it('merges person field manager property overrides into the prepared link preset', async () => {
    mountWorkbench()
    await flushUi()

    workbenchMock.client.preparePersonField.mockResolvedValue({
      targetSheet: { id: 'sheet_people', baseId: 'base_ops', name: 'People' },
      fieldProperty: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: true,
        refKind: 'user',
      },
    })

    container!.querySelector<HTMLButtonElement>('[data-create-person-field-multi="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.createField).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      name: 'Approvers',
      type: 'link',
      property: {
        foreignSheetId: 'sheet_people',
        limitSingleRecord: false,
        refKind: 'user',
      },
    })
  })

  it('persists active gallery view config updates through the workbench client', async () => {
    mountWorkbench({ viewId: 'view_gallery' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-gallery-config]')!.click()
    await flushUi()

    expect(workbenchMock.client.updateView).toHaveBeenCalledWith('view_gallery', {
      config: {
        titleFieldId: 'fld_title',
        coverFieldId: 'fld_cover',
        fieldIds: ['fld_status'],
        columns: 4,
        cardSize: 'large',
      },
    })
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalled()
    expect(gridMock.loadViewData).toHaveBeenCalled()
  })

  it('patches timeline date updates through patchRecords and refreshes the active page', async () => {
    mountWorkbench({ viewId: 'view_timeline' })
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-timeline-patch="true"]')!.click()
    await flushUi()

    expect(workbenchMock.client.patchRecords).toHaveBeenCalledWith({
      sheetId: 'sheet_orders',
      viewId: 'view_timeline',
      changes: [
        { recordId: 'rec_1', fieldId: 'fld_start', value: '2026-03-25', expectedVersion: 3 },
        { recordId: 'rec_1', fieldId: 'fld_end', value: '2026-03-27', expectedVersion: 3 },
      ],
    })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledWith('Timeline updated')
  })

  it('prompts before switching records when record-scoped drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_2"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
    expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
    expect(container!.querySelector('[data-record-drawer="rec_2"]')).toBeNull()
  })

  it('prompts before closing the comments drawer when a comment draft exists', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-close-comments="true"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved comment draft?')
    expect(container!.querySelector('[data-close-comments="true"]')).toBeTruthy()
  })

  it('prompts before closing the record drawer when record-scoped drafts are present', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-select-record="rec_1"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-toggle-comments="true"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-set-comment-draft="true"]')!.click()
    await flushUi()

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    container!.querySelector<HTMLButtonElement>('[data-close-drawer="true"]')!.click()
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledWith('Discard unsaved record changes?')
    expect(container!.querySelector('[data-record-drawer="rec_1"]')).toBeTruthy()
  })

  it('refreshes sheet metadata while the view manager is open and stops after close', async () => {
    vi.useFakeTimers()
    mountWorkbench()
    await flushUi()

    workbenchMock.loadSheetMeta.mockClear()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    await vi.advanceTimersByTimeAsync(1200)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    container!.querySelector<HTMLButtonElement>('[data-close-view-manager="true"]')!.click()
    await flushUi()
    workbenchMock.loadSheetMeta.mockClear()

    await vi.advanceTimersByTimeAsync(2400)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  it('restarts dialog metadata refresh immediately when the active sheet changes mid-refresh', async () => {
    vi.useFakeTimers()
    const firstRefresh = createDeferred<boolean>()
    workbenchMock.loadSheetMeta.mockImplementationOnce(() => firstRefresh.promise)
    mountWorkbench()
    await flushUi()

    workbenchMock.loadSheetMeta.mockClear()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Views'))?.click()
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_orders')

    workbenchMock.activeSheetId.value = 'sheet_sales'
    await flushUi()
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)

    firstRefresh.resolve(true)
    await flushUi()

    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(2)
    expect(workbenchMock.loadSheetMeta).toHaveBeenLastCalledWith('sheet_sales')
  })

  it('blocks beforeunload when a child component reports unsaved drafts', async () => {
    mountWorkbench({ viewId: 'view_grid' })
    await flushUi()

    const managerButtons = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
    managerButtons.find((button) => button.textContent?.includes('Fields'))?.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-field-manager-dirty="true"]')!.click()
    await flushUi()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.returnValue).toBe('')
  })

  it('blocks beforeunload when the import modal reports an unsaved draft', async () => {
    mountWorkbench()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-open-import="true"]')!.click()
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-import-dirty="true"]')!.click()
    await flushUi()

    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
      configurable: true,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(event.returnValue).toBe('')
  })
})
