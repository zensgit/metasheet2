import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  assignElearningBatch,
  ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT,
  ElearningBatchAssignmentError,
  type ElearningBatchAssignmentDb,
  type ElearningBatchAssignmentQueryable,
} from '../../src/services/elearning-batch-assignment'
import {
  assignElearningDirect,
  ElearningDirectAssignmentError,
} from '../../src/services/elearning-direct-assignment'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning batch-assignment service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-batch-${process.pid}-${Date.now().toString(36)}`
const committedOrgIds: string[] = []
const CLEANUP_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
]

type PgTarget = Pool | PoolClient

async function exec(target: PgTarget, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PoolBatchDb implements ElearningBatchAssignmentDb {
  async query(sql: string, params?: unknown[]) {
    return exec(pool, sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningBatchAssignmentQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({ query: (sql, params) => exec(client, sql, params) })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }
}

function wrapBatchDb(
  base: ElearningBatchAssignmentDb,
  afterQuery: (sql: string) => Promise<void>,
): ElearningBatchAssignmentDb {
  const run = async (
    query: ElearningBatchAssignmentQueryable['query'],
    sql: string,
    params?: unknown[],
  ) => {
    const result = await query(sql, params)
    await afterQuery(sql)
    return result
  }
  return {
    query: (sql, params) => run(base.query.bind(base), sql, params),
    transaction: (handler) => base.transaction((tx) =>
      handler({ query: (sql, params) => run(tx.query.bind(tx), sql, params) })),
  }
}

class TransactionalClientDb implements ElearningBatchAssignmentDb {
  private savepoint = 0
  readonly queries: string[] = []

  constructor(private readonly client: PoolClient) {}

  async query(sql: string, params?: unknown[]) {
    this.queries.push(sql)
    const result = await this.client.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  }

  async transaction<T>(
    handler: (tx: ElearningBatchAssignmentQueryable) => Promise<T>,
  ): Promise<T> {
    const name = `elearning_batch_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${name}`)
    try {
      const value = await handler({ query: (sql, params) => this.query(sql, params) })
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      return value
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      throw error
    }
  }
}

async function withRolledBackDb(
  run: (client: PoolClient, db: TransactionalClientDb) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await run(client, new TransactionalClientDb(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

function actor(label: string): string {
  return `${NS}-${label}`
}

async function seedPublishedCourse(
  client: PgTarget,
  orgId: string,
): Promise<{ courseId: string; versionId: string }> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const author = actor(`author-${randomUUID().slice(0, 8)}`)

  await client.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Batch course', 'active', $3)`,
    [courseId, orgId, author],
  )
  await client.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, orgId, courseId, author],
  )
  await client.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
    [
      mediaId,
      orgId,
      `${NS}/media/${mediaId}`,
      'a'.repeat(64),
      author,
    ],
  )
  await client.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [questionId, orgId, author],
  )
  await client.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt,
       options, answer_key, points, created_by
     ) VALUES (
       $1, $2, $3, 1, 'single_choice', 'Pick one',
       $4::jsonb, $5::jsonb, 10, $6
     )`,
    [
      revisionId,
      orgId,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      author,
    ],
  )
  await client.query(
    `INSERT INTO elearning_exams
       (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Batch exam', 'draft', 10, 3, $3)`,
    [examId, orgId, author],
  )
  await client.query(
    `INSERT INTO elearning_exam_questions
       (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [orgId, examId, revisionId],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000)`,
    [videoItemId, orgId, versionId, mediaId],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items (
       org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, 'exam', 2, NULL, $3, NULL, NULL)`,
    [orgId, versionId, examId],
  )
  await client.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, examId],
  )
  await client.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, versionId],
  )
  return { courseId, versionId }
}

async function seedUsers(
  client: PgTarget,
  orgId: string,
  count: number,
  prefix = actor(`users-${randomUUID().slice(0, 8)}`),
): Promise<string[]> {
  await client.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     )
     SELECT
       $1 || '-' || n,
       md5($1 || ':' || n::text) || '@batch-gate.test',
       $1 || '-' || n,
       'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     FROM generate_series(1, $2::integer) AS series(n)`,
    [prefix, count],
  )
  await client.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     SELECT $1 || '-' || n, $2, TRUE
     FROM generate_series(1, $3::integer) AS series(n)`,
    [prefix, orgId, count],
  )
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`)
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningBatchAssignmentError)
  expect((error as ElearningBatchAssignmentError).code).toBe(code)
  const blob = `${(error as Error).message}\n${(error as Error).stack ?? ''}`
  expect(blob).not.toContain(NS)
}

