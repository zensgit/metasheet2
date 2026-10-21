/**
 * 客户反馈 2026-10-21: rows-per-page wiring in MultitableWorkbench (the grid composable and MetaGridTable are
 * covered in multitable-grid-grouped-paging-page-size.spec.ts). Mounts the real workbench with the grid composable
 * mocked and a capturing MetaGridTable stub (same harness as multitable-workbench-bulk-delete.spec.ts):
 *   - the grid gets the current size + the offered sizes, and a pick is stored per user + sheet, then applied;
 *   - the stored size is applied once the user id resolves, and fed to the composable's first load via
 *     resolvePageSize (null until the user is known).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let capturedGridAttrs: Record<string, unknown> | null = null
let capturedGridOpts: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }) }
})

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: (opts: Record<string, unknown>) => { capturedGridOpts = opts; return gridMock },
}))
const { resolveUserId } = vi.hoisted(() => ({ resolveUserId: { current: 'user_1' as string | null } }))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn(async () => resolveUserId.current),
    getAccessSnapshot: () => ({ userId: resolveUserId.current, isAdmin: false, permissions: [] }),
    getToken: () => null,
  }),
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

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
// Capturing stub for the grid — records the page-size props and the @set-page-size listener under test.
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedGridAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaGridTable': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/RestorePreviewDialog.vue', () => ({ default: stubComponent('RestorePreviewDialog') }))
vi.mock('../src/multitable/components/RestoreBatchDialog.vue', () => ({ default: stubComponent('RestoreBatchDialog') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
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
import { gridPageSizeStorageKey } from '../src/multitable/utils/grid-page-size'

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref<string | null>('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_ops' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([{ id: 'fld_title', name: 'Title', type: 'string' }]),
    views, activeBaseId, activeSheetId, activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null), fieldPermissions: ref({}), viewPermissions: ref({}),
    activeView: computed(() => views.value.find((v) => v.id === activeViewId.value) ?? null),
    loading: ref(false), error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true), loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true), switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((id: string) => { activeBaseId.value = id }),
    selectSheet: vi.fn((id: string) => { activeSheetId.value = id }),
    selectView: vi.fn((id: string) => { activeViewId.value = id }),
  }
}

function createGridMock() {
  return {
    fields: ref([]), rows: ref([]), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }), visibleFields: ref([]), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]), canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null), rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn().mockResolvedValue(undefined), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
    pageSize: ref(50), setPageSize: vi.fn().mockResolvedValue(undefined),
  }
}

describe('MultitableWorkbench rows-per-page wiring (客户反馈 2026-10-21)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    resolveUserId.current = 'user_1'
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedGridAttrs = null
    capturedGridOpts = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.unstubAllGlobals(); vi.clearAllMocks()
  })

  async function mountWorkbench(): Promise<void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedGridAttrs).not.toBeNull()
  }

  it('passes the current size and the offered sizes to the grid', async () => {
    gridMock.pageSize.value = 100
    await mountWorkbench()
    expect(capturedGridAttrs!['page-size']).toBe(100)
    expect([...(capturedGridAttrs!['page-size-options'] as number[])]).toEqual([50, 100, 200, 500])
  })

  it('a pick is stored for this user + sheet (snapped into the set) and applied to the grid', async () => {
    await mountWorkbench()
    gridMock.setPageSize.mockClear()
    const onSetPageSize = capturedGridAttrs!.onSetPageSize as (size: number) => void
    expect(typeof onSetPageSize).toBe('function')

    onSetPageSize(200)
    expect(localStorage.getItem(gridPageSizeStorageKey('user_1', 'sheet_orders'))).toBe('200')
    expect(gridMock.setPageSize).toHaveBeenLastCalledWith(200)

    onSetPageSize(9999)
    expect(localStorage.getItem(gridPageSizeStorageKey('user_1', 'sheet_orders'))).toBe('500')
    expect(gridMock.setPageSize).toHaveBeenLastCalledWith(500)
    expect(localStorage.getItem(gridPageSizeStorageKey('user_2', 'sheet_orders'))).toBeNull()
  })

  it('applies the stored size (snapped) once the user id resolves; the default when nothing is stored', async () => {
    localStorage.setItem(gridPageSizeStorageKey('user_1', 'sheet_orders'), '250')
    await mountWorkbench()
    expect(gridMock.setPageSize).toHaveBeenCalledWith(200)
    app!.unmount(); app = null

    localStorage.clear()
    gridMock = createGridMock()
    await mountWorkbench()
    expect(gridMock.setPageSize).toHaveBeenCalledWith(50)
  })

  it('feeds the composable a resolver that reads the stored size for the resolved user only', async () => {
    localStorage.setItem(gridPageSizeStorageKey('user_1', 'sheet_orders'), '100')
    resolveUserId.current = null
    await mountWorkbench()
    const resolvePageSize = capturedGridOpts!.resolvePageSize as (sheetId: string) => number | null
    expect(typeof resolvePageSize).toBe('function')
    expect(resolvePageSize('sheet_orders')).toBeNull()
    expect(gridMock.setPageSize).not.toHaveBeenCalled()
    app!.unmount(); app = null

    resolveUserId.current = 'user_1'
    gridMock = createGridMock()
    await mountWorkbench()
    const resolved = capturedGridOpts!.resolvePageSize as (sheetId: string) => number | null
    expect(resolved('sheet_orders')).toBe(100)
    expect(resolved('sheet_other')).toBeNull()
  })
})
