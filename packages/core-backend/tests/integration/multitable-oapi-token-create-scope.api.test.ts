/**
 * OAPI-4a — REST token-create scope plumbing (real DB).
 *
 * Regression for a review finding: the supported minting surface POST /api/multitable/api-tokens had a
 * `CreateTokenSchema` of only {name,scopes,expiresAt}, so Zod's default unknown-key STRIP silently dropped a
 * caller's `baseIds`/`sheetIds` → a "scoped" create produced an UNSCOPED creator-wide token (a least-privilege
 * footgun: scoped tokens could not be minted through the API at all).
 *
 * Proves the supported surface now: (1) REST create accepts + persists baseIds/sheetIds and returns them;
 * (2) the list reflects the persisted scope; (3) the REST-minted token is genuinely ENFORCED by oapiScopeGuard
 * (denied out-of-scope) — i.e. the scope is real end-to-end, not just echoed back. Runs only with DATABASE_URL.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

// Stub ONLY the session-auth middleware (inject the logged-in creator) — the REAL db is kept, so the token is
// genuinely persisted and the guard enforces against real meta_sheets. The factory cannot close over outer
// vars (vi.mock is hoisted), so the creator id is a fixed literal, mirrored by WRITER below.
vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: { user?: unknown }, _res: unknown, next: () => void) => {
    ;(req as { user?: unknown }).user = { id: 'user_tc_oapi4a_fixed' }
    next()
  }
  return { authenticate, authMiddleware: authenticate, default: authenticate }
})

import { apiTokensRouter } from '../../src/routes/api-tokens'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const WRITER = 'user_tc_oapi4a_fixed' // MUST equal the id injected by the auth mock above
const BASE_X = `base_tc_x_${TS}`
const BASE_Y = `base_tc_y_${TS}`
const SHEET_X = `sheet_tc_x_${TS}`
const SHEET_Y = `sheet_tc_y_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let mintedPlaintext = ''

describeIfDatabase('OAPI-4a REST token-create scope plumbing (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    app.use(apiTokensRouter()) // absolute paths: /api/multitable/api-tokens (session create/list)
    app.use('/api/multitable', univerMetaRouter()) // the mst_ guard path: /api/multitable/records
    // Clean any residue from a prior run (the creator id is fixed).
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', WRITER).execute().catch(() => {})
    // The creator holds global multitable perms so the 3-way min's CREATOR-RBAC leg passes for an in-scope op
    // (the guard is the base/sheet leg; an in-scope op must clear BOTH to succeed).
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [WRITER, `${WRITER}@t.local`, WRITER, JSON.stringify(['multitable:read', 'multitable:write'])],
    )
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2),($3,$4)', [BASE_X, 'TC X', BASE_Y, 'TC Y'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3),($4,$5,$6)', [
      SHEET_X, BASE_X, 'X', SHEET_Y, BASE_Y, 'Y',
    ])
    // A field + record on SHEET_X (mirrors the scope-guard golden) so the in-scope read is a faithful 200.
    await q(`INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,'F','text','{}'::jsonb,1)`, [`fld_tc_x_${TS}`, SHEET_X])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [`rec_tc_x_${TS}`, SHEET_X, JSON.stringify({})])
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', WRITER).execute().catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET_X, SHEET_Y]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET_X, SHEET_Y]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_X, SHEET_Y]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_X, BASE_Y]]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [WRITER]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('REST create accepts + persists baseIds (NOT stripped) and returns them', async () => {
    const res = await request(app)
      .post('/api/multitable/api-tokens')
      .send({ name: 'scoped-x', scopes: ['records:write', 'records:read'], baseIds: [BASE_X] })
    expect(res.status).toBe(201)
    expect(res.body?.data?.token?.baseIds).toEqual([BASE_X])
    expect(typeof res.body?.data?.plaintext).toBe('string')
    expect(res.body.data.plaintext).toMatch(/^mst_/)
    mintedPlaintext = res.body.data.plaintext
    // persisted, not merely echoed
    const row = await q('SELECT base_ids FROM multitable_api_tokens WHERE id = $1', [res.body.data.token.id])
    expect((row.rows[0] as { base_ids: string[] }).base_ids).toEqual([BASE_X])
  })

  test('list reflects the persisted scope', async () => {
    const res = await request(app).get('/api/multitable/api-tokens')
    expect(res.status).toBe(200)
    const tok = (res.body?.data?.tokens ?? []).find((t: { name?: string }) => t.name === 'scoped-x')
    expect(tok?.baseIds).toEqual([BASE_X])
  })

  test('the REST-minted scoped token is ENFORCED — denied out-of-scope (base Y) 403 OUT_OF_SCOPE', async () => {
    const res = await request(app)
      .post('/api/multitable/records')
      .set('Authorization', `Bearer ${mintedPlaintext}`)
      .send({ sheetId: SHEET_Y, data: {} })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('OUT_OF_SCOPE')
  })

  test('the REST-minted scoped token is allowed IN-scope (base X) — proves the scope is the gate, not a blanket block', async () => {
    const res = await request(app)
      .get(`/api/multitable/records?sheetId=${SHEET_X}`)
      .set('Authorization', `Bearer ${mintedPlaintext}`)
    expect(res.status).toBe(200)
  })

  test('REST create accepts sheetIds too (not stripped)', async () => {
    const res = await request(app)
      .post('/api/multitable/api-tokens')
      .send({ name: 'scoped-sheet', scopes: ['records:read'], sheetIds: [SHEET_X] })
    expect(res.status).toBe(201)
    expect(res.body?.data?.token?.sheetIds).toEqual([SHEET_X])
  })
})
