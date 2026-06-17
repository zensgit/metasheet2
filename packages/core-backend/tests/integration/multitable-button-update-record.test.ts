/**
 * Real-DB integration for B1-S1 D0-B — update_record button (first RECORD-MUTATING
 * button action). The decision: NO ELEVATION — a click performs the update as the
 * CLICKING ACTOR through the same per-row gate a normal edit uses, so a button can
 * never mutate a row the clicker could not edit directly.
 *
 * The keystone (the wire-vs-fixture trap a mock can't prove): under sheet write-own,
 * the sheet-level `edit` capability is TRUE for every row, so only a real per-row
 * gate (ensureRecordWriteAllowed by created_by) stops a write-own user from updating
 * ANOTHER user's row via the button. Asserted against a real DB with real records.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { createMultitableButtonRoutes } from '../../src/routes/multitable-button'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_btnup_${TS}`
const SHEET_ID = `sheet_btnup_${TS}`
const FLD_TARGET = `fld_btnup_target_${TS}`
const FLD_BTN = `fld_btnup_btn_${TS}`
const FLD_RO = `fld_btnup_ro_${TS}` // field_permissions/intrinsic read-only
const FLD_FORMULA = `fld_btnup_formula_${TS}` // computed (always read-only)
const FLD_SELECT = `fld_btnup_select_${TS}` // select with options a/b
const FLD_BTN_RO = `fld_btnup_btnro_${TS}`
const FLD_BTN_FORMULA = `fld_btnup_btnformula_${TS}`
const FLD_BTN_SEL_BAD = `fld_btnup_btnselbad_${TS}`
const FLD_BTN_SEL_OK = `fld_btnup_btnselok_${TS}`
const REC_OWN = `rec_btnup_own_${TS}` // created_by = OWNER
const REC_OTHER = `rec_btnup_other_${TS}` // created_by = OTHER
const USER_EDITOR = `u_btnup_editor_${TS}` // global multitable:write → can edit any row
const USER_OWNER = `u_btnup_owner_${TS}` // sheet write-own, no global write → own rows only
const USER_OTHER = `u_btnup_other_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const runUrl = (recId: string) => `/api/multitable/sheets/${SHEET_ID}/records/${recId}/fields/${FLD_BTN}/button/run`
const runUrlBtn = (recId: string, btnId: string) => `/api/multitable/sheets/${SHEET_ID}/records/${recId}/fields/${btnId}/button/run`

function buildApp(userId: string, perms: string[]): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms, permissions: perms }
    next()
  })
  app.use('/api/multitable', createMultitableButtonRoutes())
  return app
}

const fieldValue = async (recId: string) =>
  ((await q('SELECT data FROM meta_records WHERE id = $1', [recId])).rows[0] as { data: Record<string, unknown> }).data[FLD_TARGET]

describeIfDatabase('B1-S1 D0-B update_record button — per-row no-elevation gate (real DB)', () => {
  beforeAll(async () => {
    const seedUser = (id: string, perms: string[]) =>
      q(
        `INSERT INTO users (id, email, password_hash, name, role, is_active, permissions)
         VALUES ($1,$2,'hash',$3,'user',true,$4::jsonb)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active, permissions = EXCLUDED.permissions`,
        [id, `${id}@example.test`, id, JSON.stringify(perms)],
      )
    await seedUser(USER_EDITOR, ['multitable:read', 'multitable:write'])
    await seedUser(USER_OWNER, ['multitable:read'])
    await seedUser(USER_OTHER, ['multitable:read'])

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'BtnUp Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'BtnUp Sheet'])
    // OWNER: sheet-scoped write-own, no global write → requiresOwnWriteRowPolicy true.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', USER_OWNER, 'spreadsheet:write-own'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_TARGET, SHEET_ID, 'Status', 'string', '{}', 1])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [FLD_BTN, SHEET_ID, 'Mark', 'button', JSON.stringify({ actionType: 'update_record', label: 'Mark', actionConfig: { fields: { [FLD_TARGET]: 'updated' } } }), 2],
    )
    // Field-level gate fixtures: a read-only field, a computed (formula) field, a select field, and a
    // button per case (each targeting a field the field-gate must reject or validate).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_RO, SHEET_ID, 'ReadOnly', 'string', JSON.stringify({ readonly: true }), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FORMULA, SHEET_ID, 'Calc', 'formula', JSON.stringify({ expression: '1+1' }), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SELECT, SHEET_ID, 'Stage', 'select', JSON.stringify({ options: [{ value: 'a' }, { value: 'b' }] }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_BTN_RO, SHEET_ID, 'BtnRO', 'button', JSON.stringify({ actionType: 'update_record', actionConfig: { fields: { [FLD_RO]: 'x' } } }), 6])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_BTN_FORMULA, SHEET_ID, 'BtnF', 'button', JSON.stringify({ actionType: 'update_record', actionConfig: { fields: { [FLD_FORMULA]: 'x' } } }), 7])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_BTN_SEL_BAD, SHEET_ID, 'BtnSB', 'button', JSON.stringify({ actionType: 'update_record', actionConfig: { fields: { [FLD_SELECT]: 'nope' } } }), 8])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_BTN_SEL_OK, SHEET_ID, 'BtnSO', 'button', JSON.stringify({ actionType: 'update_record', actionConfig: { fields: { [FLD_SELECT]: 'a' } } }), 9])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OWN, SHEET_ID, JSON.stringify({ [FLD_TARGET]: 'orig' }), USER_OWNER])
    await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [REC_OTHER, SHEET_ID, JSON.stringify({ [FLD_TARGET]: 'orig' }), USER_OTHER])
  })

  beforeEach(async () => {
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [REC_OWN, JSON.stringify({ [FLD_TARGET]: 'orig' })]).catch(() => {})
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [REC_OTHER, JSON.stringify({ [FLD_TARGET]: 'orig' })]).catch(() => {})
    await q('DELETE FROM multitable_button_run_dedup WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
  })

  afterAll(async () => {
    await q('DELETE FROM multitable_button_run_dedup WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM multitable_automation_executions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_EDITOR, USER_OWNER, USER_OTHER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('full writer clicks → the clicked record is updated + a button audit row is written', async () => {
    const res = await request(buildApp(USER_EDITOR, ['multitable:read', 'multitable:write'])).post(runUrl(REC_OTHER)).send({ requestId: `req-ed-${TS}` })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
    expect(await fieldValue(REC_OTHER)).toBe('updated')
    const audit = await q("SELECT count(*)::int AS n FROM multitable_automation_executions WHERE sheet_id = $1 AND triggered_by = 'button'", [SHEET_ID])
    expect((audit.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(1)
  })

  test('NO ELEVATION: a write-own user CANNOT update another user\'s row via the button → 403, no mutation', async () => {
    const res = await request(buildApp(USER_OWNER, ['multitable:read'])).post(runUrl(REC_OTHER)).send({ requestId: `req-own-other-${TS}` })
    expect(res.status).toBe(403)
    expect(await fieldValue(REC_OTHER)).toBe('orig') // untouched
  })

  test('write-own user CAN update their OWN row via the button → 200, updated', async () => {
    const res = await request(buildApp(USER_OWNER, ['multitable:read'])).post(runUrl(REC_OWN)).send({ requestId: `req-own-own-${TS}` })
    expect(res.status).toBe(200)
    expect(await fieldValue(REC_OWN)).toBe('updated')
  })

  // ── Field-level no-elevation: even a FULL writer (row gate passes) cannot write a field the normal
  //    PATCH path would reject, nor store an unvalidated value. ────────────────────────────────────
  test('NO FIELD ELEVATION: button targeting a READ-ONLY field → 403 FIELD_FORBIDDEN', async () => {
    const res = await request(buildApp(USER_EDITOR, ['multitable:read', 'multitable:write'])).post(runUrlBtn(REC_OTHER, FLD_BTN_RO)).send({ requestId: `req-ro-${TS}` })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FIELD_FORBIDDEN')
  })

  test('NO COMPUTED CORRUPTION: button targeting a formula field → 403, the row untouched', async () => {
    const res = await request(buildApp(USER_EDITOR, ['multitable:read', 'multitable:write'])).post(runUrlBtn(REC_OTHER, FLD_BTN_FORMULA)).send({ requestId: `req-f-${TS}` })
    expect(res.status).toBe(403)
    expect(await fieldValue(REC_OTHER)).toBe('orig')
  })

  test('VALUE VALIDATION: button writing an INVALID select option → 422, no mutation', async () => {
    const res = await request(buildApp(USER_EDITOR, ['multitable:read', 'multitable:write'])).post(runUrlBtn(REC_OTHER, FLD_BTN_SEL_BAD)).send({ requestId: `req-sb-${TS}` })
    expect(res.status).toBe(422)
    const data = ((await q('SELECT data FROM meta_records WHERE id = $1', [REC_OTHER])).rows[0] as { data: Record<string, unknown> }).data
    expect(data[FLD_SELECT]).toBeUndefined()
  })

  test('VALUE VALIDATION: button writing a VALID select option → 200, select updated', async () => {
    const res = await request(buildApp(USER_EDITOR, ['multitable:read', 'multitable:write'])).post(runUrlBtn(REC_OTHER, FLD_BTN_SEL_OK)).send({ requestId: `req-so-${TS}` })
    expect(res.status).toBe(200)
    const data = ((await q('SELECT data FROM meta_records WHERE id = $1', [REC_OTHER])).rows[0] as { data: Record<string, unknown> }).data
    expect(data[FLD_SELECT]).toBe('a')
  })
})
