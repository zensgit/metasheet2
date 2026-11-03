/**
 * 复制数据表 S1 — MultitableWorkbench wiring (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md
 * CS-2 entries ① / ②, §3 result).
 *
 * Capturing stubs for the rail and the dialog record the REAL props/listeners the workbench passes, so
 * this spec pins the links the component specs cannot see:
 *   1. `canCopySheet` is read off the /context capabilities object (`=== true`, the canDeleteSheet shape):
 *      absent / false / a legacy role-string source -> the rail gets `can-copy-sheet: false`, the rail's
 *      emit is a hard no-op, and entry ② (the 「存为模板」 hand-off link) is not rendered;
 *   2. entry ① (rail `copy-sheet`) opens the dialog pinned to the ACTIVE sheet (stale ids refused);
 *   3. entry ② closes the 存为模板 dialog and opens the copy dialog;
 *   4. success (`copied`) refreshes the sheet list AND selects the copy through syncExternalContext —
 *      the onCreateSheet path — then toasts; a replay / a failed formula recompute are disclosed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { CopySheetResult } from '../src/multitable/types'

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()

let capturedRailAttrs: Record<string, unknown> | null = null
let capturedCopyDialogAttrs: Record<string, unknown> | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
    RouterLink: defineComponent({ props: ['to'], setup(_, { slots }) { return () => h('a', {}, slots.default?.()) } }),
  }
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
    canManageAutomation: ref(false), canExport: ref(true), canSendNotification: ref(true),
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
vi.mock('../src/multitable/components/MetaCopySheetDialog.vue', () => ({
  default: defineComponent({
    name: 'MetaCopySheetDialog',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedCopyDialogAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaCopySheetDialog': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
vi.mock('../src/multitable/components/SheetTrashModal.vue', () => ({ default: stubComponent('SheetTrashModal') }))
vi.mock('../src/multitable/components/HistoryCenterModal.vue', () => ({ default: stubComponent('HistoryCenterModal') }))
vi.mock('../src/multitable/components/MetaConfigHistoryModal.vue', () => ({ default: stubComponent('MetaConfigHistoryModal') }))
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
// Capturing: its `update:dirty` listener is how this spec puts an unsaved draft on the workbench.
let capturedImportAttrs: Record<string, unknown> | null = null
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({
  default: defineComponent({
    name: 'MetaImportModal',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      capturedImportAttrs = attrs as Record<string, unknown>
      return () => h('div', { 'data-stub-MetaImportModal': 'true' })
    },
  }),
}))
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

function createWorkbenchMock(capabilities: unknown) {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref<string | null>('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([{ id: 'view_grid', sheetId: 'sheet_orders', name: '表格', type: 'grid' }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: '备料' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_ops' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(), renameSheet: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      getConfigHistory: vi.fn().mockResolvedValue([]),
      dryRunCopySheet: vi.fn(), copySheet: vi.fn(),
    },
    sheets: ref([
      { id: 'sheet_orders', baseId: 'base_ops', name: '订单', description: null },
      { id: 'sheet_archive', baseId: 'base_ops', name: '归档', description: null },
    ]),
    fields: ref([{ id: 'fld_title', name: '标题', type: 'string' }, { id: 'fld_qty', name: '数量', type: 'number' }]),
    views, activeBaseId, activeSheetId, activeViewId,
    capabilities: ref(capabilities),
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

const FULL_CAPS = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
  canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
}

function copyResult(overrides: Partial<CopySheetResult> = {}): CopySheetResult {
  return {
    sheet: { id: 'sheet_copy', baseId: 'base_ops', name: '订单 副本' },
    replayed: false,
    formulaRecompute: null,
    summary: { rowCount: 1239, fieldCount: 2, permissionRowCount: 3, recordPermissionRowCount: 1 },
    ...overrides,
  }
}

describe('MultitableWorkbench × 复制数据表 S1 wiring', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    gridMock = createGridMock()
    capturedRailAttrs = null
    capturedCopyDialogAttrs = null
    capturedImportAttrs = null
    vi.stubGlobal('confirm', vi.fn(() => true))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    showErrorSpy.mockReset()
    showSuccessSpy.mockReset()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    useLocale().setLocale('en')
  })

  async function mount(capabilities: unknown): Promise<void> {
    workbenchMock = createWorkbenchMock(capabilities)
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(capturedRailAttrs).not.toBeNull()
    expect(capturedCopyDialogAttrs).not.toBeNull()
  }

  const railCopy = () => capturedRailAttrs!.onCopySheet as (id: string) => void
  const dialogVisible = () => capturedCopyDialogAttrs!.visible

  async function openSaveAsTemplate(): Promise<void> {
    const toolbarButton = container!.querySelector('[data-action="save-sheet-as-template"]') as HTMLButtonElement
    expect(toolbarButton).not.toBeNull()
    toolbarButton.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="save-sheet-as-template-dialog"]')).not.toBeNull()
  }

  it('passes canCopySheet to the rail and wires the dialog to the live client', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    expect(capturedRailAttrs!['can-copy-sheet']).toBe(true)
    expect(typeof capturedRailAttrs!.onCopySheet).toBe('function')
    expect(capturedCopyDialogAttrs!.client).toBe(workbenchMock.client)
    expect(dialogVisible()).toBe(false)
  })

  for (const [label, capabilities] of [
    ['absent', { ...FULL_CAPS }],
    ['false', { ...FULL_CAPS, canCopySheet: false }],
    ['string "true"', { ...FULL_CAPS, canCopySheet: 'true' }],
  ] as const) {
    it(`canCopySheet ${label}: entry ① hidden, its emit is a no-op, entry ② not rendered`, async () => {
      await mount(capabilities)
      expect(capturedRailAttrs!['can-copy-sheet']).toBe(false)
      railCopy()('sheet_orders')
      await flushUi()
      expect(dialogVisible()).toBe(false)
      await openSaveAsTemplate()
      expect(container!.querySelector('[data-action="save-sheet-as-template-copy-with-data"]')).toBeNull()
    })
  }

  it('entry ①: rail copy-sheet opens the dialog pinned to the ACTIVE sheet, its Base and schema names', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    await flushUi()
    railCopy()('sheet_orders')
    await flushUi()
    expect(dialogVisible()).toBe(true)
    expect(capturedCopyDialogAttrs!['sheet-id']).toBe('sheet_orders')
    expect(capturedCopyDialogAttrs!['sheet-name']).toBe('订单')
    expect(capturedCopyDialogAttrs!['base-name']).toBe('备料')
    expect(capturedCopyDialogAttrs!.fields).toEqual([{ id: 'fld_title', name: '标题' }, { id: 'fld_qty', name: '数量' }])
    expect(capturedCopyDialogAttrs!.views).toEqual([{ id: 'view_grid', name: '表格' }])
  })

  it('entry ①: a stale id for a non-active sheet is refused (the bit describes the active sheet only)', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    railCopy()('sheet_archive')
    await flushUi()
    expect(dialogVisible()).toBe(false)
  })

  it('entry ①: no active sheet -> nothing opens (never a dialog for an empty sheet id)', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    workbenchMock.activeSheetId.value = ''
    await flushUi()
    railCopy()('')
    await flushUi()
    expect(dialogVisible()).toBe(false)
  })

  it('unsaved drafts: declining the discard confirm keeps the dialog closed; accepting opens it', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    expect(capturedImportAttrs).not.toBeNull()
    ;(capturedImportAttrs!['onUpdate:dirty'] as (dirty: boolean) => void)(true)
    await flushUi()
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    railCopy()('sheet_orders')
    await flushUi()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(dialogVisible()).toBe(false)
    confirmSpy.mockReturnValue(true)
    railCopy()('sheet_orders')
    await flushUi()
    expect(dialogVisible()).toBe(true)
  })

  it('entry ②: 「改为复制数据表（含数据）」 closes 存为模板 and opens the copy dialog', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    await openSaveAsTemplate()
    const link = container!.querySelector('[data-action="save-sheet-as-template-copy-with-data"]') as HTMLButtonElement
    expect(link).not.toBeNull()
    expect(link.textContent).toBe('改为复制数据表（含数据）')
    link.click()
    await flushUi()
    expect(container!.querySelector('[data-testid="save-sheet-as-template-dialog"]')).toBeNull()
    expect(dialogVisible()).toBe(true)
    expect(capturedCopyDialogAttrs!['sheet-id']).toBe('sheet_orders')
  })

  it('success: refreshes the sheet list AND selects the copy (syncExternalContext), closes, toasts', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    railCopy()('sheet_orders')
    await flushUi()
    const onCopied = capturedCopyDialogAttrs!.onCopied as (r: CopySheetResult) => Promise<void>
    await onCopied(copyResult())
    await flushUi()
    expect(workbenchMock.syncExternalContext).toHaveBeenCalledWith({ baseId: 'base_ops', sheetId: 'sheet_copy' })
    expect(dialogVisible()).toBe(false)
    expect(showSuccessSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy.mock.calls[0][0]).toBe('已复制为「订单 副本」：1239 行 / 2 列 / 3 条授权（含 1 条记录级）')
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('success disclosures: an idempotent replay is said so; a failed formula recompute raises an error toast', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    const onCopied = capturedCopyDialogAttrs!.onCopied as (r: CopySheetResult) => Promise<void>
    await onCopied(copyResult({
      replayed: true,
      formulaRecompute: { attempted: 2, recomputed: 1, failed: true, errorCode: 'BULK_RECOMPUTE_FAILED' },
      summary: { rowCount: null, fieldCount: null, permissionRowCount: null, recordPermissionRowCount: null },
    }))
    await flushUi()
    expect(showSuccessSpy.mock.calls[0][0]).toBe('已复制为「订单 副本」（同一复制请求刚刚已完成，已打开那份副本）')
    expect(showErrorSpy).toHaveBeenCalledWith('副本已创建，但部分公式列未能重算。可在字段设置中重新保存该公式以重算。')
  })

  it('a failed refresh after success surfaces an error and no success toast', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    workbenchMock.syncExternalContext.mockResolvedValueOnce(false)
    const onCopied = capturedCopyDialogAttrs!.onCopied as (r: CopySheetResult) => Promise<void>
    await onCopied(copyResult())
    await flushUi()
    expect(showErrorSpy).toHaveBeenCalledTimes(1)
    expect(showSuccessSpy).not.toHaveBeenCalled()
  })

  it('dialog close hides it', async () => {
    await mount({ ...FULL_CAPS, canCopySheet: true })
    railCopy()('sheet_orders')
    await flushUi()
    expect(dialogVisible()).toBe(true)
    ;(capturedCopyDialogAttrs!.onClose as () => void)()
    await flushUi()
    expect(dialogVisible()).toBe(false)
  })
})
