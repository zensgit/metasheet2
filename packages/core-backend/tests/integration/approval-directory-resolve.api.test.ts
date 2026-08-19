import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * member-display-identity (2026-08-19) — the authorized-scope EXACT batch id->name resolver:
 *   GET /api/approvals/directory/resolve?userIds=&roleIds=
 *
 * Sibling of `approval-participant-directory.api.test.ts` (the `/directory/users` SEARCH route
 * this resolver reuses the guard from) — mirrors its structure so the two routes' authz posture is
 * provably identical, not just documented as identical. Distinguishing behavior under test:
 *
 *   - EXACT match, not ILIKE substring: `user_1` never pulls in `user_10`.
 *   - VALUES-FREE ON MISS: an inactive user / a blank-name user / roles.
 *   - roles are id-exact only (no listing) — a genuine, narrow authz delta from before this route
 *     existed (no role resolver was reachable to a plain participant), disclosed rather than
 *     claimed as "no widening".
 *   - same three-permission union guard as `/directory/users`, registered before `/api/approvals/:id`.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const PREFIX = `dirresolve-${Date.now()}`
const READER = `${PREFIX}-reader`
const WRITER = `${PREFIX}-writer`
const ACTOR = `${PREFIX}-actor`
const NONE = `${PREFIX}-none`
const ALICE = `${PREFIX}-alice`
const BOB = `${PREFIX}-bob`
const INACTIVE = `${PREFIX}-inactive`
const NAMELESS = `${PREFIX}-nameless`
const ROLE_A = `${PREFIX}-role-a`
const ROLE_B = `${PREFIX}-role-b`

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

