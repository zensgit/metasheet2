/**
 * W0 step-1 (emergency stop-loss): the DESTRUCTIVE point-in-time revert-execute is DEFAULT-OFF behind
 * MULTITABLE_ENABLE_PIT_REVERT. This is the NEGATIVE CONTROL — with the flag OFF the route must refuse
 * with 403 REVERT_DISABLED BEFORE any parse / auth / DB read / write, leaving the record + revision rows
 * unchanged. (The gate is the handler's FIRST statement, so nothing downstream runs at all — including
 * link writes; this test directly checks records + revisions, from which no-op is proven.) Positive
 * control: with the flag ON the same call gets PAST the gate (a different, non-REVERT_DISABLED response),
 * proving the gate is load-bearing rather than always-403.
 *
 * Env discipline: this file SAVES the incoming MULTITABLE_ENABLE_PIT_REVERT / _PIT_UNDELETE in beforeAll
 * and RESTORES them in afterAll (never a blind delete), and forces them OFF in beforeEach so the negative
 * control is immune to a sibling file that set them. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_w0rg_${TS}`, SHEET = `sheet_w0rg_${TS}`
const NAME = `fld_w0rg_name_${TS}`, SALARY = `fld_w0rg_salary_${TS}`
const A = `rec_w0rg_a_${TS}`, ACTOR = `user_w0rg_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let priorRevert: string | undefined
let priorUndelete: string | undefined
const restoreEnv = (key: string, prior: string | undefined) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior }
const revertExecute = (body: unknown) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-execute`).send(body)
const revertPreview = (body: unknown) => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send(body)
const countWhere = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE sheet_id = $1`, [SHEET])).rows[0].n)

async function seed(): Promise<void> {
  // A: existed at T0 with old values, edited at T2 → live = new. A revert-to-T0 WOULD overwrite it back to
  // 'old' AND append a forward revision — so if the gate leaked, these counts/data would change.
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,2)', [A, SHEET, JSON.stringify({ [NAME]: 'new', [SALARY]: 200 })])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[$3,$4]::text[],'{}'::jsonb,$5::jsonb,$6)`, [SHEET, A, NAME, SALARY, JSON.stringify({ [NAME]: 'old', [SALARY]: 100 }), T0])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,2,'update','rest',ARRAY[$3,$4]::text[],'{}'::jsonb,$5::jsonb,$6)`, [SHEET, A, NAME, SALARY, JSON.stringify({ [NAME]: 'new', [SALARY]: 200 }), T2])
}

describeIfDatabase('multitable W0 step-1 revert-execute default-off gate (real DB)', () => {
  beforeAll(async () => {
    priorRevert = process.env.MULTITABLE_ENABLE_PIT_REVERT
    priorUndelete = process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'W0RG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'W0RG Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [SALARY, SHEET, 'Salary', 'number', '{}', 2])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await seed()
  })
  afterAll(async () => {
    for (const t of ['meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    restoreEnv('MULTITABLE_ENABLE_PIT_REVERT', priorRevert)
    restoreEnv('MULTITABLE_ENABLE_PIT_UNDELETE', priorUndelete)
  })
  beforeEach(() => {
    // Immune to a sibling file that set the flag: this negative control ALWAYS runs with the gate OFF.
    delete process.env.MULTITABLE_ENABLE_PIT_REVERT
    delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
  })

  test('flag OFF → 403 REVERT_DISABLED with ZERO record / revision writes', async () => {
    const before = { records: await countWhere('meta_records'), revisions: await countWhere('meta_record_revisions') }
    const res = await revertExecute({ asOf: T0, previewIdentity: 'irrelevant-because-gate-is-first' })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('REVERT_DISABLED')
    // Zero writes: counts unchanged AND the live record still holds its post-T2 value (never reverted to 'old').
    expect(await countWhere('meta_records')).toBe(before.records)
    expect(await countWhere('meta_record_revisions')).toBe(before.revisions)
    const live = (await q('SELECT data, version FROM meta_records WHERE id = $1', [A])).rows[0] as { data: Record<string, unknown>; version: number }
    expect(live.version).toBe(2)
    expect(live.data[NAME]).toBe('new')
  })

  test('the gate precedes PARSE: even a body with no asOf/previewIdentity gets 403 REVERT_DISABLED (not 400)', async () => {
    const res = await revertExecute({ garbage: true })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('REVERT_DISABLED') // NOT VALIDATION_ERROR — the gate is the very first statement
  })

  test('undelete needs BOTH flags: PIT_UNDELETE on but PIT_REVERT off → still 403 REVERT_DISABLED', async () => {
    process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true' // undelete enabled...
    // ...but the revert gate (checked FIRST) is still off, so an undelete-shaped revert is refused outright.
    const res = await revertExecute({ asOf: T0, previewIdentity: 'x', confirm: 'undelete' })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('REVERT_DISABLED')
  })

  test('positive control — flag ON → the SAME call gets PAST the gate (not REVERT_DISABLED)', async () => {
    process.env.MULTITABLE_ENABLE_PIT_REVERT = 'true'
    const res = await revertExecute({ garbage: true }) // no valid body → should now reach parse → 400 VALIDATION_ERROR
    expect(res.body?.error?.code).not.toBe('REVERT_DISABLED') // proves the gate is what refused above, not an always-403
    expect(res.status).toBe(400)
  })

  // W0 step-1 review P2: revert-preview's `undeleteSupported` must be the TWO-GATE conjunction, and this
  // must be LOAD-BEARING. The existing undelete real-DB tests set PIT_REVERT on in beforeAll, so deleting
  // `&& PIT_REVERT_ENABLED()` from the preview leaves them green. This four-state matrix exercises all
  // combinations against the LIVE preview route (which is NOT gated, so it runs in every state); the
  // revert-OFF/undelete-ON row is the discriminator — it MUST report false, so the mutation flips it to
  // true and this test goes red.
  test('revert-preview undeleteSupported is the two-gate conjunction (four-state matrix, mutation-catching)', async () => {
    const cases = [
      { revert: false, undelete: false, expected: false },
      { revert: true, undelete: false, expected: false },
      { revert: false, undelete: true, expected: false }, // discriminator: remove `&& PIT_REVERT_ENABLED()` → this flips to true
      { revert: true, undelete: true, expected: true },
    ]
    for (const c of cases) {
      if (c.revert) process.env.MULTITABLE_ENABLE_PIT_REVERT = 'true'
      else delete process.env.MULTITABLE_ENABLE_PIT_REVERT
      if (c.undelete) process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
      else delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
      const res = await revertPreview({ asOf: T0 })
      expect(res.status).toBe(200)
      expect(res.body?.data?.undeleteSupported).toBe(c.expected)
    }
  })
})
