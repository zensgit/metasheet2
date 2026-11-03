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

  it('appends an older deleted-record page for the ordinary list', async () => {
    const listDeletedRecords = vi.fn()
      .mockResolvedValueOnce({ records: [rec('newer')], total: 2 })
      .mockResolvedValueOnce({ records: [rec('older')], total: 2 })
    const { records, load, loadMore } = useTrash(fakeClient({ list: listDeletedRecords }))
    await load('s1')
    await loadMore('s1')
    expect(listDeletedRecords).toHaveBeenNthCalledWith(2, 's1', { limit: 100, offset: 1 })
    expect(records.value.map((record) => record.recordId)).toEqual(['newer', 'older'])
  })

  it('does not start a page load while a deferred restore is pending, so the restored row is not reintroduced', async () => {
    let resolveRestore: ((value: { restored: string; sheetId: string }) => void) | undefined
    const listDeletedRecords = vi.fn().mockResolvedValue({ records: [rec('r1')], total: 2 })
    const restoreDeletedRecord = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveRestore = resolve }))
    const { records, total, load, loadMore, restore } = useTrash(fakeClient({ list: listDeletedRecords, restore: restoreDeletedRecord }))
    await load('s1')
    const restoring = restore('r1', 's1')
    await loadMore('s1')
    expect(listDeletedRecords).toHaveBeenCalledTimes(1)
    resolveRestore!({ restored: 'r1', sheetId: 's1' })
    await expect(restoring).resolves.toBe(true)
    expect(records.value).toEqual([])
    expect(total.value).toBe(1)
  })

  it('refuses a restore while an older deleted-record page is loading', async () => {
    let resolveMore: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    const listDeletedRecords = vi.fn()
      .mockResolvedValueOnce({ records: [rec('r1')], total: 2 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveMore = resolve }))
    const restoreDeletedRecord = vi.fn()
    const { load, loadMore, restore } = useTrash(fakeClient({ list: listDeletedRecords, restore: restoreDeletedRecord }))
    await load('s1')
    const more = loadMore('s1')
    await expect(restore('r1', 's1')).resolves.toBe(false)
    expect(restoreDeletedRecord).not.toHaveBeenCalled()
    resolveMore!({ records: [rec('r2')], total: 2 })
    await more
  })

  it('restore removes the record, decrements total, returns true', async () => {
    const { records, total, load, restore } = useTrash(fakeClient())
    await load('s1')
    const ok = await restore('r1', 's1')
    expect(ok).toBe(true)
    expect(records.value.map((r) => r.recordId)).toEqual(['r2'])
    expect(total.value).toBe(1)
  })

  it('restore NEVER throws — surfaces error, returns false, list unchanged (e.g. 409 id occupied)', async () => {
    const c = fakeClient({ restore: vi.fn().mockRejectedValue(new Error('Record id is occupied, cannot restore: r1')) })
    const { error, restore, records, load } = useTrash(c)
    await load('s1')
    const ok = await restore('r1', 's1')
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

  it('ignores a late previous-sheet load instead of replacing the active deleted-record list', async () => {
    let resolveFirst: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    let resolveSecond: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    const listDeletedRecords = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { records, load } = useTrash(fakeClient({ list: listDeletedRecords }))
    const first = load('s1')
    const second = load('s2')
    resolveSecond!({ records: [rec('s2-current')], total: 1 })
    await second
    resolveFirst!({ records: [rec('s1-stale')], total: 1 })
    await first
    expect(records.value.map((row) => row.recordId)).toEqual(['s2-current'])
  })

  it('does not decrement the newly selected sheet after a stale restore completes', async () => {
    let resolveRestore: (() => void) | undefined
    const restoreDeletedRecord = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { resolveRestore = resolve }))
    const listDeletedRecords = vi.fn()
      .mockResolvedValueOnce({ records: [rec('r1')], total: 1 })
      .mockResolvedValueOnce({ records: [rec('s2-current')], total: 4 })
    const { records, total, load, restore } = useTrash(fakeClient({ list: listDeletedRecords, restore: restoreDeletedRecord }))
    await load('s1')
    const restoring = restore('r1', 's1')
    await load('s2')
    resolveRestore!()
    await restoring
    expect(records.value.map((row) => row.recordId)).toEqual(['s2-current'])
    expect(total.value).toBe(4)
  })

  it('pages the current server list until a selected history record is found', async () => {
    const listDeletedRecords = vi.fn()
      .mockResolvedValueOnce({ records: [rec('first-page')], total: 101 })
      .mockResolvedValueOnce({ records: [rec('selected-current')], total: 101 })
    const { records, loadSelected } = useTrash(fakeClient({ list: listDeletedRecords }))
    await expect(loadSelected('s1', 'selected-current')).resolves.toBe(true)
    expect(listDeletedRecords).toHaveBeenNthCalledWith(1, 's1', { limit: 100, offset: 0 })
    expect(listDeletedRecords).toHaveBeenNthCalledWith(2, 's1', { limit: 100, offset: 1 })
    expect(records.value.map((record) => record.recordId)).toEqual(['first-page', 'selected-current'])
  })

  it('reports a selected history record as unavailable after exhausting the current server list', async () => {
    const listDeletedRecords = vi.fn().mockResolvedValue({ records: [rec('current-only')], total: 1 })
    const { records, loadSelected } = useTrash(fakeClient({ list: listDeletedRecords }))
    await expect(loadSelected('s1', 'not-current')).resolves.toBe(false)
    expect(records.value.map((record) => record.recordId)).toEqual(['current-only'])
  })

  it('ignores a late selected-record scan after the user selects another history row', async () => {
    let resolveFirst: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    let resolveSecond: ((value: { records: MetaDeletedRecord[]; total: number }) => void) | undefined
    const listDeletedRecords = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { records, loadSelected } = useTrash(fakeClient({ list: listDeletedRecords }))
    const first = loadSelected('s1', 'first-selected')
    const second = loadSelected('s1', 'second-selected')
    resolveSecond!({ records: [rec('second-selected')], total: 1 })
    await expect(second).resolves.toBe(true)
    resolveFirst!({ records: [rec('first-selected')], total: 1 })
    await expect(first).resolves.toBe(false)
    expect(records.value.map((record) => record.recordId)).toEqual(['second-selected'])
  })

  it('fails closed when the restore reply identifies another record or sheet', async () => {
    const { error, records, load, restore } = useTrash(fakeClient({
      restore: vi.fn().mockResolvedValue({ restored: 'other-record', sheetId: 'other-sheet' }),
    }))
    await load('s1')
    await expect(restore('r1', 's1')).resolves.toBe(false)
    expect(error.value).toContain('did not match')
    expect(records.value.map((record) => record.recordId)).toEqual(['r1', 'r2'])
  })

  it('keeps a newer same-record restore pending when an earlier reset operation finally settles', async () => {
    let resolveFirst: ((value: { restored: string; sheetId: string }) => void) | undefined
    let resolveSecond: ((value: { restored: string; sheetId: string }) => void) | undefined
    const restoreDeletedRecord = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const { restoringIds, restore, reset } = useTrash(fakeClient({ restore: restoreDeletedRecord }))
    const first = restore('r1', 's1')
    reset()
    const second = restore('r1', 's1')
    resolveFirst!({ restored: 'r1', sheetId: 's1' })
    await first
    expect(restoringIds.value).toEqual(['r1'])
    resolveSecond!({ restored: 'r1', sheetId: 's1' })
    await expect(second).resolves.toBe(true)
    expect(restoringIds.value).toEqual([])
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
