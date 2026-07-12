/**
 * all-tables-B (R11) — batch-detail `fieldNames` masked cross-table field-name map (real DB).
 *
 * The History Center's all-tables mode shows changes from MANY sheets in one batch, but the FE `fields` prop
 * only carries the ACTIVE sheet's fields, so a change row on a non-active sheet fell back to a raw field id.
 * `loadHistoryBatchDetail` now emits `fieldNames: { [sheetId]: { [fieldId]: name } }` for the fields that
 * appear in the batch's (post-mask) changes, reusing the SAME per-sheet allow-set the VALUE masking uses.
 *
 * The load-bearing security claim (this file's reason to exist): a field NAME is as sensitive as its value,
 * evaluated PER the field's own sheet (the #4007 lesson — TWO independent layers: property-hidden AND
 * per-subject RBAC field_permissions). So `fieldNames` must NEVER carry:
 *   (1) a layer-2 property-hidden field's name (sheet A here), NOR
 *   (2) a layer-3 field_permissions-denied field's name (sheet B here),
 * even though both fields ARE listed in the raw `changed_field_ids`. One golden per layer, on a DIFFERENT
 * sheet each, so a regression that masks one layer but not the other is caught.
 *
 * The masking here is redundant defense-in-depth: (i) `involvedFieldsBySheet` accumulates from the POST-mask
 * `fields`, and (ii) the name loop re-checks `allowed.has`. Breaking EITHER alone still blocks the leak (the
 * other guard catches it); only breaking BOTH — raw pre-mask accumulation AND no re-check — surfaces
 * `AlphaSecret` / `BetaSecret`. The whole-body assertion at the end pins that neither string can appear
 * anywhere in the response (verified: only the both-broken mutation reds these three tests).
 *
 * Runs only with DATABASE_URL. (plugin-tests.yml whitelist.)
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_atb_${TS}`
const SHEET_A = `sheet_atb_a_${TS}`
const SHEET_B = `sheet_atb_b_${TS}`
const OK_A = `fld_atb_oka_${TS}` // sheet A, readable
const HIDDEN_A = `fld_atb_hida_${TS}` // sheet A, LAYER-2 property-hidden
const OK_B = `fld_atb_okb_${TS}` // sheet B, readable
const DENIED_B = `fld_atb_denb_${TS}` // sheet B, LAYER-3 field_permissions-denied
const REC_A = `rec_atb_a_${TS}`
const REC_B = `rec_atb_b_${TS}`
const BATCH = `batch_atb_${TS}`
const USER_ID = `user_atb_${TS}`
const OK_A_NAME = 'Alpha'
const HIDDEN_A_NAME = 'AlphaSecret'
const OK_B_NAME = 'Beta'
const DENIED_B_NAME = 'BetaSecret'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express

const detail = (batchId: string) => request(app).get(`/api/multitable/bases/${BASE_ID}/history/events/${batchId}`)

const insertRevision = (sheetId: string, recordId: string, changedFieldIds: string[], snapshot: Record<string, unknown>) =>
  q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id)
     VALUES (gen_random_uuid(), $1, $2, 2, 'update', 'rest', $3, $4::text[], '{}'::jsonb, $5::jsonb, $6)`,
    [sheetId, recordId, USER_ID, changedFieldIds, JSON.stringify(snapshot), BATCH],
  )

describeIfDatabase('all-tables-B — batch-detail fieldNames masked cross-table map (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: USER_ID, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [USER_ID])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'AllTablesB Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_A, BASE_ID, 'Sheet A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B, BASE_ID, 'Sheet B'])
    // Sheet A: OK_A readable, HIDDEN_A layer-2 property-hidden.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [OK_A, SHEET_A, OK_A_NAME, 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [HIDDEN_A, SHEET_A, HIDDEN_A_NAME, 'select', '{"hidden":true}', 2])
    // Sheet B: OK_B readable, DENIED_B layer-3 field_permissions-denied for USER_ID.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [OK_B, SHEET_B, OK_B_NAME, 'select', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [DENIED_B, SHEET_B, DENIED_B_NAME, 'select', '{}', 2])
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`,
      [SHEET_B, DENIED_B, USER_ID],
    )
    // ONE batch spanning both sheets; each change lists a readable AND an unreadable field in changed_field_ids.
    await insertRevision(SHEET_A, REC_A, [OK_A, HIDDEN_A], { [OK_A]: 'a-visible', [HIDDEN_A]: 'a-secret-value' })
    await insertRevision(SHEET_B, REC_B, [OK_B, DENIED_B], { [OK_B]: 'b-visible', [DENIED_B]: 'b-secret-value' })
  })

  afterAll(async () => {
    for (const sheet of [SHEET_A, SHEET_B]) {
      await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheet]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheet]).catch(() => {})
    }
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('fieldNames is present, shaped {sheetId:{fieldId:name}}, and covers both involved sheets', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const fieldNames = res.body?.data?.fieldNames
    expect(fieldNames && typeof fieldNames === 'object').toBe(true)
    // both involved sheets appear
    expect(Object.keys(fieldNames).sort()).toEqual([SHEET_A, SHEET_B].sort())
    // values are strings
    for (const sheetId of Object.keys(fieldNames)) for (const name of Object.values(fieldNames[sheetId])) expect(typeof name).toBe('string')
  })

  test('(1) layer-2 property-hidden field NAME never appears (sheet A)', async () => {
    const res = await detail(BATCH)
    const a = res.body?.data?.fieldNames?.[SHEET_A]
    expect(a[OK_A]).toBe(OK_A_NAME) // readable name present
    expect(a).not.toHaveProperty(HIDDEN_A) // hidden field's id/name absent
    // and the CHANGED-field-id set is masked to the readable field only (existing LOCK-3 behaviour)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC_A)
    expect(change?.changedFieldIds).toEqual([OK_A])
  })

  test('(2) layer-3 field_permissions-denied field NAME never appears (sheet B)', async () => {
    const res = await detail(BATCH)
    const b = res.body?.data?.fieldNames?.[SHEET_B]
    expect(b[OK_B]).toBe(OK_B_NAME)
    expect(b).not.toHaveProperty(DENIED_B)
    const change = (res.body?.data?.changes ?? []).find((c: any) => c.recordId === REC_B)
    expect(change?.changedFieldIds).toEqual([OK_B])
  })

  test('whole-body: neither hidden nor denied field name leaks anywhere in the response', async () => {
    const res = await detail(BATCH)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(HIDDEN_A_NAME)
    expect(body).not.toContain(DENIED_B_NAME)
    // the readable names DO appear (proves the assertion above isn't vacuous)
    expect(body).toContain(OK_A_NAME)
    expect(body).toContain(OK_B_NAME)
  })

  test('fieldTypes mirrors fieldNames — same masked set; a hidden/denied field TYPE never leaks either', async () => {
    const res = await detail(BATCH)
    expect(res.status).toBe(200)
    const fieldNames = res.body?.data?.fieldNames
    const fieldTypes = res.body?.data?.fieldTypes
    expect(fieldTypes && typeof fieldTypes === 'object').toBe(true)

    // fieldTypes covers EXACTLY the same (sheet, field) pairs fieldNames does — same masked allow-set.
    // If it could describe a field fieldNames cannot name, it would be a second, weaker mask.
    expect(Object.keys(fieldTypes).sort()).toEqual(Object.keys(fieldNames).sort())
    for (const sheetId of Object.keys(fieldNames)) {
      expect(Object.keys(fieldTypes[sheetId]).sort()).toEqual(Object.keys(fieldNames[sheetId]).sort())
    }

    // the readable fields DO carry a type (non-vacuous)
    expect(fieldTypes[SHEET_A]?.[OK_A]).toBeTruthy()
    expect(fieldTypes[SHEET_B]?.[OK_B]).toBeTruthy()

    // LOCK-3: the layer-2 property-hidden and layer-3 denied fields have NO type entry — the same
    // exclusion their NAMES get. A type is metadata about a field the actor cannot read.
    expect(fieldTypes[SHEET_A]?.[HIDDEN_A]).toBeUndefined()
    expect(fieldTypes[SHEET_B]?.[DENIED_B]).toBeUndefined()
  })
})
