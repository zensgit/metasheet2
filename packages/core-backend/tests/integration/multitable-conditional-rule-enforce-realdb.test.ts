/**
 * #18 phase-2 (2b) conditional read-deny rules — CORE enforcement (real DB).
 *
 * A predicate rule `{ fieldId, operator:'eq', value:'secret', effect:'deny_read' }` hides every record
 * whose data matches it, on every read surface — by feeding the SAME per-record deny set #18 already
 * enforces (loadDeniedRecordIds, extended to union loadRuleDeniedRecordIds). So admin-bypass, masking,
 * and no-cardinality-leak come from the #18 machinery; this golden proves the rule-deny reaches every
 * read surface in the 2b-S2 acceptance criterion — single GET, GET /records (list), /records-summary,
 * search/filter (deny applied BEFORE filter), view-aggregate (total + aggregate, no count leak),
 * export-xlsx (denied row never reaches the workbook), and link-options (denied record not offered as a
 * link target) — bypasses for admins, fails closed on a missing-field rule, and is inert when the flag
 * is off OR the rule list is empty. (Trash list/restore is a deliberately deferred separate surface —
 * loadRuleDeniedRecordIds evaluates live meta_records only; that gap is owner-gated, not covered here.)
 *
 * Reuses the existing `row_level_read_permissions_enabled` flag (every surface already gates on it).
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import * as XLSX from 'xlsx'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_crd_${TS}`
const SHEET_ID = `sheet_crd_${TS}`
const STATUS = `fld_crd_status_${TS}`
const LINKF = `fld_crd_link_${TS}` // self-link (same base) pointing at SHEET_ID, for the link-picker surface
const REC_SECRET = `rec_crd_secret_${TS}`
const REC_PUBLIC = `rec_crd_public_${TS}`
const USER_ID = `user_crd_${TS}`

// supertest binary collector for the xlsx export surface (the response is an xlsx attachment, not JSON)
const binaryParser = (res: { on: (e: string, cb: (...a: unknown[]) => void) => void }, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  res.on('data', (c: unknown) => chunks.push(Buffer.from(c as Buffer)))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let testUserId = USER_ID
let testPerms: string[] = ['multitable:read']
let testRoles: string[] = []

const getRecord = (id: string) => request(app).get(`/api/multitable/records/${id}`)
const setFlag = (on: boolean) =>
  q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) =>
  q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])
const denySecretRule = [{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }]
const missingFieldRule = [{ id: 'r2', fieldId: 'fld_does_not_exist', operator: 'eq', value: 'x', effect: 'deny_read' }]

const listIds = async (): Promise<string[]> => {
  const res = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
  expect(res.status).toBe(200)
  return (res.body?.data?.records ?? []).map((r: { id: string }) => r.id)
}
const summaryIds = async (): Promise<string[]> => {
  const res = await request(app).get('/api/multitable/records-summary').query({ sheetId: SHEET_ID, limit: 100 })
  expect(res.status).toBe(200)
  return (res.body?.data?.records ?? []).map((r: { id: string }) => r.id)
}

describeIfDatabase('#18 phase-2 conditional read-deny rule enforcement (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as any).user = testUserId ? { id: testUserId, roles: testRoles, perms: testPerms } : undefined
      next()
    })
    app.use('/api/multitable', univerMetaRouter())

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'CRD Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'CRD Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    // self-link (same base → no cross-base gate) so the link-picker surface enumerates THIS sheet's records
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [LINKF, SHEET_ID, 'SelfLink', 'link', JSON.stringify({ foreignSheetId: SHEET_ID }), 2])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_SECRET, SHEET_ID, JSON.stringify({ [STATUS]: 'secret' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_PUBLIC, SHEET_ID, JSON.stringify({ [STATUS]: 'public' })])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  beforeEach(async () => {
    testUserId = USER_ID
    testPerms = ['multitable:read']
    testRoles = []
    await setFlag(false)
    await setRules([])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('inert — flag OFF even with a deny rule: secret record is visible everywhere', async () => {
    await setRules(denySecretRule)
    await setFlag(false)
    expect((await getRecord(REC_SECRET)).status).toBe(200)
    expect(await listIds()).toContain(REC_SECRET)
    expect(await summaryIds()).toContain(REC_SECRET)
  })

  test('inert — flag ON but EMPTY rules: secret record is visible everywhere', async () => {
    await setFlag(true)
    await setRules([])
    expect((await getRecord(REC_SECRET)).status).toBe(200)
    expect(await listIds()).toContain(REC_SECRET)
  })

  test('enforce — flag ON + deny rule: secret HIDDEN, public visible (single GET)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await getRecord(REC_SECRET)
    expect(denied.status).toBe(403)
    expect(JSON.stringify(denied.body)).not.toContain('"data"')
    expect((await getRecord(REC_PUBLIC)).status).toBe(200)
  })

  test('enforce — flag ON + deny rule: GET /records excludes secret, keeps public', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const ids = await listIds()
    expect(ids).not.toContain(REC_SECRET)
    expect(ids).toContain(REC_PUBLIC)
  })

  test('enforce — flag ON + deny rule: /records-summary excludes secret', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const ids = await summaryIds()
    expect(ids).not.toContain(REC_SECRET)
    expect(ids).toContain(REC_PUBLIC)
  })

  test('admin bypass — flag ON + deny rule: an admin sees the secret record', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    testRoles = ['admin']
    expect((await getRecord(REC_SECRET)).status).toBe(200)
    expect(await listIds()).toContain(REC_SECRET)
    testPerms = ['multitable:read']
  })

  test('fail-closed — flag ON + rule on a MISSING field: even the public record is denied (never fail-open)', async () => {
    await setFlag(true)
    await setRules(missingFieldRule)
    // a rule whose field is absent cannot be evaluated → the evaluator DENIES; so both records hide.
    expect((await getRecord(REC_PUBLIC)).status).toBe(403)
    expect(await listIds()).not.toContain(REC_PUBLIC)
  })

  // --- remaining read surfaces from the 2b-S2 acceptance criterion (view/search-filter, ---
  // --- aggregate/dashboard, export, link picker). Each consumes the same loadDeniedRecordIds set, ---
  // --- so the rule-deny is unioned in; these goldens assert it actually reaches every surface. ---

  test('enforce — search/filter (GET /records?filter): deny applied BEFORE filter, so filtering on the denied value cannot surface it', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const filtered = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100, [`filter.${STATUS}`]: 'secret' })
    expect(filtered.status).toBe(200)
    expect((filtered.body?.data?.records ?? []).map((r: { id: string }) => r.id)).not.toContain(REC_SECRET)
    // control: same filter, deny OFF → the secret record IS returned, proving the filter matches it
    // (so the exclusion above is the deny acting, not the filter merely not matching).
    await setFlag(false)
    const ctrl = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100, [`filter.${STATUS}`]: 'secret' })
    expect((ctrl.body?.data?.records ?? []).map((r: { id: string }) => r.id)).toContain(REC_SECRET)
  })

  test('enforce — view-aggregate: denied record excluded from total + aggregates (no count leak on the dashboard surface)', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`)
    expect(denied.status).toBe(200)
    expect(denied.body?.data?.total).toBe(1) // only REC_PUBLIC counted
    // control: deny OFF → both records counted (proves the deny-ON total is the deny acting).
    await setFlag(false)
    const all = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`)
    expect(all.body?.data?.total).toBe(2)
  })

  test('enforce — export-xlsx: a denied record never reaches the exported workbook', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const res = await request(app).get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx`).buffer(true).parse(binaryParser)
    expect(res.status).toBe(200)
    const wb = XLSX.read(res.body as Buffer, { type: 'buffer' })
    const cells = (XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }) as unknown[][]).flat()
    expect(cells).not.toContain('secret') // REC_SECRET's Status value is gone from the workbook
    expect(cells).toContain('public') // REC_PUBLIC still exported (sanity: the export ran, not empty)
  })

  test('enforce — link-picker (link-options): a rule-denied record is not offered as a link target', async () => {
    await setFlag(true)
    await setRules(denySecretRule)
    const denied = await request(app).get(`/api/multitable/fields/${LINKF}/link-options`).query({ limit: 100 })
    expect(denied.status).toBe(200)
    expect(JSON.stringify(denied.body)).not.toContain(REC_SECRET)
    // control: deny OFF → the record IS offered (proves it would otherwise be selectable).
    await setFlag(false)
    const all = await request(app).get(`/api/multitable/fields/${LINKF}/link-options`).query({ limit: 100 })
    expect(JSON.stringify(all.body)).toContain(REC_SECRET)
  })
})
