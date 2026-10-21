/**
 * Bulk-delete "false success" fix (矩阵 #8): `onBulkDelete` in MultitableWorkbench used to
 * `Promise.all(recordIds.map((rid) => grid.deleteRecord(rid)))` inside a try/catch and always show
 * the SUCCESS toast on the resolved branch — `grid.deleteRecord` (useMultitableGrid.ts) never rejects
 * (it catches internally and resolves `false` on failure), so a partial or total failure surfaced a
 * green "N records deleted" toast for records that were never deleted, with no red toast and no
 * refresh to reconcile the grid with what the server actually did.
 *
 * The fix inspects each `deleteRecord` boolean result: only the records that actually resolved `true`
 * are counted toward the success toast; any `false` results drive a red toast (using `grid.error.value`
 * when the composable set one, else a generic fallback) AND a `reloadCurrentPage()` so the grid reflects
 * reality instead of a stale optimistic state.
 *
 * Follows the same mount-the-real-workbench + capturing-stub-for-MetaGridTable pattern as
 * multitable-workbench-restore-wiring.spec.ts (capturedGridAttrs!.onBulkDelete is the real handler,
 * not a re-implementation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let capturedGridAttrs: Record<string, unknown> | null = null

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
// Capturing stub for the grid — records the @bulk-delete listener (onBulkDelete), the handler under test.
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
import { recordsDeleted } from '../src/multitable/utils/workbench-labels'
import { useLocale } from '../src/composables/useLocale'

// `selected-record-id` (kebab) is the raw template key: the capturing stub declares no props, so the
// binding lands in `attrs` exactly as written at MultitableWorkbench.vue:292.
function selectedRecordIdProp(): unknown {
  return (capturedGridAttrs as Record<string, unknown>)['selected-record-id']
}

// The green toast copy is `recordsDeleted(n, isZh)`. Asserting the exact formatted string (rather
// than 'does not contain 3') pins N itself: swapping deletedIds.length for failedIds.length, or for
// a hard-coded 0/recordIds.length, changes this string and turns the test red.
function expectDeletedToast(n: number): void {
  expect(showSuccessSpy.mock.calls[0]?.[0]).toBe(recordsDeleted(n, useLocale().isZh.value))
}

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
  }
}

describe('MultitableWorkbench bulk-delete: report actual per-record results, not blanket success (矩阵 #8)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedGridAttrs = null
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

  async function mountAndGetBulkDelete(): Promise<(ids: string[]) => Promise<void> | void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedGridAttrs).not.toBeNull()
    const onBulkDelete = capturedGridAttrs!.onBulkDelete as (ids: string[]) => Promise<void> | void
    expect(typeof onBulkDelete).toBe('function')
    return onBulkDelete
  }

  it('all records fail: no green toast, a red toast, and the grid reloads to reconcile', async () => {
    gridMock.deleteRecord = vi.fn().mockResolvedValue(false)
    gridMock.error.value = 'Record is locked'
    const onBulkDelete = await mountAndGetBulkDelete()

    await onBulkDelete(['r1', 'r2', 'r3'])
    await flushUi()

    expect(gridMock.deleteRecord).toHaveBeenCalledTimes(3)
    expect(showSuccessSpy).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).toHaveBeenCalledWith('Record is locked')
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
  })

  it('partial failure: the green toast counts only the SUCCESSFUL deletes, plus a red toast and a reload', async () => {
    gridMock.deleteRecord = vi.fn(async (rid: string) => rid !== 'r2')
    const onBulkDelete = await mountAndGetBulkDelete()

    await onBulkDelete(['r1', 'r2', 'r3'])
    await flushUi()

    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    // exactly 2 (r1, r3) — not 3 (the pre-fix blanket count) and not 1 (the failed count)
    expectDeletedToast(2)
    expect(showSuccessSpy.mock.calls[0][0]).not.toMatch(/3/)
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
  })

  it('all records succeed: only the green toast fires, no red toast, no reload', async () => {
    gridMock.deleteRecord = vi.fn().mockResolvedValue(true)
    const onBulkDelete = await mountAndGetBulkDelete()

    // Three records here on purpose: the partial-failure case above also lands on 2 successes,
    // so a hard-coded `fmtRecordsDeleted(2, …)` would pass both. 3 vs 2 pins the count itself.
    await onBulkDelete(['r1', 'r2', 'r3'])
    await flushUi()

    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expectDeletedToast(3)
    expect(showErrorSpy).not.toHaveBeenCalled()
    expect(gridMock.reloadCurrentPage).not.toHaveBeenCalled()
  })

  it('a selected record that FAILED to delete stays selected (the guard reads deletedIds, not the requested ids)', async () => {
    // Pins the `deletedIds.includes(...)` half of the contract: with the pre-fix
    // `recordIds.includes(...)` the inspector would close for a record the server still holds —
    // the same "false success" class of bug as the blanket green toast.
    gridMock.deleteRecord = vi.fn(async (rid: string) => rid !== 'r2')
    const onBulkDelete = await mountAndGetBulkDelete()

    ;(capturedGridAttrs!.onSelectRecord as (rid: string) => void)('r2')
    await flushUi()
    expect(selectedRecordIdProp()).toBe('r2')

    await onBulkDelete(['r1', 'r2'])
    await flushUi()

    expect(selectedRecordIdProp()).toBe('r2')
  })

  it('a selected record that WAS deleted clears the selection', async () => {
    // The other direction, so the test above cannot be satisfied by simply never clearing.
    gridMock.deleteRecord = vi.fn().mockResolvedValue(true)
    const onBulkDelete = await mountAndGetBulkDelete()

    ;(capturedGridAttrs!.onSelectRecord as (rid: string) => void)('r2')
    await flushUi()
    expect(selectedRecordIdProp()).toBe('r2')

    await onBulkDelete(['r1', 'r2'])
    await flushUi()

    expect(selectedRecordIdProp()).toBeNull()
  })

  it('a bulk delete with no grid.error set falls back to the generic bulk-delete-failed copy', async () => {
    gridMock.deleteRecord = vi.fn().mockResolvedValue(false)
    gridMock.error.value = null
    const onBulkDelete = await mountAndGetBulkDelete()

    await onBulkDelete(['r1'])
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    const msg = showErrorSpy.mock.calls[0][0] as string
    expect(msg.length).toBeGreaterThan(0)
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })
})
