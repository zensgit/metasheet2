/**
 * W1-2 permission matrix — B4 / G-7: export ⊆ interactive-read, a DIFFERENTIAL property (real DB).
 * Spec: docs/development/multitable-w1-2-permission-matrix-spec-20260705.md §3 G-7.
 *
 * G-7 in one line: for the SAME actor, the export-xlsx output must never reveal MORE than that actor's
 * interactive read output (GET /records) — every field masked/absent on the read side stays
 * masked/absent on the export side, and every record absent from the read side (row-level read-deny)
 * stays absent from the export side. This is a DIFFERENTIAL property (export vs read, same actor), not
 * a same-surface regression — `multitable-permission-golden-d3d1.test.ts` already locks export's field
 * three-state in isolation, and `multitable-export-allrows-maskroute-realdb.test.ts` /
 * `multitable-lookup-foreign-field-mask-export.test.ts` already lock that export itself masks M1
 * (field_permissions) and M7 (formula-over-masked-lookup taint) correctly, and
 * `multitable-permmatrix-b2-g5-collection-noleak-realdb.test.ts` already locks that export excludes an
 * M2 row-level-read-denied record with zero presence. NONE of those assert the cross-surface relation
 * this file adds: export's masked set is provably a SUBSET of read's masked set for one actor, one
 * fixture, one request — the multi-modifier (M1+M2+M7) combination the spec calls out as the actual gap.
 *
 * Why GET /records is the read-side comparator (not GET /view): GET /records and the export-xlsx
 * no-view branch derive their allowed-field-id set through the IDENTICAL chokepoints —
 * `deriveFieldPermissions` (M1) → `maskStoredRecordFieldIds` (M7 taint) — and their row set through the
 * IDENTICAL M2 primitives — `loadRowLevelReadDenyEnabled` + `loadDeniedRecordIds` /
 * `loadRecordPermissionScopeMap` + `deriveRecordPermissions` (univer-meta.ts GET /records comment: "mirrors
 * GET /view"). That shared ancestry is WHY a differential between them is meaningful (a real regression
 * in either chokepoint's call site would show up here), not an artifact of two independently-written
 * masks that happen to agree.
 *
 * Join key: GET /records never field-masks the top-level `id` (masking only touches `data`), but
 * export-xlsx has no id column at all — so a plain never-masked `Key` field carries row identity across
 * both surfaces (same idiom as the sibling export goldens' `Name`/`fld_name` column).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import * as XLSX from 'xlsx'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_b4g7_${TS}`
const BASE_X_ID = `base_b4g7x_${TS}` // foreign base — cross-base lookup drives the M7 taint edge
const SHEET_ID = `sheet_b4g7_${TS}`
const FS_X_ID = `sheet_b4g7x_${TS}`

// Field name constants double as the export-header ↔ field-id join (export emits NAMES, GET /records
// emits IDS — a fixture-owned id↔name map removes the need for a second wire call).
const F_KEY = `fld_b4g7_key_${TS}` // 'Key' — NEVER masked; the row-identity join column for export rows.
const F_PLAIN = `fld_b4g7_plain_${TS}` // 'Plain' — never masked; a control column.
const F_SECRET = `fld_b4g7_secret_${TS}` // 'Secret' — M1 field_permissions-denied for ACTOR.
const F_LINK = `fld_b4g7_link_${TS}` // 'Link' → FS_X.
const F_LOOKUP = `fld_b4g7_lookup_${TS}` // 'Lookup' — over FS_X.F_XTARGET via F_LINK.
const F_FORMULA = `fld_b4g7_formula_${TS}` // 'FormulaCol' = {Lookup}+1 — M7-tainted for ACTOR.
const F_XTARGET = `fld_b4g7_xtarget_${TS}` // 'XTarget' on FS_X — M1-denied for ACTOR (the taint trigger).

const NAME_BY_ID: Record<string, string> = {
  [F_KEY]: 'Key',
  [F_PLAIN]: 'Plain',
  [F_SECRET]: 'Secret',
  [F_LINK]: 'Link',
  [F_LOOKUP]: 'Lookup',
  [F_FORMULA]: 'FormulaCol',
}
const ID_BY_NAME: Record<string, string> = Object.fromEntries(Object.entries(NAME_BY_ID).map(([id, name]) => [name, id]))

// `Lookup` is deliberately EXCLUDED from the read↔export comparison set. It is a computed-only field
// type: GET /records reads stored `meta_records.data` verbatim (masked, never hydrated) and does NOT
// call `applyLookupRollup` (only GET /view / single-GET do) — so its value is absent from GET /records'
// `data` for every actor, admin included, regardless of any permission. That absence is a route
// COMPLETENESS fact, orthogonal to the G-7 masking property this file tests, so a presence-in-`data`
// comparison would misreport it as "masked". F_LOOKUP still exists as a real field row (needed for the
// F_FORMULA lookup-config + `formula_dependencies` edge that drives the M7 taint on F_FORMULA); it is
// simply not one of the ids either projection below considers.
const COMPARISON_FIELD_IDS = [F_KEY, F_PLAIN, F_SECRET, F_LINK, F_FORMULA]

const REC_OK_A = `rec_b4g7_oka_${TS}` // Key='row_a' — always readable.
const REC_OK_B = `rec_b4g7_okb_${TS}` // Key='row_b' — always readable.
const REC_DENIED = `rec_b4g7_denied_${TS}` // Key='row_denied' — M2 record_permissions 'none' for ACTOR.
const REC_FX = `rec_b4g7_fx_${TS}` // foreign record on FS_X; XTarget=7.

const ACTOR = `user_b4g7_actor_${TS}` // M1(Secret)+M2(REC_DENIED)+M7(FormulaCol via XTarget) all live for this actor.
const ALLOW_USER = `user_b4g7_allow_${TS}` // no deny rows reference this actor — non-vacuous baseline.
// A SEPARATE identity for the admin-bypass control (never the subject of any field_permissions /
// record_permissions row). field_permissions is a pure subject-id lookup with no admin short-circuit at
// this call site (unlike M2's explicit `!access.isAdminRole` guard in GET /records) — reusing ACTOR's id
// here would still see its OWN per-subject deny rows applied regardless of the admin role claim, which
// would test an unrelated (and out-of-spec-scope) admin/subject-collision edge case instead of the
// intended "admin sees everything, subset holds trivially" control.
const ADMIN_ID = `user_b4g7_admin_${TS}`
const SECRET_VALUE = 'topsecret_b4g7'
const FORMULA_VALUE = 8 // = XTarget(7) + 1, materialized (write-path semantics; this suite reads it back raw)

function buildApp(userId: string, opts: { admin?: boolean } = {}): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = opts.admin
      ? { id: userId, roles: ['admin'], perms: ['*:*'], permissions: ['*:*'] }
      : { id: userId, roles: ['member'], perms: ['multitable:read', 'multitable:base:read'], permissions: ['multitable:read', 'multitable:base:read'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

async function readRecords(app: Express): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const res = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
  expect(res.status).toBe(200)
  return (res.body?.data?.records ?? []) as Array<{ id: string; data: Record<string, unknown> }>
}

async function exportRows(app: Express): Promise<string[][]> {
  const res = await request(app)
    .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c) => chunks.push(Buffer.from(c)))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  expect(res.status).toBe(200)
  const parsed = XLSX.read(res.body as Buffer, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
}

/** Read-side projection: the allowed field-id set (uniform across visible records — actor-scoped, not
 * per-record) plus the set of visible records' `Key` values (row identity). */
