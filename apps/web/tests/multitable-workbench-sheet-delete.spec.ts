import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Wire-drift lock for the sheet-delete entry (rail trash button → workbench). The rail only EMITS
// `delete-sheet(id)`; MultitableWorkbench.vue's `onDeleteSheet` is the untested link between that
// emit and the write. This spec asserts the REAL contract end to end through a capturing rail stub:
//
//   1. the rail receives `can-delete-sheet` from the capabilities composable (server-derived bit) and
//      `onDeleteSheet` as its listener;
//   2. confirm → `client.deleteSheet(id)` → success toast → when the deleted sheet is the ACTIVE one,
//      `workbench.loadBaseContext(activeBaseId)` re-pulls the base (NOT switchBase, which is a same-base
//      no-op) so the first remaining sheet gets selected server-side; a non-active delete re-pulls the
//      sheet list via `loadSheetMeta` instead;
//   3. cancel → nothing is called, nothing is toasted;
//   4. the coded refusals get plain-language toasts by CODE: 409 SHEET_PLUGIN_MANAGED (the managed-sheet
//      guard) and 404 SHEET_DELETED (stale list, which additionally re-pulls the list);
//   5. a false `canDeleteSheet` bit makes the handler a hard no-op even if the emit arrives (stale rail);
//   6. the bit is read off the /context capabilities object exactly like pitResetEnabled (fail-closed
//      `=== true`): an object without the key, or a legacy role-string source, hides the entry.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let capturedRailAttrs: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }) }
})

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}

let workbenchMock: any
let gridMock: any
// Everything below is a permissive admin so nothing else in the workbench gates the path under test.
// The delete bit itself is flipped per test on `workbenchMock.capabilities` (the /context object):
// the workbench derives `canDeleteSheet` from THAT object (`capabilitySource.value?.canDeleteSheet
// === true`, the pitResetEnabled shape), not from the capabilities composable.

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
    canManageAutomation: ref(false), canExport: ref(true), canSendNotification: ref(true),
    canDeleteSheet: ref(true),
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

