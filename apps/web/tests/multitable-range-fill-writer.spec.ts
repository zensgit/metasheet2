import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import type { MetaField, PatchResult } from '../src/multitable/types'
import type { RangeChange } from '../src/multitable/utils/grid-range-fill'

const changes: RangeChange[] = [
  { recordId: 'r1', fieldId: 'f1', value: 'requested', expectedVersion: 5 },
  { recordId: 'r1', fieldId: 'f2', value: 42, expectedVersion: 5 },
  { recordId: 'r2', fieldId: 'f1', value: 'requested too', expectedVersion: 8 },
]

const success: PatchResult = {
  updated: [{ recordId: 'r1', version: 6 }, { recordId: 'r2', version: 9 }],
  records: [
    { recordId: 'r1', data: { f1: 'canonical', f2: 42 } },
    { recordId: 'r2', data: { f1: 'canonical too' } },
  ],
  batchId: 'batch-range',
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200 })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function setup() {
  const patchFetch = vi.fn(async (_init?: RequestInit): Promise<Response> => response(success))
  const client = new MultitableApiClient({
    fetchFn: vi.fn(async (input: string, init?: RequestInit) => {
      if (input === '/api/multitable/patch') return patchFetch(init)
      return response({
        fields: [{ id: 'f1', name: 'Title', type: 'string' }, { id: 'f2', name: 'Count', type: 'number' }],
        rows: [
          { id: 'r1', version: 5, data: { f1: 'old', f2: 10 } },
          { id: 'r2', version: 8, data: { f1: 'old too', f2: 20 } },
        ],
        meta: { permissions: { rowActions: { canEdit: true, canDelete: false, canComment: true } } },
      })
    }),
  })
  const patchRecords = vi.spyOn(client, 'patchRecords')
  const sheetId = ref('s1')
  const viewId = ref('v1')
  const grid = useMultitableGrid({ sheetId, viewId, client })
  await vi.waitFor(() => expect(grid.loading.value).toBe(false))
  grid.editHistory.value = [
    { recordId: 'r1', fieldId: 'f1', oldValue: 'older', newValue: 'old', version: 4 },
    { recordId: 'r1', fieldId: 'f2', oldValue: 10, newValue: 11, version: 5 },
  ]
  grid.historyIndex.value = 0
  grid.lastBatchId.value = 'previous-batch'
  return { grid, client, sheetId, viewId, patchRecords, patchFetch }
}

