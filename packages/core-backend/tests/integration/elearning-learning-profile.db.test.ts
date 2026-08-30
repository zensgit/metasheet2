import { randomUUID } from 'node:crypto'

import { Pool, type PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

import {
  publishElearningContentCourse,
  type ElearningContentCoursePublishDb,
  type ElearningContentCoursePublishQueryable,
} from '../../src/services/elearning-content-course-publish'
import {
  storeElearningContentRevision,
  type ElearningContentRevisionDb,
} from '../../src/services/elearning-content-revision-postgres'
import {
  publishElearningCourse,
  type ElearningCoursePublishDb,
} from '../../src/services/elearning-course-publish'
import {
  getElearningLearningProfile,
  type ElearningLearningProfileDb,
} from '../../src/services/elearning-learning-profile'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  recordElearningOpenCompletion,
  type ElearningOpenCompletionDb,
} from '../../src/services/elearning-open-completion-postgres'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning learning profile authority requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const NS = `el-profile-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
const ORG = `${NS}-org`
const OTHER_ORG = `${NS}-other-org`
const USER = `${NS}-user`
const OTHER_USER = `${NS}-other-user`

type RuntimeDb = ElearningContentRevisionDb
  & ElearningContentCoursePublishDb
  & ElearningCoursePublishDb
  & ElearningOpenCompletionDb
  & ElearningLearningProfileDb

async function query(
  target: Pool | PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount,
  }
}

const db: RuntimeDb = {
  async query(text, params) {
    return query(pool, text, params)
  },
  async transaction<T>(
    handler: (tx: ElearningContentCoursePublishQueryable) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await handler({
        query: (text, params) => query(client, text, params),
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

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function ensureMembership(userId: string, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     )`,
    [userId, `${userId}@profile.test`, userId],
  )
  await pool.query(
    'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
    [userId, orgId],
  )
}

async function assign(
  orgId: string,
  userId: string,
  courseVersionId: string,
): Promise<string> {
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [assignmentId, orgId, courseVersionId, randomUUID(), 'a'.repeat(64), actor('assigner')],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, orgId, assignmentId, courseVersionId, userId],
  )
  return memberId
}

async function publishAssessment(orgId: string, userId: string) {
  const mediaId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, $4, $4, 1024, $5, 60000, 'ready', $6)`,
    [
      mediaId,
      orgId,
      `${NS}/media/${mediaId}`,
      ELEARNING_MEDIA_MIME,
      'b'.repeat(64),
      actor('uploader'),
    ],
  )
  const course = await publishElearningCourse(db, {
    orgId,
    actorId: actor('publisher'),
    requestId: randomUUID(),
    title: 'Completed assessment',
    mediaId,
    passScore: 8,
    maxAttempts: 3,
    questions: [{
      questionType: 'single_choice',
      prompt: 'Pick one',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
      correctOptionIds: ['a'],
      points: 10,
    }],
  })
  const memberId = await assign(orgId, userId, course.courseVersionId)
  const videoCompletedAt = '2026-08-30T01:00:00.000Z'
  await pool.query(
    `INSERT INTO elearning_completion_evidence (
       id, org_id, assignment_member_id, course_version_id,
       course_version_item_id, user_id, completion_policy_version,
       completion_threshold_bps, media_duration_ms, effective_ms,
       max_position_ms, event_digest, evaluator_version, completed_at,
       item_type, content_revision_id, open_event_id, completion_assurance
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'video-v1-90pct',
       9000, 60000, 54000, 54000, $7, 'video-v1', $8,
       'video', NULL, NULL, NULL
     )`,
    [
      randomUUID(), orgId, memberId, course.courseVersionId,
      course.videoItemId, userId, 'c'.repeat(64), videoCompletedAt,
    ],
  )
  const attemptId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, course_version_item_id,
       user_id, attempt_no, paper_snapshot, status, started_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, 'started', $8)`,
    [
      attemptId, orgId, course.examId, course.courseVersionId,
      course.examItemId, userId, JSON.stringify({ version: 1 }),
      '2026-08-30T01:10:00.000Z',
    ],
  )
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted', answers = '{}'::jsonb, submitted_at = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, attemptId, '2026-08-30T01:20:00.000Z'],
  )
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'graded', auto_score = 9, total_score = 10,
            passed = TRUE, graded_at = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, attemptId, '2026-08-30T01:30:00.000Z'],
  )
  await pool.query(
    `UPDATE elearning_courses SET status = 'withdrawn'
      WHERE org_id = $1 AND id = $2`,
    [orgId, course.courseId],
  )
  return course
}

