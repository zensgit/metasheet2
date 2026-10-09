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
    const { grid, patchRecords, patchFetch } = await setup()
    grid.rows.value = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, version: 5, data: { f1: 'old' } }))
    const input = grid.rows.value.map((row) => ({ recordId: row.id, fieldId: 'f1', value: 'new', expectedVersion: 5 }))
    patchFetch.mockResolvedValueOnce(response({ updated: input.map(change => ({ recordId: change.recordId, version: 6 })) }))
    await grid.patchRange(input)
    expect(patchRecords).toHaveBeenCalledTimes(1)
    expect(patchRecords).toHaveBeenCalledWith({ sheetId: 's1', viewId: 'v1', partialSuccess: false, changes: input })
  })

  it('projects acknowledged values when the server only returns versions and computed fields', async () => {
    const { grid, patchFetch } = await setup()
    patchFetch.mockResolvedValueOnce(response({
      updated: success.updated,
      records: [{ recordId: 'r1', data: { computed: 84 } }],
    }))

    await grid.patchRange(changes)

    expect(grid.rows.value).toEqual([
      { id: 'r1', version: 6, data: { f1: 'requested', f2: 42, computed: 84 } },
      { id: 'r2', version: 9, data: { f1: 'requested too', f2: 20 } },
    ])
    expect(grid.editHistory.value).toEqual([])
  })

  it.each([
    [1791505800000, '2026-10-09T00:30:00.000Z'],
    ['2026-10-09T08:30:00+08:00', '2026-10-09T00:30:00.000Z'],
    [null, null],
  ])('projects acknowledged dateTime %j in the backend stored form', async (value, canonical) => {
    const { grid, patchFetch, patchRecords } = await setup()
    grid.fields.value[1].type = 'dateTime'
    patchFetch.mockResolvedValueOnce(response({ updated: [{ recordId: 'r1', version: 6 }] }))
    const input = [{ recordId: 'r1', fieldId: 'f2', value, expectedVersion: 5 }]

    await grid.patchRange(input)

    expect(patchRecords).toHaveBeenCalledWith({ sheetId: 's1', viewId: 'v1', partialSuccess: false, changes: input })
    expect(grid.rows.value[0]).toEqual({ id: 'r1', version: 6, data: { f1: 'old', f2: canonical } })
  })

  it('does not restore summaries for a row removed by realtime while the commit is pending', async () => {
    const { grid, patchFetch } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    grid.removeRemoteRecord('r1')
    pending.resolve(response({ ...success, linkSummaries: { r1: { f1: [{ id: 'old-link', display: 'Old' }] } } }))
    await commit
    expect(grid.rows.value).toEqual([{ id: 'r2', version: 9, data: { f1: 'canonical too', f2: 20 } }])
    expect(grid.linkSummaries.value).toEqual({})
    expect(grid.editHistory.value).toEqual([])
  })

  it('ignores unversioned unrelated echoes rather than overwriting a newer realtime row', async () => {
    const { grid, patchFetch } = await setup()
    grid.rows.value.push({ id: 'r3', version: 30, data: { f1: 'newer unrelated' } })
    patchFetch.mockResolvedValueOnce(response({
      ...success,
      records: [...success.records!, { recordId: 'r3', data: { f1: 'late unrelated' } }],
      linkSummaries: { r3: { f1: [{ id: 'old-link', display: 'Old' }] } },
    }))
    await grid.patchRange(changes)
    expect(grid.rows.value[2]).toEqual({ id: 'r3', version: 30, data: { f1: 'newer unrelated' } })
    expect(grid.linkSummaries.value).toEqual({})
  })

  it.each([
    ['null result', null],
    ['missing updates', {}],
    ['empty updates', { updated: [] }],
    ['partial updates', { ...success, updated: [success.updated[0]] }],
    ['duplicate updates', { ...success, updated: [success.updated[0], success.updated[0]] }],
    ['unrequested update', { ...success, updated: [...success.updated, { recordId: 'other', version: 1 }] }],
    ['non-array updates', { ...success, updated: {} }],
    ['null update', { ...success, updated: [success.updated[0], null] }],
    ['stale returned version', { ...success, updated: [{ recordId: 'r1', version: 5 }, success.updated[1]] }],
    ['fractional returned version', { ...success, updated: [{ recordId: 'r1', version: 6.5 }, success.updated[1]] }],
    ['malformed failures', { ...success, failed: {} }],
    ['non-array records', { ...success, records: {} }],
    ['null record', { ...success, records: [null] }],
    ['null record data', { ...success, records: [{ recordId: 'r1', data: null }] }],
    ['array record data', { ...success, records: [{ recordId: 'r1', data: [] }] }],
    ['duplicate records', { ...success, records: [success.records![0], success.records![0]] }],
    ['malformed summary map', { ...success, linkSummaries: { r1: null } }],
    ['malformed summaries', { ...success, attachmentSummaries: { r1: { f1: {} } } }],
  ])('rejects %s before changing any local state', async (_name, result) => {
    const { grid, patchFetch, patchRecords } = await setup()
    patchFetch.mockResolvedValueOnce(response(result))
    const before = JSON.stringify(grid.rows.value)
    const history = JSON.stringify(grid.editHistory.value)

    await expect(grid.patchRange(changes)).rejects.toThrow('RANGE_INVALID')

    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(JSON.stringify(grid.editHistory.value)).toBe(history)
    expect(grid.historyIndex.value).toBe(0)
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(grid.linkSummaries.value).toEqual({})
    expect(grid.attachmentSummaries.value).toEqual({})
    expect(patchRecords).toHaveBeenCalledTimes(1)
    await expect(grid.patchRange(changes)).resolves.toEqual(success)
  })

  it.each(['sheet', 'view', 'away and back'])('rejects %s changes before the context watcher reloads', async (navigation) => {
    const { grid, sheetId, viewId, patchRecords } = await setup()
    if (navigation === 'sheet') sheetId.value = 's2'
    else {
      viewId.value = 'v2'
      if (navigation === 'away and back') viewId.value = 'v1'
    }
    await expect(grid.patchRange(changes)).rejects.toThrow('RANGE_STALE')
    expect(patchRecords).not.toHaveBeenCalled()
  })

  it('does not project a success after a same-tick view roundtrip', async () => {
    const { grid, viewId, patchFetch } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    viewId.value = 'v2'
    viewId.value = 'v1'
    pending.resolve(response(success))
    await commit
    expect(grid.rows.value[0]).toEqual({ id: 'r1', version: 5, data: { f1: 'old', f2: 10 } })
    expect(grid.lastBatchId.value).toBe('previous-batch')
    expect(grid.historyIndex.value).toBe(0)
  })

  it.each(['cell', 'undo', 'redo', 'bulk'])('blocks %s writes while a range commit is pending', async (writer) => {
    const { grid, patchFetch, patchRecords } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = grid.patchRange(changes)
    const before = JSON.stringify(grid.rows.value)
    if (writer === 'cell') {
      await expect(grid.patchCell('r1', 'f1', 'overlap', 5)).resolves.toMatchObject({ code: 'RANGE_BUSY' })
    } else if (writer === 'bulk') {
      await expect(grid.bulkPatch({ recordIds: ['r1'], fieldId: 'f1', value: 'overlap' })).rejects.toThrow('RANGE_BUSY')
    } else await grid[writer as 'undo' | 'redo']()
    expect(patchRecords).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(grid.rows.value)).toBe(before)
    expect(grid.historyIndex.value).toBe(0)
    pending.resolve(response(success))
    await commit
  })

  it.each(['cell', 'undo', 'redo', 'bulk'])('blocks range submission during an existing %s write', async (writer) => {
    const { grid, patchFetch, patchRecords } = await setup()
    const pending = deferred<Response>()
    patchFetch.mockReturnValueOnce(pending.promise)
    const commit = writer === 'cell' ? grid.patchCell('r1', 'f1', 'other', 5)
      : writer === 'bulk' ? grid.bulkPatch({ recordIds: ['r1'], fieldId: 'f1', value: 'other' })
        : grid[writer as 'undo' | 'redo']()
    await expect(grid.patchRange(changes)).rejects.toThrow('RANGE_BUSY')
    expect(patchRecords).toHaveBeenCalledTimes(1)
    pending.resolve(response(success))
    await commit
    patchFetch.mockResolvedValueOnce(response({ ...success, updated: [{ recordId: 'r1', version: 7 }, { recordId: 'r2', version: 10 }] }))
    await grid.patchRange(changes.map(change => ({ ...change, expectedVersion: change.recordId === 'r1' ? 6 : 9 })))
    expect(patchRecords).toHaveBeenCalledTimes(2)
  })

  it.each(['cell', 'undo', 'redo', 'bulk'])('releases the range exclusion after a failed %s write', async (writer) => {
    const { grid, patchFetch, patchRecords } = await setup()
    patchFetch.mockRejectedValueOnce(new Error('network failure'))
    if (writer === 'cell') await grid.patchCell('r1', 'f1', 'other', 5)
    else if (writer === 'bulk') {
      await expect(grid.bulkPatch({ recordIds: ['r1'], fieldId: 'f1', value: 'other' })).rejects.toThrow('network failure')
    } else await grid[writer as 'undo' | 'redo']()
    await expect(grid.patchRange(changes)).resolves.toEqual(success)
    expect(patchRecords).toHaveBeenCalledTimes(2)
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
    patchFetch.mockResolvedValueOnce(response({ ...success, updated: [{ recordId: 'r1', version: 7 }, { recordId: 'r2', version: 10 }] }))
    await grid.patchRange(changes.map((change) => ({ ...change, expectedVersion: change.recordId === 'r1' ? 6 : 9 })))
    expect(patchRecords).toHaveBeenCalledTimes(2)
  })
})
