/**
 * Real-DB integration test for the formula dry-run endpoint (#5a, design #1860):
 * POST /api/multitable/sheets/:sheetId/formula/dry-run.
 * Confirms the canManageFields gate, structural caps, and the happy path. Runs only with DATABASE_URL.
 *
 * FOL-2 (dry-run hydration, design 2026-06-10 §3): the recordId branch hydrates the lookup/rollup
 * fields the expression references (requester-perspective, hydrate → mask → manual override), so
 * the preview matches production recalc, which evaluates HYDRATED rows since A-min (#2247).
 * D1-D7 below pin the joined-string substitution semantics (A2b) and the expression-scoped
 * hydration cost (no computed ref → zero link/foreign-sheet reads).
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
const FLD_LOOKUP = `fld_dry_lookup_${TS}` // #5c: lookup field — never persisted in raw record data (null cfg → hydrates to [])
const REC_ID = `rec_dry_${TS}`
const USER_ID = `u_dry_${TS}`
const SECRET_CANARY = 'do-not-leak-canary' // #5c: proves a field_permissions-denied field never leaks
const HIDDEN_CANARY = 'do-not-leak-hidden' // #5c: proves a property.hidden field never leaks

// ── FOL-2 hydration fixtures: real foreign sheets + link + configured lookup/rollup ──
const FOREIGN_A = `sheet_dry_fa_${TS}` // foreign sheet feeding the referenced lookup/rollup
const FOREIGN_B = `sheet_dry_fb_${TS}` // foreign sheet feeding the UNREFERENCED lookup (D6 scoping)
const FLD_FA_NUM = `fld_dry_fa_num_${TS}` // numeric lookup/rollup target (100)
const FLD_FA_SECRET = `fld_dry_fa_secret_${TS}` // carries FOREIGN_CANARY — read only via FLD_LU_DENIED
const FLD_FB_NUM = `fld_dry_fb_num_${TS}`
const FLD_LINK_A = `fld_dry_link_a_${TS}`
const FLD_LINK_B = `fld_dry_link_b_${TS}`
const FLD_LU_A = `fld_dry_lu_a_${TS}` // configured lookup → FLD_FA_NUM
const FLD_RU_A = `fld_dry_ru_a_${TS}` // sum rollup → FLD_FA_NUM
const FLD_LU_B = `fld_dry_lu_b_${TS}` // configured lookup → FLD_FB_NUM; deliberately never referenced in D6
const FLD_LU_DENIED = `fld_dry_lu_denied_${TS}` // lookup → FLD_FA_SECRET, field_permissions-denied for USER_ID
const REC_FA1 = `rec_dry_fa1_${TS}`
const REC_FB1 = `rec_dry_fb1_${TS}`
const USER_LIMITED = `u_dry_limited_${TS}` // sheet-scoped grant on SHEET_ID only → both foreign sheets unreadable
const FOREIGN_CANARY = 'do-not-leak-foreign-canary' // FOL-2 D3: hydrated-then-masked value must never leak

let app: Express
let testPerms: string[] = ['multitable:write'] // canManageFields requires multitable:write
let testUserId: string = USER_ID // #5c: mutable so a test can drop the user to assert 401
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const post = (body: unknown) => request(app).post(`/api/multitable/sheets/${SHEET_ID}/formula/dry-run`).send(body as object)

// FOL-2 D6/D7: capture every SQL statement issued while `fn` runs by patching the shared pool's
// query method (the route re-binds pool.query per request, so the patch is picked up). Params are
// flattened so ids inside text[] array params are matchable with a plain `includes`.
type CapturedQuery = { sql: string; params: unknown[] }
const captureQueries = async (fn: () => Promise<void>): Promise<CapturedQuery[]> => {
  const pool = poolManager.get() as unknown as { query: (...args: unknown[]) => unknown }
  const original = pool.query
  const captured: CapturedQuery[] = []
  pool.query = function (this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'string') {
      captured.push({ sql: args[0], params: Array.isArray(args[1]) ? (args[1] as unknown[]).flat(3) : [] })
    }
    return original.apply(this, args)
  }
  try {
    await fn()
  } finally {
    pool.query = original
  }
  return captured
}
const touchesSheet = (queries: CapturedQuery[], sheetId: string) =>
  queries.some((c) => c.params.includes(sheetId))

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

    // ── FOL-2 hydration fixtures (design 2026-06-10 §3.2): the pre-FOL-2 FLD_LOOKUP has property
    // {} (cfg parses to null → hydrates to []), so REAL foreign sheets + a link + configured
    // lookup/rollup are needed to exercise actual value hydration.
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FOREIGN_A, BASE_ID, 'Dry Foreign A'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [FOREIGN_B, BASE_ID, 'Dry Foreign B'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FA_NUM, FOREIGN_A, 'FA Num', 'number', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FA_SECRET, FOREIGN_A, 'FA Secret', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_FB_NUM, FOREIGN_B, 'FB Num', 'number', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FA1, FOREIGN_A, JSON.stringify({ [FLD_FA_NUM]: 100, [FLD_FA_SECRET]: FOREIGN_CANARY })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FB1, FOREIGN_B, JSON.stringify({ [FLD_FB_NUM]: 7 })])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK_A, SHEET_ID, 'Link A', 'link', JSON.stringify({ foreignSheetId: FOREIGN_A }), 6])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK_B, SHEET_ID, 'Link B', 'link', JSON.stringify({ foreignSheetId: FOREIGN_B }), 7])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LU_A, SHEET_ID, 'Lookup A', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_A, targetFieldId: FLD_FA_NUM, foreignSheetId: FOREIGN_A }), 8])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_RU_A, SHEET_ID, 'Rollup A', 'rollup', JSON.stringify({ linkFieldId: FLD_LINK_A, targetFieldId: FLD_FA_NUM, aggregation: 'sum', foreignSheetId: FOREIGN_A }), 9])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LU_B, SHEET_ID, 'Lookup B', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_B, targetFieldId: FLD_FB_NUM, foreignSheetId: FOREIGN_B }), 10])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LU_DENIED, SHEET_ID, 'Lookup Denied', 'lookup', JSON.stringify({ linkFieldId: FLD_LINK_A, targetFieldId: FLD_FA_SECRET, foreignSheetId: FOREIGN_A }), 11])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK_A, REC_ID, REC_FA1])
    await q('INSERT INTO meta_links (field_id, record_id, foreign_record_id) VALUES ($1,$2,$3)', [FLD_LINK_B, REC_ID, REC_FB1])
    // D3: deny the configured lookup itself — hydrate → mask must drop the hydrated value.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, FLD_LU_DENIED, 'user', USER_ID, false, false])
    // D4/D4b: USER_LIMITED gets sheet-scoped write on SHEET_ID only (schema-write grant →
    // canManageFields), no global perms and no grant on FOREIGN_A/B → foreign sheets unreadable.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, USER_LIMITED, 'user', USER_LIMITED, 'spreadsheet:write'])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_links WHERE field_id = ANY($1::text[])', [[FLD_LINK_A, FLD_LINK_B]]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FOREIGN_A, FOREIGN_B]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FOREIGN_A, FOREIGN_B]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, FOREIGN_A, FOREIGN_B]]).catch(() => {})
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

  test('#5c T4 (flipped by FOL-2): null-cfg lookup-ref hydrates to [] — no missing_sample, "" substitution', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // FLD_LOOKUP has property {} (cfg parses to null) → applyLookupRollup hydrates it to [],
    // which substitutes as "" (joined-string A2b contract) → numeric coercion 0 in arithmetic.
    // Pre-FOL-2 this asserted missing_sample (raw read); production recalc evaluates HYDRATED
    // rows since A-min (#2247), so the preview hydrates too.
    const res = await post({ expression: `={${FLD_LOOKUP}}+1`, recordId: REC_ID })
    expect(res.status).toBe(200)
    const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LOOKUP)
    expect(missing).toBeUndefined() // hydrated (to []) — sampled, no longer missing
    expect(res.body.data.success).toBe(true)
    expect(res.body.data.result).toBe(1) // [] → "" → 0 + 1
    const unknown = res.body.data.diagnostics.find((d: { kind: string }) => d.kind === 'unknown_field')
    expect(unknown).toBeUndefined() // it IS a known field — not unknown_field
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

  // ───────────────────────── FOL-2: dry-run hydration (design 2026-06-10 §3) ─────────────────────────
  // The recordId branch hydrates the lookup/rollup fields the expression references (requester-
  // perspective, hydrate → mask → manual override). Expected values follow the engine's ACTUAL
  // joined-string substitution (A2b, pinned in tests/unit/multitable-formula-over-lookup.test.ts):
  // hydrated [100] → "100" (numeric coercion in arithmetic), [] → "" (bare → '', +1 → 1);
  // a sum rollup hydrates to a number, an empty/unreadable one to null → '0' substitution.

  test('FOL-2 D1: linked lookup ref hydrates — [100] → "100" joined-string → +1 = 101', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const arith = await post({ expression: `={${FLD_LU_A}}+1`, recordId: REC_ID })
    expect(arith.status).toBe(200)
    expect(arith.body.data.success).toBe(true)
    expect(arith.body.data.result).toBe(101)
    expect(arith.body.data.resultType).toBe('number')
    const missing = arith.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LU_A)
    expect(missing).toBeUndefined()
    // bare ref pins the joined-string substitution itself: [100] → "100" (a string, not 100)
    const bare = await post({ expression: `={${FLD_LU_A}}`, recordId: REC_ID })
    expect(bare.body.data.result).toBe('100')
    expect(bare.body.data.resultType).toBe('string')
  })

  test('FOL-2 D2: rollup ref hydrates — sum over [100] → 100 → +1 = 101', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const arith = await post({ expression: `={${FLD_RU_A}}+1`, recordId: REC_ID })
    expect(arith.status).toBe(200)
    expect(arith.body.data.success).toBe(true)
    expect(arith.body.data.result).toBe(101)
    const missing = arith.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_RU_A)
    expect(missing).toBeUndefined()
    const bare = await post({ expression: `={${FLD_RU_A}}`, recordId: REC_ID })
    expect(bare.body.data.result).toBe(100) // rollup hydrates to a scalar number — no array join
    expect(bare.body.data.resultType).toBe('number')
  })

  test('FOL-2 D3: field_permissions-denied lookup stays missing_sample; hydrated foreign value never leaks (hydrate → mask order)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // FLD_LU_DENIED is a properly-configured lookup whose foreign target carries FOREIGN_CANARY;
    // it hydrates (referenced) but the mask drops the key BEFORE the engine sees it.
    const res = await post({ expression: `={${FLD_LU_DENIED}}`, recordId: REC_ID })
    expect(res.status).toBe(200)
    const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LU_DENIED)
    expect(missing).toBeDefined()
    expect(JSON.stringify(res.body)).not.toContain(FOREIGN_CANARY)
  })

  test('FOL-2 D4: requester cannot read the foreign sheet — lookup hydrates to [] → "" substitution', async () => {
    testPerms = []; testUserId = USER_LIMITED // sheet-scoped write on SHEET_ID only
    const bare = await post({ expression: `={${FLD_LU_A}}`, recordId: REC_ID })
    expect(bare.status).toBe(200)
    expect(bare.body.data.success).toBe(true)
    expect(bare.body.data.result).toBe('') // [] joins to "" — a string, not a missing sample
    expect(bare.body.data.resultType).toBe('string')
    const missing = bare.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LU_A)
    expect(missing).toBeUndefined()
    const arith = await post({ expression: `={${FLD_LU_A}}+1`, recordId: REC_ID })
    expect(arith.body.data.result).toBe(1) // "" coerces to 0 in arithmetic
    testPerms = ['multitable:write']; testUserId = USER_ID
  })

  test('FOL-2 D4b: requester cannot read the foreign sheet — rollup hydrates to null → \'0\' substitution (diverges from lookup)', async () => {
    testPerms = []; testUserId = USER_LIMITED
    const bare = await post({ expression: `={${FLD_RU_A}}`, recordId: REC_ID })
    expect(bare.status).toBe(200)
    expect(bare.body.data.success).toBe(true)
    expect(bare.body.data.result).toBe(0) // null substitutes as '0' — not "" like a lookup
    expect(bare.body.data.resultType).toBe('number')
    const missing = bare.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_RU_A)
    expect(missing).toBeUndefined() // hydrated (to null) — sampled, no longer missing
    const arith = await post({ expression: `={${FLD_RU_A}}+1`, recordId: REC_ID })
    expect(arith.body.data.result).toBe(1)
    testPerms = ['multitable:write']; testUserId = USER_ID
  })

  test('FOL-2 D5: manual sampleValues beat hydration; a masked lookup accepts a manual sample', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // {...masked, ...sampleValues}: the manual 5 wins over the hydrated [100].
    const overridden = await post({ expression: `={${FLD_LU_A}}+1`, recordId: REC_ID, sampleValues: { [FLD_LU_A]: 5 } })
    expect(overridden.status).toBe(200)
    expect(overridden.body.data.result).toBe(6)
    // A manual sample for the MASKED lookup also evaluates — it is the caller's own data, not a leak.
    const maskedManual = await post({ expression: `={${FLD_LU_DENIED}}+1`, recordId: REC_ID, sampleValues: { [FLD_LU_DENIED]: 5 } })
    expect(maskedManual.body.data.result).toBe(6)
    expect(JSON.stringify(maskedManual.body)).not.toContain(FOREIGN_CANARY)
  })

  test('FOL-2 D6: hydration is expression-scoped — no computed ref → zero link/foreign reads; unreferenced lookup\'s sheet never queried', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    // (a) expression references NO lookup/rollup → ZERO foreign-sheet queries, no meta_links read.
    const plain = await captureQueries(async () => {
      const res = await post({ expression: `={${FLD_A}}+{${FLD_B}}`, recordId: REC_ID })
      expect(res.status).toBe(200)
      expect(res.body.data.result).toBe(30)
    })
    expect(plain.length).toBeGreaterThan(0) // the capture hook is actually wired
    expect(plain.some((c) => /meta_links/i.test(c.sql))).toBe(false)
    expect(touchesSheet(plain, FOREIGN_A)).toBe(false)
    expect(touchesSheet(plain, FOREIGN_B)).toBe(false)
    // (b) referencing lookup A only → FOREIGN_A records are read, FOREIGN_B is never touched
    // (FLD_LU_B exists and is linked, but the expression does not reference it).
    const scoped = await captureQueries(async () => {
      const res = await post({ expression: `={${FLD_LU_A}}+1`, recordId: REC_ID })
      expect(res.status).toBe(200)
      expect(res.body.data.result).toBe(101)
    })
    expect(scoped.some((c) => /FROM meta_records/.test(c.sql) && c.params.includes(FOREIGN_A))).toBe(true)
    expect(touchesSheet(scoped, FOREIGN_B)).toBe(false)
  })

  test('FOL-2 D7: no recordId → #5b manual path unchanged (lookup ref stays missing_sample, zero hydration reads)', async () => {
    testPerms = ['multitable:write']; testUserId = USER_ID
    const captured = await captureQueries(async () => {
      const res = await post({ expression: `={${FLD_LU_A}}+1` })
      expect(res.status).toBe(200)
      const missing = res.body.data.diagnostics.find((d: { kind: string; fieldId?: string }) => d.kind === 'missing_sample' && d.fieldId === FLD_LU_A)
      expect(missing).toBeDefined()
      expect(res.body.data.result).toBe(1) // absent → '0' substitution, exactly as before FOL-2
    })
    expect(captured.some((c) => /meta_links/i.test(c.sql))).toBe(false)
    expect(touchesSheet(captured, FOREIGN_A)).toBe(false)
    expect(touchesSheet(captured, FOREIGN_B)).toBe(false)
  })
})
