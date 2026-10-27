/**
 * 客户反馈 2026-10-21 (on-prem R69): grid paging across grouping changes, and a rows-per-page choice.
 *
 * Field report, 154-row sheet: grouped by a text column the pager shows 4 pages (50/page). Removing the grouping
 * on page 1 showed all 154 rows (scroll accumulation, as designed); on pages 2 and 3 it showed 100 rows; on page 4
 * it showed 4 rows and the pager (上一页 / 1/4 / 下一页) disappeared.
 *
 * Root cause: grouping is client-side over ONE server page (offset/limit). Changing it kept the page-N offset and
 * rows, while the flat path hides the footer pager and scroll-appends at `rows.length` — right only when the held
 * rows start at row 0. Fix: a grouping change reloads page 1 (useMultitableGrid.setGroupFields), the flat path only
 * appends from offset 0 (canLoadMore), and MetaGridTable keeps the pager past page 1 even on the flat path.
 *
 * Values-free: synthetic ids and labels only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { useLocale } from '../src/composables/useLocale'
import {
  GRID_PAGE_SIZE_OPTIONS,
  clampGridPageSize,
  gridPageSizeStorageKey,
  readGridPageSize,
  writeGridPageSize,
} from '../src/multitable/utils/grid-page-size'
import type { MetaField, MetaRecord } from '../src/multitable/types'

const TOTAL = 154
const GROUP_FIELD = 'grp'

type Call = { method: string; url: string; offset?: number; limit?: number; viewId?: string | null; body?: Record<string, unknown> }

// A paginated /view backend over TOTAL rows that STORES the view's groupInfo (PATCH /views/:id) and serves it back,
// like the server: grouping does not change the row order or the page math — it is applied client-side.
//
// holdNext(method) parks the NEXT request of that method until the returned release() is called — to order a
// write against a read the way overlapping edits do in the field. A held GET reads the stored grouping when it
// ARRIVES (like a server read), and answers on release.
function makeBackend(opts: { total?: number; groupInfo?: Record<string, unknown>; patchStatus?: number; holdPatch?: Promise<void>; getStatus?: () => number; groupInfoFor?: (viewId: string | null) => Record<string, unknown> | undefined } = {}) {
  const total = opts.total ?? TOTAL
  let groupInfo: Record<string, unknown> = opts.groupInfo ?? {}
  const calls: Call[] = []
  const holds: Record<string, Array<Promise<void>>> = { GET: [], PATCH: [] }
  function holdNext(method: 'GET' | 'PATCH'): () => void {
    let release!: () => void
    holds[method].push(new Promise<void>((resolve) => { release = resolve }))
    return () => release()
  }
  const fetchFn = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const hold = holds[method]?.shift()
    if (method === 'PATCH' && input.startsWith('/api/multitable/views/')) {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      calls.push({ method, url: input, body })
      if (opts.holdPatch) await opts.holdPatch
      if (hold) await hold
      if (opts.patchStatus && opts.patchStatus >= 400) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'no' } }), { status: opts.patchStatus })
      }
      if ('groupInfo' in body) groupInfo = body.groupInfo as Record<string, unknown>
      return new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 })
    }
    if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${method} ${input}`)
    const url = new URL(input, 'http://metasheet.local')
    const offset = Number(url.searchParams.get('offset') ?? '0')
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const viewId = url.searchParams.get('viewId')
    calls.push({ method, url: input, offset, limit, viewId })
    const readGroupInfo = opts.groupInfoFor?.(viewId) ?? groupInfo
    if (hold) await hold
    const status = opts.getStatus?.() ?? 200
    if (status >= 400) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'down' } }), { status })
    }
    const rows: MetaRecord[] = []
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      rows.push({ id: `r${i}`, version: 1, data: { title: `Row ${i}`, [GROUP_FIELD]: `G${i % 3}` } })
    }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        fields: [
          { id: 'title', name: 'Title', type: 'string' },
          { id: GROUP_FIELD, name: 'Group', type: 'string' },
        ],
        rows,
        view: { id: viewId ?? 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [], groupInfo: readGroupInfo },
        page: { offset, limit, total, hasMore: offset + rows.length < total },
      },
    }), { status: 200 })
  })
  return { fetchFn, calls, holdNext, gets: () => calls.filter((c) => c.method === 'GET'), patches: () => calls.filter((c) => c.method === 'PATCH'), stored: () => groupInfo }
}

function ids(rows: MetaRecord[]): string[] {
  return rows.map((r) => r.id)
}
function range(from: number, to: number): string[] {
  const out: string[] = []
  for (let i = from; i < to; i++) out.push(`r${i}`)
  return out
}

async function loadedGrid(backend: ReturnType<typeof makeBackend>, extra: Partial<Parameters<typeof useMultitableGrid>[0]> = {}) {
  const grid = useMultitableGrid({
    sheetId: ref('s1'),
    viewId: ref('v1'),
    client: new MultitableApiClient({ fetchFn: backend.fetchFn }),
    ...extra,
  })
  await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
  await vi.waitFor(() => expect(grid.loading.value).toBe(false))
  return grid
}

function installMemoryStorage(): Record<string, string> {
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v) },
    removeItem: (k: string) => { delete store[k] },
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('grid paging across grouping changes (客户反馈 2026-10-21)', () => {
  it('the field sequence: 154 rows, group → 4 pages → page 4 → ungroup ⇒ page 1, 50 rows, pager math intact, scroll continues from row 50', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    expect(grid.rows.value).toHaveLength(50)

    await grid.setGroupFields([GROUP_FIELD])
    expect(backend.stored()).toEqual({ fieldIds: [GROUP_FIELD], fieldId: GROUP_FIELD })
    expect(grid.totalPages.value).toBe(4)
    expect(grid.currentPage.value).toBe(1)

    grid.goToPage(4)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(4))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(ids(grid.rows.value)).toEqual(range(150, 154))

    await grid.setGroupFields([])
    expect(backend.stored()).toEqual({})
    expect(grid.groupFieldIds.value).toEqual([])
    // Back on page 1 of the flat set: exactly one page of rows, starting at row 0.
    expect(grid.currentPage.value).toBe(1)
    expect(grid.totalPages.value).toBe(4)
    expect(grid.page.value.offset).toBe(0)
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    // The reload came AFTER the write (a read that overtook it would sync the old grouping back).
    const patchIndex = backend.calls.map((c) => c.method).lastIndexOf('PATCH')
    const lastGet = backend.calls.length - 1
    expect(backend.calls[lastGet]).toMatchObject({ method: 'GET', offset: 0 })
    expect(lastGet).toBeGreaterThan(patchIndex)

    // Scrolling on reaches every row, contiguously, with no duplicate.
    expect(grid.canLoadMore.value).toBe(true)
    await grid.loadMore()
    await grid.loadMore()
    await grid.loadMore()
    expect(ids(grid.rows.value)).toEqual(range(0, TOTAL))
  })

  it.each([2, 3])('ungrouping on page %i reloads page 1 instead of appending onto that page (was 100 mixed rows)', async (pageNo) => {
    const backend = makeBackend({ groupInfo: { fieldIds: [GROUP_FIELD], fieldId: GROUP_FIELD } })
    const grid = await loadedGrid(backend)
    expect(grid.groupFieldIds.value).toEqual([GROUP_FIELD])
    grid.goToPage(pageNo)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(pageNo))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))

    await grid.setGroupFields([])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    await grid.loadMore()
    expect(ids(grid.rows.value)).toEqual(range(0, 100))
  })

  it('grouping a flat grid that has scrolled in all 154 rows reloads page 1 (grouped page = 50 rows, not 154 under "1 / 4")', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    await grid.loadMore()
    await grid.loadMore()
    await grid.loadMore()
    expect(grid.rows.value).toHaveLength(TOTAL)

    await grid.setGroupFields([GROUP_FIELD])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    expect(grid.currentPage.value).toBe(1)
    expect(grid.totalPages.value).toBe(4)
  })

  it('changing the group column on page 3 returns to page 1', async () => {
    const backend = makeBackend({ groupInfo: { fieldIds: [GROUP_FIELD], fieldId: GROUP_FIELD } })
    const grid = await loadedGrid(backend)
    grid.goToPage(3)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))

    await grid.setGroupFields(['title'])
    expect(grid.groupFieldIds.value).toEqual(['title'])
    expect(grid.currentPage.value).toBe(1)
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })

  it('no extra read when the grid already holds exactly page 1, or when the grouping did not change', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    const before = backend.gets().length
    await grid.setGroupFields([GROUP_FIELD]) // page 1, 50 rows: already the grouped page-1 window
    expect(backend.gets().length).toBe(before)

    grid.goToPage(3)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    const onPage3 = backend.gets().length
    await grid.setGroupFields([GROUP_FIELD]) // same grouping re-sent: page 3 stays
    expect(backend.gets().length).toBe(onPage3)
    expect(grid.currentPage.value).toBe(3)
  })

  it('a refused grouping write still resets the page, and the grouping stays local as before', async () => {
    const backend = makeBackend({ patchStatus: 403 })
    const grid = await loadedGrid(backend)
    grid.goToPage(4)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(4))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))

    await grid.setGroupFields([GROUP_FIELD])
    expect(backend.stored()).toEqual({})
    expect(grid.currentPage.value).toBe(1)
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    expect(grid.groupFieldIds.value).toEqual([GROUP_FIELD])
  })

  it('a view switch while the grouping write is in flight leaves the new view where the viewer paged it', async () => {
    let release!: () => void
    const holdPatch = new Promise<void>((resolve) => { release = resolve })
    const backend = makeBackend({ holdPatch })
    const viewId = ref('v1')
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId, client: new MultitableApiClient({ fetchFn: backend.fetchFn }) })
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    grid.goToPage(4)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(4))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))

    const pending = grid.setGroupFields([GROUP_FIELD])
    viewId.value = 'v2'
    await vi.waitFor(() => expect(backend.gets().some((c) => c.viewId === 'v2')).toBe(true))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    grid.goToPage(3) // the viewer pages on in v2 while v1's write is still out
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    const v2Reads = backend.gets().filter((c) => c.viewId === 'v2').length
    release()
    await pending
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(grid.currentPage.value).toBe(3)
    expect(ids(grid.rows.value)).toEqual(range(100, 150))
    expect(backend.gets().filter((c) => c.viewId === 'v2')).toHaveLength(v2Reads)
  })

  it('a flat grid holding a later page (e.g. grouping removed elsewhere, then a reload) does not scroll-append onto it', async () => {
    const backend = makeBackend({ groupInfo: { fieldIds: [GROUP_FIELD], fieldId: GROUP_FIELD } })
    const grid = await loadedGrid(backend)
    grid.goToPage(3)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    // Another session clears the grouping; this grid's next reload of the current page syncs it.
    await backend.fetchFn('/api/multitable/views/v1', { method: 'PATCH', body: JSON.stringify({ groupInfo: {} }) })
    await grid.reloadCurrentPage()
    expect(grid.groupFieldIds.value).toEqual([])
    expect(grid.currentPage.value).toBe(3)
    expect(grid.page.value.hasMore).toBe(true)
    expect(grid.canLoadMore.value).toBe(false)
    const before = ids(grid.rows.value)
    await grid.loadMore()
    expect(ids(grid.rows.value)).toEqual(before)
  })

  // ── PR #6479 review: overlapping edits and an in-flight append ────────────────────────────────────────────────
  const G3 = { fieldIds: ['g1', 'g2', 'g3'], fieldId: 'g1' }

  async function onPage(grid: ReturnType<typeof useMultitableGrid>, n: number) {
    grid.goToPage(n)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(n))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
  }

  it('two quick edits, the older reload landing first: the screen ends on the newest grouping, as stored', async () => {
    const backend = makeBackend({ groupInfo: G3 })
    const grid = await loadedGrid(backend)
    await onPage(grid, 2)
    const releaseReload1 = backend.holdNext('GET')
    const edit1 = grid.setGroupFields(['g1', 'g2'])
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 0 }))
    const releasePatch2 = backend.holdNext('PATCH')
    const edit2 = grid.setGroupFields(['g1'])
    await vi.waitFor(() => expect(backend.patches()).toHaveLength(2))
    releaseReload1() // read before edit 2's write: it carries [g1, g2]
    await edit1
    releasePatch2()
    await edit2
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.stored()).toEqual({ fieldIds: ['g1'], fieldId: 'g1' })
    expect(grid.groupFieldIds.value).toEqual(['g1'])
    expect(grid.currentPage.value).toBe(1)
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })

  it('two quick edits, the older call settling last: it re-asserts the newest grouping, not its own', async () => {
    const backend = makeBackend({ groupInfo: G3 })
    const grid = await loadedGrid(backend)
    await onPage(grid, 2)
    const releaseReload1 = backend.holdNext('GET')
    const edit1 = grid.setGroupFields(['g1', 'g2'])
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 0 }))
    const edit2 = grid.setGroupFields(['g1']) // still on page 2 here, so it sends its own page-1 read
    await edit2
    expect(grid.groupFieldIds.value).toEqual(['g1'])
    releaseReload1() // superseded by edit 2's read; edit 1 settles now
    await edit1
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.stored()).toEqual({ fieldIds: ['g1'], fieldId: 'g1' })
    expect(grid.groupFieldIds.value).toEqual(['g1'])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })

  it('ungroup on page 3 then a quick regroup: the screen ends grouped as stored, not flat', async () => {
    const backend = makeBackend({ groupInfo: { fieldIds: ['g1'], fieldId: 'g1' } })
    const grid = await loadedGrid(backend)
    await onPage(grid, 3)
    const releaseReload1 = backend.holdNext('GET')
    const edit1 = grid.setGroupFields([])
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 0 }))
    const releasePatch2 = backend.holdNext('PATCH')
    const edit2 = grid.setGroupFields(['g2'])
    await vi.waitFor(() => expect(backend.patches()).toHaveLength(2))
    releaseReload1() // carries the cleared grouping
    await edit1
    releasePatch2()
    await edit2
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.stored()).toEqual({ fieldIds: ['g2'], fieldId: 'g2' })
    expect(grid.groupFieldIds.value).toEqual(['g2'])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })

  it('a view switch while the page-1 reload is out: the other view keeps its own grouping', async () => {
    const backend = makeBackend({ groupInfo: G3, groupInfoFor: (viewId) => (viewId === 'v2' ? { fieldIds: ['g2'], fieldId: 'g2' } : undefined) })
    const viewId = ref('v1')
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId, client: new MultitableApiClient({ fetchFn: backend.fetchFn }) })
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    await onPage(grid, 2)
    const releaseReload = backend.holdNext('GET')
    const edit = grid.setGroupFields(['g1'])
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 0, viewId: 'v1' }))
    viewId.value = 'v2'
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v2')).toBe(true))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(grid.groupFieldIds.value).toEqual(['g2'])
    releaseReload()
    await edit
    expect(grid.groupFieldIds.value).toEqual(['g2'])
  })

  it('grouping while a scroll-append is in flight drops that append: grouped page 1 is 50 rows, Next shows r50..r99 once', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    const releaseAppend = backend.holdNext('GET')
    const append = grid.loadMore()
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 50 }))
    await grid.setGroupFields([GROUP_FIELD])
    releaseAppend()
    await append
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    expect(grid.loadingMore.value).toBe(false)
    expect(grid.currentPage.value).toBe(1)
    expect(grid.totalPages.value).toBe(4)
    await onPage(grid, 2)
    expect(ids(grid.rows.value)).toEqual(range(50, 100))
  })
  // ── PR #6479 review round 2 ───────────────────────────────────────────────────────────────────────────────────
  it('append in flight → a reset in flight → a grouping pick: the reset still lands (no stuck loading), rows consistent', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    const releaseAppend = backend.holdNext('GET')
    const append = grid.loadMore()
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 50 }))
    const releaseReset = backend.holdNext('GET')
    const reset = grid.reloadCurrentPage()
    await vi.waitFor(() => expect(backend.gets()).toHaveLength(3))
    expect(grid.loading.value).toBe(true)
    const edit = grid.setGroupFields([GROUP_FIELD])
    releaseAppend()
    await append
    releaseReset()
    await reset
    await edit
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(grid.loadingMore.value).toBe(false)
    expect(grid.groupFieldIds.value).toEqual([GROUP_FIELD])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
    expect(grid.totalPages.value).toBe(4)
    await onPage(grid, 2)
    expect(ids(grid.rows.value)).toEqual(range(50, 100))
  })

  it('append in flight → a view switch → a grouping pick: the new view still loads and its state is known', async () => {
    const backend = makeBackend()
    const viewId = ref('v1')
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId, client: new MultitableApiClient({ fetchFn: backend.fetchFn }) })
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    const releaseAppend = backend.holdNext('GET')
    const append = grid.loadMore()
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 50 }))
    const releaseSwitch = backend.holdNext('GET')
    viewId.value = 'v2'
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ viewId: 'v2' }))
    const edit = grid.setGroupFields([GROUP_FIELD])
    releaseAppend()
    await append
    releaseSwitch()
    await edit
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(grid.isViewStateLoadedFor('v2')).toBe(true)
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })

  it('a reset that superseded an append and then fails does not leave scrolling blocked', async () => {
    let status = 200
    const backend = makeBackend({ getStatus: () => status })
    const grid = await loadedGrid(backend)
    const releaseAppend = backend.holdNext('GET')
    const append = grid.loadMore()
    await vi.waitFor(() => expect(backend.gets().at(-1)).toMatchObject({ offset: 50 }))
    const releaseReset = backend.holdNext('GET')
    const reset = grid.reloadCurrentPage()
    await vi.waitFor(() => expect(backend.gets()).toHaveLength(3))
    status = 500
    releaseReset()
    await reset
    expect(grid.error.value).toBeTruthy()
    status = 200
    releaseAppend()
    await append
    expect(grid.loading.value).toBe(false)
    expect(grid.loadingMore.value).toBe(false)
    expect(grid.canLoadMore.value).toBe(true)
    await grid.loadMore()
    expect(ids(grid.rows.value)).toEqual(range(0, 100))
  })

  it.each([
    ['the page-1 reload answering at once', false],
    ['the page-1 reload held until every write is in', true],
  ])('three overlapping edits, the first write slow: the server commits them in order, stored = screen = newest (%s)', async (_label, holdReload) => {
    const backend = makeBackend({ groupInfo: G3 })
    const grid = await loadedGrid(backend)
    await onPage(grid, 2)
    const releasePatch1 = backend.holdNext('PATCH')
    const releaseReload = holdReload ? backend.holdNext('GET') : () => undefined
    const edit1 = grid.setGroupFields(['g1', 'g2'])
    const edit2 = grid.setGroupFields(['g1'])
    const edit3 = grid.setGroupFields(['g2'])
    await vi.waitFor(() => expect(backend.patches()).toHaveLength(1))
    releasePatch1()
    await vi.waitFor(() => expect(backend.patches()).toHaveLength(3))
    releaseReload()
    await Promise.all([edit1, edit2, edit3])
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.patches().map((c) => (c.body?.groupInfo as { fieldIds?: string[] }).fieldIds)).toEqual([['g1', 'g2'], ['g1'], ['g2']])
    expect(backend.stored()).toEqual({ fieldIds: ['g2'], fieldId: 'g2' })
    expect(grid.groupFieldIds.value).toEqual(['g2'])
    // A later reload reads the stored grouping: the screen does not flip.
    await grid.reloadCurrentPage()
    expect(grid.groupFieldIds.value).toEqual(['g2'])
    expect(ids(grid.rows.value)).toEqual(range(0, 50))
  })
})

describe('rows-per-page choice (客户反馈 2026-10-21)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('clampGridPageSize snaps into 50 / 100 / 200 / 500', () => {
    expect([...GRID_PAGE_SIZE_OPTIONS]).toEqual([50, 100, 200, 500])
    expect(clampGridPageSize(50)).toBe(50)
    expect(clampGridPageSize(100)).toBe(100)
    expect(clampGridPageSize(120)).toBe(100)
    expect(clampGridPageSize('200')).toBe(200)
    expect(clampGridPageSize(9999)).toBe(500)
    expect(clampGridPageSize(10)).toBe(50)
    expect(clampGridPageSize(-1)).toBe(50)
    expect(clampGridPageSize('abc')).toBe(50)
    expect(clampGridPageSize(Number.NaN)).toBe(50)
    expect(clampGridPageSize(Number.POSITIVE_INFINITY)).toBe(50)
    expect(clampGridPageSize(null)).toBe(50)
    expect(clampGridPageSize('')).toBe(50)
  })

  it('storage is per user + sheet, written clamped, read clamped, and never throws', () => {
    const store = installMemoryStorage()
    writeGridPageSize('u1', 's1', 200)
    writeGridPageSize('u1', 's2', 333)
    expect(store[gridPageSizeStorageKey('u1', 's1')]).toBe('200')
    expect(store[gridPageSizeStorageKey('u1', 's2')]).toBe('200')
    expect(readGridPageSize('u1', 's1')).toBe(200)
    expect(readGridPageSize('u2', 's1')).toBeNull()
    expect(readGridPageSize(null, 's1')).toBeNull()
    expect(readGridPageSize('u1', '')).toBeNull()
    store[gridPageSizeStorageKey('u1', 's3')] = '120'
    expect(readGridPageSize('u1', 's3')).toBe(100)
    store[gridPageSizeStorageKey('u1', 's4')] = 'garbage'
    expect(readGridPageSize('u1', 's4')).toBe(50)

    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => undefined,
    })
    expect(readGridPageSize('u1', 's1')).toBeNull()
    expect(() => writeGridPageSize('u1', 's1', 100)).not.toThrow()
  })

  it('setPageSize from page 3 reloads page 1 at the new size; totals follow the size', async () => {
    const backend = makeBackend({ groupInfo: { fieldIds: [GROUP_FIELD], fieldId: GROUP_FIELD } })
    const grid = await loadedGrid(backend)
    grid.goToPage(3)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))

    await grid.setPageSize(100)
    expect(grid.pageSize.value).toBe(100)
    expect(backend.gets().at(-1)).toMatchObject({ offset: 0, limit: 100 })
    expect(grid.currentPage.value).toBe(1)
    expect(grid.totalPages.value).toBe(2)
    expect(ids(grid.rows.value)).toEqual(range(0, 100))

    grid.goToPage(2)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(2))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(ids(grid.rows.value)).toEqual(range(100, TOTAL))
  })

  it('a failed read after setPageSize keeps the size, the page and its rows (no page-2 rows under "1 / 1")', async () => {
    let status = 200
    const backend = makeBackend({ getStatus: () => status })
    const grid = await loadedGrid(backend)
    grid.goToPage(2)
    await vi.waitFor(() => expect(grid.currentPage.value).toBe(2))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    status = 500
    await grid.setPageSize(500)
    expect(grid.error.value).toBeTruthy()
    expect(grid.pageSize.value).toBe(50)
    expect(grid.currentPage.value).toBe(2)
    expect(grid.totalPages.value).toBe(4)
    expect(ids(grid.rows.value)).toEqual(range(50, 100))
    status = 200
    await grid.setPageSize(500)
    expect(grid.pageSize.value).toBe(500)
    expect(grid.currentPage.value).toBe(1)
    expect(grid.rows.value).toHaveLength(TOTAL)
  })

  it('setPageSize snaps an off-list size; the same size is a no-op (no reload)', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    const before = backend.gets().length
    await grid.setPageSize(75)
    expect(grid.pageSize.value).toBe(50)
    expect(backend.gets().length).toBe(before)
    await grid.setPageSize(100000)
    expect(grid.pageSize.value).toBe(500)
    expect(backend.gets().at(-1)).toMatchObject({ offset: 0, limit: 500 })
    expect(grid.rows.value).toHaveLength(TOTAL)
    expect(grid.totalPages.value).toBe(1)
  })

  it('the stored size is restored (clamped) on the first load and re-resolved per sheet', async () => {
    const store = installMemoryStorage()
    store[gridPageSizeStorageKey('u1', 's1')] = '200'
    store[gridPageSizeStorageKey('u1', 's2')] = '777'
    const backend = makeBackend()
    const sheetId = ref('s1')
    const grid = useMultitableGrid({
      sheetId,
      viewId: ref('v1'),
      client: new MultitableApiClient({ fetchFn: backend.fetchFn }),
      resolvePageSize: (sid) => readGridPageSize('u1', sid),
    })
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.gets()[0]).toMatchObject({ offset: 0, limit: 200 })
    expect(grid.pageSize.value).toBe(200)
    expect(grid.totalPages.value).toBe(1)

    sheetId.value = 's2'
    await vi.waitFor(() => expect(backend.gets().length).toBe(2))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.gets()[1]).toMatchObject({ offset: 0, limit: 500 })

    sheetId.value = 's3' // nothing stored ⇒ default
    await vi.waitFor(() => expect(backend.gets().length).toBe(3))
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    expect(backend.gets()[2]).toMatchObject({ offset: 0, limit: 50 })
  })

  it('a size picked on this sheet is not overridden by the next reload of the same sheet', async () => {
    installMemoryStorage()
    const backend = makeBackend()
    const grid = await loadedGrid(backend, { resolvePageSize: () => null })
    await grid.setPageSize(200)
    await grid.reloadCurrentPage()
    expect(grid.pageSize.value).toBe(200)
    expect(backend.gets().at(-1)).toMatchObject({ limit: 200 })
  })
})

// ── MetaGridTable footer: pager visibility + the rows-per-page select ────────────────────────────────────────────
let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [{ id: 'title', name: 'Title', type: 'string' }]

function mountGrid(props: Record<string, unknown>): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    render() {
      return h(MetaGridTable, {
        rows: [{ id: 'r0', version: 1, data: { title: 'Row 0' } }],
        visibleFields: FIELDS,
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        selectedRecordId: null,
        canEdit: false,
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

describe('MetaGridTable footer (客户反馈 2026-10-21)', () => {
  it('flat path past page 1 keeps the pager (the page-4 case); flat page 1 still scrolls without it; grouped always has it', async () => {
    let root = mountGrid({ infiniteScroll: true, currentPage: 4, totalPages: 4 })
    await nextTick()
    expect(root.querySelector('.meta-grid__pagination')).not.toBeNull()
    expect(root.querySelector('.meta-grid__page-info')?.textContent?.trim()).toBe('4 / 4')
    app!.unmount(); container!.remove()

    root = mountGrid({ infiniteScroll: true, currentPage: 1, totalPages: 4 })
    await nextTick()
    expect(root.querySelector('.meta-grid__page-info')).toBeNull()
    app!.unmount(); container!.remove()

    root = mountGrid({ infiniteScroll: false, currentPage: 2, totalPages: 4 })
    await nextTick()
    expect(root.querySelector('.meta-grid__page-info')?.textContent?.trim()).toBe('2 / 4')
  })

  it('renders the rows-per-page select with the offered sizes and emits the picked one', async () => {
    const onSetPageSize = vi.fn()
    const root = mountGrid({ infiniteScroll: false, currentPage: 1, totalPages: 4, pageSize: 50, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS, onSetPageSize })
    await nextTick()
    const select = root.querySelector('[data-testid="grid-page-size-select"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['50', '100', '200', '500'])
    expect(select.value).toBe('50')
    expect(select.getAttribute('aria-label')).toBe('Rows per page')
    select.value = '200'
    select.dispatchEvent(new Event('change'))
    expect(onSetPageSize).toHaveBeenCalledWith(200)
  })

  it('keeps the select when everything fits on one page at a non-default size (so it can be changed back); none without options or at default on one page', async () => {
    let root = mountGrid({ totalPages: 1, pageSize: 200, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('[data-testid="grid-page-size-select"]')).not.toBeNull()
    expect(root.querySelector('.meta-grid__page-info')).toBeNull()
    app!.unmount(); container!.remove()

    root = mountGrid({ totalPages: 1, pageSize: 50, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('.meta-grid__pagination')).toBeNull()
    app!.unmount(); container!.remove()

    root = mountGrid({ infiniteScroll: false, totalPages: 4, currentPage: 1 })
    await nextTick()
    expect(root.querySelector('[data-testid="grid-page-size-select"]')).toBeNull()
    expect(root.querySelector('.meta-grid__page-info')).not.toBeNull()
  })

  it('zh label and aria label', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ totalPages: 4, pageSize: 100, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('.meta-grid__page-size-label')?.textContent?.trim()).toBe('每页行数')
    expect(root.querySelector('[data-testid="grid-page-size-select"]')?.getAttribute('aria-label')).toBe('每页显示的行数')
  })
})

// ── 客户反馈 2026-10-27 (R74): 「每页行数 能否新增 跳转到 行」 ─────────────────────────────────────────────────────
// The footer gets 「跳转到第 [ ] 行」. Row N is the number in the row-number column (server order on the flat path,
// visible order on the grouped path). A loaded row is focused and selected without a request; a row that is not
// loaded asks for its page (go-to-page, ceil(N / pageSize)) and is focused once that page lands.
function makeRows(from: number, to: number, prefix = 'r'): MetaRecord[] {
  const out: MetaRecord[] = []
  for (let i = from; i < to; i++) out.push({ id: `${prefix}${i}`, version: 1, data: { title: `Row ${i}` } })
  return out
}

function jumpTo(root: HTMLElement, value: string, via: 'enter' | 'button' = 'enter'): void {
  const input = root.querySelector('[data-testid="grid-row-jump-input"]') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
  if (via === 'enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  else (root.querySelector('[data-testid="grid-row-jump-go"]') as HTMLButtonElement).click()
}

function focusedRowNumber(root: HTMLElement): string | null {
  return root.querySelector('tr.meta-grid__row--focused .meta-grid__row-num span')?.textContent?.trim() ?? null
}

describe('MetaGridTable footer row jump (客户反馈 2026-10-27)', () => {
  it('shows on the flat page 1 without the pager when there is more than one row; hidden at one row or without a total', async () => {
    let root = mountGrid({ infiniteScroll: true, currentPage: 1, totalPages: 4, totalRows: 200, pageSize: 50, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('.meta-grid__page-info')).toBeNull()
    expect(root.querySelector('[data-testid="grid-row-jump-input"]')).not.toBeNull()
    expect(root.querySelector('.meta-grid__row-jump-label')?.textContent?.trim()).toBe('Go to row')
    expect(root.querySelector('[data-testid="grid-row-jump-go"]')?.textContent?.trim()).toBe('Go')
    expect(root.querySelector('[data-testid="grid-row-jump-input"]')?.getAttribute('aria-label')).toBe('Row number to go to')
    app!.unmount(); container!.remove()

    // One row in total and the default size: nothing to jump to, no footer at all.
    root = mountGrid({ infiniteScroll: true, totalPages: 1, totalRows: 1, pageSize: 50, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('[data-testid="grid-row-jump-input"]')).toBeNull()
    expect(root.querySelector('.meta-grid__pagination')).toBeNull()
    app!.unmount(); container!.remove()

    // Mounts that do not pass a total (other hosts of the grid) keep exactly the old footer.
    root = mountGrid({ infiniteScroll: true, totalPages: 4, pageSize: 50, pageSizeOptions: GRID_PAGE_SIZE_OPTIONS })
    await nextTick()
    expect(root.querySelector('[data-testid="grid-row-jump-input"]')).toBeNull()
  })

  it('a loaded row is focused and selected with no page request (Enter and the Go button)', async () => {
    const onGoToPage = vi.fn()
    const onSelectRecord = vi.fn()
    const root = mountGrid({ rows: makeRows(0, 10), infiniteScroll: true, totalPages: 4, totalRows: 200, pageSize: 50, onGoToPage, onSelectRecord })
    await nextTick()
    jumpTo(root, '5')
    await nextTick()
    expect(onGoToPage).not.toHaveBeenCalled()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r4')
    expect(focusedRowNumber(root)).toBe('5')

    jumpTo(root, '9', 'button')
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r8')
    expect(focusedRowNumber(root)).toBe('9')
    expect(root.querySelector('[data-testid="grid-row-jump-hint"]')).toBeNull()
  })

  it('clamps: 0 and negatives go to row 1, past the total goes to the last row with a 共 M 行 hint, decimals truncate, non-numbers do nothing', async () => {
    const onGoToPage = vi.fn()
    const onSelectRecord = vi.fn()
    const root = mountGrid({ rows: makeRows(0, 10), infiniteScroll: true, totalPages: 4, totalRows: 200, pageSize: 50, onGoToPage, onSelectRecord })
    await nextTick()

    jumpTo(root, '0')
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r0')
    expect(root.querySelector('[data-testid="grid-row-jump-hint"]')?.textContent?.trim()).toBe('200 rows in total')

    jumpTo(root, '-7')
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r0')

    jumpTo(root, '3.9')
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r2')
    expect(root.querySelector('[data-testid="grid-row-jump-hint"]')).toBeNull()

    onSelectRecord.mockClear()
    jumpTo(root, 'abc')
    jumpTo(root, '')
    await nextTick()
    expect(onSelectRecord).not.toHaveBeenCalled()
    expect(onGoToPage).not.toHaveBeenCalled()

    // 5000 > 200 rows: row 200 is on page 4, which is not loaded.
    jumpTo(root, '5000')
    await nextTick()
    expect(onGoToPage).toHaveBeenCalledWith(4)
    expect(root.querySelector('[data-testid="grid-row-jump-hint"]')?.textContent?.trim()).toBe('200 rows in total')
  })

  it('a row that is not loaded asks for its page and is focused when that page lands; a sheet/view change in between cancels', async () => {
    const rows = ref<MetaRecord[]>(makeRows(0, 50))
    const startIndex = ref(0)
    const currentPage = ref(1)
    const loading = ref(false)
    const contextKey = ref('["s1","v1"]')
    const onGoToPage = vi.fn()
    const onSelectRecord = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: rows.value, visibleFields: FIELDS, sortRules: [], loading: loading.value,
          currentPage: currentPage.value, totalPages: 20, startIndex: startIndex.value, canEdit: false,
          infiniteScroll: true, totalRows: 1000, pageSize: 50, rangeContextKey: contextKey.value,
          onGoToPage, onSelectRecord,
        })
      },
    })
    app.mount(container)
    await nextTick()

    jumpTo(container, '120')
    await nextTick()
    expect(onGoToPage).toHaveBeenCalledWith(3)
    expect(onSelectRecord).not.toHaveBeenCalled()
    // The page load: loading first, then the page-3 rows (row numbers 101..150).
    loading.value = true
    await nextTick()
    rows.value = makeRows(100, 150)
    startIndex.value = 100
    currentPage.value = 3
    loading.value = false
    await nextTick()
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r119')
    expect(focusedRowNumber(container)).toBe('120')

    // A second jump to page 1; the sheet/view changes before the rows land → nothing is focused afterwards.
    onSelectRecord.mockClear()
    jumpTo(container, '7')
    await nextTick()
    expect(onGoToPage).toHaveBeenLastCalledWith(1)
    contextKey.value = '["s2","v9"]'
    await nextTick()
    rows.value = makeRows(0, 50, 'other')
    startIndex.value = 0
    currentPage.value = 1
    await nextTick()
    await nextTick()
    expect(onSelectRecord).not.toHaveBeenCalled()
  })

  it('a load that ends without the target clears the pending jump (a later reload does not jump)', async () => {
    const rows = ref<MetaRecord[]>(makeRows(0, 50))
    const startIndex = ref(0)
    const loading = ref(false)
    const onGoToPage = vi.fn()
    const onSelectRecord = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: rows.value, visibleFields: FIELDS, sortRules: [], loading: loading.value,
          currentPage: 1, totalPages: 20, startIndex: startIndex.value, canEdit: false,
          infiniteScroll: true, totalRows: 1000, pageSize: 50, onGoToPage, onSelectRecord,
        })
      },
    })
    app.mount(container)
    await nextTick()
    jumpTo(container, '120')
    await nextTick()
    expect(onGoToPage).toHaveBeenCalledWith(3)
    // The load failed: loading flips back with the same rows.
    loading.value = true
    await nextTick()
    loading.value = false
    await nextTick()
    // A later reload that happens to bring page 3 must not focus anything.
    rows.value = makeRows(100, 150)
    startIndex.value = 100
    await nextTick()
    await nextTick()
    expect(onSelectRecord).not.toHaveBeenCalled()
  })

  it('end to end with the real composable: jumping to row 120 on a flat 154-row sheet loads page 3 and focuses row 120', async () => {
    const backend = makeBackend()
    const grid = await loadedGrid(backend)
    const onSelectRecord = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render() {
        return h(MetaGridTable, {
          rows: grid.rows.value, visibleFields: FIELDS, sortRules: [], loading: grid.loading.value,
          currentPage: grid.currentPage.value, totalPages: grid.totalPages.value, startIndex: grid.page.value.offset,
          canEdit: false, infiniteScroll: true, totalRows: grid.page.value.total, pageSize: grid.pageSize.value,
          onGoToPage: grid.goToPage, onSelectRecord,
        })
      },
    })
    app.mount(container)
    await nextTick()
    expect(ids(grid.rows.value)).toEqual(range(0, 50))

    jumpTo(container, '120')
    await vi.waitFor(() => expect(onSelectRecord).toHaveBeenCalledWith('r119'))
    expect(backend.gets().at(-1)).toMatchObject({ offset: 100, limit: 50 })
    await nextTick()
    expect(focusedRowNumber(container)).toBe('120')
    // The flat grid now holds page 3, so it shows the pager (the 2026-10-21 rule) until page 1.
    expect(container.querySelector('.meta-grid__page-info')?.textContent?.trim()).toBe('3 / 4')
  })

  it('grouped: row N is the visible row number; a loaded one is focused', async () => {
    const onSelectRecord = vi.fn()
    const rows: MetaRecord[] = makeRows(0, 6).map((r, i) => ({ ...r, data: { ...r.data, grp: i % 2 === 0 ? 'A' : 'B' } }))
    const root = mountGrid({
      rows, groupFields: [{ id: 'grp', name: 'Group', type: 'string' }], totalPages: 1, totalRows: 6, pageSize: 50, onSelectRecord,
    })
    await nextTick()
    // Visible order: A → r0, r2, r4; B → r1, r3, r5. Row 4 is r1.
    jumpTo(root, '4')
    await nextTick()
    expect(onSelectRecord).toHaveBeenLastCalledWith('r1')
    expect(focusedRowNumber(root)).toBe('4')
  })

  it('zh labels: 跳转到第 [ ] 行, 前往, 共 M 行', async () => {
    useLocale().setLocale('zh-CN')
    const root = mountGrid({ rows: makeRows(0, 10), infiniteScroll: true, totalPages: 4, totalRows: 200, pageSize: 50, onGoToPage: vi.fn() })
    await nextTick()
    expect(root.querySelector('.meta-grid__row-jump-label')?.textContent?.trim()).toBe('跳转到第')
    expect(root.querySelector('.meta-grid__row-jump-suffix')?.textContent?.trim()).toBe('行')
    expect(root.querySelector('[data-testid="grid-row-jump-go"]')?.textContent?.trim()).toBe('前往')
    expect(root.querySelector('[data-testid="grid-row-jump-input"]')?.getAttribute('aria-label')).toBe('要跳转到的行号')
    jumpTo(root, '999')
    await nextTick()
    expect(root.querySelector('[data-testid="grid-row-jump-hint"]')?.textContent?.trim()).toBe('共 200 行')
  })
})
