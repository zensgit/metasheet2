/**
 * E-learning L2 B1 assignment lifecycle gate (real PostgreSQL).
 *
 * Assumes content/assessment + watch-progress migrations have already been
 * applied by the caller. Does not call up()/down() and does not write
 * kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  elearningAssignmentRevokeLockKey,
  ElearningAssignmentLifecycleError,
  listElearningAssignmentProgress,
  revokeElearningAssignmentMember,
  type ElearningAssignmentLifecycleDb,
  type ElearningAssignmentLifecycleQueryable,
} from '../../src/services/elearning-assignment-lifecycle'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCoursesDb,
} from '../../src/services/elearning-learner-courses'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning assignment-lifecycle service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-life-${process.pid}-${Date.now().toString(36)}`
const committedOrgIds: string[] = []
const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
]

function sortedMemberIds(): [string, string, string] {
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort()
  return [ids[0]!, ids[1]!, ids[2]!]
}

type PgTarget = Pool | PoolClient

async function exec(target: PgTarget, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PoolLifecycleDb implements ElearningAssignmentLifecycleDb, ElearningLearnerCoursesDb {
  constructor(private readonly target: Pool | PoolClient) {}

  query(sql: string, params?: unknown[]) {
    return exec(this.target, sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningAssignmentLifecycleQueryable) => Promise<T>,
  ): Promise<T> {
    if ('release' in this.target) {
      const client = this.target
      await client.query('BEGIN')
      try {
        const value = await handler({ query: (sql, params) => exec(client, sql, params) })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
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

const db = new PoolLifecycleDb(pool)

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function setTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ALL_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_grading_records WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [org])
    const scopeTables = await pool.query<{ rel: string | null }>(
      `SELECT to_regclass('elearning_scope_revision_rules') AS rel`,
    )
    if (scopeTables.rows[0]?.rel) {
      await pool.query('DELETE FROM elearning_scope_revision_rules WHERE org_id = $1', [org])
      await pool.query(
        `UPDATE elearning_scopes
            SET active_revision_id = NULL, latest_revision_id = NULL
          WHERE org_id = $1`,
        [org],
      )
      await pool.query('DELETE FROM elearning_scope_revisions WHERE org_id = $1', [org])
      await pool.query('DELETE FROM elearning_scopes WHERE org_id = $1', [org])
    }
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [org],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [org])
  } finally {
    await setTriggers(true)
  }
}

async function countOrg(table: string, org: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
    [org],
  )
  return result.rows[0]?.n ?? 0
}

interface Seed {
  org: string
  assignmentId: string
  versionId: string
  videoItemId: string
  examItemId: string
  examId: string
  members: { a: string; b: string; c: string }
  users: { a: string; b: string; c: string }
}

async function seedPublishedCourse(org: string): Promise<{
  versionId: string
  videoItemId: string
  examItemId: string
  examId: string
}> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const videoItemId = randomUUID()
  const examItemId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Lifecycle course', 'active', $3)`,
    [courseId, org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, org, courseId, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
    [mediaId, org, `${NS}/media/${mediaId}`, 'a'.repeat(64), actor('uploader')],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [questionId, org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, explanation, points, created_by
     ) VALUES ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 'secret rationale', 10, $6)`,
    [
      revisionId,
      org,
      questionId,
      JSON.stringify([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Lifecycle exam', 'draft', 10, 3, $3)`,
    [examId, org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [org, examId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES
       ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000),
       ($5, $2, $3, 'exam', 2, NULL, $6, NULL, NULL)`,
    [videoItemId, org, versionId, mediaId, examItemId, examId],
  )
  await pool.query(
    `UPDATE elearning_exams SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [org, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [org, versionId],
  )
  return { versionId, videoItemId, examItemId, examId }
}

async function seedAssignment(org: string): Promise<Seed> {
  const { versionId, videoItemId, examItemId, examId } = await seedPublishedCourse(org)
  const assignmentId = randomUUID()
  const [memberA, memberB, memberC] = sortedMemberIds()
  const users = {
    a: `${org}-user-a`,
    b: `${org}-user-b`,
    c: `${org}-user-c`,
  }
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      assignmentId,
      org,
      versionId,
      `${org}-src-${assignmentId}`,
      `hash-${assignmentId}`,
      '2020-01-01T00:00:00.000Z',
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source, assigned_at
     ) VALUES
       ($1, $4, $5, $6, $7, 'manual', '2026-01-03T00:00:00.000Z'),
       ($2, $4, $5, $6, $8, 'rule', '2026-01-02T00:00:00.000Z'),
       ($3, $4, $5, $6, $9, 'import', '2026-01-01T00:00:00.000Z')`,
    [
      memberA,
      memberB,
      memberC,
      org,
      assignmentId,
      versionId,
      users.a,
      users.b,
      users.c,
    ],
  )
  return {
    org,
    assignmentId,
    versionId,
    videoItemId,
    examItemId,
    examId,
    members: { a: memberA, b: memberB, c: memberC },
    users,
  }
}

async function insertProgress(input: {
  org: string
  memberId: string
  versionId: string
  itemId: string
  userId: string
  status: 'in_progress' | 'completed'
}): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_progress (
       org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, status, effective_ms, max_position_ms, completed_at, required_at_completion
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
    [
      input.org,
      input.memberId,
      input.versionId,
      input.itemId,
      input.userId,
      input.status,
      input.status === 'completed' ? 9000 : 1200,
      input.status === 'completed' ? 10_000 : 900,
      input.status === 'completed' ? new Date().toISOString() : null,
    ],
  )
}

async function insertEvidence(input: {
  org: string
  memberId: string
  versionId: string
  itemId: string
  userId: string
}): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_completion_evidence (
       org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, completion_policy_version, completion_threshold_bps, media_duration_ms,
       effective_ms, max_position_ms, event_digest, evaluator_version, completed_at
     ) VALUES ($1, $2, $3, $4, $5, 'video-v1-90pct', 9000, 10000, 9000, 10000, 'ev', 'eval-v1', now())`,
    [input.org, input.memberId, input.versionId, input.itemId, input.userId],
  )
}

async function insertAttempt(input: {
  org: string
  examId: string
  versionId: string
  itemId: string
  userId: string
  attemptNo: number
  status: 'started' | 'graded'
  passed?: boolean
}): Promise<void> {
  const attemptId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, course_version_item_id, user_id, attempt_no,
       paper_snapshot, answers, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, 'started')`,
    [
      attemptId,
      input.org,
      input.examId,
      input.versionId,
      input.itemId,
      input.userId,
      input.attemptNo,
      JSON.stringify({ domain: 'elearning.exam.paper.v1', secret: 'paper' }),
    ],
  )
  if (input.status === 'started') return
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted',
            answers = $2::jsonb,
            submitted_at = now()
      WHERE org_id = $3 AND id = $1`,
    [attemptId, JSON.stringify({ choice: ['a'] }), input.org],
  )
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'graded',
            auto_score = $2,
            total_score = 10,
            passed = $3,
            graded_at = now()
      WHERE org_id = $4 AND id = $1`,
    [attemptId, input.passed ? 10 : 0, input.passed === true, input.org],
  )
}

afterEach(async () => {
  for (const org of committedOrgIds.splice(0)) {
    await cleanupOrg(org)
  }
})

afterAll(async () => {
  await pool.end()
})

describe('elearning assignment lifecycle (real PostgreSQL)', () => {
  it('paginates members by UUID, aggregates progress, and treats an expired deadline as overdue not revoked', async () => {
    const org = orgId('page')
    committedOrgIds.push(org)
    const seed = await seedAssignment(org)
    await insertProgress({
      org,
      memberId: seed.members.b,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId: seed.users.b,
      status: 'in_progress',
    })
    await insertProgress({
      org,
      memberId: seed.members.c,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId: seed.users.c,
      status: 'completed',
    })
    await insertEvidence({
      org,
      memberId: seed.members.c,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId: seed.users.c,
    })
    await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      itemId: seed.examItemId,
      userId: seed.users.c,
      attemptNo: 1,
      status: 'graded',
      passed: true,
    })

    const first = await listElearningAssignmentProgress(db, {
      orgId: org,
      assignmentId: seed.assignmentId,
      limit: 2,
    })
    expect(first.assignmentId).toBe(seed.assignmentId)
    expect(first.courseVersionId).toBe(seed.versionId)
    expect(first.deadline).toBe('2020-01-01T00:00:00.000Z')
    expect(first.members.map((row) => row.memberId)).toEqual([seed.members.a, seed.members.b])
    expect(first.nextCursor).toBe(seed.members.b)
    expect(first.members[0]).toMatchObject({
      userId: seed.users.a,
      source: 'manual',
      revokedAt: null,
      overdue: true,
      videoStatus: 'not_started',
      examStatus: 'not_started',
      passed: false,
      courseStatus: 'not_started',
    })
    expect(first.members[1]).toMatchObject({
      userId: seed.users.b,
      source: 'rule',
      overdue: true,
      videoStatus: 'in_progress',
      examStatus: 'not_started',
      passed: false,
      courseStatus: 'in_progress',
    })
    expect(JSON.stringify(first)).not.toMatch(/score|answer|storage|revocation_reason|secret rationale/i)

    const second = await listElearningAssignmentProgress(db, {
      orgId: org,
      assignmentId: seed.assignmentId,
      cursor: first.nextCursor,
      limit: 2,
    })
    expect(second.members.map((row) => row.memberId)).toEqual([seed.members.c])
    expect(second.nextCursor).toBeNull()
    expect(second.members[0]).toMatchObject({
      userId: seed.users.c,
      source: 'import',
      overdue: true,
      videoStatus: 'completed',
      examStatus: 'graded',
      passed: true,
      courseStatus: 'completed',
    })

    const overdueLearner = await listElearningLearnerCourses(db, {
      orgId: org,
      userId: seed.users.a,
    })
    expect(overdueLearner.some((course) => course.courseVersionId === seed.versionId)).toBe(true)
  })

  it('isolates lookup and revocation to the authoritative org', async () => {
    const org = orgId('home')
    const other = orgId('away')
    committedOrgIds.push(org, other)
    const seed = await seedAssignment(org)
    const sameOrgOther = await seedAssignment(org)
    const foreign = await seedAssignment(other)

    await expect(listElearningAssignmentProgress(db, {
      orgId: other,
      assignmentId: seed.assignmentId,
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: other,
      actorId: actor('admin'),
      assignmentId: seed.assignmentId,
      memberId: seed.members.a,
      reason: 'left team',
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: org,
      actorId: actor('admin'),
      assignmentId: seed.assignmentId,
      memberId: sameOrgOther.members.a,
      reason: 'left team',
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeElearningAssignmentMember(db, {
      orgId: org,
      actorId: actor('admin'),
      assignmentId: seed.assignmentId,
      memberId: foreign.members.a,
      reason: 'left team',
    })).rejects.toMatchObject({ code: 'not_found' })
    const untouched = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at
         FROM elearning_assignment_members
        WHERE org_id = $1 AND assignment_id = $2 AND id = $3`,
      [org, sameOrgOther.assignmentId, sameOrgOther.members.a],
    )
    expect(untouched.rows).toEqual([{ revoked_at: null }])
  })

  it('revokes once, replays the same reason, conflicts on a different reason, and preserves progress', async () => {
    const org = orgId('revoke')
    committedOrgIds.push(org)
    const seed = await seedAssignment(org)
    await insertProgress({
      org,
      memberId: seed.members.a,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId: seed.users.a,
      status: 'completed',
    })
    await insertEvidence({
      org,
      memberId: seed.members.a,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId: seed.users.a,
    })
    await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      itemId: seed.examItemId,
      userId: seed.users.a,
      attemptNo: 1,
      status: 'graded',
      passed: true,
    })
    const before = {
      members: await countOrg('elearning_assignment_members', org),
      assignments: await countOrg('elearning_assignments', org),
      progress: await countOrg('elearning_progress', org),
      evidence: await countOrg('elearning_completion_evidence', org),
      attempts: await countOrg('elearning_exam_attempts', org),
    }
    const learnerBefore = await listElearningLearnerCourses(db, {
      orgId: org,
      userId: seed.users.a,
    })
    expect(learnerBefore.some((course) => course.courseVersionId === seed.versionId)).toBe(true)

    const first = await revokeElearningAssignmentMember(db, {
      orgId: org,
      actorId: actor('admin'),
      assignmentId: seed.assignmentId,
      memberId: seed.members.a,
      reason: '  left team  ',
    })
    expect(first).toEqual({
      assignmentId: seed.assignmentId,
      memberId: seed.members.a,
      revoked: true,
      duplicate: false,
    })
    const stored = await pool.query<{
      revoked_at: Date
      revoked_by: string
      revocation_reason: string
    }>(
      `SELECT revoked_at, revoked_by, revocation_reason
         FROM elearning_assignment_members
        WHERE org_id = $1 AND id = $2`,
      [org, seed.members.a],
    )
    expect(stored.rows[0]?.revoked_by).toBe(actor('admin'))
    expect(stored.rows[0]?.revocation_reason).toBe('left team')
    expect(stored.rows[0]?.revoked_at).toBeInstanceOf(Date)

    const replay = await revokeElearningAssignmentMember(db, {
      orgId: org,
      actorId: actor('other'),
      assignmentId: seed.assignmentId,
      memberId: seed.members.a,
      reason: 'left team',
    })
    expect(replay.duplicate).toBe(true)
    const afterReplay = await pool.query<{ revoked_by: string; revocation_reason: string }>(
      `SELECT revoked_by, revocation_reason
         FROM elearning_assignment_members
        WHERE org_id = $1 AND id = $2`,
      [org, seed.members.a],
    )
    expect(afterReplay.rows[0]?.revoked_by).toBe(actor('admin'))
    expect(afterReplay.rows[0]?.revocation_reason).toBe('left team')

    await expect(revokeElearningAssignmentMember(db, {
      orgId: org,
      actorId: actor('other'),
      assignmentId: seed.assignmentId,
      memberId: seed.members.a,
      reason: 'different reason',
    })).rejects.toEqual(new ElearningAssignmentLifecycleError('conflict'))

    expect(await countOrg('elearning_assignment_members', org)).toBe(before.members)
    expect(await countOrg('elearning_assignments', org)).toBe(before.assignments)
    expect(await countOrg('elearning_progress', org)).toBe(before.progress)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(before.evidence)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(before.attempts)

    const page = await listElearningAssignmentProgress(db, {
      orgId: org,
      assignmentId: seed.assignmentId,
    })
    const revoked = page.members.find((row) => row.memberId === seed.members.a)
    expect(revoked?.revokedAt).toBeTruthy()
    expect(revoked?.overdue).toBe(false)
    expect(revoked?.videoStatus).toBe('completed')
    expect(revoked?.passed).toBe(true)
    expect(JSON.stringify(page)).not.toMatch(/left team|revocation_reason|revoked_by/)

    const learnerAfter = await listElearningLearnerCourses(db, {
      orgId: org,
      userId: seed.users.a,
    })
    expect(learnerAfter.some((course) => course.courseVersionId === seed.versionId)).toBe(false)
    const stillAssigned = await listElearningLearnerCourses(db, {
      orgId: org,
      userId: seed.users.b,
    })
    expect(stillAssigned.some((course) => course.courseVersionId === seed.versionId)).toBe(true)
  })

  it('serializes concurrent same-reason revoke onto one effect', async () => {
    const org = orgId('race')
    committedOrgIds.push(org)
    const seed = await seedAssignment(org)
    const left = await pool.connect()
    const right = await pool.connect()
    try {
      const results = await Promise.allSettled([
        revokeElearningAssignmentMember(new PoolLifecycleDb(left), {
          orgId: org,
          actorId: actor('left'),
          assignmentId: seed.assignmentId,
          memberId: seed.members.b,
          reason: 'left team',
        }),
        revokeElearningAssignmentMember(new PoolLifecycleDb(right), {
          orgId: org,
          actorId: actor('right'),
          assignmentId: seed.assignmentId,
          memberId: seed.members.b,
          reason: 'left team',
        }),
      ])
      const fulfilled = results
        .filter((row): row is PromiseFulfilledResult<{ duplicate: boolean }> => row.status === 'fulfilled')
        .map((row) => row.value)
      expect(fulfilled).toHaveLength(2)
      expect(fulfilled.filter((row) => row.duplicate === false)).toHaveLength(1)
      expect(fulfilled.filter((row) => row.duplicate === true)).toHaveLength(1)
      const stored = await pool.query<{ n: number; revoked_by: string }>(
        `SELECT count(*)::int AS n, min(revoked_by) AS revoked_by
           FROM elearning_assignment_members
          WHERE org_id = $1 AND id = $2 AND revoked_at IS NOT NULL`,
        [org, seed.members.b],
      )
      expect(stored.rows[0]?.n).toBe(1)
      expect(['left', 'right'].some((suffix) => stored.rows[0]?.revoked_by === actor(suffix))).toBe(true)
      expect(elearningAssignmentRevokeLockKey(org, seed.assignmentId, seed.members.b)).toContain(org)
    } finally {
      left.release()
      right.release()
    }
  })

  it('serializes concurrent different-reason revoke onto one winner and one conflict', async () => {
    const org = orgId('race-diff')
    committedOrgIds.push(org)
    const seed = await seedAssignment(org)
    const left = await pool.connect()
    const right = await pool.connect()
    const leftReason = 'left team'
    const rightReason = 'role change'
    try {
      const results = await Promise.allSettled([
        revokeElearningAssignmentMember(new PoolLifecycleDb(left), {
          orgId: org,
          actorId: actor('left'),
          assignmentId: seed.assignmentId,
          memberId: seed.members.c,
          reason: leftReason,
        }),
        revokeElearningAssignmentMember(new PoolLifecycleDb(right), {
          orgId: org,
          actorId: actor('right'),
          assignmentId: seed.assignmentId,
          memberId: seed.members.c,
          reason: rightReason,
        }),
      ])
      const fulfilled = results.filter(
        (row): row is PromiseFulfilledResult<{
          assignmentId: string
          memberId: string
          revoked: true
          duplicate: boolean
        }> => row.status === 'fulfilled',
      )
      const rejected = results.filter(
        (row): row is PromiseRejectedResult => row.status === 'rejected',
      )
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(fulfilled[0]?.value).toEqual({
        assignmentId: seed.assignmentId,
        memberId: seed.members.c,
        revoked: true,
        duplicate: false,
      })
      expect(rejected[0]?.reason).toEqual(new ElearningAssignmentLifecycleError('conflict'))

      const stored = await pool.query<{
        n: number
        revoked_by: string
        revocation_reason: string
      }>(
        `SELECT count(*)::int AS n, min(revoked_by) AS revoked_by, min(revocation_reason) AS revocation_reason
           FROM elearning_assignment_members
          WHERE org_id = $1 AND id = $2 AND revoked_at IS NOT NULL`,
        [org, seed.members.c],
      )
      expect(stored.rows[0]?.n).toBe(1)
      const winnerBy = stored.rows[0]?.revoked_by
      const winnerReason = stored.rows[0]?.revocation_reason
      expect([actor('left'), actor('right')]).toContain(winnerBy)
      expect(winnerReason).toBe(winnerBy === actor('left') ? leftReason : rightReason)
      expect(await countOrg('elearning_assignment_members', org)).toBe(3)
    } finally {
      left.release()
      right.release()
    }
  })
})
