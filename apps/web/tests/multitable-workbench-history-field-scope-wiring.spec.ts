/**
 * Regression test for the History Center field-NAME leak (T2/T3 UX-parity audit, PR-A + owner P1 fix).
 *
 * Field-name visibility has TWO independent layers, and the History field list must filter BOTH:
 *  - layer-2: property-hidden (field.property.hidden === true / property.visible === false) —
 *    filterPropertyVisibleFields / propertyVisibleGridFields covers ONLY this;
 *  - layer-3: per-subject field_permissions RBAC (effectiveFieldPermissions[f.id]?.visible === false) —
 *    scopedAllFields covers ONLY this.
 * The original wiring used propertyVisibleGridFields (leaked RBAC-denied names); the first fix swapped to
 * scopedAllFields (owner P1: re-leaked property-hidden names). The correct wiring is the INTERSECTION —
 * `historyVisibleFields = filterPropertyVisibleFields(scopedAllFields)` — and this spec pins BOTH layers:
 * either single-layer wiring turns exactly one assertion red. Backend already withholds VALUES (LOCK-3);
 * the label itself was the FE-side leak.
 *
 * This test does NOT mock HistoryCenterModal or HistoryBatchChangesList — it mounts the real
 * MultitableWorkbench (heavy siblings stubbed, same pattern as
 * multitable-workbench-permission-wiring.spec.ts).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, computed, type App as VueApp, type Component } from 'vue'
import type { HistoryBatchDetail, HistoryBatchSummary } from '../src/multitable/types'

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any
let capsMock: any

const { mockListHistoryEvents, mockGetHistoryBatch } = vi.hoisted(() => ({
  mockListHistoryEvents: vi.fn(),
  mockGetHistoryBatch: vi.fn(),
}))

vi.mock('../src/multitable/api/client', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/api/client')>('../src/multitable/api/client')
  return {
    ...actual,
    multitableClient: {
      ...actual.multitableClient,
      listHistoryEvents: mockListHistoryEvents,
      getHistoryBatch: mockGetHistoryBatch,
    },
  }
})

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
    resolvingIds: ref([]), updatingIds: ref([]), deletingIds: ref([]), reactingKeys: ref([]),
    error: ref(null), loadComments: vi.fn(), addComment: vi.fn(),
    resolveComment: vi.fn(), deleteComment: vi.fn(), updateComment: vi.fn(), clearComments: vi.fn(),
    reactToComment: vi.fn(), unreactToComment: vi.fn(),
  }),
}))
vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: () => ({ reconnect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: () => ({ reconnect: vi.fn(), disconnect: vi.fn() }),
}))
vi.mock('../src/multitable/composables/useMultitableSheetPresence', () => ({
  useMultitableSheetPresence: () => ({
    presence: ref(null), activeUsers: ref([]), activeCollaborators: ref([]),
    activeCollaboratorCount: ref(0), remoteCursors: ref([]), remoteCursorsByCell: ref({}),
    setLocalCursor: vi.fn(), reconnect: vi.fn(), disconnect: vi.fn(),
  }),
}))
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    getAccessSnapshot: () => ({ userId: 'user_1', isAdmin: false, permissions: [] }),
  }),
}))
const { mockShowError, mockShowSuccess } = vi.hoisted(() => ({ mockShowError: vi.fn(), mockShowSuccess: vi.fn() }))
vi.mock('../src/composables/useToast', () => ({
  useToast: () => ({ showSuccess: mockShowSuccess, showError: mockShowError }),
}))

// Stub heavy sub-components that aren't under test — HistoryCenterModal (and its child
// HistoryBatchChangesList) are deliberately left REAL.
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
// MetaToast must expose showError/showSuccess — the workbench's local showError() calls the TEMPLATE
// REF's method (toastRef.value?.showError), not the useToast composable.
vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({ showError: mockShowError, showSuccess: mockShowSuccess })
      return () => h('div', { 'data-stub-MetaToast': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))

vi.mock('../src/multitable/import/bulk-import', () => ({ bulkImportRecords: vi.fn() }))

// The workbench subscribes to comment/mention realtime on sheet activation (watch immediate);
// the real module opens a socket via useAuth().getToken() — stub the subscribe entry points only.
vi.mock('../src/multitable/realtime/comments-realtime', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/realtime/comments-realtime')>(
    '../src/multitable/realtime/comments-realtime',
  )
  return {
    ...actual,
    subscribeToMultitableCommentSheetRealtime: vi.fn(() => () => {}),
    subscribeToMultitableCommentsRealtime: vi.fn(() => () => {}),
  }
})

const fields = [
  { id: 'fld_1', name: 'Title', type: 'string', property: {}, order: 0, options: [] },
  // layer-3 leak case: RBAC-denied via field_permissions (property says visible)
  { id: 'fld_2', name: 'SecretSalary', type: 'string', property: {}, order: 1, options: [] },
  // layer-2 leak case: property-hidden (RBAC says visible) — the History field list must
  // filter BOTH layers (layer-2 ∩ layer-3), not either one alone
  { id: 'fld_3', name: 'HiddenNotes', type: 'string', property: { hidden: true }, order: 2, options: [] },
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
      listSheetPermissions: vi.fn().mockResolvedValue({ items: [] }),
      listSheetPermissionCandidates: vi.fn().mockResolvedValue({ items: [] }),
      updateSheetPermission: vi.fn().mockResolvedValue({}),
      listFieldPermissions: vi.fn().mockResolvedValue({ items: [] }),
      updateFieldPermission: vi.fn().mockResolvedValue({}),
      listViewPermissions: vi.fn().mockResolvedValue({ items: [] }),
      updateViewPermission: vi.fn().mockResolvedValue({}),
      getRecord: vi.fn().mockRejectedValue(new Error('not mocked')),
      listCommentMentionSuggestions: vi.fn().mockResolvedValue({ items: [] }),
    },
  }
}

function createGridMock() {
  return {
    // fld_2 is RBAC-denied for the current actor (field_permissions, NOT property-hidden) — this is what
    // scopedAllFields consults (effectiveFieldPermissions) and propertyVisibleGridFields does NOT.
    fields: ref(fields),
    rows: ref([]), loading: ref(false),
    currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref(fields), sortRules: ref([]), filterRules: ref([]),
    filterGroups: ref([]), canLoadMore: ref(false), fieldOrder: ref([]), lastBatchId: ref(null),
    filterConjunction: ref('and'), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref([]), columnWidths: ref({}),
    linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref({ fld_2: { visible: false, readOnly: false } }),
    viewPermission: ref(null),
    rowActions: ref(null), rowActionOverrides: ref({}),
    capabilityOrigin: ref(null), conflict: ref(null),
    error: ref(null), sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(),
    addFilterRule: vi.fn(), updateFilterRule: vi.fn(), removeFilterRule: vi.fn(),
    clearFilters: vi.fn(), applySortFilter: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn(),
    createRecord: vi.fn(), deleteRecord: vi.fn(),
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(), retryConflict: vi.fn(),
    setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
    loadMore: vi.fn(), applyPatchResult: vi.fn(), applyRemoteRecordPatch: vi.fn(),
    bulkPatch: vi.fn(), duplicateRecord: vi.fn(), mergeRemoteRecord: vi.fn(),
    removeRemoteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    addFilterGroup: vi.fn(), removeFilterGroup: vi.fn(), updateFilterGroup: vi.fn(),
  }
}

describe('MultitableWorkbench -> HistoryCenterModal field-scope wiring', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  async function flushUi() {
    await nextTick(); await nextTick()
    await new Promise((r) => setTimeout(r, 20))
    await nextTick()
  }

  function batch(): HistoryBatchSummary {
    return {
      batchId: 'batch_1', sheetId: 'sheet_1', actorId: 'user_1', actorName: null, source: 'rest',
      action: 'update', createdAt: new Date().toISOString(), visibleAffectedRecordCount: 1,
      visibleAffectedFieldCount: 1, provenanceQuality: 'stamped',
    }
  }

  beforeEach(() => {
    mockListHistoryEvents.mockReset()
    mockGetHistoryBatch.mockReset()
    mockListHistoryEvents.mockResolvedValue({ batches: [batch()], total: 1, nextCursor: null, searchTruncated: false })
    const detail: HistoryBatchDetail = {
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_1', recordId: 'rec_1', action: 'update', version: 2,
        // fld_2 is post-mask ABSENT here too (LOCK-3 already drops it server-side); this test is about the
        // FE field-NAME leak specifically, so it focuses on the filter dropdown + a visible field's diff.
        changedFieldIds: ['fld_1'],
        before: { fld_1: 'Old' },
        after: { fld_1: 'New' },
      }],
    }
    mockGetHistoryBatch.mockResolvedValue(detail)

    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capsMock = {
      canRead: ref(true), canCreateRecord: ref(true), canEditRecord: ref(true),
      canDeleteRecord: ref(true), canManageFields: ref(true), canManageSheetAccess: ref(true),
      canManageViews: ref(true), canComment: ref(true), canManageAutomation: ref(false),
      canExport: ref(true),
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    // The workbench mirrors the selected record into the URL hash (#recordId=…) and deep-link-
    // bootstraps FROM it on mount — clear it so a prior test's selection can't auto-trigger
    // resolveDeepLink in the next mount (jsdom shares one window across this file).
    window.history.replaceState(null, '', window.location.pathname)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    vi.clearAllMocks()
  })

  it('the field-filter dropdown lists an RBAC-visible field but NOT a field denied via field_permissions', async () => {
    const MultitableWorkbench = (await import('../src/multitable/views/MultitableWorkbench.vue')).default

    app = createApp(defineComponent({
      setup() { return () => h(MultitableWorkbench as Component) },
    }))
    app.mount(container!)
    await flushUi()

    const historyBtn = container!.querySelector<HTMLButtonElement>('[data-action="open-history"]')
    expect(historyBtn).toBeTruthy()
    historyBtn!.click()
    await flushUi()

    expect(mockListHistoryEvents).toHaveBeenCalled()

    const fieldSelect = container!.querySelector<HTMLSelectElement>('[data-test="hist-filter-field"]')
    expect(fieldSelect).toBeTruthy()
    const optionTexts = Array.from(fieldSelect!.querySelectorAll('option')).map((o) => o.textContent)
    const optionValues = Array.from(fieldSelect!.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
    expect(optionTexts).toContain('Title') // fld_1 — visible on both layers
    expect(optionTexts).not.toContain('SecretSalary') // fld_2 — layer-3: denied via field_permissions
    expect(optionValues).not.toContain('fld_2')
    expect(optionTexts).not.toContain('HiddenNotes') // fld_3 — layer-2: property-hidden
    expect(optionValues).not.toContain('fld_3')

    // Expand the batch and confirm the visible field's diff label still resolves to its real name (the
    // fix must not regress the normal, non-denied path).
    const batchBtn = container!.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')
    expect(batchBtn).toBeTruthy()
    batchBtn!.click()
    await flushUi()
    const label = container!.querySelector('.meta-hist__diff-label')
    expect(label?.textContent).toContain('Title')
  })

  // ── PR-C: click-through from a batch-detail record chip to the record drawer ──
  async function mountAndExpandBatch() {
    const MultitableWorkbench = (await import('../src/multitable/views/MultitableWorkbench.vue')).default
    app = createApp(defineComponent({
      setup() { return () => h(MultitableWorkbench as Component) },
    }))
    app.mount(container!)
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-action="open-history"]')!.click()
    await flushUi()
    container!.querySelector<HTMLButtonElement>('[data-test="hist-batch"]')!.click()
    await flushUi()
    const chip = container!.querySelector<HTMLButtonElement>('button[data-test="hist-rec-label"]')
    expect(chip).toBeTruthy()
    return chip!
  }

  it('PR-C hit: clicking a record chip closes the History Center and selects the loaded record (no fetch, no toast)', async () => {
    gridMock.rows.value = [{ id: 'rec_1', version: 2, data: { fld_1: 'New' } }]
    const chip = await mountAndExpandBatch()
    chip.click()
    await flushUi()
    expect(container!.querySelector('[data-test="hist-filter-field"]')).toBeNull() // modal closed
    expect(mockShowError).not.toHaveBeenCalled()
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled() // in-page → no deep-link fetch
    expect(workbenchMock.selectSheet).not.toHaveBeenCalled() // same sheet — no switch
  })

  it('PR-C off-page record: resolveDeepLink fetches it via getRecord (no toast on success)', async () => {
    gridMock.rows.value = [] // rec_1 is NOT loaded → deep-link fetch path
    workbenchMock.client.getRecord.mockResolvedValue({
      record: { id: 'rec_1', version: 2, data: { fld_1: 'New' } },
      linkSummaries: {}, personSummaries: {}, attachmentSummaries: {},
      commentsScope: null, fieldPermissions: {}, viewPermissions: {}, rowActions: null,
    })
    const chip = await mountAndExpandBatch()
    chip.click()
    await flushUi()
    expect(container!.querySelector('[data-test="hist-filter-field"]')).toBeNull()
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_1', expect.anything())
    expect(mockShowError).not.toHaveBeenCalled()
  })

  it('PR-C gone/denied record: getRecord failure surfaces the existing not-found toast', async () => {
    gridMock.rows.value = []
    workbenchMock.client.getRecord.mockRejectedValue(new Error('404'))
    const chip = await mountAndExpandBatch()
    chip.click()
    await flushUi()
    expect(mockShowError).toHaveBeenCalledTimes(1)
    expect(String(mockShowError.mock.calls[0][0])).toContain('Record not found')
  })

  it('PR-C cross-sheet: switches the active sheet BEFORE locating (all-tables mode)', async () => {
    mockGetHistoryBatch.mockResolvedValue({
      batchId: 'batch_1', actorId: 'user_1', source: 'rest', createdAt: new Date().toISOString(),
      visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
      changes: [{
        sheetId: 'sheet_2', recordId: 'rec_other', action: 'update', version: 1,
        changedFieldIds: ['fld_1'], before: { fld_1: 'a' }, after: { fld_1: 'b' },
      }],
    } satisfies HistoryBatchDetail)
    workbenchMock.client.getRecord.mockResolvedValue({
      record: { id: 'rec_other', version: 1, data: { fld_1: 'b' } },
      linkSummaries: {}, personSummaries: {}, attachmentSummaries: {},
      commentsScope: null, fieldPermissions: {}, viewPermissions: {}, rowActions: null,
    })
    const chip = await mountAndExpandBatch()
    chip.click()
    await flushUi()
    expect(workbenchMock.selectSheet).toHaveBeenCalledWith('sheet_2')
    expect(mockShowError).not.toHaveBeenCalled()
  })
})
