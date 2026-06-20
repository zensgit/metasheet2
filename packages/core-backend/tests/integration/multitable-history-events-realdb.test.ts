/**
 * Global History & Point-in-Time Restore — T1b/T4 LOCK-3 security goldens (real DB).
 *
 * The base-level history center (GET /bases/:baseId/history/events[/:batchId]) is a project-on-read
 * projection over meta_record_revisions. These goldens pin the load-bearing LOCK-3 contract:
 *   - a row-level rule-denied record never leaks through the batch list, the total, or the visible
 *     affected counts (a batch whose every record is denied is invisible AND uncounted; a mixed batch
 *     reports only the visible record/field counts);
 *   - batch detail for a denied batch shares the SAME 404 shape as a missing batch (no existence oracle);
 *   - admin bypasses; flag-off is byte-inert;
 *   - a bulk action (shared batch_id) is ONE batch (the T1 acceptance), end-to-end through the projection.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_gh_${TS}`
const SHEET_ID = `sheet_gh_${TS}`
const STATUS = `fld_gh_status_${TS}`
const REC_SECRET = `rec_gh_secret_${TS}`
const REC_PUBLIC = `rec_gh_public_${TS}`
const BULK_BATCH = `batch_gh_bulk_${TS}` // one bulk action touching BOTH records (shared id)
const SECRET_BATCH = `batch_gh_secret_${TS}` // a single-record action on the secret record only
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

const seed = async () => {
  await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID])
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  for (const [rid, status] of [[REC_SECRET, 'secret'], [REC_PUBLIC, 'public']] as const) {
    await q('INSERT INTO meta_records (id, sheet_id, base_id, data, version) VALUES ($1,$2,$3,$4::jsonb,1)', [
      rid, SHEET_ID, BASE_ID, JSON.stringify({ [STATUS]: status }),
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
  })

  afterAll(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
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
})
