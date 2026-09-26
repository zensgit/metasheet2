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
 * This spec drives the REAL composable (useMultitableGrid) + the REAL MetaToolbar / MetaGridTable against a
 * MultitableApiClient whose loadView/updateView are backed by an in-memory view store that mimics the
 * server's PATCH merge (a key that is absent from the body keeps the stored value).
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

function makeServer(opts: { failLoadFor?: string; withoutViewFor?: string } = {}) {
  const store: Record<string, StoredView> = { view_all: viewA(), view_new: viewB() }
  const client = new MultitableApiClient({ fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) })
  const loadView = vi.spyOn(client, 'loadView').mockImplementation(async (params) => {
    const vid = params.viewId ?? ''
    if (opts.failLoadFor && vid === opts.failLoadFor) throw new Error('network down')
    const view = store[vid]
    return {
      fields: FIELDS,
      rows: [],
      ...(opts.withoutViewFor === vid ? {} : { view: view ? JSON.parse(JSON.stringify(view)) : undefined }),
      page: { offset: 0, limit: 50, total: 0, hasMore: false },
    } as never
  })
  // Mimics PATCH /views/:id: JSON drops `undefined`, and a key absent from the body KEEPS the stored value.
  const updateView = vi.spyOn(client, 'updateView').mockImplementation(async (viewId, input) => {
    const body = JSON.parse(JSON.stringify(input ?? {})) as Partial<StoredView>
    const current = store[viewId]
    if (current) {
      if (body.sortInfo !== undefined) current.sortInfo = body.sortInfo
      if (body.filterInfo !== undefined) current.filterInfo = body.filterInfo
    }
    return {} as never
  })
  return { client, store, loadView, updateView }
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

  it('the toolbar is cleared the moment the view changes — even if B\'s load then FAILS', async () => {
    const server = makeServer({ failLoadFor: 'view_new' })
    const { container, viewId, grid } = mountHarness(server)
    await flush()
    expect(grid().sortRules.value).toHaveLength(3)

    viewId.value = 'view_new'
    await flush()

    expect(grid().error.value).toBe('network down')
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(headerArrows(container)).toEqual([null, null, null])
    // A header click on the (failed-to-load) B must not smuggle A's 3 rules into B.
    headerByName(container, '数量').click()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView.mock.calls[0][0]).toBe('view_new')
    expect(server.updateView.mock.calls[0][1]).toEqual({
      sortInfo: { rules: [{ fieldId: 'fld_qty', desc: false }] },
      filterInfo: { conjunction: 'and', conditions: [] },
    })
  })

  it('a header click in B saves ONLY the clicked column\'s sort (never A\'s rules or A\'s filter)', async () => {
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
      filterInfo: { conjunction: 'and', conditions: [] },
    })
    expect(server.store.view_new.sortInfo).toEqual({ rules: [{ fieldId: 'fld_qty', desc: false }] })
    expect(server.store.view_new.filterInfo).toEqual({ conjunction: 'and', conditions: [] })
    // After the reload B shows exactly its own single rule.
    expect(badgeOf(sortTrigger(container))).toBe('1')
    expect(headerArrows(container)).toEqual([null, null, '▲'])
    // A is untouched.
    expect(server.store.view_all).toEqual(viewA())
  })

  it('应用 in B (sort panel) persists only what B shows; 清除筛选 in B persists an empty filter, not A\'s', async () => {
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
      filterInfo: { conjunction: 'and', conditions: [] },
    })

    // 清除筛选 path (onClearFilters → clearFilters + applySortFilter) in B: add a condition, then clear it.
    server.updateView.mockClear()
    filterTrigger(container).click()
    await flush()
    ;(document.querySelector('.meta-toolbar__filter-actions .meta-toolbar__add') as HTMLButtonElement).click()
    await flush()
    const clearAll = document.querySelector('.meta-toolbar__filter-actions .meta-toolbar__add--danger') as HTMLButtonElement | null
    expect(clearAll).not.toBeNull()
    clearAll!.click()
    await flush()

    expect(server.updateView).toHaveBeenCalledTimes(1)
    expect(server.updateView).toHaveBeenCalledWith('view_new', {
      sortInfo: { rules: [{ fieldId: 'fld_key', desc: false }] },
      filterInfo: { conjunction: 'and', conditions: [] },
    })
    expect(server.store.view_new.filterInfo).toEqual({ conjunction: 'and', conditions: [] })
    // A is untouched throughout.
    expect(server.store.view_all).toEqual(viewA())
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
    expect(server.updateView).toHaveBeenCalledWith('view_all', {
      sortInfo: { rules: [] },
      filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_proj', operator: 'contains', value: '2025' }] },
    })
    expect(server.store.view_all.sortInfo).toEqual({ rules: [] })
    // Reloaded from the store: still no sort (the old undefined payload left the 3 rules in place).
    expect(grid().sortRules.value).toEqual([])
    expect(badgeOf(sortTrigger(container))).toBeNull()
    expect(badgeOf(filterTrigger(container))).toBe('1')
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
    expect(body.filterInfo).toEqual({ conjunction: 'and', conditions: [] })
    expect(body.sortInfo).toEqual(viewA().sortInfo)
    expect(server.store.view_all.filterInfo).toEqual({ conjunction: 'and', conditions: [] })
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

  it('a response with no view clears the sort/filter state (the server applied none)', async () => {
    const server = makeServer({ withoutViewFor: 'view_new' })
    const { viewId, grid } = mountHarness(server)
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
    // server would fall back to the SHARED sort, silently undoing the user's clear).
    expect(JSON.parse(JSON.stringify(overlay))).toEqual({
      sortInfo: { rules: [] },
      filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_proj', operator: 'contains', value: '2025' }] },
      hiddenFieldIds: ['fld_qty'],
    })
    expect(server.updateView).not.toHaveBeenCalled()
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
