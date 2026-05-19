/**
 * Regression coverage for:
 *  - #1673: the multitable "Workflow" toolbar entry must be hidden when the
 *    global `workflow` product feature is unavailable, otherwise the router
 *    guard redirects /workflows/designer -> resolveHomePath() (/attendance).
 *  - #1672: closing the record drawer / unloading the page must flush a
 *    focused field edit (blur the active element) so text/longText commits,
 *    matching select/checkbox which commit on selection.
 *
 * Mounts the real MultitableWorkbench.vue with the same composable scaffold
 * proven by multitable-workbench-permission-wiring.spec.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, computed, type App as VueApp, type Component } from 'vue'

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any
let capsMock: any
let hasFeatureMock: (feature: string) => boolean

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
    RouterLink: defineComponent({ props: ['to'], setup(_, { slots }) { return () => h('a', {}, slots.default?.()) } }),
  }
})

// Preserve every real export; only swap hasFeature so the workflow gate is
// controllable per test (other modules in the tree still see the real store).
vi.mock('../src/stores/featureFlags', async () => {
  const actual = await vi.importActual<any>('../src/stores/featureFlags')
  return {
    ...actual,
    useFeatureFlags: () => ({ ...actual.useFeatureFlags(), hasFeature: (f: string) => hasFeatureMock(f) }),
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
vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))

const fields = [
  { id: 'fld_1', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
]
const views = [
  { id: 'view_1', name: 'Grid View', sheetId: 'sheet_1', type: 'grid', filterInfo: null, sortInfo: null, groupInfo: null, hiddenFieldIds: [], config: {} },
]

function createWorkbenchMock() {
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
      canComment: true, canManageAutomation: true, canExport: true,
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
    },
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

describe('MultitableWorkbench #1672 / #1673', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  async function flushUi() {
    await nextTick(); await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()
  }

  function managerButtons(): HTMLButtonElement[] {
    return Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[]
  }

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capsMock = {
      canRead: ref(true), canCreateRecord: ref(true), canEditRecord: ref(true),
      canDeleteRecord: ref(true), canManageFields: ref(true), canManageSheetAccess: ref(true),
      canManageViews: ref(true), canComment: ref(true), canManageAutomation: ref(true),
      canExport: ref(true),
    }
    hasFeatureMock = () => false
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    vi.clearAllMocks()
  })

  async function mountWorkbench() {
    const MultitableWorkbench = (await import('../src/multitable/views/MultitableWorkbench.vue')).default
    app = createApp(defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } }))
    app.mount(container!)
    await flushUi()
  }

  it('#1673 hides the Workflow designer entry when the workflow feature is unavailable', async () => {
    hasFeatureMock = (f) => f === 'workflow' ? false : true
    await mountWorkbench()

    const texts = managerButtons().map((b) => b.textContent?.trim() ?? '')
    // The sibling "Automations" button is gated by canManageAutomation only and
    // must still render — proving canManageAutomation=true and that the missing
    // Workflow button is specifically the workflow-feature gate, not caps.
    expect(texts.some((t) => t.includes('Automations'))).toBe(true)
    expect(texts.some((t) => t.includes('Workflow'))).toBe(false)
  })

  it('#1673 shows the Workflow designer entry when the workflow feature is available', async () => {
    hasFeatureMock = (f) => f === 'workflow' ? true : false
    await mountWorkbench()

    const texts = managerButtons().map((b) => b.textContent?.trim() ?? '')
    expect(texts.some((t) => t.includes('Workflow'))).toBe(true)
    expect(texts.some((t) => t.includes('Automations'))).toBe(true)
  })

  it('#1672 flushes a focused field edit by blurring the active element on page unload', async () => {
    await mountWorkbench()

    const input = document.createElement('input')
    input.type = 'text'
    container!.appendChild(input)
    input.focus()
    expect(document.activeElement).toBe(input)
    const blurSpy = vi.spyOn(input, 'blur')

    // The workbench registers onBeforeUnload in onMounted; it must flush the
    // in-progress edit (blur) before the early hasBlockingUnloadState return.
    window.dispatchEvent(new Event('beforeunload'))

    expect(blurSpy).toHaveBeenCalledTimes(1)
  })
})
