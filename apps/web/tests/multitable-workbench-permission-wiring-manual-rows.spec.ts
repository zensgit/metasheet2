import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { manualRowLabel } from '../src/multitable/utils/manual-row-labels'
import type { ManualCellWrite } from '../src/multitable/composables/useMultitableGrid'

// 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.1, §3.3, §3.4, §3.7, §8 「B3」; #6664 notes N2 / N5 / N12) —
// the workbench wiring, with the REAL capabilities composable reading /context's `stockPreparationManualRows` block:
//
//   W-01 block present → EVERY generic create entry is off (toolbar add / import, grid "+ row" and footer, inspector
//        duplicate, kanban, a new form submission), whatever the state; the R68 note gives way to the manual-rows note;
//   W-02 the note per state (zh): 「新增人工补充行」 only in `allowed`, otherwise the state's reason (lock_missing →
//        「需管理员修复本表」);
//   W-03 block absent → exactly the old entries, no note, and a row's `manualSupplement` mark alone enables nothing
//        (N2: no manual grid cells, no 复制为新行, the route resolver answers /patch);
//   W-04 an actor who cannot create sees no note and no manual entry;
//   W-05 a stale generic-create emit on a P_reg sheet is refused with the note's text;
//   W-06 the dialog: 名称 / 总用量 required, 项目号 read-only, POST /sheets/:sheetId/manual-rows, then the new row opens;
//   W-07 N5: a column the actor's field permissions hide is neither editable nor offered;
//   W-08 复制为新行: asks, POST /records/:recordId/manual-copy, opens the new row;
//   W-09 the grid's route resolver (patchCell / undo / redo) and the grid props;
//   W-10 the drawer: the fillable columns of a manual row are lifted; its saves go one at a time, each carrying the version
//        the previous step returned (ADR §3.4 「第二步必须带第一步返回的 version」).
//
// Collected by the required web gate through the existing `multitable-workbench-permission-wiring` token.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()
const captured: Record<string, Record<string, unknown> | null> = {}
let capturedGridOptions: { resolveManualCellWrite?: (recordId: string, fieldId: string) => ManualCellWrite | null } | null = null

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return { ...actual, useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }) }
})

