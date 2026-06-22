/**
 * Global History — slice (2): per-field-through-preview (real DB). A fieldIds subset is a FILTER of the same
 * single-record-version diff, folded into the changesHash (filter-then-hash, symmetric at preview + execute) —
 * NOT a new identity scope. Locks: the [A,B]→[A,C] keystone (selection bound), preview-subset→execute-full
 * reject, empty/unchanged/hidden → no executable identity, empty array → 400, and order/dup-insensitivity.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_pf_${TS}`
const SHEET = `sheet_pf_${TS}`
const NAME = `f_name_${TS}`
const SALARY = `f_salary_${TS}`
const NOTE = `f_note_${TS}`
const UNCH = `f_unch_${TS}` // unchanged v1→current → never in the diff
const SECRET = `f_secret_${TS}` // hidden from VIEWER via field_permissions
const REC = `rec_pf_${TS}`
const VIEWER = `user_pf_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
const preview = (body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${REC}/restore-preview`).send(body)
const execute = (body: Record<string, unknown>) => request(app).post(`/api/multitable/sheets/${SHEET}/records/${REC}/restore-execute`).send(body)
const dataOf = async () => ((await q('SELECT data FROM meta_records WHERE id = $1', [REC])).rows[0] as { data: Record<string, unknown> } | undefined)?.data
const field = (id: string, name: string, type: string, order: number) => q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [id, SHEET, name, type, '{}', order])

describeIfDatabase('multitable per-field restore through preview — slice (2) (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: VIEWER, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'PF'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'PF'])
    await field(NAME, 'Name', 'string', 1); await field(SALARY, 'Salary', 'number', 2); await field(NOTE, 'Note', 'string', 3)
    await field(UNCH, 'Unch', 'string', 4); await field(SECRET, 'Secret', 'string', 5)
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [VIEWER])
    // SECRET hidden from VIEWER (so a [SECRET] selection masks to empty).
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,'user',$3,false,false)`, [SHEET, SECRET, VIEWER])
  })
  afterAll(async () => {
    for (const t of ['field_permissions', 'meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {}); await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {}); await q('DELETE FROM users WHERE id = $1', [VIEWER]).catch(() => {})
  })
  // v2 current {b,200,z,same,s2}; v1 snapshot {a,100,y,same,s1}. Restore→v1 changes NAME,SALARY,NOTE,SECRET (UNCH stays).
  beforeEach(async () => {
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET]); await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [REC, SHEET, JSON.stringify({ [NAME]: 'b', [SALARY]: 200, [NOTE]: 'z', [UNCH]: 'same', [SECRET]: 's2' })])
    const rev = (v: number, action: string, data: Record<string, unknown>) => q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at) VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',ARRAY[$5]::text[],'{}'::jsonb,$6::jsonb,now())`, [SHEET, REC, v, action, NAME, JSON.stringify(data)])
    await rev(1, 'create', { [NAME]: 'a', [SALARY]: 100, [NOTE]: 'y', [UNCH]: 'same', [SECRET]: 's1' })
    await rev(2, 'update', { [NAME]: 'b', [SALARY]: 200, [NOTE]: 'z', [UNCH]: 'same', [SECRET]: 's2' })
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('happy path: preview [NAME] → execute [NAME] restores ONLY NAME', async () => {
    const id = (await preview({ targetVersion: 1, fieldIds: [NAME] })).body?.data?.previewIdentity as string
    expect(typeof id).toBe('string')
    const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: id, fieldIds: [NAME] })
    expect(ex.status).toBe(200)
    const d = await dataOf()
    expect(d?.[NAME]).toBe('a') // restored
    expect(d?.[SALARY]).toBe(200); expect(d?.[NOTE]).toBe('z') // untouched
  })

  test('KEYSTONE: an identity minted for [NAME,SALARY] cannot execute [NAME,NOTE]', async () => {
    const id = (await preview({ targetVersion: 1, fieldIds: [NAME, SALARY] })).body?.data?.previewIdentity as string
    const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: id, fieldIds: [NAME, NOTE] })
    expect(ex.status).toBe(409)
    expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID') // different filtered set → different hash
    expect((await dataOf())?.[NAME]).toBe('b') // nothing written
  })

  test('a FULL-record identity cannot execute a per-field SUBSET (filter-then-hash, not verify-full)', async () => {
    // mint over the full diff (no fieldIds → hash(full)); a [NAME] execute hashes only {NAME} → diverges → reject.
    // This is the case that distinguishes filter-then-hash from a buggy verify-full-then-filter-the-write.
    const id = (await preview({ targetVersion: 1 })).body?.data?.previewIdentity as string
    const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: id, fieldIds: [NAME] })
    expect(ex.status).toBe(409)
    expect((await dataOf())?.[NAME]).toBe('b') // nothing written
  })

  test('a subset identity cannot execute the FULL record (omitted fieldIds)', async () => {
    const id = (await preview({ targetVersion: 1, fieldIds: [NAME] })).body?.data?.previewIdentity as string
    const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: id }) // no fieldIds = full diff
    expect(ex.status).toBe(409)
    expect((await dataOf())?.[NAME]).toBe('b')
  })

  test('order / duplicates are irrelevant: [NAME,SALARY] preview, [SALARY,NAME,NAME] execute succeeds', async () => {
    const id = (await preview({ targetVersion: 1, fieldIds: [NAME, SALARY] })).body?.data?.previewIdentity as string
    const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: id, fieldIds: [SALARY, NAME, NAME] })
    expect(ex.status).toBe(200) // same Set → same filtered diff → same hash
    const d = await dataOf(); expect(d?.[NAME]).toBe('a'); expect(d?.[SALARY]).toBe(100)
  })

  test('an UNCHANGED-field selection yields no executable identity (empty filtered diff)', async () => {
    const pv = await preview({ targetVersion: 1, fieldIds: [UNCH] })
    expect(pv.body?.data?.changes).toHaveLength(0)
    expect(pv.body?.data?.previewIdentity).toBeNull()
  })

  test('a HIDDEN-field selection yields no executable identity (masked out before the filter)', async () => {
    const pv = await preview({ targetVersion: 1, fieldIds: [SECRET] }) // SECRET hidden from VIEWER
    expect(pv.body?.data?.changes).toHaveLength(0)
    expect(pv.body?.data?.previewIdentity).toBeNull()
  })

  test('empty filtered diff + ANY token → 409 (no 200-noop bypass of the identity verify)', async () => {
    // A valid signed token, minted for [NAME] (a different, non-empty selection).
    const realToken = (await preview({ targetVersion: 1, fieldIds: [NAME] })).body?.data?.previewIdentity as string
    // Each of these filters to an EMPTY diff (unchanged / hidden / unknown). The execute must 409 — the success
    // contract consumes a valid identity, and the [NAME] token's hash != hash([]). NOT a 200 noop.
    for (const fids of [[UNCH], [SECRET], ['ghost_field_x']]) {
      const ex = await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: realToken, fieldIds: fids })
      expect(ex.status).toBe(409)
      expect(ex.body?.error?.code).toBe('PREVIEW_IDENTITY_INVALID')
    }
    // a forged/garbage token likewise 409s (signature), never a noop.
    expect((await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: 'forged.token.value', fieldIds: [UNCH] })).status).toBe(409)
    expect((await dataOf())?.[NAME]).toBe('b') // nothing written
  })

  test('an empty fieldIds array is a 400 at both preview and execute (never a hash([]) token)', async () => {
    expect((await preview({ targetVersion: 1, fieldIds: [] })).status).toBe(400)
    expect((await execute({ targetVersion: 1, expectedVersion: 2, previewIdentity: 'x.y.z', fieldIds: [] })).status).toBe(400)
  })
})
