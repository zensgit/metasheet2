/**
 * OAPI-2a — comments:write token comment-create (real DB, full server).
 *
 * The comment path is a SEPARATE write surface from records (its own router + CommentService + Kysely
 * transaction), so it needs its own golden. Proves, through the full MetaSheetServer (the global gate +
 * the route's apiTokenAuth → rate-limit → requireScope → rbacGuard chain):
 *   - comments:write token → POST /api/comments → 2xx + a COMMITTED audit row (operation=create,
 *     scope=comments:write, actor=creator) — the Kysely in-txn audit path;
 *   - wrong scope (records:read) → 403 INSUFFICIENT_SCOPE + a DENIED audit row + NO comment;
 *   - revoked → 401, no comment.
 * Runs only with DATABASE_URL.
 */
import net from 'net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { ApiTokenService } from '../../src/multitable/api-token-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const CREATOR = `user_oapi2cw_${TS}`
const SHEET = `sheet_oapi2cw_${TS}`
const ROW = `rec_oapi2cw_${TS}`
const q = (sql: string, params: unknown[]) => poolManager.get().query(sql, params)

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}

describeIfDatabase('OAPI-2a comments:write token comment-create (real DB, full server)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let tokWrite = ''
  let tokWriteId = ''
  let tokWrongScope = ''
  let tokWrongScopeId = ''
  let tokRevoked = ''

  const postComment = (token: string, body: unknown) =>
    fetch(`${base}/api/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const commentCount = async (): Promise<number> =>
    Number(((await q('SELECT COUNT(*)::int AS n FROM meta_comments WHERE spreadsheet_id = $1', [SHEET])).rows[0] as { n: number }).n)
  const auditRows = async (
    tokenId: string,
  ): Promise<Array<{ operation: string; outcome: string; status_code: number | null; scope: string; actor_id: string }>> =>
    (await q('SELECT operation, outcome, status_code, scope, actor_id FROM oapi_write_audit WHERE token_id = $1', [tokenId]))
      .rows as Array<{ operation: string; outcome: string; status_code: number | null; scope: string; actor_id: string }>

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    // Admin creator so rbacGuard('comments','write') passes for the success path; the comments-RBAC min-spine
    // is already covered by the OAPI-1 comments golden. (rbacGuard runs AFTER requireScope for the 403 case.)
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1,$2,$3,'x','member',$4::jsonb, TRUE, TRUE)
       ON CONFLICT (id) DO UPDATE SET is_admin = TRUE`,
      [CREATOR, `${CREATOR}@t.local`, 'CmtWriter', JSON.stringify(['comments:write'])],
    )

    const svc = new ApiTokenService(db)
    const w = await svc.createToken(CREATOR, { name: 'cw', scopes: ['comments:write'] })
    tokWrite = w.plainTextToken
    tokWriteId = w.token.id
    const ws = await svc.createToken(CREATOR, { name: 'rr', scopes: ['records:read'] })
    tokWrongScope = ws.plainTextToken
    tokWrongScopeId = ws.token.id
    const rv = await svc.createToken(CREATOR, { name: 'rv', scopes: ['comments:write'] })
    tokRevoked = rv.plainTextToken
    await svc.revokeToken(rv.token.id, CREATOR)

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
  })

  afterAll(async () => {
    await db.deleteFrom('multitable_api_tokens').where('created_by', '=', CREATOR).execute().catch(() => {})
    await q('DELETE FROM oapi_write_audit WHERE token_id = ANY($1::text[])', [[tokWriteId, tokWrongScopeId]]).catch(() => {})
    await q('DELETE FROM meta_comments WHERE spreadsheet_id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [CREATOR]).catch(() => {})
    if (server) await server.stop()
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('comments:write → POST /api/comments 2xx + committed audit (operation=create, scope=comments:write)', async () => {
    const before = await commentCount()
    const res = await postComment(tokWrite, { spreadsheetId: SHEET, rowId: ROW, content: 'hello from token' })
    expect([200, 201]).toContain(res.status)
    expect(await commentCount()).toBe(before + 1)
    const committed = (await auditRows(tokWriteId)).filter(
      (r) => r.outcome === 'committed' && r.operation === 'create' && r.scope === 'comments:write',
    )
    expect(committed.length).toBeGreaterThanOrEqual(1)
    expect(committed[0].actor_id).toBe(CREATOR) // acts-as-creator
  })

  test('wrong scope (records:read) → 403 INSUFFICIENT_SCOPE + denied audit + no comment', async () => {
    const before = await commentCount()
    const res = await postComment(tokWrongScope, { spreadsheetId: SHEET, rowId: ROW, content: 'should not exist' })
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain('INSUFFICIENT_SCOPE')
    expect(await commentCount()).toBe(before)
    await new Promise((r) => setTimeout(r, 100)) // boundary finish-listener flush
    expect((await auditRows(tokWrongScopeId)).some((r) => r.outcome === 'denied' && r.status_code === 403)).toBe(true)
  })

  test('revoked token → 401, no comment', async () => {
    const before = await commentCount()
    expect((await postComment(tokRevoked, { spreadsheetId: SHEET, rowId: ROW, content: 'x' })).status).toBe(401)
    expect(await commentCount()).toBe(before)
  })
})
