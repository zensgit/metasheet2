/**
 * OAPI-1 — read-only API-token routes (real DB).
 * Design-lock: docs/development/multitable-openapi-token-auth-designlock-20260619.md.
 *
 * Proves an `mst_` token authenticates GET /records (records:read) AS ITS CREATOR (Option A) through the
 * full permission stack, with deny-by-default scope + revoke:
 *   - valid records:read token → 200, returns records;
 *   - token missing records:read → 403 INSUFFICIENT_SCOPE;
 *   - revoked token → 401;
 *   - no token → 401 (auth required);
 *   - NEVER EXCEEDS CREATOR (the spine): a record the creator is row-level-denied is NOT returned through
 *     the token — the token reads exactly what the creator can, no more;
 *   - READ-ONLY: the same token on a write route (POST /patch) is rejected (no apiTokenAuth mounted there).
 *
 * Token validation runs against the kysely `db`; records/flags via poolManager — both on DATABASE_URL.
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApiTokenService } from '../../src/multitable/api-token-service'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const BASE_ID = `base_oapi1_${TS}`
const SHEET_ID = `sheet_oapi1_${TS}`
const STATUS = `fld_oapi1_status_${TS}`
const REC_OPEN = `rec_oapi1_open_${TS}`
const REC_SECRET = `rec_oapi1_secret_${TS}`
const CREATOR = `user_oapi1_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)
let app: Express
let tokReadOk = '' // records:read
let tokNoScope = '' // comments:read only
let tokRevoked = '' // records:read, then revoked
let tokFields = '' // fields:read (no records:read)
const auth = (path: string, token: string) => request(app).get(path).set('Authorization', `Bearer ${token}`)
const setFlag = (on: boolean) => q('UPDATE meta_sheets SET row_level_read_permissions_enabled = $2 WHERE id = $1', [SHEET_ID, on])
const setRules = (rules: unknown[]) => q('UPDATE meta_sheets SET conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, JSON.stringify(rules)])

describeIfDatabase('OAPI-1 read-only API-token routes (real DB)', () => {
  beforeAll(async () => {
    app = express()
    app.use(express.json())
    // No fake-user middleware: the route's apiTokenAuth must set the actor from the token itself.
    app.use('/api/multitable', univerMetaRouter())

    // Creator with REAL perms (token requests load via listUserPermissions, not req.user.perms); non-admin.
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
             VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
             ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [CREATOR, `${CREATOR}@t.local`, 'OAPI1 Creator', JSON.stringify(['multitable:read'])])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'OAPI1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'OAPI1 Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [STATUS, SHEET_ID, 'Status', 'select', '{}', 1])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_OPEN, SHEET_ID, JSON.stringify({ [STATUS]: 'open' })])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [REC_SECRET, SHEET_ID, JSON.stringify({ [STATUS]: 'secret' })])

    const svc = new ApiTokenService(db)
    tokReadOk = (await svc.createToken(CREATOR, { name: 'read-ok', scopes: ['records:read'] })).plainTextToken
    tokNoScope = (await svc.createToken(CREATOR, { name: 'no-scope', scopes: ['comments:read'] })).plainTextToken
    tokFields = (await svc.createToken(CREATOR, { name: 'fields', scopes: ['fields:read'] })).plainTextToken
    const revoked = await svc.createToken(CREATOR, { name: 'revoked', scopes: ['records:read'] })
    tokRevoked = revoked.plainTextToken
    await svc.revokeToken(revoked.token.id, CREATOR)
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', CREATOR).execute().catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [CREATOR]).catch(() => {})
  })

  beforeEach(async () => {
    await setFlag(false)
    await setRules([])
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('valid records:read token → 200, returns records (authenticates as creator)', async () => {
    const res = await auth('/api/multitable/records', tokReadOk).query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(200)
    const ids = (res.body?.data?.records ?? []).map((r: { id: string }) => r.id)
    expect(ids).toContain(REC_OPEN)
    expect(ids).toContain(REC_SECRET)
  })

  test('token missing records:read → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await auth('/api/multitable/records', tokNoScope).query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('INSUFFICIENT_SCOPE')
  })

  test('revoked token → 401', async () => {
    const res = await auth('/api/multitable/records', tokRevoked).query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(401)
  })

  test('no token → 401 (auth required)', async () => {
    const res = await request(app).get('/api/multitable/records').query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(401)
  })

  test('NEVER EXCEEDS CREATOR — a row the creator is rule-denied is not returned through the token', async () => {
    await setFlag(true)
    await setRules([{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }])
    const res = await auth('/api/multitable/records', tokReadOk).query({ sheetId: SHEET_ID, limit: 100 })
    expect(res.status).toBe(200)
    const ids = (res.body?.data?.records ?? []).map((r: { id: string }) => r.id)
    expect(ids).toContain(REC_OPEN)
    expect(ids).not.toContain(REC_SECRET) // creator (non-admin) is denied this row → token is too
  })

  test('READ-ONLY SCOPE — a records:read token on a write route (POST /patch) is rejected with 403 (OAPI-2a)', async () => {
    // OAPI-2a mounts apiTokenAuth + requireScope('records:write') on POST /patch, so a records:read token now
    // reaches requireScope and is rejected for INSUFFICIENT_SCOPE (403) — previously 401 (no auth mounted).
    // The intent is unchanged: a read-scoped token still cannot mutate.
    const res = await request(app).post('/api/multitable/patch')
      .set('Authorization', `Bearer ${tokReadOk}`)
      .send({ sheetId: SHEET_ID, changes: [{ recordId: REC_OPEN, fieldId: STATUS, value: 'hacked' }] })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toContain('INSUFFICIENT_SCOPE')
    const check = await q('SELECT data FROM meta_records WHERE id = $1', [REC_OPEN])
    expect((check.rows[0] as { data?: Record<string, unknown> })?.data?.[STATUS]).toBe('open') // unchanged
  })

  // ---- OAPI-1 continuation: records:read on /view, /view-aggregate, /records-summary; fields:read on /fields ----

  // Guard-proof per route: wrong-scope → 403 and revoked → 401 prove BOTH apiTokenAuth + requireScope are
  // mounted (a happy-200 alone passes even if apiTokenAuth were missing). A valid token must NOT 401/403.
  test('records:read guards mounted on /view + /view-aggregate + /records-summary (403 wrong-scope, 401 revoked)', async () => {
    for (const p of [
      '/api/multitable/view',
      `/api/multitable/sheets/${SHEET_ID}/view-aggregate`,
      '/api/multitable/records-summary',
    ]) {
      expect((await auth(p, tokNoScope).query({ sheetId: SHEET_ID })).status).toBe(403) // requireScope mounted
      expect((await auth(p, tokRevoked).query({ sheetId: SHEET_ID })).status).toBe(401) // apiTokenAuth mounted
      expect([401, 403]).not.toContain((await auth(p, tokReadOk).query({ sheetId: SHEET_ID })).status) // valid passes guards
    }
  })

  test('fields:read guard mounted on /fields (200 with fields:read; 403 with records:read-only; 401 revoked)', async () => {
    expect((await auth('/api/multitable/fields', tokFields).query({ sheetId: SHEET_ID })).status).toBe(200)
    expect((await auth('/api/multitable/fields', tokReadOk).query({ sheetId: SHEET_ID })).status).toBe(403) // records:read ≠ fields:read
    expect((await auth('/api/multitable/fields', tokRevoked).query({ sheetId: SHEET_ID })).status).toBe(401)
  })

  // The spine on the AGGREGATE surfaces: a row the creator is read-denied must not be counted/summarized
  // (aggregation is the classic place row-deny gets dropped — count-before-filter).
  test('NEVER EXCEEDS CREATOR (aggregates) — denied row excluded from /records-summary records + /view-aggregate total', async () => {
    await setFlag(true)
    await setRules([{ id: 'r1', fieldId: STATUS, operator: 'eq', value: 'secret', effect: 'deny_read' }])

    const summary = await auth('/api/multitable/records-summary', tokReadOk).query({ sheetId: SHEET_ID, limit: 100 })
    expect(summary.status).toBe(200)
    const sIds = (summary.body?.data?.records ?? []).map((r: { id: string }) => r.id)
    expect(sIds).toContain(REC_OPEN)
    expect(sIds).not.toContain(REC_SECRET) // denied → not in the summary slice

    const agg = await auth(`/api/multitable/sheets/${SHEET_ID}/view-aggregate`, tokReadOk).query({ sheetId: SHEET_ID })
    expect(agg.status).toBe(200)
    expect(agg.body?.data?.total).toBe(1) // denied REC_SECRET excluded from the aggregate row set (no count leak)
  })
})
