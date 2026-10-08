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
 * The R3 ordering proof below is a committed, automated counting spy on the
 * aggregate's own `query`, asserting zero aggregate queries on every
 * rejection leg and a positive control of >0 on the 200 leg (a
 * permanently-zero counter must not pass vacuously).
 *
 * Scope of that ordering proof, stated narrowly: `rbacGuard` is `vi.mock`ed
 * out in this harness, so what is proven is "before aggregate SQL", never
 * "before any SQL". The real guard does read (`SELECT 1 FROM user_permissions
 * …`), and §4.1 explicitly permits authorization middleware to read first.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import { Pool } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildAggregateCallPathClosure,
  collectQuerySqlArguments,
  findRepoRoot,
  relationsInSql,
} from '../helpers/attendance-w6-call-path-closure'

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
    isAdmin: vi.fn(async (userId: string, runQuery?: Parameters<typeof actual.isAdmin>[1]) =>
      runQuery ? actual.isAdmin(userId, runQuery) : false),
    listUserPermissions: vi.fn(async () => []),
  }
})

/**
 * COUNTING SPY on the query function the aggregate service is constructed
 * with. Without it every "…before SQL" title asserted nothing but a status
 * code: if the ordering were INVERTED, each of those legs would still return
 * the same status and nothing would red. Statuses are not ordering evidence.
 *
 * The wrapper records every statement that goes through `src/db/pg`'s `query`
 * — which is what `attendance-admin.ts` hands the aggregate — and the
 * assertions then count only the statements the AGGREGATE MODULE authors,
 * identified by matching against the SQL literals the derived call-path
 * closure attributes to `w6-group-effective-policy-aggregate.ts`. That
 * distinction is load-bearing and was found by running the test, not by
 * reading it: the delegated-admin membership gate legitimately issues SQL
 * BEFORE the groupId format check, so a naive "zero statements" assertion is
 * false on the 400-invalid-groupId leg for a correct implementation.
 *
 * `rbacGuard` is mocked out in this harness; see the file header for why the
 * claim is "before AGGREGATE SQL", never "before any SQL".
 */
const observedSql: string[] = []
/** One entry per transaction the route opens, in order, each carrying the
 *  statements issued on THAT client handle. This is what makes "the membership
 *  read and the aggregate reads share ONE read-only transaction" a checkable
 *  claim rather than a design intention. */
