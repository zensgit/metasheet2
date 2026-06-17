import { describe, it, expect, vi } from 'vitest'
import { useTrash } from '../src/multitable/composables/useTrash'
import type { MetaDeletedRecord } from '../src/multitable/types'

// #15 recycle bin — useTrash composable contract. Locks: load populates list+total; restore is
// optimistic-on-success (removes row, decrements total) and NEVER throws — a 409 (id occupied) / 403
// surfaces via `error` and leaves the list unchanged, so a click can't leak an unhandled rejection.

function rec(id: string): MetaDeletedRecord {
  return { recordId: id, sheetId: 's1', data: {}, originalVersion: 1, createdBy: null, deletedBy: 'u', deletedAt: '2026-06-17T00:00:00Z' }
}
function fakeClient(over: { list?: unknown; restore?: unknown } = {}) {
  return {
    listDeletedRecords: over.list ?? vi.fn().mockResolvedValue({ records: [rec('r1'), rec('r2')], total: 2 }),
    restoreDeletedRecord: over.restore ?? vi.fn().mockResolvedValue({ restored: 'r1', sheetId: 's1' }),
  } as never
}

describe('useTrash — recycle bin composable', () => {
  it('load populates records + total', async () => {
    const { records, total, load } = useTrash(fakeClient())
    await load('s1')
    expect(records.value.map((r) => r.recordId)).toEqual(['r1', 'r2'])
    expect(total.value).toBe(2)
  })

  it('restore removes the record, decrements total, returns true', async () => {
    const { records, total, load, restore } = useTrash(fakeClient())
    await load('s1')
    const ok = await restore('r1')
    expect(ok).toBe(true)
    expect(records.value.map((r) => r.recordId)).toEqual(['r2'])
    expect(total.value).toBe(1)
  })

  it('restore NEVER throws — surfaces error, returns false, list unchanged (e.g. 409 id occupied)', async () => {
    const c = fakeClient({ restore: vi.fn().mockRejectedValue(new Error('Record id is occupied, cannot restore: r1')) })
    const { error, restore, records, load } = useTrash(c)
    await load('s1')
    const ok = await restore('r1')
    expect(ok).toBe(false)
    expect(error.value).toContain('occupied')
    expect(records.value.map((r) => r.recordId)).toEqual(['r1', 'r2'])
  })

  it('load NEVER throws — surfaces error', async () => {
    const c = fakeClient({ list: vi.fn().mockRejectedValue(new Error('boom')) })
    const { error, load } = useTrash(c)
    await load('s1')
    expect(error.value).toBe('boom')
  })

  it('load is a no-op without a sheetId', async () => {
    const c = fakeClient()
    const { load } = useTrash(c)
    await load('')
    expect((c as { listDeletedRecords: { mock: { calls: unknown[] } } }).listDeletedRecords.mock.calls.length).toBe(0)
  })
})