describeIfDatabase('approval participant directory RESOLVE endpoint (member-display-identity, real DB)', () => {
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
    const seedUser = async (id: string, name: string, isActive = true) => {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $3, 'x', 'member', '[]'::jsonb, $4, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active, name = EXCLUDED.name`,
        [id, `${id}@ex.test`, name, isActive],
      )
    }
    await seedUser(ALICE, 'RmarkerX Alice')
    await seedUser(BOB, 'RmarkerX Bob')
    await seedUser(INACTIVE, 'RmarkerX Deactivated', false)
    await seedUser(NAMELESS, '')
    // A decoy sharing ALICE's id as a PREFIX, to prove exact match (not ILIKE %term%) — a search
    // for ALICE must never also return this one.
    await seedUser(`${ALICE}-decoy`, 'RmarkerX Alice Decoy')

    await pool.query(
      `INSERT INTO roles (id, name) VALUES ($1, $2), ($3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ROLE_A, 'RmarkerX Role A', ROLE_B, 'RmarkerX Role B'],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`

    readerToken = await devToken(baseUrl, READER, 'member', 'approvals:read')
    writerToken = await devToken(baseUrl, WRITER, 'member', 'approvals:write')
    actorToken = await devToken(baseUrl, ACTOR, 'member', 'approvals:act')
    noneToken = await devToken(baseUrl, NONE, 'member', '')
  })

  afterAll(async () => {
    try {
      await poolManager.get().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
        [READER, WRITER, ACTOR, NONE, ALICE, BOB, INACTIVE, NAMELESS, `${ALICE}-decoy`],
      ])
      await poolManager.get().query(`DELETE FROM roles WHERE id = ANY($1::text[])`, [[ROLE_A, ROLE_B]])
    } catch { /* ignore */ }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('each of approvals:read / :write / :act ALONE reaches the endpoint (200) — the union guard', async () => {
    for (const token of [readerToken, writerToken, actorToken]) {
      const res = await get(baseUrl, `/api/approvals/directory/resolve?userIds=${ALICE}`, token)
      expect(res.status).toBe(200)
    }
  })

  it('a user holding NONE of the three approval permissions is rejected (403) — same guard as /directory/users', async () => {
    const res = await get(baseUrl, `/api/approvals/directory/resolve?userIds=${ALICE}`, noneToken)
    expect(res.status).toBe(403)
  })

  it('resolves exact ids to {id,name} — never the raw id join, and never an ILIKE-substring extra match', async () => {
    const res = await get(baseUrl, `/api/approvals/directory/resolve?userIds=${ALICE},${BOB}`, readerToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ id: string; name: string; email: string }>; roles: unknown[] }
    const ids = body.users.map((u) => u.id)
    expect(ids).toContain(ALICE)
    expect(ids).toContain(BOB)
    expect(ids).not.toContain(`${ALICE}-decoy`)
    expect(ids.length).toBe(2)
    const alice = body.users.find((u) => u.id === ALICE)
    expect(alice?.name).toBe('RmarkerX Alice')
  })

  it('values-free on miss: a deactivated user, a nameless user, and a nonexistent id are all OMITTED (never returned with a blank/stale name, never an error)', async () => {
    const bogus = `${PREFIX}-does-not-exist`
    const res = await get(
      baseUrl,
      `/api/approvals/directory/resolve?userIds=${ALICE},${INACTIVE},${NAMELESS},${bogus}`,
      writerToken,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ id: string }> }
    const ids = body.users.map((u) => u.id)
    expect(ids).toEqual([ALICE])
    expect(ids).not.toContain(INACTIVE)
    expect(ids).not.toContain(NAMELESS)
    expect(ids).not.toContain(bogus)
  })

  it('resolves roles by exact id — a genuinely NEW authz surface for a plain participant (no role resolver existed before this route)', async () => {
    const res = await get(baseUrl, `/api/approvals/directory/resolve?roleIds=${ROLE_A},${ROLE_B}`, actorToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: unknown[]; roles: Array<{ id: string; name: string }> }
    const ids = body.roles.map((r) => r.id)
    expect(ids).toContain(ROLE_A)
    expect(ids).toContain(ROLE_B)
    const a = body.roles.find((r) => r.id === ROLE_A)
    expect(Object.keys(a as Record<string, unknown>).sort()).toEqual(['id', 'name'])
  })

  it('a nonexistent role id is omitted (values-free on miss, roles too)', async () => {
    const bogus = `${PREFIX}-role-does-not-exist`
    const res = await get(baseUrl, `/api/approvals/directory/resolve?roleIds=${ROLE_A},${bogus}`, actorToken)
    const body = (await res.json()) as { roles: Array<{ id: string }> }
    expect(body.roles.map((r) => r.id)).toEqual([ROLE_A])
  })

  it('users AND roles resolve together in one call, each shape minimal ({id,name,email} / {id,name})', async () => {
    const res = await get(baseUrl, `/api/approvals/directory/resolve?userIds=${ALICE}&roleIds=${ROLE_A}`, readerToken)
    const body = (await res.json()) as { users: Array<Record<string, unknown>>; roles: Array<Record<string, unknown>> }
    expect(Object.keys(body.users[0]).sort()).toEqual(['email', 'id', 'name'])
    expect(Object.keys(body.roles[0]).sort()).toEqual(['id', 'name'])
  })

  it('no ids at all -> {users:[],roles:[]}, no query executed, no error', async () => {
    const res = await get(baseUrl, '/api/approvals/directory/resolve', readerToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: unknown[]; roles: unknown[] }
    expect(body).toEqual({ users: [], roles: [] })
  })

  it('CANDIDATE resolver, NOT an authorization fact: resolving a name says nothing about being an assignee/approver of anything', async () => {
    // Mirrors the sibling search route's own "candidate, not authorization" proof — BOB is not an
    // assignee of anything, yet resolves fine. The real transfer/create/delegate/add_sign stays
    // gated downstream by dispatchAction/createApproval, independent of this lookup.
    const res = await get(baseUrl, `/api/approvals/directory/resolve?userIds=${BOB}`, actorToken)
    const body = (await res.json()) as { users: Array<{ id: string }> }
    expect(body.users.map((u) => u.id)).toEqual([BOB])
  })

  it('source-level: the route uses the least-privilege UNION guard, registered before /api/approvals/:id', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/routes/approvals.ts'), 'utf8')
    const lines = src.split('\n')
    const routeLine = lines.find((l) => l.includes("'/api/approvals/directory/resolve'"))
    expect(routeLine).toBeTruthy()
    expect(routeLine).toContain('approvalParticipantDirectoryGuard')
    const dirIdx = lines.findIndex((l) => l.includes("r.get('/api/approvals/directory/resolve'"))
    const idIdx = lines.findIndex((l) => l.includes("r.get('/api/approvals/:id'"))
    expect(dirIdx).toBeGreaterThan(-1)
    expect(idIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeLessThan(idIdx)
  })
})
