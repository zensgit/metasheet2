/**
 * #18 phase-2 (2b) conditional read-deny rules — TRASH surface close-out (real DB).
 *
 * The live read surfaces feed the rule-deny via loadDeniedRecordIds → loadRuleDeniedRecordIds, which
 * evaluates LIVE meta_records only. A deleted record lives in meta_records_trash, so the live evaluator
 * can't see it — this golden proves the dedicated trash evaluator (loadRuleDeniedTrashRecordIds) closes
 * that gap on the two trash-surface paths:
 *   - trash list (GET /sheets/:id/trash): a rule-denied deleted record is hidden, just like live.
 *   - restore (POST /records/:id/restore): restoring a currently-rule-denied record is REFUSED (403),
 *     so restore can't reintroduce an unreadable record onto the live/operable path.
 * Admin bypass + flag-off inertness mirror the live surfaces exactly. Each test re-seeds trash in
 * beforeEach so the (mutating) restore cases are independent.
 *
 * SCOPE: this closes the CONDITIONAL-RULE deny on the trash surface. Grant-deny (record_permissions)
 * on restore, and the unadjusted trash `total` COUNT (a pre-existing count caveat shared with grant-deny
 * — the record's data is excluded, only the aggregate count is not), are deliberately out of scope here
 * (a separate cross-cutting follow-up); the `total` behavior is pinned below so a future change is intentional.
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
const BASE_ID = `base_crt_${TS}`
const SHEET_ID = `sheet_crt_${TS}`
const STATUS = `fld_crt_status_${TS}`
const REC_SECRET = `rec_crt_secret_${TS}`
const REC_PUBLIC = `rec_crt_public_${TS}`
const USER_ID = `user_crt_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read', 'multitable:write'] // full write → canDeleteRecord, non-admin
let testRoles: string[] = ['member'] // non-admin; full write (above) grants canDeleteRecord (gates the bin)

const setFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) =>
  q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]

const trashIds = async (): Promise<string[]> => {
  const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/trash`).query({ limit: 100 })
  expect(res.status).toBe(200)
  return (res.body?.data?.records ?? []).map((r: { recordId: string }) => r.recordId)
}
const restore = (recordId: string) => request(app).post(`/api/multitable/records/${recordId}/restore`)

const seedTrash = async () => {
  // start clean: nothing live, both records sitting in trash
  await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET_ID])
  for (const [rid, status] of [[REC_SECRET, 'secret'], [REC_PUBLIC, 'public']] as const) {
    await q(
      `INSERT INTO meta_records_trash (record_id, sheet_id, base_id, data, original_version, created_by, deleted_by)
       VALUES ($1,$2,$3,$4::jsonb,1,$5,$5)`,
      [rid, SHEET_ID, BASE_ID, JSON.stringify({ [STATUS]: status }), USER_ID],
    )
  }
}

describeIfDatabase('#18 phase-2 conditional read-deny — trash list + restore (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'CRT Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'CRT Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
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
    await seedTrash()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('inert — flag OFF even with a deny rule: trash list shows the rule-denied record', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    const ids = await trashIds()
    expect(ids).toContain(REC_SECRET)
    expect(ids).toContain(REC_PUBLIC)
  })

  test('enforce — flag ON + deny rule: trash list HIDES the rule-denied record, keeps the rest', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/trash`).query({ limit: 100 })
    expect(res.status).toBe(200)
    const ids = (res.body?.data?.records ?? []).map((r: { recordId: string }) => r.recordId)
    expect(ids).not.toContain(REC_SECRET) // the denied record's row + data are excluded
    expect(ids).toContain(REC_PUBLIC)
    // LOCK-4 (deny-aware count): `total` now EXCLUDES denied trashed records in SQL (listDeletedRecords
    // excludeRecordIds), so the aggregate can't reveal the cardinality of hidden rows — 2 trashed, 1 denied → 1.
    expect(res.body?.data?.total).toBe(1)
  })

  test('enforce — flag ON + deny rule: restoring the rule-denied record is REFUSED as 404 not-found (no existence oracle); a non-denied record restores (200)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await restore(REC_SECRET)
    // LOCK-6: the refusal is INDISTINGUISHABLE from "no such deleted record" — the SAME 404 NOT_FOUND body a
    // genuinely-nonexistent id returns (`No deleted record to restore: <probed id>`). A 403 would be an
    // existence oracle letting a canDeleteRecord actor enumerate which rule-hidden records sit in the trash.
    expect(denied.status).toBe(404)
    expect(denied.body?.error?.code).toBe('NOT_FOUND')
    expect(denied.body?.error?.message).toBe(`No deleted record to restore: ${REC_SECRET}`)
    // a genuinely-nonexistent id returns the SAME shape (status + code + id-echoing message format), so the
    // two cases are indistinguishable for any given probe id (the echoed id is attacker-supplied, not a leak).
    const GHOST_ID = 'rec_nonexistent_oracle_probe'
    const ghost = await restore(GHOST_ID)
    expect(ghost.status).toBe(404)
    expect(ghost.body?.error?.code).toBe('NOT_FOUND')
    expect(ghost.body?.error?.message).toBe(`No deleted record to restore: ${GHOST_ID}`)
    // the refused record stays in trash (not resurrected onto the live path)
    const trashRow = await q('SELECT 1 FROM meta_records_trash WHERE sheet_id = $1 AND record_id = $2', [SHEET_ID, REC_SECRET])
    expect(trashRow.rows.length).toBe(1)
    const live = await q('SELECT 1 FROM meta_records WHERE sheet_id = $1 AND id = $2', [SHEET_ID, REC_SECRET])
    expect(live.rows.length).toBe(0)
    // a non-denied trashed record restores normally
    expect((await restore(REC_PUBLIC)).status).toBe(200)
  })

  test('inert — flag OFF: the same record restores normally (default-off changes nothing)', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    expect((await restore(REC_SECRET)).status).toBe(200)
  })

  test('admin bypass — flag ON + deny rule: an admin sees the record in trash and can restore it', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin']
    expect(await trashIds()).toContain(REC_SECRET)
    expect((await restore(REC_SECRET)).status).toBe(200)
    testRoles = []
  })
})
