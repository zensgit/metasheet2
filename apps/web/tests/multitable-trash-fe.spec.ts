import { describe, it, expect, vi } from 'vitest'
import { useTrash } from '../src/multitable/composables/useTrash'
import { pickRecordTitle } from '../src/multitable/utils/field-display'
import type { MetaDeletedRecord, MetaField } from '../src/multitable/types'

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

// The recycle bin shows a human-readable title for each trashed row instead of the raw record id, so a
// record is identifiable before restore. Title = first field (by column ORDER) whose backend-masked
// value renders non-empty; masked/empty fields fall through; null when nothing is readable.
describe('pickRecordTitle — recycle bin record identity', () => {
  const f = (id: string, order: number, type = 'text'): MetaField => ({ id, name: id, type: type as MetaField['type'], order })

  it('picks the first field by ORDER with a non-empty value (not array position)', () => {
    const fields = [f('b', 2), f('a', 1)]
    expect(pickRecordTitle({ fields, data: { a: 'Acme Corp', b: 'x' } })).toBe('Acme Corp')
  })

  it('skips masked / empty fields (—) and falls through to the next readable field', () => {
    // a denied/masked primary field is simply absent from the backend-masked data → renders '—' → skipped
    const fields = [f('secret', 1), f('name', 2)]
    expect(pickRecordTitle({ fields, data: { name: 'Visible Name' } })).toBe('Visible Name')
  })

  it('returns null when no field is readable (caller falls back to a short record id)', () => {
    expect(pickRecordTitle({ fields: [f('a', 1), f('b', 2)], data: {} })).toBeNull()
  })

  it('returns null with no fields', () => {
    expect(pickRecordTitle({ fields: [], data: { a: 'x' } })).toBeNull()
  })
})
