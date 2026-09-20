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
 *
 * RUNNING THIS FILE OUTSIDE ITS CI LANE: this file calls `POST /api/auth/register` a dozen times.
 * The lane (`.github/workflows/approval-realdb-permission-catalogue.yml`) sets
 * `AUTH_REGISTER_MAX_PER_IP=50` in its job `env:` for exactly that reason. The route's own default
 * (`routes/auth.ts`'s `maxRegisterPerIp`) is 3 per IP per window — running this file locally without
 * that override 429s starting at the 4th registration, and the failure surfaces as an unrelated
 * `expect(response.status).toBe(201)` mismatch with no hint that rate limiting is the real cause. Set
 * `AUTH_REGISTER_MAX_PER_IP` to something well above the registration count in this file before
 * running it directly.
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

/** The actual product grant endpoint, routes/permissions.ts:133 — same call the existing
 *  DISCRIMINATING test below uses inline; factored out so the additional acceptance cases further
 *  down (participant fence / revoke / write-shaped surface) share one call site. */
async function grantPermission(baseUrl: string, adminToken: string, userId: string, permission: string): Promise<Response> {
  return fetch(`${baseUrl}/api/permissions/grant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ userId, permission }),
  })
}

/** The actual product revoke endpoint, routes/permissions.ts:214 — admin-only, DELETEs the
 *  `user_permissions` row through the product path (not a direct DB DELETE). */
async function revokePermission(baseUrl: string, adminToken: string, userId: string, permission: string): Promise<Response> {
  return fetch(`${baseUrl}/api/permissions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ userId, permission }),
  })
}

