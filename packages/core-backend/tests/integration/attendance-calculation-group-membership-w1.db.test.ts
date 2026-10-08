import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import {
  AttendanceCalculationGroupMembershipError,
  listAttendanceCalculationGroupMemberships,
  transitionAttendanceCalculationGroupMembership,
} from '../../src/services/AttendanceCalculationGroupMembership'
import {
  down as membershipMigrationDown,
  up as membershipMigrationUp,
} from '../../src/db/migrations/zzzz20260723140000_create_attendance_calculation_group_memberships'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

describeIfDatabase('W1 effective calculation-group membership (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgA = `calc-w1-a-${suffix}`
  const orgB = `calc-w1-b-${suffix}`
  const actorId = `calc-w1-actor-${suffix}`
  const userId = `calc-w1-user-${suffix}`
  const futureUserId = `calc-w1-future-${suffix}`
  const raceUserId = `calc-w1-race-${suffix}`
  const lifecycleUserId = `calc-w1-lifecycle-${suffix}`
  const mixedWriterUserId = `calc-w1-mixed-writer-${suffix}`
  const uuidUserId = `calc-w1-uuid-${suffix}`
  const inactiveUserId = `calc-w1-inactive-${suffix}`
  const groupA = randomUUID()
  const groupB = randomUUID()
  const groupC = randomUUID()
  const foreignGroup = randomUUID()
  const userIds = [
    actorId,
    userId,
    futureUserId,
    raceUserId,
    lifecycleUserId,
    mixedWriterUserId,
    uuidUserId,
    inactiveUserId,
  ]
  const groupIds = [groupA, groupB, groupC, foreignGroup]

  beforeAll(async () => {
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required')

    for (const [id, active] of [
      [actorId, true],
      [userId, true],
      [futureUserId, true],
      [raceUserId, true],
      [lifecycleUserId, true],
      [mixedWriterUserId, true],
      [uuidUserId, true],
      [inactiveUserId, false],
    ] as const) {
      await pool.query(
        `INSERT INTO users (
           id, email, username, name, password_hash, role, permissions,
           is_active, is_admin, created_at, updated_at
         ) VALUES ($1, $2, $1, 'Fixture', 'x', 'user', '[]'::jsonb, $3, false, now(), now())`,
        [id, `${id}@example.test`, active],
      )
    }
    for (const id of [
      actorId,
      userId,
      futureUserId,
      raceUserId,
      lifecycleUserId,
      mixedWriterUserId,
      uuidUserId,
    ]) {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id, is_active)
         VALUES ($1, $2, true)`,
        [id, orgA],
      )
    }
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, true)`,
      [futureUserId, orgB],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active)
       VALUES ($1, $2, false)`,
      [inactiveUserId, orgA],
    )

    for (const [id, orgId, name] of [
      [groupA, orgA, 'Group A'],
      [groupB, orgA, 'Group B'],
      [groupC, orgA, 'Group C'],
      [foreignGroup, orgB, 'Foreign Group'],
    ]) {
      await pool.query(
        `INSERT INTO attendance_groups (
           id, org_id, name, code, timezone, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'UTC', now(), now())`,
        [id, orgId, `${name} ${suffix}`, `${name.replaceAll(' ', '-').toLowerCase()}-${suffix}`],
      )
    }
  })

  it('replays the migration down/up path and a second up without schema drift', async () => {
    const migrationPool = new Pool({ connectionString: dbUrl, max: 2 })
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: migrationPool }),
    })
    try {
      await membershipMigrationDown(db)
      const removed = await pool.query<{ membership: string | null; operation: string | null }>(
        `SELECT to_regclass('attendance_calculation_group_memberships')::text AS membership,
                to_regclass('attendance_calculation_group_membership_operations')::text AS operation`,
      )
      expect(removed.rows[0]).toEqual({ membership: null, operation: null })

      await membershipMigrationUp(db)
      await membershipMigrationUp(db)
      const restored = await pool.query<{ membership: string | null; operation: string | null }>(
        `SELECT to_regclass('attendance_calculation_group_memberships')::text AS membership,
                to_regclass('attendance_calculation_group_membership_operations')::text AS operation`,
      )
      expect(restored.rows[0]).toEqual({
        membership: 'attendance_calculation_group_memberships',
        operation: 'attendance_calculation_group_membership_operations',
      })
    } finally {
      await db.destroy()
    }
  })

  afterAll(async () => {
    await pool.query(
      `DELETE FROM attendance_calculation_group_membership_operations
        WHERE org_id = ANY($1::text[])`,
      [[orgA, orgB]],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM attendance_calculation_group_memberships
        WHERE org_id = ANY($1::text[])`,
      [[orgA, orgB]],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM attendance_group_members
        WHERE org_id = ANY($1::text[]) OR user_id = ANY($2::text[])`,
      [[orgA, orgB], userIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM attendance_groups WHERE id = ANY($1::uuid[])`,
      [groupIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`,
      [userIds],
    ).catch(() => undefined)
    await pool.query(
      `DELETE FROM users WHERE id = ANY($1::text[])`,
      [userIds],
    ).catch(() => undefined)
    await pool.end()
  })

  it('installs inclusive non-overlap, same-org group, and active user-org database guards', async () => {
    const constraints = await pool.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'attendance_calculation_group_memberships'::regclass`,
    )
    expect(constraints.rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        'attendance_calc_group_membership_dates_valid',
        'attendance_calc_group_membership_group_org_fk',
        'attendance_calc_group_memberships_no_overlap',
      ]),
    )

    await expect(
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2026-01-01', NULL, $4, 'wrong org', 'wrong-org')`,
        [orgA, userId, foreignGroup, actorId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'attendance_calc_group_membership_group_org_fk',
    })

    await expect(
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2026-01-01', NULL, $4, 'inactive user', 'inactive-user')`,
        [orgA, inactiveUserId, groupA, actorId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'attendance_calc_group_membership_user_org_required',
    })

    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (
         org_id, user_id, group_id, effective_from, effective_to,
         assigned_by, assigned_reason, assigned_correlation_id
       ) VALUES
         ($1, $3, $4, '2030-01-01', '2030-01-31', $6, 'org A interval', 'org-a-allowed'),
         ($2, $3, $5, '2030-01-01', '2030-01-31', $6, 'org B interval', 'org-b-allowed')`,
      [orgA, orgB, futureUserId, groupA, foreignGroup, actorId],
    )
    const crossOrg = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM attendance_calculation_group_memberships
        WHERE user_id = $1 AND effective_from = '2030-01-01'`,
      [futureUserId],
    )
    expect(crossOrg.rows[0]?.count).toBe('2')
    const orgAOnly = await listAttendanceCalculationGroupMemberships(orgA, futureUserId)
    expect(orgAOnly).toHaveLength(1)
    expect(orgAOnly[0]).toMatchObject({
      orgId: orgA,
      userId: futureUserId,
      groupId: groupA,
    })
    await pool.query(
      `DELETE FROM attendance_calculation_group_memberships
        WHERE user_id = $1 AND effective_from = '2030-01-01'`,
      [futureUserId],
    )
  })

  it('closes the prior inclusive interval at D-1, starts the next at D, and records audit context', async () => {
    const legacyBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM attendance_group_members
        WHERE org_id = $1 AND user_id = $2`,
      [orgA, userId],
    )
    const orgMembershipBefore = await pool.query(
      `SELECT user_id, org_id, is_active
         FROM user_orgs
        WHERE user_id = $1 AND org_id = $2`,
      [userId, orgA],
    )

    const first = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId,
      targetGroupId: groupA,
      effectiveOn: '2026-01-01',
      actorId,
      reason: 'Initial calculation policy',
      correlationId: `initial-${suffix}`,
    })
    const second = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId,
      targetGroupId: groupB,
      effectiveOn: '2026-02-01',
      actorId,
      reason: 'Move to February policy',
      correlationId: `february-${suffix}`,
    })

    expect(first.membership.effectiveTo).toBeNull()
    expect(second.membership).toMatchObject({
      groupId: groupB,
      effectiveFrom: '2026-02-01',
      effectiveTo: null,
      assignedBy: actorId,
      assignedReason: 'Move to February policy',
      assignedCorrelationId: `february-${suffix}`,
    })

    const timeline = await pool.query(
      `SELECT group_id, effective_from::text, effective_to::text,
              closed_by, closed_reason, closed_correlation_id
         FROM attendance_calculation_group_memberships
        WHERE org_id = $1 AND user_id = $2
        ORDER BY effective_from`,
      [orgA, userId],
    )
    expect(timeline.rows).toEqual([
      expect.objectContaining({
        group_id: groupA,
        effective_from: '2026-01-01',
        effective_to: '2026-01-31',
        closed_by: actorId,
        closed_reason: 'Move to February policy',
        closed_correlation_id: `february-${suffix}`,
      }),
      expect.objectContaining({
        group_id: groupB,
        effective_from: '2026-02-01',
        effective_to: null,
      }),
    ])

    const legacyAfter = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM attendance_group_members
        WHERE org_id = $1 AND user_id = $2`,
      [orgA, userId],
    )
    const orgMembershipAfter = await pool.query(
      `SELECT user_id, org_id, is_active
         FROM user_orgs
        WHERE user_id = $1 AND org_id = $2`,
      [userId, orgA],
    )
    expect(legacyAfter.rows).toEqual(legacyBefore.rows)
    expect(orgMembershipAfter.rows).toEqual(orgMembershipBefore.rows)
  })

  it('replays an identical correlation and rejects mismatched reuse without another write', async () => {
    const correlationId = `february-${suffix}`
    await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId,
      targetGroupId: groupC,
      effectiveOn: '2026-03-01',
      actorId,
      reason: 'Move to March policy',
      correlationId: `march-${suffix}`,
    })
    const replay = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId,
      targetGroupId: groupB,
      effectiveOn: '2026-02-01',
      actorId,
      reason: 'Move to February policy',
      correlationId,
    })
    expect(replay.outcome).toBe('transitioned')
    expect(replay.membership).toMatchObject({
      groupId: groupB,
      effectiveFrom: '2026-02-01',
      effectiveTo: null,
    })

    await expect(
      transitionAttendanceCalculationGroupMembership({
        orgId: orgA,
        userId,
        targetGroupId: groupB,
        effectiveOn: '2026-02-02',
        actorId,
        reason: 'Move to February policy',
        correlationId,
      }),
    ).rejects.toMatchObject({
      code: 'CORRELATION_ID_REUSED',
      status: 409,
    } satisfies Partial<AttendanceCalculationGroupMembershipError>)

    const operations = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM attendance_calculation_group_membership_operations
        WHERE org_id = $1 AND correlation_id = $2`,
      [orgA, correlationId],
    )
    expect(operations.rows[0]?.count).toBe('1')
  })

  it('canonicalizes UUID casing for exact replay and same-group no-op detection', async () => {
    const uppercaseGroup = groupA.toUpperCase()
    const first = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: uuidUserId,
      targetGroupId: uppercaseGroup,
      effectiveOn: '2026-06-01',
      actorId,
      reason: 'Canonical UUID transition',
      correlationId: `uuid-first-${suffix}`,
    })
    const replay = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: uuidUserId,
      targetGroupId: uppercaseGroup,
      effectiveOn: '2026-06-01',
      actorId,
      reason: 'Canonical UUID transition',
      correlationId: `uuid-first-${suffix}`,
    })
    const unchanged = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: uuidUserId,
      targetGroupId: uppercaseGroup,
      effectiveOn: '2026-06-10',
      actorId,
      reason: 'Already in this calculation group',
      correlationId: `uuid-unchanged-${suffix}`,
    })

    expect(first.membership.groupId).toBe(groupA)
    expect(replay).toEqual(first)
    expect(unchanged.outcome).toBe('unchanged')
    expect(unchanged.membership.id).toBe(first.membership.id)
    const timeline = await listAttendanceCalculationGroupMemberships(orgA, uuidUserId)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      orgId: orgA,
      userId: uuidUserId,
      groupId: groupA,
      effectiveFrom: '2026-06-01',
      effectiveTo: null,
    })
  })

  it('preserves an existing future interval by ending the inserted target at futureStart-1', async () => {
    await pool.query(
      `INSERT INTO attendance_calculation_group_memberships (
         org_id, user_id, group_id, effective_from, effective_to,
         assigned_by, assigned_reason, assigned_correlation_id
       ) VALUES
         ($1, $2, $3, '2026-01-01', '2026-01-31', $5, 'past', 'future-past'),
         ($1, $2, $4, '2026-03-01', NULL, $5, 'future', 'future-existing')`,
      [orgA, futureUserId, groupA, groupC, actorId],
    )

    const inserted = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: futureUserId,
      targetGroupId: groupB,
      effectiveOn: '2026-02-01',
      actorId,
      reason: 'Fill the planned February interval',
      correlationId: `future-fill-${suffix}`,
    })

    expect(inserted.membership).toMatchObject({
      effectiveFrom: '2026-02-01',
      effectiveTo: '2026-02-28',
    })
    const future = await pool.query(
      `SELECT group_id, effective_from::text, effective_to::text
         FROM attendance_calculation_group_memberships
        WHERE org_id = $1 AND user_id = $2
        ORDER BY effective_from`,
      [orgA, futureUserId],
    )
    expect(future.rows).toEqual([
      { group_id: groupA, effective_from: '2026-01-01', effective_to: '2026-01-31' },
      { group_id: groupB, effective_from: '2026-02-01', effective_to: '2026-02-28' },
      { group_id: groupC, effective_from: '2026-03-01', effective_to: null },
    ])
  })

  it('lets the database reject one of two concurrent direct overlapping writes', async () => {
    const statements = [
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2027-01-01', '2027-01-31', $4, 'race one', $5)`,
        [orgA, raceUserId, groupA, actorId, `race-one-${suffix}`],
      ),
      pool.query(
        `INSERT INTO attendance_calculation_group_memberships (
           org_id, user_id, group_id, effective_from, effective_to,
           assigned_by, assigned_reason, assigned_correlation_id
         ) VALUES ($1, $2, $3, '2027-01-31', NULL, $4, 'race two', $5)`,
        [orgA, raceUserId, groupB, actorId, `race-two-${suffix}`],
      ),
    ]
    const results = await Promise.allSettled(statements)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: {
        code: '23P01',
        constraint: 'attendance_calc_group_memberships_no_overlap',
      },
    })
  })

  it('serializes a service transition against deactivation and guards direct timeline rewrites', async () => {
    const lifecycleClient = await pool.connect()
    try {
      await lifecycleClient.query('BEGIN')
      await lifecycleClient.query(
        `SELECT 1
           FROM user_orgs
          WHERE user_id = $1 AND org_id = $2
          FOR UPDATE`,
        [lifecycleUserId, orgA],
      )

      const transition = transitionAttendanceCalculationGroupMembership({
        orgId: orgA,
        userId: lifecycleUserId,
        targetGroupId: groupA,
        effectiveOn: '2026-07-01',
        actorId,
        reason: 'Must not race deactivation',
        correlationId: `lifecycle-race-${suffix}`,
      })
      let observedLockWait = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND (
                query LIKE '%FROM users u%'
                OR query LIKE '%attendance_calculation_group_memberships%'
              )`,
        )
        if (blocked.rows[0]?.count !== '0') {
          observedLockWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(observedLockWait).toBe(true)

      await lifecycleClient.query(
        `UPDATE user_orgs
            SET is_active = false
          WHERE user_id = $1 AND org_id = $2`,
        [lifecycleUserId, orgA],
      )
      await lifecycleClient.query('COMMIT')

      await expect(transition).rejects.toMatchObject({
        code: 'ACTIVE_ORG_USER_REQUIRED',
        status: 422,
      } satisfies Partial<AttendanceCalculationGroupMembershipError>)
      const noWrite = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM attendance_calculation_group_memberships
          WHERE org_id = $1 AND user_id = $2`,
        [orgA, lifecycleUserId],
      )
      expect(noWrite.rows[0]?.count).toBe('0')
    } finally {
      await lifecycleClient.query('ROLLBACK').catch(() => undefined)
      lifecycleClient.release()
    }

    await pool.query(
      `UPDATE user_orgs
          SET is_active = true
        WHERE user_id = $1 AND org_id = $2`,
      [lifecycleUserId, orgA],
    )
    const created = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: lifecycleUserId,
      targetGroupId: groupA,
      effectiveOn: '2026-07-01',
      actorId,
      reason: 'Create before later lifecycle change',
      correlationId: `lifecycle-created-${suffix}`,
    })
    await pool.query(
      `UPDATE user_orgs
          SET is_active = false
        WHERE user_id = $1 AND org_id = $2`,
      [lifecycleUserId, orgA],
    )
    await expect(
      pool.query(
        `UPDATE attendance_calculation_group_memberships
            SET group_id = $1
          WHERE id = $2`,
        [groupB, created.membership.id],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'attendance_calc_group_membership_user_org_required',
    })
  })

  it('uses one lock order for a direct semantic update racing a service transition', async () => {
    const initial = await transitionAttendanceCalculationGroupMembership({
      orgId: orgA,
      userId: mixedWriterUserId,
      targetGroupId: groupA,
      effectiveOn: '2028-01-01',
      actorId,
      reason: 'Seed mixed-writer timeline',
      correlationId: `mixed-seed-${suffix}`,
    })
    const directClient = await pool.connect()
    try {
      await directClient.query('BEGIN')
      await directClient.query(
        `SELECT 1
           FROM attendance_calculation_group_memberships
          WHERE id = $1
          FOR UPDATE`,
        [initial.membership.id],
      )

      const serviceTransition = transitionAttendanceCalculationGroupMembership({
        orgId: orgA,
        userId: mixedWriterUserId,
        targetGroupId: groupB,
        effectiveOn: '2028-02-01',
        actorId,
        reason: 'Service waits behind direct timeline writer',
        correlationId: `mixed-service-${suffix}`,
      }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )

      let observedTimelineWait = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blocked = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%attendance_calculation_group_memberships%'`,
        )
        if (blocked.rows[0]?.count !== '0') {
          observedTimelineWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(observedTimelineWait).toBe(true)

      await expect(
        directClient.query(
          `UPDATE attendance_calculation_group_memberships
              SET effective_to = '2028-01-31',
                  closed_by = $2,
                  closed_reason = 'Direct writer closes the first interval',
                  closed_correlation_id = $3
            WHERE id = $1`,
          [initial.membership.id, actorId, `mixed-direct-${suffix}`],
        ),
      ).resolves.toMatchObject({ rowCount: 1 })
      await directClient.query('COMMIT')

      await expect(serviceTransition).resolves.toMatchObject({
        status: 'fulfilled',
        value: {
          outcome: 'transitioned',
          membership: {
            groupId: groupB,
            effectiveFrom: '2028-02-01',
          },
        },
      })
    } finally {
      await directClient.query('ROLLBACK').catch(() => undefined)
      directClient.release()
    }
  })

  it('fails closed for an inactive target and a group from another org', async () => {
    await expect(
      transitionAttendanceCalculationGroupMembership({
        orgId: orgA,
        userId: inactiveUserId,
        targetGroupId: groupA,
        effectiveOn: '2026-04-01',
        actorId,
        reason: 'Should not apply',
        correlationId: `inactive-${suffix}`,
      }),
    ).rejects.toMatchObject({
      code: 'ACTIVE_ORG_USER_REQUIRED',
      status: 422,
    } satisfies Partial<AttendanceCalculationGroupMembershipError>)

    await expect(
      transitionAttendanceCalculationGroupMembership({
        orgId: orgA,
        userId,
        targetGroupId: foreignGroup,
        effectiveOn: '2026-04-01',
        actorId,
        reason: 'Should not cross organizations',
        correlationId: `foreign-${suffix}`,
      }),
    ).rejects.toMatchObject({
      code: 'TARGET_GROUP_NOT_FOUND',
      status: 404,
    } satisfies Partial<AttendanceCalculationGroupMembershipError>)
  })
})
