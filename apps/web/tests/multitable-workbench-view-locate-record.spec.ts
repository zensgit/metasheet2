// 客户问题 2026-10-27（4b）：点通知 / 评论深链 / URL #recordId 定位一条记录后，表格要把目标行滚进可视区；
// 目标行不在已加载的行里时，按现有分页（grid.loadMore）有上限地追加加载后再滚；仍没定位到时，详情照常
// 用 getRecord 打开，并给一条轻提示。这里挂真实的 MultitableWorkbench，表格用桩件（只暴露 scrollToRecord），
// 网格组合式函数用 mock（可控的 rows / canLoadMore / loadMore）。MetaGridTable.scrollToRecord 本身的滚动
// 计算由 tests/meta-grid-table-scroll-to-record.spec.ts 覆盖。入口：通知铃铛（同表 / 跨表）、历史中心、
// 评论深链（props.recordId + commentId）、URL #recordId；另钉住只刷新已选记录的调用方（冲突重载）不追加、不滚动。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, watch, type App as VueApp, type Component } from 'vue'
import { deepLinkLocateHint } from '../src/multitable/utils/workbench-labels'

const hoisted = vi.hoisted(() => ({
  scrollToRecord: vi.fn((_recordId: string) => true),
  toastShow: vi.fn(),
  toastShowError: vi.fn(),
  navigateRecordId: { value: 'rec_0' },
  navigateSheetId: { value: 'sheet_orders' },
}))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

function stubComponent(name: string) {
  return defineComponent({
    name,
    render() {
      return h('div', { [`data-stub-${name}`]: 'true' })
    },
  })
}


let workbenchMock: any
let gridMock: any
// 跨表用例用：在 useMultitableGrid() 被调用时（组件 setup 内）执行，好把「视图变了就重新取行」的监听
// 建在组件实例内，和真实的 useMultitableGrid 一样排进组件的 pre 任务（见跨表用例的说明）。
let gridSetupHook: ((opts: any) => void) | null = null

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

vi.mock('../src/multitable/composables/useMultitableGrid', async () => {
  const actual = await vi.importActual<typeof import('../src/multitable/composables/useMultitableGrid')>(
    '../src/multitable/composables/useMultitableGrid',
  )
  return {
    ...actual,
    useMultitableGrid: (opts: any) => {
      gridSetupHook?.(opts)
      return gridMock
    },
  }
})

vi.mock('../src/multitable/composables/useMultitableCapabilities', () => ({
  useMultitableCapabilities: () => ({
    canRead: ref(true),
    canCreateRecord: ref(true),
    canEditRecord: ref(true),
    canDeleteRecord: ref(true),
    canManageFields: ref(true),
    canManageSheetAccess: ref(true),
    canManageViews: ref(true),
    canComment: ref(true),
    canManageAutomation: ref(false), canExport: ref(true),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableComments', () => ({
  useMultitableComments: () => ({
    comments: ref([]),
    loading: ref(false),
    submitting: ref(false),
    resolvingIds: ref<string[]>([]),
    updatingIds: ref<string[]>([]),
    deletingIds: ref<string[]>([]),
    reactingKeys: ref<string[]>([]),
    error: ref<string | null>(null),
    loadComments: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    resolveComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentInbox', () => ({
  useMultitableCommentInbox: () => ({
    unreadCount: ref(0),
    refreshUnreadCount: vi.fn().mockResolvedValue(0),
  }),
}))

vi.mock('../src/multitable/composables/useMultitableCommentRealtime', () => ({
  useMultitableCommentRealtime: vi.fn(),
}))

// onCreateSheet/onInstallTemplate gate on canCreateBasesAndSheets, which
// reads auth.getAccessSnapshot() directly (not through any of the composables already mocked above).
// Grant isAdmin so the toolbar's template-library button and the rail's create-sheet path are live.
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getAccessSnapshot: () => ({ email: 'test@example.com', roles: ['admin'], permissions: [], isAdmin: true }),
    getCurrentUserId: vi.fn().mockResolvedValue('user_1'),
    // useMultitableSheetPresence/comments-realtime (reached through this component's own setup, not
    // through any of the composables already mocked above) also call these two.
    getToken: () => null,
  }),
}))

vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: vi.fn(),
}))

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: vi.fn(),
}))


vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaToolbar.vue', () => ({ default: stubComponent('MetaToolbar') }))
// 表格桩件：只暴露 scrollToRecord，记录工作台有没有、对哪条记录调用它。
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    setup(_, { expose }) {
      expose({ scrollToRecord: hoisted.scrollToRecord })
      return () => h('div', { 'data-stub-MetaGridTable': 'true' })
    },
  }),
}))
vi.mock('../src/multitable/components/MetaFormView.vue', () => ({ default: stubComponent('MetaFormView') }))
vi.mock('../src/multitable/components/MetaRecordInspector.vue', () => ({ default: stubComponent('MetaRecordInspector') }))
vi.mock('../src/multitable/components/MetaCommentsDrawer.vue', () => ({ default: stubComponent('MetaCommentsDrawer') }))
vi.mock('../src/multitable/components/MetaLinkPicker.vue', () => ({ default: stubComponent('MetaLinkPicker') }))
vi.mock('../src/multitable/components/MetaFieldManager.vue', () => ({ default: stubComponent('MetaFieldManager') }))
vi.mock('../src/multitable/components/MetaKanbanView.vue', () => ({ default: stubComponent('MetaKanbanView') }))
vi.mock('../src/multitable/components/MetaGalleryView.vue', () => ({ default: stubComponent('MetaGalleryView') }))
vi.mock('../src/multitable/components/MetaCalendarView.vue', () => ({ default: stubComponent('MetaCalendarView') }))
vi.mock('../src/multitable/components/MetaTimelineView.vue', () => ({ default: stubComponent('MetaTimelineView') }))
vi.mock('../src/multitable/components/MetaImportModal.vue', () => ({ default: stubComponent('MetaImportModal') }))
vi.mock('../src/multitable/components/MetaBasePicker.vue', () => ({ default: stubComponent('MetaBasePicker') }))
vi.mock('../src/multitable/components/MetaDashboardView.vue', () => ({ default: stubComponent('MetaDashboardView') }))
// 通知铃铛桩件：点一下就发出 navigate（表 id、记录 id 由用例设定）。
vi.mock('../src/multitable/components/MetaNotificationBell.vue', () => ({
  default: defineComponent({
    name: 'MetaNotificationBell',
    props: ['apiClient'],
    emits: ['navigate'],
    setup(_, { emit }) {
      return () => h('button', {
        type: 'button',
        'data-testid': 'stub-notification-navigate',
        onClick: () => emit('navigate', { sheetId: hoisted.navigateSheetId.value, recordId: hoisted.navigateRecordId.value }),
      }, 'navigate')
    },
  }),
}))
vi.mock('../src/multitable/components/MetaViewManager.vue', () => ({ default: stubComponent('MetaViewManager') }))
// 历史中心桩件：点一下就发出 open-record（同一张表，记录 id 由用例设定）。
vi.mock('../src/multitable/components/HistoryCenterModal.vue', () => ({
  default: defineComponent({
    name: 'HistoryCenterModal',
    emits: ['open-record', 'close', 'restored'],
    setup(_, { emit }) {
      return () => h('button', {
        type: 'button',
        'data-testid': 'stub-history-open-record',
        onClick: () => emit('open-record', { sheetId: 'sheet_orders', recordId: hoisted.navigateRecordId.value }),
      }, 'open-record')
    },
  }),
}))
vi.mock('../src/multitable/components/MetaTemplateCard.vue', () => ({ default: stubComponent('MetaTemplateCard') }))

vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({
        show: hoisted.toastShow,
        showError: hoisted.toastShowError,
        showSuccess: vi.fn(),
      })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createWorkbenchMock() {
  const activeBaseId = ref('base_ops')
  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'Grid', type: 'grid' },
    // A second GRID-typed view (not e.g. gallery) so switching to it still renders MetaGridTable —
    // these workbench stubs reuse the dashboard-exit spec's setup; this spec does not test the
    // per-view-type render chain.
    { id: 'view_grid_2', sheetId: 'sheet_orders', name: 'Grid 2', type: 'grid' },
    // 跨表用例的目标表的视图。
    { id: 'view_other', sheetId: 'sheet_other', name: 'Other grid', type: 'grid' },
  ])

  return {
    client: {
      listBases: vi.fn().mockResolvedValue({
        bases: [{ id: 'base_ops', name: 'Ops Base' }, { id: 'base_finance', name: 'Finance Base' }],
      }),
      updateView: vi.fn(),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      markCommentRead: vi.fn().mockResolvedValue(undefined),
      createSheet: vi.fn().mockResolvedValue({ sheet: { id: 'sheet_new', baseId: 'base_ops', name: 'New Sheet' } }),
      deleteSheet: vi.fn().mockResolvedValue(undefined),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView: vi.fn().mockResolvedValue({ view: { id: 'view_new', sheetId: 'sheet_orders', name: 'New View', type: 'grid' } }),
      // Actually removes the view, the same shape as the real server call, so the loadSheetMeta mock
      // below stays consistent with a real deleteView -> loadSheetMeta round trip (stub reused from the
      // dashboard-exit spec's setup).
      deleteView: vi.fn(async (viewId: string) => { views.value = views.value.filter((view) => view.id !== viewId) }),
      // onInstallTemplate/loadTemplateLibrary.
      listTemplates: vi.fn().mockResolvedValue({ templates: [{ id: 'tpl_1', name: 'Tpl', sheets: [], fields: [], views: [] }] }),
      installTemplate: vi.fn().mockResolvedValue({
        base: { id: 'base_tpl', name: 'Templated Base' },
        sheets: [{ id: 'sheet_tpl', baseId: 'base_tpl', name: 'Templated Sheet' }],
        views: [{ id: 'view_tpl', sheetId: 'sheet_tpl', name: 'Templated View', type: 'grid' }],
        template: { id: 'tpl_1', name: 'Tpl' },
      }),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
      renameSheet: vi.fn(),
      renameBase: vi.fn(),
    },
    sheets: ref([
      { id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null },
      { id: 'sheet_other', baseId: 'base_ops', name: 'Other', description: null },
    ]),
    fields: ref([
      { id: 'fld_title', name: 'Title', type: 'string' },
    ]),
    views,
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: false, canExport: true,
      // onDeleteSheet's own capability gate.
      canDeleteSheet: true,
    }),
    capabilityOrigin: ref(null),
    // 能力（/context）属于哪张表。切表后、新表的 /context 回来之前，它还是上一张表（工作台据此判断 capabilitiesStale）。
    capabilitiesSheetId: ref<string | null>('sheet_orders'),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    // The real useMultitableWorkbench.loadSheetMeta falls activeViewId back to views[0] once the
    // requested/active view is no longer in the reloaded list — reproduce that one fallback bit here
    // (nothing else this spec needs) so activeViewId ends up where a real loadSheetMeta reload would
    // leave it.
    loadSheetMeta: vi.fn(async () => {
      if (!views.value.some((view) => view.id === activeViewId.value)) {
        activeViewId.value = views.value[0]?.id ?? ''
      }
      return true
    }),
    switchBase: vi.fn(async (baseId: string) => { activeBaseId.value = baseId; return true }),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn((baseId: string) => { activeBaseId.value = baseId }),
    // 和真实的 useMultitableWorkbench.selectSheet 一样：换表并清空 activeViewId（视图等新表的 /context 回来再定）。
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId; activeViewId.value = '' }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
}

function createGridMock() {
  return {
    fields: ref([]),
    rows: ref([]),
    loading: ref(false),
    currentPage: ref(1),
    totalPages: ref(1),
    page: ref({ offset: 0, limit: 50, total: 0, hasMore: false }),
    visibleFields: ref([]),
    sortRules: ref([]),
    filterRules: ref([]),
    filterConjunction: ref('and'),
    filterGroups: ref([]),
    canLoadMore: ref(false),
    canUndo: ref(false),
    canRedo: ref(false),
    groupFieldId: ref<string | null>(null), groupFieldIds: ref([]),
    groupField: ref(null), groupFields: ref([]),
    hiddenFieldIds: ref<string[]>([]),
    columnWidths: ref<Record<string, number>>({}),
    linkSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    personSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    attachmentSummaries: ref<Record<string, Record<string, unknown[]>>>({}),
    fieldPermissions: ref({}),
    viewPermission: ref(null),
    rowActions: ref(null),
    rowActionOverrides: ref<Record<string, { canEdit: boolean; canDelete: boolean; canComment: boolean }>>({}),
    capabilityOrigin: ref(null),
    conflict: ref(null),
    error: ref<string | null>(null),
    sortFilterDirty: ref(false),
    toggleFieldVisibility: vi.fn(),
    addSortRule: vi.fn(),
    removeSortRule: vi.fn(),
    addFilterRule: vi.fn(),
    updateFilterRule: vi.fn(),
    removeFilterRule: vi.fn(),
    clearFilters: vi.fn(),
    applySortFilter: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    setGroupField: vi.fn(), setGroupFields: vi.fn(),
    goToPage: vi.fn(),
    patchCell: vi.fn(),
    createRecord: vi.fn(),
    deleteRecord: vi.fn(),
    resolveRowActions: vi.fn(() => null),
    loadViewData: vi.fn().mockResolvedValue(true),
    reloadCurrentPage: vi.fn(),
    dismissConflict: vi.fn(),
    retryConflict: vi.fn(),
    setColumnWidth: vi.fn(),
    setSearchQuery: vi.fn(),
  }
}


