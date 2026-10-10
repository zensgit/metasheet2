import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import http from 'node:http'
import express from 'express'
import { authRouter } from '../../src/routes/auth'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { query, transaction } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import {
  assignUserRoles,
  RoleAssignmentForbiddenError,
  type RoleAssignmentScope,
} from '../../src/rbac/role-assignment'
import { Pool } from 'pg'

/**
 * W4-PRE-1 (§3.3 of docs/development/attendance-vnext-wave4-onboarding-design-lock-20260721.md,
 * the pre-ticket owner errata #4513 blocked Wave 4 on): before this PR, `user_orgs` had exactly
 * ONE production writer — the one-time zzzz20260114110000 backfill migration. `POST
 * /api/admin/users` is the FIRST-PRIORITY write site named in the ticket: it already resolves
 * and validates a known-authoritative org (attendanceOrgId, checked against
 * attendance_groups.org_id / attendance_shifts.org_id above the write) whenever attendance
 * onboarding fields are supplied, but historically never persisted that org into `user_orgs`.
 *
 * This file proves, against a real Postgres, the three required suites (§3.3 item 3):
 *   - fresh-DB: a brand-new admission writes the user_orgs row, and a user_orgs write failure
 *     rolls back the WHOLE admission (no orphan `users` row with no membership).
 *   - two-org: two admissions in different orgs never cross-count.
 *   - upgrade: a pre-existing zzzz20260114110000-style backfill row survives a later admission
 *     in the same org.
 * …plus the org-unknowable negative control for THIS route (no attendanceGroupId/
 * defaultShiftId supplied): zero user_orgs rows, never a silent 'default' guess (§3.3 item 2).
 * …plus item 4's is_active semantics: user_orgs.is_active is hardcoded TRUE at admission
 * (never mirrors the created user's own isActive) — an admin-created-inactive user is excluded
 * from the RD-3 dual-is_active count via users.is_active alone, and reactivating that user later
 * (PATCH /api/admin/users/:userId/status, the only production writer of users.is_active) needs
 * no separate user_orgs repair, because user_orgs.is_active was never set to false in the first
 * place.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const RUN = crypto.randomBytes(4).toString('hex')
const NS = `w4pre1admit${TS}${RUN}`
const P28_SHADOW_ORG_ID = '82828282-8282-4828-8828-282828282828'

function orgId(tag: string): string {
  return `${NS}_org_${tag}`
}
function emailFor(tag: string): string {
  return `${NS}.${tag}@example.com`
}

describeIfDatabase('W4-PRE-1 — user_orgs admission write site: POST /api/admin/users (real DB)', () => {
  // Deliberately NOT MetaSheetServer: its stop() closes the shared pg pool (src/index.ts, "Close
  // database pool" shutdown task), which would poison every OTHER .db.test.ts file that shares
  // this vitest.integration.config.ts invocation (fileParallelism:false runs them serially in one
  // process — plugin-tests.yml's "Run attendance integration tests" step runs dozens of files in
  // one command). A bare Express app mounting only the routers under test, closed via
  // httpServer.close() (HTTP listener only), keeps this file's real-route/real-DB coverage
  // without that blast radius.
  let httpServer: http.Server
  let baseUrl = ''
  let adminToken = ''

  const createdUserIds: string[] = []
  const createdGroupIds: string[] = []
  const createdShiftIds: string[] = []

  async function seedGroup(org: string, tag: string): Promise<{ id: string; name: string }> {
    const id = crypto.randomUUID()
    const name = `${NS}-group-${tag}`
    await query(
      `INSERT INTO attendance_groups (id, org_id, name, attendance_type) VALUES ($1, $2, $3, 'fixed_shift')`,
      [id, org, name],
    )
    createdGroupIds.push(id)
    return { id, name }
  }

  async function createUserViaRoute(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    if (json?.data?.user?.id) createdUserIds.push(json.data.user.id)
    return { status: res.status, json }
  }

  async function seedShift(
    org: string,
    tag: string,
    segments: Array<{ startTime: string; endTime: string }>,
  ): Promise<{ id: string; name: string }> {
    const id = crypto.randomUUID()
    const name = `${NS}-shift-${tag}`
    await query(
      `INSERT INTO attendance_shifts
         (id, org_id, name, timezone, work_start_time, work_end_time, is_overnight)
       VALUES ($1, $2, $3, 'UTC', $4::time, $5::time, false)`,
      [id, org, name, segments[0]?.startTime ?? '09:00', segments.at(-1)?.endTime ?? '18:00'],
    )
    for (const [index, segment] of segments.entries()) {
      await query(
        `INSERT INTO attendance_shift_segments
           (org_id, shift_id, segment_index, start_time, start_day_offset, end_time, end_day_offset)
         VALUES ($1, $2, $3, $4::time, 0, $5::time, 0)`,
        [org, id, index, segment.startTime, segment.endTime],
      )
    }
    createdShiftIds.push(id)
    return { id, name }
  }

  async function userOrgRow(userId: string, org: string): Promise<{ user_id: string; org_id: string; is_active: boolean } | null> {
    const result = await query<{ user_id: string; org_id: string; is_active: boolean }>(
      `SELECT user_id, org_id, is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
      [userId, org],
    )
    return result.rows[0] ?? null
  }

  async function activeMemberCount(org: string): Promise<number> {
    // Mirrors plugins/plugin-attendance/index.cjs:15532-15541 RD-3 target-population semantics
    // (§3.3 item 4): active org members = user_orgs.is_active=true AND users.is_active=true.
    const result = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM user_orgs uo
         JOIN users u ON u.id = uo.user_id
        WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true`,
      [org],
    )
    return result.rows[0]?.n ?? 0
  }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(adminUsersRouter())
    httpServer = http.createServer(app)
    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to bind ephemeral port for W4-PRE-1 admission test server'))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`

    const tokenRes = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${NS}-admin&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const tokenJson = await tokenRes.json()
    adminToken = tokenJson.token as string
  })

  afterAll(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
    if (createdUserIds.length) {
      await query(`DELETE FROM attendance_shift_assignments WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM attendance_group_members WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [createdUserIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
    }
    if (createdGroupIds.length) {
      await query(`DELETE FROM attendance_groups WHERE id = ANY($1::uuid[])`, [createdGroupIds])
    }
    if (createdShiftIds.length) {
      await query(`DELETE FROM attendance_shift_segments WHERE shift_id = ANY($1::uuid[])`, [createdShiftIds])
      await query(`DELETE FROM attendance_shifts WHERE id = ANY($1::uuid[])`, [createdShiftIds])
    }
  })

  describe('fresh-DB', () => {
    it('a first-priority admission (attendanceOrgId known) writes user_orgs in the same transaction', async () => {
      const org = orgId('fresh')
      const group = await seedGroup(org, 'fresh')

      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 Fresh',
        email: emailFor('fresh'),
        orgId: org,
        attendanceGroupId: group.id,
      })

      expect(status).toBe(200)
      expect(json.ok).toBe(true)
      const userId = json.data.user.id as string
      expect(json.data.attendanceOnboarding).toEqual({
        orgId: org,
        group: { id: group.id, name: group.name, memberCreated: true },
        defaultShift: null,
      })

      const row = await userOrgRow(userId, org)
      expect(row).toEqual({ user_id: userId, org_id: org, is_active: true })
    })

    it('fails closed before all admission writes when defaultShiftId is multi-segment preview-only', async () => {
      const org = orgId('multisegment')
      const shift = await seedShift(org, 'multisegment', [
        { startTime: '09:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '18:00' },
      ])
      const testEmail = emailFor('multisegment')

      const { status, json } = await createUserViaRoute({
        name: 'W3 Multi Segment',
        email: testEmail,
        orgId: org,
        defaultShiftId: shift.id,
        defaultShiftStartDate: '2026-07-24',
      })

      expect(status).toBe(422)
      expect(json).toMatchObject({
        ok: false,
        error: {
          code: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
          details: [{
            field: 'defaultShiftId',
          }],
        },
      })
      const users = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [testEmail])
      expect(users.rows).toEqual([])
      const memberships = await query<{ user_id: string }>('SELECT user_id FROM user_orgs WHERE org_id = $1', [org])
      expect(memberships.rows).toEqual([])
      const assignments = await query<{ id: string }>(
        'SELECT id FROM attendance_shift_assignments WHERE org_id = $1 AND shift_id = $2',
        [org, shift.id],
      )
      expect(assignments.rows).toEqual([])
    })

    it('P28 admits a multi-segment default shift through the canonical shadow posture seam', async () => {
      const org = P28_SHADOW_ORG_ID
      const shift = await seedShift(org, 'p28-shadow', [
        { startTime: '09:00', endTime: '12:00' },
        { startTime: '13:00', endTime: '18:00' },
      ])
      const testEmail = emailFor('p28-shadow')
      const previousAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      await query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
         VALUES ($1, 'shadow', 'w4c3b-p28-test', 'TEST_FIXTURE', 'w4c3b-p28-test', 1, NULL)
         ON CONFLICT (org_id) DO NOTHING`,
        [org],
      )
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = org

      try {
        const { status, json } = await createUserViaRoute({
          name: 'W4C3B P28 Shadow',
          email: testEmail,
          orgId: org,
          defaultShiftId: shift.id,
          defaultShiftStartDate: '2026-08-01',
        })

        expect(status, JSON.stringify(json)).toBe(200)
        const userId = json.data.user.id as string
        expect(await userOrgRow(userId, org)).toEqual({ user_id: userId, org_id: org, is_active: true })
        const assignments = await query<{ user_id: string; shift_id: string }>(
          `SELECT user_id, shift_id::text AS shift_id
             FROM attendance_shift_assignments
            WHERE org_id = $1 AND user_id = $2 AND shift_id = $3::uuid`,
          [org, userId, shift.id],
        )
        expect(assignments.rows).toEqual([{ user_id: userId, shift_id: shift.id }])
      } finally {
        if (previousAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
        else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = previousAllowlist
      }
    })

    it('atomicity: a user_orgs write failure rolls back the whole admission (no orphan users row)', async () => {
      const org = orgId('atomicfail')
      const group = await seedGroup(org, 'atomicfail')
      const fnName = `w4pre1_fail_user_orgs_admin_${RUN}`
      const testEmail = emailFor('atomicfail')

      await query(`CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'W4-PRE-1 injected admin-users user_orgs failure' USING ERRCODE = 'P0001';
        END $fn$ LANGUAGE plpgsql`)
      await query(`CREATE TRIGGER ${fnName}_trg BEFORE INSERT ON user_orgs
        FOR EACH ROW WHEN (NEW.org_id = '${org}') EXECUTE FUNCTION ${fnName}()`)

      try {
        const { status, json } = await createUserViaRoute({
          name: 'W4PRE1 Atomic',
          email: testEmail,
          orgId: org,
          attendanceGroupId: group.id,
        })

        expect(status).toBe(500)
        expect(json.ok).toBe(false)

        const usersRow = await query(`SELECT id FROM users WHERE email = $1`, [testEmail])
        expect(usersRow.rows).toEqual([])
        const orgRows = await query(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [org])
        expect(orgRows.rows).toEqual([])
        // The group-member insert is part of the SAME transaction — it must have rolled back too.
        const memberRows = await query(`SELECT id FROM attendance_group_members WHERE group_id = $1`, [group.id])
        expect(memberRows.rows).toEqual([])
      } finally {
        await query(`DROP TRIGGER IF EXISTS ${fnName}_trg ON user_orgs`).catch(() => {})
        await query(`DROP FUNCTION IF EXISTS ${fnName}()`).catch(() => {})
      }
    })
  })

  describe('two-org', () => {
    it('admissions in org A and org B do not cross-count (org_id-anchored)', async () => {
      const orgA = orgId('twoA')
      const orgB = orgId('twoB')
      const groupA = await seedGroup(orgA, 'twoA')
      const groupB = await seedGroup(orgB, 'twoB')

      const { json: jsonA } = await createUserViaRoute({
        name: 'W4PRE1 TwoA',
        email: emailFor('twoA'),
        orgId: orgA,
        attendanceGroupId: groupA.id,
      })
      const { json: jsonB } = await createUserViaRoute({
        name: 'W4PRE1 TwoB',
        email: emailFor('twoB'),
        orgId: orgB,
        attendanceGroupId: groupB.id,
      })
      const userA = jsonA.data.user.id as string
      const userB = jsonB.data.user.id as string

      expect(await activeMemberCount(orgA)).toBe(1)
      expect(await activeMemberCount(orgB)).toBe(1)

      const rowsA = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgA])
      expect(rowsA.rows.map((r) => r.user_id)).toEqual([userA])
      const rowsB = await query<{ user_id: string }>(`SELECT user_id FROM user_orgs WHERE org_id = $1`, [orgB])
      expect(rowsB.rows.map((r) => r.user_id)).toEqual([userB])
    })
  })

  describe('org-unknowable (this route without attendance onboarding fields)', () => {
    it('creating a user with no attendanceGroupId/defaultShiftId writes zero user_orgs rows (no silent default)', async () => {
      const testEmail = emailFor('noorg')
      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 NoOrg',
        email: testEmail,
      })

      expect(status).toBe(200)
      const userId = json.data.user.id as string
      expect(json.data.attendanceOnboarding).toBeNull()

      const rows = await query(`SELECT org_id FROM user_orgs WHERE user_id = $1`, [userId])
      expect(rows.rows).toEqual([])
    })
  })

  describe('user_orgs.is_active is hardcoded TRUE (never mirrors the created user\'s isActive)', () => {
    it('isActive:false at creation still writes user_orgs.is_active=true, exclusion comes ONLY from users.is_active, and reactivation via PATCH status needs no membership repair', async () => {
      const org = orgId('inactive')
      const group = await seedGroup(org, 'inactive')

      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 Inactive',
        email: emailFor('inactive'),
        orgId: org,
        attendanceGroupId: group.id,
        isActive: false,
      })

      expect(status).toBe(200)
      const userId = json.data.user.id as string

      // The membership row exists and is_active=TRUE even though the user itself is inactive —
      // this is the fix under test: is_active must NOT mirror the created user's isActive flag.
      const row = await userOrgRow(userId, org)
      expect(row).toEqual({ user_id: userId, org_id: org, is_active: true })

      // Excluded from the RD-3 dual-is_active active-member count purely via users.is_active,
      // never via user_orgs.is_active.
      expect(await activeMemberCount(org)).toBe(0)

      // Reactivate through the ONLY production write path that ever flips users.is_active
      // (PATCH /api/admin/users/:userId/status — it never touches user_orgs).
      const patchRes = await fetch(`${baseUrl}/api/admin/users/${userId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ isActive: true }),
      })
      expect(patchRes.status).toBe(200)

      // No stuck-false membership to repair: user_orgs.is_active was TRUE all along, so the
      // count now includes this member purely because users.is_active flipped.
      expect(await activeMemberCount(org)).toBe(1)
      const rowAfterReactivate = await userOrgRow(userId, org)
      expect(rowAfterReactivate).toEqual({ user_id: userId, org_id: org, is_active: true })
    })
  })

  describe('upgrade', () => {
    it('a pre-existing zzzz20260114110000-style backfill row survives a new admission in the same org', async () => {
      // 'default' is the literal org_id the real backfill migration writes for every pre-existing
      // active user (zzzz20260114110000_create_user_orgs_table.ts). Simulating it here (rather
      // than a synthetic org) is deliberate: it proves the new write path is additive against
      // the actual upgrade shape, not just against a fresh custom org.
      const org = 'default'
      const legacyUserId = `${NS}-legacy-user`
      const legacyEmail = emailFor('legacy')
      const legacyUsername = `${NS}legacyuser`
      createdUserIds.push(legacyUserId)

      await query(
        `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
         VALUES ($1, $2, $3, 'W4PRE1 Legacy', 'x', 'user', '[]'::jsonb, true, false, NOW(), NOW())`,
        [legacyUserId, legacyEmail, legacyUsername],
      )
      // Simulates the backfill migration's own INSERT shape exactly (user_id, org_id, is_active).
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
        [legacyUserId, org],
      )

      const group = await seedGroup(org, 'upgrade')
      const { status, json } = await createUserViaRoute({
        name: 'W4PRE1 Upgrade',
        email: emailFor('upgrade'),
        orgId: org,
        attendanceGroupId: group.id,
      })

      expect(status).toBe(200)
      const newUserId = json.data.user.id as string

      const newRow = await userOrgRow(newUserId, org)
      expect(newRow).toEqual({ user_id: newUserId, org_id: org, is_active: true })

      const legacyRow = await userOrgRow(legacyUserId, org)
      expect(legacyRow).toEqual({ user_id: legacyUserId, org_id: org, is_active: true })
    })
  })
})

/**
 * Role delegation, owner ruling 2026-10-10 「只有平台管理员能任命 *_admin」 — REAL Postgres, real routes.
 *
 * Hosted in this file on purpose: it is an already-registered real-DB file of plugin-tests.yml's
 * "Run attendance integration tests" step and already mounts `adminUsersRouter` behind
 * `authRouter` dev tokens on a bare Express app (see the harness note above), so these legs run in
 * CI with no workflow edit. Self-contained: its own server, its own run-unique ids and cleanup.
 *
 *  - a delegate cannot assign or revoke ANY namespace main-admin role (`attendance_admin`,
 *    `stock-prep_admin`, an arbitrary `<x>_admin`); a platform admin can, on the same route;
 *  - a delegate cannot assign a role carrying a code outside its namespace (`multitable:write`),
 *    and that check is serialized against a concurrent role edit by the FOR SHARE row lock taken
 *    inside the write transaction (proved with a real blocking editor);
 *  - G7 (the S5b judge's scenario): revoking a main-admin role removes the department AND
 *    member-group audience; re-appointing starts with none; audience orphaned before this fix is
 *    dropped on the next appointment; every revoke path tested clears it;
 *  - gate order: an empty body still answers 400 for a delegated attendance_admin.
 *  - fix round 1: admin power via CODES (`<ns>:admin` / `<ns>:*`) is refused like the `_admin`
 *    id; a delegate may REVOKE a role carrying ordinary platform codes but not an admin-level
 *    one; the write boundary refuses by itself under the delegated scope (and serializes its own
 *    code read against an editor); a revocation clears only the revoked namespace's audience; the
 *    attendance admin router's four role writes audit their cleanup and a batch appointment
 *    leaves a sitting admin's audience alone.
 */
