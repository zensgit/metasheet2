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

// Capture the real listeners/props the workbench passes to MetaRecordDrawer + RestorePreviewDialog + (BS-4) the
// MetaGridTable bulk bar + the RestoreBatchDialog.
let capturedDrawerAttrs: Record<string, unknown> | null = null
let capturedDialogAttrs: Record<string, unknown> | null = null
let capturedGridAttrs: Record<string, unknown> | null = null
let capturedBatchDialogAttrs: Record<string, unknown> | null = null

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
// Capturing stub for the grid — records the @bulk-restore listener (onBulkRestoreRequest), the BS-4 entry point.
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
// Capturing stub for the BS-4 batch panel — records visible/executable + the @preview-version/@confirm listeners.
vi.mock('../src/multitable/components/RestoreBatchDialog.vue', () => ({
  default: defineComponent({
    name: 'RestoreBatchDialog',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedBatchDialogAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-RestoreBatchDialog': 'true' })
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
      // BS-4 batch chain: preview returns a RESTORABLE scope [A,C] (B skipped) + per-record previewVersion; execute echoes a result.
      restoreBatchPreview: vi.fn().mockResolvedValue({ records: [{ recordId: 'A', status: 'restorable', previewVersion: 2 }, { recordId: 'B', status: 'skipped', skipReason: 'no_change' }, { recordId: 'C', status: 'restorable', previewVersion: 5 }], scope: ['A', 'C'], restorableCount: 2, skippedCount: 1, targetVersion: 1, previewIdentity: 'tok_batch' }),
      restoreBatchExecute: vi.fn().mockResolvedValue({ records: [{ recordId: 'A', status: 'restored', newVersion: 3 }, { recordId: 'C', status: 'restored', newVersion: 6 }], restoredCount: 2, skippedCount: 0, targetVersion: 1 }),
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

// BS-4: the REAL workbench batch wire — the lock the helper + dialog specs don't provide. Mounts the workbench,
// captures the grid's @bulk-restore + the batch dialog's @preview-version/@confirm, and asserts the EXACT client
// call chain (so a future edit that executes the original selected ids, or builds expectedVersions from the wrong
// list, or drifts the identity position, fails here).
describe('MultitableWorkbench BATCH-restore handler wiring (bulk → preview → confirm → execute)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedGridAttrs = null
    capturedBatchDialogAttrs = null
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

  async function mountAndGetBulkRestore(): Promise<(ids: string[]) => Promise<void> | void> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedGridAttrs).not.toBeNull()
    const onBulkRestore = capturedGridAttrs!.onBulkRestore as (ids: string[]) => Promise<void> | void
    expect(typeof onBulkRestore).toBe('function')
    return onBulkRestore
  }

  it('locks the chain: preview(SELECTED, v1) → advanced re-preview(SELECTED, N) → execute(SCOPE, expectedVersions-from-previewVersion, identity)', async () => {
    const onBulkRestore = await mountAndGetBulkRestore()
    // 1. bulk restore previews the ORIGINAL selected ids at v1 (default revert-to-original).
    await onBulkRestore(['A', 'B', 'C']); await flushUi()
    expect(workbenchMock.client.restoreBatchPreview).toHaveBeenCalledWith('sheet_orders', ['A', 'B', 'C'], 1)
    expect(capturedBatchDialogAttrs!.visible).toBe(true)
    expect(capturedBatchDialogAttrs!.executable).toBe(true)
    // 2. Advanced re-preview uses the target version N + the SAME original selected ids (not the scope).
    await (capturedBatchDialogAttrs!.onPreviewVersion as (v: number) => void)(3); await flushUi()
    expect(workbenchMock.client.restoreBatchPreview).toHaveBeenLastCalledWith('sheet_orders', ['A', 'B', 'C'], 3)
    // 3. confirm executes over the preview's SCOPE (['A','C']) — NOT the selected ids; expectedVersions are exactly
    //    each restorable record's previewVersion ({A:2,C:5}); targetVersion is the re-previewed 3; identity is the
    //    5th positional arg. A reorder/wrong-source on ANY of these fails here.
    await (capturedBatchDialogAttrs!.onConfirm as () => void)(); await flushUi()
    expect(workbenchMock.client.restoreBatchExecute).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.restoreBatchExecute).toHaveBeenCalledWith('sheet_orders', ['A', 'C'], 3, { A: 2, C: 5 }, 'tok_batch')
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(gridMock.loadViewData).toHaveBeenCalled()
  })

  it('confirm NEVER executes the original selected ids — the skipped record B is excluded (scope-not-selection lock)', async () => {
    const onBulkRestore = await mountAndGetBulkRestore()
    await onBulkRestore(['A', 'B', 'C']); await flushUi()
    await (capturedBatchDialogAttrs!.onConfirm as () => void)(); await flushUi()
    const call = (workbenchMock.client.restoreBatchExecute as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[1]).toEqual(['A', 'C']) // the scope, not ['A','B','C']
    expect(call[1]).not.toContain('B') // the skipped record is never written
    expect(call[3]).toEqual({ A: 2, C: 5 }) // expectedVersions has no B either
  })

  it('a non-executable preview (empty restorable scope → previewIdentity null) cannot execute even if confirm is forced', async () => {
    workbenchMock.client.restoreBatchPreview.mockResolvedValueOnce({ records: [{ recordId: 'A', status: 'skipped', skipReason: 'no_change' }], scope: [], restorableCount: 0, skippedCount: 1, targetVersion: 1, previewIdentity: null })
    const onBulkRestore = await mountAndGetBulkRestore()
    await onBulkRestore(['A']); await flushUi()
    expect(capturedBatchDialogAttrs!.executable).toBe(false)
    await (capturedBatchDialogAttrs!.onConfirm as () => void)(); await flushUi()
    expect(workbenchMock.client.restoreBatchExecute).not.toHaveBeenCalled()
  })

  it('[P3] FE fail-closed: a scope record missing previewVersion blocks execute (incomplete expectedVersions never sent)', async () => {
    // executable (identity present) but a restorable scope record has NO previewVersion → expectedVersions would be
    // incomplete → the FE guard blocks the execute (rather than letting the server 400).
    workbenchMock.client.restoreBatchPreview.mockResolvedValueOnce({ records: [{ recordId: 'A', status: 'restorable' }], scope: ['A'], restorableCount: 1, skippedCount: 0, targetVersion: 1, previewIdentity: 'tok_batch' })
    const onBulkRestore = await mountAndGetBulkRestore()
    await onBulkRestore(['A']); await flushUi()
    await (capturedBatchDialogAttrs!.onConfirm as () => void)(); await flushUi()
    expect(workbenchMock.client.restoreBatchExecute).not.toHaveBeenCalled() // incomplete expectedVersions never sent
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('out-of-order Advanced previews: a stale earlier-version response never overwrites the latest (seq guard)', async () => {
    const onBulkRestore = await mountAndGetBulkRestore()
    await onBulkRestore(['A', 'B', 'C']); await flushUi() // initial v1 preview (default mock)
    // race: v3 deferred, v4 resolves first → v3's late response must be dropped.
    let resolveV3!: (v: unknown) => void
    workbenchMock.client.restoreBatchPreview
      .mockReturnValueOnce(new Promise((r) => { resolveV3 = r as (v: unknown) => void }))
      .mockResolvedValueOnce({ records: [{ recordId: 'C', status: 'restorable', previewVersion: 5 }], scope: ['C'], restorableCount: 1, skippedCount: 0, targetVersion: 4, previewIdentity: 'tok_v4' })
    await (capturedBatchDialogAttrs!.onPreviewVersion as (v: number) => void)(3)
    await (capturedBatchDialogAttrs!.onPreviewVersion as (v: number) => void)(4); await flushUi() // v4 applies
    resolveV3({ records: [{ recordId: 'A', status: 'restorable', previewVersion: 2 }, { recordId: 'B', status: 'restorable', previewVersion: 3 }], scope: ['A', 'B'], restorableCount: 2, skippedCount: 0, targetVersion: 3, previewIdentity: 'tok_v3' })
    await flushUi() // the stale v3 now resolves — must be dropped, not overwrite v4
    await (capturedBatchDialogAttrs!.onConfirm as () => void)(); await flushUi()
    // confirm executes the v4 scope + identity, NOT the stale v3 (['A','B'] / tok_v3)
    expect(workbenchMock.client.restoreBatchExecute).toHaveBeenCalledWith('sheet_orders', ['C'], 4, { C: 5 }, 'tok_v4')
  })
})
