import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import {
  useMultitableGrid,
  buildSortInfo,
  buildFilterInfo,
  buildFilterInfoFromNodes,
  parseFilterTree,
  isFilterGroup,
  FILTER_OPERATORS_BY_TYPE,
  resolveCreateRecordContext,
  type SortRule,
  type FilterRule,
  type FilterNode,
  type FilterGroup,
} from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

type PatchRequestBody = {
  partialSuccess?: boolean
  changes: Array<{
    recordId: string
    fieldId?: string
    value?: unknown
    expectedVersion?: number
  }>
}

function createMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
  })
}

describe('useMultitableGrid', () => {
  let client: MultitableApiClient

  beforeEach(() => {
    useLocale().setLocale('en')
    client = createMockClient()
  })

  it('initializes with empty state', () => {
    const grid = useMultitableGrid({ sheetId: ref(''), viewId: ref(''), client })
    expect(grid.rows.value).toEqual([])
    expect(grid.fields.value).toEqual([])
    expect(grid.loading.value).toBe(false)
    expect(grid.currentPage.value).toBe(1)
  })

  it('computes visible fields excluding hidden', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.fields.value = [{ id: 'f1', name: 'A', type: 'string' }, { id: 'f2', name: 'B', type: 'number' }, { id: 'f3', name: 'C', type: 'boolean' }]
    grid.hiddenFieldIds.value = ['f2']
    expect(grid.visibleFields.value.map((f) => f.id)).toEqual(['f1', 'f3'])
  })

  it('excludes fields hidden by scoped permissions from visible fields', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.fields.value = [{ id: 'f1', name: 'A', type: 'string' }, { id: 'f2', name: 'B', type: 'number' }]
    grid.fieldPermissions.value = {
      f1: { visible: true, readOnly: false },
      f2: { visible: false, readOnly: false },
    }

    expect(grid.visibleFields.value.map((f) => f.id)).toEqual(['f1'])
  })

  it('excludes property-hidden fields even when scoped permissions are missing', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.fields.value = [
      { id: 'f1', name: 'A', type: 'string' },
      { id: 'f2', name: 'Secret', type: 'string', property: { hidden: true } },
      { id: 'f3', name: 'View Hidden', type: 'string' },
    ]
    grid.hiddenFieldIds.value = ['f3']

    expect(grid.visibleFields.value.map((f) => f.id)).toEqual(['f1'])
  })

  it('loads initial view data when sheetId/viewId are preselected', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          fields: [{ id: 'f1', name: 'Title', type: 'string' }],
          rows: [{ id: 'r1', version: 1, data: { f1: 'Ship pilot' } }],
          view: { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [] },
          meta: {
            capabilityOrigin: {
              source: 'sheet-scope',
              hasSheetAssignments: true,
            },
          },
          page: { offset: 0, limit: 50, total: 1, hasMore: false },
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref('s1'),
      viewId: ref('v1'),
      client: new MultitableApiClient({ fetchFn }),
    })

    await nextTick()
    await vi.waitFor(() => {
      expect(grid.rows.value).toHaveLength(1)
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn.mock.calls[0]?.[0]).toContain('/api/multitable/view?sheetId=s1&viewId=v1')
    expect(grid.rows.value).toEqual([{ id: 'r1', version: 1, data: { f1: 'Ship pilot' } }])
    expect(grid.fields.value).toEqual([{ id: 'f1', name: 'Title', type: 'string' }])
    expect(grid.capabilityOrigin.value).toEqual({
      source: 'sheet-scope',
      hasSheetAssignments: true,
    })
  })

  it('ignores stale load responses and keeps the latest page data', async () => {
    let resolveFirst: ((value: Response) => void) | null = null
    let resolveSecond: ((value: Response) => void) | null = null
    const fetchFn = vi.fn((input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      return new Promise<Response>((resolve) => {
        if (!resolveFirst) {
          resolveFirst = resolve
          return
        }
        resolveSecond = resolve
      })
    })

    const grid = useMultitableGrid({
      sheetId: ref('s1'),
      viewId: ref('v1'),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.loadViewData(50)

    resolveSecond?.(new Response(JSON.stringify({
      ok: true,
      data: {
        fields: [{ id: 'f1', name: 'Title', type: 'string' }],
        rows: [{ id: 'r2', version: 2, data: { f1: 'latest page' } }],
        page: { offset: 50, limit: 50, total: 100, hasMore: false },
      },
    }), { status: 200 }))
    await nextTick()
    await nextTick()

    resolveFirst?.(new Response(JSON.stringify({
      ok: true,
      data: {
        fields: [{ id: 'f1', name: 'Title', type: 'string' }],
        rows: [{ id: 'r1', version: 1, data: { f1: 'stale page' } }],
        page: { offset: 0, limit: 50, total: 100, hasMore: true },
      },
    }), { status: 200 }))
    await vi.waitFor(() => {
      expect(grid.rows.value).toEqual([{ id: 'r2', version: 2, data: { f1: 'latest page' } }])
    })

    expect(grid.page.value.offset).toBe(50)
  })

  it('toggle field visibility', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.toggleFieldVisibility('f1')
    expect(grid.hiddenFieldIds.value).toContain('f1')
    grid.toggleFieldVisibility('f1')
    expect(grid.hiddenFieldIds.value).not.toContain('f1')
  })

  it('manages sort rules (add/update/remove)', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.addSortRule({ fieldId: 'f1', direction: 'asc' })
    expect(grid.sortRules.value).toHaveLength(1)
    grid.addSortRule({ fieldId: 'f1', direction: 'desc' })
    expect(grid.sortRules.value).toHaveLength(1)
    expect(grid.sortRules.value[0].direction).toBe('desc')
    grid.removeSortRule('f1')
    expect(grid.sortRules.value).toHaveLength(0)
  })

  it('manages filter rules', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.addFilterRule({ fieldId: 'f1', operator: 'is', value: 'x' })
    expect(grid.filterRules.value).toHaveLength(1)
    grid.removeFilterRule(0)
    expect(grid.filterRules.value).toHaveLength(0)
  })

  it('computes pagination', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client, pageSize: 10 })
    grid.page.value = { offset: 20, limit: 10, total: 55, hasMore: true }
    expect(grid.currentPage.value).toBe(3)
    expect(grid.totalPages.value).toBe(6)
  })

  // ── A1 infinite-scroll accumulation (the ACTIVATION of the grid windowing) ─────────────────────────
  describe('A1 infinite-scroll accumulation (loadMore)', () => {
    // A paginated /view backend: `total` rows served in `pageSize` chunks keyed by the offset query
    // param. Returns a per-row link summary so we can assert the summary maps MERGE (never replace).
    function makePaginatedViewFetch(total: number, pageSize: number) {
      const calls: Array<{ offset: number; limit: number; search: string | null }> = []
      const fetchFn = vi.fn(async (input: string) => {
        if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
        const url = new URL(input, 'http://metasheet.local')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        const limit = Number(url.searchParams.get('limit') ?? String(pageSize))
        const search = url.searchParams.get('search')
        calls.push({ offset, limit, search })
        const slice: Array<{ id: string; version: number; data: Record<string, unknown> }> = []
        const linkSummaries: Record<string, Record<string, Array<{ id: string; display: string }>>> = {}
        for (let i = offset; i < Math.min(offset + limit, total); i++) {
          slice.push({ id: `r${i}`, version: 1, data: { title: `Row ${i}` } })
          linkSummaries[`r${i}`] = { link: [{ id: `l${i}`, display: `Link ${i}` }] }
        }
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'title', name: 'Title', type: 'string' }],
            rows: slice,
            linkSummaries,
            view: { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [] },
            page: { offset, limit, total, hasMore: offset + slice.length < total },
          },
        }), { status: 200 })
      })
      return { fetchFn, calls }
    }

    it('appends the next page on loadMore (rows grow past one page → windowing can engage)', async () => {
      const { fetchFn, calls } = makePaginatedViewFetch(200, 50)
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })

      // initial page-1 load (offset 0, 50 rows)
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))
      expect(grid.page.value.hasMore).toBe(true)
      expect(grid.canLoadMore.value).toBe(true)
      // offset pinned at 0 on the infinite path (not bumped to 50) so row numbers + mutation reloads behave
      expect(grid.page.value.offset).toBe(0)

      // scroll-append → next page fetched at offset = accumulated count (50), APPENDED
      await grid.loadMore()
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(100))
      // crossed the 60-row windowing threshold → the grid now holds enough rows for the DOM windowing
      expect(grid.rows.value.length).toBeGreaterThan(60)
      expect(calls.map((c) => c.offset)).toEqual([0, 50])
      // earlier page's rows are still present (append, not replace)
      expect(grid.rows.value[0]?.id).toBe('r0')
      expect(grid.rows.value[99]?.id).toBe('r99')
      // summary maps MERGED across pages (page-1 + page-2 link summaries both present)
      expect(grid.linkSummaries.value.r0?.link?.[0]?.display).toBe('Link 0')
      expect(grid.linkSummaries.value.r99?.link?.[0]?.display).toBe('Link 99')
      expect(grid.page.value.offset).toBe(0) // still pinned
    })

    it('stops fetching at end-of-data (hasMore=false → loadMore is a no-op)', async () => {
      const { fetchFn, calls } = makePaginatedViewFetch(120, 50)
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))

      await grid.loadMore() // offset 50 → rows 50..99
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(100))
      await grid.loadMore() // offset 100 → rows 100..119 (last, short page)
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(120))
      expect(grid.page.value.hasMore).toBe(false)
      expect(grid.canLoadMore.value).toBe(false)

      // further loadMore does nothing (no fetch beyond the three pages)
      await grid.loadMore()
      await grid.loadMore()
      expect(calls.map((c) => c.offset)).toEqual([0, 50, 100])
      expect(grid.rows.value).toHaveLength(120)
    })

    it('dedups overlapping loadMore (rapid scroll) into a single fetch', async () => {
      // first /view load resolves immediately; subsequent (append) /view loads are gated so two rapid
      // loadMore() calls overlap in flight.
      let firstResolved = false
      let releaseAppend: (() => void) | null = null
      const appendFetches: number[] = []
      const fetchFn = vi.fn((input: string) => {
        const url = new URL(input, 'http://metasheet.local')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        if (!firstResolved) {
          firstResolved = true
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            data: {
              fields: [{ id: 'title', name: 'Title', type: 'string' }],
              rows: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, version: 1, data: {} })),
              view: { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [] },
              page: { offset: 0, limit: 50, total: 500, hasMore: true },
            },
          }), { status: 200 }))
        }
        appendFetches.push(offset)
        return new Promise<Response>((resolve) => {
          releaseAppend = () => resolve(new Response(JSON.stringify({
            ok: true,
            data: {
              rows: Array.from({ length: 50 }, (_, i) => ({ id: `r${offset + i}`, version: 1, data: {} })),
              page: { offset, limit: 50, total: 500, hasMore: true },
            },
          }), { status: 200 }))
        })
      })
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))

      // fire two loadMore() back-to-back; the second must bail (loadingMore in-flight) → ONE append fetch
      const p1 = grid.loadMore()
      const p2 = grid.loadMore()
      expect(appendFetches).toHaveLength(1)
      expect(appendFetches[0]).toBe(50)
      releaseAppend?.()
      await Promise.all([p1, p2])
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(100))
      // still exactly one append fetch happened
      expect(appendFetches).toHaveLength(1)
    })

    it('a filter/sort change while an append is in flight RESETS (refetch offset 0, replace) and the stale append is dropped', async () => {
      let releaseAppend: ((rows: unknown[]) => void) | null = null
      const offsets: number[] = []
      const fetchFn = vi.fn((input: string) => {
        const url = new URL(input, 'http://metasheet.local')
        const offset = Number(url.searchParams.get('offset') ?? '0')
        const search = url.searchParams.get('search')
        offsets.push(offset)
        // The in-flight APPEND (offset 50, no search) is held until we release it AFTER the reset.
        if (offset === 50 && !search) {
          return new Promise<Response>((resolve) => {
            releaseAppend = (rows) => resolve(new Response(JSON.stringify({
              ok: true,
              data: { rows, page: { offset: 50, limit: 50, total: 500, hasMore: true } },
            }), { status: 200 }))
          })
        }
        // page-1 loads (offset 0): the initial one, and the post-filter RESET one (with search).
        return Promise.resolve(new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'title', name: 'Title', type: 'string' }],
            rows: search
              ? [{ id: 'f0', version: 1, data: { title: 'filtered' } }] // reset result (1 filtered row)
              : Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, version: 1, data: {} })),
            view: { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [] },
            page: { offset: 0, limit: 50, total: search ? 1 : 500, hasMore: !search },
          },
        }), { status: 200 }))
      })
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))

      // start an append (held in flight at offset 50)
      const appendPromise = grid.loadMore()
      await vi.waitFor(() => expect(offsets).toContain(50))

      // ...meanwhile a search change RESETS: refetch offset 0 (with search) and REPLACE rows
      grid.setSearchQuery('zzz')
      await vi.waitFor(() => expect(grid.rows.value).toEqual([{ id: 'f0', version: 1, data: { title: 'filtered' } }]))

      // now release the STALE append; it must be DROPPED (post-await request-id guard) — never appended
      releaseAppend?.(Array.from({ length: 50 }, (_, i) => ({ id: `stale${i}`, version: 1, data: {} })))
      await appendPromise
      await nextTick()
      // the freshly-filtered single row stands; no cross-filter rows mixed in
      expect(grid.rows.value).toEqual([{ id: 'f0', version: 1, data: { title: 'filtered' } }])
      expect(grid.rows.value.some((r) => r.id.startsWith('stale'))).toBe(false)
    })

    it('caps accumulation at the ceiling and surfaces it (no silent truncation)', async () => {
      // total far exceeds the 5000 ceiling; drive loadMore until capped. Use a small page to keep it quick
      // but assert the cap behavior generically (capped flag set + hasMore forced false + warn logged).
      const { fetchFn } = makePaginatedViewFetch(6000, 1000)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }), pageSize: 1000 })
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(1000))
      for (let i = 0; i < 6 && grid.canLoadMore.value; i++) {
        await grid.loadMore()
        await nextTick()
      }
      expect(grid.rows.value.length).toBe(5000)
      expect(grid.accumulationCapped.value).toBe(true)
      expect(grid.canLoadMore.value).toBe(false)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('a reset (loadViewData offset 0) clears the accumulation cap latch', async () => {
      const { fetchFn } = makePaginatedViewFetch(200, 50)
      const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))
      grid.accumulationCapped.value = true // simulate a prior cap
      await grid.loadViewData(0)
      await vi.waitFor(() => expect(grid.rows.value).toHaveLength(50))
      expect(grid.accumulationCapped.value).toBe(false)
    })
  })

  it('resolves record-create context from the multitable route when refs are temporarily blank', () => {
    expect(resolveCreateRecordContext({
      sheetId: '',
      viewId: '',
      pathname: '/multitable/sheet_standard_materials/view_grid',
    })).toEqual({
      sheetId: 'sheet_standard_materials',
      viewId: 'view_grid',
    })
  })

  it('resolves record-create context from a hash-backed multitable route', () => {
    expect(resolveCreateRecordContext({
      sheetId: '',
      viewId: '',
      hash: '#/multitable/sheet_hash_materials/view_hash_grid?baseId=base_legacy',
    })).toEqual({
      sheetId: 'sheet_hash_materials',
      viewId: 'view_hash_grid',
    })
  })

  it('resolves record-create context from sheet and view query parameters', () => {
    expect(resolveCreateRecordContext({
      sheetId: '',
      viewId: '',
      href: 'http://localhost/grid?sheetId=sheet_query_materials&viewId=view_query_grid',
    })).toEqual({
      sheetId: 'sheet_query_materials',
      viewId: 'view_query_grid',
    })
  })

  it('does not borrow public-form route ids for authenticated record creation', () => {
    expect(resolveCreateRecordContext({
      sheetId: '',
      viewId: '',
      pathname: '/multitable/public-form/sheet_public/view_public',
    })).toEqual({})
  })

  it('sends route-derived sheet and view ids when creating a record from a direct multitable URL', async () => {
    const originalPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
    window.history.pushState({}, '', '/multitable/sheet_standard_materials/view_grid?baseId=base_legacy')
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/multitable/records') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          sheetId: 'sheet_standard_materials',
          viewId: 'view_grid',
          data: {},
        })
        return new Response(JSON.stringify({
          ok: true,
          data: { record: { id: 'rec_1', version: 1, data: {} } },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/view')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [],
            rows: [],
            page: { offset: 0, limit: 50, total: 0, hasMore: false },
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const sheetId = ref('')
    const viewId = ref('')
    const grid = useMultitableGrid({
      sheetId,
      viewId,
      client: new MultitableApiClient({ fetchFn }),
    })

    try {
      await grid.createRecord({})
    } finally {
      window.history.pushState({}, '', originalPath || '/')
    }

    expect(fetchFn).toHaveBeenCalledWith('/api/multitable/records', expect.objectContaining({ method: 'POST' }))
    expect(sheetId.value).toBe('sheet_standard_materials')
    expect(viewId.value).toBe('view_grid')
    expect(grid.error.value).toBeNull()
  })

  it('blocks record creation locally when no sheet or view context exists', async () => {
    const fetchFn = vi.fn()
    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    await grid.createRecord({})

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.error.value).toBe('sheetId or viewId is required')
  })

  it('localizes local record-create context fallback in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const fetchFn = vi.fn()
    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    await grid.createRecord({})

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.error.value).toBe('需要 sheetId 或 viewId')
  })

  it('falls back to the last non-empty page when a load lands beyond the new total', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      const url = new URL(`http://localhost${input}`)
      const offset = Number(url.searchParams.get('offset') ?? '0')
      if (offset === 20) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'f1', name: 'Title', type: 'string' }],
            rows: [],
            page: { offset: 20, limit: 10, total: 15, hasMore: false },
          },
        }), { status: 200 })
      }
      if (offset === 10) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'f1', name: 'Title', type: 'string' }],
            rows: [{ id: 'r2', version: 2, data: { f1: 'last valid page' } }],
            page: { offset: 10, limit: 10, total: 15, hasMore: false },
          },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        ok: true,
        data: {
          fields: [{ id: 'f1', name: 'Title', type: 'string' }],
          rows: [{ id: 'r0', version: 1, data: { f1: 'initial page' } }],
          page: { offset: 0, limit: 10, total: 15, hasMore: true },
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref('s1'),
      viewId: ref('v1'),
      pageSize: 10,
      client: new MultitableApiClient({ fetchFn }),
    })

    await vi.waitFor(() => {
      expect(grid.rows.value).toEqual([{ id: 'r0', version: 1, data: { f1: 'initial page' } }])
    })
    fetchFn.mockClear()

    await grid.loadViewData(20)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0]?.[0]).toContain('offset=20')
    expect(fetchFn.mock.calls[1]?.[0]).toContain('offset=10')
    expect(grid.page.value.offset).toBe(10)
    expect(grid.rows.value).toEqual([{ id: 'r2', version: 2, data: { f1: 'last valid page' } }])
  })

  it('clamps goToPage to the current total page count', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      const url = new URL(`http://localhost${input}`)
      const offset = Number(url.searchParams.get('offset') ?? '0')
      return new Response(JSON.stringify({
        ok: true,
        data: {
          fields: [{ id: 'f1', name: 'Title', type: 'string' }],
          rows: [],
          page: { offset, limit: 10, total: 23, hasMore: offset < 20 },
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref('s1'),
      viewId: ref('v1'),
      pageSize: 10,
      client: new MultitableApiClient({ fetchFn }),
    })

    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
    fetchFn.mockClear()

    grid.page.value = { offset: 10, limit: 10, total: 23, hasMore: true }
    grid.goToPage(99)

    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    expect(fetchFn.mock.calls[0]?.[0]).toContain('offset=20')
  })

  it('does not refetch when goToPage resolves to the current offset', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          fields: [{ id: 'f1', name: 'Title', type: 'string' }],
          rows: [{ id: 'r3', version: 1, data: { f1: 'page three' } }],
          page: { offset: 20, limit: 10, total: 23, hasMore: false },
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref('s1'),
      viewId: ref('v1'),
      pageSize: 10,
      client: new MultitableApiClient({ fetchFn }),
    })

    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })
    fetchFn.mockClear()

    grid.page.value = { offset: 20, limit: 10, total: 23, hasMore: false }
    grid.goToPage(3)

    await nextTick()

    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not refetch when the search query is unchanged', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn(async (input: string) => {
        if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'f1', name: 'Title', type: 'string' }],
            rows: [{ id: 'r1', version: 1, data: { f1: 'Ship pilot' } }],
            page: { offset: 0, limit: 50, total: 1, hasMore: false },
          },
        }), { status: 200 })
      })

      const grid = useMultitableGrid({
        sheetId: ref('s1'),
        viewId: ref('v1'),
        client: new MultitableApiClient({ fetchFn }),
      })

      await vi.waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1)
      })

      fetchFn.mockClear()
      grid.setSearchQuery('pilot')
      vi.advanceTimersByTime(150)
      await vi.waitFor(() => {
        expect(fetchFn).toHaveBeenCalledTimes(1)
      })
      expect(fetchFn.mock.calls[0]?.[0]).toContain('search=pilot')

      fetchFn.mockClear()
      grid.setSearchQuery('pilot')
      vi.advanceTimersByTime(150)
      await nextTick()

      expect(fetchFn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clearFilters resets all', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.addFilterRule({ fieldId: 'f1', operator: 'is', value: 'a' })
    grid.addFilterRule({ fieldId: 'f2', operator: 'greater', value: 5 })
    grid.filterConjunction.value = 'or'
    grid.clearFilters()
    expect(grid.filterRules.value).toHaveLength(0)
    expect(grid.filterConjunction.value).toBe('and')
  })

  it('updateFilterRule modifies in place', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.addFilterRule({ fieldId: 'f1', operator: 'is', value: 'a' })
    grid.updateFilterRule(0, { fieldId: 'f1', operator: 'contains', value: 'new' })
    expect(grid.filterRules.value[0].operator).toBe('contains')
    expect(grid.sortFilterDirty.value).toBe(true)
  })

  // Column width is no longer composable state (persist-display-prefs arc 2026-06-16): it moved to
  // workbench-owned local override + view.config persistence. See onSetColumnWidth assertions in
  // multitable-display-prefs-workbench.spec.ts.

  it('tracks undo/redo availability', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    expect(grid.canUndo.value).toBe(false)
    expect(grid.canRedo.value).toBe(false)
  })

  it('clearEditHistory resets stack', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.editHistory.value = [{ recordId: 'r1', fieldId: 'f1', oldValue: 'a', newValue: 'b', version: 1 }]
    grid.historyIndex.value = 0
    grid.clearEditHistory()
    expect(grid.editHistory.value).toEqual([])
    expect(grid.historyIndex.value).toBe(-1)
  })

  it('patchCell updates row version from backend response', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 2 }],
          records: [{ recordId: 'r1', data: { f1: 'patched' } }],
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]

    await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(grid.rows.value[0].data.f1).toBe('patched')
    expect(grid.rows.value[0].version).toBe(2)
    expect(grid.error.value).toBeNull()
  })

  it('rejects patchCell when scoped rowActions disallow edits', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.rowActions.value = {
      canEdit: false,
      canDelete: true,
      canComment: true,
    }

    await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.error.value).toBe('Record editing is not allowed for this row.')
  })

  it('localizes local row-action edit blocks in zh-CN', async () => {
    useLocale().setLocale('zh-CN')
    const fetchFn = vi.fn()
    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.rowActions.value = {
      canEdit: false,
      canDelete: true,
      canComment: true,
    }

    await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.error.value).toBe('该行不允许编辑记录。')
  })

  it('allows patchCell when a record-scoped rowActionOverride grants edit access', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 2 }],
          records: [{ recordId: 'r1', data: { f1: 'patched' } }],
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.rowActions.value = {
      canEdit: false,
      canDelete: false,
      canComment: true,
    }
    grid.rowActionOverrides.value = {
      r1: {
        canEdit: true,
        canDelete: false,
        canComment: true,
      },
    }

    await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(grid.rows.value[0].data.f1).toBe('patched')
    expect(grid.error.value).toBeNull()
  })

  it('captures VERSION_CONFLICT state and preserves optimistic rollback', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Row changed elsewhere',
          serverVersion: 8,
        },
      }), { status: 409 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]

    await grid.patchCell('r1', 'f1', 'patched', 1)

    expect(grid.rows.value[0].data.f1).toBe('before')
    expect(grid.conflict.value).toEqual({
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 'patched',
      message: 'Row changed elsewhere',
      serverVersion: 8,
      previousLinkSummaries: undefined,
      nextLinkSummaries: undefined,
    })
    expect(grid.error.value).toBe('Row changed elsewhere')
  })

  it('bulkPatch sends one patchRecords request with expectedVersion per selected row', async () => {
    const patchCalls: Array<{ url: string; body: PatchRequestBody }> = []
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      patchCalls.push({ url: input, body: JSON.parse(init?.body as string) as PatchRequestBody })
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [
            { recordId: 'r1', version: 4 },
            { recordId: 'r2', version: 4 },
            { recordId: 'r3', version: 4 },
          ],
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [
      { id: 'r1', version: 3, data: { f1: 'a' } },
      { id: 'r2', version: 3, data: { f1: 'b' } },
      { id: 'r3', version: 3, data: { f1: 'c' } },
    ]

    const result = await grid.bulkPatch({
      fieldId: 'f1',
      value: 'set-by-bulk',
      recordIds: ['r1', 'r2', 'r3'],
    })

    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].body.partialSuccess).toBe(true)
    expect(patchCalls[0].body.changes).toEqual([
      { recordId: 'r1', fieldId: 'f1', value: 'set-by-bulk', expectedVersion: 3 },
      { recordId: 'r2', fieldId: 'f1', value: 'set-by-bulk', expectedVersion: 3 },
      { recordId: 'r3', fieldId: 'f1', value: 'set-by-bulk', expectedVersion: 3 },
    ])
    expect(result.updated).toEqual(['r1', 'r2', 'r3'])
    expect(result.failed).toEqual([])
    for (const row of grid.rows.value) {
      expect(row.version).toBe(4)
    }
  })

  it('bulkPatch propagates a VERSION_CONFLICT error so the caller can surface it', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'VERSION_CONFLICT', message: 'Row changed elsewhere' },
      }), { status: 409 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [
      { id: 'r1', version: 3, data: { f1: 'a' } },
      { id: 'r2', version: 3, data: { f1: 'b' } },
    ]

    await expect(
      grid.bulkPatch({ fieldId: 'f1', value: 'x', recordIds: ['r1', 'r2'] }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('bulkPatch applies successful rows and returns per-row failures from partialSuccess responses', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 4 }],
          records: [{ recordId: 'r1', data: { f1: 'patched' } }],
          failed: [{
            recordId: 'r2',
            code: 'VERSION_CONFLICT',
            message: 'Version conflict for r2',
            serverVersion: 8,
          }],
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [
      { id: 'r1', version: 3, data: { f1: 'a' } },
      { id: 'r2', version: 3, data: { f1: 'b' } },
    ]

    const result = await grid.bulkPatch({
      fieldId: 'f1',
      value: 'patched',
      recordIds: ['r1', 'r2'],
    })

    expect(result.updated).toEqual(['r1'])
    expect(result.failed).toEqual([{ recordId: 'r2', reason: 'Version conflict for r2' }])
    expect(grid.rows.value[0]).toMatchObject({ version: 4, data: { f1: 'patched' } })
    expect(grid.rows.value[1]).toMatchObject({ version: 3, data: { f1: 'b' } })
  })

  it('bulkPatch skips recordIds not present in rows.value (no version available)', async () => {
    const patchCalls: Array<{ body: PatchRequestBody }> = []
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      patchCalls.push({ body: JSON.parse(init?.body as string) as PatchRequestBody })
      return new Response(JSON.stringify({
        ok: true,
        data: { updated: [{ recordId: 'r1', version: 4 }] },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [{ id: 'r1', version: 3, data: { f1: 'a' } }]

    const result = await grid.bulkPatch({
      fieldId: 'f1',
      value: 'x',
      recordIds: ['r1', 'r2_offscreen'],
    })

    expect(patchCalls[0].body.partialSuccess).toBe(true)
    expect(patchCalls[0].body.changes.map((change) => change.recordId)).toEqual(['r1'])
    expect(result.updated).toEqual(['r1'])
  })

  it('rejects deleteRecord when scoped rowActions disallow deletes', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/records/')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.rowActions.value = {
      canEdit: true,
      canDelete: false,
      canComment: true,
    }

    await expect(grid.deleteRecord('r1')).resolves.toBe(false)

    expect(fetchFn).not.toHaveBeenCalled()
    expect(grid.error.value).toBe('Record deletion is not allowed for this row.')
  })

  it('allows deleteRecord when a record-scoped rowActionOverride grants delete access', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/records/')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.rowActions.value = {
      canEdit: false,
      canDelete: false,
      canComment: true,
    }
    grid.rowActionOverrides.value = {
      r1: {
        canEdit: false,
        canDelete: true,
        canComment: true,
      },
    }

    await expect(grid.deleteRecord('r1')).resolves.toBe(true)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(grid.error.value).toBeNull()
  })

  it('reloads and reapplies pending conflict edits', async () => {
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/api/multitable/view')) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            fields: [{ id: 'f1', name: 'Title', type: 'string' }],
            rows: [{ id: 'r1', version: 8, data: { f1: 'server latest' } }],
            page: { offset: 0, limit: 50, total: 1, hasMore: false },
          },
        }), { status: 200 })
      }
      if (input.startsWith('/api/multitable/patch')) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        expect(body.changes?.[0]).toEqual({
          recordId: 'r1',
          fieldId: 'f1',
          value: 'patched again',
          expectedVersion: 8,
        })
        return new Response(JSON.stringify({
          ok: true,
          data: {
            updated: [{ recordId: 'r1', version: 9 }],
            records: [{ recordId: 'r1', data: { f1: 'patched again' } }],
          },
        }), { status: 200 })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const grid = useMultitableGrid({
      sheetId: ref('sheet_1'),
      viewId: ref('view_1'),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Title', type: 'string' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]
    grid.conflict.value = {
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 'patched again',
      message: 'Row changed elsewhere',
      serverVersion: 8,
    }

    const retried = await grid.retryConflict()

    expect(retried).toBe(true)
    expect(grid.conflict.value).toBeNull()
    expect(grid.rows.value[0]).toEqual({ id: 'r1', version: 9, data: { f1: 'patched again' } })
  })

  it('mergeRemoteRecord preserves personSummaries from a realtime refetch', () => {
    // Regression (#3): the realtime full-context refetch merge must carry
    // personSummaries (alongside link/attachment) so native person fields keep
    // showing the resolved display instead of dropping back to the raw userId.
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.rows.value = [{ id: 'r1', version: 1, data: { fld_owner: ['u1'] } }]

    const merged = grid.mergeRemoteRecord(
      { id: 'r1', version: 2, data: { fld_owner: ['u2'] } },
      {
        linkSummaries: {},
        personSummaries: { fld_owner: [{ id: 'u2', display: 'Bob' }] },
        attachmentSummaries: {},
      },
    )

    expect(merged).toBe(true)
    expect(grid.rows.value[0]).toEqual({ id: 'r1', version: 2, data: { fld_owner: ['u2'] } })
    // The merged person summary is stored under the record, keyed by field id.
    expect(grid.personSummaries.value.r1).toEqual({ fld_owner: [{ id: 'u2', display: 'Bob' }] })
  })
})