describeIfDatabase('role delegation — only a platform admin appoints *_admin; the audience follows the role (real DB)', () => {
  const RUN_ID = crypto.randomBytes(4).toString('hex')
  const P = `adgrd${TS}${RUN_ID}`
  const X_NS = `adgx${RUN_ID}`
  const ids = {
    platformAdmin: `${P}-pa`,
    attendanceDelegate: `${P}-d-att`,
    stockPrepDelegate: `${P}-d-sp`,
    xDelegate: `${P}-d-x`,
    target: `${P}-t1`,
    reappointed: `${P}-t2`,
    orphan: `${P}-t3`,
    multiNamespace: `${P}-t4`,
    boundaryTarget: `${P}-t5`,
    // The attendance admin router's batch routes accept UUIDs only.
    attendanceSingle: crypto.randomUUID(),
    attendanceSitting: crypto.randomUUID(),
    attendanceFresh: crypto.randomUUID(),
  }
  const allUserIds = Object.values(ids)
  const roles = {
    stockPrepAdmin: 'stock-prep_admin',
    stockPrepMember: `stock-prep_adg${RUN_ID}`,
    attendancePlain: `attendance_adg${RUN_ID}_plain`,
    attendancePlatformish: `attendance_adg${RUN_ID}_platformish`,
    attendanceRace: `attendance_adg${RUN_ID}_race`,
    attendanceLead: `attendance_adg${RUN_ID}_lead`,
    attendanceWild: `attendance_adg${RUN_ID}_wild`,
    attendanceSuperish: `attendance_adg${RUN_ID}_superish`,
    attendanceBoundaryRace: `attendance_adg${RUN_ID}_brace`,
    xAdmin: `${X_NS}_admin`,
  }
  const createdRoleIds: string[] = []
  const createdPermissionCodes: string[] = []
  const tokens: Record<string, string> = {}
  let httpServer: http.Server
  let baseUrl = ''
  let groupId = ''
  let integrationId = ''
  let departmentId = ''
  const lockPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })

  async function api(method: string, path: string, token: string, body?: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const delegationRole = (token: string, userId: string, action: 'assign' | 'unassign', body: Record<string, unknown>) =>
    api('POST', `/api/admin/role-delegation/users/${encodeURIComponent(userId)}/roles/${action}`, token, body)

  async function holds(userId: string, roleId: string): Promise<boolean> {
    const r = await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2', [userId, roleId])
    return r.rows.length > 0
  }
  async function audience(userId: string, namespace: string): Promise<{ departments: number; groups: number }> {
    const [d, g] = await Promise.all([
      query<{ n: number }>('SELECT count(*)::int AS n FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = $2', [userId, namespace]),
      query<{ n: number }>('SELECT count(*)::int AS n FROM delegated_role_admin_member_groups WHERE admin_user_id = $1 AND namespace = $2', [userId, namespace]),
    ])
    return { departments: d.rows[0]?.n ?? 0, groups: g.rows[0]?.n ?? 0 }
  }
  async function auditCount(resourceType: string, resourceId: string, action: string): Promise<number> {
    const r = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_logs WHERE resource_type = $1 AND resource_id = $2 AND action = $3',
      [resourceType, resourceId, action],
    )
    return r.rows[0]?.n ?? 0
  }
  async function ensureRole(roleId: string, codes: string[]): Promise<void> {
    const inserted = await query<{ id: string }>(
      'INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING RETURNING id',
      [roleId],
    )
    if (inserted.rows.length === 0) return // pre-existing (e.g. a seeded role): leave it exactly as found
    createdRoleIds.push(roleId)
    for (const code of codes) {
      // `role_permissions.permission_code` references `permissions(code)`; a code this file had to
      // create (e.g. a wildcard) is removed again in afterAll.
      const createdCode = await query<{ code: string }>(
        'INSERT INTO permissions (code, name, description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING RETURNING code',
        [code, code, code],
      )
      if (createdCode.rows.length) createdPermissionCodes.push(code)
      await query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, code])
    }
  }

  beforeAll(async () => {
    for (const userId of allUserIds) {
      await query(
        `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', true, false)`,
        [userId, `${userId}@example.test`],
      )
    }
    await ensureRole(roles.stockPrepAdmin, ['stock-prep:admin'])
    await ensureRole(roles.stockPrepMember, ['stock-prep:read'])
    await ensureRole(roles.attendancePlain, ['attendance:read'])
    await ensureRole(roles.attendancePlatformish, ['attendance:read', 'multitable:write'])
    await ensureRole(roles.attendanceRace, ['attendance:read'])
    await ensureRole(roles.attendanceLead, ['attendance:read', 'attendance:admin'])
    await ensureRole(roles.attendanceWild, ['attendance:*'])
    await ensureRole(roles.attendanceSuperish, ['attendance:read', '*:*'])
    await ensureRole(roles.attendanceBoundaryRace, ['attendance:read'])
    await ensureRole(roles.xAdmin, [])

    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4), ($5, $6)', [
      ids.attendanceDelegate, 'attendance_admin',
      ids.stockPrepDelegate, roles.stockPrepAdmin,
      ids.xDelegate, roles.xAdmin,
    ])
    groupId = (await query<{ id: string }>('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id', [`${P}-group`])).rows[0].id
    for (const member of [ids.target, ids.reappointed, ids.orphan]) {
      await query('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)', [groupId, member])
    }
    for (const [delegate, namespace] of [
      [ids.attendanceDelegate, 'attendance'],
      [ids.stockPrepDelegate, 'stock-prep'],
      [ids.xDelegate, X_NS],
    ]) {
      await query(
        'INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by) VALUES ($1, $2, $3, $4)',
        [delegate, namespace, groupId, ids.platformAdmin],
      )
    }
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
      [`${P}-org`, `${P}-int`, `corp-${P}`],
    )).rows[0].id
    departmentId = (await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
      [integrationId, `${P}-dept`, `${P}-dept`],
    )).rows[0].id

    // Loaded lazily, as the other attendance-admin real-DB files do.
    const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')
    const app = express()
    app.use(express.json())
    app.use('/api/auth', authRouter)
    app.use(adminUsersRouter())
    app.use('/api/attendance-admin', authenticate)
    app.use(attendanceAdminRouter())
    httpServer = http.createServer(app)
    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(0, '127.0.0.1', () => {
        const address = httpServer.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('failed to bind ephemeral port for the role-delegation test server'))
      })
    })
    baseUrl = `http://127.0.0.1:${port}`
    const devToken = async (userId: string, platform: boolean) => {
      const qs = platform
        ? `userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`
        : `userId=${encodeURIComponent(userId)}&roles=user&perms=${encodeURIComponent('attendance:read')}`
      const json = await (await fetch(`${baseUrl}/api/auth/dev-token?${qs}`)).json()
      if (!json?.token) throw new Error('dev-token issuance failed')
      return json.token as string
    }
    tokens.platformAdmin = await devToken(ids.platformAdmin, true)
    for (const key of ['attendanceDelegate', 'stockPrepDelegate', 'xDelegate', 'reappointed'] as const) {
      tokens[key] = await devToken(ids[key], false)
    }
  })

  afterAll(async () => {
    if (httpServer) await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await lockPool.end()
    await query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [allUserIds])
    await query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id = ANY($1::text[])', [allUserIds])
    await query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [allUserIds])
    await query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [allUserIds])
    if (groupId) {
      await query('DELETE FROM platform_member_group_members WHERE group_id = $1', [groupId])
      await query('DELETE FROM platform_member_groups WHERE id = $1', [groupId])
    }
    if (departmentId) await query('DELETE FROM directory_departments WHERE id = $1', [departmentId])
    if (integrationId) await query('DELETE FROM directory_integrations WHERE id = $1', [integrationId])
    if (createdRoleIds.length) {
      await query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [createdRoleIds])
      await query('DELETE FROM roles WHERE id = ANY($1::text[])', [createdRoleIds])
    }
    if (createdPermissionCodes.length) {
      await query('DELETE FROM permissions WHERE code = ANY($1::text[])', [createdPermissionCodes])
    }
    await query('DELETE FROM users WHERE id = ANY($1::text[])', [allUserIds])
  })

  it('a delegate cannot appoint attendance_admin, stock-prep_admin or an arbitrary x_admin (403, nothing written, refusal audited)', async () => {
    const cases: Array<[string, string]> = [
      [tokens.attendanceDelegate, 'attendance_admin'],
      [tokens.stockPrepDelegate, roles.stockPrepAdmin],
      [tokens.xDelegate, roles.xAdmin],
    ]
    for (const [token, roleId] of cases) {
      const { status, json } = await delegationRole(token, ids.target, 'assign', { roleId })
      expect({ roleId, status, code: json?.error?.code }).toEqual({ roleId, status: 403, code: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN' })
      expect(JSON.stringify(json)).not.toContain(roleId)
      expect(await holds(ids.target, roleId)).toBe(false)
      expect(await auditCount('user-role', `${ids.target}:${roleId}`, 'grant_denied')).toBeGreaterThanOrEqual(1)
    }
  })

  it('a delegate cannot demote a peer main admin either (unassign attendance_admin → 403, the row stays)', async () => {
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.target, 'attendance_admin'])
    try {
      const { status, json } = await delegationRole(tokens.attendanceDelegate, ids.target, 'unassign', { roleId: 'attendance_admin' })
      expect(status).toBe(403)
      expect(json?.error?.code).toBe('ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN')
      expect(await holds(ids.target, 'attendance_admin')).toBe(true)
    } finally {
      await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.target, 'attendance_admin'])
    }
    // `<x>_admin` carries no code at all: the peer-demotion refusal must come from its id.
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.target, roles.xAdmin])
    try {
      const { status, json } = await delegationRole(tokens.xDelegate, ids.target, 'unassign', { roleId: roles.xAdmin })
      expect(status).toBe(403)
      expect(json?.error?.code).toBe('ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN')
      expect(await holds(ids.target, roles.xAdmin)).toBe(true)
      expect(await auditCount('user-role', `${ids.target}:${roles.xAdmin}`, 'revoke_denied')).toBeGreaterThanOrEqual(1)
    } finally {
      await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.target, roles.xAdmin])
    }
  })

  it('POSITIVE CONTROL — a platform admin appoints stock-prep_admin through the same route', async () => {
    const { status } = await delegationRole(tokens.platformAdmin, ids.target, 'assign', { roleId: roles.stockPrepAdmin })
    expect(status).toBe(200)
    expect(await holds(ids.target, roles.stockPrepAdmin)).toBe(true)
    await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.target, roles.stockPrepAdmin])
  })

  it('a delegate cannot assign a role carrying a platform code; in-namespace-only roles still assign', async () => {
    const refused = await delegationRole(tokens.attendanceDelegate, ids.target, 'assign', { roleId: roles.attendancePlatformish })
    expect(refused.status).toBe(403)
    expect(refused.json?.error?.code).toBe('ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN')
    expect(JSON.stringify(refused.json)).not.toContain('multitable')
    expect(await holds(ids.target, roles.attendancePlatformish)).toBe(false)
    expect(await auditCount('user-role', `${ids.target}:${roles.attendancePlatformish}`, 'grant_denied')).toBeGreaterThanOrEqual(1)

    const attendanceOk = await delegationRole(tokens.attendanceDelegate, ids.target, 'assign', { roleId: roles.attendancePlain })
    expect(attendanceOk.status).toBe(200)
    expect(await holds(ids.target, roles.attendancePlain)).toBe(true)
    const stockPrepOk = await delegationRole(tokens.stockPrepDelegate, ids.target, 'assign', { roleId: roles.stockPrepMember })
    expect(stockPrepOk.status).toBe(200)
    expect(await holds(ids.target, roles.stockPrepMember)).toBe(true)
  })

  it('the platform-code check is serialized against a concurrent role edit (FOR SHARE inside the write transaction)', async () => {
    const editor = await lockPool.connect()
    let committed = false
    try {
      await editor.query('BEGIN')
      // The role editor's first statement (routes/roles.ts PUT): the role row FOR UPDATE.
      await editor.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [roles.attendanceRace])
      const pending = delegationRole(tokens.attendanceDelegate, ids.target, 'assign', { roleId: roles.attendanceRace })

      let blocked = false
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        const waiting = await lockPool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM roles WHERE id = $1 FOR SHARE%'`,
        )
        blocked = (waiting.rows[0]?.n ?? 0) > 0
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(blocked).toBe(true)

      // While the delegate's request waits on the row lock, the editor adds a platform code.
      await editor.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roles.attendanceRace, 'multitable:write'])
      await editor.query('COMMIT')
      committed = true

      const { status, json } = await pending
      expect(status).toBe(403)
      expect(json?.error?.code).toBe('ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN')
      expect(await holds(ids.target, roles.attendanceRace)).toBe(false)
    } finally {
      if (!committed) await editor.query('ROLLBACK').catch(() => undefined)
      editor.release()
    }
  })

  it('G7 — revoke clears the department AND member-group audience; re-appointment starts with zero audience', async () => {
    const appoint = await delegationRole(tokens.platformAdmin, ids.reappointed, 'assign', { roleId: roles.stockPrepAdmin })
    expect(appoint.status).toBe(200)
    const group = await api('POST', `/api/admin/role-delegation/users/${ids.reappointed}/scope-groups/assign`, tokens.platformAdmin, {
      namespace: 'stock-prep', groupId,
    })
    expect(group.status).toBe(200)
    const department = await api('POST', `/api/admin/role-delegation/users/${ids.reappointed}/scopes/assign`, tokens.platformAdmin, {
      namespace: 'stock-prep', directoryDepartmentId: departmentId,
    })
    expect(department.status).toBe(200)
    expect(await audience(ids.reappointed, 'stock-prep')).toEqual({ departments: 1, groups: 1 })
    // The appointed admin can work with that audience.
    const working = await api('GET', `/api/admin/role-delegation/users/${ids.target}/access`, tokens.reappointed)
    expect(working.status).toBe(200)

    const revoke = await delegationRole(tokens.platformAdmin, ids.reappointed, 'unassign', { roleId: roles.stockPrepAdmin })
    expect(revoke.status).toBe(200)
    expect(await audience(ids.reappointed, 'stock-prep')).toEqual({ departments: 0, groups: 0 })
    expect(await auditCount('delegated-admin-scope', `${ids.reappointed}:stock-prep`, 'revoke')).toBe(1)

    const reappoint = await api('POST', `/api/admin/users/${ids.reappointed}/roles/assign`, tokens.platformAdmin, { roleId: roles.stockPrepAdmin })
    expect(reappoint.status).toBe(200)
    expect(await holds(ids.reappointed, roles.stockPrepAdmin)).toBe(true)
    expect(await audience(ids.reappointed, 'stock-prep')).toEqual({ departments: 0, groups: 0 })
    const after = await api('GET', `/api/admin/role-delegation/users/${ids.target}/access`, tokens.reappointed)
    expect(after.status).toBe(403)
    expect(after.json?.error?.code).toBe('ROLE_DELEGATION_SCOPE_REQUIRED')
  })

  it('audience orphaned by a revocation before this fix is dropped on the next appointment', async () => {
    // The pre-fix state: no main-admin role, audience rows still present.
    await query(
      'INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by) VALUES ($1, $2, $3, $4)',
      [ids.orphan, 'attendance', groupId, ids.platformAdmin],
    )
    await query(
      'INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, created_by) VALUES ($1, $2, $3, $4)',
      [ids.orphan, 'attendance', departmentId, ids.platformAdmin],
    )
    expect(await audience(ids.orphan, 'attendance')).toEqual({ departments: 1, groups: 1 })

    const appoint = await delegationRole(tokens.platformAdmin, ids.orphan, 'assign', { roleId: 'attendance_admin' })
    expect(appoint.status).toBe(200)
    expect(await audience(ids.orphan, 'attendance')).toEqual({ departments: 0, groups: 0 })
  })

  it('revoking through /api/admin/users/:userId/roles/unassign clears the audience too', async () => {
    expect(await holds(ids.orphan, 'attendance_admin')).toBe(true)
    const group = await api('POST', `/api/admin/role-delegation/users/${ids.orphan}/scope-groups/assign`, tokens.platformAdmin, {
      namespace: 'attendance', groupId,
    })
    expect(group.status).toBe(200)
    expect(await audience(ids.orphan, 'attendance')).toEqual({ departments: 0, groups: 1 })

    const revoke = await api('POST', `/api/admin/users/${ids.orphan}/roles/unassign`, tokens.platformAdmin, { roleId: 'attendance_admin' })
    expect(revoke.status).toBe(200)
    expect(await holds(ids.orphan, 'attendance_admin')).toBe(false)
    expect(await audience(ids.orphan, 'attendance')).toEqual({ departments: 0, groups: 0 })
  })

  it('admin power via codes: a delegate cannot assign or revoke a role carrying attendance:admin or attendance:* (403 ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN), nor is it offered one', async () => {
    for (const roleId of [roles.attendanceLead, roles.attendanceWild]) {
      const assign = await delegationRole(tokens.attendanceDelegate, ids.target, 'assign', { roleId })
      expect({ roleId, status: assign.status, code: assign.json?.error?.code }).toEqual({ roleId, status: 403, code: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN' })
      expect(await holds(ids.target, roleId)).toBe(false)
      expect(await auditCount('user-role', `${ids.target}:${roleId}`, 'grant_denied')).toBeGreaterThanOrEqual(1)

      await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.target, roleId])
      try {
        const revoke = await delegationRole(tokens.attendanceDelegate, ids.target, 'unassign', { roleId })
        expect({ roleId, status: revoke.status, code: revoke.json?.error?.code }).toEqual({ roleId, status: 403, code: 'ROLE_DELEGATION_ADMIN_ROLE_FORBIDDEN' })
        expect(await holds(ids.target, roleId)).toBe(true)
        const access = await api('GET', `/api/admin/role-delegation/users/${ids.target}/access`, tokens.attendanceDelegate)
        expect(access.status).toBe(200)
        expect((access.json?.data?.roleCatalog ?? []).map((role: { id: string }) => role.id)).not.toContain(roleId)
        expect(access.json?.data?.delegableRoles ?? []).not.toContain(roleId)
        // POSITIVE CONTROL — the same catalog does offer an ordinary in-namespace role.
        expect((access.json?.data?.roleCatalog ?? []).map((role: { id: string }) => role.id)).toContain(roles.attendancePlain)
      } finally {
        await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.target, roleId])
      }
    }
    // POSITIVE CONTROL — a platform admin appoints the admin-equivalent role on the same route.
    const platform = await delegationRole(tokens.platformAdmin, ids.target, 'assign', { roleId: roles.attendanceLead })
    expect(platform.status).toBe(200)
    await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [ids.target, roles.attendanceLead])
  })

  it('a delegate may REVOKE a role carrying ordinary platform codes (only lowers privilege), but not one carrying *:*', async () => {
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING', [
      ids.target, roles.attendancePlatformish, roles.attendanceSuperish,
    ])
    try {
      const access = await api('GET', `/api/admin/role-delegation/users/${ids.target}/access`, tokens.attendanceDelegate)
      expect(access.json?.data?.delegableRoles ?? []).toContain(roles.attendancePlatformish)
      expect(access.json?.data?.delegableRoles ?? []).not.toContain(roles.attendanceSuperish)
      expect((access.json?.data?.roleCatalog ?? []).map((role: { id: string }) => role.id)).not.toContain(roles.attendancePlatformish)

      const revoke = await delegationRole(tokens.attendanceDelegate, ids.target, 'unassign', { roleId: roles.attendancePlatformish })
      expect(revoke.status).toBe(200)
      expect(await holds(ids.target, roles.attendancePlatformish)).toBe(false)

      const refused = await delegationRole(tokens.attendanceDelegate, ids.target, 'unassign', { roleId: roles.attendanceSuperish })
      expect(refused.status).toBe(403)
      expect(refused.json?.error?.code).toBe('ROLE_DELEGATION_PLATFORM_PERMISSION_FORBIDDEN')
      expect(JSON.stringify(refused.json)).not.toContain('*:*')
      expect(await holds(ids.target, roles.attendanceSuperish)).toBe(true)
      expect(await auditCount('user-role', `${ids.target}:${roles.attendanceSuperish}`, 'revoke_denied')).toBeGreaterThanOrEqual(1)
    } finally {
      await query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = ANY($2::text[])', [
        ids.target, [roles.attendancePlatformish, roles.attendanceSuperish],
      ])
    }
  })

  it('the write boundary refuses by itself under the delegated scope: main-admin id, admin-equivalent codes, platform codes (real transaction)', async () => {
    const delegated: RoleAssignmentScope = { kind: 'namespaces', namespaces: ['attendance'] }
    for (const [roleId, reason] of [
      ['attendance_admin', 'main_admin_role'],
      [roles.attendanceLead, 'admin_equivalent_role'],
      [roles.attendanceWild, 'admin_equivalent_role'],
      [roles.attendancePlatformish, 'platform_permission'],
    ] as const) {
      const error = await transaction((client) => assignUserRoles({ userIds: [ids.boundaryTarget], roleId, scope: delegated, executor: client }))
        .then(() => null, (thrown: unknown) => thrown)
      expect(error, roleId).toBeInstanceOf(RoleAssignmentForbiddenError)
      expect({ roleId, reason: (error as RoleAssignmentForbiddenError).reason }).toEqual({ roleId, reason })
      expect(await holds(ids.boundaryTarget, roleId)).toBe(false)
    }
    // POSITIVE CONTROL — an ordinary in-namespace role is written under the same scope.
    const ok = await transaction((client) => assignUserRoles({ userIds: [ids.boundaryTarget], roleId: roles.attendancePlain, scope: delegated, executor: client }))
    expect(ok.affectedUserIds).toEqual([ids.boundaryTarget])
    expect(await holds(ids.boundaryTarget, roles.attendancePlain)).toBe(true)
  })

  it('the boundary\'s own code read waits for a concurrent role editor (FOR SHARE) and sees the admin code it committed', async () => {
    const delegated: RoleAssignmentScope = { kind: 'namespaces', namespaces: ['attendance'] }
    const editor = await lockPool.connect()
    let committed = false
    try {
      await editor.query('BEGIN')
      await editor.query('SELECT id FROM roles WHERE id = $1 FOR UPDATE', [roles.attendanceBoundaryRace])
      const pending = transaction((client) => assignUserRoles({
        userIds: [ids.boundaryTarget], roleId: roles.attendanceBoundaryRace, scope: delegated, executor: client,
      })).then(() => null, (thrown: unknown) => thrown)

      let blocked = false
      for (let attempt = 0; attempt < 200 && !blocked; attempt += 1) {
        const waiting = await lockPool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM roles WHERE id = $1 FOR SHARE%'`,
        )
        blocked = (waiting.rows[0]?.n ?? 0) > 0
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(blocked).toBe(true)

      await editor.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roles.attendanceBoundaryRace, 'attendance:admin'])
      await editor.query('COMMIT')
      committed = true

      const error = await pending
      expect(error).toBeInstanceOf(RoleAssignmentForbiddenError)
      expect((error as RoleAssignmentForbiddenError).reason).toBe('admin_equivalent_role')
      expect(await holds(ids.boundaryTarget, roles.attendanceBoundaryRace)).toBe(false)
    } finally {
      if (!committed) await editor.query('ROLLBACK').catch(() => undefined)
      editor.release()
    }
  })

  it('V12 — revoking one namespace\'s main-admin role clears only that namespace\'s audience; another namespace\'s stays', async () => {
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($1, $3)', [ids.multiNamespace, 'attendance_admin', roles.xAdmin])
    for (const namespace of ['attendance', X_NS]) {
      await query(
        'INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by) VALUES ($1, $2, $3, $4)',
        [ids.multiNamespace, namespace, groupId, ids.platformAdmin],
      )
      await query(
        'INSERT INTO delegated_role_admin_scopes (admin_user_id, namespace, directory_department_id, created_by) VALUES ($1, $2, $3, $4)',
        [ids.multiNamespace, namespace, departmentId, ids.platformAdmin],
      )
    }

    const revoke = await api('POST', `/api/admin/users/${ids.multiNamespace}/roles/unassign`, tokens.platformAdmin, { roleId: 'attendance_admin' })

    expect(revoke.status).toBe(200)
    expect(await audience(ids.multiNamespace, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await audience(ids.multiNamespace, X_NS)).toEqual({ departments: 1, groups: 1 })
  })

  it('attendance admin router: all four role writes clear and audit the audience post-commit; a batch appointment leaves a sitting admin\'s audience alone (V5/V10)', async () => {
    const giveAudience = async (userId: string) => {
      await query(
        'INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [userId, 'attendance', groupId, ids.platformAdmin],
      )
    }
    const cleanupAudits = (userId: string) => auditCount('delegated-admin-scope', `${userId}:attendance`, 'revoke')
    const single = (action: 'assign' | 'unassign') =>
      api('POST', `/api/attendance-admin/users/${ids.attendanceSingle}/roles/${action}?scope=global`, tokens.platformAdmin, { template: 'admin' })
    const batch = (action: 'assign' | 'unassign') =>
      api('POST', `/api/attendance-admin/users/batch/roles/${action}?scope=global`, tokens.platformAdmin, {
        template: 'admin', userIds: [ids.attendanceSitting, ids.attendanceFresh],
      })

    // Single assign: a fresh appointment drops audience orphaned by an earlier tenure.
    await giveAudience(ids.attendanceSingle)
    const singleAssign = await single('assign')
    expect(singleAssign.status).toBe(200)
    expect(await holds(ids.attendanceSingle, 'attendance_admin')).toBe(true)
    expect(await audience(ids.attendanceSingle, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await cleanupAudits(ids.attendanceSingle)).toBe(1)
    // Single unassign: the audience configured during the tenure goes with the role.
    await giveAudience(ids.attendanceSingle)
    const singleUnassign = await single('unassign')
    expect(singleUnassign.status).toBe(200)
    expect(await holds(ids.attendanceSingle, 'attendance_admin')).toBe(false)
    expect(await audience(ids.attendanceSingle, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await cleanupAudits(ids.attendanceSingle)).toBe(2)

    // Batch assign: SITTING already holds the role and has a configured audience; FRESH holds an orphan.
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [ids.attendanceSitting, 'attendance_admin'])
    await giveAudience(ids.attendanceSitting)
    await giveAudience(ids.attendanceFresh)
    const batchAssign = await batch('assign')
    expect(batchAssign.status).toBe(200)
    expect(batchAssign.json?.data?.affectedUserIds).toEqual([ids.attendanceFresh])
    expect(await audience(ids.attendanceSitting, 'attendance')).toEqual({ departments: 0, groups: 1 })
    expect(await audience(ids.attendanceFresh, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await cleanupAudits(ids.attendanceSitting)).toBe(0)
    expect(await cleanupAudits(ids.attendanceFresh)).toBe(1)
    // Batch unassign: both lose the role and the audience.
    await giveAudience(ids.attendanceFresh)
    const batchUnassign = await batch('unassign')
    expect(batchUnassign.status).toBe(200)
    expect(await audience(ids.attendanceSitting, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await audience(ids.attendanceFresh, 'attendance')).toEqual({ departments: 0, groups: 0 })
    expect(await cleanupAudits(ids.attendanceSitting)).toBe(1)
    expect(await cleanupAudits(ids.attendanceFresh)).toBe(2)
  })

  it('gate order: an empty body answers 400 (not 401/403) for a delegated attendance_admin on both routes', async () => {
    const role = await api('POST', `/api/admin/role-delegation/users/${ids.target}/roles/assign`, tokens.attendanceDelegate, {})
    expect(role.status).toBe(400)
    expect(role.json?.error?.code).toBe('ROLE_REQUIRED')
    const admission = await api('PATCH', `/api/admin/role-delegation/users/${ids.target}/namespaces/attendance/admission`, tokens.attendanceDelegate, {})
    expect(admission.status).toBe(400)
    expect(admission.json?.error?.code).toBe('ENABLED_REQUIRED')
  })
})
