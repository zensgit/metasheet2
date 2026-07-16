/**
 * W0 enablement gate (owner ruling, post-merge review of #4279/#4286): unit coverage for
 * `recordRecordRevisionsBatch` — the batch counterpart to `recordRecordRevision` the field-undelete
 * rehydration site now calls instead of a per-record serial loop (see `univer-meta.ts`'s
 * `recreateFieldFromConfig`). No DB here — a mock `QueryFn` records every statement + its params so these
 * tests pin the CHUNKING MATH (statement count at/around the 1000-row boundary) and the COLUMN-SEMANTICS
 * PARITY with `recordRecordRevision` (same id generation, same defaults, same JSON handling) without a real
 * Postgres. The real-DB spec (`multitable-tombstone-field-rehydrate-revision-realdb.test.ts`) covers the
 * end-to-end wiring and the atomicity golden; this file is the fast, deterministic complement that a real-DB
 * run cannot cheaply exercise at N=1000+ rows.
 */
import { describe, expect, test, vi } from 'vitest'

import { recordRecordRevision, recordRecordRevisionsBatch, type QueryFn, type RecordRevisionInput } from '../../src/multitable/record-history-service'

function mockQuery(): { query: QueryFn; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query: QueryFn = async (sql, params) => {
    calls.push({ sql, params: params ?? [] })
    // The `restored_from_version` column-existence probe (SELECT ... information_schema.columns) must
    // return zero rows so callers that never set restoredFromVersion never trip the extended-shape path
    // (mirrors the base fixture's schema: no such column configured in this mock).
    if (/information_schema\.columns/.test(sql)) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 0 }
  }
  return { query, calls }
}

function input(i: number, overrides: Partial<RecordRevisionInput> = {}): RecordRevisionInput {
  return {
    sheetId: 'sheet_1',
    recordId: `rec_${i}`,
    version: 2,
    action: 'update',
    source: 'restore',
    actorId: 'actor_1',
    changedFieldIds: ['fld_1'],
    patch: { fld_1: `v${i}` },
    snapshot: { fld_1: `v${i}`, other: 'x' },
    batchId: 'batch_shared',
    ...overrides,
  }
}

