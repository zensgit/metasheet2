/**
 * 客户反馈 2026-09-24 #5 (裁定见 PR #6074 §2 「5 新视图与 All Records 不一致」) — the REAL create-view entry point.
 *
 * The customer created the new view from 视图管理 → 新建视图. MultitableWorkbench.vue onCreateView does
 * `workbench.selectView(res.view.id)` and then, in the SAME tick, `await grid.loadViewData(...)`. That explicit
 * load runs BEFORE useMultitableGrid's (pre-flush) view-switch watcher resets the toolbar state, so if the
 * user had STAGED a sort/filter edit in the previous view without clicking 应用 (sortFilterDirty = true), the
 * load's "persist dirty sort/filter first" step used to PATCH the previous view's rules into the brand-new view
 * — the exact 排序 3 / ▼ 唯一键 symptom, now stored in the DB.
 *
 * Unlike multitable-view-switch-sort-filter.spec.ts (which drives the composable directly), this spec mounts
 * the real MultitableWorkbench with the REAL useMultitableGrid, the REAL MetaToolbar and the REAL MetaViewManager,
 * and creates the view by typing a name into the add-view row and clicking 添加. Only the workbench data
 * composable, the realtime/comment plumbing and unrelated child views are stubbed; the grid's HTTP client
 * (the shared `multitableClient`) is backed by an in-memory view store that mimics PATCH /views/:id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn().mockResolvedValue(undefined) }),
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

vi.mock('../src/multitable/composables/useMultitableWorkbench', () => ({
  useMultitableWorkbench: () => workbenchMock,
}))

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

vi.mock('../src/multitable/composables/useMultitableSheetRealtime', () => ({
  useMultitableSheetRealtime: vi.fn(),
}))

vi.mock('../src/multitable/import/bulk-import', () => ({
  bulkImportRecords: vi.fn(),
}))

// NOT mocked on purpose: useMultitableGrid, MetaToolbar.vue, MetaViewManager.vue.
vi.mock('../src/multitable/components/MetaSheetViewRail.vue', () => ({ default: stubComponent('MetaSheetViewRail') }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({ default: stubComponent('MetaGridTable') }))
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

const showErrorSpy = vi.fn()
vi.mock('../src/multitable/components/MetaToast.vue', () => ({
  default: defineComponent({
    name: 'MetaToast',
    setup(_, { expose }) {
      expose({ showError: showErrorSpy, showSuccess: vi.fn() })
      return () => h('div', { 'data-toast': 'true' })
    },
  }),
}))

import MultitableWorkbench from '../src/multitable/views/MultitableWorkbench.vue'
import { multitableClient } from '../src/multitable/api/client'

type StoredView = {
  id: string
  sheetId: string
  name: string
  type: string
  sortInfo: Record<string, unknown>
  filterInfo: Record<string, unknown>
  groupInfo: Record<string, unknown>
  hiddenFieldIds: string[]
}

const FIELDS = [
  { id: 'fld_title', name: 'Title', type: 'string' },
  { id: 'fld_key', name: '唯一键', type: 'string' },
  { id: 'fld_owner', name: 'Owner', type: 'string' },
]

// The customer's All Records: 3 sort rules (▼ on 唯一键) + 1 filter condition.
function allRecords(): StoredView {
  return {
    id: 'view_grid',
    sheetId: 'sheet_orders',
    name: 'All Records',
    type: 'grid',
    sortInfo: { rules: [
      { fieldId: 'fld_title', desc: false },
      { fieldId: 'fld_key', desc: true },
      { fieldId: 'fld_owner', desc: false },
    ] },
    filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_owner', operator: 'contains', value: 'ops' }] },
    groupInfo: {},
    hiddenFieldIds: [],
  }
}

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function setup() {
  // In-memory view store behind the grid's client (POST /views stores `{}` facets for a blank create).
  const store: Record<string, StoredView> = { view_grid: allRecords() }
  const loadView = vi.spyOn(multitableClient, 'loadView').mockImplementation(async (params) => {
    const view = store[params.viewId ?? '']
    return {
      fields: FIELDS,
      rows: [],
      view: view ? JSON.parse(JSON.stringify(view)) : undefined,
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    } as never
  })
  // Mimics PATCH /views/:id: JSON drops `undefined`, and a key absent from the body KEEPS the stored value.
  const updateView = vi.spyOn(multitableClient, 'updateView').mockImplementation(async (viewId, input) => {
    const body = JSON.parse(JSON.stringify(input ?? {})) as Partial<StoredView>
    const current = store[viewId]
    if (current) {
      if (body.sortInfo !== undefined) current.sortInfo = body.sortInfo
      if (body.filterInfo !== undefined) current.filterInfo = body.filterInfo
    }
    return {} as never
  })

  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  const views = ref<Array<{ id: string; sheetId: string; name: string; type: string }>>([
    { id: 'view_grid', sheetId: 'sheet_orders', name: 'All Records', type: 'grid' },
  ])
  const createView = vi.fn(async (input: { sheetId: string; name: string; type: string }) => {
    const created: StoredView = {
      id: 'view_created', sheetId: input.sheetId, name: input.name, type: input.type,
      sortInfo: {}, filterInfo: {}, groupInfo: {}, hiddenFieldIds: [],
    }
    store[created.id] = created
    views.value = [...views.value, { id: created.id, sheetId: created.sheetId, name: created.name, type: created.type }]
    return { view: { ...created } }
  })
  workbenchMock = {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      updateView: vi.fn().mockResolvedValue({}),
      loadFormContext: vi.fn(),
      getRecord: vi.fn(),
      createSheet: vi.fn(),
      createBase: vi.fn(),
      createField: vi.fn(),
      preparePersonField: vi.fn(),
      updateField: vi.fn(),
      deleteField: vi.fn(),
      createView,
      deleteView: vi.fn(),
      patchRecords: vi.fn(),
      submitForm: vi.fn(),
    },
    sheets: ref([{ id: 'sheet_orders', baseId: 'base_ops', name: 'Orders', description: null }]),
    fields: ref(FIELDS),
    views,
    activeBaseId: ref('base_ops'),
    activeSheetId,
    activeViewId,
    capabilities: ref({
      canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
      canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: false, canExport: true,
    }),
    capabilityOrigin: ref(null),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    loadSheetMeta: vi.fn().mockResolvedValue(true),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn(),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
  return { store, loadView, updateView, createView, activeViewId }
}

const sortTrigger = (root: HTMLElement) => root.querySelector('.meta-toolbar button[title="Sort"]') as HTMLButtonElement
const filterTrigger = (root: HTMLElement) => root.querySelector('.meta-toolbar button[title="Filter"]') as HTMLButtonElement
const badgeOf = (btn: HTMLElement | null) => btn?.querySelector('.meta-toolbar__badge')?.textContent?.trim() ?? null

describe('MultitableWorkbench 视图管理 → 新建视图: the previous view\'s sort/filter never reaches the new view', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    document.body.innerHTML = ''
    showErrorSpy.mockReset()
    vi.restoreAllMocks()
  })

  it('a STAGED (unapplied) sort edit in All Records is not PATCHed into the view created next', async () => {
    const env = setup()
    app = createApp(defineComponent({ setup: () => () => h(MultitableWorkbench as Component) }))
    app.mount(container!)
    await flushUi()

    // Sanity: All Records shows its 3 sorts + 1 filter through the real grid + real toolbar.
    expect(badgeOf(sortTrigger(container!))).toBe('3')
    expect(badgeOf(filterTrigger(container!))).toBe('1')

    // Stage an edit WITHOUT 应用: flip the 唯一键 rule to ascending in the sort panel (workbench onUpdateSort).
    sortTrigger(container!).click()
    await flushUi()
    const dirSelect = document.querySelectorAll('.meta-toolbar__sort-panel .meta-toolbar__sort-rule')[1]
      .querySelectorAll('select')[1] as HTMLSelectElement
    dirSelect.value = 'asc'
    dirSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(env.updateView).not.toHaveBeenCalled()

    // 视图管理 → type a name in the add-view row → 添加 (MetaViewManager emits create-view → onCreateView).
    ;(Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Views'))!.click()
    await flushUi()
    const nameInput = document.querySelector('.meta-view-mgr__add-row .meta-view-mgr__input') as HTMLInputElement
    expect(nameInput).not.toBeNull()
    nameInput.value = '新视图'
    nameInput.dispatchEvent(new Event('input'))
    await flushUi()
    ;(document.querySelector('.meta-view-mgr__add-row .meta-view-mgr__btn-add') as HTMLButtonElement).click()
    await flushUi()

    expect(env.createView).toHaveBeenCalledTimes(1)
    expect(env.activeViewId.value).toBe('view_created')
    // The new view was never written to — it is still exactly the blank view POST /views created…
    expect(env.updateView.mock.calls.filter(([viewId]) => viewId === 'view_created')).toEqual([])
    expect(env.store.view_created.sortInfo).toEqual({})
    expect(env.store.view_created.filterInfo).toEqual({})
    // …All Records did not receive the discarded staged edit either…
    expect(env.updateView).not.toHaveBeenCalled()
    expect(env.store.view_grid).toEqual(allRecords())
    // …and the new view shows blank: no 排序 / 筛选 badge.
    expect(badgeOf(sortTrigger(container!))).toBeNull()
    expect(badgeOf(filterTrigger(container!))).toBeNull()
    expect(showErrorSpy).not.toHaveBeenCalled()
  })
})
