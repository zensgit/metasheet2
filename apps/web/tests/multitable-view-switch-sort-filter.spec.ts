/**
 * 客户反馈 2026-09-24 #5 (裁定见 PR #6074 §2 「5 新视图与 All Records 不一致」).
 *
 * A newly created (blank) view showed a different row order than All Records, while its toolbar said 排序 3
 * and the 唯一键 header carried a ▼. Root cause: `syncFromView` only overwrote the sort/filter state when the
 * incoming view HAD rules, and the view-switch watcher only cleared the dirty flag — so the previous view's
 * rules stayed in the new view's toolbar/header state, and the next header click / 应用 / 清除筛选 PERSISTED
 * them into the new view (persistSortFilter always sends sortInfo together with filterInfo). Separately,
 * clearing the LAST rule was never saved: the empty list serialised to `undefined`, which the PATCH drops.
 *
 * Review round 1 of #6075 added three fail-closed properties, all covered below:
 *  - sort/filter state is persisted ONLY into the view it was loaded from. The create-view path switches the
 *    view and calls loadViewData in the same tick, BEFORE the (pre-flush) view-switch watcher resets — a
 *    staged, unapplied toolbar edit of the previous view must not be written into the new view.
 *  - "not loaded yet" is not "empty": while the new view's load is in flight or has failed, a header click /
 *    应用 must not write anything (an explicit empty would wipe the view's stored filter and sort).
 *  - only the facet the user changed is sent; a sort edit never rewrites the stored filter and vice versa.
 *
 * Review round 2 added (describe block at the end, PATCHes parked with `heldUpdateViews`):
 *  - in-flight writes: the baseline moves to what was SENT before the await, so a 应用 pressed meanwhile diffs
 *    against the pending write (a re-add of the rule being removed is sent, last write wins); writes to one view
 *    are serialised; a reload never reads a view while a write to it is in flight; a failed write is rolled back
 *    compare-and-set, and neither a late success nor a late failure for A touches B's state.
 *  - a 视图管理 save / config revert discards the toolbar's unapplied edits (discardUnappliedSortFilterEdits).
 *  - hidden columns / grouping / column order get the same "only into the view they were loaded from" gate, and a
 *    view switch resets them (the new view shows all columns until — and unless — its own load lands).
 *
 * This spec drives the REAL composable (useMultitableGrid) + the REAL MetaToolbar / MetaGridTable against a
 * MultitableApiClient whose loadView/updateView are backed by an in-memory view store that mimics the
 * server's PATCH merge (a key that is absent from the body keeps the stored value). The real workbench
 * create-view entry point is covered in multitable-workbench-create-view-sort-filter.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import MetaToolbar from '../src/multitable/components/MetaToolbar.vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import MetaViewManager from '../src/multitable/components/MetaViewManager.vue'
import { useMultitableGrid, type SortRule } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useLocale } from '../src/composables/useLocale'
import type { MetaField } from '../src/multitable/types'

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

const FIELDS: MetaField[] = [
  { id: 'fld_key', name: '唯一键', type: 'string' },
  { id: 'fld_proj', name: '项目号', type: 'string' },
  { id: 'fld_qty', name: '数量', type: 'number' },
]

// View A = the customer's All Records: 3 sort rules (one of them ▼ on 唯一键) + 1 filter condition.
function viewA(): StoredView {
  return {
    id: 'view_all',
    sheetId: 'sheet_1',
    name: 'All Records',
    type: 'grid',
    sortInfo: { rules: [
      { fieldId: 'fld_proj', desc: false },
      { fieldId: 'fld_key', desc: true },
      { fieldId: 'fld_qty', desc: false },
    ] },
    filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_proj', operator: 'contains', value: '2025' }] },
    groupInfo: {},
    hiddenFieldIds: [],
  }
}

// View B = a freshly created view — exactly what POST /views stores for a blank create (`{}` facets).
function viewB(): StoredView {
  return { id: 'view_new', sheetId: 'sheet_1', name: '新视图', type: 'grid', sortInfo: {}, filterInfo: {}, groupInfo: {}, hiddenFieldIds: [] }
}

// View S = an existing view with its OWN saved sort (数量 ▼) and filter (唯一键 not empty) — the one whose
// stored rules a write made before its state is known would wipe.
function viewSaved(): StoredView {
  return {
    id: 'view_saved',
    sheetId: 'sheet_1',
    name: '已保存视图',
    type: 'grid',
    sortInfo: { rules: [{ fieldId: 'fld_qty', desc: true }] },
    filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_key', operator: 'isNotEmpty' }] },
    groupInfo: {},
    hiddenFieldIds: [],
  }
}

// Two views with their OWN hidden columns and grouping (#6075 round 2) — the whole-list facets a write made while
// the incoming view is not loaded yet would replace.
function viewColsA(): StoredView {
  return {
    id: 'view_cols_a', sheetId: 'sheet_1', name: '列视图 A', type: 'grid', sortInfo: {}, filterInfo: {},
    groupInfo: { fieldIds: ['fld_proj'], fieldId: 'fld_proj' }, hiddenFieldIds: ['fld_qty'],
  }
}
function viewColsB(): StoredView {
  return {
    id: 'view_cols_b', sheetId: 'sheet_1', name: '列视图 B', type: 'grid', sortInfo: {}, filterInfo: {},
    groupInfo: { fieldIds: ['fld_qty'], fieldId: 'fld_qty' }, hiddenFieldIds: ['fld_key'],
  }
}

function makeServer(opts: { failLoadFor?: string; withoutViewFor?: string } = {}) {
  const store: Record<string, StoredView> = {
    view_all: viewA(), view_new: viewB(), view_saved: viewSaved(), view_cols_a: viewColsA(), view_cols_b: viewColsB(),
  }
  const client = new MultitableApiClient({ fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) })
  // Mutable so a test can make a view's load fail, then recover.
  const failingLoads = new Set<string>(opts.failLoadFor ? [opts.failLoadFor] : [])
  // A view id here makes its loads WAIT until release() — a slow network.
  let held: { viewId: string; gate: Promise<void>; release: () => void } | null = null
  const holdLoadsFor = (viewId: string) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    held = { viewId, gate, release: () => { held = null; release() } }
    return held.release
  }
  // Mutable: a view id here answers WITHOUT a `view` object.
  const viewlessLoads = new Set<string>(opts.withoutViewFor ? [opts.withoutViewFor] : [])
  const loadView = vi.spyOn(client, 'loadView').mockImplementation(async (params) => {
    const vid = params.viewId ?? ''
    if (held && held.viewId === vid) await held.gate
    if (failingLoads.has(vid)) throw new Error('network down')
    const view = store[vid]
    return {
      fields: FIELDS,
      rows: [],
      ...(viewlessLoads.has(vid) ? {} : { view: view ? JSON.parse(JSON.stringify(view)) : undefined }),
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    } as never
  })
  // Mimics PATCH /views/:id: JSON drops `undefined`, and a key absent from the body KEEPS the stored value.
  const applyPatch = (viewId: string, body: Partial<StoredView>) => {
    const current = store[viewId]
    if (!current) return
    if (body.sortInfo !== undefined) current.sortInfo = body.sortInfo
    if (body.filterInfo !== undefined) current.filterInfo = body.filterInfo
    if (body.hiddenFieldIds !== undefined) current.hiddenFieldIds = body.hiddenFieldIds
    if (body.groupInfo !== undefined) current.groupInfo = body.groupInfo
  }
  // A view id in `heldUpdateViews` PARKS its PATCHes (a slow network) until the test lands or fails them, oldest
  // first. The store changes only when a PATCH LANDS — exactly when the server would apply it.
  const heldUpdateViews = new Set<string>()
  const parked: Array<{ land: () => void; fail: () => void }> = []
  const updateView = vi.spyOn(client, 'updateView').mockImplementation(async (viewId, input) => {
    const body = JSON.parse(JSON.stringify(input ?? {})) as Partial<StoredView>
    if (heldUpdateViews.has(viewId)) {
      await new Promise<void>((resolve, reject) => {
        parked.push({
          land: () => { applyPatch(viewId, body); resolve() },
          fail: () => reject(new Error('PATCH failed')),
        })
      })
    } else {
      applyPatch(viewId, body)
    }
    return {} as never
  })
  const nextParked = () => {
    const next = parked.shift()
    if (!next) throw new Error('no PATCH is parked')
    return next
  }
  const landUpdate = () => nextParked().land()
  const failUpdate = () => nextParked().fail()
  const parkedCount = () => parked.length
  return { client, store, loadView, updateView, failingLoads, holdLoadsFor, viewlessLoads, heldUpdateViews, landUpdate, failUpdate, parkedCount }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// ---- harness: real toolbar + real grid header, wired the way MultitableWorkbench.vue wires them ----

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

function mountHarness(server: ReturnType<typeof makeServer>, initialViewId = 'view_all', isPersonalMode?: () => boolean) {
  const viewId = ref(initialViewId)
  let grid!: ReturnType<typeof useMultitableGrid>
  const Harness = defineComponent({
    setup() {
      grid = useMultitableGrid({ sheetId: ref('sheet_1'), viewId, client: server.client, isPersonalMode })
      // Same call sequence as MultitableWorkbench.vue onToggleSort (header click) / onUpdateSort / onClearFilters.
      function onToggleSort(fieldId: string) {
        const ex = grid.sortRules.value.find((r) => r.fieldId === fieldId)
        if (!ex) grid.addSortRule({ fieldId, direction: 'asc' })
        else if (ex.direction === 'asc') grid.addSortRule({ fieldId, direction: 'desc' })
        else grid.removeSortRule(fieldId)
        grid.applySortFilter()
      }
      function onUpdateSort(index: number, rule: SortRule) {
        grid.sortRules.value[index] = rule; grid.sortFilterDirty.value = true
      }
      function onClearFilters() { grid.clearFilters(); grid.applySortFilter() }
      return () => h('div', [
        h(MetaToolbar, {
          fields: FIELDS, hiddenFieldIds: grid.hiddenFieldIds.value,
          sortRules: grid.sortRules.value, filterRules: grid.filterRules.value,
          filterGroups: grid.filterGroups.value, filterConjunction: grid.filterConjunction.value,
          sortFilterDirty: grid.sortFilterDirty.value,
          canCreateRecord: true, canExport: true, canUndo: false, canRedo: false,
          onAddSort: grid.addSortRule, onRemoveSort: grid.removeSortRule, onUpdateSort,
          onAddFilter: grid.addFilterRule, onUpdateFilter: grid.updateFilterRule, onRemoveFilter: grid.removeFilterRule,
          onClearFilters, onApplySortFilter: grid.applySortFilter,
        }),
        h(MetaGridTable, {
          rows: grid.rows.value, visibleFields: FIELDS, sortRules: grid.sortRules.value, loading: false,
          currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true, searchText: '', rowDensity: 'normal',
          enableMultiSelect: false,
          onToggleSort,
        }),
      ])
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp(Harness)
  app.mount(container)
  mounts.push({ app, container })
  return { container, viewId, grid: () => grid }
}

const sortTrigger = (root: HTMLElement) => root.querySelector('button[title="Sort"]') as HTMLButtonElement
const filterTrigger = (root: HTMLElement) => root.querySelector('button[title="Filter"]') as HTMLButtonElement
const badgeOf = (btn: HTMLElement) => btn.querySelector('.meta-toolbar__badge')?.textContent?.trim() ?? null
const headerArrows = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.meta-field-header')).map((th) => th.querySelector('.meta-field-header__sort')?.textContent?.trim() ?? null)
const headerByName = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll('.meta-field-header')).find((th) => th.querySelector('.meta-field-header__name')?.textContent === name) as HTMLElement

beforeEach(() => { useLocale().setLocale('en') })
afterEach(() => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  document.body.innerHTML = ''
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('view switch: the loaded view is authoritative for sort + filter (客户反馈 2026-09-24 #5)', () => {
  it('A (3 sorts + 1 filter) → blank B: no 排序/筛选 badge, no header arrows, empty composable state', async () => {
    const server = makeServer()
    const { container, viewId, grid } = mountHarness(server)
    await flush()
    // Sanity: view A really shows its 3 sorts (▼ on 唯一键) and 1 filter.
    expect(badgeOf(sortTrigger(container))).toBe('3')
    expect(badgeOf(filterTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual(['▼', '▲', '▲'])

    viewId.value = 'view_new'
    await flush()

    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(badgeOf(filterTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
    expect(grid().sortRules.value).toEqual([])
    expect(grid().filterRules.value).toEqual([])
    expect(grid().filterGroups.value).toEqual([])
    expect(grid().nestedFilterNodes.value).toBeNull()
    expect(grid().filterConjunction.value).toBe('and')
    expect(grid().sortFilterDirty.value).toBe(false)
    // Switching views alone never writes anything.
    expect(server.updateView).not.toHaveBeenCalled()
  })

  it('B\'s load FAILS: the toolbar is cleared, and a header click writes NOTHING (B\'s saved filter + sort survive)', async () => {
    const server = makeServer({ failLoadFor: 'view_saved' })
    const { container, viewId, grid } = mountHarness(server)
    await flush()
    expect(grid().sortRules.value).toHaveLength(3)

    viewId.value = 'view_saved'
    await flush()

    expect(grid().error.value).toBe('network down')
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
    // B's state is NOT KNOWN (its load failed). An empty toolbar here means "not loaded", not "no rules":
    // a header click must neither smuggle A's 3 rules into B nor send an empty filter that wipes B's own.
    headerByName(container, '数量').click()
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_saved).toEqual(viewSaved())
    expect(server.store.view_all).toEqual(viewA())

    // The network comes back: B shows exactly its own saved sort + filter — the dropped click left no trace.
    server.failingLoads.clear()
    await grid().loadViewData(0)
    await flush()
    expect(grid().error.value).toBeNull()
    expect(badgeOf(sortTrigger(container))).toBe('1')
    expect(badgeOf(filterTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual([null, null, '▼'])
    expect(server.updateView).not.toHaveBeenCalled()

    // Now that B is known, a header click saves ONLY the sort facet — B's stored filter is left alone.
    headerByName(container, '唯一键').click()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_saved', {
      sortInfo: { rules: [{ fieldId: 'fld_qty', desc: true }, { fieldId: 'fld_key', desc: false }] },
    })
    expect(server.store.view_saved.filterInfo).toEqual(viewSaved().filterInfo)
  })

  it('B\'s load is still IN FLIGHT: + 添加排序 → 应用 writes nothing; B then shows its own saved rules', async () => {
    const server = makeServer()
    const { container, viewId } = mountHarness(server)
    await flush()

    const release = server.holdLoadsFor('view_saved')
    viewId.value = 'view_saved'
    await flush()
    expect(badgeOf(sortTrigger(container))).toBeNull()

    // The toolbar is usable during the load (the grid's loading overlay does not cover it).
    sortTrigger(container).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__add') as HTMLButtonElement).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__apply') as HTMLButtonElement).click()
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    // The dropped rule is not left on screen pretending to be applied while B is still loading.
    expect(badgeOf(sortTrigger(container))).toBeNull()

    release()
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_saved).toEqual(viewSaved())
    expect(badgeOf(sortTrigger(container))).toBe('1')
    expect(badgeOf(filterTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual([null, null, '▼'])
  })

  it('create-view path: a STAGED (unapplied) edit of A is never written into the new view', async () => {
    // MultitableWorkbench.vue onCreateView: `workbench.selectView(res.view.id)` then, in the SAME tick,
    // `await grid.loadViewData(grid.page.value.offset)` — this runs BEFORE the pre-flush view-switch watcher
    // resets the toolbar, while the state (and the dirty flag) are still A's.
    const server = makeServer()
    const { container, viewId, grid } = mountHarness(server)
    await flush()

    // Stage an edit in A without 应用: change the direction of the 唯一键 rule in the sort panel (onUpdateSort).
    sortTrigger(container).click()
    await flush()
    const dirSelect = document.querySelectorAll('.meta-toolbar__sort-panel .meta-toolbar__sort-rule')[1]
      .querySelectorAll('select')[1] as HTMLSelectElement
    dirSelect.value = 'asc'
    dirSelect.dispatchEvent(new Event('change'))
    await flush()
    expect(grid().sortFilterDirty.value).toBe(true)

    server.store.view_created = { ...viewB(), id: 'view_created', name: '视图 2' }
    viewId.value = 'view_created'
    await grid().loadViewData(grid().page.value.offset)
    await flush()

    // Nothing was written anywhere: not A's staged rules into the new view, not the staged edit into A.
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_created.sortInfo).toEqual({})
    expect(server.store.view_created.filterInfo).toEqual({})
    expect(server.store.view_all).toEqual(viewA())
    // …and the new view shows as blank.
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(badgeOf(filterTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
    expect(grid().sortFilterDirty.value).toBe(false)
  })

  it('a header click in B saves ONLY the clicked column\'s sort (never A\'s rules, and no filter key at all)', async () => {
    const server = makeServer()
    const { container, viewId } = mountHarness(server)
    await flush()
    viewId.value = 'view_new'
    await flush()

    headerByName(container, '数量').click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_new', {
      sortInfo: { rules: [{ fieldId: 'fld_qty', desc: false }] },
    })
    expect(server.store.view_new.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: false }] })
    expect(server.store.view_new.filterInfo).toEqual({})
    // After the reload B shows exactly its own single rule.
    expect(badgeOf(sortTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual([null, null, '▲'])
    // A is untouched.
    expect(server.store.view_all).toEqual(viewA())
  })

  it('应用 in B (sort panel) persists only what B shows; 清除筛选 in B never carries A\'s filter', async () => {
    const server = makeServer()
    const { container, viewId } = mountHarness(server)
    await flush()
    viewId.value = 'view_new'
    await flush()

    sortTrigger(container).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__add') as HTMLButtonElement).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__apply') as HTMLButtonElement).click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_new', {
      sortInfo: { rules: [{ fieldId: 'fld_key', desc: false }] },
    })

    // 清除筛选 path (onClearFilters → clearFilters + applySortFilter) in B: add a condition, then clear it.
    // Net change against what B stores (no filter) is nothing — so nothing is written, least of all A's filter.
    server.updateView.mockClear()
    filterTrigger(container).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__filter-actions .meta-toolbar__add') as HTMLButtonElement).click()
    await flush()
    const clearAll = document.querySelector('.meta-toolbar__filter-actions .meta-toolbar__add--danger') as HTMLButtonElement | null
    expect(clearAll).not.toBeNull()
    clearAll!.click()
    await flush()

    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_new.filterInfo).toEqual({})
    expect(server.store.view_new.sortInfo).toEqual({ rules: [{ fieldId: 'fld_key', desc: false }] })
    // A is untouched throughout.
    expect(server.store.view_all).toEqual(viewA())
  })

  it('清除筛选 in A saves ONLY an explicit empty filter — A\'s 3 sort rules are not rewritten', async () => {
    const server = makeServer()
    const { container } = mountHarness(server)
    await flush()

    filterTrigger(container).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__filter-actions .meta-toolbar__add--danger') as HTMLButtonElement).click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_all', {
      filterInfo: { conjunction: 'and', conditions: [] },
    })
    expect(server.store.view_all.sortInfo).toEqual(viewA().sortInfo)
    expect(badgeOf(sortTrigger(container))).toBe('3')
    expect(badgeOf(filterTrigger(container))).toBeNull()
  })

  it('clearing the LAST sort rule from the toolbar is saved as an explicit empty sort, and stays cleared after reload', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()

    sortTrigger(container).click()
    await flush()
    for (let i = 0; i < 3; i += 1) {
      ;(document.querySelector('.meta-toolbar__sort-rule .meta-toolbar__remove') as HTMLButtonElement).click()
      await flush()
    }
    expect(grid().sortRules.value).toEqual([])
    // The Apply button must survive the removal of the last rule, or the clear could never be applied.
    const apply = document.querySelector('.meta-toolbar__sort-panel .meta-toolbar__apply') as HTMLButtonElement | null
    expect(apply).not.toBeNull()
    apply!.click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    // Only the edited facet: the explicit empty sort. A's filter is not re-sent.
    expect(server.updateView).toHaveBeenCalledWith('view_all', { sortInfo: { rules: [] } })
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
    expect(server.store.view_all.filterInfo).toEqual(viewA().filterInfo)
    // Reloaded from the store: still no sort (the old undefined payload left the 3 rules in place).
    expect(grid().sortRules.value).toEqual([])
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(badgeOf(filterTrigger(container))).toBe('1')
  })

  it('a saved edit becomes the new baseline even when the reload after it FAILS (re-adding the old rules is saved)', async () => {
    const server = makeServer()
    const { grid } = mountHarness(server)
    await flush()

    // Clear A's 3 sorts and apply; the PATCH lands but the reload fails.
    server.failingLoads.add('view_all')
    for (const rule of [...grid().sortRules.value]) grid().removeSortRule(rule.fieldId)
    grid().applySortFilter()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
    expect(grid().error.value).toBe('network down')

    // Put exactly the original 3 rules back: that differs from what is STORED now (no sort), so it must be sent
    // — diffing against the stale pre-save baseline would call it "unchanged" and silently skip the write.
    server.failingLoads.clear()
    grid().addSortRule({ fieldId: 'fld_proj', direction: 'asc' })
    grid().addSortRule({ fieldId: 'fld_key', direction: 'desc' })
    grid().addSortRule({ fieldId: 'fld_qty', direction: 'asc' })
    grid().applySortFilter()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_all', { sortInfo: viewA().sortInfo }])
    expect(server.store.view_all.sortInfo).toEqual(viewA().sortInfo)
  })

  it('removing the LAST filter condition (×) then 应用 saves an explicit empty filter', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()

    grid().removeFilterRule(0)
    await flush()
    filterTrigger(container).click()
    await flush()
    const apply = document.querySelector('.meta-toolbar__filter-panel .meta-toolbar__apply') as HTMLButtonElement | null
    expect(apply).not.toBeNull()
    apply!.click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    const [vid, body] = server.updateView.mock.calls[0]
    expect(vid).toBe('view_all')
    // Only the edited facet: the explicit empty filter. A's 3 sort rules are not re-sent.
    expect(body).toEqual({ filterInfo: { conjunction: 'and', conditions: [] } })
    expect(server.store.view_all.filterInfo).toEqual({ conjunction: 'and', conditions: [] })
    expect(server.store.view_all.sortInfo).toEqual(viewA().sortInfo)
    expect(grid().filterRules.value).toEqual([])
    expect(badgeOf(filterTrigger(container))).toBeNull()
  })

  it('a view-settings save of `{}` (MetaViewManager clear) is honoured on reload instead of keeping stale rules', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()
    expect(grid().sortRules.value).toHaveLength(3)

    // MetaViewManager.buildCommonViewPayload sends `{}` for a cleared facet; the workbench then reloads.
    server.store.view_all.sortInfo = {}
    server.store.view_all.filterInfo = {}
    await grid().loadViewData(0)
    await flush()

    expect(grid().sortRules.value).toEqual([])
    expect(grid().filterRules.value).toEqual([])
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
  })

  it('a response with no view clears the sort/filter state (the server applied none) and allows no write', async () => {
    const server = makeServer({ withoutViewFor: 'view_new' })
    const { container, viewId, grid } = mountHarness(server)
    await flush()
    expect(grid().sortRules.value).toHaveLength(3)
    viewId.value = 'view_new'
    await flush()
    // Re-populate the state AFTER the switch-reset so only the no-view branch of loadViewData can clear it.
    grid().sortRules.value = [{ fieldId: 'fld_key', direction: 'desc' }]
    grid().filterRules.value = [{ fieldId: 'fld_proj', operator: 'contains', value: 'x' }]
    await grid().loadViewData(0)
    await flush()
    expect(grid().sortRules.value).toEqual([])
    expect(grid().filterRules.value).toEqual([])
    // With no view to compare against, the state stays "not known": a header click persists nothing.
    headerByName(container, '数量').click()
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
  })

  it('personal mode: clearing the last sort writes an explicit empty sort into the merged overlay (no fall-back to shared)', async () => {
    const server = makeServer()
    const getPersonal = vi.spyOn(server.client, 'getPersonalViewConfig').mockResolvedValue({
      viewId: 'view_all', config: { sortInfo: { rules: [{ fieldId: 'fld_key', desc: true }] }, hiddenFieldIds: ['fld_qty'] } as never, updatedAt: null,
    })
    const putPersonal = vi.spyOn(server.client, 'putPersonalViewConfig').mockResolvedValue({ viewId: 'view_all', config: {} as never, updatedAt: null })
    const { grid } = mountHarness(server, 'view_all', () => true)
    await flush()

    for (const rule of [...grid().sortRules.value]) grid().removeSortRule(rule.fieldId)
    grid().applySortFilter()
    await flush()

    expect(getPersonal).toHaveBeenCalledWith('view_all')
    expect(putPersonal).toHaveBeenCalledTimes(1)
    const [vid, overlay] = putPersonal.mock.calls[0]
    expect(vid).toBe('view_all')
    // The explicit empty survives the JSON boundary (an `undefined` facet would be dropped and the
    // server would fall back to the SHARED sort, silently undoing the user's clear). The untouched filter
    // facet is NOT written: it is not pinned into the overlay, so the user keeps inheriting the shared filter.
    expect(JSON.parse(JSON.stringify(overlay))).toEqual({
      sortInfo: { rules: [] },
      hiddenFieldIds: ['fld_qty'],
    })
    expect(server.updateView).not.toHaveBeenCalled()
  })
})

describe('#6075 round 2: in-flight writes, discarded edits, and the column / grouping state', () => {
  const removeAllSorts = (grid: ReturnType<typeof useMultitableGrid>) => {
    for (const rule of [...grid.sortRules.value]) grid.removeSortRule(rule.fieldId)
  }

  it('a rule RE-ADDED while the removal PATCH is in flight is sent — and wins (last write wins)', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')

    // 应用 #1: remove all of A's sort rules → PATCH #1 `{ rules: [] }` is in flight.
    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()
    expect(server.updateView.mock.calls).toEqual([['view_all', { sortInfo: { rules: [] } }]])

    // Meanwhile the user re-adds exactly the same 3 rules → 应用 #2. Against the stale pre-write baseline that is
    // "unchanged"; against the pending write (no sort) it is a real change and must be sent.
    grid().addSortRule({ fieldId: 'fld_proj', direction: 'asc' })
    grid().addSortRule({ fieldId: 'fld_key', direction: 'desc' })
    grid().addSortRule({ fieldId: 'fld_qty', direction: 'asc' })
    grid().applySortFilter()
    await flush()

    server.landUpdate() // PATCH #1 lands
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_all', { sortInfo: viewA().sortInfo }])
    server.landUpdate() // PATCH #2 lands
    await flush()

    expect(server.store.view_all.sortInfo).toEqual(viewA().sortInfo)
    expect(badgeOf(sortTrigger(container))).toBe('3')
    expect(headerArrows(container)).toEqual(['▼', '▲', '▲'])
    expect(grid().sortFilterDirty.value).toBe(false)
  })

  it('writes to one view are serialised: 应用 #2 is sent only after 应用 #1\'s PATCH has settled', async () => {
    const server = makeServer()
    const { grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')

    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()
    grid().addSortRule({ fieldId: 'fld_qty', direction: 'desc' })
    grid().applySortFilter()
    await flush()
    // #2 waits behind #1 — two PATCHes racing to the server could be applied in either order.
    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.parkedCount()).toBe(1)

    server.landUpdate()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_all', { sortInfo: { rules: [{ fieldId: 'fld_qty', desc: true }] } }])
    server.landUpdate()
    await flush()
    expect(server.store.view_all.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: true }] })
  })

  it('a reload never READS the view while a sort/filter write to it is in flight (no pre-write re-sync)', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')

    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()
    const loadsBefore = server.loadView.mock.calls.length
    // Any other reload meanwhile (a page change, a record-mutation reload, 应用 with nothing new).
    void grid().loadViewData(0)
    await flush()
    // A GET now would return A's 3 pre-write rules and re-sync the toolbar (and its baseline) to them.
    expect(server.loadView.mock.calls.length).toBe(loadsBefore)

    server.landUpdate()
    await flush()
    expect(server.loadView.mock.calls.length).toBeGreaterThan(loadsBefore)
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
    // The grid shows what the view now stores.
    expect(grid().sortRules.value).toEqual([])
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
  })

  it('a FAILED write is rolled back: the edit stays staged and the next load retries it', async () => {
    const server = makeServer()
    const { grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')
    server.failingLoads.add('view_all') // the network is down: the reload after the failed PATCH fails too

    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()
    server.failUpdate()
    await flush()
    expect(grid().error.value).toBe('network down')
    expect(server.store.view_all.sortInfo).toEqual(viewA().sortInfo)
    expect(grid().sortRules.value).toEqual([]) // the user's edit is still on screen…
    expect(grid().sortFilterDirty.value).toBe(true) // …and staged again

    // The network is back: the next load retries exactly the failed write.
    server.heldUpdateViews.clear()
    server.failingLoads.clear()
    await grid().loadViewData(0)
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_all', { sortInfo: { rules: [] } }])
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
  })

  it('a slow write for A that SUCCEEDS after the switch to B leaves B\'s staged edit and dirty flag alone', async () => {
    const server = makeServer()
    const { viewId, grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')
    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()

    viewId.value = 'view_new'
    await flush()
    // Stage an edit in B, without 应用.
    grid().addSortRule({ fieldId: 'fld_qty', direction: 'desc' })
    expect(grid().sortFilterDirty.value).toBe(true)

    server.landUpdate() // A's PATCH finally lands
    await flush()
    expect(grid().sortFilterDirty.value).toBe(true)
    // …so B's next load still applies B's staged edit — into B only.
    await grid().loadViewData(0)
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_new', { sortInfo: { rules: [{ fieldId: 'fld_qty', desc: true }] } }])
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
  })

  it('a slow write for A that FAILS after the switch to B never rolls A\'s baseline / dirty flag back over B\'s', async () => {
    const server = makeServer()
    const { container, viewId, grid } = mountHarness(server)
    await flush()
    server.heldUpdateViews.add('view_all')
    removeAllSorts(grid())
    grid().applySortFilter()
    await flush()

    viewId.value = 'view_new'
    await flush()
    server.failUpdate() // A's PATCH fails, with B on screen
    await flush()
    expect(grid().sortFilterDirty.value).toBe(false)
    expect(badgeOf(sortTrigger(container))).toBeNull()

    // B's own baseline survived: a header click in B saves exactly B's new rule, into B.
    headerByName(container, '数量').click()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(2)
    expect(server.updateView.mock.calls[1]).toEqual(['view_new', { sortInfo: { rules: [{ fieldId: 'fld_qty', desc: false }] } }])
    expect(server.store.view_new.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: false }] })
    expect(server.store.view_all).toEqual(viewA())
  })

  it('discardUnappliedSortFilterEdits (视图管理 save / revert): the reload re-syncs from the saved view and PATCHes nothing', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()

    // Staged in the toolbar, NOT applied: remove every sort rule (would go out as an explicit `{ rules: [] }`).
    removeAllSorts(grid())
    expect(grid().sortFilterDirty.value).toBe(true)
    expect(server.updateView).not.toHaveBeenCalled()

    // The dialog saves a different sort for the same view; the workbench then discards + reloads.
    server.store.view_all.sortInfo = { rules: [{ fieldId: 'fld_qty', desc: true }] }
    grid().discardUnappliedSortFilterEdits()
    // Discarded ⇒ no longer staged (the toolbar stops offering to apply it).
    expect(grid().sortFilterDirty.value).toBe(false)
    await grid().loadViewData(0)
    await flush()

    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_all.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: true }] })
    expect(badgeOf(sortTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual([null, null, '▼'])
    expect(grid().sortFilterDirty.value).toBe(false)
  })

  it('discardUnappliedSortFilterEdits + the reload FAILS: the stale baseline is gone, so nothing is written', async () => {
    const server = makeServer()
    const { container, grid } = mountHarness(server)
    await flush()

    removeAllSorts(grid())
    server.store.view_all.sortInfo = { rules: [{ fieldId: 'fld_qty', desc: true }] }
    server.failingLoads.add('view_all')
    grid().discardUnappliedSortFilterEdits()
    await grid().loadViewData(0)
    await flush()
    expect(grid().error.value).toBe('network down')

    // The toolbar was never re-synced; diffing against the pre-save baseline would PATCH it over the saved sort.
    headerByName(container, '唯一键').click()
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_all.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: true }] })
  })

  it('hidden columns / grouping: while B\'s load is IN FLIGHT the grid shows all columns and writes nothing into B', async () => {
    const server = makeServer()
    const { viewId, grid } = mountHarness(server, 'view_cols_a')
    await flush()
    expect(grid().hiddenFieldIds.value).toEqual(['fld_qty'])
    expect(grid().groupFieldIds.value).toEqual(['fld_proj'])

    const release = server.holdLoadsFor('view_cols_b')
    viewId.value = 'view_cols_b'
    await flush()
    // Not known yet ⇒ blank, as the 新视图 hint says: all columns, no grouping, entry order — not A's.
    expect(grid().hiddenFieldIds.value).toEqual([])
    expect(grid().groupFieldIds.value).toEqual([])
    expect(grid().fieldOrder.value).toEqual([])
    expect(grid().isViewStateLoadedFor('view_cols_b')).toBe(false)

    // Toggling a column / setting a group level now would PUT a whole list that is not B's.
    grid().toggleFieldVisibility('fld_proj')
    await grid().setGroupFields(['fld_proj'])
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_cols_b).toEqual(viewColsB())
    expect(server.store.view_cols_a).toEqual(viewColsA())

    release()
    await flush()
    // B shows exactly its own stored columns / grouping.
    expect(grid().hiddenFieldIds.value).toEqual(['fld_key'])
    expect(grid().groupFieldIds.value).toEqual(['fld_qty'])
    expect(grid().isViewStateLoadedFor('view_cols_b')).toBe(true)

    // Once known, a toggle writes B's own list plus the toggled column — nothing of A's.
    grid().toggleFieldVisibility('fld_proj')
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_cols_b', { hiddenFieldIds: ['fld_key', 'fld_proj'] })
  })

  it('hidden columns / grouping: when B\'s load FAILS nothing is written into B (its stored lists survive)', async () => {
    const server = makeServer({ failLoadFor: 'view_cols_b' })
    const { viewId, grid } = mountHarness(server, 'view_cols_a')
    await flush()

    viewId.value = 'view_cols_b'
    await flush()
    expect(grid().error.value).toBe('network down')
    expect(grid().hiddenFieldIds.value).toEqual([])

    grid().toggleFieldVisibility('fld_qty')
    await grid().setGroupFields([])
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_cols_b).toEqual(viewColsB())
  })

  it('a loaded view with no hidden list shows every column (the previous hidden list is not kept)', async () => {
    const server = makeServer()
    const { grid } = mountHarness(server, 'view_cols_a')
    await flush()
    expect(grid().hiddenFieldIds.value).toEqual(['fld_qty'])

    delete (server.store.view_cols_a as Partial<StoredView>).hiddenFieldIds
    await grid().loadViewData(0)
    await flush()
    expect(grid().hiddenFieldIds.value).toEqual([])
  })

  it('a reload that answers WITHOUT a view drops the column / grouping state and the right to write it', async () => {
    const server = makeServer()
    const { grid } = mountHarness(server, 'view_cols_a')
    await flush()
    expect(grid().isViewStateLoadedFor('view_cols_a')).toBe(true)

    server.viewlessLoads.add('view_cols_a')
    await grid().loadViewData(0)
    await flush()
    expect(grid().hiddenFieldIds.value).toEqual([])
    expect(grid().groupFieldIds.value).toEqual([])
    expect(grid().isViewStateLoadedFor('view_cols_a')).toBe(false)
    grid().toggleFieldVisibility('fld_key')
    await flush()
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.store.view_cols_a).toEqual(viewColsA())
  })
})

describe('MetaViewManager: the add-view row explains that a new view starts blank', () => {
  function mountManager() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      render: () => h(MetaViewManager, {
        visible: true, sheetId: 'sheet_1', activeViewId: 'view_all', fields: FIELDS,
        views: [{ id: 'view_all', sheetId: 'sheet_1', name: 'All Records', type: 'grid' }],
      }),
    })
    app.mount(container)
    mounts.push({ app, container })
    return container
  }

  it('shows the zh hint under the add row', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountManager()
    await flush()
    const hint = root.querySelector('.meta-view-mgr__add-section [data-new-view-blank-hint]')
    expect(hint?.textContent?.trim()).toBe('新视图从空白开始：显示全部列、按录入顺序、无筛选')
  })

  it('shows the en hint under the add row', async () => {
    const root = mountManager()
    await flush()
    const hint = root.querySelector('.meta-view-mgr__add-section [data-new-view-blank-hint]')
    expect(hint?.textContent?.trim()).toBe('New views start blank: all columns shown, in entry order, no filter.')
  })
})
