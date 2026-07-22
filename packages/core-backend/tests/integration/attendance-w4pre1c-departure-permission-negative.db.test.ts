import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { query } from '../../src/db/pg'
import { applyDirectoryDeprovisionPolicies } from '../../src/directory/directory-sync'
import { db } from '../../src/db/db'
import { DingTalkGroupDestinationService } from '../../src/multitable/dingtalk-group-destination-service'

/**
 * W4-PRE-1c owner case ⑤ ("权限负例") — after a genuine policy-executed departure (real
 * `applyDirectoryDeprovisionPolicies` call, mark_inactive, real DB), the S7-5 readiness door
 * 403s AND the DingTalk group destination visibility disappears; a positive control (a
 * genuinely active member) proves the gate is not vacuously always-403/never-visible.
 *
 * Two SEPARATE fixture shapes are used deliberately (see the destination sub-suite's own
 * doc-comment): the readiness-gate leg uses the REAL policy-executed deactivation (proving
 * THIS PR's new mechanism feeds the pre-existing #4526 gate); the destination leg additionally
 * needs a `users.is_active=false` + `user_orgs.is_active=true` fixture — the ONE shape that can
 * distinguish "the two-clause EXISTS is correct" from "user_orgs alone already excluded the
 * row" (mutation ④, owner E) — a fixture where ONLY user_orgs is deactivated would pass even
 * with the `users.is_active` join deleted.
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
const NS = `w4pre1cneg${TS}`

describeIfDatabase('W4-PRE-1c case ⑤ leg 1 — readiness gate 403 after a policy-executed departure, real endpoint (real DB)', () => {
  let attendanceAdminRouter: () => express.Router

  const integrationName = `${NS}-integration`
  const departedUser = `${NS}-departed`
  const activeUser = `${NS}-active`
  let integrationId = ''
  let orgId = ''

  const depClient = {
    query: (sql: string, params?: unknown[]) =>
      query(sql, params).then((r) => ({ rows: r.rows as Array<Record<string, unknown>> })),
  }

  function makeApp(userId: string) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
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

    const row = (await query<{ id: string; org_id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, org_id, default_deprovision_policy)
       VALUES ($1, $2, $3, 'mark_inactive') RETURNING id::text AS id, org_id`,
      [integrationName, `${integrationName}-corp`, `${NS}-org`],
    )).rows[0]
    integrationId = row.id
    orgId = row.org_id

    for (const userId of [departedUser, activeUser]) {
      await query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
        [userId, `${userId}@example.test`],
      )
      await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [userId, orgId])
    }

    // The departed user's directory binding actually departs, and the policy actually
    // executes — this is what deactivates user_orgs, not a raw SQL flip.
    const external = `${departedUser}-acct`
    const account = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Fixture', false) RETURNING id::text AS id`,
      [integrationId, external, `dingtalk:${external}`],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status) VALUES ($1::uuid, $2, 'linked')`,
      [account.rows[0].id, departedUser],
    )
    const outcome = await applyDirectoryDeprovisionPolicies(depClient, {
      integrationId,
      deactivatedAccountIds: [account.rows[0].id],
      syncedAccountCount: 50,
      integrationDefaultPolicy: 'mark_inactive',
      enabled: true,
    })
    expect(outcome.usersDeactivatedCount).toBe(1)
  })

  afterAll(async () => {
    await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [[departedUser, activeUser]])
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [departedUser])
    await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId]) // links cascade
    await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[departedUser, activeUser]])
  })

  it('200 for a genuinely active org member (positive control)', async () => {
    const res = await request(makeApp(activeUser)).get(`/api/attendance-admin/directory-readiness?orgId=${encodeURIComponent(orgId)}`)
    expect(res.status).toBe(200)
    expect(res.body?.ok).toBe(true)
  })

  it('403 for the departed member after the deprovision policy actually executed (this PR\'s own mechanism feeding the pre-existing #4526 gate)', async () => {
    const readback = await query<{ is_active: boolean }>(`SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`, [departedUser, orgId])
    expect(readback.rows[0].is_active).toBe(false) // sanity: the fixture setup actually deactivated it

    const res = await request(makeApp(departedUser)).get(`/api/attendance-admin/directory-readiness?orgId=${encodeURIComponent(orgId)}`)
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
  })
})

describeIfDatabase('W4-PRE-1c case ⑤ leg 2 — destination visibility disappears with the dual is_active filter (real DB, real Kysely)', () => {
  const activeUser = `${NS}-dest-active`
  const deactivatedUserActiveMembership = `${NS}-dest-deactivated-user`
  const userIds = [activeUser, deactivatedUserActiveMembership]
  const orgId = `${NS}-dest-org`
  const service = new DingTalkGroupDestinationService(db, vi.fn())
  let destinationId = ''

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'w4pre1c-test-key'
    process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'w4pre1c-test-salt'

    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
      [activeUser, `${activeUser}@example.test`],
    )
    // Mutation ④ target fixture: users.is_active=false, user_orgs.is_active=true — the OLD
    // single-filter EXISTS would still surface this row; only the NEW dual filter excludes it.
    await query(
      `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, false, false, NOW(), NOW())`,
      [deactivatedUserActiveMembership, `${deactivatedUserActiveMembership}@example.test`],
    )
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [activeUser, orgId])
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`, [deactivatedUserActiveMembership, orgId])

    const destination = await service.createDestination('w4pre1c-creator', {
      name: `${NS} org destination`,
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=w4pre1c-token',
      orgId,
    })
    destinationId = destination.id
  })

  afterAll(async () => {
    if (destinationId) await query(`DELETE FROM dingtalk_group_destinations WHERE id = $1`, [destinationId])
    await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
  })

  it('visible to a genuinely active org member (positive control)', async () => {
    const list = await service.listDestinations(activeUser)
    expect(list.map((d) => d.id)).toContain(destinationId)
  })

  it('NOT visible when users.is_active=false even though user_orgs.is_active=true (mutation ④ target — the load-bearing case)', async () => {
    const list = await service.listDestinations(deactivatedUserActiveMembership)
    expect(list.map((d) => d.id)).not.toContain(destinationId)
  })

  it('NOT visible when user_orgs.is_active=false (pre-existing filter, unchanged by this PR — deactivated departure end state)', async () => {
    await query(`UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2`, [activeUser, orgId])
    try {
      const list = await service.listDestinations(activeUser)
      expect(list.map((d) => d.id)).not.toContain(destinationId)
    } finally {
      await query(`UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2`, [activeUser, orgId])
    }
  })
})