function stubComponent(name: string) {
  return defineComponent({ name, render() { return h('div', { [`data-stub-${name}`]: 'true' }) } })
}
function capturingStub(name: string) {
  return defineComponent({
    name,
    inheritAttrs: false,
    setup(_props, { attrs }) {
      captured[name] = attrs as Record<string, unknown>
      return () => h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({ useMultitableWorkbench: () => workbenchMock }))
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: (options: typeof capturedGridOptions) => {
    capturedGridOptions = options
    return gridMock
  },
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

vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: capturingStub('MetaToolbar') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: capturingStub('MetaGridTable') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: capturingStub('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: capturingStub('MetaFormView') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: capturingStub('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/SheetTrashModal.vue', () => ({ default: stubComponent('SheetTrashModal') }))
vi.mock('../src/multitable/components/HistoryCenterModal.vue', () => ({ default: stubComponent('HistoryCenterModal') }))
vi.mock('../src/multitable/components/MetaConfigHistoryModal.vue', () => ({ default: stubComponent('MetaConfigHistoryModal') }))
vi.mock('../src/multitable/components/RestorePreviewDialog.vue', () => ({ default: stubComponent('RestorePreviewDialog') }))
vi.mock('../src/multitable/components/RestoreBatchDialog.vue', () => ({ default: stubComponent('RestoreBatchDialog') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
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

const LOCK = { humanWriteLock: 'plm_system' }
// Synthetic physical ids for 名称 / 总用量 / 图号 / 规格 / 用量 (locked), 备注 (human) and 唯一键 (locked, never fillable).
const F = { name: 'fld_wb_name', total: 'fld_wb_total', code: 'fld_wb_code', spec: 'fld_wb_spec', raw: 'fld_wb_raw', notes: 'fld_wb_notes', key: 'fld_wb_key' }
const FIELDS = [
  { id: F.code, name: '图号', type: 'string', property: { ...LOCK } },
  { id: F.name, name: '名称', type: 'string', property: { ...LOCK } },
  { id: F.spec, name: '组件规格', type: 'string', property: { ...LOCK } },
  { id: F.raw, name: '单层用量', type: 'number', property: { ...LOCK } },
  { id: F.total, name: '总用量', type: 'number', property: { ...LOCK } },
  { id: F.notes, name: '备注', type: 'string', property: {} },
  { id: F.key, name: '唯一键', type: 'string', property: { ...LOCK } },
]
const PERMS = Object.fromEntries(FIELDS.map((f) => [f.id, { visible: true, readOnly: f.id !== F.notes }]))
const BLOCK = {
  state: 'allowed',
  editableFieldIds: [F.code, F.name, F.spec, F.raw, F.total],
  requiredFieldIds: [F.name, F.total],
  dialogFieldIds: [F.name, F.total, F.code, F.spec, F.raw, F.notes],
}
const WRITER_CAPS = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false,
  canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true,
}
const MANUAL_ACTIONS = { canEdit: true, canDelete: true, canComment: true, manualSupplement: true }
const ROWS = () => [
  { id: 'rec_wb_manual', version: 3, data: { [F.name]: 'Synthetic part', [F.spec]: 'SPEC-A', [F.notes]: '' } },
  { id: 'rec_wb_plm', version: 5, data: { [F.name]: 'PLM part', [F.spec]: 'SPEC-P', [F.notes]: '' } },
]

function createWorkbenchMock(viewType: string, capabilities: Record<string, unknown>) {
  const activeBaseId = ref('base_wb')
  const activeSheetId = ref<string | null>('sheet_wb')
  const activeViewId = ref('view_wb')
  const views = ref([{ id: 'view_wb', sheetId: 'sheet_wb', name: 'Main', type: viewType, hiddenFieldIds: [] as string[] }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_wb', name: 'Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_wb' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(), renameSheet: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      getConfigHistory: vi.fn().mockResolvedValue([]), deleteSheet: vi.fn(),
      createManualRow: vi.fn(), copyAsManualRow: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_wb', baseId: 'base_wb', name: 'Sheet', description: null }]),
    fields: ref(FIELDS),
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
    fields: ref(FIELDS), rows: ref(ROWS()), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 2, hasMore: false }), visibleFields: ref(FIELDS), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]), canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]), hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref<Record<string, { visible: boolean; readOnly: boolean }>>({ ...PERMS }), viewPermission: ref(null),
    rowActions: ref({ canEdit: true, canDelete: true, canComment: true }),
    rowActionOverrides: ref<Record<string, unknown>>({ rec_wb_manual: MANUAL_ACTIONS }),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false), lastBatchId: ref(null),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn().mockResolvedValue(null),
    createRecord: vi.fn().mockResolvedValue(undefined), duplicateRecord: vi.fn().mockResolvedValue(null),
    deleteRecord: vi.fn(), resolveRowActions: vi.fn((id: string) => (id === 'rec_wb_manual' ? MANUAL_ACTIONS : null)),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

const withBlock = (block: Record<string, unknown> = BLOCK, caps: Record<string, unknown> = WRITER_CAPS) => ({ ...caps, stockPreparationManualRows: block })

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

async function mount(viewType: string, capabilities: Record<string, unknown>): Promise<void> {
  workbenchMock = createWorkbenchMock(viewType, capabilities)
  const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
  app = createApp(Host)
  app.mount(container!)
  await flushUi()
}
function unmount(): void {
  app?.unmount()
  app = null
}

const note = () => container!.querySelector('[data-testid="manual-rows-note"]')
const createButton = () => container!.querySelector<HTMLButtonElement>('[data-testid="manual-row-create"]')
const dialog = () => document.body.querySelector('[data-testid="manual-row-dialog"]')

beforeEach(() => {
  for (const key of Object.keys(captured)) captured[key] = null
  capturedGridOptions = null
  gridMock = createGridMock()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  unmount()
  container?.remove()
  container = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  useLocale().setLocale('en')
  showErrorSpy.mockReset(); showSuccessSpy.mockReset()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks()
})

describe('W-01 a P_reg sheet (block present): every generic create entry is off, whatever the state', () => {
  it.each(['allowed', 'disabled', 'unavailable'])('state %s: toolbar add / import, grid "+ row", inspector duplicate', async (state) => {
    await mount('grid', withBlock({ ...BLOCK, state, ...(state === 'unavailable' ? { reason: 'lock_missing' } : {}) }))
    expect(captured.MetaToolbar!['can-create-record']).toBe(false)
    expect(captured.MetaGridTable!['can-create']).toBe(false)
    expect(captured.MetaRecordInspector!['can-create']).toBe(false)
    expect(note(), 'the manual-rows note replaces the entries').not.toBeNull()
  })

  it('kanban create follows the same gate', async () => {
    await mount('kanban', withBlock())
    expect(captured.MetaKanbanView!['can-create']).toBe(false)
  })

  it('OQ7 「表单不改」: a new form-view submission (the form route) keeps its pre-B3 gate — open on an unlocked registered sheet, closed by R68 on a locked one', async () => {
    await mount('form', withBlock({ ...BLOCK, state: 'unavailable', reason: 'lock_missing' }))
    expect(captured.MetaFormView!['read-only']).toBe(false)
    await (captured.MetaFormView!.onSubmit as (data: Record<string, unknown>) => Promise<void>)({ [F.notes]: 'x' })
    expect(workbenchMock.client.submitForm).toHaveBeenCalledTimes(1)
    unmount()
    await mount('form', withBlock(BLOCK, { ...WRITER_CAPS, recordCreateBlockedByLock: true }))
    expect(captured.MetaFormView!['read-only']).toBe(true)
  })

  it('the R68 note gives way to the manual-rows note on a locked P_reg sheet', async () => {
    await mount('grid', withBlock(BLOCK, { ...WRITER_CAPS, recordCreateBlockedByLock: true }))
    expect(container!.querySelector('[data-testid="record-create-locked-note"]')).toBeNull()
    expect(note()?.getAttribute('data-manual-rows-state')).toBe('allowed')
  })
})

describe('W-02 the note per state (zh)', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))

  it('allowed: 「新增人工补充行」 with the §3.1 text', async () => {
    await mount('grid', withBlock())
    expect(note()?.textContent).toContain('备料项目表上请用「新增人工补充行」新增行；PLM 行由拉取写入。')
    expect(createButton()?.textContent?.trim()).toBe('新增人工补充行')
  })

  it.each([
    [{ state: 'disabled' }, null, '本项目表已关闭「允许人工补充行」，不能新增行；如需新增请联系备料管理员。'],
    [{ state: 'unavailable', reason: 'lock_missing' }, '需管理员修复本表', '本表的 PLM 列锁还没有补齐，暂时不能新增行；请联系管理员修复本表。'],
    [{ state: 'unavailable', reason: 'project_archived' }, null, '本项目的备料表已归档，不能新增行。'],
    [{ state: 'unavailable', reason: 'project_sheets_off' }, null, '「一个项目一张备料表」功能未开启，不能在这张表上新增行。'],
    [{ state: 'unavailable', reason: 'contract_mismatch' }, null, '本表结构与备料模板不一致，暂时不能新增行；请联系管理员核对本表。'],
    [{ state: 'unavailable', reason: 'registry_unreadable' }, null, '暂时读不到项目登记信息，请稍后重试；仍不行请联系管理员。'],
  ])('%j: no entry, the reason', async (partial, headline, text) => {
    await mount('grid', withBlock({ ...BLOCK, ...partial }))
    expect(createButton()).toBeNull()
    expect(container!.querySelector('[data-testid="manual-rows-reason"]')?.textContent?.trim()).toBe(text)
    const headlineEl = container!.querySelector('[data-testid="manual-rows-reason-headline"]')
    if (headline) expect(headlineEl?.textContent?.trim()).toBe(headline)
    else expect(headlineEl).toBeNull()
    expect(captured.MetaRecordInspector!['manual-copy-available']).toBe(false)
  })
})