const PAGE_SIZE = 50

function makeRecords(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `rec_${from + i}`, version: 1, data: { fld_title: `Row ${from + i}` } }))
}

// 平铺视图、从第 1 行开始累计（offset 0）：每次 loadMore 追加一页。totalRows 为视图里一共有多少行。
function installPagedGrid(opts: { totalRows: number; offset?: number; canAppend?: boolean }) {
  const offset = opts.offset ?? 0
  const loaded = Math.min(PAGE_SIZE, Math.max(0, opts.totalRows - offset))
  gridMock.rows.value = makeRecords(offset, loaded)
  const hasMore = offset + loaded < opts.totalRows
  gridMock.page.value = { offset, limit: PAGE_SIZE, total: opts.totalRows, hasMore }
  gridMock.canLoadMore.value = (opts.canAppend ?? true) && offset === 0 && hasMore
  gridMock.loadingMore = ref(false)
  gridMock.accumulationCapped = ref(false)
  gridMock.loadMore = vi.fn(async () => {
    const start = gridMock.rows.value.length
    const next = makeRecords(start, Math.min(PAGE_SIZE, opts.totalRows - start))
    gridMock.rows.value = [...gridMock.rows.value, ...next]
    const more = gridMock.rows.value.length < opts.totalRows
    gridMock.page.value = { offset: 0, limit: PAGE_SIZE, total: opts.totalRows, hasMore: more }
    gridMock.canLoadMore.value = more
  })
}

function hintVariants(kind: 'capped' | 'absent' | 'unavailable', loadedRows: number): string[] {
  return [deepLinkLocateHint(kind, loadedRows, true), deepLinkLocateHint(kind, loadedRows, false)]
}

