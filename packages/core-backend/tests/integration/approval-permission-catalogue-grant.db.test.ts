import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

/**
 * `approvals:read` — real-DB acceptance for `zzzz20260920130000_add_approval_product_permissions`,
 * the migration that registers this one code in the `permissions` catalogue (see
 * `verify-approvals-read-catalogue-gap-20260920.md` for the CONFIRMED finding this closes).
 *
 * `approvals:write` and `approvals:act` are DELIBERATELY out of scope for this migration and this
 * suite — see the migration's own file header. Test 1 below asserts they remain unregistered; that
 * assertion is EXPECTED to need updating by whatever future PR registers them, since it is the
 * scope boundary of *this* PR, not a permanent invariant of the catalogue.
 *
 * This suite deliberately goes through the PRODUCT paths, not a trusted-claims dev-token and not a
 * direct `user_permissions` INSERT:
 *   1. `POST /api/auth/register` creates both principals (real path; register() also returns a
 *      usable token — no separate login call needed).
 *   2. The actor is elevated to admin via a direct `user_roles` INSERT, exactly as the real-browser
 *      acceptance run recorded it (`todo-center-real-browser-acceptance-20260920.md` §0.2 note 1):
 *      there is no product path to self-elevate to admin, so this one seed step is out-of-band by
 *      necessity, not a shortcut around the thing under test.
 *   3. `POST /api/permissions/grant` (routes/permissions.ts:133) is the actual product grant
 *      endpoint — the one that 400s on an unregistered code (routes/permissions.ts:156-164). Before
 *      this migration, granting `approvals:read` here would fail with exactly that 400; this suite
 *      proves it now succeeds and the target's PRE-EXISTING token (not a freshly minted one) is
 *      immediately treated as authorized on its very next request, because `AuthService.verifyToken`
 *      re-resolves permissions from `user_permissions`/`role_permissions` on every call
 *      (`resolveRbacProfile` → `listUserPermissions`) rather than baking them into the JWT.
 *   4. `GET /api/approvals/pending-count` (routes/approvals.ts:1990) is the discriminating endpoint:
 *      gated by the exact `rbacGuard('approvals', 'read')` this migration's code feeds, and it
 *      already exists on `origin/main` today (routes/todo.ts does not — the todo center is an
 *      unmerged draft PR — so this is the closest main-side analogue named in the review, and the
 *      SAME predicate the todo center will inherit once it lands).
 *
 * The discriminating pair is the SAME target user, SAME token, SAME endpoint, before vs. after the
 * grant: 403 → grant → 200. That isolates the catalogue-registration fix from every other variable.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

const TS = Date.now()

interface RegisterResult {
  userId: string
  token: string
}

async function registerUser(baseUrl: string, email: string, name: string): Promise<RegisterResult> {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Perm-Cat-Test-P@ss1', name }),
  })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { data: { user: { id: string }; token: string } }
  return { userId: body.data.user.id, token: body.data.token }
}

describeIfDatabase('approvals:read catalogue registration — grant-and-gate real-DB acceptance', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdUserIds: string[] = []

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM user_roles WHERE user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  it('migration registered ONLY approvals:read in the permissions catalogue — approvals:write/act are out of scope for this PR (this assertion is expected to need updating by whatever future PR registers them)', async () => {
    const result = await pool().query<{ code: string }>(
      `SELECT code FROM permissions WHERE code = ANY($1::text[]) ORDER BY code`,
      [['approvals:read', 'approvals:write', 'approvals:act']],
    )
    expect(result.rows.map((row) => row.code)).toEqual(['approvals:read'])
  })

  it('this migration grants NOTHING by default — no role_permissions row exists for approvals:read', async () => {
    const result = await pool().query<{ permission_code: string }>(
      `SELECT permission_code FROM role_permissions WHERE permission_code = $1`,
      ['approvals:read'],
    )
    expect(result.rows).toEqual([])
  })

  it(
    'DISCRIMINATING: same non-admin user, same token, same endpoint — 403 before the product grant, 200 after it',
    async () => {
      const adminEmail = `permcat-admin-${TS}@example.com`
      const targetEmail = `permcat-target-${TS}@example.com`

      const admin = await registerUser(baseUrl, adminEmail, 'Permcat Admin')
      const target = await registerUser(baseUrl, targetEmail, 'Permcat Target')
      createdUserIds.push(admin.userId, target.userId)

      // No product path elevates a fresh registrant to admin (registration never assigns the
      // `admin` role_id) — this one direct seed is the same out-of-band step the real-browser
      // acceptance run took and documented for the identical reason.
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [admin.userId],
      )

      // BEFORE: target has never been granted approvals:read.
      const before = await fetch(`${baseUrl}/api/approvals/pending-count`, {
        headers: { Authorization: `Bearer ${target.token}` },
      })
      expect(before.status).toBe(403)

      // Grant, through the actual product endpoint routes/permissions.ts:133 — the same one that
      // 400s on an unregistered code at :156-164. Pre-migration this call would have 400ed.
      const grant = await fetch(`${baseUrl}/api/permissions/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ userId: target.userId, permission: 'approvals:read' }),
      })
      expect(grant.status).toBe(200)
      const grantBody = (await grant.json()) as { success: boolean; permission: string }
      expect(grantBody).toMatchObject({ success: true, permission: 'approvals:read' })

      // AFTER: SAME token, SAME endpoint — verifyToken re-resolves permissions from
      // user_permissions/role_permissions on every call, so no re-login is needed.
      const after = await fetch(`${baseUrl}/api/approvals/pending-count`, {
        headers: { Authorization: `Bearer ${target.token}` },
      })
      expect(after.status).toBe(200)
    },
  )

  it('granting an UNREGISTERED code still 400s (negative control — the fix is not a blanket bypass; uses a synthetic code, not approvals:write/act, so this stays correct even after a future PR registers those)', async () => {
    const adminEmail = `permcat-admin2-${TS}@example.com`
    const targetEmail = `permcat-target2-${TS}@example.com`
    const admin = await registerUser(baseUrl, adminEmail, 'Permcat Admin Two')
    const target = await registerUser(baseUrl, targetEmail, 'Permcat Target Two')
    createdUserIds.push(admin.userId, target.userId)
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [admin.userId],
    )

    const grant = await fetch(`${baseUrl}/api/permissions/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ userId: target.userId, permission: `nonexistent:code-${TS}` }),
    })
    expect(grant.status).toBe(400)
  })
})
