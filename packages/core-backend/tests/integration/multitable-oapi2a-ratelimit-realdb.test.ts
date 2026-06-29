/**
 * OAPI-2a — wrong-scope write attempts ARE rate-limited (real DB).
 *
 * Regression guard for the review P1: the per-token limiter runs BEFORE `requireScope`, so a `records:read`
 * token cannot hammer a write route unbounded. Within the per-token cap each attempt 403s (denied audit);
 * beyond the cap it is 429 (rate_limited audit) — proving rate-limiting covers ALL token write attempts, not
 * only scope-correct ones.
 *
 * The 600/min cap is lowered via `OAPI_WRITE_RATE_LIMIT_MAX`, which the limiter reads PER-REQUEST (runtime
 * cap) — so it is honored regardless of when the rate-limiter module was first imported in this batched
 * Vitest invocation (the module-load-time read was unreliable across files). Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_oapi2rl_${TS}`
const SHEET_ID = `sheet_oapi2rl_${TS}`
const CREATOR = `user_oapi2rl_${TS}`
const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let tokRead = ''
let tokReadId = ''

describeIfDatabase('OAPI-2a wrong-scope writes are rate-limited (real DB)', () => {
  beforeAll(async () => {
    process.env.OAPI_WRITE_RATE_LIMIT_MAX = '2' // runtime cap (read per-request) — independent of import timing
    app = express()
    app.use(express.json())
    app.use('/api/multitable', univerMetaRouter())

    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [CREATOR, `${CREATOR}@t.local`, CREATOR, JSON.stringify(['multitable:write'])],
    )
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'rl'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'rl'])

    const svc = new ApiTokenService(db)
    const r = await svc.createToken(CREATOR, { name: 'read', scopes: ['records:read'] })
    tokRead = r.plainTextToken
    tokReadId = r.token.id
  })

  afterAll(async () => {
    delete process.env.OAPI_WRITE_RATE_LIMIT_MAX
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', CREATOR).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE token_id = $1', [tokReadId]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [CREATOR]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('records:read token hammering POST /records is capped per-token (403 within cap, 429 beyond)', async () => {
    const hit = () =>
      request(app)
        .post('/api/multitable/records')
        .set('Authorization', `Bearer ${tokRead}`)
        .send({ sheetId: SHEET_ID, data: {} })
    const r1 = await hit()
    const r2 = await hit()
    const r3 = await hit()
    expect(r1.status).toBe(403) // within cap (2): limiter passes → requireScope → 403 (denied)
    expect(r2.status).toBe(403)
    expect(r3.status).toBe(429) // 3rd exceeds the cap → rate-limited BEFORE requireScope
    await new Promise((res) => setTimeout(res, 100)) // let the boundary res.on('finish') listeners flush
    const rows = (await q('SELECT outcome, status_code FROM oapi_write_audit WHERE token_id = $1', [tokReadId]))
      .rows as Array<{ outcome: string; status_code: number }>
    expect(rows.some((x) => x.outcome === 'denied' && x.status_code === 403)).toBe(true)
    expect(rows.some((x) => x.outcome === 'rate_limited' && x.status_code === 429)).toBe(true)
  })
})
