import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { bomRelationsLabel } from '../src/multitable/utils/bom-relations'

// 备料 「查看子件」 / 「查看所有使用位置」 (owner question 2026-11-07) — the workbench wiring, with the REAL capabilities
// composable reading /context's `stockPreparationBomRelations` block:
//
//   WB-01 detection: the block present ⇒ the drawer gets `bom-relations` for a READ-ONLY viewer; an ordinary sheet (no
//         block) ⇒ null, so the drawer shows no buttons; capabilities still belonging to the PREVIOUS sheet ⇒ null;
//   WB-02 a row without a PLM material id ⇒ the drawer gets the disabled reason;
//   WB-03 查看子件 sets the grid's viewer filter with parentSourceId `is` the row's PLM id (exact ids) and closes the
//         drawer; 查看所有使用位置 uses componentSourceId and keeps the drawer open; neither calls the view-config writers
//         (client.updateView / putPersonalViewConfig) nor the toolbar's applySortFilter;
//   WB-04 the banner shows the label 「…（只对你生效）」 and the 全部记录 note while a viewer filter is up, and its 清除 calls
//         clearViewerFilter; no banner without one.
//
// Collected by the required web gate through the existing `multitable-workbench-permission-wiring` token.

const showErrorSpy = vi.fn()
const showSuccessSpy = vi.fn()
const captured: Record<string, Record<string, unknown> | null> = {}

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
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({ useMultitableGrid: () => gridMock }))
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

// Synthetic physical ids (on a real sheet: provisioning's sha1-derived ids, which the web could not guess).
const F = { code: 'fld_wbb_code', name: 'fld_wbb_name', src: 'fld_wbb_src', parent: 'fld_wbb_parent', active: 'fld_wbb_active' }
const BLOCK = { componentSourceFieldId: F.src, parentSourceFieldId: F.parent, activeFieldId: F.active, componentCodeFieldId: F.code, componentNameFieldId: F.name }
const FIELDS = [
  { id: F.code, name: '图号', type: 'string' },
  { id: F.name, name: '名称', type: 'string' },
  { id: F.src, name: 'PLM 物料ID', type: 'string' },
  { id: F.parent, name: '父件源ID', type: 'string' },
  { id: F.active, name: '有效', type: 'boolean' },
]
const PERMS = Object.fromEntries(FIELDS.map((f) => [f.id, { visible: true, readOnly: true }]))
const READER_CAPS = {
  canRead: true, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false, canManageFields: false,
  canManageSheetAccess: false, canManageViews: false, canComment: false, canManageAutomation: false, canExport: false,
}
const ROWS = () => [
  { id: 'rec_wbb_s01', version: 1, data: { [F.code]: 'S-01', [F.name]: 'Synthetic sub-assembly', [F.src]: 'SRC-S01', [F.parent]: 'SRC-P07', [F.active]: true } },
  { id: 'rec_wbb_nosrc', version: 1, data: { [F.code]: 'X', [F.name]: 'Synthetic manual row', [F.active]: true } },
]

function createWorkbenchMock(capabilities: Record<string, unknown>, capabilitiesSheetId = 'sheet_wbb') {
  const activeBaseId = ref('base_wbb')
  const activeSheetId = ref<string | null>('sheet_wbb')
  const activeViewId = ref('view_wbb')
  const views = ref([{ id: 'view_wbb', sheetId: 'sheet_wbb', name: '备料填写视图', type: 'grid', hiddenFieldIds: [F.src, F.parent] }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_wbb', name: 'Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_wbb' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(), renameSheet: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      putPersonalViewConfig: vi.fn(), deletePersonalViewConfig: vi.fn(), aggregateView: vi.fn().mockResolvedValue({ aggregates: {} }),
      getConfigHistory: vi.fn().mockResolvedValue([]), deleteSheet: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_wbb', baseId: 'base_wbb', name: 'Sheet', description: null }]),
    fields: ref(FIELDS),
    views, activeBaseId, activeSheetId, activeViewId,
    capabilities: ref(capabilities),
    capabilitiesSheetId: ref(capabilitiesSheetId),
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
  const viewerFilter = ref<{ label: string; conditions: unknown[] } | null>(null)
  return {
    fields: ref(FIELDS), rows: ref(ROWS()), loading: ref(false), currentPage: ref(1), totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 2, hasMore: false }), visibleFields: ref(FIELDS.filter((f) => f.id !== F.src && f.id !== F.parent)), sortRules: ref([]),
    filterRules: ref([]), filterConjunction: ref('and'), filterGroups: ref([]), canLoadMore: ref(false), canUndo: ref(false), canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]), groupField: ref(null), groupFields: ref([]), hiddenFieldIds: ref<string[]>([F.src, F.parent]),
    columnWidths: ref<Record<string, number>>({}), linkSummaries: ref({}), personSummaries: ref({}), attachmentSummaries: ref({}),
    fieldPermissions: ref<Record<string, { visible: boolean; readOnly: boolean }>>({ ...PERMS }), viewPermission: ref(null),
    rowActions: ref({ canEdit: false, canDelete: false, canComment: false }),
    rowActionOverrides: ref<Record<string, unknown>>({}),
    capabilityOrigin: ref(null), conflict: ref(null), error: ref<string | null>(null), sortFilterDirty: ref(false), lastBatchId: ref(null),
    viewerFilter,
    viewerFilterParam: computed(() => (viewerFilter.value ? JSON.stringify({ conditions: viewerFilter.value.conditions }) : undefined)),
    setViewerFilter: vi.fn(async (state: { label: string; conditions: unknown[] }) => { viewerFilter.value = state }),
    clearViewerFilter: vi.fn(async () => { viewerFilter.value = null }),
    toggleFieldVisibility: vi.fn(), addSortRule: vi.fn(), removeSortRule: vi.fn(), addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(), removeFilterRule: vi.fn(), clearFilters: vi.fn(), applySortFilter: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), setGroupField: vi.fn(), setGroupFields: vi.fn(), goToPage: vi.fn(), patchCell: vi.fn().mockResolvedValue(null),
    createRecord: vi.fn().mockResolvedValue(undefined), duplicateRecord: vi.fn().mockResolvedValue(null),
    deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

