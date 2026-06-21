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
 * Trigger: a PATCH (here, re-setting the link) recomputes dependent formulas via recalculateFormulaFields;
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
const relExpr = (target: string, value: string) => JSON.stringify({ expression: `RELSUMIF("${FLD_LINK}","${target}","${FLD_STATUS}","is","${value}")` })

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
// Re-set the link to its current ids → triggers recalculateFormulaFields (formulas depend on the link).
async function materializeAs(userId: string): Promise<void> {
  const cur = await q('SELECT version FROM meta_records WHERE id = $1', [REC])
  const version = Number((cur.rows[0] as any)?.version ?? 1)
  const res = await request(buildApp(userId)).post('/api/multitable/patch').send({
    sheetId: MS,
    changes: [{ recordId: REC, fieldId: FLD_LINK, value: [FR1, FR2, FR3], expectedVersion: version }],
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
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SUMIF, MS, 'SumIf', 'formula', relExpr(FLD_AMT, 'paid'), 3])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_SECRETSUM, MS, 'SecretSum', 'formula', relExpr(FLD_SECRET, 'paid'), 4])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FLD_CLIFF, MS, 'Cliff', 'formula', JSON.stringify({ expression: `RELSUMIF("${FLD_LINK}","${FLD_AMT}","${FLD_STATUS}","is","paid")+1` }), 5])

    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, MS, JSON.stringify({ [FLD_LINK]: [FR1, FR2, FR3], [FLD_CURVAL]: 'paid' })])
    for (const fr of [FR1, FR2, FR3]) {
      await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)', [`lnk_rel_${fr}`, FLD_LINK, REC, fr])
    }
    // Formula deps on the link (the string-literal link arg is invisible to the {fld} extractor; the
    // create handler would register it, but these fields are seeded via SQL, so insert the edge directly).
    for (const ff of [FLD_SUMIF, FLD_SECRETSUM, FLD_CLIFF]) {
      await q('INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id) VALUES ($1,$2,$3,NULL)', [MS, ff, FLD_LINK])
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
  })

  test('composition cliff: RELSUMIF composed with arithmetic is rejected fail-loud as #ERROR! (not silent-wrong)', async () => {
    expect(await readField(ALLOW, FLD_CLIFF)).toBe('#ERROR!')
  })
})
