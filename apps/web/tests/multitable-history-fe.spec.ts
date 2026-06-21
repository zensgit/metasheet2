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
    listHistoryEvents: over.listHistoryEvents ?? vi.fn().mockResolvedValue({ batches: [batch('b1', 2), batch('b2')], total: 2 }),
    getHistoryBatch: over.getHistoryBatch ?? vi.fn().mockResolvedValue(detailOf('b1')),
  } as FakeClient
}
const spied = (c: FakeClient): Spied => c as unknown as Spied

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
    await load('base1', { actorId: 'u9', source: 'automation', action: 'create', from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z', fieldId: 'fld_x' })
    const params = spied(c).listHistoryEvents.mock.calls[0][1]
    // T2b: time-range + field filter forwarded alongside actor/source/action
    expect(params).toMatchObject({ actorId: 'u9', source: 'automation', action: 'create', from: '2026-06-01T00:00:00Z', to: '2026-06-30T23:59:59Z', fieldId: 'fld_x' })
  })

  it('load NEVER throws — surfaces the error and clears batches', async () => {
    const c = fakeClient({ listHistoryEvents: vi.fn().mockRejectedValue(new Error('boom')) })
    const { error, batches, load } = useHistoryCenter(c)
    await load('base1')
    expect(error.value).toBe('boom')
    expect(batches.value).toEqual([])
  })

  it('toggle lazily loads detail; toggling the same batch collapses it', async () => {
    const { expandedId, detail, toggle } = useHistoryCenter(fakeClient())
    await toggle('base1', 'b1')
    expect(expandedId.value).toBe('b1')
    expect(detail.value?.changes[0].recordId).toBe('r1')
    await toggle('base1', 'b1')
    expect(expandedId.value).toBeNull()
  })

  it('toggle on a denied/missing batch (client → null, no oracle) shows no detail and never throws', async () => {
    const c = fakeClient({ getHistoryBatch: vi.fn().mockResolvedValue(null) })
    const { detail, expandedId, toggle } = useHistoryCenter(c)
    await toggle('base1', 'bX')
    expect(expandedId.value).toBe('bX')
    expect(detail.value).toBeNull()
  })
})
