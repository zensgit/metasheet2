import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { manualRowLabel } from '../src/multitable/utils/manual-row-labels'
import type { ManualCellWrite } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

// 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.1, §3.3, §3.4, §3.7, §8 「B3」; #6664 notes N2 / N5 / N12) —
// the workbench wiring, with the REAL capabilities composable reading /context's `stockPreparationManualRows` block:
//
//   W-01 block present → EVERY generic create entry is off (toolbar add / import, grid "+ row" and footer, inspector
//        duplicate, kanban / gallery / calendar / timeline / gantt / hierarchy), whatever the state; the in-place
//        「新增人工补充行」 (toolbar, inline row, footer) only in `allowed`; a new form-view submission keeps its pre-B3 gate
//        (OQ7, the form route is unchanged); the R68 note gives way to the manual-rows note;
//   W-02 the note per state (zh): in `allowed` the line pointing to 「新增人工补充行」 (no button of its own — the entries
//        are in place), otherwise the state's reason (lock_missing → 「需管理员修复本表」);
//   W-03 block absent → exactly the old entries, no note, and a row's `manualSupplement` mark alone enables nothing
//        (N2: no manual grid cells, no 复制为新行, the route resolver answers /patch);
//   W-04 an actor who cannot create sees no note and no manual entry;
//   W-05 a stale generic-create emit on a P_reg sheet is refused with the note's text;
//   W-06 the dialog: 名称 / 总用量 required, 项目号 read-only, POST /sheets/:sheetId/manual-rows, then the new row opens;
//   W-07 N5: a column the actor's field permissions hide is neither editable nor offered;
//   W-08 复制为新行: asks, POST /records/:recordId/manual-copy, opens the new row;
//   W-09 the grid's route resolver (patchCell / undo / redo) and the grid props;
//   W-10 the drawer: the fillable columns of a manual row are lifted; its saves go one at a time, each carrying the version
//        the previous step returned (ADR §3.4 「第二步必须带第一步返回的 version」): on the page the drawer shows the grid's
//        row (also when it holds a copy) and the grid sends them; a row it shows as a copy (a new row off the page) is
//        chained by the drawer. W-10R runs the REAL grid composable under the workbench, on a stand-in server;
//   W-11 the three in-place entries with the REAL toolbar and grid fed the workbench's own props (fix round 2, R74's
//        footer kept): in `allowed` the toolbar, inline-row and footer places hold 「+ 新增人工补充行」 and open the
//        dialog, never a generic create; lock_missing / disabled: no entry in any of them; an ordinary sheet keeps
//        「+ 新建记录」 in all three, each sending the generic create.
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
    setup(_props, { attrs, expose }) {
      captured[name] = attrs as Record<string, unknown>
      expose({ canAnchorFieldError: () => false })
      return () => h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}

