import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { ManualCellWrite } from '../src/multitable/composables/useMultitableGrid'

// 人工补充行的父组件 (ADR adr-stock-prep-manual-rows-20261030 §12.2 / §12.6 / §12.7 ①, slice P2) — the workbench wiring,
// on the same harness as multitable-workbench-permission-wiring-manual-rows.spec.ts:
//
//   MP-W1 the 新增 dialog shows 「父组件」 only with /context `parentFieldIds`; 选已有的 reads the host candidates (the
//         typed own 图号 left out) and the pick is sent exactly as returned; the pair never becomes a grid cell editor;
//   MP-W2 the drawer's 「修改父组件」 is offered for a manual row with the pair AND `componentCodeFieldId` only (the
//         self-parent check compares with that column; without it the edit route answers 403); it saves BOTH columns through
//         PATCH …/manual-fields with the row's version and reloads; a refusal keeps the dialog with the server text;
//   MP-W3 changing a manual row's 图号 (grid cell, drawer) or deleting manual rows asks 「有 N 行人工补充行以它为父组件…」
//         when the host counts dependents; cancel aborts; no count / no change / PLM rows ask nothing; an actor without
//         the pair is still asked, the 图号 column then named by the BOM-relations block.
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
vi.mock('../src/multitable/composables/useMultitableGrid', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/composables/useMultitableGrid')>('../src/multitable/composables/useMultitableGrid')
  return {
    ...actual,
    useMultitableGrid: (options: typeof capturedGridOptions) => {
      capturedGridOptions = options
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

const dialog = () => document.body.querySelector('[data-testid="manual-row-dialog"]')
/** What the toolbar's in-place 「新增人工补充行」 emits (the base spec's W-11 proves the real button reaches it). */
async function openFromToolbarEntry(): Promise<void> {
  const onAddManualRow = captured.MetaToolbar!.onAddManualRow as () => void
  onAddManualRow()
  await flushUi()
}

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


// ── 人工补充行的父组件 (ADR §12, slice P2): the workbench wiring ─────────────────────────────────────────────────────

const PARENT = { code: 'fld_wb_pcode', name: 'fld_wb_pname' }
const PARENT_FIELDS = [
  ...FIELDS,
  { id: PARENT.code, name: '父组件图号', type: 'string', property: { ...LOCK } },
  { id: PARENT.name, name: '父组件名称', type: 'string', property: { ...LOCK } },
]
// Beside the pair the block names the row's own 图号 (`componentCodeFieldId`) to an actor who may read it.
const PARENT_BLOCK = { ...BLOCK, parentFieldIds: { ...PARENT }, componentCodeFieldId: F.code }
// The same column as the BOM-relations block of the sheet names it — only the 图号 change warning falls back to it.
const BOM_BLOCK = {
  componentSourceFieldId: 'fld_wb_src', parentSourceFieldId: 'fld_wb_psrc', activeFieldId: 'fld_wb_active',
  componentCodeFieldId: F.code, componentNameFieldId: F.name,
}
const PARENT_ROWS = () => [
  { id: 'rec_wb_manual', version: 3, data: { [F.code]: 'SYN-OWN', [F.name]: 'Synthetic part', [PARENT.code]: 'SYN-P1', [PARENT.name]: 'Synthetic parent' } },
  { id: 'rec_wb_plm', version: 5, data: { [F.code]: 'SYN-PLM', [F.name]: 'PLM part', [PARENT.code]: 'SYN-P0', [PARENT.name]: 'PLM parent' } },
]

async function mountParent(block: Record<string, unknown> = PARENT_BLOCK, extraCaps: Record<string, unknown> = {}): Promise<void> {
  gridMock.fields.value = PARENT_FIELDS
  gridMock.visibleFields.value = PARENT_FIELDS
  gridMock.rows.value = PARENT_ROWS()
  gridMock.fieldPermissions.value = Object.fromEntries(PARENT_FIELDS.map((f) => [f.id, { visible: true, readOnly: f.id !== F.notes }]))
  workbenchMock = null
  await mount('grid', { ...withBlock(block), ...extraCaps })
  workbenchMock.fields.value = PARENT_FIELDS
  Object.assign(workbenchMock.client, {
    listManualRowParentOptions: vi.fn().mockResolvedValue({
      items: [
        { code: ' SYN-P1 ', name: 'Synthetic parent ', kind: 'parent', childCount: 3 },
        { code: 'SYN-OWN', name: 'Self', kind: 'component' },
        { code: 'SYN-C9', name: null, kind: 'component' },
      ],
      truncated: false,
    }),
    countManualRowParentDependents: vi.fn().mockResolvedValue({ count: 0 }),
    patchManualRowFields: vi.fn().mockResolvedValue({ updated: [{ recordId: 'rec_wb_manual', version: 4 }] }),
  })
  await flushUi()
}

async function selectRow(id: string): Promise<void> {
  await (captured.MetaGridTable!.onSelectRecord as (recordId: string) => Promise<void>)(id)
  await flushUi()
}

describe('MP-W1 the 新增 dialog gets the parent picker only with /context parentFieldIds', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))

  it('with the pair: the fieldset shows; 选已有的 lists the host candidates without the typed own 图号; the pick is sent exactly as returned', async () => {
    await mountParent()
    workbenchMock.client.createManualRow.mockResolvedValue({ record: { id: 'rec_wb_new' } })
    await openFromToolbarEntry()
    expect(dialog()?.querySelector('[data-testid="manual-row-dialog-parent"]')).not.toBeNull()
    const input = (fieldId: string) => dialog()!.querySelector<HTMLInputElement>(`[data-manual-row-field="${fieldId}"] input`)!
    input(F.name).value = 'Synthetic new'; input(F.name).dispatchEvent(new Event('input'))
    input(F.total).value = '2'; input(F.total).dispatchEvent(new Event('input'))
    input(F.code).value = 'SYN-OWN'; input(F.code).dispatchEvent(new Event('input'))
    const pick = dialog()!.querySelector<HTMLInputElement>('[data-manual-parent-mode="pick"]')!
    pick.checked = true; pick.dispatchEvent(new Event('change'))
    await flushUi()
    expect(workbenchMock.client.listManualRowParentOptions).toHaveBeenCalledWith('sheet_wb', undefined)
    const options = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('[data-manual-parent-option]'))
    expect(options.map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['SYN-P1 Synthetic parent 3 个子件', 'SYN-C9 （无名称）'])
    options[0].click()
    await flushUi()
    dialog()!.querySelector<HTMLButtonElement>('[data-action="manual-row-dialog-submit"]')!.click()
    await flushUi()
    expect(workbenchMock.client.createManualRow).toHaveBeenCalledWith('sheet_wb', {
      [F.name]: 'Synthetic new', [F.total]: 2, [F.code]: 'SYN-OWN',
      [PARENT.code]: ' SYN-P1 ', [PARENT.name]: 'Synthetic parent ',
    })
  })

  it('with the pair but no componentCodeFieldId (the actor cannot read 图号): the fieldset still shows — a create is not refused for it', async () => {
    const { componentCodeFieldId: _omit, ...pairOnly } = PARENT_BLOCK
    await mountParent(pairOnly)
    await openFromToolbarEntry()
    expect(dialog()?.querySelector('[data-testid="manual-row-dialog-parent"]')).not.toBeNull()
  })

  it('without the pair: no fieldset, and the create sends no parent key', async () => {
    await mountParent(BLOCK)
    await openFromToolbarEntry()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector('[data-testid="manual-row-dialog-parent"]')).toBeNull()
  })

  it('the grid never gets the pair as single-cell editors, even if a host listed them as editable', async () => {
    await mountParent({ ...PARENT_BLOCK, editableFieldIds: [...BLOCK.editableFieldIds, PARENT.code, PARENT.name] })
    const ids = captured.MetaGridTable!['manual-row-field-ids'] as string[]
    expect(ids).not.toContain(PARENT.code)
    expect(ids).not.toContain(PARENT.name)
    expect(capturedGridOptions!.resolveManualCellWrite!('rec_wb_manual', PARENT.code)).toBeNull()
  })
})

