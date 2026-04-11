/**
 * Tests that MultitableWorkbench correctly wires field/view permission data
 * into MetaSheetPermissionManager when the Access panel is opened.
 *
 * This test does NOT mock MetaSheetPermissionManager — it mounts the real
 * component through the workbench to verify end-to-end prop passing.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, computed, type App as VueApp, type Component } from 'vue'

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any
let capsMock: any

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
    RouterLink: defineComponent({ props: ['to'], setup(_, { slots }) { return () => h('a', {}, slots.default?.()) } }),
  }
})

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
}))
vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => capsMock,
}))
vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]), loading: ref(false), submitting: ref(false),
    resolvingIds: ref([]), updatingIds: ref([]), deletingIds: ref([]),
    error: ref(null), loadComments: vi.fn(), addComment: vi.fn(),
    resolveComment: vi.fn(), deleteComment: vi.fn(), updateComment: vi.fn(), clearComments: vi.fn(),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: () => ({ reconnect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    getAccessSnapshot: () => ({ userId: 'user_1', isAdmin: false, permissions: [] }),
  }),
}))
vi.mock('../src/composables/useToast', () => ({
  useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn() }),
}))

// Stub heavy sub-components that aren't under test
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({ default: stubComponent('MetaViewTabBar') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({ default: stubComponent('MetaRecordDrawer') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubComponent('MetaViewManager') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaToast.vue', () => ({ default: stubComponent('MetaToast') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
// Do NOT mock MetaSheetPermissionManager — we want to test the real component

vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))

const fields = [
  { id: 'fld_1', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
  { id: 'fld_2', name: 'Status', type: 'select', property: {}, order: 1, options: [] },
]
const views = [
  { id: 'view_1', name: 'Grid View', sheetId: 'sheet_1', type: 'grid', filterInfo: null, sortInfo: null, groupInfo: null, hiddenFieldIds: [], config: {} },
]

function createWorkbenchMock() {
  const listFieldPermissionsFn = vi.fn().mockResolvedValue({
    items: [
      {
        fieldId: 'fld_2',
        subjectType: 'user',
        subjectId: 'user_2',
        subjectLabel: 'Bob',
        visible: false,
        readOnly: false,
      },
    ],
  })
  const listViewPermissionsFn = vi.fn().mockResolvedValue({
    items: [
      {
        viewId: 'view_1',
        subjectType: 'user',
        subjectId: 'user_2',
        permission: 'read',
      },
    ],
  })
  return {
    activeBaseId: ref('base_1'),
    activeSheetId: ref('sheet_1'),
    activeViewId: ref('view_1'),
    activeView: computed(() => views[0]),
    sheets: ref([{ id: 'sheet_1', name: 'Sheet 1', baseId: 'base_1', description: '' }]),
    fields: ref(fields),
    views: ref(views),
    bases: ref([]),
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
      canManageFields: true, canManageSheetAccess: true, canManageViews: true,
      canComment: true, canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    loading: ref(false),
    error: ref(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn(),
    selectSheet: vi.fn(),
    selectView: vi.fn(),
    client: {
      loadContext: vi.fn().mockResolvedValue({ sheets: [], views: [], capabilities: {} }),
      getViewData: vi.fn().mockResolvedValue({ fields: [], rows: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } }),
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [
        { subjectType: 'user', subjectId: 'user_2', label: 'Bob', accessLevel: 'write', isActive: true },
      ] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      listFieldPermissions: listFieldPermissionsFn,
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      listViewPermissions: listViewPermissionsFn,
      updateViewPermission: vi.fn().mockResolvedValue({}),
    },
    listFieldPermissionsFn,
    listViewPermissionsFn,
  }
}

function createGridMock() {
  return {
    fields: ref(fields), rows: ref([]), loading: ref(false),
    currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref(fields), sortRules: ref([]), filterRules: ref([]),
    filterConjunction: ref('and'), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref(null), groupField: ref(null),
    hiddenFieldIds: ref([]), columnWidths: ref({}),
    linkSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({}), viewPermission: ref(null),
    rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null),
    error: ref(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(),
    addFilterRule: vi.fn(), updateFilterRule: vi.fn(), removeFilterRule: vi.fn(),
    clearFilters: vi.fn(), applySortFilter: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    setGroupField: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(),
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(), retryConflict: vi.fn(),
    setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench -> MetaSheetPermissionManager wiring', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  async function flushUi() {
    await nextTick(); await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()
  }

  beforeEach(() => {
    const wb = createWorkbenchMock()
    workbenchMock = wb
    gridMock = createGridMock()
    capsMock = {
      canRead: ref(true), canCreateRecord: ref(true), canEditRecord: ref(true),
      canDeleteRecord: ref(true), canManageFields: ref(true), canManageSheetAccess: ref(true),
      canManageViews: ref(true), canComment: ref(true), canManageAutomation: ref(false),
      canExport: ref(true),
    }
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    vi.clearAllMocks()
  })

  it('opens Access panel and loads field/view permission entries via client API', async () => {
    const MultitableWorkbench = (await import('../src/multitable/views/MultitableWorkbench.vue')).default

    app = createApp(defineComponent({
      setup() { return () => h(MultitableWorkbench as Component) },
    }))
    app.mount(container!)
    await flushUi()

    // Click Access button
    const accessBtn = Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn'))
      .find((btn) => btn.textContent?.includes('Access')) as HTMLButtonElement
    expect(accessBtn).toBeTruthy()
    accessBtn.click()
    await flushUi()

    // Verify the real MetaSheetPermissionManager rendered with tabs
    const tabs = Array.from(container!.querySelectorAll('[role="tab"]'))
    expect(tabs.length).toBeGreaterThanOrEqual(3)
    const tabLabels = tabs.map((t) => t.textContent?.trim())
    expect(tabLabels).toContain('Field Permissions')
    expect(tabLabels).toContain('View Permissions')

    // Verify client API was called to load permission entries
    expect(workbenchMock.listFieldPermissionsFn).toHaveBeenCalledWith('sheet_1')
    expect(workbenchMock.listViewPermissionsFn).toHaveBeenCalledWith('view_1')

    const fieldTab = tabs.find((t) => t.textContent?.includes('Field Permissions')) as HTMLElement
    fieldTab.click()
    await flushUi()

    const fieldRow = container!.querySelector('[data-field-permission-row="fld_2:user:user_2"]')
    expect(fieldRow).toBeTruthy()
    expect(fieldRow?.textContent).toContain('Bob')
    expect(fieldRow?.textContent).toContain('Hidden')

    const viewTab = tabs.find((t) => t.textContent?.includes('View Permissions')) as HTMLElement
    viewTab.click()
    await flushUi()

    const viewRow = container!.querySelector('[data-view-permission-row="view_1:user:user_2"]')
    expect(viewRow).toBeTruthy()
    expect(viewRow?.textContent).toContain('Bob')
    expect(viewRow?.textContent).toContain('Read')
  })
})
