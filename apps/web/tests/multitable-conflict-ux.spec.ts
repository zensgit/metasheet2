import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'

type ConflictSnapshot = {
  message: string
  serverVersion?: number
}

function deriveConflictBannerState(conflict: ConflictSnapshot | null) {
  if (!conflict) {
    return {
      visible: false,
      message: '',
      serverVersion: undefined as number | undefined,
      actions: [] as string[],
    }
  }

  return {
    visible: true,
    message: conflict.message,
    serverVersion: conflict.serverVersion,
    actions: typeof conflict.serverVersion === 'number' ? ['refresh', 'retry'] : ['retry'],
  }
}

function makeLoadResponse(
  rows: Array<{ id: string; version: number; data: Record<string, unknown> }>,
  offset: number,
) {
  return new Response(JSON.stringify({
    ok: true,
    data: {
      fields: [{ id: 'fld_title', name: 'Title', type: 'string' }],
      rows,
      page: { offset, limit: 50, total: 100, hasMore: offset < 50 },
    },
  }), { status: 200 })
}

describe('multitable conflict UX assumptions', () => {
  it('surfaces VERSION_CONFLICT payload message and serverVersion on client errors', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Row changed elsewhere',
          serverVersion: 8,
        },
      }), { status: 409 })),
    })

    const error = await client.patchRecords({
      sheetId: 'sheet_1',
      changes: [
        { recordId: 'r1', fieldId: 'fld_title', value: 'patched', expectedVersion: 1 },
      ],
    }).catch((err) => err)

    expect(error.name).toBe('MultitableApiError')
    expect(error.message).toBe('Row changed elsewhere')
    expect(error.code).toBe('VERSION_CONFLICT')
    expect(error.serverVersion).toBe(8)
  })

  it('maps conflict state to a simple banner model with refresh and retry actions when serverVersion is present', () => {
    expect(deriveConflictBannerState({
      message: 'Row changed elsewhere',
      serverVersion: 8,
    })).toEqual({
      visible: true,
      message: 'Row changed elsewhere',
      serverVersion: 8,
      actions: ['refresh', 'retry'],
    })

    expect(deriveConflictBannerState({
      message: 'Row changed elsewhere',
    })).toEqual({
      visible: true,
      message: 'Row changed elsewhere',
      serverVersion: undefined,
      actions: ['retry'],
    })
  })

  it('drops stale search/pagination responses when a later request resolves first', async () => {
    const pending: Array<(response: Response) => void> = []
    const fetchFn = vi.fn((input: string) => {
      if (!input.startsWith('/api/multitable/view')) {
        throw new Error(`Unexpected request: ${input}`)
      }

      return new Promise<Response>((resolve) => {
        pending.push(resolve)
      })
    })

    const sheetId = ref('')
    const viewId = ref('view_1')
    const grid = useMultitableGrid({
      sheetId,
      viewId,
      client: new MultitableApiClient({ fetchFn }),
    })

    grid.searchQuery.value = 'alpha'
    sheetId.value = 'sheet_1'
    await nextTick()

    grid.searchQuery.value = 'beta'
    const latestLoad = grid.loadViewData(50)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0]?.[0]).toContain('search=alpha')
    expect(fetchFn.mock.calls[1]?.[0]).toContain('offset=50')
    expect(fetchFn.mock.calls[1]?.[0]).toContain('search=beta')

    pending[1]?.(makeLoadResponse([
      { id: 'r2', version: 2, data: { fld_title: 'latest page' } },
    ], 50))
    await latestLoad

    pending[0]?.(makeLoadResponse([
      { id: 'r1', version: 1, data: { fld_title: 'stale page' } },
    ], 0))
    await nextTick()

    expect(grid.rows.value).toEqual([
      { id: 'r2', version: 2, data: { fld_title: 'latest page' } },
    ])
    expect(grid.page.value.offset).toBe(50)
    expect(grid.page.value.total).toBe(100)
  })
})