describe('useMultitableGrid patchRange', () => {
  beforeEach(() => useLocale().setLocale('en'))

  it('sends exactly one atomic payload, preserving one captured version for multiple fields in a record', async () => {
    const { grid, patchRecords, patchFetch } = await setup()
    const expected = { sheetId: 's1', viewId: 'v1', partialSuccess: false, changes }
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(true)

    await expect(grid.patchRange(changes)).resolves.toEqual(success)

    expect(patchRecords).toHaveBeenCalledTimes(1)
    expect(patchRecords).toHaveBeenCalledWith(expected)
    expect(patchFetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(patchFetch.mock.calls[0][0]?.body as string)).toEqual(expected)
    expect(grid.rows.value).toEqual([
      { id: 'r1', version: 6, data: { f1: 'canonical', f2: 42 } },
      { id: 'r2', version: 9, data: { f1: 'canonical too', f2: 20 } },
    ])
    expect(grid.lastBatchId.value).toBe('batch-range')
    expect(grid.editHistory.value).toEqual([])
    expect(grid.historyIndex.value).toBe(-1)
    expect(grid.canUndo.value).toBe(false)
    expect(grid.canRedo.value).toBe(false)
    await grid.undo()
    await grid.redo()
    expect(patchRecords).toHaveBeenCalledTimes(1)
  })

  it('keeps rows, history and batch untouched until success and freezes the payload objects', async () => {
    const { grid, patchRecords, patchFetch } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const before = JSON.stringify(grid.rows.value)
    const input = changes.map((change) => ({ ...change }))
    const commit = grid.patchRange(input)
    input[0].expectedVersion = 100
    input[0].value = 'later mutation'

    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(true)
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(patchRecords.mock.calls[0][0].changes).toEqual(changes)
    pending.resolve(response(success))
    await commit
  })

  it.each([
    [403, 'FORBIDDEN'],
    [409, 'VERSION_CONFLICT'],
    [422, 'VALIDATION_ERROR'],
  ])('propagates HTTP %i failures without local mutations or raw shared error text', async (status, code) => {
    const { grid, patchFetch } = await setup()
    patchFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false, error: { code, message: 'sensitive server message' },
    }), { status }))
    const before = JSON.stringify(grid.rows.value)
    const history = JSON.stringify(grid.editHistory.value)

    await expect(grid.patchRange(changes)).rejects.toMatchObject({ status, code })

    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(JSON.stringify(grid.editHistory.value)).toBe(history)
    expect(grid.historyIndex.value).toBe(0)
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(true)
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(grid.error.value).toBeNull()
    expect(grid.conflict.value).toBeNull()
    await expect(grid.patchRange(changes)).resolves.toEqual(success)
  })

  it('rejects a returned failure before applying even a mixed success echo', async () => {
    const { grid, patchFetch } = await setup()
    patchFetch.mockResolvedValueOnce(response({
      ...success, failed: [{ recordId: 'r2', code: 'FORBIDDEN', message: 'sensitive server message' }],
    }))
    const before = JSON.stringify(grid.rows.value)

    await expect(grid.patchRange(changes)).rejects.toThrow('RANGE_INVALID')
    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(true)
  })

  it('does not automatically retry a timeout with an uncertain commit outcome', async () => {
    const { grid, patchFetch, patchRecords } = await setup()
    const failure = Object.assign(new Error('sensitive timeout message'), { name: 'TimeoutError' })
    patchFetch.mockRejectedValueOnce(failure)
    const before = JSON.stringify(grid.rows.value)
    const history = JSON.stringify(grid.editHistory.value)

    await expect(grid.patchRange(changes)).rejects.toBe(failure)
    await nextTick()

    expect(patchRecords).toHaveBeenCalledTimes(1)
    expect(patchFetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(JSON.stringify(grid.editHistory.value)).toBe(history)
    expect(grid.historyIndex.value).toBe(0)
    expect(grid.canUndo.value).toBe(true)
    expect(grid.canRedo.value).toBe(true)
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(grid.error.value).toBeNull()
    expect(grid.conflict.value).toBeNull()
  })

  it('preserves realtime version 7 and its data when a deferred range response returns version 6', async () => {
    const { grid, patchFetch, patchRecords } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    const liveAttachment = {
      id: 'live-file', filename: 'live', mimeType: 'text/plain', size: 7,
      url: '/live-file', uploadedAt: '2026-10-08T00:00:00Z',
    }
    grid.mergeRemoteRecord({ id: 'r1', version: 7, data: { f1: 'realtime newer', f2: 77 } }, {
      linkSummaries: { f1: [{ id: 'live-link', display: 'Live' }] },
      attachmentSummaries: { f1: [liveAttachment] },
    })
    const echo = {
      ...success,
      linkSummaries: {
        r1: { f1: [{ id: 'stale-link', display: 'Stale' }] },
        r2: { f1: [{ id: 'current-link', display: 'Current' }] },
      },
      attachmentSummaries: {
        r1: { f1: [{ ...liveAttachment, id: 'stale-file' }] },
        r2: { f1: [{ ...liveAttachment, id: 'current-file' }] },
      },
    }
    pending.resolve(response(echo))
    await expect(commit).resolves.toEqual(echo)

    expect(grid.rows.value).toEqual([
      { id: 'r1', version: 7, data: { f1: 'realtime newer', f2: 77 } },
      { id: 'r2', version: 9, data: { f1: 'canonical too', f2: 20 } },
    ])
    expect(grid.linkSummaries.value).toEqual({
      r1: { f1: [{ id: 'live-link', display: 'Live' }] },
      r2: { f1: [{ id: 'current-link', display: 'Current' }] },
    })
    expect(grid.attachmentSummaries.value).toEqual({
      r1: { f1: [liveAttachment] },
      r2: { f1: [{ ...liveAttachment, id: 'current-file' }] },
    })
    expect(grid.lastBatchId.value).toBe('batch-range')
    expect(grid.editHistory.value).toEqual([])
    expect(grid.canUndo.value).toBe(false)
    expect(grid.canRedo.value).toBe(false)
    expect(patchRecords).toHaveBeenCalledTimes(1)
  })

  it('propagates a network rejection and releases the range lock', async () => {
    const { grid, patchFetch } = await setup()
    const failure = new Error('network failure')
    patchFetch.mockRejectedValueOnce(failure)
    const before = JSON.stringify(grid.rows.value)

    await expect(grid.patchRange(changes)).rejects.toBe(failure)
    expect(JSON.stringify(grid.rows.value)).toBe(before)
    await expect(grid.patchRange(changes)).resolves.toEqual(success)
  })

  it.each([
    ['unknown row', [{ ...changes[0], recordId: 'missing' }], 'RANGE_INVALID'],
    ['unknown field', [{ ...changes[0], fieldId: 'missing' }], 'RANGE_INVALID'],
    ['duplicate cell', [changes[0], changes[0]], 'RANGE_INVALID'],
    ['stale version', [{ ...changes[0], expectedVersion: 4 }], 'RANGE_STALE'],
    ['inconsistent versions for one record', [changes[0], { ...changes[1], expectedVersion: 6 }], 'RANGE_STALE'],
    ['nonfinite version', [{ ...changes[0], expectedVersion: NaN }], 'RANGE_STALE'],
    ['fractional version', [{ ...changes[0], expectedVersion: 5.5 }], 'RANGE_STALE'],
    ['empty changes', [], 'RANGE_INVALID'],
    ['too many cells', Array.from({ length: 1001 }, () => changes[0]), 'RANGE_INVALID'],
  ] as const)('rejects %s without a request or silent filtering', async (_name, input, code) => {
    const { grid, patchRecords } = await setup()
    const before = JSON.stringify(grid.rows.value)
    await expect(grid.patchRange(input.length ? [...changes.slice(2), ...input] : [])).rejects.toThrow(code)
    expect(patchRecords).not.toHaveBeenCalled()
    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(grid.canUndo.value).toBe(true)
    await expect(grid.patchRange(changes)).resolves.toEqual(success)
  })

  it.each([
    ['locked', (grid: Awaited<ReturnType<typeof setup>>['grid']) => { grid.rows.value[0].locked = true }],
    ['hidden column', (grid: Awaited<ReturnType<typeof setup>>['grid']) => { grid.hiddenFieldIds.value = ['f1'] }],
    ['masked permission', (grid: Awaited<ReturnType<typeof setup>>['grid']) => {
      grid.fieldPermissions.value.f1 = { visible: false, readOnly: false }
    }],
    ['read-only permission', (grid: Awaited<ReturnType<typeof setup>>['grid']) => {
      grid.fieldPermissions.value.f1 = { visible: true, readOnly: true }
    }],
    ['row denied', (grid: Awaited<ReturnType<typeof setup>>['grid']) => {
      grid.rowActionOverrides.value.r1 = { canEdit: false, canDelete: false, canComment: false }
    }],
    ['global denied', (grid: Awaited<ReturnType<typeof setup>>['grid']) => {
      grid.rowActions.value = { canEdit: false, canDelete: false, canComment: false }
    }],
    ['view denied', (grid: Awaited<ReturnType<typeof setup>>['grid']) => {
      grid.viewPermission.value = { canAccess: false, canConfigure: false, canDelete: false }
    }],
  ])('rejects %s for the whole operation', async (_name, deny) => {
    const { grid, patchRecords } = await setup()
    deny(grid)
    const before = JSON.stringify(grid.rows.value)
    await expect(grid.patchRange([changes[2], changes[0]])).rejects.toThrow('RANGE_READ_ONLY')
    expect(patchRecords).not.toHaveBeenCalled()
    expect(JSON.stringify(grid.rows.value)).toBe(before)
  })

  it.each<Partial<MetaField>>([
    { type: 'formula' }, { type: 'lookup' }, { type: 'rollup' }, { type: 'createdTime' },
    { type: 'link' }, { type: 'attachment' }, { property: { mirrorOf: 'source' } },
    { property: { readOnly: true } }, { property: { readonly: true } },
    { property: { hidden: true } }, { property: { visible: false } },
  ])('rejects structurally forbidden fields %j without a request', async (definition) => {
    const { grid, patchRecords } = await setup()
    grid.fields.value[0] = { ...grid.fields.value[0], ...definition }
    await expect(grid.patchRange([changes[2], changes[0]])).rejects.toThrow('RANGE_READ_ONLY')
    expect(patchRecords).not.toHaveBeenCalled()
  })

  it('accepts exactly 1000 cells in one request', async () => {
    const { grid, patchRecords } = await setup()
    grid.rows.value = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, version: 5, data: { f1: 'old' } }))
    const input = grid.rows.value.map((row) => ({ recordId: row.id, fieldId: 'f1', value: 'new', expectedVersion: 5 }))
    await grid.patchRange(input)
    expect(patchRecords).toHaveBeenCalledTimes(1)
    expect(patchRecords).toHaveBeenCalledWith({ sheetId: 's1', viewId: 'v1', partialSuccess: false, changes: input })
  })

  it.each(['sheet', 'view', 'away and back', 'reload'])('does not project an old success after %s navigation', async (navigation) => {
    const { grid, sheetId, viewId, patchFetch, patchRecords } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    if (navigation === 'sheet') sheetId.value = 's2'
    else if (navigation === 'reload') await grid.loadViewData()
    else viewId.value = 'v2'
    await nextTick()
    await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    if (navigation === 'away and back') {
      viewId.value = 'v1'
      await nextTick()
      await vi.waitFor(() => expect(grid.loading.value).toBe(false))
    }
    grid.rows.value = [{ id: 'r1', version: 50, data: { f1: 'new context' } }]
    grid.linkSummaries.value = { r1: { f1: [{ id: 'linked-new', display: 'New' }] } }
    grid.lastBatchId.value = 'new-context-batch'
    grid.editHistory.value = [{ recordId: 'r1', fieldId: 'f1', oldValue: 'new old', newValue: 'new context', version: 49 }]
    grid.historyIndex.value = 0
    pending.resolve(response({ ...success, linkSummaries: { r1: { f1: [{ id: 'old-link', display: 'Old' }] } } }))
    await commit

    expect(patchRecords.mock.calls[0][0]).toEqual({ sheetId: 's1', viewId: 'v1', partialSuccess: false, changes })
    expect(grid.rows.value).toEqual([{ id: 'r1', version: 50, data: { f1: 'new context' } }])
    expect(grid.linkSummaries.value).toEqual({ r1: { f1: [{ id: 'linked-new', display: 'New' }] } })
    expect(grid.lastBatchId.value).toBe('new-context-batch')
    expect(grid.canUndo.value).toBe(true)
  })

  it('rejects concurrent submission and permits the next request after settlement', async () => {
    const { grid, patchFetch, patchRecords } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    await expect(grid.patchRange(changes)).rejects.toThrow('RANGE_BUSY')
    expect(patchRecords).toHaveBeenCalledTimes(1)
    pending.resolve(response(success))
    await commit
    await grid.patchRange(changes.map((change) => ({ ...change, expectedVersion: change.recordId === 'r1' ? 6 : 9 })))
    expect(patchRecords).toHaveBeenCalledTimes(2)
  })
})