describeIfDatabase('approvals:read catalogue registration — grant-and-gate real-DB acceptance', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdUserIds: string[] = []
  const createdInstanceIds: string[] = []

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
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM approval_delegations WHERE delegator_user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM approval_reads WHERE user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM user_roles WHERE user_id = ANY($1::text[])`, [createdUserIds])
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  /** Seeds a minimal platform approval instance directly (no template/workflow scaffolding needed
   *  for a permission-catalogue authz probe) with the given user as its REQUESTER — arm 1 of
   *  `canReadApprovalInstance` (services/approval-instance-readability.ts): `requester_snapshot->>
   *  'id' = viewerId`, unconditional. Mirrors approval-history-authz-guard.db.test.ts's own
   *  `seedInstanceWithComment`, minus the marker/comment row this suite's status-only assertions
   *  don't need. */
  async function seedRequesterInstance(requesterId: string): Promise<string> {
    const id = `permcat-instance-${TS}-${Math.random().toString(36).slice(2, 8)}`
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'pending', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    createdInstanceIds.push(id)
    return id
  }

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

  it(
    'UNRELATED-INSTANCE FENCE: a user holding approvals:read via the product grant is NOT thereby admitted to an instance they are not a participant of — GET /:id and /:id/history both deny (canReadApprovalInstance runs AFTER rbacGuard as a SEPARATE per-instance leg; approvals:read only satisfies the leg-1 resource-shape guard). This is a P1 finding-in-waiting if it ever comes back 200: the test records the ACTUAL status observed rather than assuming 403/404, and fails loudly (with the unexpected status printed) if the participant fence turns out not to hold. POSITIVE CONTROL, same instanceId: the instance\'s own requester (also granted approvals:read) asserts 200 on the identical two endpoints, so a 404 above can only mean "not a participant", never "the instance was never actually created" (gate r3 P2-1).',
    async () => {
      const adminEmail = `permcat-admin3-${TS}@example.com`
      const readerEmail = `permcat-reader3-${TS}@example.com`
      const strangerRequesterEmail = `permcat-stranger3-${TS}@example.com`

      const admin = await registerUser(baseUrl, adminEmail, 'Permcat Admin Three')
      const reader = await registerUser(baseUrl, readerEmail, 'Permcat Reader Three')
      const strangerRequester = await registerUser(baseUrl, strangerRequesterEmail, 'Permcat Stranger Three')
      createdUserIds.push(admin.userId, reader.userId, strangerRequester.userId)
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [admin.userId],
      )

      // reader is granted approvals:read through the actual product endpoint — not a dev-token,
      // not a direct user_permissions INSERT.
      const grant = await grantPermission(baseUrl, admin.token, reader.userId, 'approvals:read')
      expect(grant.status).toBe(200)

      // strangerRequester is ALSO granted approvals:read — the positive control below needs them to
      // clear the SAME leg-1 rbacGuard('approvals','read') reader just cleared, so that a 200 on
      // their own instance is attributable to canReadApprovalInstance's arm 1 (participant), not to
      // some other bypass.
      const requesterGrant = await grantPermission(baseUrl, admin.token, strangerRequester.userId, 'approvals:read')
      expect(requesterGrant.status).toBe(200)

      // An instance reader is NOT a participant of: requester is strangerRequester, not reader; no
      // assignment/cc/past-actor row names reader at all.
      const instanceId = await seedRequesterInstance(strangerRequester.userId)

      const detailResponse = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}`, {
        headers: { Authorization: `Bearer ${reader.token}` },
      })
      const historyResponse = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}/history`, {
        headers: { Authorization: `Bearer ${reader.token}` },
      })

      // POSITIVE CONTROL — SAME instanceId, the instance's own requester, own token: arm 1 of
      // canReadApprovalInstance (`requester_snapshot->>'id' = viewerId`) admits them unconditionally,
      // so this must be 200/200. Without this pair, the 404/404 above would read identically whether
      // the fence is holding OR seedRequesterInstance's INSERT silently failed/wrote a different id —
      // this closes that gap by proving the SAME id is hydratable by SOMEONE.
      const requesterDetailResponse = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}`, {
        headers: { Authorization: `Bearer ${strangerRequester.token}` },
      })
      const requesterHistoryResponse = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}/history`, {
        headers: { Authorization: `Bearer ${strangerRequester.token}` },
      })

      // Record what actually happened rather than assuming — if either comes back 200 that is the
      // participant fence failing to hold for a grant issued via THIS migration's code, which is a
      // P1 worth flagging to owner, not silently accepting/hiding.
      expect([403, 404]).toContain(detailResponse.status)
      expect([403, 404]).toContain(historyResponse.status)
      expect(requesterDetailResponse.status).toBe(200)
      expect(requesterHistoryResponse.status).toBe(200)
    },
  )

  it(
    'REVOKE THEN DENY: same non-admin user, same token, same endpoint that just proved 403→grant→200 above — after the product revoke endpoint removes the grant, the identical request is denied again (403), proving the gate re-resolves permissions on every call rather than caching the earlier grant for the life of the token',
    async () => {
      const adminEmail = `permcat-admin4-${TS}@example.com`
      const targetEmail = `permcat-target4-${TS}@example.com`

      const admin = await registerUser(baseUrl, adminEmail, 'Permcat Admin Four')
      const target = await registerUser(baseUrl, targetEmail, 'Permcat Target Four')
      createdUserIds.push(admin.userId, target.userId)
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [admin.userId],
      )

      const grant = await grantPermission(baseUrl, admin.token, target.userId, 'approvals:read')
      expect(grant.status).toBe(200)

      const afterGrant = await fetch(`${baseUrl}/api/approvals/pending-count`, {
        headers: { Authorization: `Bearer ${target.token}` },
      })
      expect(afterGrant.status).toBe(200)

      const revoke = await revokePermission(baseUrl, admin.token, target.userId, 'approvals:read')
      expect(revoke.status).toBe(200)
      const revokeBody = (await revoke.json()) as { success: boolean; permission: string }
      expect(revokeBody).toMatchObject({ success: true, permission: 'approvals:read' })

      // SAME token, SAME endpoint — post-revoke this must deny again.
      const afterRevoke = await fetch(`${baseUrl}/api/approvals/pending-count`, {
        headers: { Authorization: `Bearer ${target.token}` },
      })
      expect(afterRevoke.status).toBe(403)
    },
  )

  it(
    'WRITE-SHAPED SURFACE BEHIND approvals:read: enumerates what an approvals:read holder can reach on write-shaped routes gated by the SAME rbacGuard(\'approvals\',\'read\') predicate this migration\'s code feeds — POST /api/approval-delegations/mine (creates a delegation row) and POST /api/approvals/mark-all-read (mutates read-state). Without the grant both 403 (negative control, unchanged by this migration). WITH the grant, this records the ACTUAL status/effect rather than assuming a particular outcome either way — a 2xx here is evidence for the private write-up (approvals:read gates more than reads), not something this test tries to prevent or launder.',
    async () => {
      const adminEmail = `permcat-admin5-${TS}@example.com`
      const targetEmail = `permcat-target5-${TS}@example.com`
      const delegateeEmail = `permcat-delegatee5-${TS}@example.com`

      const admin = await registerUser(baseUrl, adminEmail, 'Permcat Admin Five')
      const target = await registerUser(baseUrl, targetEmail, 'Permcat Target Five')
      const delegatee = await registerUser(baseUrl, delegateeEmail, 'Permcat Delegatee Five')
      createdUserIds.push(admin.userId, target.userId, delegatee.userId)
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [admin.userId],
      )

      // BEFORE grant: negative control — target has approvals:read on neither route yet.
      const delegationsBefore = await fetch(`${baseUrl}/api/approval-delegations/mine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({
          delegateeUserId: delegatee.userId,
          scope: 'all',
          startAt: new Date(TS).toISOString(),
          endAt: new Date(TS + 24 * 60 * 60 * 1000).toISOString(),
        }),
      })
      expect(delegationsBefore.status).toBe(403)

      const markAllReadBefore = await fetch(`${baseUrl}/api/approvals/mark-all-read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({}),
      })
      expect(markAllReadBefore.status).toBe(403)

      const grant = await grantPermission(baseUrl, admin.token, target.userId, 'approvals:read')
      expect(grant.status).toBe(200)

      // AFTER grant — record the real outcome as evidence, whatever it is.
      const delegationsAfter = await fetch(`${baseUrl}/api/approval-delegations/mine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({
          delegateeUserId: delegatee.userId,
          scope: 'all',
          startAt: new Date(TS).toISOString(),
          endAt: new Date(TS + 24 * 60 * 60 * 1000).toISOString(),
        }),
      })
      // eslint-disable-next-line no-console
      console.log(`[permcat write-surface evidence] POST /api/approval-delegations/mine after approvals:read grant -> ${delegationsAfter.status}`)

      const markAllReadAfter = await fetch(`${baseUrl}/api/approvals/mark-all-read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({}),
      })
      // eslint-disable-next-line no-console
      console.log(`[permcat write-surface evidence] POST /api/approvals/mark-all-read after approvals:read grant -> ${markAllReadAfter.status}`)

      // This suite does not assert a particular post-grant status for either route — the finding
      // (round-2 gate P3-B) is that approvals:read is ALSO the leg-1 door for these write-shaped
      // routes, and the actual numbers are the evidence, not a thing to be papered over with a
      // loose assertion. If a future PR adds a leg-2 fence to either route, this evidence changes
      // and the console lines above will show it; until then the numbers are what they are.
      expect(typeof delegationsAfter.status).toBe('number')
      expect(typeof markAllReadAfter.status).toBe('number')

      // Clean up any delegation row this test actually created (delegator = target).
      if (delegationsAfter.status === 201) {
        const body = (await delegationsAfter.json()) as { data: { id: string } }
        await pool().query(`DELETE FROM approval_delegations WHERE id = $1`, [body.data.id])
      }
    },
  )
})
