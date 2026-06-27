/**
 * Cross-base relation-aggregation read gate (real DB). The standalone relation-agg gate
 * (resolveRelationAggregation) and the formula-taint sink both used to BLANKET-deny any cross-base foreign
 * sheet → #PERM!, even for an AUTHORIZED cross-base reader. That was an out-of-scope-at-lock-time placeholder,
 * redundant with the per-field gate: resolveForeignFieldReadability empties the readable set when the actor
 * can't read the foreign base (resolveBaseReadable), so shouldMaskForeignField already masks an unreadable
 * cross-base field — and ALLOWS a readable one. This suite locks the corrected behavior across the permission
 * matrix; before the two-site fix, case (a) is RED (authorized reader gets the field dropped).
 *
 * Matrix: (a) authorized cross-base reader (base-read + target + criteria readable) → real aggregate (proves
 * BOTH the materialize gate storing the value AND the read gate surfacing it) · (b) cannot read foreign base
 * → dropped · (c) target field unreadable → dropped · (d) CRITERIA field unreadable → dropped (the
 * side-channel: a count over a denied field leaks its distribution) · (e) lookup kind, authorized → value.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
// authorized cross-base reader: sheet-read + base-read on the foreign base. Materializer also needs write.
const ALLOW = `u_xbr_allow_${TS}`
const ALLOW_PERMS = ['multitable:read', 'multitable:write', 'multitable:base:read']
// can read MS, but NO base-read on the foreign base → must NOT see cross-base relation-agg.
const DENY_BASE = `u_xbr_denybase_${TS}`
const DENY_BASE_PERMS = ['multitable:read']
// base-read OK, but the foreign SECRET field is field-permission denied → secret-target/criterion must drop.
const DENY_FIELD = `u_xbr_denyfield_${TS}`
const DENY_FIELD_PERMS = ['multitable:read', 'multitable:base:read']

const BASE_SRC = `base_xbr_src_${TS}`
const BASE_FOR = `base_xbr_for_${TS}`
const FS = `sheet_xbr_fs_${TS}` // foreign sheet, in BASE_FOR
const MS = `sheet_xbr_ms_${TS}` // main sheet, in BASE_SRC

const FLD_AMT = `fld_xbr_amt_${TS}`
const FLD_STATUS = `fld_xbr_status_${TS}`
const FLD_SECRET = `fld_xbr_secret_${TS}`
const FLD_LINK = `fld_xbr_link_${TS}`
const FLD_CURVAL = `fld_xbr_curval_${TS}`
const FLD_SUMIF = `fld_xbr_sumif_${TS}` // RELSUMIF(link, amt, status, is, {curval}) → 30 (target+criteria readable)
const FLD_SECRETSUM = `fld_xbr_secsum_${TS}` // RELSUMIF(link, SECRET, status, is, {curval}) → 300 (target denied)
const FLD_SECRETCOUNT = `fld_xbr_seccount_${TS}` // RELCOUNTIF(link, SECRET, greater, 0) → 3 (CRITERIA denied — side-channel)
const FLD_LOOKUP = `fld_xbr_lookup_${TS}` // RELLOOKUP(link, status, amt, is, 10) → 'paid'

const FR1 = `rec_xbr_f1_${TS}`
const FR2 = `rec_xbr_f2_${TS}`
const FR3 = `rec_xbr_f3_${TS}`
const REC = `rec_xbr_src_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
function buildApp(userId: string, perms: string[]): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { ;(req as { user?: unknown }).user = { id: userId, roles: ['member'], perms, permissions: perms }; next() })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const relSum = (target: string) => JSON.stringify({ expression: `RELSUMIF("${FLD_LINK}","${target}","${FLD_STATUS}","is",{${FLD_CURVAL}})` })
async function readField(userId: string, perms: string[], fieldId: string): Promise<unknown> {
  const res = await request(buildApp(userId, perms)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}
async function hasField(userId: string, perms: string[], fieldId: string): Promise<boolean> {
  const res = await request(buildApp(userId, perms)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return Object.prototype.hasOwnProperty.call(res.body?.data?.record?.data ?? {}, fieldId)
}
async function storedValue(fieldId: string): Promise<unknown> {
  return ((await q('SELECT data->$2 AS v FROM meta_records WHERE id=$1', [REC, fieldId])).rows[0] as { v: unknown }).v
}
// Patch the current-record criteria field 'unpaid'→'paid' as ALLOW → recompute the dependent relation-agg
// formulas in ALLOW's (authorized cross-base) context.
async function materializeAsAllow(): Promise<void> {
  const cur = await q('SELECT version FROM meta_records WHERE id = $1', [REC])
  const version = Number((cur.rows[0] as { version?: unknown })?.version ?? 1)
  const res = await request(buildApp(ALLOW, ALLOW_PERMS)).post('/api/multitable/patch').send({
    sheetId: MS, changes: [{ recordId: REC, fieldId: FLD_CURVAL, value: 'paid', expectedVersion: version }],
  })
  expect(res.status).toBe(200)
}

describeIfDatabase('multitable cross-base relation-aggregation read gate (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_SRC, 'XBR Src', `u_xbr_owner_${TS}`])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE_FOR, 'XBR For', `u_xbr_owner_${TS}`])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE_FOR, 'XBR Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE_SRC, 'XBR Main'])
    for (const [fid, name, type, order] of [[FLD_AMT, 'Amount', 'number', 1], [FLD_STATUS, 'Status', 'string', 2], [FLD_SECRET, 'Secret', 'number', 3]] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, FS, name, type, '{}', order])
    }
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR1, FS, JSON.stringify({ [FLD_AMT]: 10, [FLD_STATUS]: 'paid', [FLD_SECRET]: 100 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR2, FS, JSON.stringify({ [FLD_AMT]: 20, [FLD_STATUS]: 'paid', [FLD_SECRET]: 200 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR3, FS, JSON.stringify({ [FLD_AMT]: 5, [FLD_STATUS]: 'unpaid', [FLD_SECRET]: 300 })])
    // cross-base link: FS lives in BASE_FOR, MS in BASE_SRC → crossBase derived from the sheets' bases.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS, foreignBaseId: BASE_FOR }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_CURVAL, MS, 'CurVal', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SUMIF, MS, 'SumIf', 'formula', relSum(FLD_AMT), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRETSUM, MS, 'SecretSum', 'formula', relSum(FLD_SECRET), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRETCOUNT, MS, 'SecretCount', 'formula', JSON.stringify({ expression: `RELCOUNTIF("${FLD_LINK}","${FLD_SECRET}","greater","0")` }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP, MS, 'Lookup', 'formula', JSON.stringify({ expression: `RELLOOKUP("${FLD_LINK}","${FLD_STATUS}","${FLD_AMT}","is","10")` }), 6])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3], [FLD_CURVAL]: 'unpaid' })])
    for (const fr of [FR1, FR2, FR3]) await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_xbr_${fr}`, FLD_LINK, REC, fr])
    for (const ff of [FLD_SUMIF, FLD_SECRETSUM, FLD_SECRETCOUNT, FLD_LOOKUP]) {
      await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [MS, ff, FLD_CURVAL])
    }
    // DENY_FIELD cannot read the foreign SECRET field.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FS, FLD_SECRET, 'user', DENY_FIELD, false, false])
    await materializeAsAllow()
  })
  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_SRC, BASE_FOR]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('1399 materialize: an AUTHORIZED cross-base reader stores the real aggregate, not #PERM!', async () => {
    expect(Number(await storedValue(FLD_SUMIF))).toBe(30) // amt where status=paid: 10+20 (was #PERM! before the fix)
  })

  test('(a) authorized cross-base reader (base-read + fields readable) → real aggregate 30 [the fix; RED before]', async () => {
    expect(await readField(ALLOW, ALLOW_PERMS, FLD_SUMIF)).toBe(30)
    expect(await readField(ALLOW, ALLOW_PERMS, FLD_LOOKUP)).toBe('paid') // (e) lookup kind shares the gate
  })

  test('(b) NO base-read on the foreign base → the cross-base relation-agg is DROPPED (fail-closed preserved)', async () => {
    expect(await hasField(DENY_BASE, DENY_BASE_PERMS, FLD_SUMIF)).toBe(false)
    expect(await hasField(DENY_BASE, DENY_BASE_PERMS, FLD_LOOKUP)).toBe(false)
  })

  test('(c) base-read OK but TARGET field unreadable → dropped; authorized sees it', async () => {
    expect(await readField(ALLOW, ALLOW_PERMS, FLD_SECRETSUM)).toBe(300)
    expect(await hasField(DENY_FIELD, DENY_FIELD_PERMS, FLD_SECRETSUM)).toBe(false)
  })

  test('(d) base-read OK but CRITERIA field unreadable → dropped (side-channel: count over a denied field)', async () => {
    expect(await readField(ALLOW, ALLOW_PERMS, FLD_SECRETCOUNT)).toBe(3)
    expect(await hasField(DENY_FIELD, DENY_FIELD_PERMS, FLD_SECRETCOUNT)).toBe(false)
  })
})