describe('W-03 block absent: the old entries, and the row mark alone enables nothing (N2)', () => {
  it('generic create follows canCreateRecord; no note; no manual cells; no 复制为新行; the resolver answers /patch', async () => {
    await mount('grid', { ...WRITER_CAPS })
    expect(captured.MetaToolbar!['can-create-record']).toBe(true)
    expect(captured.MetaGridTable!['can-create']).toBe(true)
    expect(note()).toBeNull()
    // The page still holds a row the server marked `manualSupplement` (the host registry says so) — but no block.
    expect(captured.MetaGridTable!['manual-row-record-ids']).toEqual([])
    expect(captured.MetaGridTable!['manual-row-field-ids']).toEqual([])
    expect(captured.MetaRecordInspector!['manual-copy-available']).toBe(false)
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', F.spec)).toBeNull()
  })

  it('with the MARKED row selected: still no 复制为新行, no lifted column, no manual route (the mark is a label only)', async () => {
    await mount('grid', { ...WRITER_CAPS })
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
    await flushUi()
    expect((captured.MetaRecordInspector!.record as { id: string } | null)?.id).toBe('rec_wb_manual')
    expect(captured.MetaRecordInspector!['manual-copy-available']).toBe(false)
    const perms = captured.MetaRecordInspector!['field-permissions'] as Record<string, { readOnly: boolean }>
    expect(perms[F.spec].readOnly).toBe(true)
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', F.name)).toBeNull()
  })
})