async function setCleanupTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of CLEANUP_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(orgId: string): Promise<void> {
  await setCleanupTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [orgId])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [orgId])
    const memberships = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM user_orgs WHERE org_id = $1',
      [orgId],
    )
    await pool.query('DELETE FROM user_orgs WHERE org_id = $1', [orgId])
    const userIds = memberships.rows.map((row) => row.user_id)
    if (userIds.length > 0) {
      await pool.query(
        `DELETE FROM users
          WHERE id = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM user_orgs uo WHERE uo.user_id = users.id
            )`,
        [userIds],
      )
    }
  } finally {
    await setCleanupTriggers(true)
  }
}

describe('e-learning L2 batch-assignment service (real PostgreSQL)', () => {
  afterEach(async () => {
    for (const orgId of committedOrgIds.splice(0)) await cleanupOrg(orgId)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('materializes once, replays without re-resolving, conflicts with direct, and isolates orgs', async () => {
    await withRolledBackDb(async (client, db) => {
      const orgA = actor(`org-a-${randomUUID().slice(0, 8)}`)
      const orgB = actor(`org-b-${randomUUID().slice(0, 8)}`)
      const courseA = await seedPublishedCourse(client, orgA)
      const courseB = await seedPublishedCourse(client, orgB)
      const usersA = await seedUsers(client, orgA, 2)
      await seedUsers(client, orgB, 1)
      const sourceKey = actor('shared-source')

      const first = await assignElearningBatch(db, {
        orgId: orgA,
        actorId: actor('assigner-a'),
        courseVersionId: courseA.versionId,
        sourceKey,
        deadline: '2026-12-31T16:00:00+08:00',
        rules: [{ subjectType: 'all' }, { subjectType: 'all', subjectRef: null }],
      })
      expect(first).toEqual({
        assignmentId: expect.any(String),
        memberCount: 2,
        duplicate: false,
      })
      const stored = await client.query(
        `SELECT target_snapshot, deadline, request_hash_version
           FROM elearning_assignments
          WHERE org_id = $1 AND id = $2`,
        [orgA, first.assignmentId],
      )
      expect(stored.rows).toEqual([{
        target_snapshot: [{ subjectType: 'all', subjectRef: null, includeChildren: false }],
        deadline: new Date('2026-12-31T08:00:00.000Z'),
        request_hash_version: 1,
      }])
      const members = await client.query(
        `SELECT user_id, source
           FROM elearning_assignment_members
          WHERE org_id = $1 AND assignment_id = $2
          ORDER BY user_id`,
        [orgA, first.assignmentId],
      )
      expect(members.rows).toEqual(usersA.sort().map((userId) => ({
        user_id: userId,
        source: 'rule',
      })))

      const audienceQueries = db.queries.filter(
        (sql) => sql.includes('elearning-audience:resolve-membership'),
      ).length
      await client.query(
        `UPDATE user_orgs SET is_active = FALSE WHERE org_id = $1`,
        [orgA],
      )
      const replay = await assignElearningBatch(db, {
        orgId: orgA,
        actorId: actor('different-assigner'),
        courseVersionId: courseA.versionId,
        sourceKey,
        deadline: '2026-12-31T08:00:00.000Z',
        rules: [{ subjectType: 'all' }],
      })
      expect(replay).toEqual({ ...first, duplicate: true })
      expect(db.queries.filter(
        (sql) => sql.includes('elearning-audience:resolve-membership'),
      )).toHaveLength(audienceQueries)

      await expect(assignElearningBatch(db, {
        orgId: orgA,
        actorId: actor('assigner-a'),
        courseVersionId: courseA.versionId,
        sourceKey,
        deadline: null,
        rules: [{ subjectType: 'all' }],
      })).rejects.toMatchObject({ code: 'conflict' })
      await expect(assignElearningDirect(db, {
        orgId: orgA,
        actorId: actor('assigner-a'),
        targetUserId: usersA[0],
        courseVersionId: courseA.versionId,
        sourceKey,
        deadline: '2026-12-31T08:00:00.000Z',
      })).rejects.toBeInstanceOf(ElearningDirectAssignmentError)

      const independent = await assignElearningBatch(db, {
        orgId: orgB,
        actorId: actor('assigner-b'),
        courseVersionId: courseB.versionId,
        sourceKey,
        rules: [{ subjectType: 'all' }],
      })
      expect(independent).toMatchObject({ memberCount: 1, duplicate: false })
      expect(independent.assignmentId).not.toBe(first.assignmentId)
    })
  })

  it('converges concurrent identical requests onto one committed assignment', async () => {
    const orgId = actor(`org-race-${randomUUID().slice(0, 8)}`)
    committedOrgIds.push(orgId)
    const course = await seedPublishedCourse(pool, orgId)
    await seedUsers(pool, orgId, 3)
    const input = {
      orgId,
      actorId: actor('race-assigner'),
      courseVersionId: course.versionId,
      sourceKey: actor('race-source'),
      deadline: null,
      rules: [{ subjectType: 'all' }],
    }

    const raced = await Promise.all([
      assignElearningBatch(new PoolBatchDb(), input),
      assignElearningBatch(new PoolBatchDb(), input),
    ])
    expect(raced[0].assignmentId).toBe(raced[1].assignmentId)
    expect(raced.map((row) => row.duplicate).sort()).toEqual([false, true])
    expect(raced.map((row) => row.memberCount)).toEqual([3, 3])
    const effects = await pool.query<{ assignments: number; members: number }>(
      `SELECT
         (SELECT count(*)::int FROM elearning_assignments WHERE org_id = $1) AS assignments,
         (SELECT count(*)::int FROM elearning_assignment_members WHERE org_id = $1) AS members`,
      [orgId],
    )
    expect(effects.rows).toEqual([{ assignments: 1, members: 3 }])
  })

  it('rolls back if a resolved member loses active org membership before materialization', async () => {
    const orgId = actor(`org-drift-${randomUUID().slice(0, 8)}`)
    committedOrgIds.push(orgId)
    const course = await seedPublishedCourse(pool, orgId)
    const [userId] = await seedUsers(pool, orgId, 1)
    let signalResolved!: () => void
    const resolved = new Promise<void>((resolve) => {
      signalResolved = resolve
    })
    let resumeAssignment!: () => void
    const assignmentMayContinue = new Promise<void>((resolve) => {
      resumeAssignment = resolve
    })
    const db = wrapBatchDb(new PoolBatchDb(), async (sql) => {
      if (!sql.includes('elearning-audience:resolve-membership')) return
      signalResolved()
      await assignmentMayContinue
    })
    const pending = assignElearningBatch(db, {
      orgId,
      actorId: actor('drift-assigner'),
      courseVersionId: course.versionId,
      sourceKey: actor('drift-source'),
      deadline: null,
      rules: [{ subjectType: 'all' }],
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )

    await resolved
    await pool.query(
      `UPDATE user_orgs
          SET is_active = FALSE
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    )
    resumeAssignment()
    const result = await pending
    expect(result).toEqual({ error: expect.any(ElearningBatchAssignmentError) })
    expect((result as { error: ElearningBatchAssignmentError }).error.code).toBe('unavailable')
    const effects = await pool.query<{ assignments: number; members: number }>(
      `SELECT
         (SELECT count(*)::int FROM elearning_assignments WHERE org_id = $1) AS assignments,
         (SELECT count(*)::int FROM elearning_assignment_members WHERE org_id = $1) AS members`,
      [orgId],
    )
    expect(effects.rows).toEqual([{ assignments: 0, members: 0 }])
  })

  it('rejects unsupported, missing, empty, and unavailable targets without effects', async () => {
    await withRolledBackDb(async (client, db) => {
      const org = actor(`org-negative-${randomUUID().slice(0, 8)}`)
      const otherOrg = actor(`org-other-${randomUUID().slice(0, 8)}`)
      const course = await seedPublishedCourse(client, org)
      const [otherUser] = await seedUsers(client, otherOrg, 1)

      await expect(assignElearningBatch(db, {
        orgId: org,
        actorId: actor('assigner'),
        courseVersionId: course.versionId,
        sourceKey: actor('role-source'),
        rules: [{ subjectType: 'role', subjectRef: 'manager' }],
      })).rejects.toMatchObject({ code: 'unsupported_subject' })
      await expect(assignElearningBatch(db, {
        orgId: org,
        actorId: actor('assigner'),
        courseVersionId: course.versionId,
        sourceKey: actor('cross-org-source'),
        rules: [{ subjectType: 'user', subjectRef: otherUser }],
      })).rejects.toMatchObject({ code: 'subject_not_found' })
      let emptyError: unknown
      try {
        await assignElearningBatch(db, {
          orgId: org,
          actorId: actor('assigner'),
          courseVersionId: course.versionId,
          sourceKey: actor('empty-source'),
          rules: [],
        })
      } catch (error) {
        emptyError = error
      }
      expectCode(emptyError, 'empty_audience')

      await client.query(
        `UPDATE elearning_courses SET status = 'archived'
          WHERE org_id = $1 AND id = $2`,
        [org, course.courseId],
      )
      await expect(assignElearningBatch(db, {
        orgId: org,
        actorId: actor('assigner'),
        courseVersionId: course.versionId,
        sourceKey: actor('archived-source'),
        rules: [{ subjectType: 'all' }],
      })).rejects.toMatchObject({ code: 'course_unavailable' })

      const effects = await client.query<{ assignments: number; members: number }>(
        `SELECT
           (SELECT count(*)::int FROM elearning_assignments WHERE org_id = $1) AS assignments,
           (SELECT count(*)::int FROM elearning_assignment_members WHERE org_id = $1) AS members`,
        [org],
      )
      expect(effects.rows).toEqual([{ assignments: 0, members: 0 }])
    })
  })

  it('accepts exactly 10,000 current members and rejects 10,001 in the real resolver', async () => {
    await withRolledBackDb(async (client, db) => {
      const org = actor(`org-boundary-${randomUUID().slice(0, 8)}`)
      const course = await seedPublishedCourse(client, org)
      const users = await seedUsers(
        client,
        org,
        ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT + 1,
      )
      await client.query(
        `UPDATE user_orgs SET is_active = FALSE WHERE org_id = $1 AND user_id = $2`,
        [org, users.at(-1)],
      )
      const exact = await assignElearningBatch(db, {
        orgId: org,
        actorId: actor('assigner'),
        courseVersionId: course.versionId,
        sourceKey: actor('exact-limit'),
        rules: [{ subjectType: 'all' }],
      })
      expect(exact.memberCount).toBe(ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT)
      const materialized = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM elearning_assignment_members
          WHERE org_id = $1 AND assignment_id = $2`,
        [org, exact.assignmentId],
      )
      expect(materialized.rows).toEqual([{ count: ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT }])

      await client.query(
        `UPDATE user_orgs SET is_active = TRUE WHERE org_id = $1 AND user_id = $2`,
        [org, users.at(-1)],
      )
      await expect(assignElearningBatch(db, {
        orgId: org,
        actorId: actor('assigner'),
        courseVersionId: course.versionId,
        sourceKey: actor('over-limit'),
        rules: [{ subjectType: 'all' }],
      })).rejects.toMatchObject({ code: 'audience_too_large' })
      const over = await client.query(
        `SELECT id FROM elearning_assignments WHERE org_id = $1 AND source_key = $2`,
        [org, actor('over-limit')],
      )
      expect(over.rows).toEqual([])
    })
  }, 60_000)
})
