import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: only runs when a Postgres DATABASE_URL is provided (the DB-backed CI
// step in plugin-tests.yml + local runs). The no-DB default `test (18.x)` job both
// excludes this file (vitest.config.ts) and would skip it here.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

/**
 * Lane A (P1-static-picker) backend landing blocker: the two read-only directory
 * endpoints used by the authoring assignee picker.
 *   GET /api/approval-templates/directory/users?q=&limit=
 *   GET /api/approval-templates/directory/roles
 *
 * Coverage: rejection (403 for a non-manager), functional success + minimal-exposure
 * shape + ?q filter + limit (via an authorized caller), and a source-level assertion
 * that the routes are gated by the least-privilege `approval-templates:manage` and NOT
 * `ensurePlatformAdmin`. (The positive caller is an admin token because a non-admin
 * "manager" additionally needs role-derived namespace admission — the platform's real
 * RBAC layer — which is out of scope here; the least-privilege wiring is pinned by the
 * source assertion + the 403 negative.)
 */

const PREFIX = `dirpick-${Date.now()}`
const ADMIN = `${PREFIX}-admin`
const NON = `${PREFIX}-non`
const ALICE = `${PREFIX}-alice`
const BOB = `${PREFIX}-bob`
const CAROL = `${PREFIX}-carol`
const ROLE = `${PREFIX}-role`

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

describeIfDatabase('approval directory endpoints (P1-static-picker backend, real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  let nonMgrToken = ''
  let roleSeeded = false

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
    await seedUser(ALICE, 'ZmarkerQ Alice')
    await seedUser(BOB, 'ZmarkerQ Bob')
    await seedUser(CAROL, 'Zzz Other Person')
    try {
      await pool.query(`INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [ROLE, 'Dirpick Role'])
      roleSeeded = true
    } catch {
      roleSeeded = false
    }

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`

    adminToken = await devToken(baseUrl, ADMIN, 'admin', '*:*')
    // roles=member keeps this NON-admin; empty perms → lacks approval-templates:manage.
    nonMgrToken = await devToken(baseUrl, NON, 'member', '')
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN, NON, ALICE, BOB, CAROL]])
      if (roleSeeded) await pool.query(`DELETE FROM roles WHERE id = $1`, [ROLE])
    } catch {
      // ignore cleanup failures
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('rejects a non-manager on /directory/users (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/users', nonMgrToken)
    expect(res.status).toBe(403)
  })

  it('rejects a non-manager on /directory/roles (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/roles', nonMgrToken)
    expect(res.status).toBe(403)
  })

  it('returns the minimal {id,name,email} shape on /directory/users for an authorized caller', async () => {
    const res = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ`, adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<Record<string, unknown>> }
    expect(Array.isArray(body.users)).toBe(true)
    const alice = body.users.find((u) => u.id === ALICE)
    expect(alice).toBeTruthy()
    // least-privilege exposure: ONLY id/name/email — NOT mobile/department/role/is_admin/etc.
    expect(Object.keys(alice as Record<string, unknown>).sort()).toEqual(['email', 'id', 'name'])
    expect((alice as { email: string }).email).toBe(`${ALICE}@ex.test`)
  })

  it('filters by ?q name marker (matches alice/bob, excludes the other)', async () => {
    const res = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ`, adminToken)
    const body = (await res.json()) as { users: Array<{ id: string }> }
    const ids = body.users.map((u) => u.id)
    expect(ids).toContain(ALICE)
    expect(ids).toContain(BOB)
    expect(ids).not.toContain(CAROL)
  })

  it('applies limit (limit=1 over 2 matches → 1), clamps 0 without erroring, and caps at 50', async () => {
    const one = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ&limit=1`, adminToken)
    expect(one.status).toBe(200)
    expect(((await one.json()) as { users: unknown[] }).users.length).toBe(1)
    const zero = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ&limit=0`, adminToken)
    expect(zero.status).toBe(200)
    expect(((await zero.json()) as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(1)
    const over = await get(baseUrl, `/api/approval-templates/directory/users?limit=999`, adminToken)
    expect(((await over.json()) as { users: unknown[] }).users.length).toBeLessThanOrEqual(50)
  })

  it('returns the minimal {id,name} shape on /directory/roles', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/roles', adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roles: Array<Record<string, unknown>> }
    expect(Array.isArray(body.roles)).toBe(true)
    if (roleSeeded) {
      const seeded = body.roles.find((r) => r.id === ROLE)
      expect(seeded).toBeTruthy()
      expect(Object.keys(seeded as Record<string, unknown>).sort()).toEqual(['id', 'name'])
    } else if (body.roles.length > 0) {
      expect(Object.keys(body.roles[0]).sort()).toEqual(['id', 'name'])
    }
  })

  it('routes are gated by least-privilege approval-templates:manage, NOT ensurePlatformAdmin', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/routes/approvals.ts'), 'utf8')
    const lines = src.split('\n')
    const usersLine = lines.find((l) => l.includes("'/api/approval-templates/directory/users'"))
    const rolesLine = lines.find((l) => l.includes("'/api/approval-templates/directory/roles'"))
    expect(usersLine).toBeTruthy()
    expect(rolesLine).toBeTruthy()
    expect(usersLine).toContain("rbacGuard('approval-templates:manage')")
    expect(rolesLine).toContain("rbacGuard('approval-templates:manage')")
    expect(usersLine).not.toContain('ensurePlatformAdmin')
    expect(rolesLine).not.toContain('ensurePlatformAdmin')
  })
})
