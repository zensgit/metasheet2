/**
 * E-learning V0.1 composite course-publish service gate (real PostgreSQL).
 *
 * Service cases assume content/assessment + course-publish-request migrations
 * have already been applied by the caller and do not write kysely_migration.
 * The isolated-schema describe exercises this ledger migration's up()/down()
 * against a throwaway schema and never drops public tables.
 *
 * DATABASE_URL is required. A missing URL throws (refusing skip-shaped green).
 * HTTP/API/UI surfaces are out of this slice.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  up as upElearningContentAssessment,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import {
  COURSE_PUBLISH_REQUESTS_DENY_TRIGGER,
  ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  ELEARNING_V01_LEDGER_TRIGGERS,
  MEDIA_DURATION_STATUS_CHK,
  down as downElearningLedgerHardening,
  up as upElearningLedgerHardening,
} from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import { up as upElearningWatchProgress } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import {
  ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK,
  ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK,
  ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK,
  ELEARNING_COURSE_PUBLISH_REQUESTS_ITEM_ROLES_DISTINCT_CHK,
  ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE,
  ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK,
  ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK,
  down as downElearningCoursePublishRequests,
  up as upElearningCoursePublishRequests,
} from '../../src/db/migrations/zzzz20260825140000_create_elearning_course_publish_requests'
import { ELEARNING_MEDIA_MIME } from '../../src/services/elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from '../../src/services/elearning-watch-progress'
import {
  ELEARNING_COURSE_PUBLISH_REQUEST_HASH_VERSION,
  ElearningCoursePublishError,
  canonicalizeElearningCoursePublishInput,
  hashElearningCoursePublishRequest,
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
  'elearning_course_publish_requests',
  'elearning_course_version_items',
  'elearning_exam_questions',
  'elearning_exams',
  'elearning_question_revisions',
  'elearning_questions',
  'elearning_course_versions',
  'elearning_courses',
] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  for (const { table, name } of [
    ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
    ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  ]) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_grading_records WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_course_publish_requests WHERE org_id = $1', [org])
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
      input.durationMs === undefined
        ? ((input.status ?? 'ready') === 'ready' ? 60_000 : null)
        : input.durationMs,
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

    expect(result.courseId).not.toBe(input.requestId)
    expect(result.courseId).toMatch(UUID_RE)
    expect(result).toEqual({
      courseId: result.courseId,
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

    const keyedByRequest = await pool.query(
      `SELECT id FROM elearning_courses WHERE id = $1`,
      [input.requestId],
    )
    expect(keyedByRequest.rows).toHaveLength(0)

    const course = await pool.query(
      `SELECT id, org_id, title, status, active_version_id, latest_version_id, created_by
         FROM elearning_courses WHERE org_id = $1 AND id = $2`,
      [org, result.courseId],
    )
    expect(course.rows).toHaveLength(1)
    expect(course.rows[0]).toEqual(expect.objectContaining({
      id: result.courseId,
      org_id: org,
      title: 'Composite publish course',
      status: 'active',
      active_version_id: result.courseVersionId,
      latest_version_id: result.courseVersionId,
      created_by: actor('author'),
    }))

    const request = await pool.query(
      `SELECT org_id, source_key, request_hash, request_hash_version, course_id,
              course_version_id, video_item_id, exam_item_id, exam_id,
              question_count, total_score
         FROM elearning_course_publish_requests
        WHERE org_id = $1 AND source_key = $2`,
      [org, input.requestId],
    )
    expect(request.rows).toHaveLength(1)
    expect(request.rows[0]).toEqual(expect.objectContaining({
      org_id: org,
      source_key: input.requestId,
      request_hash: hashElearningCoursePublishRequest(canonicalizeElearningCoursePublishInput(input)),
      request_hash_version: ELEARNING_COURSE_PUBLISH_REQUEST_HASH_VERSION,
      course_id: result.courseId,
      course_version_id: result.courseVersionId,
      video_item_id: result.videoItemId,
      exam_item_id: result.examItemId,
      exam_id: result.examId,
    }))
    expect(Number(request.rows[0].question_count)).toBe(3)
    expect(Number(request.rows[0].total_score)).toBe(25)

    const version = await pool.query(
      `SELECT id, course_id, version, status, title
         FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
      [org, result.courseVersionId],
    )
    expect(version.rows[0]).toEqual(expect.objectContaining({
      course_id: result.courseId,
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
    let zeroDuration: PgError | null = null
    try {
      await seedMedia({ org, durationMs: 0 })
    } catch (error) {
      zeroDuration = error as PgError
    }
    expect(zeroDuration?.constraint).toBe(MEDIA_DURATION_STATUS_CHK)
    let nullDuration: PgError | null = null
    try {
      await seedMedia({ org, durationMs: null })
    } catch (error) {
      nullDuration = error as PgError
    }
    expect(nullDuration?.constraint).toBe(MEDIA_DURATION_STATUS_CHK)

    const cases: Array<{ input: PublishElearningCourseInput; code: string }> = [
      { input: publishInput(org, foreign), code: 'media_unavailable' },
      { input: publishInput(org, probing), code: 'media_unavailable' },
      { input: publishInput(org, rejected), code: 'media_unavailable' },
      { input: publishInput(org, wrongMime), code: 'media_unavailable' },
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
    expect(await countOrg('elearning_media', org)).toBe(4)
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

  it('replays the same org+key+hash, conflicts on a different payload, and isolates orgs', async () => {
    const org = orgId('idem')
    const orgB = orgId('idem-b')
    seededOrgIds.push(org, orgB)
    const mediaId = await seedMedia({ org })
    const mediaB = await seedMedia({ org: orgB })
    const requestId = randomUUID()
    const input = publishInput(org, mediaId, { requestId })

    const first = await publishElearningCourse(db, input)
    const replay = await publishElearningCourse(db, { ...input, actorId: actor('retry') })
    expect(replay).toEqual(first)
    expect(first.courseId).not.toBe(requestId)
    expect(await countOrg('elearning_courses', org)).toBe(1)
    expect(await countOrg('elearning_course_versions', org)).toBe(1)
    expect(await countOrg('elearning_course_version_items', org)).toBe(2)
    expect(await countOrg('elearning_exams', org)).toBe(1)
    expect(await countOrg('elearning_questions', org)).toBe(3)
    expect(await countOrg('elearning_course_publish_requests', org)).toBe(1)

    try {
      await publishElearningCourse(db, { ...input, title: 'Different composite title' })
      throw new Error('expected conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningCoursePublishError)
      expect((error as ElearningCoursePublishError).code).toBe('conflict')
      assertValuesFree(error, org)
      expect((error as Error).message).toBe('conflict')
    }
    expect(await countOrg('elearning_courses', org)).toBe(1)
    expect(await countOrg('elearning_course_publish_requests', org)).toBe(1)

    const other = await publishElearningCourse(db, publishInput(orgB, mediaB, {
      requestId,
      title: 'Different composite title',
    }))
    expect(other.courseId).not.toBe(first.courseId)
    expect(other.courseId).not.toBe(requestId)
    expect(await countOrg('elearning_courses', orgB)).toBe(1)
    expect(await countOrg('elearning_course_versions', orgB)).toBe(1)
    expect(await countOrg('elearning_exams', orgB)).toBe(1)
    expect(await countOrg('elearning_course_publish_requests', orgB)).toBe(1)
    expect(await countOrg('elearning_courses', org)).toBe(1)
    expect(await countOrg('elearning_course_publish_requests', org)).toBe(1)
  })

  it('rejects UPDATE and DELETE of a publish request while canonical replay still succeeds', async () => {
    const org = orgId('req-append')
    seededOrgIds.push(org)
    const mediaId = await seedMedia({ org })
    const input = publishInput(org, mediaId)
    const first = await publishElearningCourse(db, input)

    let updateErr: Error | null = null
    try {
      await pool.query(
        `UPDATE elearning_course_publish_requests SET request_hash = 'tamper' WHERE org_id = $1 AND source_key = $2`,
        [org, input.requestId],
      )
    } catch (error) {
      updateErr = error as Error
    }
    expect(String(updateErr?.message)).toMatch(/append-only: UPDATE is not permitted/)

    let deleteErr: Error | null = null
    try {
      await pool.query(
        `DELETE FROM elearning_course_publish_requests WHERE org_id = $1 AND source_key = $2`,
        [org, input.requestId],
      )
    } catch (error) {
      deleteErr = error as Error
    }
    expect(String(deleteErr?.message)).toMatch(/append-only: DELETE is not permitted/)

    const replay = await publishElearningCourse(db, { ...input, actorId: actor('retry') })
    expect(replay).toEqual(first)
    expect(await countOrg('elearning_course_publish_requests', org)).toBe(1)
    expect(COURSE_PUBLISH_REQUESTS_DENY_TRIGGER).toBe(
      'trg_elearning_course_publish_requests_deny_mutation',
    )
  })

  it('converges concurrent exact replays onto one course graph', async () => {
    const org = orgId('race')
    seededOrgIds.push(org)
    const mediaId = await seedMedia({ org })
    const input = publishInput(org, mediaId)
    const raced = await Promise.all([
      publishElearningCourse(db, input),
      publishElearningCourse(db, input),
    ])
    expect(raced[0]).toEqual(raced[1])
    expect(raced[0].courseId).not.toBe(input.requestId)
    expect(await countOrg('elearning_courses', org)).toBe(1)
    expect(await countOrg('elearning_course_versions', org)).toBe(1)
    expect(await countOrg('elearning_course_version_items', org)).toBe(2)
    expect(await countOrg('elearning_exams', org)).toBe(1)
    expect(await countOrg('elearning_questions', org)).toBe(3)
    expect(await countOrg('elearning_course_publish_requests', org)).toBe(1)
  })

  it('turns red if publish ordering or the ready-mp4 media check is mutated', async () => {
    const source = await fs.readFile(SERVICE_SOURCE, 'utf8')
    const lockAt = source.indexOf('elearning-publish:lock')
    const loadRequestAt = source.indexOf('elearning-publish:load-request')
    const mediaAt = source.indexOf('elearning-publish:load-media')
    const insertCourseAt = source.indexOf('elearning-publish:insert-course')
    const videoAt = source.indexOf('elearning-publish:insert-video-item')
    const examItemAt = source.indexOf('elearning-publish:insert-exam-item')
    const publishExamAt = source.indexOf('elearning-publish:publish-exam')
    const publishVersionAt = source.indexOf('elearning-publish:publish-version')
    const pointersAt = source.indexOf('elearning-publish:set-pointers')
    const insertRequestAt = source.indexOf('elearning-publish:insert-request')
    expect(lockAt).toBeGreaterThan(-1)
    expect(loadRequestAt).toBeGreaterThan(lockAt)
    expect(mediaAt).toBeGreaterThan(loadRequestAt)
    expect(insertCourseAt).toBeGreaterThan(mediaAt)
    expect(videoAt).toBeGreaterThan(insertCourseAt)
    expect(examItemAt).toBeGreaterThan(videoAt)
    expect(publishExamAt).toBeGreaterThan(examItemAt)
    expect(publishVersionAt).toBeGreaterThan(publishExamAt)
    expect(pointersAt).toBeGreaterThan(publishVersionAt)
    expect(insertRequestAt).toBeGreaterThan(pointersAt)
    expect(source).toContain('elearning_course_publish_requests')
    expect(source).toContain('org_id = $1 AND source_key = $2')
    expect(source).not.toMatch(/FROM elearning_courses\s+WHERE id = \$1/)

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

interface PgError extends Error {
  code?: string
  constraint?: string
}

async function rejectPg(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn()
    throw new Error('expected postgres error')
  } catch (error) {
    return error as PgError
  }
}

describe.sequential('elearning course-publish request ledger migration (isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL })
    schema = `elpubmig_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schema}`,
    })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    await testPool.query(
      `CREATE OR REPLACE FUNCTION gen_random_uuid()
       RETURNS uuid
       LANGUAGE sql
       AS $fn$ SELECT public.gen_random_uuid() $fn$`,
    )
    await upElearningContentAssessment(testDb)
    await upElearningWatchProgress(testDb)
    await upElearningCoursePublishRequests(testDb)
    await upElearningLedgerHardening(testDb)
  })

  afterAll(async () => {
    try {
      await testDb.destroy()
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await adminPool.end()
    }
  })

  async function seedGraph(org: string) {
    const courseId = randomUUID()
    const versionId = randomUUID()
    const mediaId = randomUUID()
    const examId = randomUUID()
    const videoItemId = randomUUID()
    const examItemId = randomUUID()
    await testPool.query(
      `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
       VALUES ($1, $2, 'Scratch course', 'active', 'scratch-author')`,
      [courseId, org],
    )
    await testPool.query(
      `INSERT INTO elearning_course_versions
         (id, org_id, course_id, version, status, title, created_by)
       VALUES ($1, $2, $3, 1, 'draft', 'Scratch version', 'scratch-author')`,
      [versionId, org, courseId],
    )
    await testPool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type,
         size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, $4, $4, 1024, $5, 60000, 'ready', 'scratch-uploader')`,
      [mediaId, org, `${schema}/media/${mediaId}`, ELEARNING_MEDIA_MIME, 'a'.repeat(64)],
    )
    await testPool.query(
      `INSERT INTO elearning_exams
         (id, org_id, title, status, pass_score, max_attempts, created_by)
       VALUES ($1, $2, 'Scratch exam', 'draft', 10, 3, 'scratch-author')`,
      [examId, org],
    )
    await testPool.query(
      `INSERT INTO elearning_course_version_items (
         id, org_id, course_version_id, item_type, position, media_id, exam_id,
         completion_policy_version, completion_threshold_bps
       ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, $5, $6)`,
      [
        videoItemId,
        org,
        versionId,
        mediaId,
        ELEARNING_WATCH_POLICY_VERSION,
        ELEARNING_WATCH_THRESHOLD_BPS,
      ],
    )
    await testPool.query(
      `INSERT INTO elearning_course_version_items (
         id, org_id, course_version_id, item_type, position, media_id, exam_id,
         completion_policy_version, completion_threshold_bps
       ) VALUES ($1, $2, $3, 'exam', 2, NULL, $4, NULL, NULL)`,
      [examItemId, org, versionId, examId],
    )
    return { courseId, versionId, mediaId, examId, videoItemId, examItemId }
  }

  async function insertRequest(row: {
    org: string
    sourceKey: string
    courseId: string
    versionId: string
    videoItemId: string
    examItemId: string
    examId: string
  }) {
    await testPool.query(
      `INSERT INTO ${ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE} (
         org_id, source_key, request_hash, request_hash_version,
         course_id, course_version_id, video_item_id, exam_item_id, exam_id,
         question_count, total_score
       ) VALUES ($1, $2, 'abc', 1, $3, $4, $5, $6, $7, 1, 10)`,
      [
        row.org,
        row.sourceKey,
        row.courseId,
        row.versionId,
        row.videoItemId,
        row.examItemId,
        row.examId,
      ],
    )
  }

  it('creates the full same-org RESTRICT FK chain on the scratch ledger', async () => {
    const fks = await testPool.query<{ conname: string; def: string; confdeltype: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def, confdeltype
         FROM pg_constraint
        WHERE conrelid = $1::regclass
          AND contype = 'f'
        ORDER BY conname`,
      [ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE],
    )
    const byName = new Map(fks.rows.map((row) => [row.conname, row]))
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK)?.confdeltype).toBe('r')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK)?.confdeltype).toBe('r')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK)?.confdeltype).toBe('r')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)?.confdeltype).toBe('r')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK)?.confdeltype).toBe('r')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK)?.def).toContain('(org_id, course_id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK)?.def).toContain('elearning_courses(org_id, id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK)?.def).toContain('(org_id, course_id, course_version_id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK)?.def).toContain('elearning_course_versions(org_id, course_id, id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK)?.def).toContain('(org_id, course_version_id, video_item_id, video_item_type)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK)?.def).toContain('elearning_course_version_items(org_id, course_version_id, id, item_type)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)?.def).toContain('(org_id, course_version_id, exam_item_id, exam_item_type, exam_id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)?.def).toContain('elearning_course_version_items(org_id, course_version_id, id, item_type, exam_id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK)?.def).toContain('(org_id, exam_id)')
    expect(byName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK)?.def).toContain('elearning_exams(org_id, id)')
    for (const row of fks.rows) {
      expect(row.def).toMatch(/ON DELETE RESTRICT/)
    }

    const checks = await testPool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = $1::regclass
          AND contype = 'c'`,
      [ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE],
    )
    const checkByName = new Map(checks.rows.map((row) => [row.conname, row]))
    expect(checkByName.get(ELEARNING_COURSE_PUBLISH_REQUESTS_ITEM_ROLES_DISTINCT_CHK)?.def).toContain(
      'video_item_id <> exam_item_id',
    )
  })

  it('rejects cross-org and parent-inconsistent request rows, and blocks parent deletes', async () => {
    const orgA = `${schema}-a`
    const orgB = `${schema}-b`
    const graphA = await seedGraph(orgA)
    const graphA2 = await seedGraph(orgA)
    const graphB = await seedGraph(orgB)

    const crossOrg = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphB.courseId,
      versionId: graphB.versionId,
      videoItemId: graphB.videoItemId,
      examItemId: graphB.examItemId,
      examId: graphB.examId,
    }))
    expect(crossOrg.code).toBe('23503')
    expect(crossOrg.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_COURSE_FK)

    const wrongVersion = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA2.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA.examItemId,
      examId: graphA.examId,
    }))
    expect(wrongVersion.code).toBe('23503')
    expect(wrongVersion.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_VERSION_FK)

    const wrongVideo = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA2.videoItemId,
      examItemId: graphA.examItemId,
      examId: graphA.examId,
    }))
    expect(wrongVideo.code).toBe('23503')
    expect(wrongVideo.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK)

    const wrongExamItem = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA2.examItemId,
      examId: graphA.examId,
    }))
    expect(wrongExamItem.code).toBe('23503')
    expect(wrongExamItem.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)

    const wrongExam = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA.examItemId,
      examId: graphB.examId,
    }))
    expect(wrongExam.code).toBe('23503')
    expect(wrongExam.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_FK)

    const swappedRoles = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.examItemId,
      examItemId: graphA.videoItemId,
      examId: graphA.examId,
    }))
    expect(swappedRoles.code).toBe('23503')
    expect([
      ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK,
      ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK,
    ]).toContain(swappedRoles.constraint)

    const reusedVideo = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA.videoItemId,
      examId: graphA.examId,
    }))
    expect(reusedVideo.code).toBe('23514')
    expect(reusedVideo.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_ITEM_ROLES_DISTINCT_CHK)

    const reusedExam = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.examItemId,
      examItemId: graphA.examItemId,
      examId: graphA.examId,
    }))
    expect(reusedExam.code).toBe('23514')
    expect(reusedExam.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_ITEM_ROLES_DISTINCT_CHK)

    const sameOrgWrongExam = await rejectPg(() => insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA.examItemId,
      examId: graphA2.examId,
    }))
    expect(sameOrgWrongExam.code).toBe('23503')
    expect(sameOrgWrongExam.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)

    await insertRequest({
      org: orgA,
      sourceKey: randomUUID(),
      courseId: graphA.courseId,
      versionId: graphA.versionId,
      videoItemId: graphA.videoItemId,
      examItemId: graphA.examItemId,
      examId: graphA.examId,
    })

    const deleteVideo = await rejectPg(() => testPool.query(
      `DELETE FROM elearning_course_version_items WHERE org_id = $1 AND id = $2`,
      [orgA, graphA.videoItemId],
    ))
    expect(deleteVideo.code).toBe('23503')
    expect(deleteVideo.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_VIDEO_ITEM_FK)

    const deleteExamItem = await rejectPg(() => testPool.query(
      `DELETE FROM elearning_course_version_items WHERE org_id = $1 AND id = $2`,
      [orgA, graphA.examItemId],
    ))
    expect(deleteExamItem.code).toBe('23503')
    expect(deleteExamItem.constraint).toBe(ELEARNING_COURSE_PUBLISH_REQUESTS_EXAM_ITEM_FK)

    const deleteExam = await rejectPg(() => testPool.query(
      `DELETE FROM elearning_exams WHERE org_id = $1 AND id = $2`,
      [orgA, graphA.examId],
    ))
    expect(deleteExam.code).toBe('23503')

    const deleteVersion = await rejectPg(() => testPool.query(
      `DELETE FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
      [orgA, graphA.versionId],
    ))
    expect(deleteVersion.code).toBe('23503')

    const deleteCourse = await rejectPg(() => testPool.query(
      `DELETE FROM elearning_courses WHERE org_id = $1 AND id = $2`,
      [orgA, graphA.courseId],
    ))
    expect(deleteCourse.code).toBe('23503')
  })

  it('quarantines legacy untrusted ready media, repairs non-ready duration residue, and validates', async () => {
    await downElearningLedgerHardening(testDb)
    const untrustedReadyId = randomUUID()
    const nonReadyResidueId = randomUUID()
    await testPool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type,
         size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, $4, $4, 1024, $5, NULL, 'ready', 'legacy-uploader')`,
      [
        untrustedReadyId,
        `${schema}-legacy`,
        `${schema}/media/${untrustedReadyId}`,
        ELEARNING_MEDIA_MIME,
        'b'.repeat(64),
      ],
    )
    await testPool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type,
         size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, $4, $4, 1024, $5, 500, 'probing', 'legacy-uploader')`,
      [
        nonReadyResidueId,
        `${schema}-legacy`,
        `${schema}/media/${nonReadyResidueId}`,
        ELEARNING_MEDIA_MIME,
        'c'.repeat(64),
      ],
    )

    await upElearningLedgerHardening(testDb)
    const repaired = await testPool.query<{ id: string; status: string; duration_ms: string | null }>(
      `SELECT id::text, status, duration_ms::text
         FROM elearning_media
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[untrustedReadyId, nonReadyResidueId]],
    )
    expect(repaired.rows).toEqual(
      [
        { id: untrustedReadyId, status: 'rejected', duration_ms: null },
        { id: nonReadyResidueId, status: 'probing', duration_ms: null },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    )
    const constraint = await testPool.query<{ convalidated: boolean }>(
      `SELECT convalidated
         FROM pg_constraint
        WHERE conname = $1
          AND conrelid = 'elearning_media'::regclass`,
      [MEDIA_DURATION_STATUS_CHK],
    )
    expect(constraint.rows).toEqual([{ convalidated: true }])
  })

  it('down() drops the scratch hardening and request ledger while leaving the public table untouched', async () => {
    const publicBefore = await adminPool.query<{ rel: string | null }>(
      `SELECT to_regclass('public.${ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE}')::text AS rel`,
    )
    await downElearningLedgerHardening(testDb)
    const hardening = await testPool.query<{
      trigger_count: number
      function_count: number
      constraint_count: number
    }>(
      `SELECT
          (SELECT count(*)::int
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = current_schema()
              AND NOT t.tgisinternal
              AND t.tgname = ANY($1::text[])) AS trigger_count,
          (SELECT count(*)::int
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = current_schema()
              AND p.proname = ANY($2::text[])) AS function_count,
          (SELECT count(*)::int
             FROM pg_constraint
            WHERE conname = $3
              AND conrelid = 'elearning_media'::regclass) AS constraint_count`,
      [
        ELEARNING_V01_LEDGER_TRIGGERS.map((row) => row.name),
        ELEARNING_V01_LEDGER_TRIGGERS.map((row) => row.fn),
        MEDIA_DURATION_STATUS_CHK,
      ],
    )
    expect(hardening.rows[0]).toEqual({
      trigger_count: 0,
      function_count: 0,
      constraint_count: 0,
    })

    await downElearningCoursePublishRequests(testDb)
    const scratch = await testPool.query<{ rel: string | null }>(
      `SELECT to_regclass($1)::text AS rel`,
      [`${schema}.${ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE}`],
    )
    expect(scratch.rows[0].rel).toBeNull()
    const publicAfter = await adminPool.query<{ rel: string | null }>(
      `SELECT to_regclass('public.${ELEARNING_COURSE_PUBLISH_REQUESTS_TABLE}')::text AS rel`,
    )
    expect(publicAfter.rows[0].rel).toBe(publicBefore.rows[0].rel)
  })
})