async function mount(capabilities: Record<string, unknown>, capabilitiesSheetId?: string): Promise<void> {
  workbenchMock = createWorkbenchMock(capabilities, capabilitiesSheetId)
  const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
  app = createApp(Host)
  app.mount(container!)
  await flushUi()
}
/** Opens the drawer on a row the way the grid's expand affordance does. */
async function select(recordId: string): Promise<void> {
  await (captured.MetaGridTable!.onExpandRecord as (id: string) => Promise<void>)(recordId)
  await flushUi()
}
const inspectorProp = () => captured.MetaRecordInspector!['bom-relations']
async function press(kind: 'children' | 'whereUsed'): Promise<void> {
  await (captured.MetaRecordInspector!.onBomRelations as (k: string) => Promise<void>)(kind)
  await flushUi()
}
const banner = () => container!.querySelector('[data-testid="workbench-viewer-filter-banner"]')
const noViewConfigWrites = () => {
  expect(workbenchMock.client.updateView).not.toHaveBeenCalled()
  expect(workbenchMock.client.putPersonalViewConfig).not.toHaveBeenCalled()
  expect(workbenchMock.client.deletePersonalViewConfig).not.toHaveBeenCalled()
  expect(gridMock.applySortFilter).not.toHaveBeenCalled()
  expect(gridMock.addFilterRule).not.toHaveBeenCalled()
}

beforeEach(() => {
  for (const key of Object.keys(captured)) captured[key] = null
  gridMock = createGridMock()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
  useLocale().setLocale('en')
  showErrorSpy.mockReset(); showSuccessSpy.mockReset()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks()
})

describe('WB-01 detection', () => {
  it('a stock-prep main-template sheet (block present): a read-only viewer\'s drawer gets the buttons', async () => {
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    await select('rec_wbb_s01')
    expect(inspectorProp()).toEqual({ disabledReason: null })
  })

  it('an ordinary sheet (no block): the drawer gets null — no buttons', async () => {
    await mount({ ...READER_CAPS })
    await select('rec_wbb_s01')
    expect(inspectorProp()).toBeNull()
  })

  it('capabilities that still belong to the previous sheet: null until the active sheet\'s /context lands', async () => {
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK }, 'sheet_previous')
    await select('rec_wbb_s01')
    expect(inspectorProp()).toBeNull()
  })
})

describe('WB-02 a row without a PLM material id', () => {
  it('gets the disabled reason', async () => {
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    await select('rec_wbb_nosrc')
    expect(inspectorProp()).toEqual({ disabledReason: bomRelationsLabel('action.noSource', false) })
  })
})

describe('WB-03 pressing the buttons sets a viewer filter, never a view write', () => {
  it('查看子件: parentSourceId is the row\'s PLM id; the drawer closes', async () => {
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    await select('rec_wbb_s01')
    expect(captured.MetaRecordInspector!.visible).toBe(true)
    await press('children')
    expect(gridMock.setViewerFilter).toHaveBeenCalledTimes(1)
    expect(gridMock.setViewerFilter).toHaveBeenCalledWith({
      label: 'Viewing: children of S-01 (only for you)',
      conditions: [{ fieldId: F.parent, operator: 'is', value: 'SRC-S01' }],
    })
    expect(captured.MetaRecordInspector!.visible).toBe(false)
    noViewConfigWrites()
  })

  it('查看所有使用位置: componentSourceId is the row\'s PLM id; the drawer stays open (zh label)', async () => {
    useLocale().setLocale('zh-CN')
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    await select('rec_wbb_s01')
    await press('whereUsed')
    expect(gridMock.setViewerFilter).toHaveBeenCalledWith({
      label: '正在查看：S-01 的所有使用位置（只对你生效）',
      conditions: [{ fieldId: F.src, operator: 'is', value: 'SRC-S01' }],
    })
    expect(captured.MetaRecordInspector!.visible).toBe(true)
    noViewConfigWrites()
  })

  it('a stale emit on an ordinary sheet or a row without a PLM id does nothing', async () => {
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    await select('rec_wbb_nosrc')
    await press('children')
    expect(gridMock.setViewerFilter).not.toHaveBeenCalled()
  })
})

describe('WB-04 the banner', () => {
  it('shows the label and the 全部记录 note while a viewer filter is up; 清除 clears it; gone afterwards', async () => {
    useLocale().setLocale('zh-CN')
    await mount({ ...READER_CAPS, stockPreparationBomRelations: BLOCK })
    expect(banner()).toBeNull()
    await select('rec_wbb_s01')
    await press('children')
    expect(banner()).not.toBeNull()
    expect(container!.querySelector('[data-testid="workbench-viewer-filter-label"]')?.textContent?.trim()).toBe('正在查看：S-01 的子件（只对你生效）')
    expect(banner()!.textContent).toContain('全部记录')
    const clear = container!.querySelector<HTMLButtonElement>('[data-testid="workbench-viewer-filter-clear"]')!
    expect(clear.textContent?.trim()).toBe('清除，回到视图')
    clear.click()
    await flushUi()
    expect(gridMock.clearViewerFilter).toHaveBeenCalledTimes(1)
    expect(banner()).toBeNull()
    noViewConfigWrites()
  })
})
