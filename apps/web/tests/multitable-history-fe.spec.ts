import { describe, it, expect, vi } from 'vitest'
import { useHistoryCenter } from '../src/multitable/composables/useHistoryCenter'
import type { HistoryBatchSummary, HistoryBatchDetail } from '../src/multitable/types'

// Global History & Point-in-Time Restore — T2/T3 read-only history center composable contract.
// Locks: load populates batches and surfaces (never throws) errors; toggle lazily loads detail and a
// repeat toggle collapses; a denied/missing batch (client → null per the LOCK-3 no-oracle 404 mapping)
// shows no detail without throwing. The FE renders only what the permission-filtered backend returns.

function batch(id: string, recCount = 1): HistoryBatchSummary {
  return {
    batchId: id, sheetId: 's1', actorId: 'u1', actorName: null, source: 'rest', action: 'update',
    createdAt: '2026-06-19T00:00:00Z', visibleAffectedRecordCount: recCount, visibleAffectedFieldCount: 1,
    provenanceQuality: 'stamped',
  }
}
function detailOf(id: string): HistoryBatchDetail {
  return {
    batchId: id, actorId: 'u1', actorName: null, source: 'rest', createdAt: '2026-06-19T00:00:00Z',
    visibleAffectedRecordCount: 1, visibleAffectedFieldCount: 1,
    changes: [{ sheetId: 's1', recordId: 'r1', action: 'update', version: 2, changedFieldIds: ['f1'], before: null, after: { f1: 'x' } }],
  }
}
type FakeClient = Parameters<typeof useHistoryCenter>[0]
type Spied = { listHistoryEvents: ReturnType<typeof vi.fn>; getHistoryBatch: ReturnType<typeof vi.fn> }
function fakeClient(over: Partial<Spied> = {}): FakeClient {
  return {
    listHistoryEvents: over.listHistoryEvents ?? vi.fn().mockResolvedValue({ batches: [batch('b1', 2), batch('b2')], total: 2, nextCursor: null, searchTruncated: false }),
    getHistoryBatch: over.getHistoryBatch ?? vi.fn().mockResolvedValue(detailOf('b1')),
  } as FakeClient
}
const spied = (c: FakeClient): Spied => c as unknown as Spied

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useHistoryCenter — read-only history center', () => {
  it('load populates batches (bulk = one batch with multiple records)', async () => {
    const { batches, load } = useHistoryCenter(fakeClient())
    await load('base1')
    expect(batches.value.map((b) => b.batchId)).toEqual(['b1', 'b2'])
    expect(batches.value[0].visibleAffectedRecordCount).toBe(2)
  })

  it('load is a no-op without a baseId, and forwards filters when present', async () => {
    const c = fakeClient()
    const { load } = useHistoryCenter(c)
    await load('')
    expect(spied(c).listHistoryEvents.mock.calls.length).toBe(0)
    await load('base1', { actorId: 'u9', source: 'automation', action: 'create', from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z', fieldId: 'fld_x', search: 'invoice-42' })
    const params = spied(c).listHistoryEvents.mock.calls[0][1]
    // T2b: time-range + field filter + search forwarded alongside actor/source/action (search → client `q`)
    expect(params).toMatchObject({ actorId: 'u9', source: 'automation', action: 'create', from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z', fieldId: 'fld_x', q: 'invoice-42' })
  })

  it('T2b loadMore APPENDS the next cursor page, forwards the cursor, and stops when exhausted', async () => {
    const calls = vi.fn()
      .mockResolvedValueOnce({ batches: [batch('b1')], total: 3, nextCursor: 'cur1' })
      .mockResolvedValueOnce({ batches: [batch('b2')], total: 3, nextCursor: null })
    const c = fakeClient({ listHistoryEvents: calls })
    const { batches, nextCursor, load, loadMore } = useHistoryCenter(c)
    await load('base1', { search: 'x' })
    expect(batches.value.map((b) => b.batchId)).toEqual(['b1'])
    expect(nextCursor.value).toBe('cur1')
    await loadMore()
    expect(batches.value.map((b) => b.batchId)).toEqual(['b1', 'b2']) // appended, not replaced
    expect(nextCursor.value).toBeNull() // exhausted
    expect(calls.mock.calls[1][1]).toMatchObject({ cursor: 'cur1', q: 'x' }) // forwards cursor + reuses filters
  })

  it('T2b surfaces searchTruncated from the response (so the UI can warn of incomplete results)', async () => {
    const c = fakeClient({ listHistoryEvents: vi.fn().mockResolvedValue({ batches: [batch('b1')], total: 1, nextCursor: null, searchTruncated: true }) })
    const { searchTruncated, load } = useHistoryCenter(c)
    expect(searchTruncated.value).toBe(false)
    await load('base1', { search: 'x' })
    expect(searchTruncated.value).toBe(true)
  })

  it('T2b loadMore is a no-op when there is no nextCursor', async () => {
    const c = fakeClient() // default mock → nextCursor null
    const { load, loadMore } = useHistoryCenter(c)
    await load('base1')
    await loadMore()
    expect(spied(c).listHistoryEvents.mock.calls.length).toBe(1) // no extra fetch
  })

  it('load NEVER throws — surfaces the error and clears batches', async () => {
    const c = fakeClient({ listHistoryEvents: vi.fn().mockRejectedValue(new Error('boom')) })
    const { error, batches, load } = useHistoryCenter(c)
    await load('base1')
    expect(error.value).toBe('boom')
    expect(batches.value).toEqual([])
  })

  it('ignores an older list success, error, and finally while a newer scope is loading', async () => {
    const oldRequest = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const currentRequest = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const c = fakeClient({ listHistoryEvents: vi.fn().mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(currentRequest.promise) })
    const { batches, loading, load } = useHistoryCenter(c)

    const oldLoad = load('base_a', { sheetId: 'sheet_a' })
    const currentLoad = load('base_b', { sheetId: 'sheet_b' })
    oldRequest.resolve({ batches: [batch('old')], total: 1, nextCursor: null, searchTruncated: false })
    await oldLoad
    expect(loading.value).toBe(true)
    expect(batches.value).toEqual([])

    currentRequest.resolve({ batches: [batch('current')], total: 1, nextCursor: null, searchTruncated: false })
    await currentLoad
    expect(batches.value.map((entry) => entry.batchId)).toEqual(['current'])

    const oldError = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const currentAfterError = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const errorClient = fakeClient({ listHistoryEvents: vi.fn().mockReturnValueOnce(oldError.promise).mockReturnValueOnce(currentAfterError.promise) })
    const errorHistory = useHistoryCenter(errorClient)
    const failedOldLoad = errorHistory.load('base_a', { sheetId: 'sheet_a' })
    const successfulCurrentLoad = errorHistory.load('base_b', { sheetId: 'sheet_b' })
    currentAfterError.resolve({ batches: [batch('current_after_error')], total: 1, nextCursor: null, searchTruncated: false })
    await successfulCurrentLoad
    oldError.reject(new Error('late error'))
    await failedOldLoad
    expect(errorHistory.error.value).toBeNull()
    expect(errorHistory.batches.value.map((entry) => entry.batchId)).toEqual(['current_after_error'])
  })

  it('keeps an old load-more page from changing a newer ABA scope or its spinner', async () => {
    const oldPage = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null; searchTruncated: boolean }>()
    const currentPage = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: string | null; searchTruncated: boolean }>()
    const calls = vi.fn()
      .mockResolvedValueOnce({ batches: [batch('a_initial')], total: 2, nextCursor: 'a_old_cursor', searchTruncated: false })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ batches: [batch('b')], total: 1, nextCursor: null, searchTruncated: false })
      .mockResolvedValueOnce({ batches: [batch('a_current')], total: 2, nextCursor: 'a_new_cursor', searchTruncated: false })
      .mockReturnValueOnce(currentPage.promise)
    const { batches, loadingMore, nextCursor, load, loadMore } = useHistoryCenter(fakeClient({ listHistoryEvents: calls }))

    await load('base', { search: 'a' })
    const oldMore = loadMore()
    await load('base', { search: 'b' })
    await load('base', { search: 'a' })
    const currentMore = loadMore()
    expect(loadingMore.value).toBe(true)

    oldPage.resolve({ batches: [batch('a_old_page')], total: 2, nextCursor: 'a_old_after', searchTruncated: false })
    await oldMore
    expect(batches.value.map((entry) => entry.batchId)).toEqual(['a_current'])
    expect(nextCursor.value).toBe('a_new_cursor')
    expect(loadingMore.value).toBe(true)

    currentPage.resolve({ batches: [batch('a_current_page')], total: 2, nextCursor: null, searchTruncated: false })
    await currentMore
  })

  it('toggle lazily loads detail; toggling the same batch collapses it', async () => {
    const { expandedId, detail, toggle } = useHistoryCenter(fakeClient())
    await toggle('base1', 'b1')
    expect(expandedId.value).toBe('b1')
    expect(detail.value?.changes[0].recordId).toBe('r1')
    await toggle('base1', 'b1')
    expect(expandedId.value).toBeNull()
  })

  it('keeps the current cursor and spinner when an obsolete page rejects', async () => {
    const oldPage = deferred<never>()
    const currentPage = deferred<{ batches: HistoryBatchSummary[]; total: number; nextCursor: null; searchTruncated: boolean }>()
    const calls = vi.fn()
      .mockResolvedValueOnce({ batches: [batch('old')], nextCursor: 'old_cursor' })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ batches: [batch('current')], nextCursor: 'current_cursor' })
      .mockReturnValueOnce(currentPage.promise)
    const history = useHistoryCenter(fakeClient({ listHistoryEvents: calls }))
    await history.load('base', { search: 'old' })
    const oldMore = history.loadMore()
    await history.load('base', { search: 'current' })
    const currentMore = history.loadMore()
    oldPage.reject(new Error('obsolete page'))
    await oldMore
    expect(history.nextCursor.value).toBe('current_cursor')
    expect(history.loadingMore.value).toBe(true)
    expect(history.batches.value.map((entry) => entry.batchId)).toEqual(['current'])
    currentPage.resolve({ batches: [batch('current_page')], total: 2, nextCursor: null, searchTruncated: false })
    await currentMore
    expect(history.batches.value.map((entry) => entry.batchId)).toEqual(['current', 'current_page'])
  })

  it('keeps replacement detail when an obsolete detail rejects', async () => {
    const oldDetail = deferred<never>()
    const history = useHistoryCenter(fakeClient({ getHistoryBatch: vi.fn()
      .mockReturnValueOnce(oldDetail.promise).mockResolvedValueOnce(detailOf('current')) }))
    const oldToggle = history.toggle('base', 'old')
    await history.toggle('base', 'current')
    oldDetail.reject(new Error('obsolete detail'))
    await oldToggle
    expect(history.expandedId.value).toBe('current')
    expect(history.detail.value).toEqual(detailOf('current'))
    expect(history.detailLoading.value).toBe(false)
  })

  it.each(['success', 'failure'] as const)('keeps replacement pin loading after obsolete %s', async (outcome) => {
    const oldPin = deferred<HistoryBatchDetail | null>()
    const currentPin = deferred<HistoryBatchDetail | null>()
    const history = useHistoryCenter(fakeClient({ getHistoryBatch: vi.fn()
      .mockReturnValueOnce(oldPin.promise).mockReturnValueOnce(currentPin.promise) }))
    const oldLoad = history.loadPinned('base', 'old')
    const currentLoad = history.loadPinned('base', 'current')
    if (outcome === 'success') oldPin.resolve(detailOf('old'))
    else oldPin.reject(new Error('obsolete pin'))
    await oldLoad
    expect(history.pinnedLoading.value).toBe(true)
    expect(history.pinnedDetail.value).toBeNull()
    currentPin.resolve(detailOf('current'))
    await currentLoad
    expect(history.pinnedDetail.value).toEqual(detailOf('current'))
    expect(history.pinnedLoading.value).toBe(false)
  })

  it('keeps replacement pin detail after an obsolete rejection', async () => {
    const oldPin = deferred<never>()
    const history = useHistoryCenter(fakeClient({ getHistoryBatch: vi.fn()
      .mockReturnValueOnce(oldPin.promise).mockResolvedValueOnce(detailOf('current')) }))
    const oldLoad = history.loadPinned('base', 'old')
    await history.loadPinned('base', 'current')
    oldPin.reject(new Error('obsolete pin'))
    await oldLoad
    expect(history.pinnedDetail.value).toEqual(detailOf('current'))
  })

  it('toggle on a denied/missing batch (client → null, no oracle) shows no detail and never throws', async () => {
    const c = fakeClient({ getHistoryBatch: vi.fn().mockResolvedValue(null) })
    const { detail, expandedId, toggle } = useHistoryCenter(c)
    await toggle('base1', 'bX')
    expect(expandedId.value).toBe('bX')
    expect(detail.value).toBeNull()
  })

  it('ignores an older detail after another batch is expanded or a list reload invalidates it', async () => {
    const firstDetail = deferred<HistoryBatchDetail | null>()
    const secondDetail = deferred<HistoryBatchDetail | null>()
    const c = fakeClient({ getHistoryBatch: vi.fn().mockReturnValueOnce(firstDetail.promise).mockReturnValueOnce(secondDetail.promise) })
    const { detail, detailLoading, expandedId, load, toggle } = useHistoryCenter(c)

    const firstToggle = toggle('base', 'b1')
    const secondToggle = toggle('base', 'b2')
    firstDetail.resolve(detailOf('b1'))
    await firstToggle
    expect(expandedId.value).toBe('b2')
    expect(detail.value).toBeNull()
    expect(detailLoading.value).toBe(true)

    secondDetail.resolve(detailOf('b2'))
    await secondToggle
    expect(detail.value?.batchId).toBe('b2')

    const staleAfterReload = deferred<HistoryBatchDetail | null>()
    spied(c).getHistoryBatch.mockReturnValueOnce(staleAfterReload.promise)
    const staleToggle = toggle('base', 'b3')
    await load('base', { search: 'new scope' })
    staleAfterReload.resolve(detailOf('b3'))
    await staleToggle
    expect(expandedId.value).toBeNull()
    expect(detail.value).toBeNull()
    expect(detailLoading.value).toBe(false)
  })
})