describe('W-04 an actor who cannot create', () => {
  it('gets no note and no manual entry (an editor still edits manual rows)', async () => {
    await mount('grid', withBlock(BLOCK, { ...WRITER_CAPS, canCreateRecord: false }))
    expect(note()).toBeNull()
    expect(captured.MetaRecordInspector!['manual-copy-available']).toBe(false)
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', F.spec)).toEqual({ required: false })
  })
})

describe('W-05 a stale generic-create emit on a P_reg sheet', () => {
  it('is refused with the note\'s text; the grid\'s create / duplicate are never called', async () => {
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onCreateRecord as () => Promise<void>)()
    await (captured.MetaGridTable!.onDuplicateRecord as (id: string) => Promise<void>)('rec_wb_plm')
    expect(gridMock.createRecord).not.toHaveBeenCalled()
    expect(gridMock.duplicateRecord).not.toHaveBeenCalled()
    const text = manualRowLabel('notice.useManualRow', false)
    expect(showErrorSpy).toHaveBeenCalledWith(text)
  })
})

describe('W-06 the 新增人工补充行 dialog', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))

  async function openDialog(): Promise<void> {
    await mount('grid', withBlock())
    createButton()!.click()
    await flushUi()
    expect(dialog()).not.toBeNull()
  }
  const input = (fieldId: string) => document.body.querySelector<HTMLInputElement>(`[data-manual-row-field="${fieldId}"] input`)
  const submit = () => document.body.querySelector<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!

  it('shows 名称* and 总用量* first, the optional columns after, 项目号 read-only (filled by the server)', async () => {
    await openDialog()
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('[data-manual-row-field]'))
    expect(rows.map((row) => row.getAttribute('data-manual-row-field'))).toEqual([F.name, F.total, F.code, F.spec, F.raw, F.notes])
    expect(rows[0].textContent).toContain('名称 *')
    expect(rows[1].textContent).toContain('总用量 *')
    expect(rows[2].textContent).not.toContain('*')
    expect(document.body.querySelector('[data-testid="manual-row-dialog-project-no"]')?.textContent).toContain('由系统按本表的项目自动填写')
    expect(document.body.querySelector(`[data-manual-row-field="${F.key}"]`)).toBeNull()
  })

  it('a required column left empty is refused in the dialog (nothing sent)', async () => {
    await openDialog()
    input(F.total)!.value = '3'
    input(F.total)!.dispatchEvent(new Event('input', { bubbles: true }))
    submit().click()
    await flushUi()
    expect(workbenchMock.client.createManualRow).not.toHaveBeenCalled()
    expect(document.body.querySelector(`[data-manual-row-field-error="${F.name}"]`)?.textContent).toBe('请填写「名称」')
  })

  it('submits the filled columns to POST /sheets/:sheetId/manual-rows, reloads, and opens the new row', async () => {
    await openDialog()
    workbenchMock.client.createManualRow.mockResolvedValue({ record: { id: 'rec_wb_new', version: 1, data: {} } })
    workbenchMock.client.getRecord.mockResolvedValue({ record: { id: 'rec_wb_new', version: 1, data: {} }, rowActions: MANUAL_ACTIONS })
    for (const [fieldId, value] of [[F.name, 'Synthetic manual part'], [F.total, '4'], [F.spec, 'SPEC-M']] as const) {
      input(fieldId)!.value = value
      input(fieldId)!.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await flushUi()
    submit().click()
    await flushUi(10)
    expect(workbenchMock.client.createManualRow).toHaveBeenCalledWith('sheet_wb', { [F.name]: 'Synthetic manual part', [F.total]: 4, [F.spec]: 'SPEC-M' })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_wb_new', expect.objectContaining({ sheetId: 'sheet_wb' }))
    expect(captured.MetaRecordInspector!.visible).toBe(true)
    expect(dialog()).toBeNull()
    expect(showSuccessSpy.mock.calls.map((call) => call[0])).toContain('已新增人工补充行')
  })

  it('a server refusal stays in the dialog with its message and the per-field errors', async () => {
    await openDialog()
    workbenchMock.client.createManualRow.mockRejectedValue(Object.assign(new Error('Record validation failed'), { fieldErrors: { [F.total]: '总用量 is required' } }))
    input(F.name)!.value = 'X'
    input(F.name)!.dispatchEvent(new Event('input', { bubbles: true }))
    input(F.total)!.value = '1'
    input(F.total)!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    submit().click()
    await flushUi(10)
    expect(dialog()).not.toBeNull()
    expect(document.body.querySelector('[data-testid="manual-row-dialog-error"]')?.textContent?.trim()).toBe('Record validation failed')
    expect(document.body.querySelector(`[data-manual-row-field-error="${F.total}"]`)?.textContent).toBe('总用量 is required')
  })
})