async function publishContent(
  orgId: string,
  userId: string,
  title: string,
  complete: boolean,
) {
  const revision = await storeElearningContentRevision(db, {
    orgId,
    actorId: actor('content-author'),
    requestId: randomUUID(),
    itemType: 'article',
    title,
    articleHtml: `<p>${title}</p>`,
    externalUrl: null,
  })
  const secondRevision = complete ? null : await storeElearningContentRevision(db, {
    orgId,
    actorId: actor('content-author'),
    requestId: randomUUID(),
    itemType: 'article',
    title: `${title} second`,
    articleHtml: `<p>${title} second</p>`,
    externalUrl: null,
  })
  const course = await publishElearningContentCourse(db, {
    orgId,
    actorId: actor('content-publisher'),
    requestId: randomUUID(),
    title,
    items: [
      { itemType: 'article', contentRevisionId: revision.contentRevisionId },
      ...(secondRevision ? [{
        itemType: 'article' as const,
        contentRevisionId: secondRevision.contentRevisionId,
      }] : []),
    ],
  })
  await assign(orgId, userId, course.courseVersionId)
  await recordElearningOpenCompletion(db, {
    orgId,
    userId,
    requestId: randomUUID(),
    itemId: course.items[0]!.itemId,
  })
  return course
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning learning profile authority (real PostgreSQL)', () => {
  it('fails closed when the authenticated learner lacks active org membership', async () => {
    await expect(getElearningLearningProfile(db, {
      orgId: OTHER_ORG,
      userId: OTHER_USER,
    })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('derives completed assessment/content history, preserves withdrawn history, and excludes incomplete work', async () => {
    await ensureMembership(USER, ORG)
    await ensureMembership(OTHER_USER, ORG)
    const assessment = await publishAssessment(ORG, USER)
    const content = await publishContent(ORG, USER, 'Completed article', true)
    await publishContent(ORG, USER, 'Incomplete article', false)
    await publishContent(ORG, OTHER_USER, 'Other learner article', true)

    const profile = await getElearningLearningProfile(db, {
      orgId: ORG,
      userId: USER,
      limit: 100,
    })
    expect(profile.summary).toEqual({
      completedCourses: 2,
      assessmentCourses: 1,
      contentCourses: 1,
    })
    expect(profile.courses).toHaveLength(2)
    expect(profile.courses).toEqual(expect.arrayContaining([
      {
        courseId: assessment.courseId,
        courseVersionId: assessment.courseVersionId,
        title: 'Completed assessment',
        kind: 'assessment',
        completedAt: '2026-08-30T01:30:00.000Z',
        exams: [{
          itemId: assessment.examItemId,
          earnedScore: 9,
          totalScore: 10,
          passedAt: '2026-08-30T01:30:00.000Z',
        }],
      },
      expect.objectContaining({
        courseId: content.courseId,
        courseVersionId: content.courseVersionId,
        title: 'Completed article',
        kind: 'content',
      }),
    ]))
    expect(JSON.stringify(profile)).not.toMatch(
      /answers|paperSnapshot|grading|eventDigest|assignmentMember|scopeRevision|actorId/,
    )
  })

  it('uses a stable exclusive cursor without changing the overall summary', async () => {
    const first = await getElearningLearningProfile(db, {
      orgId: ORG,
      userId: USER,
      limit: 1,
    })
    expect(first.courses).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await getElearningLearningProfile(db, {
      orgId: ORG,
      userId: USER,
      limit: 1,
      cursor: first.nextCursor!,
    })
    expect(second.summary).toEqual(first.summary)
    expect(second.courses).toHaveLength(1)
    expect(second.courses[0]!.courseVersionId)
      .not.toBe(first.courses[0]!.courseVersionId)
    expect(second.nextCursor).toBeNull()
  })
})
