// A2 (2026-09-25, 客户反馈 2026-09-24 #6, 裁定见 PR #6074): once the dashboard toolbar toggle opened
// MetaDashboardView, none of the sidebar navigation paths (select a different/the-same view, switch
// base) reset `showDashboardView`, and MetaDashboardView itself had no back control — there was no
// way back to the grid short of re-clicking the toggle button. This spec pins the fix: every listed
// navigation path (plus the dashboard's own new `close` emit) returns to the grid.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn().mockResolvedValue(undefined),
    }),
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

// The rail stub exposes two controls: re-selecting the ALREADY-active view (the early-return branch
// `onSelectView` takes) and selecting a genuinely different one — the two "click the rail" scenarios
// this fix covers.
function stubMetaSheetViewRail() {
  return defineComponent({
    name: 'MetaSheetViewRail',
    emits: ['select-sheet', 'select-view', 'create-sheet', 'toggle-personal', 'rename-sheet', 'delete-sheet'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaSheetViewRail': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-view-same',
          onClick: () => emit('select-view', 'view_grid'),
        }, 'select-view-same'),
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-view-other',
          onClick: () => emit('select-view', 'view_grid_2'),
        }, 'select-view-other'),
      ])
    },
  })
}

// The base-picker stub exposes a control for switching to a DIFFERENT base.
function stubMetaBasePicker() {
  return defineComponent({
    name: 'MetaBasePicker',
    emits: ['select', 'create', 'toggle-favorite', 'rename'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaBasePicker': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-select-base-other',
          onClick: () => emit('select', 'base_finance'),
        }, 'select-base-other'),
      ])
    },
  })
}

// The dashboard stub exposes its own close control so the spec can drive MetaDashboardView's new
// `close` emit without depending on its real (heavy: charts/panels/client fetches) internals.
function stubMetaDashboardView() {
  return defineComponent({
    name: 'MetaDashboardView',
    emits: ['close'],
    setup(_, { emit }) {
      return () => h('div', { 'data-stub-MetaDashboardView': 'true' }, [
        h('button', {
          type: 'button',
          'data-testid': 'stub-dashboard-close',
          onClick: () => emit('close'),
        }, 'close'),
      ])
    },
  })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

vi.mock('../src/multitable/composables/useMultitableGrid', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/composables/useMultitableGrid')>(
    '../src/multitable/composables/useMultitableGrid',
  )
  return {
    ...actual,
    useMultitableGrid: () => gridMock,
  }
})

vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => ({
    canRead: ref(true),
    canCreateRecord: ref(true),
    canEditRecord: ref(true),
    canDeleteRecord: ref(true),
    canManageFields: ref(true),
    canManageSheetAccess: ref(true),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false), canExport: ref(true),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]),
    deletingIds: ref<string[]>([]),
    reactingKeys: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({
    unreadCount: ref(0),
    refreshUnreadCount: vi.fn().mockResolvedValue(0),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: vi.fn(),
}))

vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: vi.fn(),
}))

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: vi.fn(),
}))

vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubMetaSheetViewRail() }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubMetaBasePicker() }))
vi.mock('../src/multitable/components/MetaDashboardView.vue', () => ({ default: stubMetaDashboardView() }))

vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        showError: vi.fn(),
        showSuccess: vi.fn(),
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
    // A second GRID-typed view (not e.g. gallery) so switching to it still renders MetaGridTable —
    // this spec is about the dashboard-exit wiring, not the per-view-type render chain.
    { id: 'view_grid_2', sheetId: 'sheet_orders', name: 'Grid 2', type: 'grid' },
  ])

  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [{ id: 'base_ops', name: 'Ops Base' }, { id: 'base_finance', name: 'Finance Base' }],
      }),
      updateView: vi.fn(),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      deleteView: vi.fn(),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
      renameSheet: vi.fn(),
      renameBase: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref([
      { id: 'fld_title', name: 'Title', type: 'string' },
    ]),
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
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false, canExport: true,
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
    switchBase: vi.fn(async (baseId: string) => { activeBaseId.value = baseId; return true }),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((baseId: string) => { activeBaseId.value = baseId }),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
}

function createGridMock() {
  return {
    fields: ref([]),
    rows: ref([]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref([]),
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    filterGroups: ref([]),
    canLoadMore: ref(false),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]),
    groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    capabilityOrigin: ref(null),
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
    setGroupField: vi.fn(), setGroupFields: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench dashboard exit (A2)', () => {
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
    vi.clearAllMocks()
  })

  function mountWorkbench(): HTMLDivElement {
    const Host = defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component)
      },
    })
    app = createApp(Host)
    app.mount(container!)
    return container!
  }

  function toggleButton(root: HTMLDivElement): HTMLButtonElement {
    const button = root.querySelector<HTMLButtonElement>('[data-action="toggle-dashboard"]')
    expect(button).toBeTruthy()
    return button!
  }

  function isDashboardShown(root: HTMLDivElement): boolean {
    return !!root.querySelector('[data-stub-MetaDashboardView]')
  }

  function isGridShown(root: HTMLDivElement): boolean {
    return !!root.querySelector('[data-stub-MetaGridTable]')
  }

  it('toggling the button opens the dashboard', async () => {
    const root = mountWorkbench()
    await flushUi()
    expect(isDashboardShown(root)).toBe(false)

    const button = toggleButton(root)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    button.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(true)
    expect(isGridShown(root)).toBe(false)
    expect(toggleButton(root).getAttribute('aria-pressed')).toBe('true')
    expect(toggleButton(root).classList.contains('mt-workbench__mgr-btn--active')).toBe(true)
  })

  it('selecting a DIFFERENT view returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-view-other"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    expect(workbenchMock.selectView).toHaveBeenCalledWith('view_grid_2')
  })

  it('re-selecting the ALREADY-active view returns to the grid instead of doing nothing', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)
    expect(workbenchMock.activeViewId.value).toBe('view_grid')

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-view-same"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
    // The early-return branch never calls workbench.selectView — it is already the active view.
    expect(workbenchMock.selectView).not.toHaveBeenCalled()
  })

  it('switching to a different base returns to the grid', async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-select-base-other"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(workbenchMock.switchBase).toHaveBeenCalledWith('base_finance')
  })

  it("the dashboard's own close control returns to the grid", async () => {
    const root = mountWorkbench()
    await flushUi()
    toggleButton(root).click()
    await flushUi()
    expect(isDashboardShown(root)).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-testid="stub-dashboard-close"]')!.click()
    await flushUi()

    expect(isDashboardShown(root)).toBe(false)
    expect(isGridShown(root)).toBe(true)
  })
})