describe('MP-W2 the drawer\'s 「修改父组件」', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))

  it('is offered for a manual row only, and only with parentFieldIds', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    expect(captured.MetaRecordInspector!['manual-parent']).toEqual({ code: 'SYN-P1', name: 'Synthetic parent' })
    await selectRow('rec_wb_plm')
    expect(captured.MetaRecordInspector!['manual-parent']).toBeNull()
    unmount()
    await mountParent(BLOCK)
    await selectRow('rec_wb_manual')
    expect(captured.MetaRecordInspector!['manual-parent']).toBeNull()
  })

  it('is hidden when the block names the pair without componentCodeFieldId (PATCH …/manual-fields would answer 403) — the BOM block does not stand in', async () => {
    const { componentCodeFieldId: _omit, ...pairOnly } = PARENT_BLOCK
    await mountParent(pairOnly, { stockPreparationBomRelations: BOM_BLOCK })
    await selectRow('rec_wb_manual')
    expect(captured.MetaRecordInspector!['manual-parent']).toBeNull()
  })

  it('takes the row\'s own 图号 from componentCodeFieldId for the self-parent check', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    ;(captured.MetaRecordInspector!.onEditManualParent as () => void)()
    await flushUi()
    const modal = document.body.querySelector('[data-testid="manual-parent-dialog"]')!
    const fresh = modal.querySelector<HTMLInputElement>('[data-manual-parent-mode="new"]')!
    fresh.checked = true; fresh.dispatchEvent(new Event('change'))
    await flushUi()
    const code = modal.querySelector<HTMLInputElement>('[data-testid="manual-parent-new-code"]')!
    const name = modal.querySelector<HTMLInputElement>('[data-testid="manual-parent-new-name"]')!
    code.value = ' SYN-OWN '; code.dispatchEvent(new Event('input'))
    name.value = 'Synthetic self'; name.dispatchEvent(new Event('input'))
    modal.querySelector<HTMLButtonElement>('[data-action="manual-parent-dialog-submit"]')!.click()
    await flushUi()
    expect(workbenchMock.client.patchManualRowFields).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="manual-parent-dialog-error"]')?.textContent?.trim()).toBeTruthy()
  })

  it('saves BOTH columns through manual-fields with the row\'s version, then reloads the page', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    ;(captured.MetaRecordInspector!.onEditManualParent as () => void)()
    await flushUi()
    const modal = document.body.querySelector('[data-testid="manual-parent-dialog"]')!
    expect(modal).not.toBeNull()
    const remove = modal.querySelector<HTMLInputElement>('[data-manual-parent-mode="remove"]')!
    remove.checked = true; remove.dispatchEvent(new Event('change'))
    await flushUi()
    gridMock.loadViewData.mockClear()
    modal.querySelector<HTMLButtonElement>('[data-action="manual-parent-dialog-submit"]')!.click()
    await flushUi()
    expect(workbenchMock.client.patchManualRowFields).toHaveBeenCalledWith('rec_wb_manual', {
      sheetId: 'sheet_wb', expectedVersion: 3, data: { [PARENT.code]: null, [PARENT.name]: null },
    })
    expect(gridMock.loadViewData).toHaveBeenCalled()
    expect(showSuccessSpy.mock.calls[0]?.[0]).toBe('已修改父组件')
    expect(document.body.querySelector('[data-testid="manual-parent-dialog"]')).toBeNull()
  })

  it('keeps the dialog open with the server\'s message as is when the save is refused', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    const refusal = Object.assign(new Error('父组件图号不能和这一行自己的图号相同。'), { code: 'STOCK_PREP_MANUAL_PARENT_INVALID', status: 422 })
    workbenchMock.client.patchManualRowFields.mockRejectedValue(refusal)
    ;(captured.MetaRecordInspector!.onEditManualParent as () => void)()
    await flushUi()
    const modal = document.body.querySelector('[data-testid="manual-parent-dialog"]')!
    const fresh = modal.querySelector<HTMLInputElement>('[data-manual-parent-mode="new"]')!
    fresh.checked = true; fresh.dispatchEvent(new Event('change'))
    await flushUi()
    const code = modal.querySelector<HTMLInputElement>('[data-testid="manual-parent-new-code"]')!
    const name = modal.querySelector<HTMLInputElement>('[data-testid="manual-parent-new-name"]')!
    code.value = '  SYN-NEW  '; code.dispatchEvent(new Event('input'))
    name.value = ' Synthetic new parent '; name.dispatchEvent(new Event('input'))
    modal.querySelector<HTMLButtonElement>('[data-action="manual-parent-dialog-submit"]')!.click()
    await flushUi()
    expect(workbenchMock.client.patchManualRowFields).toHaveBeenCalledWith('rec_wb_manual', expect.objectContaining({
      data: { [PARENT.code]: 'SYN-NEW', [PARENT.name]: 'Synthetic new parent' },
    }))
    expect(document.body.querySelector('[data-testid="manual-parent-dialog-error"]')?.textContent?.trim()).toBe('父组件图号不能和这一行自己的图号相同。')
  })
})

