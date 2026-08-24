/**
 * E-learning V0.1 composite course-publish service gate (real PostgreSQL).
 *
 * Assumes content/assessment migrations have already been applied by the
 * caller. Does not call up()/down() and does not write kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refusing skip-shaped green).
 * HTTP/API/UI surfaces are out of this slice.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'
import {
  ElearningCoursePublishError,
  publishElearningCourse,
  type ElearningCoursePublishDb,
  type ElearningCoursePublishQueryable,
  type PublishElearningCourseInput,
} from '../../src/services/elearning-course-publish'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 course publish service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-pub-${STAMP}`
const SERVICE_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/services/elearning-course-publish.ts',
)

const GRAPH_TABLES = [
  'elearning_course_version_items',
  'elearning_exam_questions',
  'elearning_exams',
  'elearning_question_revisions',
  'elearning_questions',
  'elearning_course_versions',
  'elearning_courses',
] as const

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PgPublishDb implements ElearningCoursePublishDb {
  constructor(private readonly target: Pool) {}

  async transaction<T>(handler: (tx: ElearningCoursePublishQueryable) => Promise<T>): Promise<T> {
    const client = await this.target.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: async (sql, params) => exec(client, sql, params),
        })
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

const db = new PgPublishDb(pool)

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function setTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ELEARNING_V01_IMMUTABILITY_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_grading_records WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [org])
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
  return result.rows[0].n
}

async function graphResidue(org: string): Promise<number> {
  let total = 0
  for (const table of GRAPH_TABLES) {
    total += await countOrg(table, org)
  }
  return total
}

async function seedMedia(input: {
  org: string
  id?: string
  status?: string
  mimeType?: string
  magicMimeType?: string
  durationMs?: number | null
}): Promise<string> {
  const id = input.id ?? randomUUID()
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, $4, $5, 1024, $6, $7, $8, $9)`,
    [
      id,
      input.org,
      `${NS}/media/${id}`,
      input.mimeType ?? ELEARNING_MEDIA_MIME,
      input.magicMimeType ?? ELEARNING_MEDIA_MIME,
      'a'.repeat(64),
      input.durationMs === undefined ? 60_000 : input.durationMs,
      input.status ?? 'ready',
      actor('uploader'),
    ],
  )
  return id
}

function questions() {
  return [
    {
      questionType: 'single_choice' as const,
      prompt: 'Pick one',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
      ],
      correctOptionIds: ['a'],
      points: 10,
      explanation: 'single secret',
    },
    {
      questionType: 'multiple_choice' as const,
      prompt: 'Pick several',
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'b', text: 'beta' },
        { id: 'c', text: 'gamma' },
      ],
      correctOptionIds: ['c', 'a'],
      points: 10,
      explanation: 'multi secret',
    },
    {
      questionType: 'true_false' as const,
      prompt: 'Is this true',
      options: [
        { id: 't', text: 'true' },
        { id: 'f', text: 'false' },
      ],
      correctOptionIds: ['t'],
      points: 5,
    },
  ]
}

function publishInput(org: string, mediaId: string, over: Record<string, unknown> = {}): PublishElearningCourseInput {
  return {
    orgId: org,
    actorId: actor('author'),
    requestId: randomUUID(),
    title: 'Composite publish course',
    mediaId,
    passScore: 15,
    maxAttempts: 3,
    questions: questions(),
    ...over,
  } as PublishElearningCourseInput
}

function assertValuesFree(payload: unknown, org: string): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain('single secret')
  expect(blob).not.toContain('multi secret')
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('correctOptionIds')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain('sha256')
  expect(blob).not.toContain('Pick one')
  expect(blob).not.toMatch(/"correct"/)
}

describe('elearning V0.1 course publish service gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('publishes one video + one exam and persists the full trigger-legal graph', async () => {
    const org = orgId('ok')
    seededOrgIds.push(org)
    const mediaId = await seedMedia({ org })
    const input = publishInput(org, mediaId)
    const result = await publishElearningCourse(db, input)

    expect(result).toEqual({
      courseId: input.requestId,
      courseVersionId: result.courseVersionId,
      videoItemId: result.videoItemId,
      examItemId: result.examItemId,
      examId: result.examId,
      status: 'published',
      questionCount: 3,
      totalScore: 25,
    })
    expect(Object.keys(result)).toEqual([
      'courseId',
      'courseVersionId',
      'videoItemId',
      'examItemId',
      'examId',
      'status',
      'questionCount',
      'totalScore',
    ])
    assertValuesFree(result, org)

    const course = await pool.query(
      `SELECT id, org_id, title, status, active_version_id, latest_version_id, created_by
         FROM elearning_courses WHERE id = $1`,
      [input.requestId],
    )
    expect(course.rows).toHaveLength(1)
    expect(course.rows[0]).toEqual(expect.objectContaining({
      org_id: org,
      title: 'Composite publish course',
      status: 'active',
      active_version_id: result.courseVersionId,
      latest_version_id: result.courseVersionId,
      created_by: actor('author'),
    }))

    const version = await pool.query(
      `SELECT id, course_id, version, status, title
         FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
      [org, result.courseVersionId],
    )
    expect(version.rows[0]).toEqual(expect.objectContaining({
      course_id: input.requestId,
      version: 1,
      status: 'published',
    }))

    const items = await pool.query(
      `SELECT id, item_type, position, media_id, exam_id,
              completion_policy_version, completion_threshold_bps
         FROM elearning_course_version_items
        WHERE org_id = $1 AND course_version_id = $2
        ORDER BY position ASC`,
      [org, result.courseVersionId],
    )
    expect(items.rows).toHaveLength(2)
    expect(items.rows[0]).toEqual(expect.objectContaining({
      id: result.videoItemId,
      item_type: 'video',
      position: 1,
      media_id: mediaId,
      exam_id: null,
      completion_policy_version: ELEARNING_WATCH_POLICY_VERSION,
      completion_threshold_bps: ELEARNING_WATCH_THRESHOLD_BPS,
    }))
    expect(items.rows[1]).toEqual(expect.objectContaining({
      id: result.examItemId,
      item_type: 'exam',
      position: 2,
      media_id: null,
      exam_id: result.examId,
      completion_policy_version: null,
      completion_threshold_bps: null,
    }))

    const exam = await pool.query(
      `SELECT status, pass_score::text AS pass_score, max_attempts
         FROM elearning_exams WHERE org_id = $1 AND id = $2`,
      [org, result.examId],
    )
    expect(exam.rows[0].status).toBe('published')
    expect(Number(exam.rows[0].pass_score)).toBe(15)
    expect(Number(exam.rows[0].max_attempts)).toBe(3)

    const examQuestions = await pool.query(
      `SELECT position, points, question_revision_id
         FROM elearning_exam_questions
        WHERE org_id = $1 AND exam_id = $2
        ORDER BY position ASC`,
      [org, result.examId],
    )
    expect(examQuestions.rows.map((row) => Number(row.position))).toEqual([1, 2, 3])
    expect(examQuestions.rows.map((row) => Number(row.points))).toEqual([10, 10, 5])

    const revisions = await pool.query(
      `SELECT qr.revision, qr.question_type, qr.prompt, qr.options, qr.answer_key, qr.explanation, qr.points
         FROM elearning_question_revisions qr
         JOIN elearning_exam_questions eq
           ON eq.org_id = qr.org_id AND eq.question_revision_id = qr.id
        WHERE eq.org_id = $1 AND eq.exam_id = $2
        ORDER BY eq.position ASC`,
      [org, result.examId],
    )
    expect(revisions.rows).toHaveLength(3)
    expect(revisions.rows.map((row) => row.revision)).toEqual([1, 1, 1])
    expect(revisions.rows.map((row) => row.question_type)).toEqual([
      'single_choice',
      'multiple_choice',
      'true_false',
    ])
    expect(revisions.rows[0].answer_key).toEqual({ correct: ['a'] })
    expect(revisions.rows[1].answer_key).toEqual({ correct: ['a', 'c'] })
    expect(revisions.rows[0].explanation).toBe('single secret')
    expect(await countOrg('elearning_questions', org)).toBe(3)
    expect(await countOrg('elearning_media', org)).toBe(1)
  })

  it('rolls back to zero course graph residue for cross-org, not-ready, rejected, and invalid passScore', async () => {
    const org = orgId('fail')
    const other = orgId('fail-other')
    seededOrgIds.push(org, other)

    const readyHome = await seedMedia({ org })
    const foreign = await seedMedia({ org: other })
    const probing = await seedMedia({ org, status: 'probing' })
    const rejected = await seedMedia({ org, status: 'rejected' })
    const wrongMime = await seedMedia({ org, mimeType: 'video/webm', magicMimeType: 'video/webm' })
    const zeroDuration = await seedMedia({ org, durationMs: 0 })
    const nullDuration = await seedMedia({ org, durationMs: null })

    const cases: Array<{ input: PublishElearningCourseInput; code: string }> = [
      { input: publishInput(org, foreign), code: 'media_unavailable' },
      { input: publishInput(org, probing), code: 'media_unavailable' },
      { input: publishInput(org, rejected), code: 'media_unavailable' },
      { input: publishInput(org, wrongMime), code: 'media_unavailable' },
      { input: publishInput(org, zeroDuration), code: 'media_unavailable' },
      { input: publishInput(org, nullDuration), code: 'media_unavailable' },
      { input: publishInput(org, readyHome, { passScore: 26 }), code: 'invalid_input' },
    ]

    for (const testCase of cases) {
      try {
        await publishElearningCourse(db, testCase.input)
        throw new Error(`expected ${testCase.code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ElearningCoursePublishError)
        expect((error as ElearningCoursePublishError).code).toBe(testCase.code)
        assertValuesFree(error, org)
        expect((error as Error).message).toBe(testCase.code)
      }
      expect(await graphResidue(org)).toBe(0)
      expect(await graphResidue(other)).toBe(0)
    }
    expect(await countOrg('elearning_media', org)).toBe(6)
    expect(await countOrg('elearning_media', other)).toBe(1)
  })

  it('leaves zero course graph residue for int32 overflow and illegal option counts', async () => {
    const org = orgId('bounds')
    seededOrgIds.push(org)
    const mediaId = await seedMedia({ org })

    const cases: Array<{ input: PublishElearningCourseInput; code: string }> = [
      { input: publishInput(org, mediaId, { maxAttempts: 2147483648 }), code: 'invalid_input' },
      {
        input: publishInput(org, mediaId, {
          passScore: 1,
          questions: [{
            questionType: 'single_choice',
            prompt: 'Pick one',
            options: [
              { id: 'a', text: 'alpha' },
              { id: 'b', text: 'beta' },
            ],
            correctOptionIds: ['a'],
            points: 2147483648,
          }],
        }),
        code: 'invalid_input',
      },
      {
        input: publishInput(org, mediaId, {
          passScore: 1,
          questions: [{
            questionType: 'true_false',
            prompt: 'Is this true',
            options: [{ id: 't', text: 'true' }],
            correctOptionIds: ['t'],
            points: 5,
          }],
        }),
        code: 'invalid_input',
      },
      {
        input: publishInput(org, mediaId, {
          passScore: 1,
          questions: [{
            questionType: 'single_choice',
            prompt: 'Pick one',
            options: [{ id: 'a', text: 'alpha' }],
            correctOptionIds: ['a'],
            points: 10,
          }],
        }),
        code: 'invalid_input',
      },
    ]

    for (const testCase of cases) {
      try {
        await publishElearningCourse(db, testCase.input)
        throw new Error(`expected ${testCase.code}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ElearningCoursePublishError)
        expect((error as ElearningCoursePublishError).code).toBe(testCase.code)
        assertValuesFree(error, org)
        expect((error as Error).message).toBe(testCase.code)
      }
      expect(await graphResidue(org)).toBe(0)
    }
    expect(await countOrg('elearning_media', org)).toBe(1)
  })

  it('retries of the same request id cannot create a second course', async () => {
    const org = orgId('retry')
    seededOrgIds.push(org)
    const mediaId = await seedMedia({ org })
    const input = publishInput(org, mediaId)
    const first = await publishElearningCourse(db, input)
    try {
      await publishElearningCourse(db, input)
      throw new Error('expected conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningCoursePublishError)
      expect((error as ElearningCoursePublishError).code).toBe('conflict')
      assertValuesFree(error, org)
    }
    expect(await countOrg('elearning_courses', org)).toBe(1)
    expect(await countOrg('elearning_course_versions', org)).toBe(1)
    expect(await countOrg('elearning_course_version_items', org)).toBe(2)
    expect(await countOrg('elearning_exams', org)).toBe(1)
    const course = await pool.query(
      `SELECT id, active_version_id FROM elearning_courses WHERE org_id = $1`,
      [org],
    )
    expect(course.rows[0].id).toBe(first.courseId)
    expect(course.rows[0].active_version_id).toBe(first.courseVersionId)
  })

  it('turns red if publish ordering or the ready-mp4 media check is mutated', async () => {
    const source = await fs.readFile(SERVICE_SOURCE, 'utf8')
    const lockAt = source.indexOf('elearning-publish:lock')
    const mediaAt = source.indexOf('elearning-publish:load-media')
    const insertCourseAt = source.indexOf('elearning-publish:insert-course')
    const videoAt = source.indexOf('elearning-publish:insert-video-item')
    const examItemAt = source.indexOf('elearning-publish:insert-exam-item')
    const publishExamAt = source.indexOf('elearning-publish:publish-exam')
    const publishVersionAt = source.indexOf('elearning-publish:publish-version')
    const pointersAt = source.indexOf('elearning-publish:set-pointers')
    expect(lockAt).toBeGreaterThan(-1)
    expect(mediaAt).toBeGreaterThan(lockAt)
    expect(insertCourseAt).toBeGreaterThan(mediaAt)
    expect(videoAt).toBeGreaterThan(insertCourseAt)
    expect(examItemAt).toBeGreaterThan(videoAt)
    expect(publishExamAt).toBeGreaterThan(examItemAt)
    expect(publishVersionAt).toBeGreaterThan(publishExamAt)
    expect(pointersAt).toBeGreaterThan(publishVersionAt)

    const mediaSql = source.slice(mediaAt, insertCourseAt)
    expect(mediaSql).toContain("status = 'ready'")
    expect(mediaSql).toContain('mime_type = $3')
    expect(mediaSql).toContain('magic_mime_type = $3')
    expect(mediaSql).toContain('duration_ms > 0')
    expect(mediaSql).toContain('org_id = $1')
    expect(mediaSql).toContain('FOR SHARE')
    expect(source).toContain("item_type, position, media_id, exam_id")
    expect(source).toContain("'video', 1")
    expect(source).toContain("'exam', 2")
    expect(source).toContain('ELEARNING_WATCH_POLICY_VERSION')
    expect(source).toContain('ELEARNING_WATCH_THRESHOLD_BPS')
  })
})