let workbenchMock: any
let gridMock: any

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({ useMultitableWorkbench: () => workbenchMock }))
// W-10R: the REAL grid composable on `realGridClient` when it is set; the mock otherwise.
let realGridClient: MultitableApiClient | null = null
let realGrid: any = null
vi.mock('../src/multitable/composables/useMultitableGrid', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/composables/useMultitableGrid')>('../src/multitable/composables/useMultitableGrid')
  return {
    ...actual,
    useMultitableGrid: (options: typeof capturedGridOptions) => {
      capturedGridOptions = options
      if (realGridClient) {
        realGrid = actual.useMultitableGrid({ ...(options as Parameters<typeof actual.useMultitableGrid>[0]), client: realGridClient })
        return realGrid
      }
      return gridMock
    },
  }
})
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
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: capturingStub('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: capturingStub('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: capturingStub('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaGanttView.vue', () => ({ default: capturingStub('MetaGanttView') }))
vi.mock('../src/multitable/components/MetaHierarchyView.vue', () => ({ default: capturingStub('MetaHierarchyView') }))
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

/** The drawer asks for the version the server returns on every save (`patchCell`'s `onCommitted`). */
const ROW_SAVE = { onCommitted: expect.any(Function) }
import { useMultitableSheetRealtime } from '../src/multitable/composables/useMultitableSheetRealtime'

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
// The note's own button (before fix round 2) — must stay gone: the entries are in the generic entries' places now.
const createButton = () => container!.querySelector<HTMLButtonElement>('[data-testid="manual-row-create"]')
const dialog = () => document.body.querySelector('[data-testid="manual-row-dialog"]')
/** What the toolbar's in-place 「新增人工补充行」 emits (W-11 proves the real button reaches this listener). */
async function openFromToolbarEntry(): Promise<void> {
  const onAddManualRow = captured.MetaToolbar!.onAddManualRow as () => void
  onAddManualRow()
  await flushUi()
}

// W-11: the REAL toolbar / grid, mounted beside the workbench with the props and listeners the stubs captured.
const realApps: VueApp<Element>[] = []
const REAL = {
  MetaToolbar: () => vi.importActual<{ default: Component }>('../src/multitable/components/MetaToolbar.vue'),
  MetaGridTable: () => vi.importActual<{ default: Component }>('../src/multitable/components/MetaGridTable.vue'),
}
async function mountReal(name: keyof typeof REAL): Promise<HTMLElement> {
  const { default: Real } = await REAL[name]()
  const props = { ...captured[name]! }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const realApp = createApp({ render: () => h(Real, props) })
  realApp.mount(el)
  realApps.push(realApp)
  await flushUi()
  return el
}

beforeEach(() => {
  for (const key of Object.keys(captured)) captured[key] = null
  capturedGridOptions = null
  gridMock = createGridMock()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  while (realApps.length) realApps.pop()!.unmount()
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
  it.each(['allowed', 'disabled', 'unavailable'])('state %s: toolbar add / import, grid "+ row", inspector duplicate; 新增人工补充行 in their places only in allowed', async (state) => {
    await mount('grid', withBlock({ ...BLOCK, state, ...(state === 'unavailable' ? { reason: 'lock_missing' } : {}) }))
    expect(captured.MetaToolbar!['can-create-record']).toBe(false)
    expect(captured.MetaGridTable!['can-create']).toBe(false)
    expect(captured.MetaRecordInspector!['can-create']).toBe(false)
    expect(captured.MetaToolbar!['manual-row-create']).toBe(state === 'allowed')
    expect(captured.MetaGridTable!['manual-row-create']).toBe(state === 'allowed')
    expect(note(), 'the manual-rows note takes the R68 note\'s place').not.toBeNull()
  })

  it.each([
    ['kanban', 'MetaKanbanView'],
    ['gallery', 'MetaGalleryView'],
    ['calendar', 'MetaCalendarView'],
    ['timeline', 'MetaTimelineView'],
    ['gantt', 'MetaGanttView'],
    ['hierarchy', 'MetaHierarchyView'],
  ])('%s create: off with the block present, on without it (ADR §3.7 「全部通用新建入口」); the toolbar\'s in-place 新增人工补充行 reaches this view too', async (viewType, stub) => {
    await mount(viewType, withBlock())
    expect(captured[stub], `${stub} rendered`).toBeTruthy()
    expect(captured[stub]!['can-create']).toBe(false)
    expect(captured.MetaToolbar!['manual-row-create']).toBe(true)
    unmount()
    for (const key of Object.keys(captured)) captured[key] = null
    await mount(viewType, { ...WRITER_CAPS })
    expect(captured[stub]!['can-create']).toBe(true)
    expect(captured.MetaToolbar!['manual-row-create']).toBe(false)
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

  it('allowed: the §3.1 text pointing to 「新增人工补充行」; no button of its own (the toolbar\'s place, right under it, holds one)', async () => {
    await mount('grid', withBlock())
    expect(note()?.textContent?.trim()).toBe('备料项目表上请用「新增人工补充行」新增行；PLM 行由拉取写入。')
    expect(note()!.querySelector('button')).toBeNull()
    expect(createButton()).toBeNull()
    expect(captured.MetaToolbar!['manual-row-create']).toBe(true)
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
    expect(note()!.querySelector('button')).toBeNull()
    expect(captured.MetaToolbar!['manual-row-create']).toBe(false)
    expect(captured.MetaGridTable!['manual-row-create']).toBe(false)
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
    expect(captured.MetaToolbar!['manual-row-create']).toBe(false)
    expect(captured.MetaGridTable!['manual-row-create']).toBe(false)
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
    expect(captured.MetaToolbar!['manual-row-create']).toBe(false)
    expect(captured.MetaGridTable!['manual-row-create']).toBe(false)
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
    await openFromToolbarEntry()
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
    await openFromToolbarEntry()
    expect(document.body.querySelector(`[data-manual-row-field="${F.spec}"]`)).toBeNull()
    expect(document.body.querySelector(`[data-manual-row-field="${F.name}"]`)).not.toBeNull()
  })

  it('a required column the actor may not see blocks the dialog (counted, not named)', async () => {
    gridMock.fieldPermissions.value = { ...PERMS, [F.name]: { visible: false, readOnly: true } }
    await mount('grid', withBlock())
    await openFromToolbarEntry()
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

  it('on the page, two saves both go to the grid at once, on the row\'s version; the grid sends them one at a time (ADR §3.4)', async () => {
    // The grid's `patchCell` sends a record's writes one at a time, the second with the version the first returned
    // (multitable-grid-manual-rows.spec.ts R-07 and W-10R below, on the real composable). The drawer does not hold the
    // second back, so a later grid edit of the cell cannot go out before it.
    await mount('grid', withBlock())
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
    await flushUi()
    let releaseFirst: () => void = () => {}
    const calls: unknown[][] = []
    gridMock.patchCell.mockImplementation(async (...args: unknown[]) => {
      calls.push(args)
      if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve })
      return null
    })
    const onPatch = captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>
    const first = onPatch(F.spec, 'SPEC-B')
    const second = onPatch(F.notes, 'note')
    await flushUi()
    expect(calls).toEqual([['rec_wb_manual', F.spec, 'SPEC-B', 3, ROW_SAVE], ['rec_wb_manual', F.notes, 'note', 3, ROW_SAVE]])
    releaseFirst()
    await first
    await second
  })

  it('an ordinary row\'s drawer saves are not chained (unchanged)', async () => {
    await mount('grid', { ...WRITER_CAPS })
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await flushUi()
    const onPatch = captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>
    await onPatch(F.notes, 'note')
    expect(gridMock.patchCell).toHaveBeenCalledWith('rec_wb_plm', F.notes, 'note', 5, ROW_SAVE)
  })

  // A drawer write that names its record (an attachment write that ended after the drawer moved on) takes that
  // record's route: the manual row's one-at-a-time route, or a PLM row's plain /patch, whichever row is shown.
  async function selectThen(first: string, second: string): Promise<(fieldId: string, value: unknown, recordId?: string) => Promise<void>> {
    await mount('grid', withBlock())
    const select = captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>
    await select(first)
    await flushUi()
    await select(second)
    await flushUi()
    expect((captured.MetaRecordInspector!.record as { id: string } | null)?.id).toBe(second)
    return captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown, recordId?: string) => Promise<void>
  }

  it('the manual row\'s named write after a move to the PLM row goes to the manual row, at its version (the grid picks its route)', async () => {
    const onPatch = await selectThen('rec_wb_manual', 'rec_wb_plm')
    await onPatch(F.notes, 'late', 'rec_wb_manual')
    expect(gridMock.patchCell.mock.calls).toEqual([['rec_wb_manual', F.notes, 'late', 3, ROW_SAVE]])
  })

  it('the reverse: the PLM row\'s named write while the manual row is shown is a plain /patch call for the PLM row', async () => {
    const onPatch = await selectThen('rec_wb_plm', 'rec_wb_manual')
    await onPatch(F.notes, 'late', 'rec_wb_plm')
    expect(gridMock.patchCell.mock.calls).toEqual([['rec_wb_plm', F.notes, 'late', 5, ROW_SAVE]])
  })

  // The drawer can hold a copy of a manual row (`deepLinkedRecord`): after a realtime merge of a row on the page, or for
  // a new row that is not on the loaded page (ADR §8 B3.3: 新增人工补充行 opens it through `getRecord`). On the page the
  // drawer shows the grid's row and the grid chains its saves; off the page the drawer shows the copy, which the grid
  // never chains, so the drawer's own rule above holds there. Either way two quick saves (two ArrowUp presses on 总用量,
  // or ADR §3.4's two steps) both store, the second with the version the first returned.
  describe('a manual row with a copy (a realtime merge on the page, or a new row off the page)', () => {
    /** The grid's `patchCell` and the server, by the real `patchCell`'s rule: a record's writes go one at a time, the
     *  version chained only for a record on the page, and its row shows the value at once; the server takes a write
     *  only at its current version and moves it one on, and `onCommitted` gets the new version. `overlapped` says, per
     *  call, whether an earlier call of the record was still unanswered (false: the drawer held it back). */
    function strictServer(versions: Record<string, number>) {
      const stored: Record<string, Record<string, unknown>> = {}
      const sent: Array<[string, unknown, number]> = []
      const overlapped: boolean[] = []
      let outstanding = 0
      const advanced = new Map<string, number>()
      const tails = new Map<string, Promise<unknown>>()
      gridMock.patchCell.mockImplementation((recordId: string, fieldId: string, value: unknown, version: number, options?: { onCommitted?: (v: number) => void }) => {
        const inPage = gridMock.rows.value.some((r: { id: string }) => r.id === recordId)
        overlapped.push(outstanding > 0)
        outstanding += 1
        const shownRow = gridMock.rows.value.find((r: { id: string }) => r.id === recordId)
        if (shownRow) shownRow.data[fieldId] = value
        const run = (tails.get(recordId) ?? Promise.resolve()).then(async () => {
          let expected = version
          if (inPage) {
            for (let next = advanced.get(`${recordId}@${expected}`); next !== undefined; next = advanced.get(`${recordId}@${expected}`)) expected = next
          }
          sent.push([fieldId, value, expected])
          await new Promise((resolve) => setTimeout(resolve, 0))
          outstanding -= 1
          if (expected !== versions[recordId]) {
            return { recordId, fieldId, attemptedValue: value, status: 409, code: 'VERSION_CONFLICT', message: 'Changed elsewhere' }
          }
          versions[recordId] += 1
          advanced.set(`${recordId}@${expected}`, versions[recordId])
          ;(stored[recordId] ??= {})[fieldId] = value
          const row = gridMock.rows.value.find((r: { id: string }) => r.id === recordId)
          if (row) row.version = versions[recordId]
          options?.onCommitted?.(versions[recordId])
          return null
        })
        tails.set(recordId, run.then(() => undefined, () => undefined))
        return run
      })
      return { stored, sent, overlapped }
    }
    async function settle(): Promise<void> {
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      await flushUi()
    }
    const shownRecord = () => captured.MetaRecordInspector!.record as { id: string; version: number; data: Record<string, unknown> }
    const onPatch = () => captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>

    async function mergedCopyOfManualRow(): Promise<void> {
      await mount('grid', withBlock())
      await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
      await flushUi()
      gridMock.mergeRemoteRecord = vi.fn(() => true)
      workbenchMock.client.getRecord.mockResolvedValue({
        record: { id: 'rec_wb_manual', version: 3, data: { ...ROWS()[0].data, [F.total]: 5 } }, rowActions: MANUAL_ACTIONS,
        linkSummaries: {}, attachmentSummaries: {}, fieldPermissions: {}, viewPermissions: {},
        commentsScope: { targetType: 'meta_record', targetId: 'rec_wb_manual', containerType: 'meta_sheet', containerId: 'sheet_wb' },
      })
      const realtime = vi.mocked(useMultitableSheetRealtime).mock.calls.at(-1)![0] as unknown as { mergeRemoteRecord: (id: string) => Promise<boolean> }
      await realtime.mergeRemoteRecord('rec_wb_manual')
      await flushUi()
      const row = gridMock.rows.value.find((r: { id: string }) => r.id === 'rec_wb_manual')
      expect(shownRecord()).toBe(row) // the grid's row, though the drawer holds a copy
    }

    async function newManualRowOffThePage(): Promise<void> {
      useLocale().setLocale('zh-CN')
      await mount('grid', withBlock())
      await openFromToolbarEntry()
      workbenchMock.client.createManualRow.mockResolvedValue({ record: { id: 'rec_wb_new', version: 1, data: {} } })
      workbenchMock.client.getRecord.mockResolvedValue({
        record: { id: 'rec_wb_new', version: 1, data: { [F.name]: 'Synthetic manual part', [F.total]: 5 } }, rowActions: MANUAL_ACTIONS,
      })
      const input = (fieldId: string) => document.body.querySelector<HTMLInputElement>(`[data-manual-row-field="${fieldId}"] input`)
      for (const [fieldId, value] of [[F.name, 'Synthetic manual part'], [F.total, '5']] as const) {
        input(fieldId)!.value = value
        input(fieldId)!.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await flushUi()
      document.body.querySelector<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!.click()
      await flushUi(10)
      expect(gridMock.rows.value.some((r: { id: string }) => r.id === 'rec_wb_new')).toBe(false)
      expect(shownRecord().id).toBe('rec_wb_new')
    }

    it('after a realtime merge of a row on the page: two quick saves of 总用量 (5 → 6 → 7) go to the grid at once and store 7, the second sent with the version the first returned', async () => {
      await mergedCopyOfManualRow()
      const { stored, sent, overlapped } = strictServer({ rec_wb_manual: 3 })
      await Promise.all([onPatch()(F.total, 6), onPatch()(F.total, 7)])
      await settle()
      expect(overlapped).toEqual([false, true])
      expect(sent).toEqual([[F.total, 6, 3], [F.total, 7, 4]])
      expect(stored.rec_wb_manual).toEqual({ [F.total]: 7 })
      expect(shownRecord()).toMatchObject({ version: 5, data: { [F.total]: 7 } })
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('after a realtime merge of a row on the page: ADR §3.4\'s two steps (规格 by the manual route, then 备注 by /patch) both store', async () => {
      await mergedCopyOfManualRow()
      const { stored, sent } = strictServer({ rec_wb_manual: 3 })
      await Promise.all([onPatch()(F.spec, 'SPEC-B'), onPatch()(F.notes, 'note')])
      await settle()
      expect(sent).toEqual([[F.spec, 'SPEC-B', 3], [F.notes, 'note', 4]])
      expect(stored.rec_wb_manual).toEqual({ [F.spec]: 'SPEC-B', [F.notes]: 'note' })
      expect(shownRecord()).toMatchObject({ version: 5, data: { [F.spec]: 'SPEC-B', [F.notes]: 'note' } })
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('a new row opened off the page (ADR §8 B3.3): two quick saves of 总用量 (5 → 6 → 7) store 7, the second held by the drawer and sent with the version the first returned', async () => {
      await newManualRowOffThePage()
      const { stored, sent, overlapped } = strictServer({ rec_wb_new: 1 })
      await Promise.all([onPatch()(F.total, 6), onPatch()(F.total, 7)])
      await settle()
      expect(overlapped).toEqual([false, false])
      expect(sent).toEqual([[F.total, 6, 1], [F.total, 7, 2]])
      expect(stored.rec_wb_new).toEqual({ [F.total]: 7 })
      expect(shownRecord()).toMatchObject({ version: 3, data: { [F.total]: 7 } })
      expect(showErrorSpy).not.toHaveBeenCalled()
    })

    it('on the page a save is the grid row\'s (chained by the grid), also after a realtime merge; off the page it is the copy\'s, sent as given', async () => {
      await mergedCopyOfManualRow()
      await onPatch()(F.total, 6)
      // The version returned is asked for, for the copy the drawer holds.
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_wb_manual', F.total, 6, 3, { onCommitted: expect.any(Function) }]])
      gridMock.patchCell.mockClear()
      unmount()
      await newManualRowOffThePage()
      await onPatch()(F.total, 6)
      expect(gridMock.patchCell.mock.calls).toEqual([['rec_wb_new', F.total, 6, 1, { onCommitted: expect.any(Function), chainVersion: false }]])
    })

    it('a new row opened off the page: ADR §3.4\'s two steps (规格, then 备注) both store', async () => {
      await newManualRowOffThePage()
      const { stored, sent } = strictServer({ rec_wb_new: 1 })
      await Promise.all([onPatch()(F.spec, 'SPEC-B'), onPatch()(F.notes, 'note')])
      await settle()
      expect(sent).toEqual([[F.spec, 'SPEC-B', 1], [F.notes, 'note', 2]])
      expect(stored.rec_wb_new).toEqual({ [F.spec]: 'SPEC-B', [F.notes]: 'note' })
      expect(shownRecord()).toMatchObject({ version: 3, data: { [F.spec]: 'SPEC-B', [F.notes]: 'note' } })
      expect(showErrorSpy).not.toHaveBeenCalled()
    })
  })
})

// ── W-10R the drawer on the REAL grid composable ──────────────────────────────────────────────────────────────────────
// The workbench as in W-10, with the real `useMultitableGrid` on a stand-in server that checks every write against the
// record's version, moves it one on, and answers only when told. So the drawer's own one-at-a-time rule (a copy off the
// page) and the grid's per-record queue (`patchCell`) meet for real.

type SentWrite = { route: 'manual' | 'patch'; recordId: string; fieldId: string; value: unknown; at: number; outcome?: string }

function versionCheckingServer(records: Array<{ id: string; version: number; data: Record<string, unknown> }>, page: string[], manual: string[]) {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const stored = new Map(records.map((r) => [r.id, { version: r.version, data: { ...r.data } }]))
  const state = { page: [...page], manual: [...manual], holdViews: false }
  const heldViews: Array<() => void> = []
  const sent: SentWrite[] = []
  const waiting: Array<{ compute: () => Response; resolve: (response: Response) => void }> = []
  const held: Array<() => void> = []
  const fetchFn = vi.fn((input: string, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const manualMatch = /\/api\/multitable\/records\/([^/]+)\/manual-fields$/.exec(input)
    if ((manualMatch && method === 'PATCH') || (input.startsWith('/api/multitable/patch') && method === 'POST')) {
      const change = manualMatch
        ? { recordId: decodeURIComponent(manualMatch[1]), fieldId: Object.keys(body.data)[0], value: Object.values(body.data)[0], expectedVersion: body.expectedVersion as number }
        : body.changes[0] as { recordId: string; fieldId: string; value: unknown; expectedVersion: number }
      const entry: SentWrite = { route: manualMatch ? 'manual' : 'patch', recordId: change.recordId, fieldId: change.fieldId, value: change.value, at: change.expectedVersion }
      sent.push(entry)
      return new Promise<Response>((resolve) => {
        waiting.push({
          resolve,
          compute: () => {
            const record = stored.get(change.recordId)!
            if (record.version !== change.expectedVersion) {
              entry.outcome = 'VERSION_CONFLICT'
              return json({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Changed elsewhere', serverVersion: record.version } }, 409)
            }
            record.version += 1
            record.data[change.fieldId] = change.value
            entry.outcome = `stored v${record.version}`
            return json({ ok: true, data: { updated: [{ recordId: change.recordId, version: record.version }] } })
          },
        })
      })
    }
    if (input.startsWith('/api/multitable/view?') && method === 'GET') {
      const rows = state.page.filter((id) => stored.has(id)).map((id) => ({ id, version: stored.get(id)!.version, data: { ...stored.get(id)!.data } }))
      const overrides = Object.fromEntries(state.manual.filter((id) => state.page.includes(id)).map((id) => [id, MANUAL_ACTIONS]))
      const viewBody = { ok: true, data: {
        fields: FIELDS, rows, page: { offset: 0, limit: 50, total: rows.length, hasMore: false },
        meta: { permissions: { fieldPermissions: PERMS, rowActions: { canEdit: true, canDelete: true, canComment: true }, rowActionOverrides: overrides } },
      } }
      if (state.holdViews) return new Promise<Response>((resolve) => { heldViews.push(() => resolve(json(viewBody))) })
      return Promise.resolve(json(viewBody))
    }
    return Promise.resolve(json({ ok: true, data: {} }))
  })
  async function tick() {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    await flushUi()
  }
  return {
    stored, state, sent, fetchFn, tick,
    async releaseViews() {
      state.holdViews = false
      while (heldViews.length) heldViews.shift()!()
      await tick()
    },
    async answerAll() {
      await tick()
      while (waiting.length) {
        const w = waiting.shift()!
        w.resolve(w.compute())
        await tick()
      }
    },
    /** Store the oldest write now; its answer is on the way until `release`. */
    store() {
      const w = waiting.shift()!
      const response = w.compute()
      held.push(() => w.resolve(response))
    },
    async release() {
      held.shift()!()
      await tick()
    },
  }
}

describe('W-10R the drawer on the REAL grid composable (a stand-in server checks each write\'s version)', () => {
  let server: ReturnType<typeof versionCheckingServer>
  const records = () => [
    { id: 'rec_wb_manual', version: 3, data: { [F.name]: 'Synthetic part', [F.spec]: 'SPEC-A', [F.notes]: '', [F.total]: 5 } },
    { id: 'rec_wb_plm', version: 5, data: { [F.name]: 'PLM part', [F.spec]: 'SPEC-P', [F.notes]: '' } },
    { id: 'rec_wb_new', version: 1, data: { [F.name]: 'Synthetic manual part', [F.total]: 5 } },
    { id: 'rec_wb_far', version: 8, data: { [F.name]: 'Far PLM part', [F.notes]: '', [F.code]: ['att_1', 'att_2'] } },
  ]
  const row = (id: string) => realGrid.rows.value.find((r: { id: string }) => r.id === id) as { id: string; version: number; data: Record<string, unknown> } | undefined
  const shown = () => captured.MetaRecordInspector?.record as { id: string; version: number; data: Record<string, unknown> } | null | undefined
  const onPatch = () => captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>
  const gridEdit = (recordId: string, fieldId: string, value: unknown) => (
    (captured.MetaGridTable!.onPatchCell as (recordId: string, fieldId: string, value: unknown, version: number) => Promise<void>)(recordId, fieldId, value, row(recordId)!.version)
  )
  const realtime = () => vi.mocked(useMultitableSheetRealtime).mock.calls.at(-1)![0] as unknown as {
    mergeRemoteRecord: (id: string) => Promise<boolean>
    reloadCurrentSheetPage: () => Promise<void>
    reloadSelectedRecordContext: (id: string) => Promise<void>
  }
  const writes = () => server.sent.map((e) => [e.fieldId, e.value, e.at, e.outcome])
  const step = () => flushUi(3)

  beforeEach(() => {
    server = versionCheckingServer(records(), ['rec_wb_manual', 'rec_wb_plm'], ['rec_wb_manual', 'rec_wb_new'])
    realGridClient = new MultitableApiClient({ fetchFn: server.fetchFn as unknown as typeof fetch })
    realGrid = null
  })
  afterEach(() => { realGridClient = null; realGrid = null })

  function getRecordFromServer() {
    workbenchMock.client.getRecord.mockImplementation(async (recordId: string) => {
      const record = server.stored.get(recordId)!
      return {
        record: { id: recordId, version: record.version, data: { ...record.data } },
        rowActions: server.state.manual.includes(recordId) ? MANUAL_ACTIONS : { canEdit: true, canDelete: true, canComment: true },
        linkSummaries: {}, attachmentSummaries: {}, fieldPermissions: {}, viewPermissions: {},
        commentsScope: { targetType: 'meta_record', targetId: recordId, containerType: 'meta_sheet', containerId: 'sheet_wb' },
      }
    })
  }
  async function mountReal(): Promise<void> {
    await mount('grid', withBlock())
    await vi.waitFor(() => expect(realGrid.rows.value).toHaveLength(2))
    await flushUi()
    getRecordFromServer()
  }
  async function onTheRow(id = 'rec_wb_manual'): Promise<void> {
    await mountReal()
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)(id)
    await flushUi()
    expect(shown()).toBe(row(id))
  }
  async function afterMerge(id = 'rec_wb_manual'): Promise<void> {
    await onTheRow(id)
    await realtime().mergeRemoteRecord(id)
    await flushUi()
    expect(shown()).toBe(row(id))
  }
  /** 新增人工补充行 whose new row is not on the loaded page: opened through getRecord (ADR §8 B3.3). */
  async function newRowOffThePage(): Promise<void> {
    useLocale().setLocale('zh-CN')
    await mountReal()
    await openFromToolbarEntry()
    workbenchMock.client.createManualRow.mockResolvedValue({ record: { id: 'rec_wb_new', version: 1, data: {} } })
    const input = (fieldId: string) => document.body.querySelector<HTMLInputElement>(`[data-manual-row-field="${fieldId}"] input`)
    for (const [fieldId, value] of [[F.name, 'Synthetic manual part'], [F.total, '5']] as const) {
      input(fieldId)!.value = value
      input(fieldId)!.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await flushUi()
    document.body.querySelector<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!.click()
    await server.tick()
    await flushUi(10)
    expect(row('rec_wb_new')).toBeUndefined()
    expect(shown()!.id).toBe('rec_wb_new')
  }
  /** The record opened by its link at mount, the page's rows held back until the drawer shows it. */
  async function openedByLinkBeforeTheRows(recordId: string): Promise<void> {
    server.state.holdViews = true
    workbenchMock = createWorkbenchMock('grid', withBlock())
    getRecordFromServer()
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component, { recordId }) } })
    app = createApp(Host)
    app.mount(container!)
    await server.tick()
    await flushUi(10)
    expect(workbenchMock.client.getRecord).toHaveBeenCalled()
    await server.releaseViews()
    await vi.waitFor(() => expect(realGrid.rows.value).toHaveLength(2))
    await flushUi(10)
    expect(shown()).toBe(row(recordId))
  }

  it('a manual row on the page: two drawer saves of 总用量, then a grid edit of the cell, all before the first answer: the newest value is stored, with no conflict', async () => {
    await onTheRow()
    const all = [onPatch()(F.total, 6)]
    await step()
    all.push(onPatch()(F.total, 7))
    await step()
    all.push(gridEdit('rec_wb_manual', F.total, 9))
    await step()
    await server.answerAll()
    await Promise.all(all)
    // The drawer's 7 waited in the grid's queue, where the grid's 9 replaced it.
    expect(writes()).toEqual([[F.total, 6, 3, 'stored v4'], [F.total, 9, 4, 'stored v5']])
    expect(server.stored.get('rec_wb_manual')!.data[F.total]).toBe(9)
    expect(realGrid.conflict.value).toBeNull()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('after a realtime merge of a manual row on the page: a drawer save, a grid edit of the row before its answer, then a later drawer save: all three are stored', async () => {
    await afterMerge()
    const all = [onPatch()(F.total, 6)]
    await step()
    all.push(gridEdit('rec_wb_manual', F.notes, 'g'))
    await step()
    await server.answerAll()
    await Promise.all(all)
    const later = onPatch()(F.total, 7)
    await step()
    await server.answerAll()
    await later
    expect(writes()).toEqual([[F.total, 6, 3, 'stored v4'], [F.notes, 'g', 4, 'stored v5'], [F.total, 7, 5, 'stored v6']])
    expect(realGrid.conflict.value).toBeNull()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['rec_wb_plm', F.notes, 'a', 'b', 5],
    ['rec_wb_manual', F.total, 6, 7, 3],
  ] as Array<[string, string, unknown, unknown, number]>)('%s opened by its link before the page\'s rows came: two quick saves both store', async (recordId, fieldId, first, second, at) => {
    await openedByLinkBeforeTheRows(recordId)
    const all = [onPatch()(fieldId, first)]
    await step()
    all.push(onPatch()(fieldId, second))
    await step()
    await server.answerAll()
    await Promise.all(all)
    expect(writes()).toEqual([[fieldId, first, at, `stored v${at + 1}`], [fieldId, second, at + 1, `stored v${at + 2}`]])
    expect(realGrid.conflict.value).toBeNull()
  })

  it('a new manual row off the page whose copy is refreshed from the server between the store and the answer of the first step: the second step carries the version returned', async () => {
    await newRowOffThePage()
    const first = onPatch()(F.total, 6)
    await step()
    const second = onPatch()(F.total, 7)
    await step()
    server.store()
    await realtime().reloadSelectedRecordContext('rec_wb_new')
    await flushUi()
    expect(shown()).toMatchObject({ version: 2, data: { [F.total]: 6 } })
    await server.release()
    await server.answerAll()
    await Promise.all([first, second])
    expect(writes()).toEqual([[F.total, 6, 1, 'stored v2'], [F.total, 7, 2, 'stored v3']])
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('a new manual row comes onto the page while the drawer still holds its second step: a third save waits behind it, so the three go out in the order made', async () => {
    await newRowOffThePage()
    const all = [onPatch()(F.total, 6)]
    await step()
    all.push(onPatch()(F.total, 7))
    await step()
    server.state.page.push('rec_wb_new')
    await realtime().reloadCurrentSheetPage()
    await flushUi()
    expect(row('rec_wb_new')).toBeTruthy()
    all.push(onPatch()(F.total, 8))
    await step()
    await server.answerAll()
    await Promise.all(all)
    expect(writes().map((write) => write[1])).toEqual([6, 7, 8])
    expect(server.stored.get('rec_wb_new')!.data[F.total]).toBe(8)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  async function rowComesOntoThePage(id: string): Promise<void> {
    server.state.page.push(id)
    await realtime().reloadCurrentSheetPage()
    await flushUi()
    expect(row(id)).toBeTruthy()
  }
  async function rowLeavesThePage(id: string): Promise<void> {
    server.state.page = server.state.page.filter((each) => each !== id)
    await realtime().reloadCurrentSheetPage()
    await flushUi()
    expect(row(id)).toBeUndefined()
  }

  it('a new manual row: drawer 6 (out), drawer 7 (held); the row comes onto the page; a grid edit of the cell to 9 (the newest): the grid\'s 9 is stored and the held 7, made on the copy, conflicts (as on main)', async () => {
    await newRowOffThePage()
    const all = [onPatch()(F.total, 6)]
    await step()
    all.push(onPatch()(F.total, 7))
    await step()
    await rowComesOntoThePage('rec_wb_new')
    all.push(gridEdit('rec_wb_new', F.total, 9))
    await step()
    await server.answerAll()
    await Promise.all(all)
    expect(writes()).toEqual([[F.total, 6, 1, 'stored v2'], [F.total, 9, 2, 'stored v3'], [F.total, 7, 2, 'VERSION_CONFLICT']])
    expect(server.stored.get('rec_wb_new')!.data[F.total]).toBe(9)
    expect(realGrid.conflict.value).toMatchObject({ fieldId: F.total, attemptedValue: 7 })
  })

  it('after a realtime merge of a manual row on the page: a drawer save (out); the row leaves the page; a second save, made on the copy, waits for the first and goes with the version it returned; then a third', async () => {
    await afterMerge()
    const all = [onPatch()(F.total, 6)]
    await step()
    await rowLeavesThePage('rec_wb_manual')
    expect(shown()!.id).toBe('rec_wb_manual')
    all.push(onPatch()(F.total, 7))
    await step()
    await server.answerAll()
    await Promise.all(all)
    const third = onPatch()(F.total, 8)
    await step()
    await server.answerAll()
    await third
    expect(writes()).toEqual([[F.total, 6, 3, 'stored v4'], [F.total, 7, 4, 'stored v5'], [F.total, 8, 5, 'stored v6']])
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('after a realtime merge of a manual row: a drawer save is stored, and another merge that read it lands before its answer: the copy keeps that merge\'s version (not one more), so later saves on the page and on the copy store', async () => {
    await afterMerge()
    const first = onPatch()(F.total, 6)
    await step()
    server.store()
    await realtime().mergeRemoteRecord('rec_wb_manual')
    await flushUi()
    await server.release()
    await first
    const onPage = onPatch()(F.total, 7)
    await step()
    await server.answerAll()
    await onPage
    await rowLeavesThePage('rec_wb_manual')
    expect(shown()).toMatchObject({ id: 'rec_wb_manual', version: 5, data: { [F.total]: 7 } })
    const onCopy = onPatch()(F.total, 8)
    await step()
    await server.answerAll()
    await onCopy
    expect(writes()).toEqual([[F.total, 6, 3, 'stored v4'], [F.total, 7, 4, 'stored v5'], [F.total, 8, 5, 'stored v6']])
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('after a realtime merge of a manual row: a grid edit of 备注 is stored, then a drawer save on the row: the copy, which lacks the grid edit, keeps its version; off the page a save of 备注 on it conflicts, not stored over the grid edit', async () => {
    await afterMerge()
    const edit = gridEdit('rec_wb_manual', F.notes, 'g')
    await step()
    await server.answerAll()
    await edit
    const save = onPatch()(F.total, 6)
    await step()
    await server.answerAll()
    await save
    await rowLeavesThePage('rec_wb_manual')
    expect(shown()).toMatchObject({ id: 'rec_wb_manual', version: 3 })
    const onCopy = onPatch()(F.notes, 'mine')
    await step()
    await server.answerAll()
    await onCopy
    expect(writes()).toEqual([[F.notes, 'g', 3, 'stored v4'], [F.total, 6, 4, 'stored v5'], [F.notes, 'mine', 3, 'VERSION_CONFLICT']])
    expect(server.stored.get('rec_wb_manual')!.data[F.notes]).toBe('g')
  })

  /** A record the loaded page does not hold, opened by its link: the drawer shows its copy. */
  async function openedOffThePage(recordId: string): Promise<void> {
    workbenchMock = createWorkbenchMock('grid', withBlock())
    getRecordFromServer()
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component, { recordId }) } })
    app = createApp(Host)
    app.mount(container!)
    await server.tick()
    await vi.waitFor(() => expect(realGrid.rows.value).toHaveLength(2))
    await flushUi(10)
    expect(row(recordId)).toBeUndefined()
    expect(shown()!.id).toBe(recordId)
  }

  it('a record off the page: a save is stored, and an attachment removal is stored after it but answered first: the copy takes the save, then the removal, so the removal\'s patch is stored', async () => {
    await openedOffThePage('rec_wb_far')
    const save = onPatch()(F.notes, 'a')
    await step()
    server.store()
    workbenchMock.client.deleteAttachment = vi.fn(async () => {
      const record = server.stored.get('rec_wb_far')!
      record.version += 1
      record.data[F.code] = ['att_2']
      return { deleted: 'att_1' }
    })
    const remove = (captured.MetaRecordInspector!['delete-attachment-fn'] as (id: string, context: { recordId: string; fieldId: string }) => Promise<void>)('att_1', { recordId: 'rec_wb_far', fieldId: F.code })
    await step()
    await server.release()
    await save
    await remove
    const patch = onPatch()(F.code, ['att_2'])
    await step()
    await server.answerAll()
    await patch
    expect(writes()).toEqual([[F.notes, 'a', 8, 'stored v9'], [F.code, ['att_2'], 10, 'stored v11']])
    expect(shown()).toMatchObject({ id: 'rec_wb_far', version: 11, data: { [F.notes]: 'a' } })
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('a save on the row, and a realtime merge that read before it was stored lands while it is out (the drawer now holds a copy): the copy takes the save, so once the row leaves the page a save on the copy is stored', async () => {
    await onTheRow('rec_wb_plm')
    const first = onPatch()(F.notes, 'a')
    await step()
    await realtime().mergeRemoteRecord('rec_wb_plm')
    await flushUi()
    await server.answerAll()
    await first
    await rowLeavesThePage('rec_wb_plm')
    expect(shown()).toMatchObject({ id: 'rec_wb_plm', version: 6, data: { [F.notes]: 'a' } })
    const onCopy = onPatch()(F.notes, 'b')
    await step()
    await server.answerAll()
    await onCopy
    expect(writes()).toEqual([[F.notes, 'a', 5, 'stored v6'], [F.notes, 'b', 6, 'stored v7']])
  })

  it('a write named for a record on the page that the drawer holds a copy of (the drawer moved on) goes with the row\'s version, not the older copy\'s', async () => {
    await afterMerge('rec_wb_plm')
    const edit = gridEdit('rec_wb_plm', F.spec, 'G')
    await step()
    await server.answerAll()
    await edit
    await (captured.MetaGridTable!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_manual')
    await flushUi()
    const named = (captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown, recordId?: string) => Promise<void>)(F.notes, 'late', 'rec_wb_plm')
    await step()
    await server.answerAll()
    await named
    expect(writes().at(-1)).toEqual([F.notes, 'late', 6, 'stored v7'])
  })

  it('after a realtime merge of a manual row: a save is stored, another user changes the cell, and a merge reading their change lands before the answer: the copy keeps their value and version', async () => {
    await afterMerge()
    const save = onPatch()(F.total, 6)
    await step()
    server.store()
    const record = server.stored.get('rec_wb_manual')!
    record.version += 1
    record.data[F.total] = 9
    await realtime().mergeRemoteRecord('rec_wb_manual')
    await flushUi()
    await server.release()
    await save
    await rowLeavesThePage('rec_wb_manual')
    expect(shown()).toMatchObject({ id: 'rec_wb_manual', version: 5, data: { [F.total]: 9 } })
  })

  it.each([['kanban', 'MetaKanbanView'], ['calendar', 'MetaCalendarView']])('a %s view: after a realtime merge of the record shown the drawer shows the grid\'s row, and two quick saves both store', async (viewType, stub) => {
    await mount(viewType, withBlock())
    await vi.waitFor(() => expect(realGrid.rows.value).toHaveLength(2))
    await flushUi()
    getRecordFromServer()
    await (captured[stub]!.onSelectRecord as (id: string) => Promise<void>)('rec_wb_plm')
    await flushUi()
    await realtime().mergeRemoteRecord('rec_wb_plm')
    await flushUi()
    expect(shown()).toBe(row('rec_wb_plm'))
    const all = [onPatch()(F.notes, 'a')]
    await step()
    all.push(onPatch()(F.notes, 'b'))
    await step()
    await server.answerAll()
    await Promise.all(all)
    expect(writes()).toEqual([[F.notes, 'a', 5, 'stored v6'], [F.notes, 'b', 6, 'stored v7']])
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('a new manual row comes onto the page, moved on by another user, while its first step is out: the next step, made on the copy, is sent on it as given and conflicts (as on main); the copy never claims a version past its data', async () => {
    await newRowOffThePage()
    const first = onPatch()(F.total, 6)
    await step()
    server.store()
    const record = server.stored.get('rec_wb_new')!
    record.version += 1
    record.data[F.notes] = 'theirs'
    server.state.page.push('rec_wb_new')
    await realtime().reloadCurrentSheetPage()
    await flushUi()
    expect(row('rec_wb_new')).toMatchObject({ version: 3 })
    const second = onPatch()(F.total, 7)
    await step()
    expect(server.sent).toHaveLength(1)
    await server.release()
    await server.answerAll()
    await Promise.all([first, second])
    expect(writes()).toEqual([[F.total, 6, 1, 'stored v2'], [F.total, 7, 2, 'VERSION_CONFLICT']])
    // Off the page again, the drawer shows the copy: the first step's version, never 'theirs' (v3) without its data.
    server.state.page = server.state.page.filter((id) => id !== 'rec_wb_new')
    await realtime().reloadCurrentSheetPage()
    await flushUi()
    expect(row('rec_wb_new')).toBeUndefined()
    expect(shown()).toMatchObject({ id: 'rec_wb_new', version: 2, data: { [F.total]: 6 } })
  })
})

// ── W-11 the three in-place entries (fix round 2; R74's footer kept) ─────────────────────────────────────────────────
// On an ordinary sheet 「+ 新建记录」 sits in three places: the toolbar (top right), the inline row after the last row
// (grouped: after the last group — on the last page the 「(无值)」 one) and the footer (left of the pager, R74: a long
// sheet needs no scrolling). On a registered project sheet in state `allowed` each place holds 「+ 新增人工补充行」 and
// opens the same dialog; in every other state none of them holds any entry.

const TOOLBAR_ENTRY = '[data-testid="toolbar-add-manual-row"]'
const INLINE_ENTRY = '[data-testid="grid-inline-add-manual-row"]'
const FOOTER_ENTRY = '[data-testid="grid-footer-add-manual-row"]'
const entryText = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const buttonsReading = (root: ParentNode, pattern: RegExp) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).filter((button) => pattern.test(entryText(button)))
/** The toolbar's create place: the last item of the toolbar's action group, where 「+ 新建记录」 sits. */
const isToolbarCreatePlace = (button: Element) => button.parentElement!.lastElementChild === button
const isLastTbodyRow = (button: Element) => {
  const tr = button.closest('tr')!
  return tr.parentElement!.tagName === 'TBODY' && tr.parentElement!.lastElementChild === tr
}
const isFooterFirstItem = (button: Element) =>
  button.closest('.meta-grid__pagination') !== null && button.closest('.meta-grid__table-wrap') === null
  && button.parentElement!.firstElementChild === button

describe('W-11 the three in-place entries (the real toolbar and grid, fed the workbench\'s own props)', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))

  it.each([
    ['the toolbar (top right)', 'MetaToolbar', TOOLBAR_ENTRY],
    ['the inline row after the last row', 'MetaGridTable', INLINE_ENTRY],
    ['the footer (left of the pager)', 'MetaGridTable', FOOTER_ENTRY],
  ] as const)('allowed — %s: 「+ 新增人工补充行」, a keyboard-reachable button that opens the dialog; no generic create', async (_place, name, selector) => {
    await mount('grid', withBlock())
    const root = await mountReal(name)
    const entry = root.querySelector<HTMLButtonElement>(selector)
    expect(entry, 'the in-place entry').not.toBeNull()
    expect(entryText(entry)).toBe('+ 新增人工补充行')
    expect(buttonsReading(root, /新建记录/)).toHaveLength(0)
    expect(entry!.tagName).toBe('BUTTON')
    expect(entry!.disabled).toBe(false)
    expect(entry!.tabIndex).toBe(0)
    entry!.focus()
    expect(document.activeElement).toBe(entry)
    expect(dialog()).toBeNull()
    entry!.click()
    await flushUi()
    expect(dialog(), 'the same MetaManualRowDialog').not.toBeNull()
    const required = Array.from(document.body.querySelectorAll<HTMLElement>('[data-manual-row-field]'))
      .filter((row) => (row.textContent ?? '').includes('*'))
      .map((row) => row.getAttribute('data-manual-row-field'))
    expect(required, 'only 名称 and 总用量 are required').toEqual([F.name, F.total])
    expect(document.body.querySelector('[data-testid="manual-row-dialog-project-no"]'), '项目号 is shown').not.toBeNull()
    expect(document.body.querySelector('[data-testid="manual-row-dialog-project-no"] input'), '项目号 is read-only (filled by the server)').toBeNull()
    expect(gridMock.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('allowed: each entry sits where the generic one sits — the toolbar\'s last action, the tbody\'s last row, the footer\'s first item outside the scroll area', async () => {
    await mount('grid', withBlock())
    const toolbar = await mountReal('MetaToolbar')
    const gridRoot = await mountReal('MetaGridTable')
    expect(isToolbarCreatePlace(toolbar.querySelector(TOOLBAR_ENTRY)!)).toBe(true)
    expect(isLastTbodyRow(gridRoot.querySelector(INLINE_ENTRY)!)).toBe(true)
    expect(isFooterFirstItem(gridRoot.querySelector(FOOTER_ENTRY)!)).toBe(true)
  })

  it('allowed, grouped by 名称: the inline entry follows the last group (the 「(无值)」 one here) and opens the dialog', async () => {
    gridMock.rows.value = [...ROWS(), { id: 'rec_wb_blank', version: 1, data: { [F.name]: '', [F.spec]: '', [F.notes]: 'note-of-the-blank-row' } }]
    gridMock.groupFields.value = [FIELDS.find((field) => field.id === F.name)!]
    await mount('grid', withBlock())
    const gridRoot = await mountReal('MetaGridTable')
    const headers = gridRoot.querySelectorAll('[data-test="group-header"]')
    expect(headers).toHaveLength(3)
    expect(entryText(headers[2])).toContain('(无值)')
    const entry = gridRoot.querySelector<HTMLButtonElement>(INLINE_ENTRY)!
    expect(isLastTbodyRow(entry)).toBe(true)
    expect(entry.closest('tr')!.previousElementSibling!.textContent).toContain('note-of-the-blank-row')
    entry.click()
    await flushUi()
    expect(dialog()).not.toBeNull()
    expect(gridMock.createRecord).not.toHaveBeenCalled()
  })

  it('each entry has its generic counterpart\'s element and classes (the same size), place by place', async () => {
    const shape = (button: Element | null | undefined) => (button ? { tag: button.tagName, cls: button.className } : null)
    await mount('grid', { ...WRITER_CAPS })
    let toolbar = await mountReal('MetaToolbar')
    let gridRoot = await mountReal('MetaGridTable')
    const generic = [
      shape(buttonsReading(toolbar, /^\+ 新建记录$/)[0]),
      shape(gridRoot.querySelector('.meta-grid__add-row-btn')),
      shape(gridRoot.querySelector('[data-testid="grid-footer-add-record"]')),
    ]
    while (realApps.length) realApps.pop()!.unmount()
    unmount()
    for (const key of Object.keys(captured)) captured[key] = null
    await mount('grid', withBlock())
    toolbar = await mountReal('MetaToolbar')
    gridRoot = await mountReal('MetaGridTable')
    const manual = [shape(toolbar.querySelector(TOOLBAR_ENTRY)), shape(gridRoot.querySelector(INLINE_ENTRY)), shape(gridRoot.querySelector(FOOTER_ENTRY))]
    expect(generic.every((item) => item !== null)).toBe(true)
    expect(manual).toEqual(generic)
  })

  it.each([
    ['lock_missing', { state: 'unavailable', reason: 'lock_missing' }, '需管理员修复本表', false],
    ['disabled', { state: 'disabled' }, null, false],
    ['lock_missing, grouped by 名称', { state: 'unavailable', reason: 'lock_missing' }, '需管理员修复本表', true],
    ['disabled, grouped by 名称', { state: 'disabled' }, null, true],
  ] as const)('%s: none of the three places holds any create entry (neither 新增人工补充行 nor 新建记录); the note gives the reason', async (_state, partial, headline, grouped) => {
    if (grouped) gridMock.groupFields.value = [FIELDS.find((field) => field.id === F.name)!]
    await mount('grid', withBlock({ ...BLOCK, ...partial }))
    const toolbar = await mountReal('MetaToolbar')
    const gridRoot = await mountReal('MetaGridTable')
    if (grouped) expect(gridRoot.querySelectorAll('[data-test="group-header"]').length, 'the grouped render path').toBeGreaterThan(0)
    for (const selector of [TOOLBAR_ENTRY, INLINE_ENTRY, FOOTER_ENTRY]) expect(document.body.querySelector(selector), selector).toBeNull()
    expect(gridRoot.querySelector('[data-testid="grid-footer-add-record"]')).toBeNull()
    expect(gridRoot.querySelector('.meta-grid__add-row-btn')).toBeNull()
    expect(buttonsReading(toolbar, /新建记录|新增人工补充行/)).toHaveLength(0)
    expect(buttonsReading(gridRoot, /新建记录|新增人工补充行/)).toHaveLength(0)
    expect(container!.querySelector('[data-testid="manual-rows-reason"]')).not.toBeNull()
    const headlineEl = container!.querySelector('[data-testid="manual-rows-reason-headline"]')
    if (headline) expect(headlineEl?.textContent?.trim()).toBe(headline)
    else expect(headlineEl).toBeNull()
    expect(dialog()).toBeNull()
  })

  it('an ordinary sheet (no block): all three places keep 「+ 新建记录」, each sends the generic create; no manual entry, no dialog', async () => {
    await mount('grid', { ...WRITER_CAPS })
    const toolbar = await mountReal('MetaToolbar')
    const gridRoot = await mountReal('MetaGridTable')
    for (const selector of [TOOLBAR_ENTRY, INLINE_ENTRY, FOOTER_ENTRY]) expect(document.body.querySelector(selector), selector).toBeNull()
    const toolbarAdd = buttonsReading(toolbar, /^\+ 新建记录$/)
    expect(toolbarAdd).toHaveLength(1)
    const inlineAdd = gridRoot.querySelector<HTMLButtonElement>('.meta-grid__add-row-btn')!
    const footerAdd = gridRoot.querySelector<HTMLButtonElement>('[data-testid="grid-footer-add-record"]')!
    expect(isToolbarCreatePlace(toolbarAdd[0])).toBe(true)
    expect(isLastTbodyRow(inlineAdd)).toBe(true)
    expect(isFooterFirstItem(footerAdd)).toBe(true)
    for (const button of [toolbarAdd[0], inlineAdd, footerAdd]) {
      expect(entryText(button)).toBe('+ 新建记录')
      button.click()
      await flushUi()
    }
    expect(gridMock.createRecord).toHaveBeenCalledTimes(3)
    expect(dialog()).toBeNull()
    expect(note()).toBeNull()
  })
})

describe('W-11b the entries follow the ACTIVE sheet\'s own /context (proposed MF-2)', () => {
  it('while the capabilities still belong to the previous sheet: no entry in any place; after the active sheet\'s /context lands: all three', async () => {
    useLocale().setLocale('zh-CN')
    const capabilitiesSheetId = ref<string | null>('sheet_wb_previous')
    workbenchMock = { ...createWorkbenchMock('grid', withBlock()), capabilitiesSheetId }
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
    expect(captured.MetaToolbar!['manual-row-create']).toBe(false)
    expect(captured.MetaGridTable!['manual-row-create']).toBe(false)
    let toolbar = await mountReal('MetaToolbar')
    let gridRoot = await mountReal('MetaGridTable')
    for (const selector of [TOOLBAR_ENTRY, INLINE_ENTRY, FOOTER_ENTRY]) expect(document.body.querySelector(selector), selector).toBeNull()
    expect(buttonsReading(toolbar, /新建记录|新增人工补充行/)).toHaveLength(0)
    expect(buttonsReading(gridRoot, /新建记录|新增人工补充行/)).toHaveLength(0)
    while (realApps.length) realApps.pop()!.unmount()
    capabilitiesSheetId.value = 'sheet_wb'
    await flushUi()
    expect(captured.MetaToolbar!['manual-row-create']).toBe(true)
    expect(captured.MetaGridTable!['manual-row-create']).toBe(true)
    toolbar = await mountReal('MetaToolbar')
    gridRoot = await mountReal('MetaGridTable')
    expect(toolbar.querySelector(TOOLBAR_ENTRY)).not.toBeNull()
    expect(gridRoot.querySelector(INLINE_ENTRY)).not.toBeNull()
    expect(gridRoot.querySelector(FOOTER_ENTRY)).not.toBeNull()
  })
})
