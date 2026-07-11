import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// UI-P2-1c batch-1: MultitableWorkbench's conflict-banner actions (reload / retry / dismiss — the
// three and only sharers of `mt-workbench__conflict-btn`) were migrated from bespoke <button>s to
// the shared MtButton primitive (default ghost), so the bespoke base CSS could be removed cleanly.
// The `--primary` amber variant class on retry is deliberately KEPT as an additive class (MtButton
// has no warning/amber variant). Behavior-preservation proof: the three controls stay native,
// keyboard-operable <button>s and clicking each still runs the SAME handler (onReloadConflict →
// grid.reloadCurrentPage / onRetryConflict → grid.retryConflict / grid.dismissConflict).
//
// The mock harness below is a trimmed copy of multitable-workbench-view.spec.ts (the behavioral
// regression anchor for this banner — "renders conflict recovery actions and wires reload / retry /
// dismiss"): same composable mock shapes, simple render stubs for the heavy children.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()
const pushSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
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
  useMultitableCapabilities: (source: { value?: Record<string, boolean> } | undefined) => ({
    canRead: computed(() => source?.value?.canRead ?? true),
    canCreateRecord: computed(() => source?.value?.canCreateRecord ?? true),
    canEditRecord: computed(() => source?.value?.canEditRecord ?? true),
    canDeleteRecord: computed(() => source?.value?.canDeleteRecord ?? true),
    canManageFields: computed(() => source?.value?.canManageFields ?? true),
    canManageSheetAccess: computed(() => source?.value?.canManageSheetAccess ?? true),
    canManageViews: computed(() => source?.value?.canManageViews ?? true),
    canComment: computed(() => source?.value?.canComment ?? true),
    canManageAutomation: computed(() => source?.value?.canManageAutomation ?? false),
    canExport: computed(() => source?.value?.canExport ?? true),
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

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({ default: stubComponent('MetaViewTabBar') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({ default: stubComponent('MetaRecordDrawer') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaMentionPopover.vue', () => ({ default: stubComponent('MetaMentionPopover') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubComponent('MetaViewManager') }))
vi.mock('../src/multitable/components/MetaSheetPermissionManager.vue', () => ({ default: stubComponent('MetaSheetPermissionManager') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaGanttView.vue', () => ({ default: stubComponent('MetaGanttView') }))
vi.mock('../src/multitable/components/MetaHierarchyView.vue', () => ({ default: stubComponent('MetaHierarchyView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
vi.mock('../src/multitable/components/MetaNotificationBell.vue', () => ({ default: stubComponent('MetaNotificationBell') }))
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
import { useLocale } from '../src/composables/useLocale'

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
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      listRecordSummaries: vi.fn().mockResolvedValue({ records: [], displayMap: {} }),
      listCommentMentionSuggestions: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 100 }),
      markCommentRead: vi.fn().mockResolvedValue(undefined),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn(),
      updateView: vi.fn(),
      deleteView: vi.fn(),
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      listPersonFieldDirectory: vi.fn().mockResolvedValue({ items: [], total: 0, query: '' }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
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
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false,
      canExport: true,
    }),
    capabilityOrigin: ref({ source: 'global-rbac', hasSheetAssignments: false }),
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
  const fields = ref([{ id: 'fld_title', name: 'Title', type: 'string', order: 1 }])
  const mock: any = {
    fields,
    rows: ref([{ id: 'rec_1', version: 1, data: { fld_title: 'Alpha' } }]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: fields,
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    filterGroups: ref([]),
    canLoadMore: ref(false),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null),
    groupFieldIds: ref([]),
    groupField: ref(null),
    groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref({}),
    personSummaries: ref({}),
    attachmentSummaries: ref({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    capabilityOrigin: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref({}),
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
    setGroupFields: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    mergeRemoteRecord: vi.fn().mockReturnValue(true),
    applyRemoteRecordPatch: vi.fn().mockReturnValue(true),
    removeRemoteRecord: vi.fn().mockReturnValue(true),
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
  mock.resolveRowActions = vi.fn(() => mock.rowActions.value)
  return mock
}

describe('MultitableWorkbench conflict banner — MtButton migration (UI-P2-1c batch-1)', () => {
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
    expect(document.querySelectorAll('.mt-workbench').length).toBe(0) // residue guard
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    pushSpy.mockReset()
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  async function mountWithConflict() {
    app = createApp({
      render: () => h(MultitableWorkbench as Component, {
        baseId: 'base_ops',
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
      }),
    })
    app.mount(container!)
    await flushUi()
    gridMock.conflict.value = {
      recordId: 'rec_1',
      fieldId: 'fld_title',
      attemptedValue: 'patched',
      message: 'Row changed elsewhere',
      serverVersion: 8,
    }
    gridMock.retryConflict.mockResolvedValue(true)
    await flushUi()
  }

  const conflictBtns = () =>
    Array.from(container!.querySelectorAll('.mt-workbench__conflict-btn')) as HTMLButtonElement[]

  it('renders the three conflict actions as native <button>s (retry keeps the --primary variant class)', async () => {
    await mountWithConflict()
    const btns = conflictBtns()
    expect(btns.length).toBe(3) // reload / retry / dismiss — the full sharer set
    expect(btns.every((b) => b.tagName === 'BUTTON')).toBe(true) // keyboard-operable, not bare divs
    expect(btns[1].classList.contains('mt-workbench__conflict-btn--primary')).toBe(true) // additive variant kept
  })

  it('clicking reload still runs onReloadConflict → grid.reloadCurrentPage (unchanged)', async () => {
    await mountWithConflict()
    conflictBtns()[0].click()
    await flushUi()
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
  })

  it('clicking retry still runs onRetryConflict → grid.retryConflict (unchanged)', async () => {
    await mountWithConflict()
    conflictBtns()[1].click()
    await flushUi()
    expect(gridMock.retryConflict).toHaveBeenCalledTimes(1)
  })

  it('clicking dismiss still runs grid.dismissConflict (unchanged)', async () => {
    await mountWithConflict()
    const dismiss = conflictBtns().find((b) => b.textContent?.includes('Dismiss'))!
    dismiss.click()
    expect(gridMock.dismissConflict).toHaveBeenCalledTimes(1)
  })
})