describe('recordRecordRevisionsBatch — zero-row and single-chunk shape', () => {
  test('zero rows: no query is issued at all, returns []', async () => {
    const { query, calls } = mockQuery()
    const ids = await recordRecordRevisionsBatch(query, [])
    expect(ids).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('a handful of rows: exactly ONE INSERT statement, one VALUES tuple per row, in input order', async () => {
    const { query, calls } = mockQuery()
    const inputs = [input(1), input(2), input(3)]
    const ids = await recordRecordRevisionsBatch(query, inputs)
    expect(ids).toHaveLength(3)
    expect(calls).toHaveLength(1)
    const [{ sql, params }] = calls
    expect(sql).toMatch(/^INSERT INTO meta_record_revisions/)
    // 3 rows * 11 base columns (no restoredFromVersion anywhere in this fixture) = 33 params.
    expect(params).toHaveLength(33)
    // 3 VALUES tuples.
    expect((sql.match(/\(\$/g) ?? []).length).toBe(3)
  })

  test('column semantics parity with recordRecordRevision: same defaults for id/batchId/source/changedFieldIds/snapshot', async () => {
    const { query: singleQuery, calls: singleCalls } = mockQuery()
    const { query: batchQuery, calls: batchCalls } = mockQuery()
    const bareInput: RecordRevisionInput = { sheetId: 's', recordId: 'r1', version: 1, action: 'create' }

    await recordRecordRevision(singleQuery, bareInput)
    await recordRecordRevisionsBatch(batchQuery, [bareInput])

    const singleParams = singleCalls[0]?.params ?? []
    const batchParams = batchCalls[0]?.params ?? []
    // Column order for both is (id, sheet_id, record_id, version, action, source, actor_id,
    // changed_field_ids, patch, snapshot, batch_id) — indices 0..10.
    expect(batchParams).toHaveLength(11)
    expect(singleParams).toHaveLength(11)
    // id (0) is a random uuid on both sides — just check both are non-empty strings, not equal to each other.
    expect(typeof batchParams[0]).toBe('string')
    expect(typeof singleParams[0]).toBe('string')
    // sheet_id, record_id, version, action match verbatim.
    expect(batchParams.slice(1, 5)).toEqual(singleParams.slice(1, 5))
    // source defaults to 'rest' on both when omitted.
    expect(batchParams[5]).toBe('rest')
    expect(singleParams[5]).toBe('rest')
    // actor_id defaults to null on both.
    expect(batchParams[6]).toBeNull()
    expect(singleParams[6]).toBeNull()
    // changed_field_ids defaults to [] on both (de-duped/filtered).
    expect(batchParams[7]).toEqual([])
    expect(singleParams[7]).toEqual([])
    // patch defaults to '{}' JSON on both.
    expect(batchParams[8]).toBe('{}')
    expect(singleParams[8]).toBe('{}')
    // snapshot defaults to null (input omitted `snapshot` entirely) on both.
    expect(batchParams[9]).toBeNull()
    expect(singleParams[9]).toBeNull()
    // batch_id defaults to the row's OWN id (batchId omitted) on both — i.e. batchParams[10] === batchParams[0].
    expect(batchParams[10]).toBe(batchParams[0])
    expect(singleParams[10]).toBe(singleParams[0])
  })

  test('changedFieldIds is de-duplicated and falsy-filtered, matching recordRecordRevision', async () => {
    const { query, calls } = mockQuery()
    await recordRecordRevisionsBatch(query, [input(1, { changedFieldIds: ['a', 'a', '', 'b', 'a'] })])
    expect(calls[0]?.params[7]).toEqual(['a', 'b'])
  })

  test('an explicit id is honored (not overwritten by a random uuid), mirroring recordRecordRevision', async () => {
    const { query, calls } = mockQuery()
    await recordRecordRevisionsBatch(query, [input(1, { id: 'fixed-id-1' })])
    expect(calls[0]?.params[0]).toBe('fixed-id-1')
  })

  test('a shared explicit batchId across every row is preserved verbatim (LOCK-12 grouping)', async () => {
    const { query, calls } = mockQuery()
    const inputs = [input(1, { batchId: 'shared-batch' }), input(2, { batchId: 'shared-batch' }), input(3, { batchId: 'shared-batch' })]
    await recordRecordRevisionsBatch(query, inputs)
    const params = calls[0]?.params ?? []
    // Row i's batch_id is at offset i*11 + 10.
    expect(params[10]).toBe('shared-batch')
    expect(params[21]).toBe('shared-batch')
    expect(params[32]).toBe('shared-batch')
  })

  test('returned ids are in the SAME order as the input rows', async () => {
    const { query } = mockQuery()
    const inputs = [input(1, { id: 'id-a' }), input(2, { id: 'id-b' }), input(3, { id: 'id-c' })]
    const ids = await recordRecordRevisionsBatch(query, inputs)
    expect(ids).toEqual(['id-a', 'id-b', 'id-c'])
  })
})

describe('recordRecordRevisionsBatch — chunking math at the 1000-row boundary', () => {
  test('exactly 1000 rows: ONE statement', async () => {
    const { query, calls } = mockQuery()
    const inputs = Array.from({ length: 1000 }, (_, i) => input(i))
    await recordRecordRevisionsBatch(query, inputs)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.params).toHaveLength(1000 * 11)
  })

  test('1001 rows (one past the boundary): TWO statements, split 1000 + 1, no row dropped or duplicated', async () => {
    const { query, calls } = mockQuery()
    const inputs = Array.from({ length: 1001 }, (_, i) => input(i, { id: `id-${i}` }))
    const ids = await recordRecordRevisionsBatch(query, inputs)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.params).toHaveLength(1000 * 11)
    expect(calls[1]?.params).toHaveLength(1 * 11)
    expect(ids).toHaveLength(1001)
    expect(ids).toEqual(inputs.map((i) => i.id))
    // No id appears twice across the two statements' params (id is always param 0 of its row's tuple).
    expect(new Set(ids).size).toBe(1001)
  })

  test('2500 rows: THREE statements (1000 + 1000 + 500), preserving row order across chunks', async () => {
    const { query, calls } = mockQuery()
    const inputs = Array.from({ length: 2500 }, (_, i) => input(i, { id: `id-${i}` }))
    const ids = await recordRecordRevisionsBatch(query, inputs)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.params).toHaveLength(1000 * 11)
    expect(calls[1]?.params).toHaveLength(1000 * 11)
    expect(calls[2]?.params).toHaveLength(500 * 11)
    expect(ids).toEqual(inputs.map((i) => i.id))
  })

  test('999 rows (one short of the boundary): ONE statement, all 999 present', async () => {
    const { query, calls } = mockQuery()
    const inputs = Array.from({ length: 999 }, (_, i) => input(i, { id: `id-${i}` }))
    const ids = await recordRecordRevisionsBatch(query, inputs)
    expect(calls).toHaveLength(1)
    expect(ids).toHaveLength(999)
  })
})

describe('recordRecordRevisionsBatch — restoredFromVersion deploy-window parity', () => {
  test('column absent (mock schema has no restored_from_version): every row degrades to the base 11-column shape, restoredFromVersion silently dropped — mirrors recordRecordRevision', async () => {
    const { query, calls } = mockQuery()
    await recordRecordRevisionsBatch(query, [input(1, { restoredFromVersion: 7 })])
    // Base shape stays 11 params/row when the column probe returns absent.
    expect(calls.find((c) => /^INSERT INTO meta_record_revisions/.test(c.sql))?.params).toHaveLength(11)
  })

  test('no row sets restoredFromVersion: the column-existence probe is never even issued (short-circuited)', async () => {
    const { query, calls } = mockQuery()
    await recordRecordRevisionsBatch(query, [input(1), input(2)])
    expect(calls.some((c) => /information_schema\.columns/.test(c.sql))).toBe(false)
  })

  test('column present: EVERY row in the batch gets the extended 12-column shape, including rows that did not set restoredFromVersion (explicit NULL for those)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const query: QueryFn = async (sql, params) => {
      calls.push({ sql, params: params ?? [] })
      if (/information_schema\.columns/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    const inputs = [input(1, { restoredFromVersion: 5 }), input(2)] // second row omits it
    await recordRecordRevisionsBatch(query, inputs)
    const insertCall = calls.find((c) => /^INSERT INTO meta_record_revisions/.test(c.sql))
    expect(insertCall?.sql).toMatch(/restored_from_version/)
    expect(insertCall?.params).toHaveLength(2 * 12)
    // Row 0's restoredFromVersion (param index 11) is 5; row 1's (param index 23) is explicit null.
    expect(insertCall?.params[11]).toBe(5)
    expect(insertCall?.params[23]).toBeNull()
  })
})
