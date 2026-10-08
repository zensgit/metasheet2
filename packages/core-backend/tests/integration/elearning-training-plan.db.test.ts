/**
 * E-learning L2 training-plan gate against a fully migrated PostgreSQL DB.
 * DATABASE_URL is mandatory; missing infrastructure must fail, never skip.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  COURSE_VERSIONS_STATE_TRIGGER,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import {
  ELEARNING_TRAINING_PLAN_ITEMS_TABLE,
  ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE,
  ELEARNING_TRAINING_PLAN_VERSIONS_TABLE,
  ELEARNING_TRAINING_PLANS_TABLE,
  TRAINING_PLAN_ACTIVE_VERSION_TRIGGER,
  TRAINING_PLAN_ITEM_DRAFT_TRIGGER,
  TRAINING_PLAN_REQUEST_APPEND_ONLY_TRIGGER,
  TRAINING_PLAN_VERSION_STATE_TRIGGER,
} from '../../src/db/migrations/zzzz20260826180000_create_elearning_training_plans'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
} from '../../src/services/elearning-course-publish'
import {
  getElearningTrainingPlan,
  publishElearningTrainingPlan,
  type ElearningTrainingPlanDb,
  type ElearningTrainingPlanQueryable,
} from '../../src/services/elearning-training-plan'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning training-plan DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 6 })
const NS = `el-plan-${Date.now().toString(36)}`
const MIGRATION_NAME = 'zzzz20260826180000_create_elearning_training_plans'

type Queryable = ElearningTrainingPlanQueryable

class ClientDb implements ElearningTrainingPlanDb, ElearningCoursePublishDb {
  private savepoint = 0

  constructor(private readonly client: PoolClient) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as never)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }

  async transaction<T>(handler: (tx: Queryable) => Promise<T>): Promise<T> {
    const name = `elearning_training_plan_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${name}`)
    try {
      const result = await handler({ query: (sql, params) => this.query(sql, params) })
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      return result
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      throw error
    }
  }
}

class PoolDb implements ElearningTrainingPlanDb, ElearningCoursePublishDb {
  constructor(protected readonly targetPool: Pool) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.targetPool.query(sql, params as never)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }

  async transaction<T>(handler: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.targetPool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({
        query: async (sql, params) => {
          const queryResult = await client.query(sql, params as never)
          return {
            rows: queryResult.rows as Array<Record<string, unknown>>,
            rowCount: queryResult.rowCount,
          }
        },
      })
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

class CourseLockBarrierDb extends PoolDb {
  private paused = false
  private readonly reached: Promise<void>
  private readonly released: Promise<void>
  private resolveReached!: () => void
  private resolveReleased!: () => void

  constructor(targetPool: Pool) {
    super(targetPool)
    this.reached = new Promise((resolve) => {
      this.resolveReached = resolve
    })
    this.released = new Promise((resolve) => {
      this.resolveReleased = resolve
    })
  }

  async waitUntilCourseLocksHeld(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.reached,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('timed out waiting for course-version lock barrier')),
            5_000,
          )
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  releaseCourseLocks(): void {
    this.resolveReleased()
  }

  override async transaction<T>(handler: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.targetPool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({
        query: async (sql, params) => {
          const queryResult = await client.query(sql, params as never)
          if (!this.paused && sql.includes('elearning-training-plan:lock-course-versions')) {
            this.paused = true
            this.resolveReached()
            await this.released
          }
          return {
            rows: queryResult.rows as Array<Record<string, unknown>>,
            rowCount: queryResult.rowCount,
          }
        },
      })
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

async function withRolledBackDb(
  run: (client: PoolClient, db: ClientDb) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await run(client, new ClientDb(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function expectSqlState(
  client: PoolClient,
  expected: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const name = `negative_${randomUUID().replaceAll('-', '')}`
  await client.query(`SAVEPOINT ${name}`)
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
  await client.query(`RELEASE SAVEPOINT ${name}`)
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe(expected)
}

async function expectConcurrentLockTimeout(
  sql: string,
  params: unknown[],
): Promise<void> {
  const client = await pool.connect()
  let caught: unknown
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '500ms'")
    try {
      await client.query(sql, params as never)
    } catch (error) {
      caught = error
    }
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe('55P03')
}

function org(label: string): string {
  return `${NS}-${label}`
}

function actor(label: string): string {
  return `${NS}-actor-${label}`
}

async function seedPublishedCourse(
  db: ElearningTrainingPlanDb & ElearningCoursePublishDb,
  orgId: string,
  label: string,
) {
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

async function seedDraftTrainingPlan(
  client: PoolClient,
  orgId: string,
  label: string,
): Promise<{ planId: string; planVersionId: string }> {
  const planId = randomUUID()
  const planVersionId = randomUUID()
  await client.query(
    `INSERT INTO elearning_training_plans
       (id, org_id, title, status, created_by)
     VALUES ($1, $2, $3, 'active', $4)`,
    [planId, orgId, `Draft ${label}`, actor(`draft-${label}`)],
  )
  await client.query(
    `INSERT INTO elearning_training_plan_versions
       (id, org_id, training_plan_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', $4, $5)`,
    [planVersionId, orgId, planId, `Draft ${label}`, actor(`draft-${label}`)],
  )
  return { planId, planVersionId }
}

async function seedPublishedCourseVersionsForLimitTest(
  client: PoolClient,
  orgId: string,
  count: number,
): Promise<string[]> {
  const courseId = randomUUID()
  await client.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'DB limit fixture', 'active', $3)`,
    [courseId, orgId, actor('db-limit')],
  )
  await client.query(
    `ALTER TABLE elearning_course_versions
     DISABLE TRIGGER ${COURSE_VERSIONS_STATE_TRIGGER}`,
  )
  try {
    await client.query(
      `INSERT INTO elearning_course_versions
         (id, org_id, course_id, version, status, title, created_by)
       SELECT gen_random_uuid(), $1, $2, n, 'published', 'DB limit course ' || n, $3
         FROM generate_series(1, $4::integer) AS n`,
      [orgId, courseId, actor('db-limit'), count],
    )
  } finally {
    await client.query(
      `ALTER TABLE elearning_course_versions
       ENABLE TRIGGER ${COURSE_VERSIONS_STATE_TRIGGER}`,
    )
  }
  const rows = await client.query<{ id: string }>(
    `SELECT id
       FROM elearning_course_versions
      WHERE org_id = $1 AND course_id = $2
      ORDER BY version`,
    [orgId, courseId],
  )
  return rows.rows.map((row) => row.id)
}

afterAll(async () => {
  await pool.end()
})

describe.sequential('e-learning training-plan foundation (real PostgreSQL)', () => {
  it('verifies the migrator product, same-org parent keys, FKs, and named guards', async () => {
    const ledger = await pool.query<{ name: string }>(
      'SELECT name FROM kysely_migration WHERE name = $1',
      [MIGRATION_NAME],
    )
    expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        ELEARNING_TRAINING_PLANS_TABLE,
        ELEARNING_TRAINING_PLAN_VERSIONS_TABLE,
        ELEARNING_TRAINING_PLAN_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE,
      ]],
    )
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      ELEARNING_TRAINING_PLAN_ITEMS_TABLE,
      ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE,
      ELEARNING_TRAINING_PLAN_VERSIONS_TABLE,
      ELEARNING_TRAINING_PLANS_TABLE,
    ].sort())

    const orgColumns = await pool.query<{
      table_name: string
      is_nullable: string
      column_default: string | null
    }>(
      `SELECT table_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND column_name = 'org_id'
        ORDER BY table_name`,
      [[
        ELEARNING_TRAINING_PLANS_TABLE,
        ELEARNING_TRAINING_PLAN_VERSIONS_TABLE,
        ELEARNING_TRAINING_PLAN_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE,
      ]],
    )
    expect(orgColumns.rows).toHaveLength(4)
    for (const column of orgColumns.rows) {
      expect(column.is_nullable).toBe('NO')
      expect(column.column_default).toBeNull()
    }

    const constraints = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = ANY($1::regclass[])
        ORDER BY conname`,
      [[
        ELEARNING_TRAINING_PLANS_TABLE,
        ELEARNING_TRAINING_PLAN_VERSIONS_TABLE,
        ELEARNING_TRAINING_PLAN_ITEMS_TABLE,
        ELEARNING_TRAINING_PLAN_PUBLISH_REQUESTS_TABLE,
      ]],
    )
    const byName = new Map(constraints.rows.map((row) => [row.conname, row.def]))
    expect(byName.get('elearning_training_plans_active_version_fk')).toContain(
      'FOREIGN KEY (org_id, id, active_version_id)',
    )
    expect(byName.get('elearning_training_plans_latest_version_fk')).toContain(
      'FOREIGN KEY (org_id, id, latest_version_id)',
    )
    expect(byName.get('elearning_training_plan_items_course_version_fk')).toContain(
      'FOREIGN KEY (org_id, course_version_id)',
    )
    expect(byName.get('elearning_training_plan_requests_version_fk')).toContain(
      'FOREIGN KEY (org_id, training_plan_id, training_plan_version_id)',
    )
    for (const name of [
      'elearning_training_plans_active_version_fk',
      'elearning_training_plans_latest_version_fk',
      'elearning_training_plan_items_version_fk',
      'elearning_training_plan_items_course_version_fk',
      'elearning_training_plan_requests_plan_fk',
      'elearning_training_plan_requests_version_fk',
    ]) {
      expect(byName.get(name)).toContain('ON DELETE RESTRICT')
    }

    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
          AND tgname = ANY($1::text[])
        ORDER BY tgname`,
      [[
        TRAINING_PLAN_ACTIVE_VERSION_TRIGGER,
        TRAINING_PLAN_VERSION_STATE_TRIGGER,
        TRAINING_PLAN_ITEM_DRAFT_TRIGGER,
        TRAINING_PLAN_REQUEST_APPEND_ONLY_TRIGGER,
      ]],
    )
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      TRAINING_PLAN_ACTIVE_VERSION_TRIGGER,
      TRAINING_PLAN_ITEM_DRAFT_TRIGGER,
      TRAINING_PLAN_REQUEST_APPEND_ONLY_TRIGGER,
      TRAINING_PLAN_VERSION_STATE_TRIGGER,
    ].sort())
  })

  it('publishes an ordered pinned plan and reads the exact active-version DTO', async () => {
    await withRolledBackDb(async (_client, db) => {
      const orgId = org('happy')
      const courseA = await seedPublishedCourse(db, orgId, 'a')
      const courseB = await seedPublishedCourse(db, orgId, 'b')
      const result = await publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Onboarding plan',
        items: [
          { courseVersionId: courseB.courseVersionId, required: false },
          { courseVersionId: courseA.courseVersionId, required: true },
        ],
      })
      expect(result).toEqual({
        planId: expect.any(String),
        planVersionId: expect.any(String),
        status: 'published',
        itemCount: 2,
        duplicate: false,
      })
      await expect(getElearningTrainingPlan(db, {
        orgId,
        planId: result.planId,
      })).resolves.toEqual({
        planId: result.planId,
        title: 'Onboarding plan',
        status: 'active',
        activeVersion: {
          planVersionId: result.planVersionId,
          version: 1,
          status: 'published',
          items: [
            { courseVersionId: courseB.courseVersionId, position: 1, required: false },
            { courseVersionId: courseA.courseVersionId, position: 2, required: true },
          ],
        },
      })
      const pointers = await db.query(
        `SELECT active_version_id, latest_version_id
           FROM elearning_training_plans
          WHERE org_id = $1 AND id = $2`,
        [orgId, result.planId],
      )
      expect(pointers.rows).toEqual([{
        active_version_id: result.planVersionId,
        latest_version_id: result.planVersionId,
      }])
    })
  })

  it('enforces all three idempotency states and org-scoped reads', async () => {
    await withRolledBackDb(async (_client, db) => {
      const orgA = org('idem-a')
      const orgB = org('idem-b')
      const courseA = await seedPublishedCourse(db, orgA, 'idem-a')
      const courseB = await seedPublishedCourse(db, orgB, 'idem-b')
      const requestId = randomUUID()
      const first = await publishElearningTrainingPlan(db, {
        orgId: orgA,
        actorId: actor('first'),
        requestId,
        title: 'Idempotent plan',
        items: [{ courseVersionId: courseA.courseVersionId, required: true }],
      })
      const replay = await publishElearningTrainingPlan(db, {
        orgId: orgA,
        actorId: actor('retry'),
        requestId,
        title: 'Idempotent plan',
        items: [{ courseVersionId: courseA.courseVersionId, required: true }],
      })
      expect(replay).toEqual({ ...first, duplicate: true })
      await expect(publishElearningTrainingPlan(db, {
        orgId: orgA,
        actorId: actor('conflict'),
        requestId,
        title: 'Changed plan',
        items: [{ courseVersionId: courseA.courseVersionId, required: true }],
      })).rejects.toMatchObject({ code: 'conflict' })

      const isolated = await publishElearningTrainingPlan(db, {
        orgId: orgB,
        actorId: actor('other-org'),
        requestId,
        title: 'Other org plan',
        items: [{ courseVersionId: courseB.courseVersionId, required: true }],
      })
      expect(isolated.planId).not.toBe(first.planId)
      await expect(getElearningTrainingPlan(db, {
        orgId: orgB,
        planId: first.planId,
      })).rejects.toMatchObject({ code: 'not_found' })
    })
  })

  it('serializes concurrent retries into one append-only publish effect', async () => {
    const db = new PoolDb(pool)
    const orgId = org('idem-race')
    const course = await seedPublishedCourse(db, orgId, 'idem-race')
    const input = {
      orgId,
      actorId: actor('idem-race'),
      requestId: randomUUID(),
      title: 'Concurrent idempotent plan',
      items: [{ courseVersionId: course.courseVersionId, required: true }],
    }

    const results = await Promise.all([
      publishElearningTrainingPlan(db, input),
      publishElearningTrainingPlan(db, input),
    ])
    expect(new Set(results.map((result) => result.planId)).size).toBe(1)
    expect(new Set(results.map((result) => result.planVersionId)).size).toBe(1)
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])

    const effects = await db.query(
      `SELECT
         (SELECT count(*)::integer
            FROM elearning_training_plan_publish_requests
           WHERE org_id = $1 AND source_key = $2) AS request_count,
         (SELECT count(*)::integer
            FROM elearning_training_plans
           WHERE org_id = $1 AND id = $3) AS plan_count`,
      [orgId, input.requestId, results[0]?.planId],
    )
    expect(effects.rows).toEqual([{ request_count: 1, plan_count: 1 }])
  })

  it('holds course-head and course-version locks through publication', async () => {
    const setupDb = new PoolDb(pool)
    const orgId = org('course-locks')
    const course = await seedPublishedCourse(setupDb, orgId, 'course-locks')
    await setupDb.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [orgId, course.courseId],
    )

    const barrierDb = new CourseLockBarrierDb(pool)
    const pendingPublish = publishElearningTrainingPlan(barrierDb, {
      orgId,
      actorId: actor('course-locks'),
      requestId: randomUUID(),
      title: 'Course lock plan',
      items: [{ courseVersionId: course.courseVersionId, required: true }],
    })

    let verificationError: unknown
    try {
      await barrierDb.waitUntilCourseLocksHeld()
      await expectConcurrentLockTimeout(
        `UPDATE elearning_courses SET status = 'archived', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, course.courseId],
      )
      await expectConcurrentLockTimeout(
        `UPDATE elearning_course_versions SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, course.courseVersionId],
      )
    } catch (error) {
      verificationError = error
    } finally {
      barrierDb.releaseCourseLocks()
    }

    const result = await pendingPublish
    if (verificationError) throw verificationError
    expect(result).toEqual({
      planId: expect.any(String),
      planVersionId: expect.any(String),
      status: 'published',
      itemCount: 1,
      duplicate: false,
    })
    const sourceState = await setupDb.query(
      `SELECT c.status AS course_status, cv.status AS version_status
         FROM elearning_courses c
         JOIN elearning_course_versions cv
           ON cv.org_id = c.org_id AND cv.course_id = c.id
        WHERE c.org_id = $1 AND c.id = $2 AND cv.id = $3`,
      [orgId, course.courseId, course.courseVersionId],
    )
    expect(sourceState.rows).toEqual([{
      course_status: 'active',
      version_status: 'published',
    }])
  })

  it('rejects archived course heads and retired course versions for new plans', async () => {
    await withRolledBackDb(async (_client, db) => {
      const orgId = org('unavailable')
      const archived = await seedPublishedCourse(db, orgId, 'archived')
      await db.query(
        `UPDATE elearning_courses SET status = 'archived'
          WHERE org_id = $1 AND id = $2`,
        [orgId, archived.courseId],
      )
      await expect(publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Archived source',
        items: [{ courseVersionId: archived.courseVersionId, required: true }],
      })).rejects.toMatchObject({ code: 'course_unavailable' })

      const retired = await seedPublishedCourse(db, orgId, 'retired')
      await db.query(
        `UPDATE elearning_courses
            SET active_version_id = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, retired.courseId],
      )
      await db.query(
        `UPDATE elearning_course_versions
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, retired.courseVersionId],
      )
      await expect(publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Retired source',
        items: [{ courseVersionId: retired.courseVersionId, required: true }],
      })).rejects.toMatchObject({ code: 'course_unavailable' })
    })
  })

  it('freezes published plan content and the append-only request ledger', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('immutable')
      const course = await seedPublishedCourse(db, orgId, 'immutable')
      const result = await publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Frozen plan',
        items: [{ courseVersionId: course.courseVersionId, required: true }],
      })
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_items SET required = FALSE
          WHERE org_id = $1 AND training_plan_version_id = $2`,
        [orgId, result.planVersionId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_publish_requests SET item_count = 2
          WHERE org_id = $1 AND training_plan_id = $2`,
        [orgId, result.planId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `DELETE FROM elearning_training_plan_publish_requests
          WHERE org_id = $1 AND training_plan_id = $2`,
        [orgId, result.planId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_versions
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, result.planVersionId],
      ))
    })
  })

  it('enforces same-org course references and non-empty publication in the DB', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgA = org('fk-a')
      const orgB = org('fk-b')
      const course = await seedPublishedCourse(db, orgA, 'fk')
      const planId = randomUUID()
      const versionId = randomUUID()
      await client.query(
        `INSERT INTO elearning_training_plans
           (id, org_id, title, status, created_by)
         VALUES ($1, $2, 'Draft plan', 'active', $3)`,
        [planId, orgB, actor('draft')],
      )
      await client.query(
        `INSERT INTO elearning_training_plan_versions
           (id, org_id, training_plan_id, version, status, title, created_by)
         VALUES ($1, $2, $3, 1, 'draft', 'Draft plan', $4)`,
        [versionId, orgB, planId, actor('draft')],
      )
      await expectSqlState(client, '23503', () => client.query(
        `INSERT INTO elearning_training_plan_items (
           org_id, training_plan_version_id, course_version_id, position, required
         ) VALUES ($1, $2, $3, 1, TRUE)`,
        [orgB, versionId, course.courseVersionId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_versions
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgB, versionId],
      ))
    })
  })

  it('enforces the 1..100 dense-position contract inside the DB trigger', async () => {
    await withRolledBackDb(async (client, db) => {
      const sparseOrg = org('sparse-position')
      const sparseCourse = await seedPublishedCourse(db, sparseOrg, 'sparse-position')
      const sparse = await seedDraftTrainingPlan(client, sparseOrg, 'sparse-position')
      await client.query(
        `INSERT INTO elearning_training_plan_items (
           org_id, training_plan_version_id, course_version_id, position, required
         ) VALUES ($1, $2, $3, 101, TRUE)`,
        [sparseOrg, sparse.planVersionId, sparseCourse.courseVersionId],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_versions
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [sparseOrg, sparse.planVersionId],
      ))

      const oversizedOrg = org('oversized')
      const courseVersionIds = await seedPublishedCourseVersionsForLimitTest(
        client,
        oversizedOrg,
        101,
      )
      expect(courseVersionIds).toHaveLength(101)
      const oversized = await seedDraftTrainingPlan(client, oversizedOrg, 'oversized')
      await client.query(
        `INSERT INTO elearning_training_plan_items (
           org_id, training_plan_version_id, course_version_id, position, required
         )
         SELECT $1, $2, u.course_version_id, u.position::integer, TRUE
           FROM unnest($3::uuid[]) WITH ORDINALITY
             AS u(course_version_id, position)`,
        [oversizedOrg, oversized.planVersionId, courseVersionIds],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plan_versions
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [oversizedOrg, oversized.planVersionId],
      ))
    })
  })

  it('rejects a head pointer to another plan or to a same-plan draft version', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgId = org('pointer')
      const course = await seedPublishedCourse(db, orgId, 'pointer')
      const first = await publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'First plan',
        items: [{ courseVersionId: course.courseVersionId, required: true }],
      })
      const second = await publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Second plan',
        items: [{ courseVersionId: course.courseVersionId, required: true }],
      })
      await expectSqlState(client, '23503', () => client.query(
        `UPDATE elearning_training_plans SET active_version_id = $1
          WHERE org_id = $2 AND id = $3`,
        [second.planVersionId, orgId, first.planId],
      ))

      const draftVersionId = randomUUID()
      await client.query(
        `INSERT INTO elearning_training_plan_versions (
           id, org_id, training_plan_id, version, status, title, created_by
         ) VALUES ($1, $2, $3, 2, 'draft', 'First plan draft', $4)`,
        [draftVersionId, orgId, first.planId, actor('draft')],
      )
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_training_plans SET active_version_id = $1
          WHERE org_id = $2 AND id = $3`,
        [draftVersionId, orgId, first.planId],
      ))
    })
  })

  it('keeps an existing plan readable after its pinned course version retires', async () => {
    await withRolledBackDb(async (_client, db) => {
      const orgId = org('history')
      const course = await seedPublishedCourse(db, orgId, 'history')
      const plan = await publishElearningTrainingPlan(db, {
        orgId,
        actorId: actor('publisher'),
        requestId: randomUUID(),
        title: 'Historical plan',
        items: [{ courseVersionId: course.courseVersionId, required: true }],
      })
      await db.query(
        `UPDATE elearning_courses
            SET active_version_id = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, course.courseId],
      )
      await db.query(
        `UPDATE elearning_course_versions
            SET status = 'retired', updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, course.courseVersionId],
      )
      const stored = await getElearningTrainingPlan(db, {
        orgId,
        planId: plan.planId,
      })
      expect(stored.activeVersion.items).toEqual([{
        courseVersionId: course.courseVersionId,
        position: 1,
        required: true,
      }])
    })
  })
})
