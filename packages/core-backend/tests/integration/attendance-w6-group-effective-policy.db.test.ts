/**
 * W6-1 (#4556) — group effective-policy aggregate: real-DB integration
 * suite (shared `metasheet_test`/`DATABASE_URL` database, w4c4 harness
 * style — file-namespaced fixture IDs, no isolated schema/database).
 *
 * Governing document:
 *   docs/development/attendance-issue-4556-w6-group-effective-policy-design-lock-20260805.md
 *
 * Covers, against the ACTUAL Express route + real Postgres:
 *  - happy-path exact-key response shapes (fixed_shift effective,
 *    scheduled_shift needs_configuration);
 *  - W6-R1: row counts across every touched table are byte-identical
 *    before/after a full route round-trip;
 *  - W6-R3: cross-org probe, delegated-non-member probe, spoofed
 *    x-org-id probe, platform-admin bypass, missing-org 403, invalid
 *    groupId 400, unknown-group 404 (all before/instead-of scoped SQL);
 *  - W6-R4: the embedded `fixedSchedule` object is byte-identical to a
 *    direct call to the SAME canonical FSER service on the same seeded
 *    data (fidelity proof — one derivation, not a parallel one).
 *
 * The membership-overlap counter (W6-R5) is proved in its OWN dedicated
 * ephemeral-database suite
 * (`attendance-w6-group-effective-policy-membership-overlap.db.test.ts`)
 * because seeding a genuine overlap requires temporarily dropping
 * `attendance_calc_group_memberships_no_overlap`, which must never touch
 * the shared `metasheet_test` database other test files run against.
 *
 * R3 mutation-red evidence (guard-removal) was run manually against this
 * suite and reverted via file backup — NOT part of the committed file;
 * see the W6-1 PR body / report for the transcript.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (dbUrl) process.env.DATABASE_URL = dbUrl
const describeIfDatabase = dbUrl ? describe : describe.skip

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: (resource: string, action: string) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const permission = `${resource}:${action}`
    const user = req.user as { role?: string; permissions?: string[] } | undefined
    if (user?.role === 'admin' || user?.permissions?.includes(permission)) return next()
    return res.status(403).json({ error: 'Insufficient permissions' })
  },
}))

vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return {
    ...actual,
    isAdmin: vi.fn(async () => false),
    listUserPermissions: vi.fn(async () => []),
  }
})

vi.mock('../../src/routes/admin-users', () => ({ ensurePlatformAdmin: vi.fn(async () => null) }))
vi.mock('../../src/services/AttendanceScheduler', () => ({ getSharedAttendanceScheduler: vi.fn(() => null) }))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({ redeliverFailedAttendanceNotification: vi.fn() }))
vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ApprovalDirectoryOrg')>()
  return { ...actual, MAX_MANAGER_CHAIN_LEVELS: 10 }
})

const { attendanceAdminRouter } = await import('../../src/routes/attendance-admin')

describeIfDatabase('W6-1 group effective-policy aggregate route (real PostgreSQL)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const runstamp = randomUUID().slice(0, 8)
  const orgA = `w6agg-a-${runstamp}`
  const orgB = `w6agg-b-${runstamp}`
  const adminUser = randomUUID()
  const memberUser = randomUUID()
  const outsiderUser = randomUUID()
  const nonMemberAdminUser = randomUUID()
  const platformAdminUser = randomUUID()
  const noOrgUser = randomUUID()
  // Claims org A but is ALSO an active member of org B — the sharpest probe
  // for "does a spoofed x-org-id header actually change which org's data is
  // reachable" (a user who merely lacks ANY membership in the spoofed org
  // cannot distinguish "header ignored" from "header honored, membership
  // check correctly rejected the org anyway").
  const dualOrgUser = randomUUID()
  const seededUserIds = [adminUser, memberUser, outsiderUser, nonMemberAdminUser, platformAdminUser, noOrgUser, dualOrgUser]

  const groupAId = randomUUID()
  const groupBId = randomUUID()
  const shiftId = randomUUID()
  const ruleSetId = randomUUID()

  function makeApp(user: { id: string; permissions: string[]; role?: string; orgId?: string }): express.Express {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: unknown }).user = {
        id: user.id,
        permissions: user.permissions,
        role: user.role,
        ...(user.orgId !== undefined ? { orgId: user.orgId } : {}),
      }
      next()
    })
    app.use(attendanceAdminRouter())
    return app
  }

  async function seedUser(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W6-1 fixture', 'x', 'user', '[]'::jsonb,
               true, false, 'activated', now(), now())`,
      [userId, `w6agg-${userId}@example.test`],
    )
  }

  async function seedMembership(userId: string, orgId: string, isActive = true): Promise<void> {
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)', [userId, orgId, isActive])
  }

  beforeAll(async () => {
    for (const userId of seededUserIds) await seedUser(userId)
    await seedMembership(adminUser, orgA)
    await seedMembership(memberUser, orgA)
    await seedMembership(outsiderUser, orgB)
    await seedMembership(dualOrgUser, orgA)
    await seedMembership(dualOrgUser, orgB)
    // nonMemberAdminUser: holds attendance:admin permission but NO active
    // org_A membership row at all (delegated-non-member probe).
    // platformAdminUser: global admin, ALSO no org_A membership row —
    // proves the bypass.
    // noOrgUser: no user_orgs row anywhere, no orgId claim either.

    await pool.query(`INSERT INTO attendance_groups (id, org_id, name, timezone, attendance_type, rule_set_id) VALUES ($1, $2, 'W6 Group A', 'Asia/Shanghai', 'fixed_shift', $3)`, [
      groupAId,
      orgA,
      ruleSetId,
    ])
    await pool.query(`INSERT INTO attendance_groups (id, org_id, name, timezone, attendance_type) VALUES ($1, $2, 'W6 Group B', 'UTC', 'scheduled_shift')`, [groupBId, orgB])

    await pool.query('INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)', [
      orgA,
      groupAId,
      memberUser,
      adminUser,
    ])
    await pool.query('INSERT INTO attendance_group_managers (org_id, group_id, user_id, role) VALUES ($1, $2, $3, $4)', [
      orgA,
      groupAId,
      adminUser,
      'owner',
    ])
    await pool.query('INSERT INTO attendance_rule_sets (id, org_id, name, is_default) VALUES ($1, $2, $3, true)', [
      ruleSetId,
      orgA,
      `w6agg-rule-set-${runstamp}`,
    ])

    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, timezone, flex_mode) VALUES ($1, $2, 'W6 Shift', 'Asia/Shanghai', 'strict')`,
      [shiftId, orgA],
    )
    await pool.query(
      `INSERT INTO attendance_shift_segments (org_id, shift_id, segment_index, start_time, end_time) VALUES ($1, $2, 0, '09:00', '18:00')`,
      [orgA, shiftId],
    )
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-08-01', '2026-08-31', 1, $4)`,
      [orgA, groupAId, shiftId, adminUser],
    )
    // FSER's effectiveness derivation requires a PUBLISHED, matching
    // attendance_shift_assignments row per target member for `effective` —
    // without these the desired config exists but nothing matches it
    // (state `pending_apply`, not `effective`).
    const producerKey = ['attendance_group_fixed_schedule', groupAId, shiftId, '2026-08-01', '2026-08-31'].join(':')
    const producerRunId = randomUUID()
    for (const userId of [memberUser, adminUser]) {
      await pool.query(
        `INSERT INTO attendance_shift_assignments
           (id, org_id, user_id, shift_id, start_date, end_date, is_active, publish_status, producer_type, producer_ref_id, producer_key, producer_run_id)
         VALUES ($1, $2, $3, $4, '2026-08-01', '2026-08-31', true, 'published', 'attendance_group_fixed_schedule', $5, $6, $7)`,
        [randomUUID(), orgA, userId, shiftId, groupAId, producerKey, producerRunId],
      )
    }
  })

  afterAll(async () => {
    await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_fixed_schedule_configs WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_managers WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_members WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_groups WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_shifts WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_rule_sets WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [seededUserIds])
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    await pool.end()
  })

  function adminApp() {
    return makeApp({ id: adminUser, permissions: ['attendance:admin'], orgId: orgA })
  }

  describe('happy path', () => {
    it('returns the exact-key aggregate for the fixed_shift group, values-free', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      const data = res.body.data
      expect(Object.keys(data).sort()).toEqual(
        ['groupId', 'groupType', 'timezone', 'activeMemberCount', 'managerPosture', 'calculationPosture', 'domains', 'conflicts', 'evaluatedAt'].sort(),
      )
      expect(data.groupId).toBe(groupAId)
      expect(data.groupType).toBe('fixed_shift')
      expect(data.timezone).toBe('Asia/Shanghai')
      expect(data.activeMemberCount).toBe(2)
      expect(data.managerPosture).toEqual({ ownerCount: 1, subOwnerCount: 0 })
      expect(data.calculationPosture).toBe('legacy')
      expect(data.domains.membership.label).toBe('effective')
      expect(data.domains.schedule.label).toBe('effective')
      expect(data.domains.schedule.fixedSchedule.state).toBe('effective')
      expect(data.domains.segments.label).toBe('effective')
      expect(data.domains.flex).toEqual({
        label: 'effective',
        mode: 'strict',
        reasonCodes: [],
        editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' },
      })
      expect(data.domains.rules).toEqual({
        label: 'effective',
        source: 'group_rule_set',
        sourceRefs: [{ kind: 'rule_set', id: ruleSetId }],
        reasonCodes: [],
        editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
      })
      expect(data.conflicts).toEqual([])

      // W6-R2: no member list, no raw user id anywhere in the payload.
      const raw = JSON.stringify(res.body)
      expect(raw).not.toContain(memberUser)
      expect(raw).not.toContain(adminUser)
      expect(raw).not.toContain('memberIds')
      expect(raw).not.toContain('userId')
    })

    it('returns needs_configuration for the unconfigured scheduled_shift group (as its own admin)', async () => {
      const app = makeApp({ id: outsiderUser, permissions: ['attendance:admin'], orgId: orgB })
      const res = await request(app).get(`/api/attendance/groups/${groupBId}/effective-policy`)
      expect(res.status).toBe(200)
      const data = res.body.data
      expect(data.groupType).toBe('scheduled_shift')
      expect(data.domains.schedule.label).toBe('needs_configuration')
      expect(data.domains.schedule.reasonCodes).toEqual(['SCHEDULE_STRATEGY_INCOMPLETE'])
      expect(data.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'SCHEDULE_STRATEGY_INCOMPLETE', domain: 'schedule' }),
        ]),
      )
    })
  })

  describe('W6-R1: GET-only, zero writes (behavioral)', () => {
    const TOUCHED_TABLES = [
      'attendance_groups',
      'attendance_group_members',
      'attendance_group_managers',
      'attendance_rule_sets',
      'attendance_shifts',
      'attendance_shift_segments',
      'attendance_group_fixed_schedule_configs',
      'attendance_shift_assignments',
      'attendance_calculation_group_memberships',
      'attendance_calculation_rollout_state',
      'user_orgs',
      'users',
    ]

    async function countRows(): Promise<number[]> {
      return Promise.all(
        TOUCHED_TABLES.map(async (table) => {
          const result = await pool.query(`SELECT count(*)::int AS total FROM ${table}`)
          return result.rows[0].total
        }),
      )
    }

    it('row counts across every touched table are unchanged after a full route round-trip', async () => {
      const before = await countRows()
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)
      const after = await countRows()
      expect(after).toEqual(before)
    })
  })

  describe('W6-R3: authorization precedes every aggregate SQL read', () => {
    it('cross-org probe: org A admin requesting org B group gets the values-free 404 shape', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupBId}/effective-policy`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
    })

    it('delegated-non-member probe: attendance:admin permission WITHOUT active org_A membership is 403', async () => {
      const app = makeApp({ id: nonMemberAdminUser, permissions: ['attendance:admin'], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(403)
      expect(res.body.ok).toBe(false)
    })

    it('spoofed x-org-id probe: a header disagreeing with the authenticated org is rejected 403 BEFORE scoped SQL, regardless of which group is targeted', async () => {
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupBId}/effective-policy`)
        .set('x-org-id', orgB)
      expect(res.status).toBe(403)
      expect(res.body.ok).toBe(false)
    })

    it('spoofed x-org-id probe (mismatch on the caller\'s own accessible group): same 403, never falls through to the group SQL', async () => {
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .set('x-org-id', orgB)
      expect(res.status).toBe(403)
      expect(res.body.ok).toBe(false)
    })

    it('a header that BYTE-EQUALS the authenticated org has no effect (positive control — the check compares, it does not reject any header presence)', async () => {
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .set('x-org-id', orgA)
      expect(res.status).toBe(200)
    })

    it('spoofed x-org-id probe, sharp form: claims org A but is ALSO an active member of org B — a header claiming org B must still 403, proving org identity is not merely "ignored because unreachable" but genuinely never sourced from the header', async () => {
      const app = makeApp({ id: dualOrgUser, permissions: ['attendance:admin'], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupBId}/effective-policy`).set('x-org-id', orgB)
      expect(res.status).toBe(403)
      expect(res.body.ok).toBe(false)
    })

    it('platform-admin bypass: global admin with NO org_A membership row still reaches the aggregate (permission bypass, org identity NOT bypassed)', async () => {
      const app = makeApp({ id: platformAdminUser, permissions: [], role: 'admin', orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)
    })

    it('missing authenticated org: 403 before any scoped SQL', async () => {
      const app = makeApp({ id: noOrgUser, permissions: ['attendance:admin'] })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Authenticated organization not found', details: undefined } })
    })

    it('unknown groupId in the caller\'s own org shares the same 404 shape as cross-org', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${randomUUID()}/effective-policy`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
    })

    it('no attendance:admin permission: 403 before any org/group resolution', async () => {
      const app = makeApp({ id: memberUser, permissions: [], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(403)
    })
  })

  describe('W6-R6/R7: enum-strict, zero client-supplied state', () => {
    it('invalid groupId format is rejected 400 before any group SQL', async () => {
      const res = await request(adminApp()).get('/api/attendance/groups/not-a-uuid/effective-policy')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('GROUP_ID_INVALID')
    })

    it('any query parameter is rejected 400 before SQL (R7 — no state-selecting input accepted)', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?label=effective`)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('QUERY_NOT_ACCEPTED')
    })

    it('a JSON body is rejected 400 before SQL (R7)', async () => {
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .send({ domains: { membership: { label: 'effective' } } })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('BODY_NOT_ACCEPTED')
    })
  })

  describe('W6-R4: FSER fidelity (one derivation)', () => {
    it('the embedded fixedSchedule object is byte-identical to a direct call to the canonical FSER service on the same data', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const fserLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs') as {
        createAttendanceGroupFixedScheduleEffectivenessService: (deps: {
          HttpError: new (status: number, code: string, message: string) => Error
          buildAttendanceGroupFixedScheduleProducerKey: (input: { groupId: string; shiftId: string; startDate: string; endDate: string | null }) => string
          now: () => string
        }) => { getEffectiveness: (db: unknown, input: { orgId: string; groupId: string }) => Promise<Record<string, unknown>> }
      }
      const frozenNow = '2026-08-08T00:00:00.000Z'
      class TestHttpError extends Error {
        constructor(public status: number, public code: string, message: string) {
          super(message)
        }
      }
      const directFser = fserLib.createAttendanceGroupFixedScheduleEffectivenessService({
        HttpError: TestHttpError,
        buildAttendanceGroupFixedScheduleProducerKey: (input) =>
          ['attendance_group_fixed_schedule', input.groupId, input.shiftId, input.startDate, input.endDate ?? 'null'].join(':'),
        now: () => frozenNow,
      })
      const dbAdapter = { query: async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows }
      const direct = await directFser.getEffectiveness(dbAdapter, { orgId: orgA, groupId: groupAId })
      const { groupId: _drop, ...directEmbed } = direct

      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)
      const routeEmbed = { ...res.body.data.domains.schedule.fixedSchedule }
      // evaluatedAt differs by wall-clock instant between the two independent
      // calls; every OTHER field must be byte-identical.
      delete (routeEmbed as Record<string, unknown>).evaluatedAt
      delete (directEmbed as Record<string, unknown>).evaluatedAt
      expect(routeEmbed).toStrictEqual(directEmbed)
    })
  })
})
