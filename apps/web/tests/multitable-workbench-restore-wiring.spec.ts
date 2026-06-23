import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Wire-drift lock for record restore. The drawer emits `restore { recordId, targetVersion, expectedVersion[, fieldIds] }`;
// the workbench's `onRestoreRecordVersion` is the ONLY untested link between that emit and the restore chain.
//
// Post slice-2 (#3042): full-record AND per-field both go through preview → confirm(panel) → execute — there is no
// `window.confirm` and no direct `client.restoreRecordVersion` from this handler anymore. This spec asserts the
// REAL contract: onRestore → `client.restorePreviewRecord(sheetId, recordId, targetVersion, fieldIds)` opens the
// RestorePreviewDialog; confirming it → `client.restoreExecuteRecord(sheetId, recordId, targetVersion,
// expectedVersion, previewIdentity, fieldIds)`; success → toast + grid refresh; cancel / no-identity → no execute.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

// Capture the real listeners/props the workbench passes to MetaRecordDrawer + RestorePreviewDialog.
let capturedDrawerAttrs: Record<string, unknown> | null = null
let capturedDialogAttrs: Record<string, unknown> | null = null

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
// Capturing stub for the drawer under wiring test — records the real listeners.
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
// Capturing stub for the restore confirm panel — records the props (visible/executable/changes) + the @confirm/@cancel
// listeners. No props/emits declared, so everything falls through to attrs (same trick as the drawer stub).
vi.mock('../src/multitable/components/RestorePreviewDialog.vue', () => ({
  default: defineComponent({
    name: 'RestorePreviewDialog',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedDialogAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-RestorePreviewDialog': 'true' })
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

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

const PREVIEW_OK = {
  changes: [{ fieldId: 'fld_title', op: 'set', value: 'old' }],
  visibleAffectedFieldCount: 1, schemaDrift: false, targetVersion: 2, previewIdentity: 'tok_preview',
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
      // The functions under test (the slice-2 chain):
      restorePreviewRecord: vi.fn().mockResolvedValue({ ...PREVIEW_OK }),
      restoreExecuteRecord: vi.fn().mockResolvedValue({ recordId: 'rec_42', newVersion: 6, noop: false, restoredFieldIds: ['fld_title'] }),
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
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

type RestoreFn = (p: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }) => Promise<void>

describe('MultitableWorkbench record-restore handler wiring (preview→execute, slice 2)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedDrawerAttrs = null
    capturedDialogAttrs = null
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
  const confirmDialog = async () => { await (capturedDialogAttrs!.onConfirm as () => void)(); await flushUi() }
  const cancelDialog = async () => { await (capturedDialogAttrs!.onCancel as () => void)(); await flushUi() }

  it('full-record: onRestore opens a PREVIEW (restorePreviewRecord with fieldIds undefined), not a direct restore', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    // The preview is the FIRST call — exact positions; a reorder (target/expected) would silently corrupt restore.
    expect(workbenchMock.client.restorePreviewRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.restorePreviewRecord).toHaveBeenCalledWith('sheet_orders', 'rec_42', 2, undefined)
    // No write yet, and no legacy direct path.
    expect(workbenchMock.client.restoreExecuteRecord).not.toHaveBeenCalled()
    expect((workbenchMock.client as Record<string, unknown>).restoreRecordVersion).toBeUndefined()
    // The confirm panel is shown + executable (the preview returned an identity).
    expect(capturedDialogAttrs!.visible).toBe(true)
    expect(capturedDialogAttrs!.executable).toBe(true)
  })

  it('per-field: the fieldIds selection is threaded into the preview', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5, fieldIds: ['fld_a', 'fld_b'] })
    await flushUi()
    expect(workbenchMock.client.restorePreviewRecord).toHaveBeenCalledWith('sheet_orders', 'rec_42', 2, ['fld_a', 'fld_b'])
  })

  it('confirming the panel executes via restoreExecuteRecord (identity + fieldIds, exact positions) + refresh', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5, fieldIds: ['fld_a', 'fld_b'] })
    await flushUi()
    await confirmDialog()
    expect(workbenchMock.client.restoreExecuteRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.restoreExecuteRecord).toHaveBeenCalledWith('sheet_orders', 'rec_42', 2, 5, 'tok_preview', ['fld_a', 'fld_b'])
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy.mock.calls[0][0]).toMatch(/Restored|已恢复/)
    expect(gridMock.loadViewData).toHaveBeenCalledWith(0)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('cancelling the panel writes nothing', async () => {
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    await cancelDialog()
    expect(workbenchMock.client.restoreExecuteRecord).not.toHaveBeenCalled()
    expect(capturedDialogAttrs!.visible).toBe(false)
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })

  it('no active sheet → no preview', async () => {
    const onRestore = await mountAndGetRestore()
    workbenchMock.activeSheetId.value = null
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(workbenchMock.client.restorePreviewRecord).not.toHaveBeenCalled()
  })

  it('a non-executable preview (schema drift → previewIdentity null) cannot execute even if confirm is forced', async () => {
    workbenchMock.client.restorePreviewRecord.mockResolvedValueOnce({ ...PREVIEW_OK, schemaDrift: true, previewIdentity: null })
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    expect(capturedDialogAttrs!.executable).toBe(false) // dialog blocks confirm; handler also guards on identity
    await confirmDialog()
    expect(workbenchMock.client.restoreExecuteRecord).not.toHaveBeenCalled()
  })

  it('the noop branch (execute → noop) is surfaced distinctly from a real restore', async () => {
    workbenchMock.client.restoreExecuteRecord.mockResolvedValueOnce({ recordId: 'rec_42', newVersion: 5, noop: true, restoredFieldIds: [] })
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 5, expectedVersion: 5 })
    await flushUi()
    await confirmDialog()
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy.mock.calls[0][0]).toMatch(/Already at this version|已是该版本/)
  })

  it('surfaces an execute error (e.g. VERSION_CONFLICT) and does not refresh', async () => {
    workbenchMock.client.restoreExecuteRecord.mockRejectedValueOnce(new Error('Record is at version 6, expected 5'))
    const onRestore = await mountAndGetRestore()
    await onRestore({ recordId: 'rec_42', targetVersion: 2, expectedVersion: 5 })
    await flushUi()
    await confirmDialog()
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy.mock.calls[0][0]).toBe('Record is at version 6, expected 5')
    expect(gridMock.loadViewData).not.toHaveBeenCalled()
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })
})