describe('MultitableWorkbench locate-in-grid after notification / deep link (customer issue 2026-10-27 4b)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    workbenchMock = createWorkbenchMock()
    gridMock = createGridMock()
    workbenchMock.client.getRecord = vi.fn(async (recordId: string) => ({
      record: { id: recordId, version: 1, data: { fld_title: 'Fetched' } },
    }))
    hoisted.navigateRecordId.value = 'rec_0'
    hoisted.navigateSheetId.value = 'sheet_orders'
    gridSetupHook = null
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    vi.clearAllMocks()
  })

  async function mountWorkbench(props: Record<string, unknown> = {}): Promise<HTMLDivElement> {
    app = createApp(defineComponent({
      setup() {
        return () => h(MultitableWorkbench as Component, props)
      },
    }))
    app.mount(container!)
    await flushUi()
    return container!
  }

  async function clickNotification(root: HTMLDivElement, recordId: string): Promise<void> {
    hoisted.navigateRecordId.value = recordId
    root.querySelector<HTMLButtonElement>('[data-testid="stub-notification-navigate"]')!.click()
    await flushUi(10)
  }

  it('scrolls the grid to a notification target that is already loaded, without fetching', async () => {
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()

    await clickNotification(root, 'rec_37')

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_37'))
    expect(gridMock.loadMore).not.toHaveBeenCalled()
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    expect(hoisted.toastShow).not.toHaveBeenCalled()
  })

  it('appends pages through the existing loadMore until the target row is loaded, then scrolls to it', async () => {
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()

    // 第 163 行：要再追加 3 页（50 → 200）。
    await clickNotification(root, 'rec_162')

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_162'))
    expect(gridMock.loadMore).toHaveBeenCalledTimes(3)
    expect(gridMock.rows.value).toHaveLength(200)
    // 找到了就走「已加载」分支，不再单独取这条记录。
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    expect(hoisted.toastShow).not.toHaveBeenCalled()
  })

  it('stops after 10 extra pages, opens the record via getRecord and shows a light hint', async () => {
    installPagedGrid({ totalRows: 5000 })
    const root = await mountWorkbench()

    await clickNotification(root, 'rec_4000')

    await vi.waitFor(() => expect(hoisted.toastShow).toHaveBeenCalled())
    expect(gridMock.loadMore).toHaveBeenCalledTimes(10)
    expect(gridMock.rows.value).toHaveLength(550)
    expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_4000', expect.anything())
    const [message, type] = hoisted.toastShow.mock.calls[0]
    expect(hintVariants('capped', 550)).toContain(message)
    expect(type).toBe('info')
    expect(hoisted.scrollToRecord).not.toHaveBeenCalled()
    expect(hoisted.toastShowError).not.toHaveBeenCalled()
  })

  it('tells the user the record is not in this view once every row is loaded and it is still missing', async () => {
    installPagedGrid({ totalRows: 120 })
    const root = await mountWorkbench()

    await clickNotification(root, 'rec_filtered_out')

    await vi.waitFor(() => expect(hoisted.toastShow).toHaveBeenCalled())
    // 120 行：再追加 2 页就到底了，不会用满上限。
    expect(gridMock.loadMore).toHaveBeenCalledTimes(2)
    expect(workbenchMock.client.getRecord).toHaveBeenCalled()
    expect(hintVariants('absent', 120)).toContain(hoisted.toastShow.mock.calls[0][0])
  })

  it('does not append in paged mode (past page 1) and hints the record is not on the current page', async () => {
    installPagedGrid({ totalRows: 618, offset: 100 })
    const root = await mountWorkbench()

    await clickNotification(root, 'rec_3')

    await vi.waitFor(() => expect(hoisted.toastShow).toHaveBeenCalled())
    expect(gridMock.loadMore).not.toHaveBeenCalled()
    expect(workbenchMock.client.getRecord).toHaveBeenCalled()
    expect(hintVariants('unavailable', 50)).toContain(hoisted.toastShow.mock.calls[0][0])
  })

  it('locates a URL #recordId deep link on mount through the same path', async () => {
    installPagedGrid({ totalRows: 618 })
    window.history.replaceState(null, '', `${window.location.pathname}#recordId=rec_120`)

    await mountWorkbench()

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_120'))
    expect(gridMock.loadMore).toHaveBeenCalledTimes(2)
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
  })

  it('waits for an in-flight grid load before looking for the row', async () => {
    installPagedGrid({ totalRows: 618 })
    // 模拟刚切表：行数据还在路上。
    const loadedRows = gridMock.rows.value
    gridMock.rows.value = []
    gridMock.loading.value = true
    const root = await mountWorkbench()

    hoisted.navigateRecordId.value = 'rec_10'
    root.querySelector<HTMLButtonElement>('[data-testid="stub-notification-navigate"]')!.click()
    await flushUi(5)
    expect(hoisted.scrollToRecord).not.toHaveBeenCalled()

    gridMock.rows.value = loadedRows
    gridMock.loading.value = false

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_10'))
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
  })

  // 钉住跨表点通知时的等待时机。selectSheet 清空 activeViewId，表格先不带视图取一次行；新表的 /context 回来以后才设好
  // 视图，表格再按视图重新取行。定位必须等到按视图取的行回来，不能用不带视图的那批行。
  // 判别力：不带视图的那批行里有目标记录（第 1 页就能「找到」），按视图的行里它在第 163 行。
  //   - isGridBusy 不看 capabilitiesStale：不带视图的那批行一回来就放行，按那批行滚动 → 第一个「未调用」断言变红；
  //   - 等待用 pre 监听：/context 回来那一轮先于表格的重载监听判断「不忙」，同样按旧行滚动 → 第二个「未调用」断言变红。
  // 表格的重载监听由 gridSetupHook 建在组件 setup 内（和真实的 useMultitableGrid 一样是组件内的 pre 任务）。
  it('cross-sheet notification: waits for the new sheet\'s /context and the view-scoped reload, not the view-less first fetch', async () => {
    gridSetupHook = (opts) => {
      watch([opts.sheetId, opts.viewId], () => {
        if (opts.sheetId.value) gridMock.loading.value = true
      })
    }
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()

    hoisted.navigateSheetId.value = 'sheet_other'
    hoisted.navigateRecordId.value = 'rec_162'
    root.querySelector<HTMLButtonElement>('[data-testid="stub-notification-navigate"]')!.click()
    await flushUi(10)
    expect(workbenchMock.selectSheet).toHaveBeenCalledWith('sheet_other')
    expect(workbenchMock.activeViewId.value).toBe('')
    expect(gridMock.loading.value).toBe(true)

    // 1) 不带视图的那次取行先回来（行序和视图的不同：目标记录就在这批里）。
    gridMock.rows.value = makeRecords(150, PAGE_SIZE)
    gridMock.page.value = { offset: 0, limit: PAGE_SIZE, total: 618, hasMore: true }
    gridMock.canLoadMore.value = true
    gridMock.loading.value = false
    await flushUi(10)
    expect(hoisted.scrollToRecord).not.toHaveBeenCalled()

    // 2) 新表的 /context 回来：能力归属和视图在同一轮里设好，表格的监听随即开始按视图重新取行。
    workbenchMock.capabilitiesSheetId.value = 'sheet_other'
    workbenchMock.activeViewId.value = 'view_other'
    await flushUi(10)
    expect(gridMock.loading.value).toBe(true)
    expect(hoisted.scrollToRecord).not.toHaveBeenCalled()

    // 3) 按视图取的第 1 页回来：目标记录要再追加 3 页才到。
    installPagedGrid({ totalRows: 618 })
    gridMock.loading.value = false

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_162'))
    expect(hoisted.scrollToRecord).toHaveBeenCalledTimes(1)
    expect(gridMock.loadMore).toHaveBeenCalledTimes(3)
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    expect(hoisted.toastShow).not.toHaveBeenCalled()
  })

  it('cross-sheet notification: a failed /context does not hold the locate until the timeout', async () => {
    gridSetupHook = (opts) => {
      watch([opts.sheetId, opts.viewId], () => {
        if (opts.sheetId.value) gridMock.loading.value = true
      })
    }
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()

    hoisted.navigateSheetId.value = 'sheet_other'
    hoisted.navigateRecordId.value = 'rec_20'
    root.querySelector<HTMLButtonElement>('[data-testid="stub-notification-navigate"]')!.click()
    await flushUi(10)

    // /context 失败：能力仍属于上一张表（capabilitiesStale 一直为真），workbench.error 有值。
    workbenchMock.error.value = 'Failed to load sheet metadata'
    installPagedGrid({ totalRows: 618 })
    gridMock.loading.value = false

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_20'), { timeout: 2000 })
    expect(gridMock.loadMore).not.toHaveBeenCalled()
  })

  // 钉住历史中心的 open-record 也走同一条定位路径（去掉 onHistoryOpenRecord 里的 locate: true 这条会变红）。
  it('locates a History Center open-record through the same path', async () => {
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()

    hoisted.navigateRecordId.value = 'rec_162'
    root.querySelector<HTMLButtonElement>('[data-testid="stub-history-open-record"]')!.click()

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_162'))
    expect(gridMock.loadMore).toHaveBeenCalledTimes(3)
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
  })

  // 钉住评论深链（props.recordId + commentId）在挂载时定位，并标记评论已读。
  it('locates a comment deep link (props.recordId + commentId) on mount', async () => {
    installPagedGrid({ totalRows: 618 })

    await mountWorkbench({ recordId: 'rec_120', commentId: 'cmt_1' })

    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_120'))
    expect(gridMock.loadMore).toHaveBeenCalledTimes(2)
    expect(workbenchMock.client.getRecord).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(workbenchMock.client.markCommentRead).toHaveBeenCalledWith('cmt_1'))
  })

  // 钉住只刷新已选记录的调用方（这里是冲突重载）不传 locate：不追加、不滚动、不出提示。
  it('a refresh-only caller (conflict reload) re-resolves the selected record without appending or scrolling', async () => {
    installPagedGrid({ totalRows: 618 })
    const root = await mountWorkbench()
    await clickNotification(root, 'rec_162')
    await vi.waitFor(() => expect(hoisted.scrollToRecord).toHaveBeenCalledWith('rec_162'))

    // 冲突重载把表格刷回第一页：rec_162 不在已加载的行里了。
    gridMock.reloadCurrentPage = vi.fn(async () => { installPagedGrid({ totalRows: 618 }) })
    hoisted.scrollToRecord.mockClear()
    hoisted.toastShow.mockClear()
    gridMock.conflict.value = { recordId: 'rec_162', fieldId: 'fld_title', attemptedValue: 'x', message: 'Row changed elsewhere', serverVersion: 2 }
    await flushUi()
    root.querySelector<HTMLButtonElement>('.mt-workbench__conflict-btn')!.click()

    await vi.waitFor(() => expect(workbenchMock.client.getRecord).toHaveBeenCalledWith('rec_162', expect.anything()))
    await flushUi(10)
    expect(gridMock.reloadCurrentPage).toHaveBeenCalledTimes(1)
    expect(gridMock.loadMore).not.toHaveBeenCalled()
    expect(hoisted.scrollToRecord).not.toHaveBeenCalled()
    expect(hoisted.toastShow).not.toHaveBeenCalled()
  })
})
