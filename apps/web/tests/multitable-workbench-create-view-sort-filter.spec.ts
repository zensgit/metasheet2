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
 *
 * #6075 review round 2 adds the other real workbench entry points of the same leak class (second describe):
 *  - a 视图管理 config save and a 配置历史 revert of the CURRENT view discard the toolbar's staged, unapplied
 *    sort/filter edits instead of PATCHing them over what the dialog / revert just wrote;
 *  - in personal mode, a column drag while the view's load is in flight writes no personal column order.
 * The MetaGridTable stub renders the sortRules the workbench hands it (data-sort-rules), so every staged edit is
 * asserted to have really happened before the step that must not persist it.
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
// MetaGridTable stub that renders the sortRules the workbench hands it and can emit reorder-field.
const gridTableProbe = vi.hoisted(() => ({ emitReorder: null as null | ((fromId: string, toId: string) => void) }))
vi.mock('../src/multitable/components/MetaGridTable.vue', () => ({
  default: defineComponent({
    name: 'MetaGridTable',
    props: { sortRules: { type: Array, default: () => [] } },
    emits: ['reorder-field'],
    setup(props, { emit }) {
      gridTableProbe.emitReorder = (fromId: string, toId: string) => emit('reorder-field', fromId, toId)
      return () => h('div', { 'data-stub-MetaGridTable': 'true', 'data-sort-rules': JSON.stringify(props.sortRules) })
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

// A second grid view with its own hidden column — only present in the personal-mode setup.
function otherView(): StoredView {
  return {
    id: 'view_other', sheetId: 'sheet_orders', name: 'Ops view', type: 'grid',
    sortInfo: {}, filterInfo: {}, groupInfo: {}, hiddenFieldIds: ['fld_key'],
  }
}

function setup(opts: { personal?: boolean } = {}) {
  // In-memory view store behind the grid's client (POST /views stores `{}` facets for a blank create).
  const store: Record<string, StoredView> = opts.personal
    ? { view_grid: allRecords(), view_other: otherView() }
    : { view_grid: allRecords() }
  // A view id here makes its loads WAIT until release() — a slow network.
  let held: { viewId: string; gate: Promise<void> } | null = null
  const holdLoadsFor = (viewId: string) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    held = { viewId, gate }
    return () => { held = null; release() }
  }
  const loadView = vi.spyOn(multitableClient, 'loadView').mockImplementation(async (params) => {
    const vid = params.viewId ?? ''
    if (held && held.viewId === vid) await held.gate
    const view = store[vid]
    return {
      fields: FIELDS,
      rows: [],
      view: view ? JSON.parse(JSON.stringify(view)) : undefined,
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    } as never
  })
  // Mimics PATCH /views/:id: JSON drops `undefined`, and a key absent from the body KEEPS the stored value.
  const applyPatch = (viewId: string, input: unknown) => {
    const body = JSON.parse(JSON.stringify(input ?? {})) as Partial<StoredView>
    const current = store[viewId]
    if (current) {
      if (body.sortInfo !== undefined) current.sortInfo = body.sortInfo
      if (body.filterInfo !== undefined) current.filterInfo = body.filterInfo
      if (body.groupInfo !== undefined) current.groupInfo = body.groupInfo
      if (body.hiddenFieldIds !== undefined) current.hiddenFieldIds = body.hiddenFieldIds
    }
  }
  // The GRID's writes (toolbar / header click / hidden columns) go through the shared multitableClient…
  const updateView = vi.spyOn(multitableClient, 'updateView').mockImplementation(async (viewId, input) => {
    applyPatch(viewId, input)
    return {} as never
  })
  // …the workbench's own writes (视图管理 save, display prefs) through workbench.client — same server.
  const workbenchUpdateView = vi.fn(async (viewId: string, input: unknown) => {
    applyPatch(viewId, input)
    return {}
  })

  const activeSheetId = ref('sheet_orders')
  const activeViewId = ref('view_grid')
  // The view list carries each view's stored facets (what /meta returns), so 视图管理 hydrates its drafts from them.
  const listEntry = (view: StoredView) => JSON.parse(JSON.stringify(view)) as StoredView
  const views = ref<StoredView[]>(Object.values(store).map(listEntry))
  const createView = vi.fn(async (input: { sheetId: string; name: string; type: string }) => {
    const created: StoredView = {
      id: 'view_created', sheetId: input.sheetId, name: input.name, type: input.type,
      sortInfo: {}, filterInfo: {}, groupInfo: {}, hiddenFieldIds: [],
    }
    store[created.id] = created
    views.value = [...views.value, listEntry(created)]
    return { view: { ...created } }
  })
  // 配置历史: one revision of All Records' sort; executing its revert restores `{ rules: [Owner ▼] }`.
  const revertedSort = { rules: [{ fieldId: 'fld_owner', desc: true }] }
  const getConfigHistory = vi.fn(async () => [{
    id: 'rev_sort', entityType: 'view', entityId: 'view_grid', action: 'update',
    before: { sortInfo: revertedSort }, after: { sortInfo: allRecords().sortInfo },
    changedKeys: ['sortInfo'], batchId: null, actorId: 'u1', createdAt: '2026-09-24T00:00:00Z',
  }])
  const getConfigRestorePreview = vi.fn(async () => ({
    revisionId: 'rev_sort', entityType: 'view', entityId: 'view_grid', changedKeys: ['sortInfo'],
    current: { sortInfo: allRecords().sortInfo }, target: { sortInfo: revertedSort },
    driftConflict: false, opKind: 'safe', baselineHash: 'h1', previewToken: 'tok_sort',
  }))
  const executeConfigRestore = vi.fn(async () => {
    store.view_grid.sortInfo = JSON.parse(JSON.stringify(revertedSort))
    return {}
  })
  // Personal column order (only reached in the personal-mode setup).
  const getPersonalViewConfig = vi.fn(async () => ({ viewId: 'view_other', config: null, updatedAt: null }))
  const putPersonalViewConfig = vi.fn(async () => ({ viewId: 'view_other', config: {}, updatedAt: null }))
  workbenchMock = {
    client: {
      listBases: vi.fn().mockResolvedValue({ bases: [{ id: 'base_ops', name: 'Ops Base' }] }),
      updateView: workbenchUpdateView,
      getConfigHistory,
      getConfigRestorePreview,
      executeConfigRestore,
      getPersonalViewConfig,
      putPersonalViewConfig,
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
      ...(opts.personal ? { personalViewsEnabled: true } : {}),
    }),
    // Personal-mode setup: the actor already has a personal row for view_other ⇒ its toggle is ON.
    ...(opts.personal ? { personalOverrideViewIds: ref(['view_other']) } : {}),
    capabilityOrigin: ref(null),
    fieldPermissions: ref({}),
    viewPermissions: ref({}),
    activeView: computed(() => views.value.find((view) => view.id === activeViewId.value) ?? null),
    loading: ref(false),
    error: ref<string | null>(null),
    loadSheets: vi.fn().mockResolvedValue(true),
    loadBaseContext: vi.fn().mockResolvedValue(true),
    // Like the real /meta reload: the view list re-reads each view's stored facets.
    loadSheetMeta: vi.fn(async () => {
      views.value = views.value.map((view) => (store[view.id] ? listEntry(store[view.id]) : view))
      return true
    }),
    switchBase: vi.fn().mockResolvedValue(true),
    syncExternalContext: vi.fn().mockResolvedValue(true),
    selectBase: vi.fn(),
    selectSheet: vi.fn((sheetId: string) => { activeSheetId.value = sheetId }),
    selectView: vi.fn((viewId: string) => { activeViewId.value = viewId }),
  }
  return {
    store, loadView, updateView, workbenchUpdateView, createView, activeViewId, holdLoadsFor, revertedSort,
    getConfigHistory, getConfigRestorePreview, executeConfigRestore, getPersonalViewConfig, putPersonalViewConfig,
  }
}

// What the workbench currently hands the (stubbed) grid table as sortRules.
const gridSortRules = (root: HTMLElement) =>
  JSON.parse((root.querySelector('[data-stub-MetaGridTable]') as HTMLElement).getAttribute('data-sort-rules') ?? 'null')
// Remove every rule from the toolbar's sort panel — staged, NOT applied (MetaToolbar remove-sort → grid.removeSortRule).
async function stageRemoveAllSorts(root: HTMLElement) {
  sortTrigger(root).click()
  await flushUi()
  for (let guard = 0; guard < 10; guard += 1) {
    const remove = document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__sort-rule .meta-toolbar__remove') as HTMLButtonElement | null
    if (!remove) break
    remove.click()
    await flushUi()
  }
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
    // Precondition (#6075 round 2 nit 4): the staged edit really reached the grid state — 唯一键 is now ascending —
    // so the "nothing was written" assertions below cannot pass vacuously on an edit that never happened.
    expect(gridSortRules(container!)).toEqual([
      { fieldId: 'fld_title', direction: 'asc' },
      { fieldId: 'fld_key', direction: 'asc' },
      { fieldId: 'fld_owner', direction: 'asc' },
    ])
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

describe('MultitableWorkbench #6075 round 2: a 视图管理 save / 配置历史 revert wins over the toolbar\'s unapplied edits', () => {
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

  async function mountWorkbench(opts: { personal?: boolean } = {}) {
    const env = setup(opts)
    app = createApp(defineComponent({ setup: () => () => h(MultitableWorkbench as Component) }))
    app.mount(container!)
    await flushUi()
    return env
  }

  it('视图管理 → 配置 → 保存 of the current view: the staged "remove every sort rule" is discarded, not PATCHed over the saved sort', async () => {
    const env = await mountWorkbench()
    expect(badgeOf(sortTrigger(container!))).toBe('3')

    // Staged, NOT applied: remove all 3 rules in the toolbar (the next load would send an explicit `{ rules: [] }`).
    await stageRemoveAllSorts(container!)
    expect(gridSortRules(container!)).toEqual([])
    expect(env.updateView).not.toHaveBeenCalled()

    // 视图管理 → ⚙ All Records → drop the dialog's FIRST sort rule → 保存视图设置.
    ;(Array.from(container!.querySelectorAll('.mt-workbench__mgr-btn')) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes('Views'))!.click()
    await flushUi()
    ;(document.querySelector('.meta-view-mgr__action[title="Configure"]') as HTMLButtonElement).click()
    await flushUi()
    const sortSection = (document.querySelector('[data-sort-add="true"]') as HTMLElement).closest('.meta-view-mgr__field') as HTMLElement
    const dialogRules = sortSection.querySelectorAll('.meta-view-mgr__rule-row')
    // The dialog hydrated All Records' stored 3 rules (not the toolbar's staged edit).
    expect(dialogRules.length).toBe(3)
    ;(dialogRules[0].querySelector('.meta-view-mgr__action--danger') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('.meta-view-mgr__config-actions .meta-view-mgr__btn-add') as HTMLButtonElement).click()
    await flushUi()

    const savedSort = { rules: [{ fieldId: 'fld_key', desc: true }, { fieldId: 'fld_owner', desc: false }] }
    // The dialog's save went out…
    expect(env.workbenchUpdateView).toHaveBeenCalledTimes(1)
    expect(env.workbenchUpdateView.mock.calls[0][0]).toBe('view_grid')
    expect((env.workbenchUpdateView.mock.calls[0][1] as { sortInfo?: unknown }).sortInfo).toEqual(savedSort)
    // …the grid wrote NOTHING after it (no `{ rules: [] }` wiping the saved sort)…
    expect(env.updateView).not.toHaveBeenCalled()
    expect(env.store.view_grid.sortInfo).toEqual(savedSort)
    // …and the toolbar re-synced from the saved view.
    expect(badgeOf(sortTrigger(container!))).toBe('2')
    expect(gridSortRules(container!)).toEqual([
      { fieldId: 'fld_key', direction: 'desc' },
      { fieldId: 'fld_owner', direction: 'asc' },
    ])
    expect(showErrorSpy).not.toHaveBeenCalled()
  })

  it('配置历史 → 撤销 (revert) restoring the current view\'s sort: the staged toolbar edit is discarded, not PATCHed over it', async () => {
    const env = await mountWorkbench()
    await stageRemoveAllSorts(container!)
    expect(gridSortRules(container!)).toEqual([])
    expect(env.updateView).not.toHaveBeenCalled()

    ;(container!.querySelector('[data-action="open-config-history"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-test="config-history-revert"]') as HTMLButtonElement).click()
    await flushUi()
    ;(document.querySelector('[data-test="config-restore-confirm-btn"]') as HTMLButtonElement).click()
    await flushUi(12)

    expect(env.executeConfigRestore).toHaveBeenCalledTimes(1)
    expect(env.updateView).not.toHaveBeenCalled()
    expect(env.store.view_grid.sortInfo).toEqual(env.revertedSort)
    expect(badgeOf(sortTrigger(container!))).toBe('1')
    expect(gridSortRules(container!)).toEqual([{ fieldId: 'fld_owner', direction: 'desc' }])
  })

  it('personal mode: a column drag while the view\'s load is IN FLIGHT writes no personal column order; once loaded it does', async () => {
    const env = await mountWorkbench({ personal: true })
    const release = env.holdLoadsFor('view_other')
    env.activeViewId.value = 'view_other'
    await flushUi()

    // view_other's hidden list / order are not known yet: an order built from them must not be written.
    gridTableProbe.emitReorder!('fld_owner', 'fld_title')
    await flushUi()
    expect(env.getPersonalViewConfig).not.toHaveBeenCalled()
    expect(env.putPersonalViewConfig).not.toHaveBeenCalled()

    release()
    await flushUi()
    // Loaded (view_other hides 唯一键): the same drag now writes view_other's personal order — so the drop above was
    // the load gate, not personal mode being off.
    gridTableProbe.emitReorder!('fld_owner', 'fld_title')
    await flushUi()
    expect(env.putPersonalViewConfig).toHaveBeenCalledTimes(1)
    expect(env.putPersonalViewConfig).toHaveBeenCalledWith('view_other', { fieldOrder: ['fld_owner', 'fld_title'] })
  })
})
