/**
 * Online training closed-loop gate (real PostgreSQL).
 *
 * Proves one visible self-study learner can register, complete the server-owned
 * video progress policy, submit an objective exam, and read the resulting
 * score without creating an assignment or accepting client completion truth.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  enrollElearningCourse,
  type ElearningCourseEnrollmentQueryable,
} from '../../src/services/elearning-course-enrollment'
import {
  getElearningExamReview,
} from '../../src/services/elearning-exam-review'
import {
  startElearningExam,
  submitElearningExam,
  type ElearningExamQueryable,
} from '../../src/services/elearning-exam'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCoursesQueryable,
} from '../../src/services/elearning-learner-courses'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchQueryable,
} from '../../src/services/elearning-watch-progress'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'online training loop DB gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-loop-${randomUUID().slice(0, 8)}`
const tracked = new Set<{ orgId: string; userId: string }>()

type Queryable = ElearningCourseEnrollmentQueryable
  & ElearningExamQueryable
  & ElearningLearnerCoursesQueryable
  & ElearningWatchQueryable

async function queryTarget(
  target: Pool | PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

const db = {
  query: (text: string, params?: unknown[]) => queryTarget(pool, text, params),
  async transaction<T>(handler: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({
        query: (text, params) => queryTarget(client, text, params),
      })
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
}

interface Seed {
  orgId: string
  userId: string
  courseId: string
  versionId: string
  videoItemId: string
  examItemId: string
  questionRevisionId: string
}

async function seedVisibleVideoExamCourse(): Promise<Seed> {
  const suffix = randomUUID().slice(0, 8)
  const orgId = `${NS}-org-${suffix}`
  const userId = `${NS}-learner-${suffix}`
  const authorId = `${NS}-author`
  const courseId = randomUUID()
  const versionId = randomUUID()
  const scopeId = randomUUID()
  const scopeRevisionId = randomUUID()
  const scopeRuleId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()
  const questionId = randomUUID()
  const questionRevisionId = randomUUID()
  const examId = randomUUID()
  const examItemId = randomUUID()
  tracked.add({ orgId, userId })

  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, 'Online learner', 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     )`,
    [userId, `${userId}@training-loop.test`],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
  await pool.query(
    `INSERT INTO elearning_scopes (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [scopeId, orgId, authorId],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revisions
       (id, org_id, scope_id, revision, actor_id, reason)
     VALUES ($1, $2, $3, 1, $4, 'online self-study')`,
    [scopeRevisionId, orgId, scopeId, authorId],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revision_rules
       (id, org_id, scope_revision_id, subject_type, subject_ref, include_children)
     VALUES ($1, $2, $3, 'all', NULL, FALSE)`,
    [scopeRuleId, orgId, scopeRevisionId],
  )
  await pool.query(
    `UPDATE elearning_scopes
        SET active_revision_id = $3, latest_revision_id = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, scopeId, scopeRevisionId],
  )
  await pool.query(
    `INSERT INTO elearning_courses
       (id, org_id, title, status, created_by, scope_id)
     VALUES ($1, $2, 'Online safety course', 'active', $3, $4)`,
    [courseId, orgId, authorId, scopeId],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Online safety course v1', $4)`,
    [versionId, orgId, courseId, authorId],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES (
       $1, $2, $3, 'video/mp4', 'video/mp4', 1024,
       $4, 10000, 'ready', $5
     )`,
    [mediaId, orgId, `${NS}/media/${mediaId}`, 'a'.repeat(64), authorId],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [questionId, orgId, authorId],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt,
       options, answer_key, explanation, points, created_by
     ) VALUES (
       $1, $2, $3, 1, 'single_choice', 'Choose the safe action',
       $4::jsonb, $5::jsonb, 'private explanation', 10, $6
     )`,
    [
      questionRevisionId,
      orgId,
      questionId,
      JSON.stringify([
        { id: 'safe', text: 'Follow the procedure' },
        { id: 'unsafe', text: 'Skip the procedure' },
      ]),
      JSON.stringify({ correct: ['safe'] }),
      authorId,
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (
       id, org_id, title, status, pass_score, max_attempts,
       disclosure_policy, created_by
     ) VALUES (
       $1, $2, 'Safety check', 'draft', 10, 1,
       'correctness_after_submit', $3
     )`,
    [examId, orgId, authorId],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions
       (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [orgId, examId, questionRevisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position,
       media_id, exam_id, completion_policy_version,
       completion_threshold_bps
     ) VALUES (
       $1, $2, $3, 'video', 1, $4, NULL, $5, $6
     )`,
    [
      videoItemId,
      orgId,
      versionId,
      mediaId,
      ELEARNING_WATCH_POLICY_VERSION,
      ELEARNING_WATCH_THRESHOLD_BPS,
    ],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position,
       media_id, exam_id, completion_policy_version,
       completion_threshold_bps
     ) VALUES (
       $1, $2, $3, 'exam', 2, NULL, $4, NULL, NULL
     )`,
    [examItemId, orgId, versionId, examId],
  )
  await pool.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [orgId, versionId],
  )
  await pool.query(
    `UPDATE elearning_courses
        SET active_version_id = $3, latest_version_id = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, courseId, versionId],
  )

  return {
    orgId,
    userId,
    courseId,
    versionId,
    videoItemId,
    examItemId,
    questionRevisionId,
  }
}

async function cleanup(seed: { orgId: string; userId: string }): Promise<void> {
  const triggerTables = [
    'elearning_course_enrollments',
    'elearning_grading_records',
    'elearning_exam_attempts',
    'elearning_completion_evidence',
    'elearning_progress',
    'elearning_progress_events',
    'elearning_learning_sessions',
    'elearning_course_versions',
    'elearning_course_version_items',
    'elearning_exams',
    'elearning_exam_questions',
    'elearning_question_revisions',
    'elearning_scope_revision_rules',
    'elearning_scope_revisions',
  ]
  for (const table of triggerTables) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  }
  try {
    await pool.query('DELETE FROM elearning_grading_records WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_course_enrollments WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [seed.orgId])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [seed.orgId],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [seed.orgId])
    await pool.query(
      `UPDATE elearning_scopes
          SET active_revision_id = NULL, latest_revision_id = NULL
        WHERE org_id = $1`,
      [seed.orgId],
    )
    await pool.query('DELETE FROM elearning_scope_revision_rules WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_scope_revisions WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM elearning_scopes WHERE org_id = $1', [seed.orgId])
    await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND user_id = $2', [
      seed.orgId,
      seed.userId,
    ])
    await pool.query('DELETE FROM users WHERE id = $1', [seed.userId])
  } finally {
    for (const table of triggerTables) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
    }
  }
}

afterEach(async () => {
  for (const seed of [...tracked]) {
    await cleanup(seed)
    tracked.delete(seed)
  }
})

afterAll(async () => {
  await pool.end()
})

describe('online training closed loop (real PostgreSQL)', () => {
  it('registers, completes video, autogrades the objective exam, and returns the score', async () => {
    const seed = await seedVisibleVideoExamCourse()
    const enrollment = await enrollElearningCourse(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      requestId: randomUUID(),
      courseId: seed.courseId,
    })
    expect(enrollment).toMatchObject({
      courseId: seed.courseId,
      courseVersionId: seed.versionId,
      status: 'enrolled',
    })
    expect(await pool.query(
      'SELECT count(*)::int AS count FROM elearning_assignment_members WHERE org_id = $1',
      [seed.orgId],
    )).toMatchObject({ rows: [{ count: 0 }] })

    const startedWatch = await startElearningWatch(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      itemId: seed.videoItemId,
    })
    expect(startedWatch).toMatchObject({ status: 'in_progress', effectiveMs: 0 })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '20 seconds'
        WHERE org_id = $1 AND id = $2`,
      [seed.orgId, startedWatch.sessionId],
    )
    const completedWatch = await recordElearningHeartbeat(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      sessionId: startedWatch.sessionId!,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
      ...({ completed: true } as Record<string, unknown>),
    } as Parameters<typeof recordElearningHeartbeat>[1])
    expect(completedWatch.status).toBe('completed')
    expect(completedWatch.effectiveMs).toBeGreaterThanOrEqual(9_000)

    const attempt = await startElearningExam(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    expect(attempt.paper.questions).toHaveLength(1)
    expect(JSON.stringify(attempt)).not.toMatch(/answer_key|answerKey|explanation|private explanation/)
    const result = await submitElearningExam(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      attemptId: attempt.attemptId,
      answers: { [seed.questionRevisionId]: ['safe'] },
    })
    expect(result).toEqual({
      attemptId: attempt.attemptId,
      attemptNo: 1,
      status: 'graded',
      autoScore: 10,
      totalScore: 10,
      passed: true,
      duplicate: false,
    })

    const review = await getElearningExamReview(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      attemptId: attempt.attemptId,
    })
    expect(review).toMatchObject({
      attemptId: attempt.attemptId,
      status: 'graded',
      disclosurePolicy: 'correctness_after_submit',
      autoScore: 10,
      totalScore: 10,
      passed: true,
    })
    expect(review.questions).toEqual([
      expect.objectContaining({
        questionRevisionId: seed.questionRevisionId,
        selected: ['safe'],
        correct: true,
        awarded: 10,
      }),
    ])
    expect(JSON.stringify(review)).not.toMatch(/answer_key|answerKey|explanation|private explanation/)

    const courses = await listElearningLearnerCourses(db, {
      orgId: seed.orgId,
      userId: seed.userId,
    })
    expect(courses).toEqual([
      expect.objectContaining({
        courseId: seed.courseId,
        courseVersionId: seed.versionId,
        access: { kind: 'visibility', required: false },
        assignment: null,
        enrollment: expect.objectContaining({ status: 'enrolled' }),
        video: expect.objectContaining({ status: 'completed' }),
        exam: {
          itemId: seed.examItemId,
          latestAttempt: expect.objectContaining({
            attemptId: attempt.attemptId,
            status: 'graded',
            autoScore: 10,
            totalScore: 10,
            passed: true,
          }),
        },
        completed: true,
      }),
    ])

    const evidence = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM elearning_completion_evidence
        WHERE org_id = $1 AND user_id = $2 AND item_type = 'video'`,
      [seed.orgId, seed.userId],
    )
    const grades = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM elearning_grading_records
        WHERE org_id = $1 AND attempt_id = $2 AND kind = 'auto'`,
      [seed.orgId, attempt.attemptId],
    )
    expect(evidence.rows[0]?.count).toBe(1)
    expect(grades.rows[0]?.count).toBe(1)
  })

  it('cannot start the exam before server-derived video completion exists', async () => {
    const seed = await seedVisibleVideoExamCourse()
    await enrollElearningCourse(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      requestId: randomUUID(),
      courseId: seed.courseId,
    })
    await expect(startElearningExam(db, {
      orgId: seed.orgId,
      userId: seed.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'prerequisite_incomplete' })
    expect(await pool.query(
      'SELECT count(*)::int AS count FROM elearning_exam_attempts WHERE org_id = $1',
      [seed.orgId],
    )).toMatchObject({ rows: [{ count: 0 }] })
  })
})