// Capturing stub for the rail under wiring test — records the real props/listeners the workbench passes.
vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({
  default: defineComponent({
    name: 'MetaSheetViewRail',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedRailAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaSheetViewRail': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
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

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) { await Promise.resolve(); await nextTick() }
}

function apiError(status: number, code: string, message: string) {
  const err = new Error(message) as Error & { status?: number; code?: string; name: string }
  err.name = 'MultitableApiError'
  err.status = status
  err.code = code
  return err
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
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(), renameSheet: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      // The function under test:
      deleteSheet: vi.fn().mockResolvedValue({ deleted: 'sheet_orders' }),
    },
    sheets: ref([
      { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
      { id: 'sheet_archive', baseId: 'base_ops', name: 'Archive', description: null },
    ]),
    fields: ref([{ id: 'fld_title', name: 'Title', type: 'string' }]),
    views, activeBaseId, activeSheetId, activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
      canDeleteSheet: true,
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

type DeleteFn = (sheetId: string) => Promise<void>

describe('MultitableWorkbench sheet-delete handler wiring (rail delete-sheet → confirm → client.deleteSheet → re-pull)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let confirmSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    capturedRailAttrs = null
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

  async function mountAndGetDelete(): Promise<DeleteFn> {
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedRailAttrs).not.toBeNull()
    const onDeleteSheet = capturedRailAttrs!.onDeleteSheet as DeleteFn
    expect(typeof onDeleteSheet).toBe('function')
    // Mount-time init already issued one `loadBaseContext(activeBaseId, {...})` (the workbench's own
    // bootstrap). Zero the refresh spies HERE so every assertion below counts only what onDeleteSheet did.
    workbenchMock.loadBaseContext.mockClear()
    workbenchMock.loadSheetMeta.mockClear()
    workbenchMock.switchBase.mockClear()
    return onDeleteSheet
  }

  it('passes the server-derived canDeleteSheet bit to the rail as `can-delete-sheet` (and a false bit hides it)', async () => {
    await mountAndGetDelete()
    expect(capturedRailAttrs!['can-delete-sheet']).toBe(true)
    workbenchMock.capabilities.value = { ...workbenchMock.capabilities.value, canDeleteSheet: false }
    await flushUi()
    expect(capturedRailAttrs!['can-delete-sheet']).toBe(false)
  })

  it('fails CLOSED when the /context object carries no canDeleteSheet key (old backend), even though the capabilities composable says true', async () => {
    const { canDeleteSheet: _dropped, ...withoutKey } = workbenchMock.capabilities.value
    workbenchMock.capabilities.value = withoutKey
    const onDeleteSheet = await mountAndGetDelete()
    expect(capturedRailAttrs!['can-delete-sheet']).toBe(false)
    await onDeleteSheet('sheet_orders')
    await flushUi()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(workbenchMock.client.deleteSheet).not.toHaveBeenCalled()
  })

  it('ACTIVE sheet: confirm → deleteSheet(id) → success toast → loadBaseContext(activeBaseId) (never switchBase / never loadSheetMeta)', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    await onDeleteSheet('sheet_orders')
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    // The confirm names the sheet and states the consequence + admin-only API restore.
    const prompt = String(confirmSpy.mock.calls[0]?.[0])
    expect(prompt).toContain('Orders')
    expect(prompt).toMatch(/administrator/i)

    expect(workbenchMock.client.deleteSheet).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.deleteSheet).toHaveBeenCalledWith('sheet_orders')
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).not.toHaveBeenCalled()
    // Base re-pull is the ONLY refresh path for the active sheet: switchBase would short-circuit
    // (same base, no sheetId ⇒ return true) and leave the workbench on a sheet that no longer exists.
    expect(workbenchMock.loadBaseContext).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadBaseContext).toHaveBeenCalledWith('base_ops')
    expect(workbenchMock.switchBase).not.toHaveBeenCalled()
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  it('NON-active sheet: confirm → deleteSheet(id) → loadSheetMeta(activeSheetId) re-pulls the list; the base is not re-pulled', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    workbenchMock.client.deleteSheet.mockResolvedValueOnce({ deleted: 'sheet_archive' })
    await onDeleteSheet('sheet_archive')
    await flushUi()

    expect(String(confirmSpy.mock.calls[0]?.[0])).toContain('Archive')
    expect(workbenchMock.client.deleteSheet).toHaveBeenCalledWith('sheet_archive')
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledWith('sheet_orders')
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalled()
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
  })

  it('cancel → NO request, NO refresh, NO toast', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    confirmSpy.mockReturnValueOnce(false)
    await onDeleteSheet('sheet_orders')
    await flushUi()

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.deleteSheet).not.toHaveBeenCalled()
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalled()
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
    expect(showSuccessSpy).not.toHaveBeenCalled()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('409 SHEET_PLUGIN_MANAGED → the plain-language managed-sheet toast (by CODE, not the server prose), no refresh, no success', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    workbenchMock.client.deleteSheet.mockRejectedValueOnce(
      apiError(409, 'SHEET_PLUGIN_MANAGED', 'This sheet is provisioned and owned by a plugin and cannot be deleted from the UI or the sheet API.'),
    )
    await onDeleteSheet('sheet_orders')
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    const msg = String(showErrorSpy.mock.calls[0]?.[0])
    expect(msg).toBe('This sheet is managed by a plugin and cannot be deleted from the UI.')
    expect(showSuccessSpy).not.toHaveBeenCalled()
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalled()
    expect(workbenchMock.loadSheetMeta).not.toHaveBeenCalled()
  })

  it('404 SHEET_DELETED (stale list) → the already-deleted toast AND a list re-pull; no success', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    workbenchMock.client.deleteSheet.mockRejectedValueOnce(apiError(404, 'SHEET_DELETED', 'This sheet has been deleted.'))
    await onDeleteSheet('sheet_archive')
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(String(showErrorSpy.mock.calls[0]?.[0])).toMatch(/already deleted/i)
    expect(workbenchMock.loadSheetMeta).toHaveBeenCalledTimes(1)
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalled()
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })

  it('other failures surface the server message (403 FORBIDDEN prose) through showError; no refresh', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    workbenchMock.client.deleteSheet.mockRejectedValueOnce(apiError(403, 'FORBIDDEN', 'Deleting a sheet requires schema authority.'))
    await onDeleteSheet('sheet_orders')
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledWith('Deleting a sheet requires schema authority.')
    expect(workbenchMock.loadBaseContext).not.toHaveBeenCalled()
  })

  it('a false canDeleteSheet bit makes the handler a hard no-op — no confirm, no request (stale-rail defence)', async () => {
    const onDeleteSheet = await mountAndGetDelete()
    workbenchMock.capabilities.value = { ...workbenchMock.capabilities.value, canDeleteSheet: false }
    await flushUi()
    await onDeleteSheet('sheet_orders')
    await flushUi()

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(workbenchMock.client.deleteSheet).not.toHaveBeenCalled()
  })
})
