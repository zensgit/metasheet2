import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { workbenchLabel } from '../src/multitable/utils/workbench-labels'

// R68 (#6454 judge note): on a sheet whose human-write-locked column is ALSO required by its own validation rule
// (the 备料 project sheet's PLM columns), no person-created record can ever pass — empty fails the rule, filled
// is a locked write. GET /context then sends `capabilities.recordCreateBlockedByLock: true`, and the workbench
// must hide every hand-create entry and say why:
//
//   1. absent flag → every create entry keeps the old `canCreateRecord` (toolbar add / import, grid "+ row" and
//      duplicate, inspector duplicate, kanban create, new form submission), no note;
//   2. flag true → all of them off, the zh/en note is shown, and a stale emit (grid "+ row" / duplicate) is a
//      no-op with the same copy as a toast — the grid's create / duplicate are never called;
//   3. a reader (canCreateRecord false) gets no note — nothing was taken away from them.
//
// The capabilities composable is the REAL one: the flag is read off the same /context object as canCreateRecord.

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

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))
vi.mock('../src/multitable/composables/useMultitableGrid', () => ({
  useMultitableGrid: () => gridMock,
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

const WRITER_CAPS = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false,
  canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true,
}

function createWorkbenchMock(viewType: string, capabilities: Record<string, unknown>) {
  const activeBaseId = ref('base_lock')
  const activeSheetId = ref<string | null>('sheet_lock')
  const activeViewId = ref('view_main')
  const views = ref([{ id: 'view_main', sheetId: 'sheet_lock', name: 'Main', type: viewType }])
  return {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_lock', name: 'Base' }] }),
      loadContext: vi.fn().mockResolvedValue({ base: { id: 'base_lock' }, sheet: null, sheets: [], views: [], capabilities: {} }),
      loadFormContext: vi.fn(), getRecord: vi.fn(), createSheet: vi.fn(), createBase: vi.fn(), renameSheet: vi.fn(),
      createField: vi.fn(), preparePersonField: vi.fn(), updateField: vi.fn(), deleteField: vi.fn(),
      createView: vi.fn(), deleteView: vi.fn(), patchRecords: vi.fn(), submitForm: vi.fn(), updateView: vi.fn(),
      getConfigHistory: vi.fn().mockResolvedValue([]), deleteSheet: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_lock', baseId: 'base_lock', name: 'Sheet', description: null }]),
    fields: ref([{ id: 'fld_title', name: 'Title', type: 'string' }]),
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
    createRecord: vi.fn().mockResolvedValue(undefined), duplicateRecord: vi.fn().mockResolvedValue(null),
    deleteRecord: vi.fn(), resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true), reloadCurrentPage: vi.fn(), dismissConflict: vi.fn(),
    retryConflict: vi.fn(), setColumnWidth: vi.fn(), setSearchQuery: vi.fn(),
  }
}

describe('MultitableWorkbench hand-create gate on a sheet with locked + required columns (recordCreateBlockedByLock)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    for (const key of Object.keys(captured)) captured[key] = null
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    useLocale().setLocale('en')
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.unstubAllGlobals(); vi.clearAllMocks()
  })

  async function mount(viewType: string, capabilities: Record<string, unknown>): Promise<void> {
    workbenchMock = createWorkbenchMock(viewType, capabilities)
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  const note = () => container!.querySelector('[data-testid="record-create-locked-note"]')

  it('flag absent: every hand-create entry follows canCreateRecord, no note, duplicate and "+ row" go through', async () => {
    // Customer feedback 2026-10-27: a duplicate asks first; confirming lets it through.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount('grid', { ...WRITER_CAPS })
    expect(captured.MetaToolbar!['can-create-record']).toBe(true)
    expect(captured.MetaGridTable!['can-create']).toBe(true)
    expect(captured.MetaRecordInspector!['can-create']).toBe(true)
    expect(note()).toBeNull()

    await (captured.MetaGridTable!.onDuplicateRecord as (id: string) => Promise<void>)('rec_1')
    await (captured.MetaGridTable!.onCreateRecord as () => Promise<void>)()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    confirmSpy.mockRestore()
    expect(gridMock.duplicateRecord).toHaveBeenCalledWith('rec_1')
    expect(gridMock.createRecord).toHaveBeenCalledTimes(1)
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('flag true (en): toolbar add / import, grid "+ row" + duplicate, inspector duplicate all off, with the note', async () => {
    await mount('grid', { ...WRITER_CAPS, recordCreateBlockedByLock: true })
    expect(captured.MetaToolbar!['can-create-record']).toBe(false)
    expect(captured.MetaGridTable!['can-create']).toBe(false)
    expect(captured.MetaRecordInspector!['can-create']).toBe(false)
    const copy = workbenchLabel('notice.recordCreateBlockedByLock', false)
    expect(copy).toBe('Required columns on this sheet are maintained by PLM, so rows cannot be added by hand.')
    expect(note()?.getAttribute('role')).toBe('status')
    expect(note()?.textContent?.trim()).toBe(copy)

    // A stale emit (the prop flipped after the grid rendered) is a no-op with the same copy as a toast.
    await (captured.MetaGridTable!.onDuplicateRecord as (id: string) => Promise<void>)('rec_1')
    await (captured.MetaGridTable!.onCreateRecord as () => Promise<void>)()
    expect(gridMock.duplicateRecord).not.toHaveBeenCalled()
    expect(gridMock.createRecord).not.toHaveBeenCalled()
    expect(showErrorSpy.mock.calls).toEqual([[copy], [copy]])
  })

  it('flag true (zh): the note reads 「此表的必填列由 PLM 维护，不能手工加行。」', async () => {
    useLocale().setLocale('zh-CN')
    await mount('grid', { ...WRITER_CAPS, recordCreateBlockedByLock: true })
    expect(note()?.textContent?.trim()).toBe('此表的必填列由 PLM 维护，不能手工加行。')
  })

  it('flips live when /context changes (another sheet without the lock restores the entries)', async () => {
    await mount('grid', { ...WRITER_CAPS, recordCreateBlockedByLock: true })
    expect(captured.MetaGridTable!['can-create']).toBe(false)
    workbenchMock.capabilities.value = { ...WRITER_CAPS }
    await flushUi()
    expect(captured.MetaGridTable!['can-create']).toBe(true)
    expect(captured.MetaToolbar!['can-create-record']).toBe(true)
    expect(note()).toBeNull()
  })

  it('a non-true flag value is ignored (fail-closed read: only exactly true blocks)', async () => {
    await mount('grid', { ...WRITER_CAPS, recordCreateBlockedByLock: 'true' })
    expect(captured.MetaGridTable!['can-create']).toBe(true)
    expect(note()).toBeNull()
  })

  it('a reader (canCreateRecord false) gets no note: nothing was taken away from them', async () => {
    await mount('grid', { ...WRITER_CAPS, canCreateRecord: false, recordCreateBlockedByLock: true })
    expect(captured.MetaGridTable!['can-create']).toBe(false)
    expect(note()).toBeNull()
  })

  it('kanban create and a new form submission follow the same gate', async () => {
    await mount('kanban', { ...WRITER_CAPS, recordCreateBlockedByLock: true })
    expect(captured.MetaKanbanView!['can-create']).toBe(false)
    app!.unmount(); app = null
    await mount('kanban', { ...WRITER_CAPS })
    expect(captured.MetaKanbanView!['can-create']).toBe(true)
    app!.unmount(); app = null

    await mount('form', { ...WRITER_CAPS, recordCreateBlockedByLock: true })
    expect(captured.MetaFormView!['read-only']).toBe(true)
    app!.unmount(); app = null
    await mount('form', { ...WRITER_CAPS })
    expect(captured.MetaFormView!['read-only']).toBe(false)
  })
})

// 客户反馈 2026-10-27 (R74): 「页面拉到底才有新增记录」. A hand-created record used to land as an empty last row with the
// grid reloaded to its first page, so the person still scrolled to the bottom to fill it in. Now the toolbar
// 「+ 新建记录」 and the grid's own entries (inline row, footer) open the new record in the inspector, fetching it
// when it is not among the loaded rows. The R68 gate above still applies to the new footer entry: it rides the same
// `can-create` prop, checked here against the REAL grid fed the workbench's own props.
describe('MultitableWorkbench hand-create opens the new record (客户反馈 2026-10-27)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let gridApp: VueApp<Element> | null = null
  let gridContainer: HTMLDivElement | null = null

  beforeEach(() => {
    for (const key of Object.keys(captured)) captured[key] = null
    gridMock = createGridMock()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (gridApp) gridApp.unmount()
    if (gridContainer) gridContainer.remove()
    gridApp = null; gridContainer = null
    if (app) app.unmount()
    if (container) container.remove()
    app = null; container = null
    // Opening a record writes it into the URL (deep link); the next mount would otherwise reopen it.
    window.history.replaceState(null, '', '/')
    useLocale().setLocale('en')
    showErrorSpy.mockReset(); showSuccessSpy.mockReset()
    vi.unstubAllGlobals(); vi.clearAllMocks()
  })

  async function mount(capabilities: Record<string, unknown>): Promise<void> {
    workbenchMock = createWorkbenchMock('grid', capabilities)
    const Host = defineComponent({ setup() { return () => h(MultitableWorkbench as Component) } })
    app = createApp(Host)
    app.mount(container!)
    await flushUi()
  }

  const NEW_RECORD = { id: 'rec_new', version: 1, data: { fld_title: '' } }

  it('toolbar 「+ 新建记录」: the new record (not among the loaded rows) is fetched and opened in the inspector', async () => {
    await mount({ ...WRITER_CAPS })
    gridMock.createRecord.mockResolvedValue('rec_new')
    workbenchMock.client.getRecord.mockResolvedValue({ record: NEW_RECORD })
    expect(captured.MetaRecordInspector!.visible).toBe(false)

    await (captured.MetaToolbar!.onAddRecord as () => Promise<void>)()
    await flushUi()

    expect(gridMock.createRecord).toHaveBeenCalledTimes(1)
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_new', expect.objectContaining({ sheetId: 'sheet_lock', viewId: 'view_main' }))
    expect(captured.MetaRecordInspector!.visible).toBe(true)
    expect((captured.MetaRecordInspector!.record as { id: string } | null)?.id).toBe('rec_new')
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('grid entries (inline row / footer): a new record already among the loaded rows opens without a fetch', async () => {
    await mount({ ...WRITER_CAPS })
    gridMock.rows.value = [NEW_RECORD]
    gridMock.createRecord.mockResolvedValue('rec_new')
    await flushUi()

    await (captured.MetaGridTable!.onCreateRecord as () => Promise<void>)()
    await flushUi()

    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    expect(captured.MetaRecordInspector!.visible).toBe(true)
    expect((captured.MetaRecordInspector!.record as { id: string } | null)?.id).toBe('rec_new')
  })

  it('a rejected create shows the error and leaves the inspector closed', async () => {
    await mount({ ...WRITER_CAPS })
    gridMock.createRecord.mockImplementation(async () => { gridMock.error.value = 'Title is required'; return null })

    await (captured.MetaToolbar!.onAddRecord as () => Promise<void>)()
    await flushUi()

    expect(showErrorSpy).toHaveBeenCalledWith('Title is required')
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    expect(captured.MetaRecordInspector!.visible).toBe(false)
  })

  it('passes the server total to the grid as total-rows (the footer 「跳转到第 [ ] 行」 clamps to it)', async () => {
    gridMock.page.value = { offset: 0, limit: 50, total: 1000, hasMore: true }
    await mount({ ...WRITER_CAPS })
    expect(captured.MetaGridTable!['total-rows']).toBe(1000)
  })

  it('the real grid, fed the workbench\'s own props, shows the footer 「+ 新建记录」 only when the sheet is not PLM-locked', async () => {
    const { default: RealGrid } = await vi.importActual<{ default: Component }>('../src/multitable/components/MetaGridTable.vue')
    const footerAddWith = async (capabilities: Record<string, unknown>): Promise<boolean> => {
      for (const key of Object.keys(captured)) captured[key] = null
      gridMock = createGridMock()
      gridMock.rows.value = [{ id: 'rec_1', version: 1, data: { fld_title: 'A' } }]
      await mount(capabilities)
      const props = { ...captured.MetaGridTable! }
      gridContainer = document.createElement('div')
      document.body.appendChild(gridContainer)
      gridApp = createApp({ render: () => h(RealGrid, props) })
      gridApp.mount(gridContainer)
      await flushUi()
      const present = gridContainer.querySelector('[data-testid="grid-footer-add-record"]') !== null
      gridApp.unmount(); gridContainer.remove(); gridApp = null; gridContainer = null
      app!.unmount(); app = null
      return present
    }
    expect(await footerAddWith({ ...WRITER_CAPS })).toBe(true)
    expect(await footerAddWith({ ...WRITER_CAPS, recordCreateBlockedByLock: true })).toBe(false)
    expect(await footerAddWith({ ...WRITER_CAPS, canCreateRecord: false })).toBe(false)
  })
})