function projectRead(records: Array<{ id: string; data: Record<string, unknown> }>): { fieldIds: Set<string>; keys: Set<string> } {
  const present = new Set<string>()
  for (const r of records) for (const fid of Object.keys(r.data)) present.add(fid)
  const fieldIds = new Set(COMPARISON_FIELD_IDS.filter((fid) => present.has(fid)))
  const keys = new Set(records.map((r) => String(r.data[F_KEY])))
  return { fieldIds, keys }
}

/** Export-side projection: header names resolved back to field ids (restricted to the comparison set —
 * see COMPARISON_FIELD_IDS), plus the `Key` column's values. */
function projectExport(rows: string[][]): { fieldIds: Set<string>; keys: Set<string> } {
  const header = rows[0] ?? []
  const body = rows.slice(1)
  const comparisonIds = new Set<string>(COMPARISON_FIELD_IDS)
  const fieldIds = new Set(
    header.map((name) => ID_BY_NAME[name]).filter((v): v is string => !!v && comparisonIds.has(v)),
  )
  const keyCol = header.indexOf('Key')
  const keys = new Set(keyCol === -1 ? [] : body.map((row) => row[keyCol]))
  return { fieldIds, keys }
}

/** The G-7 property itself: every element export reveals must also be revealed by read. Asserted via an
 * explicit per-element loop (not a size/equality check) so a violation names the exact leaked id/key. */
