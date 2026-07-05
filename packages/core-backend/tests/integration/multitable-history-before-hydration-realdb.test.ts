/**
 * Global History & Point-in-Time Restore — T1b `before`-image hydration goldens (real DB).
 *
 * `loadHistoryBatchDetail` (history-projection.ts) used to return `before: null` unconditionally. This
 * suite pins the hydrated contract:
 *   - update: `before` = the immediately-previous revision's snapshot for the SAME record (looked up via
 *     ONE extra batched query — see `loadPreviousSnapshots`), not the first-ever revision;
 *   - create: `before` stays null (no prior state);
 *   - delete: `before` = the delete revision's OWN snapshot column (record-service.ts `deleteRecord`
 *     captures the pre-delete state there BEFORE issuing the DELETE);
 *   - MASKING PARITY (the load-bearing invariant): `before` is filtered through the EXACT SAME
 *     `allowed` field-id set as `after` — a field_permissions-denied field never appears on either side,
 *     and stays out of `changedFieldIds` (post-mask, unwidened) — mirrors the field-mask discipline in
 *     `multitable-history-events-realdb.test.ts` / `multitable-record-history-field-mask.test.ts`.
 *
 * PR #3626 review gaps, closed here as goldens (f)/(g):
 *   - (f) retention-thinned history: `loadPreviousSnapshots` looks up the NEAREST SURVIVING prior
 *     revision (`version < t.version ORDER BY version DESC LIMIT 1`), not literally `version - 1`, because
 *     `sweepMetaRevisionRetention` (meta-revision-retention.ts) can prune the MIDDLE of a record's log. This
 *     pins the documented degradation: `before` silently resolves to an OLDER-than-immediate snapshot when
 *     the true immediate-prior row is gone — a future "fix" cannot silently change this without a red test.
 *   - (g) update with NO prior revision at all (hand-seeded first-ever row at version > 1, as if earlier
 *     history predates capture or was fully pruned): `before` must degrade to `null` (safe), never throw.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_t1b_${TS}`
const SHEET_ID = `sheet_t1b_${TS}`
const STATUS = `fld_t1b_status_${TS}`
const SALARY = `fld_t1b_salary_${TS}` // field_permission-deniable (masking-parity golden)
const USER_ID = `user_t1b_${TS}`

const REC_UPD = `rec_t1b_upd_${TS}` // 3 revisions: create(v1) -> update(v2) -> update(v3) — goldens (a) + (e)
const REC_CREATE = `rec_t1b_create_${TS}` // 1 revision: create(v1) — golden (c)
const REC_DELETE = `rec_t1b_delete_${TS}` // 3 revisions: create(v1) -> update(v2) -> delete(v3) — golden (d)
const REC_MASK = `rec_t1b_mask_${TS}` // 2 revisions: create(v1) -> update(v2), both fields — golden (b)
const REC_RETENTION = `rec_t1b_retention_${TS}` // create(v1)->update(v2, PRUNED)->update(v3) — golden (f)
const REC_NOPRIOR = `rec_t1b_noprior_${TS}` // hand-seeded lone update at v5, no v1..v4 — golden (g)

const UPDATE_BATCH = `batch_t1b_update_${TS}`
const CREATE_BATCH = `batch_t1b_create_${TS}`
const DELETE_BATCH = `batch_t1b_delete_${TS}`
const MASK_BATCH = `batch_t1b_mask_${TS}`
const RETENTION_BATCH = `batch_t1b_retention_${TS}`
const NOPRIOR_BATCH = `batch_t1b_noprior_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
const testPerms: string[] = ['multitable:read', 'multitable:write']
const testRoles: string[] = ['member']

const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)
type ChangeShape = {
  recordId: string
  action: string
  changedFieldIds: string[]
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}
const changeOf = (res: { body?: { data?: { changes?: ChangeShape[] } } }, recordId: string) =>
  (res.body?.data?.changes ?? []).find((c) => c.recordId === recordId)

// Own-batch revision insert (own batch_id = its own row id when `batchId` omitted), matching the write
// path's shapes exactly (record-service.ts / record-write-service.ts): `patch` carries only new values,
// `snapshot` carries the FULL post-action state (or, for `delete`, the pre-delete state it captured).
const insertRevision = (input: {
  recordId: string
  version: number
  action: 'create' | 'update' | 'delete'
  changedFieldIds: string[]
  snapshot: Record<string, unknown> | null
  batchId?: string
}) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'rest', $5, $6::text[], '{}'::jsonb, $7::jsonb, $8)`,
    [
      SHEET_ID,
      input.recordId,
      input.version,
      input.action,
      USER_ID,
      input.changedFieldIds,
      input.snapshot === null ? null : JSON.stringify(input.snapshot),
      input.batchId ?? null,
    ],
  )

const denyFieldForUser = (fieldId: string) =>
  q(
    `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
     VALUES ($1,$2,'user',$3,false,false)`,
    [SHEET_ID, fieldId, USER_ID],
  )

const seed = async () => {
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])

  // ----- REC_UPD: create(v1, STATUS='v1') -> update(v2, STATUS='v2') -> update(v3, STATUS='v3') -----
  // Goldens (a)+(e): detail(UPDATE_BATCH) exposes only v3; before must resolve to v2's snapshot (the
  // IMMEDIATELY previous revision), never v1's (the first) — v1/v2/v3 are all distinct values so a bug
  // that picks the wrong revision (or the current one) is caught, not vacuously passed.
  await insertRevision({ recordId: REC_UPD, version: 1, action: 'create', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'v1' } })
  await insertRevision({ recordId: REC_UPD, version: 2, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'v2' } })
  await insertRevision({ recordId: REC_UPD, version: 3, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'v3' }, batchId: UPDATE_BATCH })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [REC_UPD, SHEET_ID, JSON.stringify({ [STATUS]: 'v3' })])

  // ----- REC_CREATE: create(v1) only ----- golden (c): before stays null (no prior revision to find).
  await insertRevision({ recordId: REC_CREATE, version: 1, action: 'create', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'created' }, batchId: CREATE_BATCH })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_CREATE, SHEET_ID, JSON.stringify({ [STATUS]: 'created' })])

  // ----- REC_DELETE: create(v1, 'alive') -> update(v2, 'updated') -> delete(v3) -----
  // golden (d): the delete revision's OWN snapshot column already IS the pre-delete state ('updated', the
  // LAST state before deletion) — distinct from v1's 'alive' so a bug reusing the first snapshot is caught.
  await insertRevision({ recordId: REC_DELETE, version: 1, action: 'create', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'alive' } })
  await insertRevision({ recordId: REC_DELETE, version: 2, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'updated' } })
  await insertRevision({ recordId: REC_DELETE, version: 3, action: 'delete', changedFieldIds: [], snapshot: { [STATUS]: 'updated' }, batchId: DELETE_BATCH })
  // deleteRecord hard-deletes the live row; meta_records intentionally has none for REC_DELETE.

  // ----- REC_MASK: create(v1, STATUS='a', SALARY=1000) -> update(v2, STATUS='b', SALARY=2000) -----
  // golden (b): masking parity. detail(MASK_BATCH) exposes only v2.
  await insertRevision({ recordId: REC_MASK, version: 1, action: 'create', changedFieldIds: [STATUS, SALARY], snapshot: { [STATUS]: 'a', [SALARY]: 1000 } })
  await insertRevision({ recordId: REC_MASK, version: 2, action: 'update', changedFieldIds: [STATUS, SALARY], snapshot: { [STATUS]: 'b', [SALARY]: 2000 }, batchId: MASK_BATCH })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC_MASK, SHEET_ID, JSON.stringify({ [STATUS]: 'b', [SALARY]: 2000 })])

  // ----- REC_RETENTION: create(v1,'A') -> update(v2,'B') -> update(v3,'C'), then v2 is HARD-DELETED -----
  // golden (f): the direct DELETE below mimics EXACTLY what `sweepMetaRevisionRetention`
  // (meta-revision-retention.ts) does — it prunes non-latest rows of a record's log by id, never the
  // latest — so we reproduce its effect on the table without running the sweeper itself. detail(v3) must
  // resolve `before` to the NEAREST SURVIVING prior revision (v1='A'), not the true immediately-previous
  // v2 value ('B', now gone) — pins the documented degradation, not a crash or a silent wrong-value pick.
  await insertRevision({ recordId: REC_RETENTION, version: 1, action: 'create', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'A' } })
  await insertRevision({ recordId: REC_RETENTION, version: 2, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'B' } })
  await insertRevision({ recordId: REC_RETENTION, version: 3, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'C' }, batchId: RETENTION_BATCH })
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = 2', [SHEET_ID, REC_RETENTION])
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,3)', [REC_RETENTION, SHEET_ID, JSON.stringify({ [STATUS]: 'C' })])

  // ----- REC_NOPRIOR: hand-seeded lone update at version 5, no v1..v4 rows at all -----
  // golden (g): as if earlier history predates revision capture, or was fully pruned by retention. The
  // batched lookup finds zero candidates (no row with version < 5 for this record) — before must degrade
  // to null (safe), never throw, and `after` must still carry the masked snapshot.
  await insertRevision({ recordId: REC_NOPRIOR, version: 5, action: 'update', changedFieldIds: [STATUS], snapshot: { [STATUS]: 'onlyRevision' }, batchId: NOPRIOR_BATCH })
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,5)', [REC_NOPRIOR, SHEET_ID, JSON.stringify({ [STATUS]: 'onlyRevision' })])
}

describeIfDatabase('T1b before-image hydration goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'T1b Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'T1b Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET_ID, 'Salary', 'number', '{}', 2])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  afterEach(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('(a) update-action: before = prior value, after = new value (both sides real values)', async () => {
    const res = await detail(UPDATE_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_UPD)
    expect(change?.action).toBe('update')
    expect(change?.changedFieldIds).toContain(STATUS)
    expect(change?.before?.[STATUS]).toBe('v2')
    expect(change?.after?.[STATUS]).toBe('v3')
  })

  test('(e) multi-revision record: before reflects the IMMEDIATELY-previous revision, not the first', async () => {
    const res = await detail(UPDATE_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_UPD)
    expect(change?.before?.[STATUS]).not.toBe('v1') // would be the wrong (first) revision
    expect(change?.before?.[STATUS]).toBe('v2') // the correct (immediately previous) revision
  })

  test('(c) create-action: before is null', async () => {
    const res = await detail(CREATE_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_CREATE)
    expect(change?.action).toBe('create')
    expect(change?.before).toBeNull()
    expect(change?.after?.[STATUS]).toBe('created')
  })

  test('(d) delete-action: before = last snapshot (masked)', async () => {
    const res = await detail(DELETE_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_DELETE)
    expect(change?.action).toBe('delete')
    expect(change?.before?.[STATUS]).toBe('updated') // the LAST state before deletion, not the first ('alive')
  })

  test('(b) control (non-vacuous): with NO field denial, before+after both carry SALARY (genuine values)', async () => {
    const res = await detail(MASK_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_MASK)
    expect(change?.changedFieldIds).toEqual(expect.arrayContaining([STATUS, SALARY]))
    expect(change?.before?.[SALARY]).toBe(1000)
    expect(change?.after?.[SALARY]).toBe(2000)
  })

  test('(b) masking parity: a field-denied viewer gets NEITHER before nor after for that field, and it stays out of changedFieldIds', async () => {
    await denyFieldForUser(SALARY)
    const res = await detail(MASK_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_MASK)
    expect(change?.changedFieldIds).toEqual([STATUS]) // SALARY id absent
    expect(change?.before?.[SALARY]).toBeUndefined() // SALARY absent from before
    expect(change?.after?.[SALARY]).toBeUndefined() // SALARY absent from after (pre-existing contract)
    // the SAME change's other field is unaffected (surgical masking, not a wholesale drop)
    expect(change?.before?.[STATUS]).toBe('a')
    expect(change?.after?.[STATUS]).toBe('b')
  })

  test('(f) retention-thinned history: before resolves to the NEAREST SURVIVING prior revision, not the (now-pruned) immediate one', async () => {
    const res = await detail(RETENTION_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_RETENTION)
    expect(change?.action).toBe('update')
    expect(change?.before?.[STATUS]).toBe('A') // v1 (nearest surviving) — v2 ('B') was pruned by the sweep
    expect(change?.after?.[STATUS]).toBe('C')
  })

  test('(g) update with no prior revision at all: before is null (safe degradation), after still resolves, nothing throws', async () => {
    const res = await detail(NOPRIOR_BATCH)
    expect(res.status).toBe(200)
    const change = changeOf(res, REC_NOPRIOR)
    expect(change?.action).toBe('update')
    expect(change?.before).toBeNull()
    expect(change?.after?.[STATUS]).toBe('onlyRevision')
  })
})
