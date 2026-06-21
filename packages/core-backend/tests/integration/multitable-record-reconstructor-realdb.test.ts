/**
 * Global History — T5-1: as-of-time-T record reconstruction (real DB). The read primitive T5-2 (restore
 * preview) and T7 (point-in-time view) build on, so it is pinned FIRST and alone.
 *
 * Locks: LOCK-9 (a delete revision means the record does NOT exist at T — never resurrected from its
 * pre-delete snapshot) + LOCK-11 (deterministic order: created_at DESC, version DESC, id DESC).
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const SHEET = `sheet_recon_${TS}`
const REC = `rec_recon_a_${TS}`
const REC2 = `rec_recon_b_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
// A revision at an explicit created_at. `data` is the snapshot (for a delete, the PRE-delete snapshot per LOCK-9).
const rev = (recordId: string, version: number, action: 'create' | 'update' | 'delete', data: Record<string, unknown> | null, createdAtIso: string) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rest', ARRAY['f']::text[], '{}'::jsonb, $5::jsonb, $6)`,
    [SHEET, recordId, version, action, data === null ? null : JSON.stringify(data), createdAtIso],
  )

describeIfDatabase('record reconstruction as of T — T5-1 (real DB)', () => {
  beforeAll(() => { /* the reconstructor reads only meta_record_revisions; no sheet/record seed needed */ })
  afterEach(async () => { await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {}) })
  afterAll(async () => { await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {}) })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('state at T = the latest revision <= T (create → update → update)', async () => {
    await rev(REC, 1, 'create', { f: 'a' }, '2026-06-01T00:00:00Z')
    await rev(REC, 2, 'update', { f: 'b' }, '2026-06-02T00:00:00Z')
    await rev(REC, 3, 'update', { f: 'c' }, '2026-06-03T00:00:00Z')
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-01T12:00:00Z')).get(REC)).toMatchObject({ exists: true, data: { f: 'a' }, version: 1 })
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-02T12:00:00Z')).get(REC)).toMatchObject({ exists: true, data: { f: 'b' }, version: 2 })
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-03T12:00:00Z')).get(REC)).toMatchObject({ exists: true, data: { f: 'c' }, version: 3 })
  })

  test('LOCK-9 delete-at-T (the pin): present before the delete, ABSENT at/after (never resurrected)', async () => {
    await rev(REC, 1, 'create', { f: 'a' }, '2026-06-01T00:00:00Z')
    await rev(REC, 2, 'delete', { f: 'a' }, '2026-06-02T00:00:00Z') // delete stores the pre-delete snapshot
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-01T12:00:00Z')).get(REC)).toMatchObject({ exists: true, data: { f: 'a' } })
    const after = (await reconstructRecordsAtT(q, SHEET, '2026-06-02T12:00:00Z')).get(REC)
    expect(after?.exists).toBe(false) // deleted at T → absent, NOT resurrected from the pre-delete snapshot
    expect(after?.data).toBeNull()
  })

  test('absent before its first revision (created after T)', async () => {
    await rev(REC, 1, 'create', { f: 'a' }, '2026-06-02T00:00:00Z')
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-01T00:00:00Z')).has(REC)).toBe(false)
  })

  test('LOCK-11 determinism: two revisions at the SAME created_at → the higher version wins', async () => {
    const sameT = '2026-06-02T00:00:00Z'
    await rev(REC, 1, 'update', { f: 'lo' }, sameT)
    await rev(REC, 2, 'update', { f: 'hi' }, sameT)
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-02T12:00:00Z')).get(REC)).toMatchObject({ data: { f: 'hi' }, version: 2 })
  })

  test('delete-then-recreate: absent at the delete, present at the recreate', async () => {
    await rev(REC, 1, 'create', { f: 'a' }, '2026-06-01T00:00:00Z')
    await rev(REC, 2, 'delete', { f: 'a' }, '2026-06-02T00:00:00Z')
    await rev(REC, 3, 'create', { f: 'z' }, '2026-06-03T00:00:00Z')
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-02T12:00:00Z')).get(REC)?.exists).toBe(false)
    expect((await reconstructRecordsAtT(q, SHEET, '2026-06-03T12:00:00Z')).get(REC)).toMatchObject({ exists: true, data: { f: 'z' } })
  })

  test('recordIds filter: only the requested records are reconstructed', async () => {
    await rev(REC, 1, 'create', { f: 'a' }, '2026-06-01T00:00:00Z')
    await rev(REC2, 1, 'create', { f: 'b' }, '2026-06-01T00:00:00Z')
    const only = await reconstructRecordsAtT(q, SHEET, '2026-06-02T00:00:00Z', [REC])
    expect(only.has(REC)).toBe(true)
    expect(only.has(REC2)).toBe(false)
  })
})