describe('W-07 N5: the actor\'s field permissions narrow the block\'s lists', () => {
  it('a column hidden for the actor is not editable on manual rows and not offered by the dialog', async () => {
    gridMock.fieldPermissions.value = { ...PERMS, [F.spec]: { visible: false, readOnly: true } }
    await mount('grid', withBlock())
    expect(captured.MetaGridTable!['manual-row-field-ids']).toEqual([F.code, F.name, F.raw, F.total])
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', F.spec)).toBeNull()
    createButton()!.click()
    await flushUi()
    expect(document.body.querySelector(`[data-manual-row-field="${F.spec}"]`)).toBeNull()
    expect(document.body.querySelector(`[data-manual-row-field="${F.name}"]`)).not.toBeNull()
  })

  it('a required column the actor may not see blocks the dialog (counted, not named)', async () => {
    gridMock.fieldPermissions.value = { ...PERMS, [F.name]: { visible: false, readOnly: true } }
    await mount('grid', withBlock())
    createButton()!.click()
    await flushUi()
    expect(document.body.querySelector('[data-testid="manual-row-dialog-blocked"]')).not.toBeNull()
    expect(document.body.querySelector<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!.disabled).toBe(true)
  })
})

describe('W-08 复制为新行', () => {
  it('asks, calls POST /records/:recordId/manual-copy for the selected row, and opens the new row', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await flushUi()
    expect(captured.MetaRecordInspector!['manual-copy-available']).toBe(true)
    workbenchMock.client.copyAsManualRow.mockResolvedValue({ record: { id: 'rec_wb_copy', version: 1, data: {} } })
    workbenchMock.client.getRecord.mockResolvedValue({ record: { id: 'rec_wb_copy', version: 1, data: {} }, rowActions: MANUAL_ACTIONS })
    await (captured.MetaRecordInspector!.onManualCopy as () => Promise<void>)()
    await flushUi(10)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.copyAsManualRow).toHaveBeenCalledWith('rec_wb_plm', { sheetId: 'sheet_wb' })
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_wb_copy', expect.objectContaining({ sheetId: 'sheet_wb' }))
    expect((captured.MetaRecordInspector!.record as { id: string } | null)?.id).toBe('rec_wb_copy')
  })

  it('declining the question sends nothing; outside state `allowed` a stale emit is refused with the reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await (captured.MetaRecordInspector!.onManualCopy as () => Promise<void>)()
    expect(workbenchMock.client.copyAsManualRow).not.toHaveBeenCalled()
    unmount()
    await mount('grid', withBlock({ ...BLOCK, state: 'disabled' }))
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await (captured.MetaRecordInspector!.onManualCopy as () => Promise<void>)()
    expect(workbenchMock.client.copyAsManualRow).not.toHaveBeenCalled()
    expect(showErrorSpy).toHaveBeenCalledWith(manualRowLabel('reason.disabled', false))
  })
})

