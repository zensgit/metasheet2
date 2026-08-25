/**
 * E-learning L2 atomic training-plan assignment gate against real PostgreSQL.
 * DATABASE_URL is mandatory; missing infrastructure must fail, never skip.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'

import {
  ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
  ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
  TRAINING_PLAN_ASSIGNMENT_COMPLETE_GROUP_TRIGGER,
  TRAINING_PLAN_ASSIGNMENT_COMPLETE_LINK_TRIGGER,
  TRAINING_PLAN_ASSIGNMENT_GROUP_GUARD_TRIGGER,
  TRAINING_PLAN_ASSIGNMENT_LINK_GUARD_TRIGGER,
  TRAINING_PLAN_ASSIGNMENT_LINK_IMMUTABLE_TRIGGER,
  TRAINING_PLAN_ASSIGNMENT_DOWN_IN_USE,
  TRAINING_PLAN_CHILD_ASSIGNMENT_DEADLINE_TRIGGER,
  TRAINING_PLAN_CHILD_MEMBER_INSERT_TRIGGER,
  TRAINING_PLAN_CHILD_MEMBER_REVOKE_TRIGGER,
  down as downTrainingPlanAssignments,
} from '../../src/db/migrations/zzzz20260826190000_create_elearning_training_plan_assignments'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
} from '../../src/services/elearning-course-publish'
import {
  publishElearningTrainingPlan,
  type ElearningTrainingPlanDb,
} from '../../src/services/elearning-training-plan'
import {
  assignElearningTrainingPlan,
  ElearningTrainingPlanAssignmentError,
  type ElearningTrainingPlanAssignmentDb,
  type ElearningTrainingPlanAssignmentQueryable,
} from '../../src/services/elearning-training-plan-assignment'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning training-plan assignment DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-plan-assign-${process.pid}-${Date.now().toString(36)}`

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount,
  }
}

class PoolDb implements
  ElearningTrainingPlanAssignmentDb,
  ElearningTrainingPlanDb,
  ElearningCoursePublishDb {
  async query(sql: string, params?: unknown[]) {
    return exec(pool, sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningTrainingPlanAssignmentQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({ query: (sql, params) => exec(client, sql, params) })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

class FailingWriteDb implements ElearningTrainingPlanAssignmentDb {
  constructor(
    private readonly base: PoolDb,
    private readonly failAtAssignment: number,
  ) {}

  query(sql: string, params?: unknown[]) {
    return this.base.query(sql, params)
  }

  transaction<T>(
    handler: (tx: ElearningTrainingPlanAssignmentQueryable) => Promise<T>,
  ): Promise<T> {
    let assignmentWrites = 0
    return this.base.transaction((tx) => handler({
      query: async (sql, params) => {
        if (sql.includes(':insert-assignment')) {
          assignmentWrites += 1
          if (assignmentWrites === this.failAtAssignment) {
            throw new Error('injected write failure')
          }
        }
        return tx.query(sql, params)
      },
    }))
  }
}

const db = new PoolDb()

function org(label: string): string {
  return `${NS}-${label}`
}

function actor(label: string): string {
  return `${NS}-actor-${label}`
}

async function seedUsers(orgId: string, count: number): Promise<string[]> {
  const prefix = `${NS}-user-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     )
     SELECT
       $1 || '-' || n,
       md5($1 || ':' || n::text) || '@plan-assignment.test',
       $1 || '-' || n,
       'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     FROM generate_series(1, $2::integer) AS series(n)`,
    [prefix, count],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     SELECT $1 || '-' || n, $2, TRUE
     FROM generate_series(1, $3::integer) AS series(n)`,
    [prefix, orgId, count],
  )
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
}

async function seedPublishedCourse(orgId: string, label: string) {
  const mediaId = randomUUID()
  await db.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type, size_bytes,
       sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
    [
      mediaId,
      orgId,
      `${NS}/${label}/${mediaId}`,
      randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      actor(`uploader-${label}`),
    ],
  )
  return publishElearningCourse(db, {
    orgId,
    actorId: actor(`author-${label}`),
    requestId: randomUUID(),
    title: `Course ${label}`,
    mediaId,
    passScore: 10,
    maxAttempts: 3,
    questions: [{
      questionType: 'single_choice',
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'Alpha' },
        { id: 'b', text: 'Beta' },
      ],
      correctOptionIds: ['a'],
      points: 10,
    }],
  })
}

async function seedPlan(orgId: string, courseVersionIds: string[]) {
  return publishElearningTrainingPlan(db, {
    orgId,
    actorId: actor('plan-author'),
    requestId: randomUUID(),
    title: 'Atomic training plan',
    items: courseVersionIds.map((courseVersionId) => ({
      courseVersionId,
      required: true,
    })),
  })
}

function assignmentInput(
  orgId: string,
  planId: string,
  sourceKey = 'plan-run-1',
) {
  return {
    orgId,
    actorId: actor('assigner'),
    planId,
    sourceKey,
    deadline: '2030-01-01T00:00:00.000Z',
    rules: [{ subjectType: 'all' as const }],
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningTrainingPlanAssignmentError)
  expect((error as ElearningTrainingPlanAssignmentError).code).toBe(code)
  expect(`${(error as Error).message}\n${(error as Error).stack ?? ''}`).not.toContain(NS)
}

async function expectSqlState(
  expected: string,
  action: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe(expected)
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning atomic training-plan assignment real DB', () => {
  it('installs the same-org FK and immutable/complete trigger chain', async () => {
    const tables = await pool.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = current_schema()
         AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [[
        ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
      ]],
    )
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
      ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
    ])

    const triggerNames = [
      TRAINING_PLAN_ASSIGNMENT_COMPLETE_GROUP_TRIGGER,
      TRAINING_PLAN_ASSIGNMENT_COMPLETE_LINK_TRIGGER,
      TRAINING_PLAN_ASSIGNMENT_GROUP_GUARD_TRIGGER,
      TRAINING_PLAN_ASSIGNMENT_LINK_GUARD_TRIGGER,
      TRAINING_PLAN_ASSIGNMENT_LINK_IMMUTABLE_TRIGGER,
      TRAINING_PLAN_CHILD_ASSIGNMENT_DEADLINE_TRIGGER,
      TRAINING_PLAN_CHILD_MEMBER_INSERT_TRIGGER,
      TRAINING_PLAN_CHILD_MEMBER_REVOKE_TRIGGER,
    ].sort()
    const triggers = await pool.query(
      `SELECT tgname
       FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = ANY($1::text[])
       ORDER BY tgname`,
      [triggerNames],
    )
    expect(triggers.rows.map((row) => row.tgname)).toEqual(triggerNames)

    const orgDefaults = await pool.query(
      `SELECT table_name, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])
         AND column_name = 'org_id'
       ORDER BY table_name`,
      [[
        ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
      ]],
    )
    expect(orgDefaults.rows).toEqual([
      { table_name: ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE, column_default: null },
      { table_name: ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE, column_default: null },
    ])

    const foreignKeys = await pool.query(
      `SELECT
         constraint_info.conname AS constraint_name,
         constraint_info.conrelid::regclass::text AS child_table,
         constraint_info.confrelid::regclass::text AS parent_table,
         ARRAY(
           SELECT column_info.attname
           FROM unnest(constraint_info.conkey) WITH ORDINALITY AS key(attnum, position)
           JOIN pg_attribute column_info
             ON column_info.attrelid = constraint_info.conrelid
            AND column_info.attnum = key.attnum
           ORDER BY key.position
         )::text[] AS child_columns
       FROM pg_constraint constraint_info
       WHERE constraint_info.contype = 'f'
         AND constraint_info.conrelid = ANY($1::regclass[])
       ORDER BY constraint_info.conname`,
      [[
        ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
      ]],
    )
    expect(foreignKeys.rows).toEqual([
      {
        constraint_name: 'elearning_training_plan_assignment_items_assignment_fk',
        child_table: ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        parent_table: 'elearning_assignments',
        child_columns: ['org_id', 'assignment_id', 'course_version_id'],
      },
      {
        constraint_name: 'elearning_training_plan_assignment_items_group_fk',
        child_table: ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        parent_table: ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
        child_columns: [
          'org_id',
          'training_plan_assignment_id',
          'training_plan_version_id',
        ],
      },
      {
        constraint_name: 'elearning_training_plan_assignment_items_plan_item_fk',
        child_table: ELEARNING_TRAINING_PLAN_ASSIGNMENT_ITEMS_TABLE,
        parent_table: 'elearning_training_plan_items',
        child_columns: [
          'org_id',
          'training_plan_item_id',
          'training_plan_version_id',
          'course_version_id',
        ],
      },
      {
        constraint_name: 'elearning_training_plan_assignments_plan_version_fk',
        child_table: ELEARNING_TRAINING_PLAN_ASSIGNMENTS_TABLE,
        parent_table: 'elearning_training_plan_versions',
        child_columns: ['org_id', 'training_plan_id', 'training_plan_version_id'],
      },
    ])
  })

  it('creates identical member facts for every item and replays before current-state checks', async () => {
    const orgId = org('success')
    const users = await seedUsers(orgId, 2)
    const courses = await Promise.all([
      seedPublishedCourse(orgId, 'success-a'),
      seedPublishedCourse(orgId, 'success-b'),
    ])
    const plan = await seedPlan(orgId, courses.map((course) => course.courseVersionId))
    const input = assignmentInput(orgId, plan.planId)

    const created = await assignElearningTrainingPlan(db, input)
    expect(created).toMatchObject({
      planVersionId: plan.planVersionId,
      assignmentCount: 2,
      memberCount: 2,
      duplicate: false,
    })

    const links = await pool.query(
      `SELECT assignment_id, course_version_id
       FROM elearning_training_plan_assignment_items
       WHERE org_id = $1 AND training_plan_assignment_id = $2
       ORDER BY course_version_id`,
      [orgId, created.planAssignmentId],
    )
    expect(links.rows).toHaveLength(2)
    const memberSets = await pool.query(
      `SELECT assignment_id, array_agg(user_id ORDER BY user_id) AS member_ids
       FROM elearning_assignment_members
       WHERE org_id = $1 AND assignment_id = ANY($2::uuid[])
       GROUP BY assignment_id
       ORDER BY assignment_id`,
      [orgId, links.rows.map((row) => row.assignment_id)],
    )
    expect(memberSets.rows).toHaveLength(2)
    expect(memberSets.rows.map((row) => row.member_ids)).toEqual([
      users,
      users,
    ])

    await pool.query(
      `UPDATE elearning_training_plans SET status = 'archived' WHERE org_id = $1 AND id = $2`,
      [orgId, plan.planId],
    )
    await pool.query(
      `UPDATE users SET is_active = FALSE WHERE id = $1`,
      [users[0]],
    )
    await expect(assignElearningTrainingPlan(db, input)).resolves.toEqual({
      ...created,
      duplicate: true,
    })
    await assignElearningTrainingPlan(db, {
      ...input,
      deadline: '2031-01-01T00:00:00.000Z',
    }).then(
      () => { throw new Error('expected conflict') },
      (error) => expectCode(error, 'conflict'),
    )
  })

  it('isolates the same source key by org and serializes concurrent retries', async () => {
    const orgA = org('isolation-a')
    const orgB = org('isolation-b')
    await Promise.all([seedUsers(orgA, 1), seedUsers(orgB, 1)])
    const [courseA, courseB] = await Promise.all([
      seedPublishedCourse(orgA, 'isolation-a'),
      seedPublishedCourse(orgB, 'isolation-b'),
    ])
    const [planA, planB] = await Promise.all([
      seedPlan(orgA, [courseA.courseVersionId]),
      seedPlan(orgB, [courseB.courseVersionId]),
    ])

    const [first, second] = await Promise.all([
      assignElearningTrainingPlan(db, assignmentInput(orgA, planA.planId, 'shared-key')),
      assignElearningTrainingPlan(db, assignmentInput(orgA, planA.planId, 'shared-key')),
    ])
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true])
    expect(first.planAssignmentId).toBe(second.planAssignmentId)

    const otherOrg = await assignElearningTrainingPlan(
      db,
      assignmentInput(orgB, planB.planId, 'shared-key'),
    )
    expect(otherOrg.duplicate).toBe(false)
    expect(otherOrg.planAssignmentId).not.toBe(first.planAssignmentId)

    const counts = await pool.query(
      `SELECT org_id, count(*)::integer AS groups
       FROM elearning_training_plan_assignments
       WHERE org_id = ANY($1::text[])
       GROUP BY org_id
       ORDER BY org_id`,
      [[orgA, orgB]],
    )
    expect(counts.rows).toEqual([
      { org_id: orgA, groups: 1 },
      { org_id: orgB, groups: 1 },
    ])
  })

  it('rolls back the group, links, assignments, and members when a later item fails', async () => {
    const orgId = org('rollback')
    await seedUsers(orgId, 2)
    const courses = await Promise.all([
      seedPublishedCourse(orgId, 'rollback-a'),
      seedPublishedCourse(orgId, 'rollback-b'),
      seedPublishedCourse(orgId, 'rollback-c'),
    ])
    const plan = await seedPlan(orgId, courses.map((course) => course.courseVersionId))
    const failing = new FailingWriteDb(db, 3)
    await assignElearningTrainingPlan(
      failing,
      assignmentInput(orgId, plan.planId),
    ).then(
      () => { throw new Error('expected unavailable') },
      (error) => expectCode(error, 'unavailable'),
    )

    const residue = await pool.query(
      `SELECT
         (SELECT count(*) FROM elearning_training_plan_assignments WHERE org_id = $1)::integer AS groups,
         (SELECT count(*) FROM elearning_training_plan_assignment_items WHERE org_id = $1)::integer AS links,
         (SELECT count(*) FROM elearning_assignments WHERE org_id = $1)::integer AS assignments,
         (SELECT count(*) FROM elearning_assignment_members WHERE org_id = $1)::integer AS members`,
      [orgId],
    )
    expect(residue.rows[0]).toEqual({ groups: 0, links: 0, assignments: 0, members: 0 })
  })

  it('rejects archived plans and retired course versions before resolving an audience', async () => {
    const archivedOrg = org('archived')
    await seedUsers(archivedOrg, 1)
    const archivedCourse = await seedPublishedCourse(archivedOrg, 'archived')
    const archivedPlan = await seedPlan(archivedOrg, [archivedCourse.courseVersionId])
    await pool.query(
      `UPDATE elearning_training_plans SET status = 'archived' WHERE org_id = $1 AND id = $2`,
      [archivedOrg, archivedPlan.planId],
    )
    await assignElearningTrainingPlan(
      db,
      assignmentInput(archivedOrg, archivedPlan.planId),
    ).then(
      () => { throw new Error('expected plan_unavailable') },
      (error) => expectCode(error, 'plan_unavailable'),
    )

    const retiredOrg = org('retired')
    await seedUsers(retiredOrg, 1)
    const retiredCourse = await seedPublishedCourse(retiredOrg, 'retired')
    const retiredPlan = await seedPlan(retiredOrg, [retiredCourse.courseVersionId])
    await pool.query(
      `UPDATE elearning_courses
       SET active_version_id = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [retiredOrg, retiredCourse.courseId],
    )
    await pool.query(
      `UPDATE elearning_course_versions
       SET status = 'retired', updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [retiredOrg, retiredCourse.courseVersionId],
    )
    await assignElearningTrainingPlan(
      db,
      assignmentInput(retiredOrg, retiredPlan.planId),
    ).then(
      () => { throw new Error('expected course_unavailable') },
      (error) => expectCode(error, 'course_unavailable'),
    )
  })

  it('enforces immutable links, cohorts, linked deadlines, and deferred completeness in PostgreSQL', async () => {
    const orgId = org('db-guards')
    const users = await seedUsers(orgId, 1)
    const course = await seedPublishedCourse(orgId, 'db-guards')
    const plan = await seedPlan(orgId, [course.courseVersionId])
    const input = assignmentInput(orgId, plan.planId)
    const created = await assignElearningTrainingPlan(db, input)
    const link = await pool.query(
      `SELECT id, assignment_id
       FROM elearning_training_plan_assignment_items
       WHERE org_id = $1 AND training_plan_assignment_id = $2`,
      [orgId, created.planAssignmentId],
    )
    const linkId = link.rows[0].id as string
    const assignmentId = link.rows[0].assignment_id as string

    await expectSqlState('P0001', () => pool.query(
      `UPDATE elearning_assignments
       SET deadline = '2032-01-01T00:00:00.000Z'
       WHERE org_id = $1 AND id = $2`,
      [orgId, assignmentId],
    ))
    await expectSqlState('P0001', () => pool.query(
      `UPDATE elearning_training_plan_assignment_items
       SET assignment_id = assignment_id
       WHERE org_id = $1 AND id = $2`,
      [orgId, linkId],
    ))
    await expectSqlState('P0001', () => pool.query(
      `UPDATE elearning_training_plan_assignments
       SET member_count = member_count
       WHERE org_id = $1 AND id = $2`,
      [orgId, created.planAssignmentId],
    ))
    await expectSqlState('P0001', () => pool.query(
      `INSERT INTO elearning_assignment_members (
         id, org_id, assignment_id, course_version_id, user_id, source
       ) VALUES ($1, $2, $3, $4, $5, 'rule')`,
      [randomUUID(), orgId, assignmentId, course.courseVersionId, `${NS}-outsider`,],
    ))
    await expectSqlState('P0001', () => pool.query(
      `UPDATE elearning_assignment_members
       SET revoked_at = now(), revoked_by = $3, revocation_reason = 'single-child-revoke'
       WHERE org_id = $1 AND assignment_id = $2 AND user_id = $4`,
      [orgId, assignmentId, input.actorId, users[0]],
    ))
    const activeCohort = await pool.query(
      `SELECT count(*)::integer AS active_members
       FROM elearning_assignment_members
       WHERE org_id = $1 AND assignment_id = $2 AND revoked_at IS NULL`,
      [orgId, assignmentId],
    )
    expect(activeCohort.rows).toEqual([{ active_members: 1 }])

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO elearning_training_plan_assignments (
           id, org_id, training_plan_id, training_plan_version_id,
           source_key, request_hash, request_hash_version, deadline,
           assigned_by, target_snapshot, member_ids, course_count, member_count
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 1, $7, $8, $9::jsonb, $10::text[], 1, 1
         )`,
        [
          randomUUID(),
          orgId,
          plan.planId,
          plan.planVersionId,
          'incomplete-group',
          'a'.repeat(64),
          input.deadline,
          input.actorId,
          JSON.stringify([{ subjectType: 'all', subjectRef: null, includeChildren: false }]),
          users,
        ],
      )
      await expectSqlState('P0001', () => client.query('COMMIT'))
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })

  it('waits on an empty-schema concurrent writer and then refuses rollback without data loss', async () => {
    const schema = `el_plan_assign_down_${process.pid}_${Date.now()}`
    const groupId = randomUUID()
    await pool.query(`CREATE SCHEMA ${schema}`)
    const scratchPool = new Pool({
      connectionString: DATABASE_URL,
      max: 2,
      options: `-c search_path=${schema},public`,
    })
    const migrationPool = new Pool({
      connectionString: DATABASE_URL,
      max: 1,
      options: `-c search_path=${schema},public`,
    })
    const migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: migrationPool }),
    })
    const writer = await scratchPool.connect()
    let rollback: Promise<{ error: unknown }> | null = null
    try {
      await scratchPool.query(
        `CREATE TABLE elearning_training_plan_assignments (
           id uuid PRIMARY KEY,
           org_id text NOT NULL
         )`,
      )
      await scratchPool.query(
        `CREATE TABLE elearning_training_plan_assignment_items (
           id uuid PRIMARY KEY,
           org_id text NOT NULL
         )`,
      )
      await writer.query('BEGIN')
      await writer.query(
        `INSERT INTO elearning_training_plan_assignments (id, org_id)
         VALUES ($1, 'scratch-org')`,
        [groupId],
      )

      let resolveMigrationPid: (pid: number) => void = () => undefined
      const migrationPid = new Promise<number>((resolve) => {
        resolveMigrationPid = resolve
      })
      rollback = migrationDb.transaction().execute(async (trx) => {
        const pid = await sql<{ pid: number }>`
          SELECT pg_backend_pid()::integer AS pid
        `.execute(trx)
        resolveMigrationPid(pid.rows[0].pid)
        await downTrainingPlanAssignments(trx)
      })
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        )
      const pid = await migrationPid

      let waitingLocks: Array<Record<string, unknown>> = []
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const locks = await pool.query(
          `SELECT lock_info.mode, lock_info.granted
           FROM pg_locks lock_info
           JOIN pg_class table_info ON table_info.oid = lock_info.relation
           JOIN pg_namespace namespace_info ON namespace_info.oid = table_info.relnamespace
           WHERE lock_info.pid = $1
             AND namespace_info.nspname = $2
             AND table_info.relname = 'elearning_training_plan_assignments'
             AND lock_info.mode = 'ShareRowExclusiveLock'`,
          [pid, schema],
        )
        waitingLocks = locks.rows
        if (waitingLocks.length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(waitingLocks).toEqual([{
        mode: 'ShareRowExclusiveLock',
        granted: false,
      }])

      await writer.query('COMMIT')
      const rollbackOutcome = await rollback
      expect(rollbackOutcome.error).toBeInstanceOf(Error)
      expect((rollbackOutcome.error as Error).message).toContain(
        TRAINING_PLAN_ASSIGNMENT_DOWN_IN_USE,
      )
      const retained = await scratchPool.query(
        `SELECT id FROM elearning_training_plan_assignments
         WHERE org_id = 'scratch-org' AND id = $1`,
        [groupId],
      )
      expect(retained.rows).toEqual([{ id: groupId }])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
      await rollback
      await migrationDb.destroy()
      await scratchPool.end()
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })
})