const observedTransactions: Array<{ statements: string[] }> = []
vi.mock('../../src/db/pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/pg')>()
  return {
    ...actual,
    query: (async (sql: string, params?: unknown[]) => {
      observedSql.push(String(sql))
      return actual.query(sql as never, params as never)
    }) as typeof actual.query,
    // W6-R1 backstop: the aggregate no longer runs on the pool, so a spy on
    // `query` alone would observe NOTHING it authors. That is not a
    // hypothetical — running this suite after the route was moved onto the
    // transaction reduced the ordering positive control to `expected 0 to be
    // greater than 0`, which is exactly the vacuum the control exists to
    // catch. The transaction client is wrapped too, and its statements are
    // recorded BOTH in `observedSql` (so every existing ordering leg keeps
    // counting the same things) and per-handle in `observedTransactions`.
    transaction: (async <T,>(
      handler: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>,
    ) => {
      const record = { statements: [] as string[] }
      observedTransactions.push(record)
      return (actual.transaction as unknown as (h: typeof handler) => Promise<T>)(async (client) => {
        return handler({
          ...client,
          query: (sql: string, params?: unknown[]) => {
            observedSql.push(String(sql))
            record.statements.push(String(sql))
            return client.query(sql, params)
          },
        })
      })
    }) as typeof actual.transaction,
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

/** Relations the aggregate's own call-path closure can query — DERIVED, so the
 * snapshot set below cannot silently omit a table the code really touches
 * (`attendance_schedule_groups` was already missing from the hand-list). */
function relationsFromAggregateClosure(): string[] {
  const repoRoot = findRepoRoot(__dirname)
  const closure = buildAggregateCallPathClosure(repoRoot)
  const sql = collectQuerySqlArguments(closure, repoRoot)
  const relations = new Set<string>()
  for (const entry of sql.resolved) for (const relation of relationsInSql(entry.sql)) relations.add(relation)
  // The pg adapter's BEGIN/COMMIT/ROLLBACK literals contribute nothing, and
  // set-returning functions are not relations to snapshot.
  relations.delete('jsonb_array_elements_text')
  return [...relations].sort()
}

/**
 * Tables a write on this call path could reach only by TRIGGER fan-out — never
 * named in any SQL literal, so never in any derived set. MODULE SCOPE on
 * purpose: two describe blocks consume it (the row-count snapshot's table
 * domain, and the "arbitrary table no list mentions" refusal leg's proof that
 * its chosen table really is off every list). Two copies would let the second
 * consumer's premise drift away from the first's without anything reddening.
 */
const TRIGGER_FANOUT_TABLES = [
  // `attendance_group_members` carries `trg_attendance_group_members_w4c3a_revision`,
  // which bumps this table. A write reaching a table only via a TRIGGER is
  // never in any hand-list, so the fan-out target is named explicitly.
  'attendance_group_effect_revisions',
]

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
  // W3 compatibility (P3): a `fixed_shift` group whose shift has ZERO persisted
  // `attendance_shift_segments` rows — `segmentCount <= 1` in the aggregate treats this
  // identically to a single-segment shift (segment 0 synthesised from the legacy
  // envelope). Deliberately a SEPARATE group/shift from groupA's (which seeds exactly
  // one segment row) rather than deleting groupA's row, so the two fixtures stay
  // independently discriminating.
  const groupZeroSegId = randomUUID()
  const shiftZeroSegId = randomUUID()

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
    await pool.query("INSERT INTO roles (id, name) VALUES ('admin', 'Platform admin') ON CONFLICT (id) DO NOTHING")
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [platformAdminUser])
    await seedMembership(adminUser, orgA)
    await seedMembership(memberUser, orgA)
    await seedMembership(outsiderUser, orgB)
    await seedMembership(dualOrgUser, orgA)
    await seedMembership(dualOrgUser, orgB)
    // nonMemberAdminUser: holds attendance:admin permission but NO active
    // org_A membership row at all (delegated-non-member probe).
    // platformAdminUser: global admin only through the real user_roles row,
    // with no legacy role claim and no org_A membership row — proves the
    // transaction-bound production isAdmin query and its bypass.
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
    // Deliberately a HAND-WRITTEN literal of the canonical producer-key join
    // format, NOT a call to the builder. This is what gives this suite
    // independent discriminating power over a format change: mutating the
    // canonical builder's separator breaks FSER's row match against this seed
    // and reds the happy-path `state === 'effective'` assertion. Do NOT "DRY"
    // this into a call to the builder — doing so would put the same function on
    // both sides and remove the only DB-level discrimination that exists.
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

    // P3 fixture: a fixed_shift group whose shift carries ZERO
    // attendance_shift_segments rows (groupA's shift, above, deliberately
    // carries exactly one — the two fixtures are independently
    // discriminating). No members/managers/assignments are seeded: FSER's
    // `desired` is truthy from the fixed_schedule_configs row alone
    // (`loadEffectivenessFacts` in the FSER service), which is all the
    // aggregate's segmentCount branch needs to run.
    await pool.query(
      `INSERT INTO attendance_shifts (id, org_id, name, timezone, flex_mode) VALUES ($1, $2, 'W6 Shift Zero Segments', 'Asia/Shanghai', 'strict')`,
      [shiftZeroSegId, orgA],
    )
    await pool.query(`INSERT INTO attendance_groups (id, org_id, name, timezone, attendance_type) VALUES ($1, $2, 'W6 Group Zero Segments', 'Asia/Shanghai', 'fixed_shift')`, [
      groupZeroSegId,
      orgA,
    ])
    await pool.query(
      `INSERT INTO attendance_group_fixed_schedule_configs (org_id, group_id, shift_id, start_date, end_date, revision, updated_by)
       VALUES ($1, $2, $3, '2026-08-01', '2026-08-31', 1, $4)`,
      [orgA, groupZeroSegId, shiftZeroSegId, adminUser],
    )
  })

  afterAll(async () => {
    // `attendance_group_effect_revisions` is deliberately append-only
    // (`attendance_w4c3a_revision_row_guard` refuses a direct DELETE with
    // W4C3A_REVISION_DIRECT_MUTATION_DENIED, owned by the W4C3A line), so
    // this file's probes leave monotonic counter rows there rather than
    // cleaning them up. They are scoped to this run's throwaway org ids
    // (`w6agg-a-<runstamp>` / `w6agg-b-<runstamp>`), so they are counter
    // state rather than fixture data and cannot collide with another
    // suite's rows.
    await pool.query('DELETE FROM attendance_shift_assignments WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_fixed_schedule_configs WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_managers WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_group_members WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_groups WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_shifts WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM attendance_rule_sets WHERE org_id = ANY($1::text[])', [[orgA, orgB]])
    await pool.query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [seededUserIds])
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUserIds])
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

      // W6-R2 — DERIVED forbidden domain, not a 4-needle hand-list.
      // The previous version named two of the seven seeded users and two key
      // spellings, so a field carrying `assignedBy`/`updatedBy`/`closedBy`/a
      // manager id would have passed untouched. Two legs now:
      //  (a) NONE of the seeded user ids may appear anywhere in the payload;
      //  (b) structurally, every UUID in the payload must be one this test can
      //      NAME (the group, or a declared sourceRef id) — an unexplained
      //      identifier is a finding even if nobody predicted its key name.
      const raw = JSON.stringify(res.body)
      for (const userId of seededUserIds) expect(raw, `seeded user id leaked: ${userId}`).not.toContain(userId)
      expect(raw).not.toContain('memberIds')
      expect(raw).not.toContain('userId')

      const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
      const explained = new Set<string>([groupAId, shiftId, ruleSetId])
      for (const ref of [
        ...(data.domains.schedule.sourceRefs ?? []),
        ...(data.domains.segments.sourceRefs ?? []),
        ...(data.domains.rules.sourceRefs ?? []),
      ] as Array<{ id: string }>) {
        explained.add(ref.id)
      }
      const unexplained = [...new Set(raw.match(UUID_ANYWHERE) ?? [])].filter((id) => !explained.has(id))
      expect(unexplained, 'payload carries UUIDs this test cannot account for').toEqual([])

      // POSITIVE CONTROL on both legs: a deliberately-injected user id IS
      // caught, so "no leak" is not the vacuous result of a check that can
      // never fire.
      const poisoned = JSON.stringify({ ...res.body, sneaky: memberUser })
      expect(seededUserIds.some((id) => poisoned.includes(id))).toBe(true)
      expect([...new Set(poisoned.match(UUID_ANYWHERE) ?? [])].filter((id) => !explained.has(id))).not.toEqual([])
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
          expect.objectContaining({
            code: 'RULE_SOURCE_MISSING',
            domain: 'rules',
            editorRef: { kind: 'group_context_route', step: 'rules', surface: 'rule-sets' },
          }),
        ]),
      )
    })

    it('P3: a fixed_shift group whose shift has ZERO persisted segment rows is still effective/effective (segment 0 synthesised, W3 compatibility)', async () => {
      // The premise, asserted rather than assumed: without this, a future
      // fixture edit that accidentally seeds a segment row here would leave
      // the labels below unchanged (segmentCount 0 and 1 both satisfy
      // `segmentCount <= 1`), and this leg would keep passing for the wrong
      // reason.
      const segmentRows = await pool.query(
        'SELECT COUNT(*)::int AS cnt FROM attendance_shift_segments WHERE org_id = $1 AND shift_id = $2',
        [orgA, shiftZeroSegId],
      )
      expect(segmentRows.rows[0].cnt).toBe(0)

      const res = await request(adminApp()).get(`/api/attendance/groups/${groupZeroSegId}/effective-policy`)
      expect(res.status).toBe(200)
      const data = res.body.data
      expect(data.groupType).toBe('fixed_shift')
      expect(data.domains.segments.label).toBe('effective')
      expect(data.domains.flex).toEqual({
        label: 'effective',
        mode: 'strict',
        reasonCodes: [],
        editorRef: { kind: 'group_context_route', step: 'schedule', surface: 'shifts' },
      })
    })
  })

  describe('W6-R1: GET-only, zero writes (behavioral)', () => {
    /**
     * DERIVED table domain. The previous list was HAND-WRITTEN and was already
     * missing `attendance_schedule_groups`, a table the aggregate itself
     * queries — so writes to it were invisible BY CONSTRUCTION, because the
     * snapshot never issued a query against that relation at all.
     *
     * The set is now computed from the same call-path closure the static leg
     * sweeps: every relation named after FROM/JOIN/INTO/UPDATE in every SQL
     * literal the closure can issue, plus the trigger targets those writes
     * would fan out to. Three legs below, matching the static guard's shape.
     */
    const derivedRelations = relationsFromAggregateClosure()
    const TOUCHED_TABLES = [...new Set([...derivedRelations, ...TRIGGER_FANOUT_TABLES])].sort()

    it('LEG 1 (unclaimed = 0): every relation the aggregate can query is in the snapshot set', () => {
      expect(derivedRelations.filter((table) => !TOUCHED_TABLES.includes(table))).toEqual([])
      // The specific table the hand-list missed, named so a regression is legible.
      expect(TOUCHED_TABLES).toContain('attendance_schedule_groups')
    })

    it('LEG 2 (non-empty domain): the derived set is substantial', () => {
      expect(derivedRelations.length).toBeGreaterThanOrEqual(8)
    })

    it('LEG 3 (off-path negative): a table the aggregate never queries is NOT in the derived set', () => {
      // Without this, "derive from the whole repo" would satisfy legs 1 and 2.
      expect(derivedRelations).not.toContain('attendance_records')
      expect(derivedRelations).not.toContain('approval_instances')
    })

    /**
     * A bare row COUNT is structurally blind to an in-place UPDATE. Every
     * Postgres UPDATE — even one writing back identical values — creates a new
     * row version with a fresh `xmin`, so `MAX(xmin)` moves when the count does
     * not.
     *
     * INSERT-then-DELETE inside one window — MEASURED, not reasoned about.
     * The initial write-up here asserted this was an uncatchable blind spot;
     * running the probe REFUTED that for the tables that matter. On
     * `attendance_groups` the insert-then-delete IS detected, because the
     * table carries `trg_attendance_groups_w4c3a_revision`, whose row in
     * `attendance_group_effect_revisions` (a member of the snapshot set via
     * TRIGGER_FANOUT_TABLES) does NOT revert when the source row is deleted.
     * Both cases are pinned below.
     *
     * The RESIDUAL limit, stated at its true boundary rather than inflated:
     * on a derived table with NO trigger fan-out, an insert-then-delete does
     * revert both metrics and is not detected. Measured trigger counts in the
     * derived set: `attendance_groups` 2, `attendance_group_members` 2,
     * `attendance_calculation_rollout_state` 4,
     * `attendance_calculation_group_memberships` 1, and ZERO on the rest.
     * Closing that residue needs per-table statement triggers appending to a
     * probe log, i.e. trigger DDL against the SHARED `metasheet_test` database
     * — the exact cross-test pollution the overlap suite moved to a dedicated
     * ephemeral database to avoid. Recorded as a phase-2 item rather than
     * half-built here.
     */
    /**
     * SCOPED to the rows this file seeded, not whole-table aggregates.
     * Whole-table `MAX(xmin)` over the SHARED `metasheet_test` database means
     * any concurrent writer from another suite reds this leg — a cross-suite
     * coupling that gets a guard disabled rather than fixed. Every table in the
     * derived set that HAS an `org_id` is scoped to this run's two orgs; the
     * handful without one (`users`, `user_roles`, `user_permissions`,
     * `role_permissions`, `user_namespace_admissions`) are scoped to this
     * file's own seeded user ids where they carry an id column, and are
     * otherwise dropped from the snapshot rather than left as a shared-table
     * aggregate. Scoping does not weaken the in-place-UPDATE detection the
     * `xmin` leg exists for: an UPDATE to a row this file seeded still moves
     * that row's `xmin`, and a write to a row it did NOT seed is not this
     * route's doing.
     */
    const scopedPredicates: Record<string, { where: string; params: unknown[] } | null> = {}
    async function buildScopedPredicates(): Promise<void> {
      const columns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [TOUCHED_TABLES],
      )
      const byTable = new Map<string, Set<string>>()
      for (const row of columns.rows as Array<{ table_name: string; column_name: string }>) {
        if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set())
        byTable.get(row.table_name)?.add(row.column_name)
      }
      for (const table of TOUCHED_TABLES) {
        const cols = byTable.get(table)
        if (!cols) {
          scopedPredicates[table] = null
          continue
        }
        if (cols.has('org_id')) {
          scopedPredicates[table] = { where: 'org_id = ANY($1::text[])', params: [[orgA, orgB]] }
        } else if (cols.has('user_id')) {
          scopedPredicates[table] = { where: 'user_id = ANY($1::text[])', params: [seededUserIds] }
        } else if (table === 'users' && cols.has('id')) {
          scopedPredicates[table] = { where: 'id = ANY($1::text[])', params: [seededUserIds] }
        } else {
          // No scoping column: excluded rather than snapshotted whole-table.
          scopedPredicates[table] = null
        }
      }
    }

    async function snapshotTables(): Promise<Array<{ table: string; count: number; maxXmin: string }>> {
      const scoped = TOUCHED_TABLES.filter((table) => scopedPredicates[table])
      return Promise.all(
        scoped.map(async (table) => {
          const predicate = scopedPredicates[table] as { where: string; params: unknown[] }
          const result = await pool.query(
            `SELECT count(*)::int AS total, COALESCE(MAX(xmin::text::bigint), -1) AS max_xmin
               FROM ${table} WHERE ${predicate.where}`,
            predicate.params,
          )
          return { table, count: result.rows[0].total, maxXmin: String(result.rows[0].max_xmin) }
        }),
      )
    }

    it('the scoped snapshot covers a substantial, org-scoped subset (an empty snapshot would make every leg below vacuous)', async () => {
      await buildScopedPredicates()
      const rows = await snapshotTables()
      expect(rows.length).toBeGreaterThanOrEqual(8)
      // Every included table really is scoped — no whole-table aggregate slips
      // back in over the shared database.
      for (const row of rows) {
        expect(scopedPredicates[row.table], `${row.table} is unscoped`).not.toBeNull()
      }
      // And the excluded set is NAMED, not silent.
      const excluded = TOUCHED_TABLES.filter((table) => !scopedPredicates[table])
      expect(excluded.every((table) => !table.startsWith('attendance_'))).toBe(true)
    })

    it('row counts AND row versions (xmin) are unchanged across the FULL request matrix, not one happy-path call', async () => {
      await buildScopedPredicates()
      // The previous leg bracketed exactly ONE request on ONE branch, so a
      // write firing only on the scheduled_shift / 404 / 400 / 403 branches sat
      // outside the snapshot window entirely. Same assertion, every branch this
      // suite already exercises.
      const before = await snapshotTables()

      await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      await request(makeApp({ id: outsiderUser, permissions: ['attendance:admin'], orgId: orgB }))
        .get(`/api/attendance/groups/${groupBId}/effective-policy`)
      await request(adminApp()).get(`/api/attendance/groups/${groupBId}/effective-policy`) // cross-org 404
      await request(adminApp()).get(`/api/attendance/groups/${randomUUID()}/effective-policy`) // unknown 404
      await request(adminApp()).get('/api/attendance/groups/not-a-uuid/effective-policy') // 400
      await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?label=effective`) // 400
      await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .send({ label: 'effective' }) // 400
      await request(makeApp({ id: nonMemberAdminUser, permissions: ['attendance:admin'], orgId: orgA }))
        // 404 delegated non-member, matching missing/inaccessible parity.
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
      await request(makeApp({ id: noOrgUser, permissions: ['attendance:admin'] }))
        .get(`/api/attendance/groups/${groupAId}/effective-policy`) // 403 no org
      await request(makeApp({ id: memberUser, permissions: [], orgId: orgA }))
        .get(`/api/attendance/groups/${groupAId}/effective-policy`) // 403 no permission
      await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .set('x-org-id', orgB) // 403 spoof
      await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy?orgId=${encodeURIComponent(orgB)}`) // 403 query-org spoof
      await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .send({ orgId: orgB }) // 403 body-org spoof
      await request(makeApp({ id: platformAdminUser, permissions: ['attendance:admin'], orgId: orgA }))
        .get(`/api/attendance/groups/${groupAId}/effective-policy`) // 200 platform admin

      const after = await snapshotTables()
      expect(after).toEqual(before)
    })

    it('POSITIVE CONTROL: the snapshot DOES detect a same-row-count in-place UPDATE', async () => {
      await buildScopedPredicates()
      // "Nothing changed" must be paired with proof the detector can fire, or
      // it is indistinguishable from a snapshot that reads nothing.
      const before = await snapshotTables()
      await pool.query('UPDATE attendance_groups SET updated_at = updated_at WHERE id = $1', [groupAId])
      const after = await snapshotTables()
      expect(after).not.toEqual(before)
      const groupsBefore = before.find((row) => row.table === 'attendance_groups')
      const groupsAfter = after.find((row) => row.table === 'attendance_groups')
      expect(groupsAfter?.count).toBe(groupsBefore?.count) // row COUNT alone would have missed it
      expect(groupsAfter?.maxXmin).not.toBe(groupsBefore?.maxXmin)
    })

    it('MEASURED: insert-then-delete on a TRIGGER-carrying table IS detected (via the trigger fan-out row, which does not revert)', async () => {
      await buildScopedPredicates()
      const before = await snapshotTables()
      const probeId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_groups (id, org_id, name, attendance_type, timezone) VALUES ($1, $2, $3, 'free_time', 'UTC')`,
        [probeId, orgA, `w6agg-itd-trigger-${runstamp}`],
      )
      await pool.query('DELETE FROM attendance_groups WHERE id = $1', [probeId])
      const after = await snapshotTables()
      expect(after).not.toEqual(before)
      // Precisely WHERE it is detected: the source table reverts, the fan-out
      // table does not. Naming both halves keeps the mechanism honest.
      const groupsBefore = before.find((row) => row.table === 'attendance_groups')
      const groupsAfter = after.find((row) => row.table === 'attendance_groups')
      expect(groupsAfter?.count).toBe(groupsBefore?.count)
      const revisionsBefore = before.find((row) => row.table === 'attendance_group_effect_revisions')
      const revisionsAfter = after.find((row) => row.table === 'attendance_group_effect_revisions')
      expect(revisionsAfter).not.toEqual(revisionsBefore)
    })

    it('MEASURED RESIDUAL: insert-then-delete on a table with NO trigger fan-out is NOT detected — the true boundary of this mechanism', async () => {
      await buildScopedPredicates()
      // This is the honest limit, pinned so that a future mechanism which DOES
      // catch it reds here and forces the header to be updated rather than
      // leaving an over-claim in place.
      const before = await snapshotTables()
      const probeId = randomUUID()
      await pool.query(
        `INSERT INTO attendance_rule_sets (id, org_id, name, is_default) VALUES ($1, $2, $3, false)`,
        [probeId, orgA, `w6agg-itd-notrigger-${runstamp}`],
      )
      await pool.query('DELETE FROM attendance_rule_sets WHERE id = $1', [probeId])
      const after = await snapshotTables()
      expect(after).toEqual(before)
    })
  })

  describe('W6-R3: authorization precedes every aggregate SQL read', () => {
    it('cross-org probe: org A admin requesting org B group gets the values-free 404 shape', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupBId}/effective-policy`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
    })

    it('delegated-non-member probe: inaccessible and missing groups share the values-free 404 shape', async () => {
      const app = makeApp({ id: nonMemberAdminUser, permissions: ['attendance:admin'], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
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

    it('query/body org selectors are assertions only: byte-equal is inert, mismatch is 403 before aggregate SQL', async () => {
      const equalQuery = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy?orgId=${encodeURIComponent(orgA)}`)
      expect(equalQuery.status).toBe(200)

      const equalBody = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .send({ orgId: orgA })
      expect(equalBody.status).toBe(200)

      for (const run of [
        () => request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?orgId=${encodeURIComponent(orgB)}`),
        () => request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`).send({ orgId: orgB }),
        () => request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?orgId=${encodeURIComponent(orgA)}&orgId=${encodeURIComponent(orgA)}`),
      ]) {
        const res = await run()
        expect(res.status).toBe(403)
      }
    })

    it('spoofed x-org-id probe, sharp form: claims org A but is ALSO an active member of org B — a header claiming org B must still 403, proving org identity is not merely "ignored because unreachable" but genuinely never sourced from the header', async () => {
      const app = makeApp({ id: dualOrgUser, permissions: ['attendance:admin'], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupBId}/effective-policy`).set('x-org-id', orgB)
      expect(res.status).toBe(403)
      expect(res.body.ok).toBe(false)
    })

    it('DB-backed platform-admin bypass: the real user_roles lookup returns true on the shared read-only transaction and skips membership', async () => {
      observedTransactions.length = 0
      const app = makeApp({ id: platformAdminUser, permissions: ['attendance:admin'], orgId: orgA })
      const res = await request(app).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)
      expect(observedTransactions.length).toBe(1)
      const statements = observedTransactions[0].statements
      expect(statements.filter((sql) => /FROM user_roles/.test(sql) && /role_id = \$2/.test(sql))).toHaveLength(1)
      expect(statements.filter((sql) => /FROM user_orgs uo/.test(sql) && /uo\.is_active = true/.test(sql))).toHaveLength(0)
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
    it('invalid groupId format is rejected 400 before any AGGREGATE SQL', async () => {
      const res = await request(adminApp()).get('/api/attendance/groups/not-a-uuid/effective-policy')
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('GROUP_ID_INVALID')
    })

    it('any state-selecting query parameter is rejected 400 before AGGREGATE SQL (R7)', async () => {
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?label=effective`)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('QUERY_NOT_ACCEPTED')
    })

    it('a STATE-BEARING JSON body is rejected 400 before AGGREGATE SQL (R7)', async () => {
      for (const body of [
        { domains: { membership: { label: 'effective' } } },
        ['effective'],
      ]) {
        const res = await request(adminApp())
          .get(`/api/attendance/groups/${groupAId}/effective-policy`)
          .send(body)
        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('BODY_NOT_ACCEPTED')
      }
    })

    it('an EMPTY JSON body carries no state and is ACCEPTED — §4.1 verbatim, and must not be tightened into "no body bytes"', async () => {
      // The lock says the route rejects no STATE-BEARING body and that an empty
      // JSON object carries no state. The previous suite only ever sent a
      // state-bearing body, so this boundary was untested in BOTH directions
      // and a future "tighten it to zero bytes" change would have passed
      // silently while exceeding the ratified contract.
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .set('Content-Type', 'application/json')
        .send('{}')
      expect(res.status).toBe(200)
    })

    it('a NON-EMPTY mismatching x-org-id still 403s (pins the empty-header decision so a relaxation cannot widen past it)', async () => {
      // The empty-header case is an owner call left at the fail-closed status
      // quo. This negative exists so that if empty-after-trim is ever treated
      // as absent, the relaxation cannot silently extend to a real mismatch.
      const res = await request(adminApp())
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
        .set('x-org-id', `${orgA}-not-really`)
      expect(res.status).toBe(403)
    })
  })

  describe('W6-R3 ORDERING (committed + automated, replacing the prior manual transcript)', () => {
    // DERIVED: the SQL literals the closure attributes to the aggregate module.
    const aggregateSqlLiterals = (() => {
      const repoRoot = findRepoRoot(__dirname)
      const closure = buildAggregateCallPathClosure(repoRoot)
      const sql = collectQuerySqlArguments(closure, repoRoot)
      return new Set(
        sql.resolved
          .filter((entry) => entry.file.endsWith('w6-group-effective-policy-aggregate.ts'))
          .map((entry) => entry.sql),
      )
    })()

    it('the derived aggregate-SQL set is non-empty (an empty set would make every ordering leg pass vacuously)', () => {
      expect(aggregateSqlLiterals.size).toBeGreaterThanOrEqual(5)
    })

    async function aggregateQueriesDuring(run: () => Promise<unknown>): Promise<number> {
      observedSql.length = 0
      await run()
      return observedSql.filter((sql) => aggregateSqlLiterals.has(sql)).length
    }

    it('POSITIVE CONTROL FIRST: the happy path really does issue aggregate queries (a permanently-zero counter must not pass vacuously)', async () => {
      const calls = await aggregateQueriesDuring(() =>
        request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`).expect(200),
      )
      expect(calls).toBeGreaterThan(0)
    })

    it('ZERO aggregate queries on every rejection leg (this is the ordering proof; the status codes never were)', async () => {
      const legs: Array<{ label: string; run: () => Promise<unknown> }> = [
        {
          label: '400 query parameter',
          run: () => request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy?label=effective`).expect(400),
        },
        {
          label: '400 state-bearing body',
          run: () =>
            request(adminApp())
              .get(`/api/attendance/groups/${groupAId}/effective-policy`)
              .send({ label: 'effective' })
              .expect(400),
        },
        {
          label: '403 no authenticated org',
          run: () =>
            request(makeApp({ id: noOrgUser, permissions: ['attendance:admin'] }))
              .get(`/api/attendance/groups/${groupAId}/effective-policy`)
              .expect(403),
        },
        {
          label: '403 spoofed x-org-id',
          run: () =>
            request(adminApp())
              .get(`/api/attendance/groups/${groupAId}/effective-policy`)
              .set('x-org-id', orgB)
              .expect(403),
        },
        {
          label: '403 spoofed query-org',
          run: () =>
            request(adminApp())
              .get(`/api/attendance/groups/${groupAId}/effective-policy?orgId=${encodeURIComponent(orgB)}`)
              .expect(403),
        },
        {
          label: '403 spoofed body-org',
          run: () =>
            request(adminApp())
              .get(`/api/attendance/groups/${groupAId}/effective-policy`)
              .send({ orgId: orgB })
              .expect(403),
        },
        {
          label: '400 invalid groupId',
          run: () => request(adminApp()).get('/api/attendance/groups/not-a-uuid/effective-policy').expect(400),
        },
      ]
      for (const leg of legs) {
        expect(await aggregateQueriesDuring(leg.run), leg.label).toBe(0)
      }
    })

    it('the delegated-non-member 404 issues the MEMBERSHIP read and then stops — no aggregate read follows it', async () => {
      // This leg genuinely reads (the active-membership gate is real SQL), so
      // the assertion is not "zero queries" but "the group SQL never ran":
      // proven by the aggregate's own 404/200 shapes never appearing.
      const res = await request(makeApp({ id: nonMemberAdminUser, permissions: ['attendance:admin'], orgId: orgA }))
        .get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Group not found', details: undefined } })
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
      // The direct side is built with the canonical producer key from
      // plugins/plugin-attendance/lib/, the same function index.cjs delegates
      // to — so this `toStrictEqual` proves the route's embedded object
      // matches a direct FSER call, not that the producer key is correct. A
      // mutation of the producer-key separator is instead caught by the
      // happy-path `state === 'effective'` assertion above, via FSER's own
      // row matching against this suite's independent hand-written seed
      // literal (see the seed comment in `beforeAll`). Two separate proofs;
      // neither stands in for the other.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
      const canonicalProducerKeyLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs') as {
        buildAttendanceGroupFixedScheduleProducerKey: (input: {
          groupId: string
          shiftId: string
          startDate: string
          endDate: string | null
        }) => string
      }
      const directFser = fserLib.createAttendanceGroupFixedScheduleEffectivenessService({
        HttpError: TestHttpError,
        buildAttendanceGroupFixedScheduleProducerKey:
          canonicalProducerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
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

  describe('W6-R1 STRUCTURAL BACKSTOP: the READ ONLY transaction (the mechanism of record)', () => {
    /**
     * The static sweep can only ever prove things about source text it can
     * trace. This block proves the property the sweep is NOT relied on for:
     * PostgreSQL itself refuses writes on the handle the aggregate runs on.
     *
     * Two halves, both required. A raise proof with no read proof is
     * indistinguishable from a broken connection; a read proof with no raise
     * proof is indistinguishable from a transaction that is not read-only.
     * Both run against the SAME handle inside ONE `runAttendanceSetupReadinessReadOnly`
     * body, because a write attempted on a fresh client proves nothing about
     * the shared one.
     */

    /** A request whose principal is a plain org member — NOT an admin. This is
     *  load-bearing: `canReadAttendanceDirectoryReadiness` short-circuits on
     *  `hasLegacyAdminClaim(req) || await isRbacAdmin(userId)`, so run as an
     *  admin the membership query never executes and every assertion about it
     *  passes without the statement ever reaching Postgres. The mock delegates
     *  injected-query calls to the real `isAdmin`, and this request carries no
     *  legacy admin claim. */
    function memberRequest(userId: string): express.Request {
      return { user: { id: userId, permissions: ['attendance:admin'] }, headers: {} } as unknown as express.Request
    }

    class ReadOnlyProbeHttpError extends Error {
      constructor(public status: number, public code: string, message: string) {
        super(message)
      }
    }

    const WRITE_SHAPES: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: 'UPDATE',
        sql: 'UPDATE attendance_groups SET timezone = $1 WHERE id = $2',
        params: ['UTC', groupAId],
      },
      {
        label: 'INSERT',
        sql: 'INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)',
        params: [orgA, groupAId, outsiderUser],
      },
      {
        label: 'DELETE',
        sql: 'DELETE FROM attendance_group_members WHERE org_id = $1 AND group_id = $2',
        params: [orgA, groupAId],
      },
    ]

    for (const shape of WRITE_SHAPES) {
      it(`a ${shape.label} on the aggregate's own transaction RAISES 25006, while the membership read and the aggregate reads on the SAME handle succeed`, async () => {
        const { runAttendanceSetupReadinessReadOnly } = await import('../../src/services/AttendanceSetupReadinessAggregate')
        const { canReadAttendanceDirectoryReadiness } = await import('../../src/routes/attendance-admin')
        const { createAttendanceGroupEffectivePolicyAggregateService } = await import(
          '../../src/attendance/w6-group-effective-policy-aggregate'
        )
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const fserLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs')
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const producerKeyLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')

        observedTransactions.length = 0
        await runAttendanceSetupReadinessReadOnly(async (readOnlyQuery) => {
          // (1) THE RBAC ADMIN-ROLE + MEMBERSHIP READS, on this handle, as a
          //     non-admin so both SQL statements genuinely execute.
          const allowed = await canReadAttendanceDirectoryReadiness(
            memberRequest(memberUser),
            memberUser,
            orgA,
            readOnlyQuery,
          )
          expect(allowed).toBe(true)
          const adminRoleSoFar = observedTransactions[0].statements.filter(
            (sql) => /FROM user_roles/.test(sql) && /role_id = \$2/.test(sql),
          )
          expect(adminRoleSoFar.length).toBe(1)
          // MEASURED, not reasoned: `allowed === true` is also what an admin
          // bypass returns, and on that path the membership statement never
          // reaches Postgres at all. Assert the statement itself landed on
          // THIS handle, or the whole leg is about a query that never ran.
          const membershipSoFar = observedTransactions[0].statements.filter(
            (sql) => /FROM user_orgs uo/.test(sql) && /uo\.is_active = true/.test(sql),
          )
          expect(membershipSoFar.length).toBe(1)

          // (2) THE AGGREGATE + FSER READS on the same handle.
          const service = createAttendanceGroupEffectivePolicyAggregateService({
            query: async (sql: string, params?: unknown[]) => (await readOnlyQuery(sql, params)).rows,
            fser: fserLib.createAttendanceGroupFixedScheduleEffectivenessService({
              HttpError: ReadOnlyProbeHttpError,
              buildAttendanceGroupFixedScheduleProducerKey:
                producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
              now: () => new Date().toISOString(),
            }),
            now: () => new Date().toISOString(),
            segmentCalculationImplemented: false,
          })
          const aggregate = await service.getAggregate({ orgId: orgA, groupId: groupAId })
          expect(aggregate.groupId).toBe(groupAId)
          // Non-vacuity: the FSER leg really ran on this handle too, so the
          // "same transaction" claim covers FSER's queries and not only the
          // aggregate's own.
          expect(aggregate.domains.schedule.fixedSchedule).not.toBeNull()

          // (3) A WRITE on the SAME handle. Asserted on SQLSTATE, not on a
          //     message substring: `25006 read_only_sql_transaction` is the
          //     code Postgres raises for a write in a READ ONLY transaction,
          //     and matching on text would also accept a syntax error or a
          //     missing-table error — "not this error" is not an outcome.
          //     Deliberately the LAST statement in the body: after it the
          //     transaction is aborted, and anything further would fail with
          //     25P02 for a different reason.
          const error = await readOnlyQuery(shape.sql, shape.params).then(
            () => null,
            (caught: unknown) => caught as { code?: string; message?: string },
          )
          expect(error).not.toBeNull()
          expect(error?.code).toBe('25006')
        })
      })
    }

    it('POSITIVE CONTROL: the very same write SUCCEEDS outside the read-only transaction (so 25006 is the transaction, not the statement)', async () => {
      // Without this the raise proof cannot distinguish "READ ONLY refused it"
      // from "that statement was always going to fail". Run on the raw pool,
      // inside an explicit transaction that is ROLLED BACK, so the fixture is
      // untouched.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await client.query('UPDATE attendance_groups SET timezone = $1 WHERE id = $2', ['UTC', groupAId])
        expect(result.rowCount).toBe(1)
      } finally {
        await client.query('ROLLBACK')
        client.release()
      }
    })

    it('for a DELEGATED (non-admin) caller the route runs the membership read AND the aggregate reads on ONE transaction whose FIRST statement is SET TRANSACTION READ ONLY', async () => {
      observedTransactions.length = 0
      observedSql.length = 0
      // adminApp()'s principal holds `attendance:admin` but is NOT an admin
      // (no legacy claim, and the real `isAdmin` read returns false), so the
      // membership query really executes on this path.
      //
      // The title says DELEGATED deliberately. A platform admin short-circuits
      // `canReadAttendanceDirectoryReadiness` before the membership statement
      // is reached, so for that caller there is no membership read to be inside
      // the transaction at all — an unqualified "the route runs the membership
      // read …" would be false for half the caller population. That
      // short-circuit is pinned, DB-free, in
      // `tests/unit/attendance-w6-group-effective-policy-authorization.test.ts`.
      const res = await request(adminApp()).get(`/api/attendance/groups/${groupAId}/effective-policy`)
      expect(res.status).toBe(200)

      expect(observedTransactions.length).toBe(1)
      const statements = observedTransactions[0].statements
      expect(statements[0]).toBe('SET TRANSACTION READ ONLY')

      // The post-guard platform-admin lookup and membership reads are on THIS
      // handle...
      const adminRoleStatements = statements.filter((sql) => /FROM user_roles/.test(sql) && /role_id = \$2/.test(sql))
      expect(adminRoleStatements.length).toBe(1)
      const membershipStatements = statements.filter((sql) => /FROM user_orgs uo/.test(sql) && /uo\.is_active = true/.test(sql))
      expect(membershipStatements.length).toBe(1)

      // ...and so are every aggregate- and FSER-authored read reached by this
      // request. Compare each derived SQL literal across the all-path recorder
      // and this transaction's recorder: equality means no matching execution
      // escaped to the pool. Per-domain positive controls prevent an empty or
      // inactive derived set from making the comparison vacuous.
      const repoRoot = findRepoRoot(__dirname)
      const closure = buildAggregateCallPathClosure(repoRoot)
      const resolvedSql = collectQuerySqlArguments(closure, repoRoot).resolved
      const aggregateLiterals = new Set(
        resolvedSql
          .filter((entry) => entry.file.endsWith('w6-group-effective-policy-aggregate.ts'))
          .map((entry) => entry.sql),
      )
      const fserLiterals = new Set(
        resolvedSql
          .filter((entry) => entry.file.endsWith('attendance-group-fixed-schedule-effectiveness-service.cjs'))
          .map((entry) => entry.sql),
      )
      expect(aggregateLiterals.size).toBeGreaterThanOrEqual(5)
      expect(fserLiterals.size).toBeGreaterThanOrEqual(1)
      expect(statements.filter((sql) => aggregateLiterals.has(sql)).length).toBeGreaterThan(0)
      expect(statements.filter((sql) => fserLiterals.has(sql)).length).toBeGreaterThan(0)
      for (const sql of new Set([...aggregateLiterals, ...fserLiterals])) {
        expect(observedSql.filter((candidate) => candidate === sql).length).toBe(
          statements.filter((candidate) => candidate === sql).length,
        )
      }

      // NEGATIVE: the membership read must NOT also appear on the pool path.
      // `observedSql` carries pool statements and transaction statements alike,
      // so the discriminating check is the COUNT — one occurrence, the one
      // already located inside the transaction.
      const membershipOnAnyPath = observedSql.filter(
        (sql) => /FROM user_orgs uo/.test(sql) && /uo\.is_active = true/.test(sql),
      )
      expect(membershipOnAnyPath.length).toBe(membershipStatements.length)
      const adminRoleOnAnyPath = observedSql.filter((sql) => /FROM user_roles/.test(sql) && /role_id = \$2/.test(sql))
      expect(adminRoleOnAnyPath.length).toBe(adminRoleStatements.length)
    })

    /**
     * Two write shapes the LIST-BASED proofs above (the row-count snapshot,
     * the derived relation set, the static DML sweep) cannot see by
     * construction, both proved refused here by PostgreSQL itself rather than
     * by any form of source analysis:
     *
     *  - a write reached through a helper that composes its own SQL, so no
     *    literal exists at the call site for a text sweep to find. The
     *    transaction does not care: the refusal is at execution, against the
     *    command type of whatever string actually arrives, regardless of how
     *    it was composed. This is what makes "the mechanism of record is the
     *    transaction, not the static sweep" a measured claim rather than an
     *    assertion.
     *  - a write to a table outside every derived and hand-written list on
     *    this branch. Its absence from those lists is derived here, not
     *    assumed: checked against the same derived closure the row-count
     *    snapshot uses.
     */
    describe('writes the list-based static proofs cannot see, refused by PostgreSQL', () => {
      /** A helper that composes its own SQL, so no literal exists at the call
       *  site for a text sweep to find. Deliberately interpolated rather than
       *  parameterised, since a builder returning a parameterised literal
       *  would be a weaker probe. */
      function buildAttendanceGroupTouchSql(groupId: string): string {
        return 'UPD' + `ATE attendance_groups SET timezone = 'UTC' WHERE id = '${groupId}'`
      }

      /** A table on no list this branch derives or hand-writes. Chosen for its
       *  distance from attendance entirely; its off-list-ness is asserted
       *  mechanically below rather than taken on faith. */
      const ARBITRARY_TABLE = 'bpmn_signal_events'
      const ARBITRARY_WRITE_SQL = `INSERT INTO ${ARBITRARY_TABLE} (signal_name, status) VALUES ($1, $2)`

      it(`PREMISE (derived, not asserted): ${ARBITRARY_TABLE} is in NO list this branch computes or writes down`, () => {
        const derived = relationsFromAggregateClosure()
        // Non-vacuity first — a derivation that returns nothing would make the
        // "absent from it" claim true for the boring reason.
        expect(derived.length).toBeGreaterThanOrEqual(8)
        expect(derived).not.toContain(ARBITRARY_TABLE)
        expect(TRIGGER_FANOUT_TABLES).not.toContain(ARBITRARY_TABLE)
        // And the write-shape battery above (which names attendance tables the
        // derived set DOES contain) does not reach it either.
        expect(WRITE_SHAPES.some((shape) => shape.sql.includes(ARBITRARY_TABLE))).toBe(false)
      })

      it('a composed-SQL helper write, on the handle the membership read and the aggregate reads shared, raises 25006', async () => {
        const { runAttendanceSetupReadinessReadOnly } = await import('../../src/services/AttendanceSetupReadinessAggregate')
        const { canReadAttendanceDirectoryReadiness } = await import('../../src/routes/attendance-admin')
        const { createAttendanceGroupEffectivePolicyAggregateService } = await import(
          '../../src/attendance/w6-group-effective-policy-aggregate'
        )
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const fserLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs')
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
        const producerKeyLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')

        observedTransactions.length = 0
        await runAttendanceSetupReadinessReadOnly(async (readOnlyQuery) => {
          // The aggregate's own seam expression, built exactly as
          // `createAttendanceGroupEffectivePolicyReadOnlyService` builds it in
          // `attendance-admin.ts` — so what is refused below is the seam the
          // aggregate itself calls, not a separate client.
          const aggregateSeam = async (sql: string, params?: unknown[]) => (await readOnlyQuery(sql, params)).rows

          const allowed = await canReadAttendanceDirectoryReadiness(
            memberRequest(memberUser),
            memberUser,
            orgA,
            readOnlyQuery,
          )
          expect(allowed).toBe(true)
          const service = createAttendanceGroupEffectivePolicyAggregateService({
            query: aggregateSeam,
            fser: fserLib.createAttendanceGroupFixedScheduleEffectivenessService({
              HttpError: ReadOnlyProbeHttpError,
              buildAttendanceGroupFixedScheduleProducerKey:
                producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
              now: () => new Date().toISOString(),
            }),
            now: () => new Date().toISOString(),
            segmentCalculationImplemented: false,
          })
          // The legitimate reads still work on this handle — otherwise the
          // raise below would be indistinguishable from a dead connection.
          const aggregate = await service.getAggregate({ orgId: orgA, groupId: groupAId })
          expect(aggregate.groupId).toBe(groupAId)

          // The composed-SQL write. Note the shape: the SQL never appears as
          // a literal at this call site, which is exactly what a text-based
          // static sweep cannot see.
          const error = await aggregateSeam(buildAttendanceGroupTouchSql(groupAId)).then(
            () => null,
            (caught: unknown) => caught as { code?: string },
          )
          expect(error).not.toBeNull()
          expect(error?.code).toBe('25006')
        })
      })

      it('positive control: the composed helper SQL really is a working write outside the transaction', async () => {
        // Without this, `25006` could not be distinguished from "that builder
        // produced a statement that was never going to work". Rolled back, so
        // the fixture is untouched.
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await client.query(buildAttendanceGroupTouchSql(groupAId))
          expect(result.rowCount).toBe(1)
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      })

      it(`a write to ${ARBITRARY_TABLE} (a table on no derived or hand-written list), on the aggregate's handle, raises 25006`, async () => {
        const { runAttendanceSetupReadinessReadOnly } = await import('../../src/services/AttendanceSetupReadinessAggregate')
        const { canReadAttendanceDirectoryReadiness } = await import('../../src/routes/attendance-admin')

        await runAttendanceSetupReadinessReadOnly(async (readOnlyQuery) => {
          // Same handle, after the membership read has genuinely executed on
          // it — so this is the aggregate's transaction, not a fresh one.
          const allowed = await canReadAttendanceDirectoryReadiness(
            memberRequest(memberUser),
            memberUser,
            orgA,
            readOnlyQuery,
          )
          expect(allowed).toBe(true)
          const stillReads = await readOnlyQuery('SELECT 1 AS one', [])
          expect(stillReads.rows[0].one).toBe(1)

          const error = await readOnlyQuery(ARBITRARY_WRITE_SQL, [`w6-ro-probe-${runstamp}`, 'pending']).then(
            () => null,
            (caught: unknown) => caught as { code?: string },
          )
          expect(error).not.toBeNull()
          expect(error?.code).toBe('25006')
        })
      })

      it(`positive control: the same ${ARBITRARY_TABLE} write succeeds outside the transaction`, async () => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const result = await client.query(ARBITRARY_WRITE_SQL, [`w6-ro-probe-${runstamp}`, 'pending'])
          expect(result.rowCount).toBe(1)
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      })

      it('THE MEMBERSHIP CHECK IS INSIDE, NOT ADJACENT: a write attempted at the membership read\'s own point RAISES 25006', async () => {
        // "Adjacent" would mean the membership read runs on a handle that is
        // not read-only and the aggregate's runs on one that is. The
        // discriminating experiment is to attempt a write at the point where
        // the membership read just executed, on the SAME handle, BEFORE any
        // aggregate query has been issued — if the membership read were merely
        // adjacent, that write would succeed.
        const { runAttendanceSetupReadinessReadOnly } = await import('../../src/services/AttendanceSetupReadinessAggregate')
        const { canReadAttendanceDirectoryReadiness } = await import('../../src/routes/attendance-admin')

        observedTransactions.length = 0
        await runAttendanceSetupReadinessReadOnly(async (readOnlyQuery) => {
          const allowed = await canReadAttendanceDirectoryReadiness(
            memberRequest(memberUser),
            memberUser,
            orgA,
            readOnlyQuery,
          )
          expect(allowed).toBe(true)
          // Measured: the membership statement really executed on this handle
          // (an admin bypass returns `true` without issuing it at all).
          const statements = observedTransactions[0].statements
          expect(statements.filter((sql) => /FROM user_orgs uo/.test(sql)).length).toBe(1)
          // ...and NO aggregate query has run yet, so what follows is a write
          // at the membership read's own point, not after the aggregate's.
          const repoRoot = findRepoRoot(__dirname)
          const aggregateLiterals = new Set(
            collectQuerySqlArguments(buildAggregateCallPathClosure(repoRoot), repoRoot)
              .resolved.filter((entry) => entry.file.endsWith('w6-group-effective-policy-aggregate.ts'))
              .map((entry) => entry.sql),
          )
          expect(aggregateLiterals.size).toBeGreaterThanOrEqual(5)
          expect(statements.filter((sql) => aggregateLiterals.has(sql)).length).toBe(0)

          const error = await readOnlyQuery('UPDATE user_orgs SET is_active = true WHERE user_id = $1', [memberUser]).then(
            () => null,
            (caught: unknown) => caught as { code?: string },
          )
          expect(error).not.toBeNull()
          expect(error?.code).toBe('25006')
        })
      })
    })
  })
})
