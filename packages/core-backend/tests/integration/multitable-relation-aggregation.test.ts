/**
 * 1b Slice A — relation-scoped criteria aggregation (RELSUMIF), real DB.
 *
 * RELSUMIF("link","target","criteria","op","value") sums a FOREIGN target field over the records linked to
 * the current row via "link", keeping only linked records whose "criteria" foreign field matches. It is
 * RELATION-SCOPED (NOT whole-sheet SUMIF). Materialized at write in the writer's permission context.
 *
 * The keystone is the READ-LEAK gate (the §2a.3 class): a RELSUMIF over a foreign field a READER cannot see
 * must be DROPPED from that reader's response — never the writer's materialized aggregate. Without the
 * resolveTaintedFormulaFieldIds extension this test is RED (the denied reader would receive 300).
 *
 * Trigger: a PATCH of the current-record criteria field ('unpaid'→'paid') recomputes dependent formulas via recalculateFormulaFields;
 * GET /records/:id reads through maskStoredRecordFieldIds → resolveTaintedFormulaFieldIds.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const ALLOW = `u_rel_allow_${TS}` // reads everything
const DENY = `u_rel_deny_${TS}` // denied the foreign SECRET field

const BASE = `base_rel_${TS}`
const FS = `sheet_rel_fs_${TS}`
const MS = `sheet_rel_ms_${TS}`

const FLD_AMT = `fld_rel_amt_${TS}` // foreign number target (readable)
const FLD_STATUS = `fld_rel_status_${TS}` // foreign string criteria (readable)
const FLD_SECRET = `fld_rel_secret_${TS}` // foreign number target, DENIED for DENY
const FLD_LINK = `fld_rel_link_${TS}`
const FLD_SUMIF = `fld_rel_sumif_${TS}` // = RELSUMIF(link, amt, status, is, paid) -> 30
const FLD_SECRETSUM = `fld_rel_secsum_${TS}` // = RELSUMIF(link, SECRET, status, is, paid) -> 300 (leak gate)
const FLD_CLIFF = `fld_rel_cliff_${TS}` // = RELSUMIF(...)+1  -> composition cliff -> #ERROR!
const FLD_CURVAL = `fld_rel_curval_${TS}` // current-record string used as a {fld} criteria value
const FLD_AVGIF = `fld_rel_avgif_${TS}` // = RELAVGIF(link, amt, status, is, {curval}) -> avg(10,20) = 15
const FLD_COUNTIF = `fld_rel_countif_${TS}` // = RELCOUNTIF(link, status, is, {curval}) -> count(paid) = 2 (4-arg)
const FLD_SECRETCOUNT = `fld_rel_seccount_${TS}` // = RELCOUNTIF(link, SECRET, greater, 0) -> 3; DENIED-criteria leak gate
const FLD_LOOKUP = `fld_rel_lookup_${TS}` // = RELLOOKUP(link, status, amt, is, 10) -> 'paid' (FR1, only amt=10; order-independent)
const FLD_LOOKUP_NA = `fld_rel_lookupna_${TS}` // = RELLOOKUP(link, status, amt, is, 999) -> #N/A (no match)
const FLD_LOOKUP_SECRET = `fld_rel_lookupsec_${TS}` // = RELLOOKUP(link, SECRET, amt, is, 10) -> 100; DENIED returnField leak gate
const FLD_VALUES = `fld_rel_values_${TS}` // = RELVALUES(link, amt, status, is, {curval}) -> [10, 20] (paid, link order)
const FLD_VALUES_SECRET = `fld_rel_valuessec_${TS}` // = RELVALUES(link, SECRET, status, is, {curval}) -> [100,200]; DENIED leak gate

const FR1 = `rec_rel_f1_${TS}` // amt 10, status paid,   secret 100
const FR2 = `rec_rel_f2_${TS}` // amt 20, status paid,   secret 200
const FR3 = `rec_rel_f3_${TS}` // amt  5, status unpaid, secret 300
const REC = `rec_rel_src_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function buildApp(userId: string): Express {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).user = { id: userId, roles: ['member'], perms: ['multitable:read', 'multitable:write'], permissions: ['multitable:read', 'multitable:write'] }
    next()
  })
  a.use('/api/multitable', univerMetaRouter())
  return a
}
const fx = (fieldId: string) => JSON.stringify({ expression: `=${fieldId}` })
// criteria value = a current-record {fld} (the genuine delta over rollup-with-filter) — and patching it
// is a guaranteed real change that triggers recompute (re-setting the link to identical ids can be a no-op).
const relExpr = (target: string) => JSON.stringify({ expression: `RELSUMIF("${FLD_LINK}","${target}","${FLD_STATUS}","is",{${FLD_CURVAL}})` })

async function readField(userId: string, fieldId: string): Promise<unknown> {
  const res = await request(buildApp(userId)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return res.body?.data?.record?.data?.[fieldId]
}
async function hasField(userId: string, fieldId: string): Promise<boolean> {
  const res = await request(buildApp(userId)).get(`/api/multitable/records/${REC}`)
  expect(res.status).toBe(200)
  return Object.prototype.hasOwnProperty.call(res.body?.data?.record?.data ?? {}, fieldId)
}
// Patch the current-record criteria field 'unpaid'→'paid' (a REAL change) → triggers recalculateFormulaFields
// (the formulas depend on it); the RELSUMIF criteria value resolves to this current-record {fld} = 'paid'.
async function materializeAs(userId: string): Promise<void> {
  const cur = await q('SELECT version FROM meta_records WHERE id = $1', [REC])
  const version = Number((cur.rows[0] as any)?.version ?? 1)
  const res = await request(buildApp(userId)).post('/api/multitable/patch').send({
    sheetId: MS,
    changes: [{ recordId: REC, fieldId: FLD_CURVAL, value: 'paid', expectedVersion: version }],
  })
  expect(res.status).toBe(200)
}

describeIfDatabase('multitable 1b Slice A — relation-scoped RELSUMIF (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'REL Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [FS, BASE, 'REL Foreign'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [MS, BASE, 'REL Main'])

    for (const [fid, name, type, order] of [
      [FLD_AMT, 'Amount', 'number', 1],
      [FLD_STATUS, 'Status', 'string', 2],
      [FLD_SECRET, 'Secret', 'number', 3],
    ] as const) {
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [fid, FS, name, type, '{}', order])
    }
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR1, FS, JSON.stringify({ [FLD_AMT]: 10, [FLD_STATUS]: 'paid', [FLD_SECRET]: 100 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR2, FS, JSON.stringify({ [FLD_AMT]: 20, [FLD_STATUS]: 'paid', [FLD_SECRET]: 200 })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [FR3, FS, JSON.stringify({ [FLD_AMT]: 5, [FLD_STATUS]: 'unpaid', [FLD_SECRET]: 300 })])

    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LINK, MS, 'Link', 'link', JSON.stringify({ foreignSheetId: FS }), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_CURVAL, MS, 'CurVal', 'string', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SUMIF, MS, 'SumIf', 'formula', relExpr(FLD_AMT), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRETSUM, MS, 'SecretSum', 'formula', relExpr(FLD_SECRET), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_CLIFF, MS, 'Cliff', 'formula', JSON.stringify({ expression: `RELSUMIF("${FLD_LINK}","${FLD_AMT}","${FLD_STATUS}","is",{${FLD_CURVAL}})+1` }), 5])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_AVGIF, MS, 'AvgIf', 'formula', JSON.stringify({ expression: `RELAVGIF("${FLD_LINK}","${FLD_AMT}","${FLD_STATUS}","is",{${FLD_CURVAL}})` }), 6])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_COUNTIF, MS, 'CountIf', 'formula', JSON.stringify({ expression: `RELCOUNTIF("${FLD_LINK}","${FLD_STATUS}","is",{${FLD_CURVAL}})` }), 7])
    // RELCOUNTIF over the DENIED foreign SECRET field as criteria — the target=criteria bridge must route it
    // through the same taint gate (a count over a denied criteria would otherwise leak its distribution).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRETCOUNT, MS, 'SecretCount', 'formula', JSON.stringify({ expression: `RELCOUNTIF("${FLD_LINK}","${FLD_SECRET}","greater","0")` }), 8])
    // Slice B — RELLOOKUP(link, returnField, matchField, op, value): single-row first-match. Single-match
    // criteria (amt=10 → only FR1) keeps the assertion order-independent.
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP, MS, 'Lookup', 'formula', JSON.stringify({ expression: `RELLOOKUP("${FLD_LINK}","${FLD_STATUS}","${FLD_AMT}","is","10")` }), 9])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP_NA, MS, 'LookupNA', 'formula', JSON.stringify({ expression: `RELLOOKUP("${FLD_LINK}","${FLD_STATUS}","${FLD_AMT}","is","999")` }), 10])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_LOOKUP_SECRET, MS, 'LookupSecret', 'formula', JSON.stringify({ expression: `RELLOOKUP("${FLD_LINK}","${FLD_SECRET}","${FLD_AMT}","is","10")` }), 11])
    // Slice C — RELVALUES(link, target, criteria, op, value): array of ALL matched target values (link order).
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUES, MS, 'Values', 'formula', JSON.stringify({ expression: `RELVALUES("${FLD_LINK}","${FLD_AMT}","${FLD_STATUS}","is",{${FLD_CURVAL}})` }), 12])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_VALUES_SECRET, MS, 'ValuesSecret', 'formula', JSON.stringify({ expression: `RELVALUES("${FLD_LINK}","${FLD_SECRET}","${FLD_STATUS}","is",{${FLD_CURVAL}})` }), 13])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3], [FLD_CURVAL]: 'unpaid' })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_rel_${fr}`, FLD_LINK, REC, fr])
    }
    // Formula deps on the current-record criteria field {CURVAL} (the recompute trigger; the create handler
    // would register it via extractFieldReferences, but these fields are seeded via SQL → insert directly).
    for (const ff of [FLD_SUMIF, FLD_SECRETSUM, FLD_CLIFF, FLD_AVGIF, FLD_COUNTIF, FLD_SECRETCOUNT, FLD_LOOKUP, FLD_LOOKUP_NA, FLD_LOOKUP_SECRET, FLD_VALUES, FLD_VALUES_SECRET]) {
      await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [MS, ff, FLD_CURVAL])
    }
    // DENY cannot read the foreign SECRET field → any RELSUMIF over it must be masked for DENY on read.
    await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)', [FS, FLD_SECRET, 'user', DENY, false, false])

    // Materialize in ALLOW's context (can read everything).
    await materializeAs(ALLOW)
  })

  afterAll(async () => {
    await q('DELETE FROM field_permissions WHERE sheet_id = ANY($1::text[])', [[FS, MS]]).catch(() => {})
    await q('DELETE FROM formula_dependencies WHERE sheet_id = $1', [MS]).catch(() => {})
    await q('DELETE FROM meta_links WHERE field_id = $1', [FLD_LINK]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[MS, FS]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('relation-scoped SUM over linked records matching the criteria (sum amt where status=paid → 30)', async () => {
    expect(await readField(ALLOW, FLD_SUMIF)).toBe(30) // FR1(10)+FR2(20); FR3 unpaid excluded
  })

  test('LEAK GATE: a RELSUMIF over a foreign field the reader cannot see is DROPPED on read, not leaked', async () => {
    // ALLOW (can read SECRET) sees the materialized aggregate…
    expect(await readField(ALLOW, FLD_SECRETSUM)).toBe(300) // SECRET of paid: FR1(100)+FR2(200)
    // …DENY (cannot read SECRET) must NOT receive it — the field is absent (taint drop), never 300.
    expect(await hasField(DENY, FLD_SECRETSUM)).toBe(false)
    // and the readable aggregate is unaffected for DENY (amount + status are readable).
    expect(await readField(DENY, FLD_SUMIF)).toBe(30)
    // A.3 RELCOUNTIF leak gate: a COUNT whose CRITERIA is the denied SECRET field (no separate target —
    // target=criteria bridge) must also be dropped for DENY, else the match count leaks SECRET's distribution.
    expect(await readField(ALLOW, FLD_SECRETCOUNT)).toBe(3) // SECRET > 0 for all 3 linked records
    expect(await hasField(DENY, FLD_SECRETCOUNT)).toBe(false)
  })

  test('composition cliff: RELSUMIF composed with arithmetic is rejected fail-loud as #ERROR! (not silent-wrong)', async () => {
    expect(await readField(ALLOW, FLD_CLIFF)).toBe('#ERROR!')
  })

  test('A.3 — RELAVGIF averages the matched target (15) and RELCOUNTIF counts matched records (2, 4-arg)', async () => {
    expect(await readField(ALLOW, FLD_AVGIF)).toBe(15) // avg amt where paid: (10+20)/2
    expect(await readField(ALLOW, FLD_COUNTIF)).toBe(2) // count where status=paid: FR1, FR2
  })

  test('B — RELLOOKUP: first matched record (happy), not-found #N/A, and denied-returnField leak gate', async () => {
    expect(await readField(ALLOW, FLD_LOOKUP)).toBe('paid') // returnField=status of the (only) amt=10 record (FR1)
    expect(await readField(ALLOW, FLD_LOOKUP_NA)).toBe('#N/A') // no linked record has amt=999
    // leak gate: returnField is the DENIED SECRET field → allowed reader gets the value, denied reader's field is dropped
    expect(await readField(ALLOW, FLD_LOOKUP_SECRET)).toBe(100) // FR1.secret (the amt=10 match)
    expect(await hasField(DENY, FLD_LOOKUP_SECRET)).toBe(false)
  })

  test('C — RELVALUES returns the matched values as an ARRAY (link order) + denied-field leak gate', async () => {
    expect(await readField(ALLOW, FLD_VALUES)).toEqual([10, 20]) // amts where status=paid: FR1, FR2 (link order)
    // leak gate: array over the DENIED SECRET field → allowed reader gets the array, denied reader's field is dropped
    expect(await readField(ALLOW, FLD_VALUES_SECRET)).toEqual([100, 200])
    expect(await hasField(DENY, FLD_VALUES_SECRET)).toBe(false)
  })

  // A.2 — foreign-write fan-out (reverse-edge). Runs LAST: it mutates FR1's amount, which the earlier
  // assertions (FLD_SUMIF=30) depend on staying at 10.
  test('A.2 fan-out: editing a FOREIGN target record recomputes the source RELSUMIF via the reverse-edge', async () => {
    const before = await readField(ALLOW, FLD_SUMIF)
    expect(before).toBe(30) // FR1(10)+FR2(20), both paid
    const cur = await q('SELECT version FROM meta_records WHERE id = $1', [FR1])
    const res = await request(buildApp(ALLOW)).post('/api/multitable/patch').send({
      sheetId: FS,
      changes: [{ recordId: FR1, fieldId: FLD_AMT, value: 1000, expectedVersion: Number((cur.rows[0] as any)?.version ?? 1) }],
    })
    expect(res.status).toBe(200)
    // the source record's RELSUMIF recomputed without touching the source record: 1000(FR1)+20(FR2) = 1020
    expect(await readField(ALLOW, FLD_SUMIF)).toBe(1020)
  })
})