describe('buildSortInfo', () => {
  it('returns undefined for empty rules', () => {
    expect(buildSortInfo([])).toBeUndefined()
  })

  it('serializes rules to backend format', () => {
    const rules: SortRule[] = [{ fieldId: 'f1', direction: 'asc' }, { fieldId: 'f2', direction: 'desc' }]
    expect(buildSortInfo(rules)).toEqual({ rules: [{ fieldId: 'f1', desc: false }, { fieldId: 'f2', desc: true }] })
  })
})

describe('buildFilterInfo', () => {
  it('returns undefined for empty rules', () => {
    expect(buildFilterInfo([])).toBeUndefined()
  })

  it('serializes with default AND conjunction', () => {
    const rules: FilterRule[] = [{ fieldId: 'f1', operator: 'is', value: 'hello' }]
    expect(buildFilterInfo(rules)).toEqual({ conjunction: 'and', conditions: [{ fieldId: 'f1', operator: 'is', value: 'hello' }] })
  })

  it('serializes with OR conjunction', () => {
    const rules: FilterRule[] = [{ fieldId: 'f1', operator: 'isEmpty' }, { fieldId: 'f2', operator: 'greater', value: 10 }]
    expect(buildFilterInfo(rules, 'or')).toEqual({
      conjunction: 'or',
      conditions: [{ fieldId: 'f1', operator: 'isEmpty', value: undefined }, { fieldId: 'f2', operator: 'greater', value: 10 }],
    })
  })
})