function assertSubset(exportSet: Set<string>, readSet: Set<string>, label: string) {
  const leaked = [...exportSet].filter((v) => !readSet.has(v))
  expect(leaked, `${label}: export revealed items read did not (${JSON.stringify(leaked)})`).toEqual([])
}

describeIfDatabase('W1-2 B4 G-7 — export ⊆ interactive read, same actor (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B4 G7 Base'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_X_ID, 'B4 G7 Foreign Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name, row_level_read_permissions_enabled) VALUES ($1,$2,$3,TRUE)', [SHEET_ID, BASE_ID, 'B4 G7 Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS_X_ID, BASE_X_ID, 'B4 G7 Foreign Sheet'])

    const field = (id: string, sheetId: string, type: string, order: number, property: unknown = {}) =>
      q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, sheetId, NAME_BY_ID[id] ?? id, type, JSON.stringify(property), order])
    await field(F_KEY, SHEET_ID, 'string', 1)
    await field(F_PLAIN, SHEET_ID, 'string', 2)
    await field(F_SECRET, SHEET_ID, 'string', 3)
    await field(F_LINK, SHEET_ID, 'link', 4, { foreignSheetId: FS_X_ID })
    await field(F_LOOKUP, SHEET_ID, 'lookup', 5, { linkFieldId: F_LINK, targetFieldId: F_XTARGET, foreignSheetId: FS_X_ID })
    await field(F_FORMULA, SHEET_ID, 'formula', 6, { expression: `={${F_LOOKUP}}+1` })
    await field(F_XTARGET, FS_X_ID, 'number', 1)

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_FX, FS_X_ID, JSON.stringify({ [F_XTARGET]: 7 })])

    const record = (id: string, key: string, extra: Record<string, unknown> = {}) =>
      q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [
        id, SHEET_ID, JSON.stringify({ [F_KEY]: key, [F_PLAIN]: 'visible', [F_SECRET]: SECRET_VALUE, [F_LINK]: [REC_FX], [F_FORMULA]: FORMULA_VALUE, ...extra }),
      ])
    await record(REC_OK_A, 'row_a')
    await record(REC_OK_B, 'row_b')
    await record(REC_DENIED, 'row_denied')
    for (const rid of [REC_OK_A, REC_OK_B, REC_DENIED]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_b4g7_${rid}`, F_LINK, rid, REC_FX])
    }
    await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,$4)', [SHEET_ID, F_FORMULA, F_LOOKUP, SHEET_ID])

    // M1: Secret denied for ACTOR only.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [SHEET_ID, F_SECRET, 'user', ACTOR, false, false])
    // M7 trigger: the cross-base foreign target is denied for ACTOR only → taints FormulaCol for ACTOR.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FS_X_ID, F_XTARGET, 'user', ACTOR, false, false])
    // M2: REC_DENIED row-level read-denied for ACTOR only (flag already ON on the sheet row above).
    await q('INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)', [SHEET_ID, REC_DENIED, 'user', ACTOR, 'none'])
  })

  afterAll(async () => {
    await q('DELETE FROM record_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FS_X_ID]]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [F_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FS_X_ID]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, FS_X_ID]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, FS_X_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_ID, BASE_X_ID]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('control (non-vacuous baseline): ALLOW actor sees the SAME fields+rows on both channels (no denial anywhere → subset holds because the sets are EQUAL, not because either is empty)', async () => {
    const app = buildApp(ALLOW_USER)
    const read = projectRead(await readRecords(app))
    const exp = projectExport(await exportRows(app))
    // Proves the fixture is genuinely readable/exportable end-to-end for a non-denied actor.
    expect(read.fieldIds.has(F_SECRET)).toBe(true)
    expect(read.fieldIds.has(F_FORMULA)).toBe(true)
    expect(read.keys.has('row_denied')).toBe(true)
    expect(exp.fieldIds).toEqual(read.fieldIds)
    expect(exp.keys).toEqual(read.keys)
  })

  test('G-7a (M1 field-mask differential): ACTOR — Secret is masked identically on both channels; export reveals no field read does not', async () => {
    const app = buildApp(ACTOR)
    const read = projectRead(await readRecords(app))
    const exp = projectExport(await exportRows(app))
    expect(read.fieldIds.has(F_SECRET)).toBe(false) // read masks it (M1)
    expect(exp.fieldIds.has(F_SECRET)).toBe(false) // export masks it too — not just "≤", but this specific field agrees
    assertSubset(exp.fieldIds, read.fieldIds, 'fields')
    // non-vacuous: the control (never-masked) columns still cross both channels.
    expect(exp.fieldIds.has(F_PLAIN)).toBe(true)
    expect(read.fieldIds.has(F_PLAIN)).toBe(true)
  })

  test('G-7b (M2 row-deny differential): ACTOR — the row-denied record is absent identically on both channels; export reveals no row read does not', async () => {
    const app = buildApp(ACTOR)
    const read = projectRead(await readRecords(app))
    const exp = projectExport(await exportRows(app))
    expect(read.keys.has('row_denied')).toBe(false) // read excludes it (M2)
    expect(exp.keys.has('row_denied')).toBe(false) // export excludes it too
    assertSubset(exp.keys, read.keys, 'rows')
    // non-vacuous: the two non-denied rows still cross both channels.
    expect(exp.keys.has('row_a')).toBe(true)
    expect(exp.keys.has('row_b')).toBe(true)
  })

  test('G-7c (headline — M1+M2+M7 combined): ACTOR — export is a full subset of read across fields AND rows in ONE fixture, including the taint column', async () => {
    const app = buildApp(ACTOR)
    const read = projectRead(await readRecords(app))
    const exp = projectExport(await exportRows(app))

    // M7 specifically: FormulaCol is tainted (depends on a lookup over the ACTOR-denied cross-base
    // XTarget) — masked on read, and must stay masked on export (not just narrower-or-equal in general).
    expect(read.fieldIds.has(F_FORMULA)).toBe(false)
    expect(exp.fieldIds.has(F_FORMULA)).toBe(false)
    // Exact-cell containment (NOT a JSON.stringify substring search — the fixture's own timestamp-based
    // record ids legitimately contain the digit '8' as a substring, which would make a blob substring
    // check on '8' spuriously fail; toContain over the flattened cell array requires a whole-cell match).
    const freshRows = await exportRows(app)
    expect(freshRows[0]).not.toContain('FormulaCol')
    expect(freshRows.flat()).not.toContain(String(FORMULA_VALUE)) // the materialized 8 never leaks via export

    // The generic property, asserted over the WHOLE fixture at once (all 3 modifiers live simultaneously).
    assertSubset(exp.fieldIds, read.fieldIds, 'fields (combined)')
    assertSubset(exp.keys, read.keys, 'rows (combined)')

    // Exact non-vacuous shape: read/export agree on precisely {Key, Plain, Link} × {row_a, row_b}
    // (Secret masked by M1, FormulaCol masked by M7, row_denied excluded by M2 — on BOTH channels).
    expect(read.fieldIds).toEqual(new Set([F_KEY, F_PLAIN, F_LINK]))
    expect(exp.fieldIds).toEqual(new Set([F_KEY, F_PLAIN, F_LINK]))
    expect(read.keys).toEqual(new Set(['row_a', 'row_b']))
    expect(exp.keys).toEqual(new Set(['row_a', 'row_b']))
  })

  test('admin bypass (M2 row-deny specifically — the mechanism with an explicit isAdminRole guard): an unrelated admin identity sees the row-denied record on both channels, subset holds trivially', async () => {
    const app = buildApp(ADMIN_ID, { admin: true })
    const read = projectRead(await readRecords(app))
    const exp = projectExport(await exportRows(app))
    assertSubset(exp.fieldIds, read.fieldIds, 'fields (admin)')
    assertSubset(exp.keys, read.keys, 'rows (admin)')
    expect(read.keys.has('row_denied')).toBe(true) // M2 bypass: ADMIN_ID is not the subject of any deny row anyway
    expect(exp.keys.has('row_denied')).toBe(true)
  })
})
