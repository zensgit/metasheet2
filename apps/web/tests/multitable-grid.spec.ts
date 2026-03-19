import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import {
  useMultitableGrid,
  buildSortInfo,
  buildFilterInfo,
  FILTER_OPERATORS_BY_TYPE,
  type SortRule,
  type FilterRule,
} from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

function createMockClient() {
  return new MultitableApiClient({
    fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })),
  })
}

describe('useMultitableGrid', () => {
  let client: MultitableApiClient

  beforeEach(() => { client = createMockClient() })

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

  it('loads initial view data when sheetId/viewId are preselected', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/view')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          fields: [{ id: 'f1', name: 'Title', type: 'string' }],
          rows: [{ id: 'r1', version: 1, data: { f1: 'Ship pilot' } }],
          view: { id: 'v1', sheetId: 's1', name: 'Grid', type: 'grid', hiddenFieldIds: [] },
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

  it('sets column width', () => {
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    grid.setColumnWidth('f1', 200)
    expect(grid.columnWidths.value.f1).toBe(200)
    grid.setColumnWidth('f2', 150)
    expect(grid.columnWidths.value.f2).toBe(150)
    expect(grid.columnWidths.value.f1).toBe(200)
  })

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

  it('patchCell applies canonical link summaries from the backend response', async () => {
    const fetchFn = vi.fn(async (input: string) => {
      if (!input.startsWith('/api/multitable/patch')) throw new Error(`Unexpected request: ${input}`)
      return new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 2 }],
          records: [{ recordId: 'r1', data: { f1: ['vendor_1', 'vendor_2'] } }],
          linkSummaries: {
            r1: {
              f1: [
                { id: 'vendor_1', display: 'Acme Supply' },
                { id: 'vendor_2', display: 'Beacon Labs' },
              ],
            },
          },
        },
      }), { status: 200 })
    })

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Vendor', type: 'link' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: ['vendor_1'] } }]
    grid.linkSummaries.value = {
      r1: {
        f1: [{ id: 'vendor_1', display: 'Old Vendor Name' }],
      },
    }

    await grid.patchCell('r1', 'f1', ['vendor_1', 'vendor_2'], 1)

    expect(grid.rows.value[0].data.f1).toEqual(['vendor_1', 'vendor_2'])
    expect(grid.linkSummaries.value.r1?.f1).toEqual([
      { id: 'vendor_1', display: 'Acme Supply' },
      { id: 'vendor_2', display: 'Beacon Labs' },
    ])
  })

  it('captures version conflicts and can retry against the latest version', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Version conflict for r1',
          serverVersion: 2,
        },
      }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 3 }],
          records: [{ recordId: 'r1', data: { f1: 'patched latest' } }],
        },
      }), { status: 200 }))

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: 'before' } }]

    await grid.patchCell('r1', 'f1', 'patched latest', 1)

    expect(grid.conflict.value).toMatchObject({
      recordId: 'r1',
      fieldId: 'f1',
      attemptedValue: 'patched latest',
      serverVersion: 2,
    })
    expect(grid.rows.value[0]?.data.f1).toBe('before')

    grid.rows.value[0]!.version = 2
    await expect(grid.retryConflict()).resolves.toBe(true)

    expect(grid.conflict.value).toBeNull()
    expect(grid.rows.value[0]).toMatchObject({
      id: 'r1',
      version: 3,
      data: { f1: 'patched latest' },
    })
  })

  it('patchCell, undo and redo round-trip a link-style cell value', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 2 }],
          records: [{ recordId: 'r1', data: { f1: ['after'] } }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 3 }],
          records: [{ recordId: 'r1', data: { f1: ['before'] } }],
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: {
          updated: [{ recordId: 'r1', version: 4 }],
          records: [{ recordId: 'r1', data: { f1: ['after'] } }],
        },
      }), { status: 200 }))

    const grid = useMultitableGrid({
      sheetId: ref(''),
      viewId: ref(''),
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.fields.value = [{ id: 'f1', name: 'Vendor', type: 'link' }]
    grid.rows.value = [{ id: 'r1', version: 1, data: { f1: ['before'] } }]
    grid.linkSummaries.value = {
      r1: {
        f1: [{ id: 'before', display: 'Beacon Labs' }],
      },
    }

    await grid.patchCell('r1', 'f1', ['after'], 1, {
      previousLinkSummaries: [{ id: 'before', display: 'Beacon Labs' }],
      nextLinkSummaries: [{ id: 'after', display: 'Acme Supply' }],
    })
    expect(grid.rows.value[0].data.f1).toEqual(['after'])
    expect(grid.rows.value[0].version).toBe(2)
    expect(grid.linkSummaries.value.r1?.f1).toEqual([{ id: 'after', display: 'Acme Supply' }])
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(false)

    await grid.undo()
    expect(grid.rows.value[0].data.f1).toEqual(['before'])
    expect(grid.rows.value[0].version).toBe(3)
    expect(grid.linkSummaries.value.r1?.f1).toEqual([{ id: 'before', display: 'Beacon Labs' }])
    expect(grid.canUndo.value).toBe(false)
    expect(grid.canRedo.value).toBe(true)

    await grid.redo()
    expect(grid.rows.value[0].data.f1).toEqual(['after'])
    expect(grid.rows.value[0].version).toBe(4)
    expect(grid.linkSummaries.value.r1?.f1).toEqual([{ id: 'after', display: 'Acme Supply' }])
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(false)

    expect(fetchFn).toHaveBeenCalledTimes(3)
    const undoRequest = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body ?? '{}'))
    const redoRequest = JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body ?? '{}'))
    expect(undoRequest.changes[0]).toMatchObject({
      recordId: 'r1',
      fieldId: 'f1',
      value: ['before'],
      expectedVersion: 2,
    })
    expect(redoRequest.changes[0]).toMatchObject({
      recordId: 'r1',
      fieldId: 'f1',
      value: ['after'],
      expectedVersion: 3,
    })
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
