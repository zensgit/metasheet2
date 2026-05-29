/**
 * Real-DB integration test for the formula dry-run endpoint (#5a, design #1860):
 * POST /api/multitable/sheets/:sheetId/formula/dry-run.
 * Confirms the canManageFields gate, structural caps, and the happy path. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_dry_${TS}`
const SHEET_ID = `sheet_dry_${TS}`
// Field IDs are namespaced `fld_dry_*` (like base_dry_/sheet_dry_) so they can never collide with a
// sibling integration test's fixtures in the shared real-DB run — multitable-view-aggregate.test.ts
// also derives `fld_secret_${TS}` and meta_fields.id is a global PK (the TS alone is not collision-safe).
const FLD_A = `fld_dry_a_${TS}`
const FLD_B = `fld_dry_b_${TS}`
const FLD_SECRET = `fld_dry_secret_${TS}` // #5c: field the requesting user is denied (field_permissions.visible=false)
const FLD_HIDDEN = `fld_dry_hidden_${TS}` // #5c: statically hidden field (property.hidden=true) — second mask channel
const FLD_LOOKUP = `fld_dry_lookup_${TS}` // #5c: lookup field — never persisted in raw record data
const REC_ID = `rec_dry_${TS}`
const USER_ID = `u_dry_${TS}`
const SECRET_CANARY = 'do-not-leak-canary' // #5c: proves a field_permissions-denied field never leaks
const HIDDEN_CANARY = 'do-not-leak-hidden' // #5c: proves a property.hidden field never leaks

let app: Express
let testPerms: string[] = ['multitable:write'] // canManageFields requires multitable:write
let testUserId: string = USER_ID // #5c: mutable so a test can drop the user to assert 401
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const post = (body: unknown) => request(app).post(`/api/multitable/sheets/${SHEET_ID}/formula/dry-run`).send(body as object)

describeIfDatabase('multitable formula dry-run (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = testUserId ? { id: testUserId, roles: [], perms: testPerms } : undefined; next() })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE_ID, 'Dry Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET_ID, BASE_ID, 'Dry Sheet'])
    for (const [fid, name, order] of [[FLD_A, 'A', 1], [FLD_B, 'B', 2]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, SHEET_ID, name, 'number', '{}', order])
    }
    // #5c real-record sampling fixtures:
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRET, SHEET_ID, 'Secret', 'number', '{}', 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP, SHEET_ID, 'Looked', 'lookup', '{}', 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_HIDDEN, SHEET_ID, 'Hidden', 'number', '{"hidden":true}', 5])
    // Record carries A/B/Secret/Hidden as RAW persisted values; the lookup key is intentionally ABSENT
    // (lookups are computed-on-read, never persisted) → the raw-read path yields missing_sample for it.
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_ID, SHEET_ID, JSON.stringify({ [FLD_A]: 10, [FLD_B]: 20, [FLD_SECRET]: SECRET_CANARY, [FLD_HIDDEN]: HIDDEN_CANARY })])
    // Deny FLD_SECRET to the requesting user — the real D3c field-read deny gate (subject-scoped).
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_SECRET, 'user', USER_ID, false, false])
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('happy path: evaluates a {fld}-only expression against sample values', async () => {
    testPerms = ['multitable:write']
    const res = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, sampleValues: { [FLD_A]: 2, [FLD_B]: 3 } })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(true)
    expect(res.body.data.result).toBe(5)
    expect(res.body.data.resultType).toBe('number')
  })

  test('unknown field reference → 200 success:false (NOT evaluated), no false-green', async () => {
    testPerms = ['multitable:write']
    const res = await post({ expression: `={fld_missing_${TS}}+1`, sampleValues: {} })
    expect(res.status).toBe(200)
    expect(res.body.data.success).toBe(false)
    expect(res.body.data.result).toBeUndefined()
    const unknown = res.body.data.diagnostics.find((d: { kind: string }) => d.kind === 'unknown_field')
    expect(unknown).toBeDefined()
    expect(unknown.fieldId).toBe(`fld_missing_${TS}`) // structured context survives the wire (i18n contract)
  })

  test('type mismatch carries structured context over the wire', async () => {
    testPerms = ['multitable:write']
    const res = await post({ expression: `={${FLD_A}}+1`, sampleValues: { [FLD_A]: 'x' } }) // string for a number field
    expect(res.status).toBe(200)
    const mismatch = res.body.data.diagnostics.find((d: { kind: string }) => d.kind === 'type_mismatch')
    expect(mismatch).toMatchObject({ fieldId: FLD_A, expectedType: 'number', actualType: 'string' })
  })

  test('capability gate: read-only user (no multitable:write) → 403', async () => {
    testPerms = ['multitable:read']
    const res = await post({ expression: `={${FLD_A}}+1`, sampleValues: { [FLD_A]: 1 } })
    expect(res.status).toBe(403)
    testPerms = ['multitable:write']
  })

  test('missing expression → 400', async () => {
    const res = await post({ sampleValues: {} })
    expect(res.status).toBe(400)
  })

  test('structural cap: over-long expression → 413', async () => {
    const res = await post({ expression: '=' + '1+'.repeat(3000) + '1', sampleValues: {} })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('DRYRUN_EXPRESSION_TOO_LONG')
  })

  test('structural cap: nesting deeper than 32 → 422 DRYRUN_TOO_DEEP', async () => {
    const res = await post({ expression: '=' + '('.repeat(33) + '1' + ')'.repeat(33), sampleValues: {} })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('DRYRUN_TOO_DEEP')
  })

  test('structural cap: more than 64 referenced fields → 422 DRYRUN_TOO_MANY_REFS', async () => {
    testPerms = ['multitable:write'] // ref-count check runs after the canManageFields gate
    const expr = '=' + Array.from({ length: 65 }, (_, i) => `{fld_x${i}}`).join('+')
    const res = await post({ expression: expr, sampleValues: {} })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('DRYRUN_TOO_MANY_REFS')
  })

  // ───────────────────────── #5c real-record sampling ─────────────────────────
  // Record-read is grant-additive in the current schema (record_permissions.access_level is
  // read|write|admin, no deny level), so requireRecordReadable enforces existence + sheet-read,
  // NOT a per-record read-deny. The real field-read deny gate is field_permissions (T2).

  test('#5c T1a: recordId not on this sheet → 404 (record-level gate, existence)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const res = await post({ expression: `={${FLD_A}}+1`, recordId: `rec_ghost_${TS}` })
    expect(res.status).toBe(404)
  })

  test('#5c T1b: valid recordId but user lacks sheet read → 403 (record-level gate, sheet canRead)', async () => {
    testPerms = []; testUserId = USER_ID // no multitable:read/write → canRead false
    const res = await post({ expression: `={${FLD_A}}+1`, recordId: REC_ID })
    expect(res.status).toBe(403)
    testPerms = ['multitable:write']
  })

  test('#5c T1c: valid recordId but unauthenticated → 401 (record-level gate, no userId)', async () => {
    testUserId = ''; testPerms = ['multitable:write'] // no user object on the request
    const res = await post({ expression: `={${FLD_A}}+1`, recordId: REC_ID })
    expect(res.status).toBe(401)
    testUserId = USER_ID
  })

  test('#5c T2: field-scope-denied value never leaks via real-record sampling (wire round-trip)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // FLD_SECRET carries SECRET_CANARY in the record but is denied (field_permissions.visible=false).
    const res = await post({ expression: `={${FLD_SECRET}}`, recordId: REC_ID })
    expect(res.status).toBe(200)
    // masked out → engine sees no sample → existing missing_sample diagnostic, never the value.
    const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_SECRET)
    expect(missing).toBeDefined()
    // the denied value must appear nowhere in the wire response.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_CANARY)
    // NB: this also proves access.userId was resolved — without it loadFieldPermissionScopeMap returns
    // an empty map, FLD_SECRET would NOT be denied, and the canary would leak (the empty-map trap).
  })

  test('#5c T3: visible record values are sampled; explicit manual values override per-field', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const base = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, recordId: REC_ID }) // record A=10,B=20
    expect(base.status).toBe(200)
    expect(base.body.data.success).toBe(true)
    expect(base.body.data.result).toBe(30)
    const overridden = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, recordId: REC_ID, sampleValues: { [FLD_A]: 100 } })
    expect(overridden.body.data.result).toBe(120) // manual override of A wins over the record's 10
  })

  test('#5c T4: lookup-ref → missing_sample (RAW read, NOT materialized) — preview==production', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // FLD_LOOKUP is a known field on the sheet but absent from raw persisted data → must degrade
    // to missing_sample, never a materialized lookup value (locks the raw-read decision).
    const res = await post({ expression: `={${FLD_LOOKUP}}+1`, recordId: REC_ID })
    expect(res.status).toBe(200)
    const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LOOKUP)
    expect(missing).toBeDefined()
    const unknown = res.body.data.diagnostics.find((d: { kind: string }) => d.kind === 'unknown_field')
    expect(unknown).toBeUndefined() // it IS a known field, just not sampled — not unknown_field
  })

  test('#5c T5: no recordId → unchanged #5b manual-sample path (additive, not regressed)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const res = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, sampleValues: { [FLD_A]: 2, [FLD_B]: 3 } })
    expect(res.status).toBe(200)
    expect(res.body.data.result).toBe(5) // manual values; record never consulted
  })

  test('#5c T1d: recordId branch — sheet-readable but not field-manager → 403 (canManageFields gate fires after the record gate)', async () => {
    // canRead=true (passes requireRecordReadable) but canManageFields=false → must 403 at the post-gate
    // capability check, ON the recordId branch (not only the no-recordId path).
    testPerms = ['multitable:read']; testUserId = USER_ID
    const res = await post({ expression: `={${FLD_A}}+1`, recordId: REC_ID })
    expect(res.status).toBe(403)
    testPerms = ['multitable:write']
  })

  test('#5c T2b: property.hidden field value never leaks via real-record sampling (second mask channel)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // FLD_HIDDEN is statically hidden (property.hidden=true) and carries HIDDEN_CANARY in the record;
    // filterVisiblePropertyFields drops it → masked out → missing_sample, value never on the wire.
    const res = await post({ expression: `={${FLD_HIDDEN}}`, recordId: REC_ID })
    expect(res.status).toBe(200)
    const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_HIDDEN)
    expect(missing).toBeDefined()
    expect(JSON.stringify(res.body)).not.toContain(HIDDEN_CANARY)
  })
})