describe('MP-W3 §12.7 ①: 图号 change and delete ask when other manual rows name the row as their parent', () => {
  beforeEach(() => useLocale().setLocale('zh-CN'))
  const TEXT = '有 2 行人工补充行以它为父组件，修改/删除后它们不会跟着变。要继续吗？'
  const onPatchCell = () => captured.MetaGridTable!.onPatchCell as (id: string, fieldId: string, value: unknown, version: number) => Promise<void>

  it('grid cell: cancel aborts the write; OK sends it', async () => {
    await mountParent()
    workbenchMock.client.countManualRowParentDependents.mockResolvedValue({ count: 2 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(workbenchMock.client.countManualRowParentDependents).toHaveBeenCalledWith('rec_wb_manual')
    expect(confirmSpy).toHaveBeenCalledWith(TEXT)
    expect(gridMock.patchCell).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(gridMock.patchCell).toHaveBeenCalledWith('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
  })

  it('no question when nobody depends, when the 图号 does not really change, on another column, or on a PLM row', async () => {
    await mountParent()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(workbenchMock.client.countManualRowParentDependents).toHaveBeenCalledTimes(1)
    workbenchMock.client.countManualRowParentDependents.mockClear()
    await onPatchCell()('rec_wb_manual', F.code, ' SYN-OWN ', 3)
    await onPatchCell()('rec_wb_manual', F.spec, 'SPEC-X', 3)
    await onPatchCell()('rec_wb_plm', F.code, 'SYN-PLM-2', 5)
    expect(workbenchMock.client.countManualRowParentDependents).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(gridMock.patchCell).toHaveBeenCalledTimes(4)
  })

  it('an actor without the pair is still asked: the 图号 column then comes from the BOM-relations block', async () => {
    await mountParent(BLOCK, { stockPreparationBomRelations: BOM_BLOCK })
    workbenchMock.client.countManualRowParentDependents.mockResolvedValue({ count: 2 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(confirmSpy).toHaveBeenCalledWith(TEXT)
    expect(gridMock.patchCell).not.toHaveBeenCalled()
  })

  it('without either id no question is asked (nothing names the 图号 column)', async () => {
    await mountParent(BLOCK)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(workbenchMock.client.countManualRowParentDependents).not.toHaveBeenCalled()
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
  })

  it('a count that cannot be read does not stop the write (a hint, not a gate)', async () => {
    await mountParent()
    workbenchMock.client.countManualRowParentDependents.mockRejectedValue(new Error('offline'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await onPatchCell()('rec_wb_manual', F.code, 'SYN-OWN-2', 3)
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(gridMock.patchCell).toHaveBeenCalledTimes(1)
  })

  it('drawer: cancel sends nothing and redraws the row (the box shows the stored 图号 again)', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    workbenchMock.client.countManualRowParentDependents.mockResolvedValue({ count: 2 })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await (captured.MetaRecordInspector!.onPatch as (fieldId: string, value: unknown) => Promise<void>)(F.code, 'SYN-OWN-2')
    expect(gridMock.patchCell).not.toHaveBeenCalled()
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
  })

  it('drawer delete: cancel keeps the row; OK deletes it', async () => {
    await mountParent()
    await selectRow('rec_wb_manual')
    workbenchMock.client.countManualRowParentDependents.mockResolvedValue({ count: 2 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    gridMock.deleteRecord.mockResolvedValue(true)
    await (captured.MetaRecordInspector!.onDelete as () => Promise<void>)()
    expect(confirmSpy).toHaveBeenCalledWith(TEXT)
    expect(gridMock.deleteRecord).not.toHaveBeenCalled()
    confirmSpy.mockReturnValue(true)
    await (captured.MetaRecordInspector!.onDelete as () => Promise<void>)()
    expect(gridMock.deleteRecord).toHaveBeenCalledWith('rec_wb_manual')
  })

  it('bulk delete: one question over the selected manual rows only (PLM rows are not asked about)', async () => {
    await mountParent()
    workbenchMock.client.countManualRowParentDependents.mockResolvedValue({ count: 2 })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    gridMock.resolveRowActions.mockImplementation(() => ({ canEdit: true, canDelete: true, canComment: true }))
    await (captured.MetaGridTable!.onBulkDelete as (ids: string[]) => Promise<void>)(['rec_wb_manual', 'rec_wb_plm'])
    expect(workbenchMock.client.countManualRowParentDependents).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.countManualRowParentDependents).toHaveBeenCalledWith('rec_wb_manual')
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(gridMock.deleteRecord).not.toHaveBeenCalled()
  })
})
