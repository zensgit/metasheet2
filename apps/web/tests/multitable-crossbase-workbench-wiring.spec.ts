import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Cross-base link picker — design-lock 2026-06-14 test-row #8 (active base
// unchanged) + the "Impl trap" lock. This MUST be a workbench-level test:
// MetaFieldManager has no switchBase, so a component-level #8 would pass
// regardless of impl. The bug lives in the workbench wiring — if
// listForeignSheetsForFieldFn used workbench.switchBase / loadBaseContext
// (which run syncContextState) instead of the BARE client.loadContext, picking
// a foreign base would yank the user's active base/sheet. This captures the fn
// the workbench passes down, invokes it, and asserts the bare client was used
// and the active base/sheet did NOT move.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

// Capture the props the workbench passes to MetaFieldManager (the stub records
// them so the test can invoke the wired fns directly).
let capturedFieldManagerProps: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
  }
})

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
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
    canRead: ref(true), canCreateRecord: ref(true), canEditRecord: ref(true), canDeleteRecord: ref(true),
    canManageFields: ref(true), canManageSheetAccess: ref(true), canManageViews: ref(true), canComment: ref(true),
    canManageAutomation: ref(false), canExport: ref(true),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]), loading: ref(false), submitting: ref(false), resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]), deletingIds: ref<string[]>([]), error: ref<string | null>(null),
    // B6 (#2674) added these to the composable; the workbench reads reactingKeys.value at render time,
    // so without them this mount throws and the spec only "passed" via suite module-ordering luck.
    reactingKeys: ref<string[]>([]),
    loadComments: vi.fn(), addComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), resolveComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({ unreadCount: ref(0), refreshUnreadCount: vi.fn().mockResolvedValue(0) }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({ useMultitableCommentRealtime: vi.fn() }))
vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({ useMultitableSheetRealtime: vi.fn() }))
vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({ default: stubComponent('MetaViewTabBar') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({ default: stubComponent('MetaRecordDrawer') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
// Capturing stub for the component under wiring test.
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({
  default: defineComponent({
    name: 'MetaFieldManager',
    props: ['listBasesFn', 'listForeignSheetsFn'],
    setup(props) {
      capturedFieldManagerProps = props as unknown as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaFieldManager': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({ showError: showErrorSpy, showSuccess: showSuccessSpy })
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
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }, { id: 'base_far', name: 'Far Base' }] }),
      // The bare-client read the wiring MUST use. Returns the foreign base's sheets.
      loadContext: vi.fn().mockResolvedValue({
        base: { id: 'base_far', name: 'Far Base' },
        sheet: null,
        sheets: [{ id: 'sheet_far', baseId: 'base_far', name: 'Far Table' }],
        views: [],
        capabilities: {},
      }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([{ id: 'fld_title', name: 'Title', type: 'string' }]),
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
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
    fields: ref([]), rows: ref([]), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }), visibleFields: ref([]), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupField: ref(null), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench cross-base field-picker wiring', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedFieldManagerProps = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.clearAllMocks()
  })

  it('wires listForeignSheetsFn to the bare client.loadContext and never moves the active base (row #8)', async () => {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()

    expect(capturedFieldManagerProps).not.toBeNull()
    const listForeignSheetsFn = capturedFieldManagerProps!.listForeignSheetsFn as (baseId: string) => Promise<unknown[]>
    const listBasesFn = capturedFieldManagerProps!.listBasesFn as () => Promise<unknown[]>
    expect(typeof listForeignSheetsFn).toBe('function')
    expect(typeof listBasesFn).toBe('function')

    const baseBefore = workbenchMock.activeBaseId.value
    const sheetBefore = workbenchMock.activeSheetId.value
    // Snapshot mutator call-counts AFTER mount — the workbench's own startup may
    // legitimately load the ACTIVE base once. We assert the foreign-sheet fetch
    // adds ZERO further mutator calls (the Impl trap is about not re-syncing on
    // a foreign-base read, not about mount-time behavior).
    const switchBaseBefore = workbenchMock.switchBase.mock.calls.length
    const loadBaseContextBefore = workbenchMock.loadBaseContext.mock.calls.length
    const selectBaseBefore = workbenchMock.selectBase.mock.calls.length
    const selectSheetBefore = workbenchMock.selectSheet.mock.calls.length

    // Invoke the wired foreign-sheet fetch for a DIFFERENT base.
    const sheets = await listForeignSheetsFn('base_far')

    // It resolved via the bare client.loadContext({baseId}) and returned .sheets.
    expect(workbenchMock.client.loadContext).toHaveBeenCalledWith({ baseId: 'base_far' })
    expect(sheets).toEqual([{ id: 'sheet_far', baseId: 'base_far', name: 'Far Table' }])

    // The active-base mutators were NOT touched BY THE FETCH (the Impl trap).
    expect(workbenchMock.switchBase.mock.calls.length).toBe(switchBaseBefore)
    expect(workbenchMock.loadBaseContext.mock.calls.length).toBe(loadBaseContextBefore)
    expect(workbenchMock.selectBase.mock.calls.length).toBe(selectBaseBefore)
    expect(workbenchMock.selectSheet.mock.calls.length).toBe(selectSheetBefore)
    // No mutator was ever called with the FOREIGN base id.
    expect(workbenchMock.switchBase).not.toHaveBeenCalledWith('base_far')
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalledWith('base_far')

    // And the active base/sheet are unchanged.
    expect(workbenchMock.activeBaseId.value).toBe(baseBefore)
    expect(workbenchMock.activeSheetId.value).toBe(sheetBefore)

    // listBasesFn unwraps the gated bases list.
    const bases = await listBasesFn()
    expect(workbenchMock.client.listBases).toHaveBeenCalled()
    expect(bases).toEqual([{ id: 'base_ops', name: 'Ops Base' }, { id: 'base_far', name: 'Far Base' }])
  })
})