describe('nested filter groups (FE model) — parseFilterTree / buildFilterInfoFromNodes round-trip', () => {
  // The data-safety gate: a stored filter (flat OR nested, any depth the UI can't author) must hydrate and
  // re-serialize byte-faithfully, so loading + re-saving a view never silently flattens/corrupts its filter.
  const THREE_LEVEL = {
    conjunction: 'and' as const,
    conditions: [
      { fieldId: 'a', operator: 'is', value: 1 },
      {
        conjunction: 'or' as const,
        conditions: [
          { fieldId: 'b', operator: 'is', value: 2 },
          {
            conjunction: 'and' as const,
            conditions: [
              { fieldId: 'c', operator: 'is', value: 3 },
              { fieldId: 'd', operator: 'isNot', value: 4 },
            ],
          },
        ],
      },
    ],
  }

  it('round-trips a 3-level filter the flat UI cannot author (deep-equal)', () => {
    const tree = parseFilterTree(THREE_LEVEL)!
    expect(tree).not.toBeNull()
    expect(buildFilterInfoFromNodes(tree.nodes, tree.conjunction)).toEqual(THREE_LEVEL)
  })

  it('round-trips a flat filter and matches buildFilterInfo byte-for-byte', () => {
    const flat = { conjunction: 'or' as const, conditions: [{ fieldId: 'a', operator: 'is', value: 1 }, { fieldId: 'b', operator: 'greater', value: 2 }] }
    const tree = parseFilterTree(flat)!
    const built = buildFilterInfoFromNodes(tree.nodes, tree.conjunction)
    expect(built).toEqual(flat)
    expect(built).toEqual(buildFilterInfo(tree.nodes as FilterRule[], tree.conjunction)) // flat parity with the legacy serializer
  })

  it('drops malformed leaves, empty groups, ambiguous (group+leaf) nodes, and groups past the depth cap', () => {
    const parsed = parseFilterTree({
      conjunction: 'and',
      conditions: [
        { fieldId: 'a', operator: 'is', value: 1 },
        { operator: 'is' }, // no fieldId
        { conjunction: 'and', conditions: [] }, // empty group
        { fieldId: 'x', operator: 'is', conditions: [{ fieldId: 'y', operator: 'is' }] }, // ambiguous
      ],
    })
    expect(parsed?.nodes.map((n) => (isFilterGroup(n) ? 'group' : n.fieldId))).toEqual(['a'])

    // 7 levels of nesting → the over-deep subtree collapses, leaving only the shallow sibling.
    let deep: any = { fieldId: 'deep', operator: 'is', value: 1 }
    for (let i = 0; i < 7; i++) deep = { conjunction: 'and', conditions: [deep] }
    const cap = parseFilterTree({ conjunction: 'and', conditions: [{ fieldId: 's', operator: 'is', value: 1 }, deep] })
    expect(cap?.nodes.map((n) => (isFilterGroup(n) ? 'group' : n.fieldId))).toEqual(['s'])
  })

  it('parseFilterTree returns null for empty / non-filter input', () => {
    expect(parseFilterTree(null)).toBeNull()
    expect(parseFilterTree({})).toBeNull()
    expect(parseFilterTree({ conjunction: 'and', conditions: [] })).toBeNull()
  })

  it('syncFromView preserves nested groups and re-serializes faithfully; a flat edit flattens (commits to flat)', () => {
    const client = createMockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.syncFromView({ filterInfo: THREE_LEVEL })
    // flat toolbar still shows the top-level leaf conditions...
    expect(grid.filterRules.value.map((r) => r.fieldId)).toEqual(['a'])
    // ...while the full ordered tree is preserved for a faithful save.
    expect(grid.nestedFilterNodes.value).not.toBeNull()
    expect(buildFilterInfoFromNodes(grid.nestedFilterNodes.value as FilterNode[], grid.filterConjunction.value)).toEqual(THREE_LEVEL)
    // editing via the flat toolbar drops the preserved tree (flat becomes the source of truth)
    grid.addFilterRule({ fieldId: 'e', operator: 'is', value: 5 })
    expect(grid.nestedFilterNodes.value).toBeNull()
  })
})

