/**
 * #4261 follow-up (flag-contract parity): revert-preview's `undeleteSupported` must be the TWO-GATE
 * conjunction of MULTITABLE_ENABLE_PIT_UNDELETE AND MULTITABLE_ENABLE_SHEET_REVERT — because the undelete
 * face rides inside revert-execute, whose SHEET_REVERT master gate (#4261) is checked FIRST. Reporting
 * PIT_UNDELETE alone would promise an undelete that execute then refuses with 403 REVERT_DISABLED.
 *
 * This is the LOAD-BEARING guard: #4261's own revert-pit suite sets SHEET_REVERT on in beforeAll, so
 * deleting `&& SHEET_REVERT_ENABLED()` from the preview would leave it green. The four-state matrix below
 * drives the (ungated) preview route across all combinations; the SHEET_REVERT-off/PIT_UNDELETE-on row is
 * the discriminator (must report false) — the mutation flips it to true and this test goes red.
 *
 * Env discipline: SAVES the incoming SHEET_REVERT/PIT_UNDELETE in beforeAll and RESTORES them in afterAll
 * (never a blind delete); each case sets exactly the two flags it needs. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE = `base_srtg_${TS}`, SHEET = `sheet_srtg_${TS}`
const NAME = `fld_srtg_name_${TS}`, ACTOR = `user_srtg_${TS}`
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-02T00:00:00.000Z', T2 = '2026-01-03T00:00:00.000Z'

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let priorRevert: string | undefined
let priorUndelete: string | undefined
const restoreEnv = (key: string, prior: string | undefined) => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior }
const revertPreview = () => request(app).post(`/api/multitable/sheets/${SHEET}/revert-preview`).send({ asOf: T1 })

async function seed(): Promise<void> {
  // One record deleted AFTER T1 → revert-to-T1 classifies it as an undelete candidate, so preview returns
  // 200 with a meaningful undeleteSupported (the flag conjunction under test).
  const R = `rec_srtg_r_${TS}`
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,1,'create','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`, [SHEET, R, NAME, JSON.stringify({ [NAME]: 'r-at-T1' }), T0])
  await q(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(),$1,$2,2,'delete','rest',ARRAY[$3]::text[],'{}'::jsonb,$4::jsonb,$5)`, [SHEET, R, NAME, JSON.stringify({ [NAME]: 'r-at-T1' }), T2])
}

describeIfDatabase('multitable #4261 revert-preview undeleteSupported two-gate parity (real DB)', () => {
  beforeAll(async () => {
    priorRevert = process.env.MULTITABLE_ENABLE_SHEET_REVERT
    priorUndelete = process.env.MULTITABLE_ENABLE_PIT_UNDELETE
    app = express()
    app.use(express.json())
    app.use((req, _res, next) => { ;(req as any).user = { id: ACTOR, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:share'] }; next() })
    app.use('/api/multitable', univerMetaRouter())
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'SRTG Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'SRTG Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [NAME, SHEET, 'Name', 'string', '{}', 1])
    await q("INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING", [ACTOR])
    await seed()
  })
  afterAll(async () => {
    for (const t of ['meta_record_revisions', 'meta_records', 'meta_fields']) await q(`DELETE FROM ${t} WHERE sheet_id = $1`, [SHEET]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [ACTOR]).catch(() => {})
    restoreEnv('MULTITABLE_ENABLE_SHEET_REVERT', priorRevert)
    restoreEnv('MULTITABLE_ENABLE_PIT_UNDELETE', priorUndelete)
  })

  test('undeleteSupported is the two-gate conjunction across all four states (mutation-catching)', async () => {
    const cases = [
      { revert: false, undelete: false, expected: false },
      { revert: true, undelete: false, expected: false },
      { revert: false, undelete: true, expected: false }, // discriminator: remove `&& SHEET_REVERT_ENABLED()` → this flips to true
      { revert: true, undelete: true, expected: true },
    ]
    for (const c of cases) {
      if (c.revert) process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
      else delete process.env.MULTITABLE_ENABLE_SHEET_REVERT
      if (c.undelete) process.env.MULTITABLE_ENABLE_PIT_UNDELETE = 'true'
      else delete process.env.MULTITABLE_ENABLE_PIT_UNDELETE
      const res = await revertPreview()
      expect(res.status).toBe(200)
      expect(res.body?.data?.undeleteSupported).toBe(c.expected)
    }
  })
})
