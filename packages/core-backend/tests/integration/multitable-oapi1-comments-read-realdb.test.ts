/**
 * OAPI-1 comments:read — read-only API-token routes (real DB, full server).
 * Design-lock: docs/development/multitable-openapi-token-auth-designlock-20260619.md (§4 OAPI-1 continuation).
 *
 * The narrow comments:read set (GET /api/comments, /api/comments/summary,
 * /api/multitable/:spreadsheetId/comments/presence) composes the OAPI guard with the EXISTING rbacGuard:
 *   apiTokenAuth → requireScope('comments:read') → rbacGuard('comments','read') = min(token scope, creator RBAC).
 * Runs through the FULL MetaSheetServer (global JWT gate + allowlist) so the gate bypass-protection is
 * proven end-to-end, not just at the matcher. Proves:
 *   - comments:read token whose creator HAS comments RBAC → 200;
 *   - records:read token (wrong scope) → 403 (requireScope);
 *   - comments:read token whose creator LACKS comments RBAC → 403 (rbacGuard still applies — the min spine);
 *   - revoked token → 401; no token → 401;
 *   - presence forces includeViewers=false on the token path (no viewer-identity egress);
 *   - a comments:read token on a DEFERRED comment route (/api/comments/inbox) → 401 (allowlist denies → JWT
 *     gate; no over-match bypass).
 */
import net from 'net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { ApiTokenService } from '../../src/multitable/api-token-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const CREATOR_C = `oapi_cmt_creator_${TS}` // has comments:read RBAC
const CREATOR_M = `oapi_cmt_nombac_${TS}`  // has multitable:read, NOT comments RBAC
const SHEET = `oapi_cmt_sheet_${TS}`

const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

async function canListen(): Promise<boolean> {
  return await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, '127.0.0.1', () => s.close(() => r(true))) })
}
const get = (base: string, path: string, token: string) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })

describeIfDatabase('OAPI-1 comments:read API-token routes (real DB, full server)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let tokCommentsC = '' // comments:read, creator HAS comments RBAC
  let tokRecordsC = ''  // records:read (wrong scope), creator C
  let tokRevokedC = ''  // comments:read, creator C, revoked
  let tokCommentsM = '' // comments:read, creator M (LACKS comments RBAC)

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    // creator WITH comments RBAC (legacy users.permissions path in userHasPermission)
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
             VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
             ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [CREATOR_C, `${CREATOR_C}@t.local`, 'CmtRBAC', JSON.stringify(['comments:read'])])
    // creator WITHOUT comments RBAC
    await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
             VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, FALSE)
             ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [CREATOR_M, `${CREATOR_M}@t.local`, 'NoCmtRBAC', JSON.stringify(['multitable:read'])])

    const svc = new ApiTokenService(db)
    tokCommentsC = (await svc.createToken(CREATOR_C, { name: 'c-read', scopes: ['comments:read'] })).plainTextToken
    tokRecordsC = (await svc.createToken(CREATOR_C, { name: 'r-read', scopes: ['records:read'] })).plainTextToken
    tokCommentsM = (await svc.createToken(CREATOR_M, { name: 'm-read', scopes: ['comments:read'] })).plainTextToken
    const revoked = await svc.createToken(CREATOR_C, { name: 'revoked', scopes: ['comments:read'] })
    tokRevokedC = revoked.plainTextToken
    await svc.revokeToken(revoked.token.id, CREATOR_C)

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', 'in', [CREATOR_C, CREATOR_M]).execute().catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1)', [[CREATOR_C, CREATOR_M]]).catch(() => {})
    if (server) await server.stop()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('comments:read token whose creator HAS comments RBAC → 200 on /api/comments', async () => {
    expect((await get(base, `/api/comments?spreadsheetId=${SHEET}`, tokCommentsC)).status).toBe(200)
  })

  test('wrong scope (records:read) → 403 INSUFFICIENT_SCOPE', async () => {
    const res = await get(base, '/api/comments', tokRecordsC)
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain('INSUFFICIENT_SCOPE')
  })

  test('creator RBAC STILL APPLIES — comments:read token whose creator LACKS comments RBAC → 403 (rbacGuard)', async () => {
    // the min spine: token scope alone is NOT enough; the creator must also hold the RBAC permission.
    expect((await get(base, '/api/comments', tokCommentsM)).status).toBe(403)
  })

  test('revoked token → 401; no token → 401', async () => {
    expect((await get(base, '/api/comments', tokRevokedC)).status).toBe(401)
    expect((await fetch(`${base}/api/comments`)).status).toBe(401)
  })

  test('/api/comments/summary: 200 with comments:read+RBAC, 403 wrong-scope', async () => {
    expect((await get(base, `/api/comments/summary?spreadsheetId=${SHEET}`, tokCommentsC)).status).toBe(200)
    expect((await get(base, '/api/comments/summary', tokRecordsC)).status).toBe(403)
  })

  test('presence: guarded (200 / 403 / 401) and includeViewers forced false on the token path', async () => {
    const p = `/api/multitable/${SHEET}/comments/presence`
    expect((await get(base, p, tokCommentsC)).status).toBe(200)
    expect((await get(base, p, tokRecordsC)).status).toBe(403)
    expect((await get(base, p, tokRevokedC)).status).toBe(401)
    // includeViewers=true is forced to false on a token request → still 200, never errors / never leaks viewers
    const withViewers = await get(base, `${p}?includeViewers=true`, tokCommentsC)
    expect(withViewers.status).toBe(200)
    expect(JSON.stringify((await withViewers.json())?.data ?? {})).not.toMatch(/"viewers":\s*\[[^\]]/) // no populated viewers array
  })

  test('NO OVER-MATCH BYPASS — a comments:read token on a DEFERRED route (/api/comments/inbox) → 401 (allowlist denies → JWT gate)', async () => {
    // inbox is NOT allowlisted; the global gate routes the mst_ bearer to jwtAuth → 401 (token never reaches a handler).
    expect((await get(base, '/api/comments/inbox', tokCommentsC)).status).toBe(401)
  })
})
