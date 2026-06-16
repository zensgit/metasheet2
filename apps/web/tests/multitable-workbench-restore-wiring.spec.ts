import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Wire-drift lock for record restore (#2662). The drawer emits
// `restore { recordId, targetVersion, expectedVersion }`; the workbench's
// `onRestoreRecordVersion` handler is the ONLY untested link between that emit
// and `client.restoreRecordVersion` — drawer-emit (meta-record-drawer-restore.spec)
// and the client call (multitable-record-restore-client.spec) are covered, the
// backend is covered by the restore integration matrix, but the handler that
// threads the payload through (and confirm / success / noop / error / refresh)
// was tested nowhere. This captures the real `@restore` listener the workbench
// wires down and asserts the payload round-trips into the exact client args.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

// Capture the real listeners/props the workbench passes to MetaRecordDrawer.
let capturedDrawerAttrs: Record<string, unknown> | null = null

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

vi.mock('../src/multitable/components/MetaViewTabBar.vue', () => ({ default: stubComponent('MetaViewTabBar') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
// Capturing stub for the component under wiring test — records the real listeners.
vi.mock('../src/multitable/components/MetaRecordDrawer.vue', () => ({
  default: defineComponent({
    name: 'MetaRecordDrawer',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedDrawerAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaRecordDrawer': 'true' })
    },
  }),
}))
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

async function flushUi(cycles = 5): Promise<void> {
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
      // The function under test:
      restoreRecordVersion: vi.fn().mockResolvedValue({ recordId: 'rec_42', newVersion: 6, noop: false, restoredFieldIds: ['fld_title'], skippedFieldIds: [] }),
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
    filterRules: ref([]), filterConjunction: ref('and'), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupField: ref(null), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), attachmentSummaries: ref({}),
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

type RestoreFn = (p: { recordId: string; targetVersion: number; expectedVersion: number }) => Promise<void>

describe('MultitableWorkbench record-restore handler wiring (#2662)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let confirmSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedDrawerAttrs = null
    confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
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

  async function mountAndGetRestore(): Promise<RestoreFn> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedDrawerAttrs).not.toBeNull()
    const onRestore = capturedDrawerAttrs!.onRestore as RestoreFn
    expect(typeof onRestore).toBe('function')
    return onRestore
  }

  it('threads the emitted payload into client.restoreRecordVersion(sheetId, recordId, targetVersion, expectedVersion, fieldIds) — exact positions (wire-drift lock)', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(workbenchMock.client.restoreRecordVersion).toHaveBeenCalledTimes(1)
    // Active sheet from the workbench + the three payload fields, in order, + fieldIds (undefined for
    // a full restore). A reorder (e.g. target/expected swapped) would silently corrupt restore — caught.
    expect(workbenchMock.client.restoreRecordVersion).toHaveBeenCalledWith('sheet_orders', 'rec_42', 2, 5, undefined)
    // success branch: toast + grid refresh
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy.mock.calls[0][0]).toMatch(/Restored|已恢复/)
    expect(gridMock.loadViewData).toHaveBeenCalledWith(0)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('threads a per-field selection (fieldIds) through to the client (Arc1·S2)', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5, fieldIds: ['fld_a', 'fld_b'] })
    await flushUi()
    expect(workbenchMock.client.restoreRecordVersion).toHaveBeenCalledWith('sheet_orders', 'rec_42', 2, 5, ['fld_a', 'fld_b'])
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the user cancels the confirm', async () => {
    confirmSpy.mockReturnValue(false)
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(workbenchMock.client.restoreRecordVersion).not.toHaveBeenCalled()
    expect(showSuccessSpy).not.toHaveBeenCalled()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('does nothing when there is no active sheet', async () => {
    const onRestore = await mountAndGetRestore()
    workbenchMock.activeSheetId.value = null
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(workbenchMock.client.restoreRecordVersion).not.toHaveBeenCalled()
  })

  it('surfaces the noop branch distinctly from a real restore', async () => {
    workbenchMock.client.restoreRecordVersion.mockResolvedValueOnce({ recordId: 'rec_42', newVersion: 5, noop: true, restoredFieldIds: [], skippedFieldIds: [] })
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 5, expectedVersion: 5 })
    await flushUi()
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy.mock.calls[0][0]).toMatch(/Already at this version|已是该版本/)
  })

  it('surfaces the backend error message (e.g. VERSION_CONFLICT) and does not refresh', async () => {
    workbenchMock.client.restoreRecordVersion.mockRejectedValueOnce(new Error('Record is at version 6, expected 5'))
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy.mock.calls[0][0]).toBe('Record is at version 6, expected 5')
    expect(gridMock.loadViewData).not.toHaveBeenCalled()
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })
})
