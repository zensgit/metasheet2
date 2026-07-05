import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * B3-04 (design-lock 2026-07-05): the participant candidate-user directory endpoint
 *   GET /api/approvals/directory/users?q=&limit=
 *
 * Distinct from the author picker (`/api/approval-templates/directory/users`, template-admin
 * guarded): this one serves ordinary approval ACTIONS (transfer/add-sign), the fill-form user
 * field, and delegation self-service, so it is gated by the least-privilege UNION
 * `rbacGuardAny(['approvals:read','approvals:write','approvals:act'])`. The owner permission
 * correction is the whole point of this test: EACH of the three perms alone must reach it, and
 * none-of-them must 403.
 *
 * It is a CANDIDATE directory, not an authorization fact — a user who is an assignee of nothing
 * still appears (proven below); the real transfer/create/delegate stays gated downstream by
 * dispatchAction/createApproval/delegation-create (their assignee/target checks are independently
 * covered by the approval lifecycle specs).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const PREFIX = `partdir-${Date.now()}`
const READER = `${PREFIX}-reader`
const WRITER = `${PREFIX}-writer`
const ACTOR = `${PREFIX}-actor`
const NONE = `${PREFIX}-none`
const ALICE = `${PREFIX}-alice`
const BOB = `${PREFIX}-bob`
const CAROL = `${PREFIX}-carol`

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function devToken(baseUrl: string, userId: string, roles: string, perms: string): Promise<string> {
  const res = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

function get(baseUrl: string, p: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } })
}

describeIfDatabase('approval participant directory endpoint (B3-04, real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let readerToken = ''
  let writerToken = ''
  let actorToken = ''
  let noneToken = ''

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    const seedUser = async (id: string, name: string) => {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $3, 'x', 'member', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, name = EXCLUDED.name`,
        [id, `${id}@ex.test`, name],
      )
    }
    await seedUser(ALICE, 'PmarkerX Alice')
    await seedUser(BOB, 'PmarkerX Bob')
    await seedUser(CAROL, 'Zzz Unrelated Person')

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`

    // Each token holds EXACTLY ONE of the union permissions — proving the OR guard.
    readerToken = await devToken(baseUrl, READER, 'member', 'approvals:read')
    writerToken = await devToken(baseUrl, WRITER, 'member', 'approvals:write')
    actorToken = await devToken(baseUrl, ACTOR, 'member', 'approvals:act')
    noneToken = await devToken(baseUrl, NONE, 'member', '')
  })

  afterAll(async () => {
    try {
      await poolManager.get().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[READER, WRITER, ACTOR, NONE, ALICE, BOB, CAROL]])
    } catch { /* ignore */ }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('each of approvals:read / :write / :act ALONE reaches the endpoint (200) — the union guard', async () => {
    for (const token of [readerToken, writerToken, actorToken]) {
      const res = await get(baseUrl, '/api/approvals/directory/users?q=PmarkerX', token)
      expect(res.status).toBe(200)
    }
  })

  it('a user holding NONE of the three approval permissions is rejected (403)', async () => {
    const res = await get(baseUrl, '/api/approvals/directory/users?q=PmarkerX', noneToken)
    expect(res.status).toBe(403)
  })

  it('returns the minimal {id,name,email} shape only', async () => {
    const res = await get(baseUrl, '/api/approvals/directory/users?q=PmarkerX', writerToken)
    const body = (await res.json()) as { users: Array<Record<string, unknown>> }
    const alice = body.users.find((u) => u.id === ALICE)
    expect(alice).toBeTruthy()
    expect(Object.keys(alice as Record<string, unknown>).sort()).toEqual(['email', 'id', 'name'])
  })

  it('filters by ?q and clamps limit (limit=1 → 1; limit=999 ≤ 50)', async () => {
    const filtered = await get(baseUrl, '/api/approvals/directory/users?q=PmarkerX', actorToken)
    const ids = ((await filtered.json()) as { users: Array<{ id: string }> }).users.map((u) => u.id)
    expect(ids).toContain(ALICE)
    expect(ids).toContain(BOB)
    expect(ids).not.toContain(CAROL)
    const one = await get(baseUrl, '/api/approvals/directory/users?q=PmarkerX&limit=1', actorToken)
    expect(((await one.json()) as { users: unknown[] }).users.length).toBe(1)
    const over = await get(baseUrl, '/api/approvals/directory/users?limit=999', actorToken)
    expect(((await over.json()) as { users: unknown[] }).users.length).toBeLessThanOrEqual(50)
  })

  it('CANDIDATE directory, NOT authorization: a user who is an assignee of nothing still appears', async () => {
    // Carol is an assignee/approver of no instance; she is nonetheless a pickable candidate. This is
    // the endpoint-level proof that "in the directory" != "may be transferred/delegated to" — the
    // real gate is dispatchAction/createApproval/delegation-create downstream.
    const res = await get(baseUrl, '/api/approvals/directory/users?q=Unrelated', readerToken)
    const ids = ((await res.json()) as { users: Array<{ id: string }> }).users.map((u) => u.id)
    expect(ids).toContain(CAROL)
  })

  it('source-level: the route uses the least-privilege UNION guard, registered before /api/approvals/:id', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/routes/approvals.ts'), 'utf8')
    const lines = src.split('\n')
    const routeLine = lines.find((l) => l.includes("'/api/approvals/directory/users'"))
    expect(routeLine).toBeTruthy()
    expect(routeLine).toContain('approvalParticipantDirectoryGuard')
    expect(src).toContain("rbacGuardAny(['approvals:read', 'approvals:write', 'approvals:act'])")
    // registered before the ':id' catch-all so 'directory' is not matched as an id
    const dirIdx = lines.findIndex((l) => l.includes("r.get('/api/approvals/directory/users'"))
    const idIdx = lines.findIndex((l) => l.includes("r.get('/api/approvals/:id'"))
    expect(dirIdx).toBeGreaterThan(-1)
    expect(idIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeLessThan(idIdx)
  })
})
