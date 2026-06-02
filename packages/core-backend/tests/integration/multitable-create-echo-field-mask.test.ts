/**
 * Real-DB integration test for F4 — POST /records create-echo field mask.
 * Design-lock: docs/development/multitable-record-egress-fieldperm-inventory-20260529.md (#2106) §3 F4.
 *
 * `POST /records` echoes the created record's `result.data` UNMASKED (`univer-meta.ts`, create handler).
 * The create write gate is layer-2 only (`canCreateRecord` + `isFieldAlwaysReadOnly`; `createRecord` never
 * consults field_permissions), so:
 *   - a `field_permissions.visible=false` non-readonly field is WRITABLE → the creator can supply it and the
 *     echo hands it back (write-only-no-read, R1 — the F3-parallel principle: a read-gated echo must omit it
 *     even when the caller wrote it); and
 *   - a SERVER-ASSIGNED value on a denied field — e.g. an auto-number the creator never supplied — is echoed
 *     back as genuinely new info (R2, the unambiguous leak).
 * F4 applies the layer-2 ∧ layer-3 mask (the #2028 composite) to the create echo, leaving the write untouched.
 *
 * Seed non-negotiable: FLD_SECRET/FLD_AUTONUM.property carry no `hidden` → deny is solely layer-3.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_f4_${TS}`
const SHEET_ID = `sheet_f4_${TS}`
const FLD_VISIBLE = `fld_f4_visible_${TS}` // string, readable — positive control
const FLD_SECRET = `fld_f4_secret_${TS}` // string, layer-3-denied — write-only-no-read (R1)
const FLD_AUTONUM = `fld_f4_auto_${TS}` // autoNumber, layer-3-denied — server-assigned leak (R2)
const USER_ID = `u_f4_${TS}` // FLD_SECRET + FLD_AUTONUM denied
const USER_ID_2 = `u_f4_other_${TS}` // no deny → positive control

let app: Express
let currentUser: { id: string; roles: string[]; perms: string[] } = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const createReq = (body: Record<string, unknown>) => request(app).post('/api/multitable/records').send(body)
const dbField = async (recordId: string, fieldId: string) => {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  return ((r.rows[0]?.data ?? {}) as Record<string, unknown>)[fieldId]
}

describeIfDatabase('F4 create-echo field mask (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = currentUser; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'F4 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'F4 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VISIBLE, SHEET_ID, 'Visible', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_AUTONUM, SHEET_ID, 'Auto', 'autoNumber', '{}', 3])
    // layer-3 read deny (subject-scoped); property carries no hidden so the deny is solely here.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_AUTONUM, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('R1 (write-only-no-read): creating with a denied field → write persists but the create echo omits it', async () => {
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
    const canary = `do-not-leak-f4-create-${TS}`
    const res = await createReq({ sheetId: SHEET_ID, data: { [FLD_VISIBLE]: 'r1-vis', [FLD_SECRET]: canary } })
    expect(res.status).toBe(200)
    const rec = res.body.data.record
    expect(rec.data[FLD_VISIBLE]).toBe('r1-vis') // positive control
    expect(rec.data[FLD_SECRET]).toBeUndefined() // THE LEAK (RED pre-fix)
    expect(rec.data[FLD_AUTONUM]).toBeUndefined() // server-assigned but denied → also omitted
    expect(JSON.stringify(res.body)).not.toContain(canary)
    expect(await dbField(rec.id, FLD_SECRET)).toBe(canary) // ...but the write really happened — mask is echo-only
  })

  test('R2 (server-assigned leak): a denied AUTO-NUMBER the creator never supplied is omitted from the echo (but assigned in DB)', async () => {
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
    const res = await createReq({ sheetId: SHEET_ID, data: { [FLD_VISIBLE]: 'r2-vis' } }) // FLD_AUTONUM NOT supplied
    expect(res.status).toBe(200)
    const rec = res.body.data.record
    expect(rec.data[FLD_VISIBLE]).toBe('r2-vis')
    expect(rec.data[FLD_AUTONUM]).toBeUndefined() // THE LEAK (RED pre-fix): server-assigned, creator can't read it
    expect(await dbField(rec.id, FLD_AUTONUM)).toBeDefined() // ...the auto-number WAS assigned, just masked from the echo
  })

  test('R3 (positive): an ungranted-to-deny user gets the denied + auto-number values back (mask is per-subject)', async () => {
    currentUser = { id: USER_ID_2, roles: ['member'], perms: ['multitable:write'] }
    const canary = `f4-other-${TS}`
    const res = await createReq({ sheetId: SHEET_ID, data: { [FLD_VISIBLE]: 'r3-vis', [FLD_SECRET]: canary } })
    expect(res.status).toBe(200)
    const rec = res.body.data.record
    expect(rec.data[FLD_SECRET]).toBe(canary)
    expect(rec.data[FLD_AUTONUM]).toBeDefined()
    currentUser = { id: USER_ID, roles: ['member'], perms: ['multitable:write'] }
  })
})
