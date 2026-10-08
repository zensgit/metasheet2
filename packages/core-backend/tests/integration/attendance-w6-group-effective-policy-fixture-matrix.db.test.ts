/**
 * W6-1 §7.2 — every committed aggregate fixture reproduced from seeded
 * PostgreSQL rows with the canonical FSER service and exact-key equality.
 *
 * A disposable database is required because the overlap fixture must contain
 * a state that the production exclusion constraint normally prevents. The
 * schema below is the smallest real-SQL surface consumed by the aggregate and
 * FSER; no query result is stubbed.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAttendanceGroupEffectivePolicyAggregateService } from '../../src/attendance/w6-group-effective-policy-aggregate'
import {
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const serverUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = serverUrl ? describe : describe.skip
const FIXTURE_DIR = join(__dirname, '../fixtures/attendance/w6')
const NOW = '2026-08-05T00:00:00.000Z'

const FIXTURE_NAMES = [
  'aggregate-effective-fixed-shift',
  'aggregate-org-inherited-defaults',
  'aggregate-preview-only-segments-flex',
  'aggregate-needs-configuration',
  'aggregate-conflict-membership-overlap',
  'aggregate-conflict-fixed-schedule-changed',
  'aggregate-configured-scheduled-shift',
  'aggregate-conflict-unpublished-managed-row',
] as const

type FixtureName = typeof FIXTURE_NAMES[number]
type FixedSchedule = {
  state: string
  desired: { shiftId: string; startDate: string; endDate: string | null; revision: number }
  drift: {
    unpublishedManagedRows: number
    managedSets: Array<{
      shiftId: string
      startDate: string
      endDate: string | null
      producerKey: string
      rowCount: number
    }>
  }
}
type FixtureData = {
  groupId: string
  groupType: 'fixed_shift' | 'scheduled_shift' | 'free_time'
  timezone: string | null
  activeMemberCount: number
  managerPosture: { ownerCount: number; subOwnerCount: number }
  domains: {
    schedule: {
      sourceRefs: Array<{ kind: string; id: string }>
      fixedSchedule: FixedSchedule | null
    }
    flex: { mode?: 'strict' | 'flex_required_duration' }
    rules: {
      label: string
      source: 'org_default' | 'group_rule_set'
      sourceRefs: Array<{ kind: string; id: string }>
    }
  }
  conflicts: Array<{ code: string }>
} & Record<string, unknown>

function readFixture(name: FixtureName): { data: FixtureData } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as { data: FixtureData }
}

async function closePoolWithinDeadline(pool: Pool, timeoutMs = 5_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pool.end(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('attendance W6 scratch pool close timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const fserLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-effectiveness-service.cjs') as {
  createAttendanceGroupFixedScheduleEffectivenessService: (deps: {
    HttpError: new (status: number, code: string, message: string) => Error
    buildAttendanceGroupFixedScheduleProducerKey: (input: {
      groupId: string
      shiftId: string
      startDate: string
      endDate: string | null
    }) => string
    now: () => string
  }) => {
    getEffectiveness: (
      db: { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> },
      input: { orgId: string; groupId: string },
    ) => Promise<{
      groupId: string
      state: 'not_configured' | 'pending_apply' | 'effective' | 'configuration_changed'
      reasonCodes: string[]
      desired: { shiftId: string; startDate: string; endDate: string | null; revision: number } | null
      coverage: { targetMembers: number; matchingMembers: number; missingMembers: number; nonMemberTargets: number; differentKeyRows: number }
      drift: { unconfiguredManagedRows: number; unpublishedManagedRows: number; managedSets: Array<{ shiftId: string; startDate: string; endDate: string | null; producerKey: string; rowCount: number }> }
      evaluatedAt: string
    }>
  }
}
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const producerKeyLib = require('../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs') as {
  buildAttendanceGroupFixedScheduleProducerKey: (input: {
    groupId: string
    shiftId: string
    startDate: string
    endDate: string | null
  }) => string
}

class TestHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

describeIfDatabase('W6-1 aggregate fixture matrix (seeded real PostgreSQL)', () => {
  const databaseName = `attendance_w6_matrix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const adminUrl = new URL(serverUrl || 'postgresql://postgres@localhost/postgres')
  adminUrl.pathname = '/postgres'
  const scratchUrl = new URL(adminUrl)
  scratchUrl.pathname = `/${databaseName}`
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  let pool: Pool | undefined
  const orgByFixture = new Map<FixtureName, string>()

  async function seedMembers(orgId: string, groupId: string, count: number): Promise<string[]> {
    const userIds = Array.from({ length: count }, (_, index) => `${orgId}-member-${index + 1}`)
    for (const userId of userIds) {
      await pool?.query(
        'INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1, $2, $3)',
        [orgId, groupId, userId],
      )
    }
    return userIds
  }

  async function seedManagers(orgId: string, groupId: string, role: 'owner' | 'sub_owner', count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await pool?.query(
        'INSERT INTO attendance_group_managers (org_id, group_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [orgId, groupId, `${orgId}-${role}-${index + 1}`, role],
      )
    }
  }

  async function seedAssignment(input: {
    orgId: string
    groupId: string
    userId: string
    shiftId: string
    startDate: string
    endDate: string | null
    producerKey: string
    publishStatus: string
  }): Promise<void> {
    await pool?.query(
      `INSERT INTO attendance_shift_assignments
       (id, org_id, user_id, shift_id, start_date, end_date, publish_status,
        producer_key, producer_type, producer_ref_id, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'attendance_group_fixed_schedule', $9, true, now())`,
      [
        randomUUID(), input.orgId, input.userId, input.shiftId,
        input.startDate, input.endDate, input.publishStatus,
        input.producerKey, input.groupId,
      ],
    )
  }

  async function seedScenario(name: FixtureName, index: number): Promise<void> {
    const fixture = readFixture(name).data
    const orgId = `w6-matrix-${String(index + 1).padStart(2, '0')}`
    orgByFixture.set(name, orgId)
    const groupRuleRef = fixture.domains.rules.sourceRefs.find((ref) => ref.kind === 'rule_set')

    await pool?.query(
      `INSERT INTO attendance_groups (id, org_id, attendance_type, timezone, rule_set_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [fixture.groupId, orgId, fixture.groupType, fixture.timezone, groupRuleRef?.id ?? null],
    )
    const memberIds = await seedMembers(orgId, fixture.groupId, fixture.activeMemberCount)
    await seedManagers(orgId, fixture.groupId, 'owner', fixture.managerPosture.ownerCount)
    await seedManagers(orgId, fixture.groupId, 'sub_owner', fixture.managerPosture.subOwnerCount)

    if (groupRuleRef) {
      await pool?.query(
        'INSERT INTO attendance_rule_sets (id, org_id, is_default) VALUES ($1, $2, false)',
        [groupRuleRef.id, orgId],
      )
    } else if (fixture.domains.rules.label === 'org_inherited') {
      await pool?.query(
        'INSERT INTO attendance_rule_sets (id, org_id, is_default) VALUES ($1, $2, true)',
        [randomUUID(), orgId],
      )
    }

    if (fixture.groupType === 'scheduled_shift' && fixture.domains.schedule.fixedSchedule === null
      && fixture.domains.schedule.sourceRefs.length === 0
      && !fixture.conflicts.some((conflict) => conflict.code === 'SCHEDULE_STRATEGY_INCOMPLETE')) {
      await pool?.query(
        'INSERT INTO attendance_schedule_groups (id, org_id, attendance_group_id, is_active) VALUES ($1, $2, $3, true)',
        [randomUUID(), orgId, fixture.groupId],
      )
    }

    const fixed = fixture.domains.schedule.fixedSchedule
    if (fixed) {
      const configRef = fixture.domains.schedule.sourceRefs.find((ref) => ref.kind === 'fixed_schedule_config')
      if (!configRef) throw new Error(`${name}: missing fixed_schedule_config source ref`)
      await pool?.query(
        'INSERT INTO attendance_shifts (id, org_id, flex_mode) VALUES ($1, $2, $3)',
        [fixed.desired.shiftId, orgId, fixture.domains.flex.mode ?? 'strict'],
      )
      await pool?.query(
        `INSERT INTO attendance_group_fixed_schedule_configs
         (id, org_id, group_id, shift_id, start_date, end_date, revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          configRef.id, orgId, fixture.groupId, fixed.desired.shiftId,
          fixed.desired.startDate, fixed.desired.endDate, fixed.desired.revision,
        ],
      )
      await pool?.query(
        `INSERT INTO attendance_shift_segments
         (id, org_id, shift_id, segment_index, start_time, end_time)
         VALUES ($1, $2, $3, 0, '09:00', '18:00')`,
        [randomUUID(), orgId, fixed.desired.shiftId],
      )

      const canonicalKey = producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey({
        groupId: fixture.groupId,
        ...fixed.desired,
      })
      const changedSet = fixed.state === 'configuration_changed' ? fixed.drift.managedSets[0] : null
      for (const userId of memberIds) {
        await seedAssignment({
          orgId,
          groupId: fixture.groupId,
          userId,
          shiftId: changedSet?.shiftId ?? fixed.desired.shiftId,
          startDate: changedSet?.startDate ?? fixed.desired.startDate,
          endDate: changedSet?.endDate ?? fixed.desired.endDate,
          producerKey: changedSet?.producerKey ?? canonicalKey,
          publishStatus: 'published',
        })
      }
      for (let unpublished = 0; unpublished < fixed.drift.unpublishedManagedRows; unpublished += 1) {
        await seedAssignment({
          orgId,
          groupId: fixture.groupId,
          userId: memberIds[unpublished % memberIds.length],
          shiftId: fixed.desired.shiftId,
          startDate: fixed.desired.startDate,
          endDate: fixed.desired.endDate,
          producerKey: canonicalKey,
          publishStatus: 'pending',
        })
      }
    }

    if (fixture.conflicts.some((conflict) => conflict.code === 'CALCULATION_GROUP_MEMBERSHIP_OVERLAP')) {
      const otherGroupId = randomUUID()
      await pool?.query(
        `INSERT INTO attendance_groups (id, org_id, attendance_type, timezone, rule_set_id)
         VALUES ($1, $2, 'free_time', 'UTC', NULL)`,
        [otherGroupId, orgId],
      )
      for (const userId of memberIds.slice(0, 2)) {
        await pool?.query(
          `INSERT INTO attendance_calculation_group_memberships
           (id, org_id, user_id, group_id, effective_from, effective_to)
           VALUES ($1, $2, $3, $4, '2026-01-01', NULL),
                  ($5, $2, $3, $6, '2026-01-01', NULL)`,
          [randomUUID(), orgId, userId, fixture.groupId, randomUUID(), otherGroupId],
        )
      }
    }
  }

  beforeAll(async () => {
    await adminPool.query(`CREATE DATABASE ${databaseName}`)
    pool = new Pool({ connectionString: scratchUrl.toString(), max: 4 })
    await pool.query(`
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY, org_id text NOT NULL, attendance_type text NOT NULL,
        timezone text, rule_set_id uuid
      );
      CREATE TABLE attendance_group_members (org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL);
      CREATE TABLE attendance_group_managers (org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL, role text NOT NULL);
      CREATE TABLE attendance_calculation_rollout_state (org_id text PRIMARY KEY, state text NOT NULL);
      CREATE TABLE attendance_rule_sets (id uuid PRIMARY KEY, org_id text NOT NULL, is_default boolean NOT NULL);
      CREATE TABLE attendance_schedule_groups (id uuid PRIMARY KEY, org_id text NOT NULL, attendance_group_id uuid NOT NULL, is_active boolean NOT NULL);
      CREATE TABLE attendance_shifts (id uuid PRIMARY KEY, org_id text NOT NULL, flex_mode text NOT NULL);
      CREATE TABLE attendance_shift_segments (
        id uuid PRIMARY KEY, org_id text NOT NULL, shift_id uuid NOT NULL,
        segment_index integer NOT NULL, start_time time NOT NULL, end_time time NOT NULL
      );
      CREATE TABLE attendance_group_fixed_schedule_configs (
        id uuid PRIMARY KEY, org_id text NOT NULL, group_id uuid NOT NULL,
        shift_id uuid NOT NULL, start_date date NOT NULL, end_date date, revision integer NOT NULL
      );
      CREATE TABLE attendance_shift_assignments (
        id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
        shift_id uuid NOT NULL, start_date date NOT NULL, end_date date,
        publish_status text, producer_key text NOT NULL, producer_type text NOT NULL,
        producer_ref_id uuid NOT NULL, is_active boolean, created_at timestamptz NOT NULL
      );
      CREATE TABLE attendance_calculation_group_memberships (
        id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
        group_id uuid NOT NULL, effective_from date NOT NULL, effective_to date
      );
    `)
    for (const [index, name] of FIXTURE_NAMES.entries()) await seedScenario(name, index)
  })

  afterAll(async () => {
    const ownedPool = pool
    const termination = ownedPool ? attachOwnedPoolTerminationHandler(ownedPool) : null
    const cleanupFailures: Array<'fixture_pool_close' | 'database_drop' | 'admin_pool_close'> = []
    try {
      if (ownedPool) {
        try {
          await closePoolWithinDeadline(ownedPool)
        } catch {
          cleanupFailures.push('fixture_pool_close')
        }
      }
      pool = undefined
      try {
        const outcome = await dropScratchDatabase(adminPool, databaseName)
        console.info(formatScratchDropOutcome('attendance-w6-fixture-matrix', outcome))
      } catch (error) {
        cleanupFailures.push('database_drop')
        console.error(formatScratchDropFailure('attendance-w6-fixture-matrix', error))
      }
    } finally {
      termination?.detach()
      try {
        await adminPool.end()
      } catch {
        cleanupFailures.push('admin_pool_close')
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error(`attendance W6 scratch cleanup failed: ${cleanupFailures.join(',')}`)
    }
  }, 60_000)

  for (const name of FIXTURE_NAMES) {
    it(`reproduces ${name}.json from seeded rows`, async () => {
      const fixture = readFixture(name)
      const orgId = orgByFixture.get(name)
      if (!orgId || !pool) throw new Error(`${name}: fixture database not initialized`)
      const query = async (sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows
      const fser = fserLib.createAttendanceGroupFixedScheduleEffectivenessService({
        HttpError: TestHttpError,
        buildAttendanceGroupFixedScheduleProducerKey: producerKeyLib.buildAttendanceGroupFixedScheduleProducerKey,
        now: () => NOW,
      })
      const service = createAttendanceGroupEffectivePolicyAggregateService({
        query,
        fser,
        now: () => NOW,
        segmentCalculationImplemented: false,
      })
      expect(await service.getAggregate({ orgId, groupId: fixture.data.groupId })).toStrictEqual(fixture.data)
    })
  }
})