describe('W-09 the grid\'s route resolver and props', () => {
  it('a fillable column of a manual row → manual-fields (名称 / 总用量 required); a PLM row, 备注 or 唯一键 → /patch', async () => {
    await mount('grid', withBlock())
    const resolve = capturedGridOptions!.resolveManualCellWrite!
    expect(resolve('rec_wb_manual', F.spec)).toEqual({ required: false })
    expect(resolve('rec_wb_manual', F.name)).toEqual({ required: true })
    expect(resolve('rec_wb_manual', F.total)).toEqual({ required: true })
    expect(resolve('rec_wb_plm', F.spec)).toBeNull()
    expect(resolve('rec_wb_manual', F.notes)).toBeNull()
    expect(resolve('rec_wb_manual', F.key)).toBeNull()
    expect(captured.MetaGridTable!['manual-row-record-ids']).toEqual(['rec_wb_manual'])
    expect(captured.MetaGridTable!['manual-row-field-ids']).toEqual([F.code, F.name, F.spec, F.raw, F.total])
  })

  it.each([
    [{ state: 'disabled' }, true],
    [{ state: 'unavailable', reason: 'project_archived' }, true],
    [{ state: 'unavailable', reason: 'project_sheets_off' }, true],
    [{ state: 'unavailable', reason: 'lock_missing' }, false],
    [{ state: 'unavailable', reason: 'contract_mismatch' }, false],
    [{ state: 'unavailable', reason: 'registry_unreadable' }, false],
  ])('%j: editing manual rows stays %s', async (partial, editable) => {
    await mount('grid', withBlock({ ...BLOCK, ...partial }))
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', F.spec) !== null).toBe(editable)
    expect((captured.MetaGridTable!['manual-row-record-ids'] as string[]).length > 0).toBe(editable)
  })
})

describe('W-10 the drawer on a manual row', () => {
  it('lifts the fillable columns\' read-only (and only those) for the selected manual row; a PLM row keeps every lock', async () => {
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
    await flushUi()
    const lifted = captured.MetaRecordInspector!['field-permissions'] as Record<string, { readOnly: boolean }>
    for (const id of [F.code, F.name, F.spec, F.raw, F.total]) expect(lifted[id].readOnly, id).toBe(false)
    expect(lifted[F.key].readOnly).toBe(true)
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await flushUi()
    const plain = captured.MetaRecordInspector!['field-permissions'] as Record<string, { readOnly: boolean }>
    expect(plain[F.spec].readOnly).toBe(true)
  })

  it('two saves go one at a time; the second carries the version the first returned (ADR §3.4)', async () => {
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
    await flushUi()
    let releaseFirst: () => void = () => {}
    const calls: Array<{ fieldId: string; version: number }> = []
    gridMock.patchCell.mockImplementation(async (recordId: string, fieldId: string, _value: unknown, version: number, options?: { onCommitted?: (v: number) => void }) => {
      calls.push({ fieldId, version })
      if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
      // The server answers a NEW version (not simply +1): the real composable writes it onto the grid row.
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === recordId)
      const next = version + 10
      row.version = next
      options?.onCommitted?.(next)
      return null
    })
    const onPatch = captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>
    const first = onPatch(F.spec, 'SPEC-B')
    const second = onPatch(F.notes, 'note')
    await flushUi()
    expect(calls).toEqual([{ fieldId: F.spec, version: 3 }]) // the second waits for the first
    releaseFirst()
    await first
    await second
    expect(calls).toEqual([{ fieldId: F.spec, version: 3 }, { fieldId: F.notes, version: 13 }])
  })

  it('an ordinary row\'s drawer saves are not chained (unchanged)', async () => {
    await mount('grid', { ...WRITER_CAPS })
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await flushUi()
    const onPatch = captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>
    await onPatch(F.notes, 'note')
    expect(gridMock.patchCell).toHaveBeenCalledWith('rec_wb_plm', F.notes, 'note', 5)
  })
})
