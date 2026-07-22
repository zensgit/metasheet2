import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { query } from '../../src/db/pg'

/**
 * W4-PRE-1b item E (F5) — the S7-5 door (`GET /api/attendance-admin/directory-readiness`,
 * `canReadAttendanceDirectoryReadiness`) now requires `users.is_active=true` IN ADDITION TO
 * `user_orgs.is_active=true`, exercised via the REAL endpoint (owner: "经真实端点") against a
 * REAL Postgres — everything is real EXCEPT the router-level `rbacGuard('attendance','admin')`
 * mount guard, which is bypassed the SAME way the existing mocked unit coverage for this exact
 * route does (`attendance-admin-admin-directory-readiness-s7-5.test.ts`'s `makeApp` +
 * `vi.mock('../../src/rbac/rbac', ...)`): that outer gate is an UNRELATED RBAC namespace-
 * admission subsystem this ticket does not touch, and a real-DB test that tried to satisfy it
 * would need to seed unrelated `user_roles`/namespace-admission fixtures that have nothing to do
 * with item E. `canReadAttendanceDirectoryReadiness` itself — the function under test — is
 * imported UNMOCKED and runs its real SQL against the real DB below; only the middleware ABOVE
 * it in the stack is stubbed, matching this repo's own precedent for isolating this route.
 *
 * `req.user` is set directly by a tiny test middleware (no JWT/dev-token machinery needed once
 * the router-level gate is stubbed) — critically NEVER `role: 'admin'` / `roles: ['admin']` /
 * `perms: ['*:*'|'admin:all']`, so `hasLegacyAdminClaim` stays false and `isRbacAdmin` (a real,
 * unmocked DB check — none of these synthetic userIds hold an admin role row) also stays false,
 * meaning the request reaches `canReadAttendanceDirectoryReadiness`'s OWN `user_orgs`/`users`
 * query instead of short-circuiting on the platform-admin bypass (the exact vacuous-test trap
 * flagged during review).
 */
vi.mock('../../src/rbac/rbac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/rbac')>()
  return {
    ...actual,
    rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }
})

vi.mock('../../src/routes/admin-users', () => ({
  ensurePlatformAdmin: vi.fn(async () => null),
}))

vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const TS = Date.now()
const NS = `w4pre1bgate${TS}`
const ORG = `${NS}-org`

describeIfDatabase('W4-PRE-1b item E (F5) — directory-readiness gate dual is_active (real DB, real endpoint)', () => {
  let attendanceAdminRouter: () => express.Router

  const activeUser = `${NS}-active`
  const deactivatedUserActiveMembership = `${NS}-deactivated-user`
  const activeUserDeactivatedMembership = `${NS}-deactivated-membership`
  const userIds = [activeUser, deactivatedUserActiveMembership, activeUserDeactivatedMembership]

  function makeApp(userId: string) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      // Delegated (non-platform) attendance admin: NO 'admin' role/perm anywhere.
      ;(req as express.Request & { user?: unknown }).user = { id: userId, roles: ['user'], permissions: ['attendance:admin'] }
      next()
    })
    app.use(attendanceAdminRouter())
    return app
  }

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')
    process.env.DATABASE_URL = dbUrl
    ;({ attendanceAdminRouter } = await import('../../src/routes/attendance-admin'))

    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
      [activeUser, `${activeUser}@example.test`],
    )
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, false, false, NOW(), NOW())`,
      [deactivatedUserActiveMembership, `${deactivatedUserActiveMembership}@example.test`],
    )
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
      [activeUserDeactivatedMembership, `${activeUserDeactivatedMembership}@example.test`],
    )

    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [activeUser, ORG])
    // Mutation G target variant: users.is_active=false, user_orgs.is_active=true — the OLD
    // single-filter gate would have allowed this; only the NEW dual filter blocks it.
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [deactivatedUserActiveMembership, ORG])
    // Pre-existing filter's own variant (unchanged behavior, sanity control).
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, false)`, [activeUserDeactivatedMembership, ORG])
  })

  afterAll(async () => {
    await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
  })

  it('200 for a genuinely active delegated admin (positive control)', async () => {
    const res = await request(makeApp(activeUser)).get(`/api/attendance-admin/directory-readiness?orgId=${encodeURIComponent(ORG)}`)
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
  })

  it('403 when users.is_active=false even though user_orgs.is_active=true (mutation G target)', async () => {
    const res = await request(makeApp(deactivatedUserActiveMembership)).get(
      `/api/attendance-admin/directory-readiness?orgId=${encodeURIComponent(ORG)}`,
    )
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
  })

  it('403 when user_orgs.is_active=false (pre-existing filter, unchanged)', async () => {
    const res = await request(makeApp(activeUserDeactivatedMembership)).get(
      `/api/attendance-admin/directory-readiness?orgId=${encodeURIComponent(ORG)}`,
    )
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
  })
})
