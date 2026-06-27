/**
 * T9-W Tier 2 (U-2) — field type/property retype revert (real DB). SCHEMA-ONLY + LOSSLESS: the forward PATCH /fields
 * route changes type/property with NO cell-value migration (stored values kept raw; the read path tolerates
 * type-mismatched values), so reverting type/property via a raw meta_fields UPDATE is symmetric with the forward op
 * and does NOT coerce or drop stored values. Behind the per-tier flag MULTITABLE_ENABLE_FIELD_RETYPE_REVERT (default
 * off). Restricted to SCALAR<->SCALAR type changes — both endpoints must be plain scalars (not computed / link /
 * attachment / autoNumber / system); a non-scalar retype needs the forward route's side-effect handlers (formula deps
 * / autoNumber sequence / link join-table) that a raw UPDATE skips, so it stays gated.
 *
 * Goldens: (a) flag-OFF -> preview AND execute 403 FIELD_RETYPE_REVERT_DISABLED · (b) gate: no canManageFields -> 403 ·
 * (c) flag-ON happy path: preview confirmable (opKind safe, no drift) -> execute reverts the field type AND a stored
 * value that does NOT fit the reverted-to type is KEPT (lossless, not dropped) + forward source=restore revision ·
 * (d) scalar restriction: a retype whose endpoint type is non-scalar (link) stays gated even flag-ON (preview not
 * confirmable, execute 422), no write · (e) drift: field type changed between preview and execute -> execute 409.
 * Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_frt_${TS}`
const SHEET = `sheet_frt_${TS}`
const FIELD = `fld_frt_${TS}`
const REC = `rec_frt_${TS}`
const U_FULL = `u_frt_full_${TS}` // multitable:write -> canManageFields
const U_READ = `u_frt_read_${TS}` // read-only -> NO canManageFields
const FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let actor: { id: string; roles: string[]; perms: string[] }
const FULL = { id: U_FULL, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const READONLY = { id: U_READ, roles: ['member'], perms: ['multitable:read'] }

const preview = (revisionId: string, as: typeof FULL) => { actor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-preview`).send({ revisionId }) }
const execute = (revisionId: string, previewToken: string, as: typeof FULL) => { actor = as; return request(app).post(`/api/multitable/sheets/${SHEET}/config-restore-execute`).send({ revisionId, previewToken }) }
const fieldType = async (): Promise<string> => ((await q('SELECT type FROM meta_fields WHERE id=$1', [FIELD])).rows[0] as { type: string }).type
const recValue = async (): Promise<unknown> => ((await q('SELECT data->>$2 AS v FROM meta_records WHERE id=$1', [REC, FIELD])).rows[0] as { v: unknown }).v
const restoreRevCount = async (): Promise<number> => ((await q(`SELECT count(*)::int AS n FROM meta_config_revisions WHERE sheet_id=$1 AND source='restore'`, [SHEET])).rows[0] as { n: number }).n
// craft a field config revision (entity_id = the field; action 'update'; source defaults to 'mutation')
const craftFieldRev = async (changedKeys: string[], before: unknown, after: unknown): Promise<string> => ((await q(`INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id) VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5,$6) RETURNING id`, [SHEET, FIELD, JSON.stringify(before), JSON.stringify(after), changedKeys, U_FULL])).rows[0] as { id: string }).id
const seedField = async (type: string, recordValue: unknown) => {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [FIELD, SHEET, 'F', type, '{}', 1])
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC, SHEET, JSON.stringify({ [FIELD]: recordValue })])
}

describeIfDatabase('multitable field retype revert — T9-W Tier 2 (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as { user?: unknown }).user = actor; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'FRT Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, SHEET])
    for (const u of [U_FULL, U_READ]) await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [u])
  })
  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    for (const u of [U_FULL, U_READ]) await q('DELETE FROM users WHERE id = $1', [u]).catch(() => {})
  })
  afterEach(() => { delete process.env[FLAG] })
  beforeEach(async () => {
    // each test seeds its own field + record state, so reset between tests
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('(a) flag OFF -> preview AND execute 403 FIELD_RETYPE_REVERT_DISABLED', async () => {
    await seedField('number', 'hello')
    const rev = await craftFieldRev(['type'], { type: 'string' }, { type: 'number' })
    const p = await preview(rev, FULL)
    expect(p.status).toBe(403)
    expect(p.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
    const x = await execute(rev, 'tok', FULL)
    expect(x.status).toBe(403)
    expect(x.body?.error?.code).toBe('FIELD_RETYPE_REVERT_DISABLED')
  })

  test('(b) gate: actor without canManageFields -> 403', async () => {
    process.env[FLAG] = 'true'
    await seedField('number', 'hello')
    const rev = await craftFieldRev(['type'], { type: 'string' }, { type: 'number' })
    const p = await preview(rev, READONLY)
    expect(p.status).toBe(403)
  })

  test('(c) flag ON happy path: preview confirmable -> execute reverts type; a non-fitting value is KEPT (lossless); forward restore revision', async () => {
    process.env[FLAG] = 'true'
    // current type 'string' holding 'hello' (NOT a valid number). Revert string->number (before=number, after=string).
    await seedField('string', 'hello')
    const rev = await craftFieldRev(['type'], { type: 'number' }, { type: 'string' })
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).toBe('safe') // route override -> FE shows confirm
    expect(p.body?.data?.preview?.driftConflict).toBe(false)
    const token = p.body?.data?.previewToken
    const x = await execute(rev, token, FULL)
    expect(x.status).toBe(200)
    expect(await fieldType()).toBe('number') // type reverted to `before`
    expect(await recValue()).toBe('hello') // LOSSLESS: the non-numeric value is KEPT, not coerced/dropped
    expect(await restoreRevCount()).toBeGreaterThanOrEqual(1) // forward source=restore revision appended
  })

  test('(d) scalar restriction: a NON-scalar endpoint (link) stays gated even flag-ON -> preview not confirmable + execute 422, no write', async () => {
    process.env[FLAG] = 'true'
    await seedField('string', 'keepme')
    // before=link (non-scalar) -> reverting would need link join-table handling -> must stay gated
    const rev = await craftFieldRev(['type'], { type: 'link' }, { type: 'string' })
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    expect(p.body?.data?.preview?.opKind).not.toBe('safe') // NOT confirmable
    const token = p.body?.data?.previewToken
    const x = await execute(rev, token, FULL)
    expect(x.status).toBe(422)
    expect(x.body?.error?.code).toBe('RESTORE_NOT_SUPPORTED')
    expect(await fieldType()).toBe('string') // no write — field type unchanged
  })

  test('(e) drift: field type changed between preview and execute -> execute 409', async () => {
    process.env[FLAG] = 'true'
    await seedField('number', 'x')
    const rev = await craftFieldRev(['type'], { type: 'string' }, { type: 'number' })
    const p = await preview(rev, FULL)
    expect(p.status).toBe(200)
    const token = p.body?.data?.previewToken
    await q('UPDATE meta_fields SET type=$2 WHERE id=$1', [FIELD, 'string']) // live moved after preview (now != `after`)
    const x = await execute(rev, token, FULL)
    expect(x.status).toBe(409)
  })
})
