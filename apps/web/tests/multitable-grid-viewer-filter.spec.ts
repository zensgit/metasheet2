/**
 * 备料 「查看子件」 / 「查看所有使用位置」 (owner question 2026-11-07) — the REAL grid composable's viewer filter
 * (useMultitableGrid setViewerFilter / clearViewerFilter) against a MultitableApiClient whose loadView / updateView /
 * getPersonalViewConfig / putPersonalViewConfig are spied:
 *
 *   V-01 transience: setting and clearing it issues NO view-config write — no PATCH of the shared view, no PUT of the
 *        personal overlay, in shared AND in personal mode — and never touches filterRules / sortFilterDirty;
 *   V-02 the records query: the exact `viewerFilter` JSON (field id, `is`, the value) on GET /view, on every reload and on
 *        loadMore, while the view's own stored filter stays what the server returns;
 *   V-03 clear restores: the next GET /view is byte-identical to the one before the filter was set (same offset too);
 *   V-04 a toolbar filter applied while the viewer filter is up persists ONLY the toolbar's rules (the viewer leaf is
 *        never part of the PATCH body);
 *   V-05 a view switch drops the viewer filter.
 *
 * Collected by the required web gate through the existing `multitable-grid` token. Synthetic ids only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { useMultitableGrid, type ViewerFilterState } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { MetaField } from '../src/multitable/types'

const FIELDS: MetaField[] = [
  { id: 'fld_vf_code', name: '图号', type: 'string' },
  { id: 'fld_vf_src', name: 'PLM 物料ID', type: 'string' },
  { id: 'fld_vf_parent_src', name: '父件源ID', type: 'string' },
  { id: 'fld_vf_active', name: '有效', type: 'boolean' },
]
// The fill view: 有效 only, the two id columns hidden.
const STORED_FILL = {
  id: 'view_fill',
  sheetId: 'sheet_vf',
  name: '备料填写视图',
  type: 'grid',
  sortInfo: { rules: [{ fieldId: 'fld_vf_code', desc: false }] },
  filterInfo: { conjunction: 'and', conditions: [{ fieldId: 'fld_vf_active', operator: 'is', value: true }] },
  groupInfo: {},
  hiddenFieldIds: ['fld_vf_src', 'fld_vf_parent_src'],
}
const STORED_ALL = { ...STORED_FILL, id: 'view_all', name: '全部记录', filterInfo: {}, hiddenFieldIds: [] as string[] }

const CHILDREN_OF_S01: ViewerFilterState = {
  label: 'Viewing: children of S-01 (only for you)',
  conditions: [{ fieldId: 'fld_vf_parent_src', operator: 'is', value: 'SRC-S01' }],
}
const EXPECTED_PARAM = JSON.stringify({ conditions: [{ fieldId: 'fld_vf_parent_src', operator: 'is', value: 'SRC-S01' }] })

function makeServer() {
  const store: Record<string, Record<string, unknown>> = {
    view_fill: JSON.parse(JSON.stringify(STORED_FILL)),
    view_all: JSON.parse(JSON.stringify(STORED_ALL)),
  }
  const client = new MultitableApiClient({ fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) })
  const loadView = vi.spyOn(client, 'loadView').mockImplementation(async (params) => ({
    fields: FIELDS,
    rows: Array.from({ length: params.limit ?? 50 }, (_, i) => ({ id: `rec_vf_${(params.offset ?? 0) + i}`, version: 1, data: {} })),
    view: JSON.parse(JSON.stringify(store[params.viewId ?? ''] ?? {})),
    page: { offset: params.offset ?? 0, limit: params.limit ?? 50, total: 300, hasMore: (params.offset ?? 0) + 50 < 300 },
  }) as never)
  const updateView = vi.spyOn(client, 'updateView').mockImplementation(async (viewId, input) => {
    const body = JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>
    if (body.filterInfo !== undefined) store[viewId].filterInfo = body.filterInfo
    if (body.sortInfo !== undefined) store[viewId].sortInfo = body.sortInfo
    return {} as never
  })
  const getPersonal = vi.spyOn(client, 'getPersonalViewConfig').mockResolvedValue(null as never)
  const putPersonal = vi.spyOn(client, 'putPersonalViewConfig').mockResolvedValue({} as never)
  const deletePersonal = vi.spyOn(client, 'deletePersonalViewConfig').mockResolvedValue(undefined as never)
  const viewConfigWrites = () => updateView.mock.calls.length + putPersonal.mock.calls.length + deletePersonal.mock.calls.length
  return { client, store, loadView, updateView, getPersonal, putPersonal, deletePersonal, viewConfigWrites }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let mounted: App | null = null
afterEach(() => {
  mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function mountGrid(server: ReturnType<typeof makeServer>, opts: { personal?: boolean; viewId?: string } = {}) {
  const viewId = ref(opts.viewId ?? 'view_fill')
  let grid!: ReturnType<typeof useMultitableGrid>
  const Harness = defineComponent({
    setup() {
      grid = useMultitableGrid({
        sheetId: ref('sheet_vf'),
        viewId,
        client: server.client,
        pageSize: 50,
        isPersonalMode: opts.personal ? () => true : undefined,
      })
      return () => h('div')
    },
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  mounted = createApp(Harness)
  mounted.mount(el)
  await flush()
  return { grid, viewId }
}

const lastLoad = (server: ReturnType<typeof makeServer>) => server.loadView.mock.calls.at(-1)![0]

describe('V-01 transience: no view-config write, ever', () => {
  for (const personal of [false, true]) {
    it(`${personal ? 'personal' : 'shared'} mode: set + reload + clear send no PATCH / PUT / DELETE of view config`, async () => {
      const server = makeServer()
      const { grid } = await mountGrid(server, { personal })
      const filterBefore = JSON.stringify([grid.filterRules.value, grid.filterGroups.value, grid.filterConjunction.value])
      await grid.setViewerFilter(CHILDREN_OF_S01)
      await flush()
      expect(grid.sortFilterDirty.value).toBe(false)
      await grid.loadViewData(0)
      await grid.reloadCurrentPage()
      await grid.clearViewerFilter()
      await flush()
      expect(server.viewConfigWrites()).toBe(0)
      expect(server.updateView).not.toHaveBeenCalled()
      expect(server.putPersonal).not.toHaveBeenCalled()
      expect(JSON.stringify([grid.filterRules.value, grid.filterGroups.value, grid.filterConjunction.value])).toBe(filterBefore)
      expect(grid.sortFilterDirty.value).toBe(false)
      // The stored view is exactly what it was.
      expect(server.store.view_fill).toEqual(STORED_FILL)
    })
  }
})

describe('V-02 the records query carries the exact viewer filter', () => {
  it('GET /view gets the JSON on set, on every reload and on loadMore; the toolbar still shows only the view\'s own rule', async () => {
    const server = makeServer()
    const { grid } = await mountGrid(server)
    await grid.setViewerFilter(CHILDREN_OF_S01)
    await flush()
    expect(lastLoad(server)).toMatchObject({ sheetId: 'sheet_vf', viewId: 'view_fill', offset: 0, viewerFilter: EXPECTED_PARAM })
    expect(grid.viewerFilterParam.value).toBe(EXPECTED_PARAM)
    expect(grid.viewerFilter.value?.label).toBe(CHILDREN_OF_S01.label)
    expect(grid.filterRules.value).toEqual([{ fieldId: 'fld_vf_active', operator: 'is', value: true }])
    await grid.reloadCurrentPage()
    expect(lastLoad(server).viewerFilter).toBe(EXPECTED_PARAM)
    await grid.loadMore()
    expect(lastLoad(server)).toMatchObject({ offset: 50, viewerFilter: EXPECTED_PARAM })
  })

  it('the condition targets a column the view hides (filtering is not bounded by hidden_field_ids)', async () => {
    const server = makeServer()
    const { grid } = await mountGrid(server)
    expect(grid.hiddenFieldIds.value).toContain('fld_vf_parent_src')
    await grid.setViewerFilter(CHILDREN_OF_S01)
    const sent = JSON.parse(lastLoad(server).viewerFilter as string) as { conditions: Array<{ fieldId: string }> }
    expect(sent.conditions.map((c) => c.fieldId)).toEqual(['fld_vf_parent_src'])
  })
})

describe('V-03 clear restores the view exactly', () => {
  it('the request after clear equals the one before set (same page)', async () => {
    const server = makeServer()
    const { grid } = await mountGrid(server)
    await grid.goToPage(3)
    await flush()
    const before = { ...lastLoad(server) }
    expect(before.offset).toBe(100)
    expect('viewerFilter' in before && before.viewerFilter !== undefined).toBe(false)
    await grid.setViewerFilter(CHILDREN_OF_S01)
    expect(lastLoad(server).offset).toBe(0)
    await grid.clearViewerFilter()
    await flush()
    expect(lastLoad(server)).toEqual(before)
    expect(grid.viewerFilter.value).toBeNull()
    expect(grid.viewerFilterParam.value).toBeUndefined()
  })

  it('clear with nothing set is a no-op (no request)', async () => {
    const server = makeServer()
    const { grid } = await mountGrid(server)
    const calls = server.loadView.mock.calls.length
    await grid.clearViewerFilter()
    expect(server.loadView.mock.calls.length).toBe(calls)
  })
})

describe('V-04 a toolbar filter applied meanwhile', () => {
  it('persists only the toolbar\'s rules — the viewer leaf never reaches the PATCH body', async () => {
    const server = makeServer()
    const { grid } = await mountGrid(server)
    await grid.setViewerFilter(CHILDREN_OF_S01)
    grid.addFilterRule({ fieldId: 'fld_vf_code', operator: 'contains', value: 'S-' })
    grid.applySortFilter()
    await flush()
    expect(server.updateView).toHaveBeenCalledTimes(1)
    const body = JSON.stringify(server.updateView.mock.calls[0][1])
    expect(body).not.toContain('fld_vf_parent_src')
    expect(body).not.toContain('SRC-S01')
    // …and the reload that followed still narrows for this viewer.
    expect(lastLoad(server).viewerFilter).toBe(EXPECTED_PARAM)
  })
})

describe('V-05 a view switch drops it', () => {
  it('the next view loads without the viewer filter', async () => {
    const server = makeServer()
    const { grid, viewId } = await mountGrid(server)
    await grid.setViewerFilter(CHILDREN_OF_S01)
    viewId.value = 'view_all'
    await flush()
    expect(lastLoad(server).viewId).toBe('view_all')
    expect(lastLoad(server).viewerFilter).toBeUndefined()
    expect(grid.viewerFilter.value).toBeNull()
    expect(server.viewConfigWrites()).toBe(0)
  })
})

describe('V-06 a toolbar edit staged (not applied) when the button / the clear is pressed', () => {
  const STAGED = { fieldId: 'fld_vf_code', operator: 'contains', value: 'STAGED-X' }
  const expectNoWriteAndResynced = (server: ReturnType<typeof makeServer>, grid: ReturnType<typeof useMultitableGrid>) => {
    expect(server.updateView).not.toHaveBeenCalled()
    expect(server.putPersonal).not.toHaveBeenCalled()
    expect(server.deletePersonal).not.toHaveBeenCalled()
    expect(server.viewConfigWrites()).toBe(0)
    expect(server.store.view_fill).toEqual(STORED_FILL)
    // The staged rule is dropped and the toolbar shows the stored view again.
    expect(grid.filterRules.value).toEqual([{ fieldId: 'fld_vf_active', operator: 'is', value: true }])
    expect(grid.sortFilterDirty.value).toBe(false)
  }
  for (const personal of [false, true]) {
    it(`${personal ? 'personal' : 'shared'} mode: addFilterRule (no 应用) then setViewerFilter writes nothing`, async () => {
      const server = makeServer()
      const { grid } = await mountGrid(server, { personal })
      grid.addFilterRule({ ...STAGED })
      expect(grid.sortFilterDirty.value).toBe(true)
      await grid.setViewerFilter(CHILDREN_OF_S01)
      await flush()
      expect(lastLoad(server)).toMatchObject({ viewId: 'view_fill', offset: 0, viewerFilter: EXPECTED_PARAM })
      expectNoWriteAndResynced(server, grid)
    })
    it(`${personal ? 'personal' : 'shared'} mode: setViewerFilter, addFilterRule (no 应用), then clearViewerFilter writes nothing`, async () => {
      const server = makeServer()
      const { grid } = await mountGrid(server, { personal })
      await grid.setViewerFilter(CHILDREN_OF_S01)
      await flush()
      grid.addFilterRule({ ...STAGED })
      expect(grid.sortFilterDirty.value).toBe(true)
      await grid.clearViewerFilter()
      await flush()
      expect(lastLoad(server).viewerFilter).toBeUndefined()
      expectNoWriteAndResynced(server, grid)
    })
  }
})
