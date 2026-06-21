/**
 * Global History & Point-in-Time Restore — T1b/T4 LOCK-3 security goldens (real DB).
 *
 * The base-level history center (GET /bases/:baseId/history/events[/:batchId]) is a project-on-read
 * projection over meta_record_revisions. These goldens pin the load-bearing LOCK-3 contract:
 *   - a row-level rule-denied record never leaks through the batch list, the total, or the visible
 *     affected counts (a batch whose every record is denied is invisible AND uncounted; a mixed batch
 *     reports only the visible record/field counts);
 *   - a field_permissions-denied FIELD on a row-readable record never leaks its id (changedFieldIds),
 *     value (detail.after), or count (visibleAffectedFieldCount) — masked surgically, the visible field
 *     of the same change still passes (the LOCK-3 field layer, parity with the per-record history route);
 *   - batch detail for a denied batch shares the SAME 404 shape as a missing batch (no existence oracle);
 *   - admin bypasses (row layer); flag-off is byte-inert;
 *   - a bulk action (shared batch_id) is ONE batch (the T1 acceptance), end-to-end through the projection.
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
const BASE_ID = `base_gh_${TS}`
const SHEET_ID = `sheet_gh_${TS}`
const STATUS = `fld_gh_status_${TS}`
const SALARY = `fld_gh_salary_${TS}` // a second field, field_permission-deniable (LOCK-3 field layer)
const REC_SECRET = `rec_gh_secret_${TS}`
const REC_PUBLIC = `rec_gh_public_${TS}`
const BULK_BATCH = `batch_gh_bulk_${TS}` // one bulk action touching BOTH records (shared id)
const SECRET_BATCH = `batch_gh_secret_${TS}` // a single-record action on the secret record only
const FIELD_BATCH = `batch_gh_field_${TS}` // a single-record action on REC_PUBLIC touching STATUS + SALARY
const USER_ID = `user_gh_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write']
let testRoles: string[] = ['member']

const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]

const events = (query: Record<string, unknown> = {}) =>
  request(app).get(`/api/multitable/bases/${BASE_ID}/history/events`).query({ limit: 100, ...query })
const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)
const batchIds = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }) =>
  (res.body?.data?.batches ?? []).map((b) => b.batchId)
const batchOf = (res: { body?: { data?: { batches?: Array<{ batchId: string }> } } }, id: string) =>
  (res.body?.data?.batches ?? []).find((b) => b.batchId === id) as
    | { batchId: string; visibleAffectedRecordCount: number; visibleAffectedFieldCount: number }
    | undefined

type ChangeShape = { recordId: string; changedFieldIds: string[]; after: Record<string, unknown> | null }
const changeOf = (res: { body?: { data?: { changes?: ChangeShape[] } } }, recordId: string) =>
  (res.body?.data?.changes ?? []).find((c) => c.recordId === recordId)

// A single-record action on the VISIBLE record touching BOTH fields (STATUS + SALARY). Added INSIDE the
// field-layer tests (after the beforeEach seed) so the existing total===2 assertions are not perturbed.
const mixedFieldRev = () =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
     VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', $3, ARRAY[$4,$5]::text[], '{}'::jsonb, $6::jsonb, $7)`,
    [SHEET_ID, REC_PUBLIC, USER_ID, STATUS, SALARY, JSON.stringify({ [STATUS]: 'public', [SALARY]: 99999 }), FIELD_BATCH],
  )
// field_permissions row hiding a field from the test user (subject_type='user'); afterEach clears it.
const denyFieldForUser = (fieldId: string) =>
  q(
    `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
     VALUES ($1,$2,'user',$3,false,false)`,
    [SHEET_ID, fieldId, USER_ID],
  )

const seed = async () => {
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  for (const [rid, status] of [[REC_SECRET, 'secret'], [REC_PUBLIC, 'public']] as const) {
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
      rid, SHEET_ID, JSON.stringify({ [STATUS]: status }),
    ])
  }
  const rev = (rid: string, batchId: string, status: string) =>
    q(
      `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
       VALUES (gen_random_uuid(), $1, $2, 1, 'update', 'rest', $3, ARRAY[$4]::text[], '{}'::jsonb, $5::jsonb, $6)`,
      [SHEET_ID, rid, USER_ID, STATUS, JSON.stringify({ [STATUS]: status }), batchId],
    )
  await rev(REC_SECRET, BULK_BATCH, 'secret')
  await rev(REC_PUBLIC, BULK_BATCH, 'public')
  await rev(REC_SECRET, SECRET_BATCH, 'secret')
}

describeIfDatabase('global-history events — LOCK-3 security goldens (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'GH Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'GH Sheet'])
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

  // The field layer toggles a field_permissions row; clear it after every test so the row-layer goldens
  // (which assume no field denial) stay isolated regardless of order.
  afterEach(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testPerms = ['multitable:read', 'multitable:write']
    testRoles = ['member']
    await setFlag(false)
    await setRules([])
    await seed()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('bulk action = ONE batch (T1 acceptance): flag OFF, BULK batch reports 2 visible records', async () => {
    const res = await events()
    expect(res.status).toBe(200)
    const ids = batchIds(res)
    expect(ids).toContain(BULK_BATCH)
    expect(ids).toContain(SECRET_BATCH)
    expect(res.body?.data?.total).toBe(2)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2) // two records, ONE batch
  })

  test('LOCK-3 list+count: flag ON + deny rule hides the all-denied batch and drops the denied record from a mixed batch', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const res = await events()
    expect(res.status).toBe(200)
    const ids = batchIds(res)
    expect(ids).not.toContain(SECRET_BATCH) // every record denied → batch invisible
    expect(ids).toContain(BULK_BATCH)
    expect(res.body?.data?.total).toBe(1) // post-permission-filter total — denied batch not counted
    // mixed batch: secret record dropped, only the public record + its field remain visible
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(1)
  })

  test('LOCK-3 detail: a rule-denied batch and a nonexistent batch return the SAME 404 shape (no existence oracle)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await detail(SECRET_BATCH)
    const missing = await detail(`batch_gh_does_not_exist_${TS}`)
    expect(denied.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(denied.body?.error?.code).toBe(missing.body?.error?.code)
    // the visible mixed batch still opens, showing only the non-denied record
    const ok = await detail(BULK_BATCH)
    expect(ok.status).toBe(200)
    expect(ok.body?.data?.visibleAffectedRecordCount).toBe(1)
    expect((ok.body?.data?.changes ?? []).every((c: { recordId: string }) => c.recordId !== REC_SECRET)).toBe(true)
  })

  test('admin bypass: flag ON + deny rule, an admin sees the denied batch and the full count', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin']
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2) // no records hidden from admin
    expect((await detail(SECRET_BATCH)).status).toBe(200)
  })

  test('flag OFF is inert: even with a deny rule authored, all batches and counts are visible', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    const res = await events()
    expect(batchIds(res)).toContain(SECRET_BATCH)
    expect(res.body?.data?.total).toBe(2)
    expect(batchOf(res, BULK_BATCH)?.visibleAffectedRecordCount).toBe(2)
  })

  // LOCK-3 FIELD layer. These two tests differ ONLY by the field_permissions denial row, on the SAME actor.
  // Test A is the false-green guard: it proves SALARY genuinely changed and is visible without a denial, so
  // Test B's absence assertions cannot pass vacuously.
  test('field layer (no denial = control): a mixed-field change reports BOTH fields and the value', async () => {
    await mixedFieldRev()
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(2) // STATUS + SALARY both visible
    const d = await detail(FIELD_BATCH)
    expect(d.status).toBe(200)
    const change = changeOf(d, REC_PUBLIC)
    expect(change?.changedFieldIds).toContain(SALARY) // field genuinely changed (guards against a vacuous pass)
    expect(change?.after?.[SALARY]).toBe(99999) // value present when the field is allowed
    expect(d.body?.data?.visibleAffectedFieldCount).toBe(2)
  })

  test('field layer (denial): a field_permissions-denied field is absent from changedFieldIds, after, and the field count', async () => {
    await mixedFieldRev()
    await denyFieldForUser(SALARY)
    const res = await events()
    expect(res.status).toBe(200)
    expect(batchOf(res, FIELD_BATCH)?.visibleAffectedFieldCount).toBe(1) // only STATUS counted — SALARY masked
    const d = await detail(FIELD_BATCH)
    expect(d.status).toBe(200)
    const change = changeOf(d, REC_PUBLIC)
    expect(change?.changedFieldIds).toEqual([STATUS]) // hidden field id absent
    expect(change?.after?.[SALARY]).toBeUndefined() // hidden value absent from the snapshot
    expect(change?.after?.[STATUS]).toBe('public') // visible field of the SAME change still passes (surgical)
    expect(d.body?.data?.visibleAffectedFieldCount).toBe(1) // detail count masked too
  })

  // ----- T2b field filter (post-mask, leak-free) -----

  test('T2b field filter: ?fieldId returns batches that touched a READABLE field', async () => {
    await mixedFieldRev()
    expect(batchIds(await events({ fieldId: STATUS }))).toContain(FIELD_BATCH)
    expect(batchIds(await events({ fieldId: SALARY }))).toContain(FIELD_BATCH) // SALARY readable here → matches
  })

  test('T2b field filter is LEAK-FREE: filtering by a field_permissions-denied field returns NO batch (post-mask)', async () => {
    await mixedFieldRev()
    await denyFieldForUser(SALARY)
    // The denied field is never in the batch's VISIBLE field set, so filtering by it yields nothing — the
    // actor cannot probe "which batches touched the hidden field". A readable field still filters normally.
    expect(batchIds(await events({ fieldId: SALARY }))).not.toContain(FIELD_BATCH)
    expect(batchIds(await events({ fieldId: STATUS }))).toContain(FIELD_BATCH)
  })
})