describe('nested filter groups (FE authoring) — filterGroups edit ops + serialize', () => {
  const serialize = (grid: ReturnType<typeof useMultitableGrid>) =>
    buildFilterInfoFromNodes([...grid.filterRules.value, ...grid.filterGroups.value], grid.filterConjunction.value)

  it('syncFromView splits a stored filter into root leaves (filterRules) + groups (filterGroups)', () => {
    const client = createMockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.syncFromView({ filterInfo: { conjunction: 'and', conditions: [
      { fieldId: 'a', operator: 'is', value: 1 },
      { conjunction: 'or', conditions: [{ fieldId: 'b', operator: 'is', value: 2 }] },
    ] } })
    expect(grid.filterRules.value.map((r) => r.fieldId)).toEqual(['a'])
    expect(grid.filterGroups.value.length).toBe(1)
    expect(grid.filterGroups.value[0].conjunction).toBe('or')
  })

  it('addFilterGroup / updateFilterGroup / removeFilterGroup edit the root subgroups and mark dirty', () => {
    const client = createMockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    const g: FilterGroup = { conjunction: 'or', conditions: [{ fieldId: 'a', operator: 'is', value: 1 }] }
    grid.addFilterGroup(g)
    expect(grid.filterGroups.value.length).toBe(1)
    expect(grid.sortFilterDirty.value).toBe(true)

    grid.updateFilterGroup(0, { conjunction: 'and', conditions: [{ fieldId: 'a', operator: 'is', value: 1 }, { fieldId: 'b', operator: 'is', value: 2 }] })
    expect(grid.filterGroups.value[0].conjunction).toBe('and')
    expect(grid.filterGroups.value[0].conditions.length).toBe(2)

    grid.removeFilterGroup(0)
    expect(grid.filterGroups.value.length).toBe(0)
  })

  it('serializes root leaves + authored groups together (leaves then groups)', () => {
    const client = createMockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.addFilterRule({ fieldId: 'a', operator: 'is', value: 1 })
    grid.addFilterGroup({ conjunction: 'or', conditions: [{ fieldId: 'b', operator: 'is', value: 2 }, { fieldId: 'c', operator: 'is', value: 3 }] })
    expect(serialize(grid)).toEqual({
      conjunction: 'and',
      conditions: [
        { fieldId: 'a', operator: 'is', value: 1 },
        { conjunction: 'or', conditions: [{ fieldId: 'b', operator: 'is', value: 2 }, { fieldId: 'c', operator: 'is', value: 3 }] },
      ],
    })
  })

  it('a group authored on a hydrated nested view drops the untouched-faithful cache', () => {
    const client = createMockClient()
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.syncFromView({ filterInfo: { conjunction: 'and', conditions: [
      { fieldId: 'a', operator: 'is', value: 1 },
      { conjunction: 'or', conditions: [{ fieldId: 'b', operator: 'is', value: 2 }] },
    ] } })
    expect(grid.nestedFilterNodes.value).not.toBeNull() // faithful passthrough until edited
    grid.addFilterGroup({ conjunction: 'and', conditions: [{ fieldId: 'c', operator: 'is', value: 3 }] })
    expect(grid.nestedFilterNodes.value).toBeNull() // edit → filterRules+filterGroups become the truth
  })
})

describe('FILTER_OPERATORS_BY_TYPE', () => {
  it('string has contains/is/isEmpty', () => {
    const ops = FILTER_OPERATORS_BY_TYPE.string.map((o) => o.value)
    expect(ops).toContain('is')
    expect(ops).toContain('contains')
    expect(ops).toContain('isEmpty')
  })

  it('number has comparison operators', () => {
    const ops = FILTER_OPERATORS_BY_TYPE.number.map((o) => o.value)
    expect(ops).toContain('greater')
    expect(ops).toContain('less')
    expect(ops).toContain('greaterEqual')
    expect(ops).toContain('lessEqual')
  })

  it('boolean has is/isNot', () => {
    const ops = FILTER_OPERATORS_BY_TYPE.boolean.map((o) => o.value)
    expect(ops).toContain('is')
    expect(ops).toContain('isNot')
  })

  it('select has is/isEmpty', () => {
    const ops = FILTER_OPERATORS_BY_TYPE.select.map((o) => o.value)
    expect(ops).toContain('is')
    expect(ops).toContain('isEmpty')
  })
})
