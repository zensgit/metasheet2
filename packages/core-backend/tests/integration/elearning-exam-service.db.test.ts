/**
 * E-learning V0.1 objective-exam service gate (real PostgreSQL).
 *
 * Assumes content/assessment + watch-progress migrations have already been
 * applied by the caller. Does not call up()/down() and does not write
 * kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 * HTTP/API surfaces are out of this slice.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  elearningExamLockKey,
  ElearningExamError,
  saveElearningExamAnswers,
  startElearningExam,
  submitElearningExam,
  type ElearningExamDb,
  type ElearningExamQueryable,
} from '../../src/services/elearning-exam'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 exam service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-exsvc-${STAMP}`

const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
]

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PgExamDb implements ElearningExamDb {
  constructor(private readonly target: Pool) {}

  query(sql: string, params?: unknown[]) {
    return exec(this.target, sql, params)
  }

  async transaction<T>(handler: (tx: ElearningExamQueryable) => Promise<T>): Promise<T> {
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

const db = new PgExamDb(pool)

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

interface Seed {
  org: string
  userId: string
  courseId: string
  versionId: string
  examId: string
  examItemId: string
  aliasExamItemId: string | null
  videoItemIds: string[]
  memberId: string
  singleId: string
  multipleId: string
  trueFalseId: string
}

async function seedPublishedExam(input: {
  org: string
  videoCount?: number
  videoProgress?: 'missing' | 'in_progress' | 'completed'
  maxAttempts?: number
  passScore?: number
  courseStatus?: 'active' | 'archived' | 'withdrawn'
  versionStatus?: 'published' | 'retired'
  examStatus?: 'published' | 'retired'
  aliasExamItem?: boolean
}): Promise<Seed> {
  const userId = actor(`learner-${randomUUID().slice(0, 8)}`)
  const courseId = randomUUID()
  const versionId = randomUUID()
  const examId = randomUUID()
  const examItemId = randomUUID()
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  const videoCount = input.videoCount ?? 1
  const videoItemIds: string[] = []
  const questionId = randomUUID()
  const questionB = randomUUID()
  const questionC = randomUUID()
  const singleId = randomUUID()
  const multipleId = randomUUID()
  const trueFalseId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Exam service course', 'active', $3)`,
    [courseId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, input.org, courseId, actor('author')],
  )

  for (let index = 0; index < videoCount; index += 1) {
    const mediaId = randomUUID()
    const itemId = randomUUID()
    videoItemIds.push(itemId)
    await pool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type,
         size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
      [mediaId, input.org, `${NS}/media/${mediaId}`, 'a'.repeat(64), actor('uploader')],
    )
    await pool.query(
      `INSERT INTO elearning_course_version_items (
         id, org_id, course_version_id, item_type, position, media_id, exam_id,
         completion_policy_version, completion_threshold_bps
       ) VALUES ($1, $2, $3, 'video', $4, $5, NULL, 'video-v1-90pct', 9000)`,
      [itemId, input.org, versionId, index + 1, mediaId],
    )
  }

  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3), ($4, $2, $3), ($5, $2, $3)`,
    [questionId, input.org, actor('author'), questionB, questionC],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, explanation, points, created_by
     ) VALUES
       ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 'single secret', 99, $6),
       ($7, $2, $8, 1, 'multiple_choice', 'Pick several', $9::jsonb, $10::jsonb, 'multi secret', 99, $6),
       ($11, $2, $12, 1, 'true_false', 'Is this true', $13::jsonb, $14::jsonb, 'tf secret', 99, $6)`,
    [
      singleId,
      input.org,
      questionId,
      JSON.stringify([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
      multipleId,
      questionB,
      JSON.stringify([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }, { id: 'c', text: 'gamma' }]),
      JSON.stringify({ correct: ['a', 'c'] }),
      trueFalseId,
      questionC,
      JSON.stringify([{ id: 't', text: 'true' }, { id: 'f', text: 'false' }]),
      JSON.stringify({ correct: ['t'] }),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Objective exam', 'draft', $3, $4, $5)`,
    [examId, input.org, input.passScore ?? 20, input.maxAttempts ?? 3, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10), ($1, $2, $4, 2, 10), ($1, $2, $5, 3, 10)`,
    [input.org, examId, singleId, multipleId, trueFalseId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'exam', $4, NULL, $5, NULL, NULL)`,
    [examItemId, input.org, versionId, videoCount + 1, examId],
  )
  let aliasExamItemId: string | null = null
  if (input.aliasExamItem) {
    aliasExamItemId = randomUUID()
    await pool.query(
      `INSERT INTO elearning_course_version_items (
         id, org_id, course_version_id, item_type, position, media_id, exam_id,
         completion_policy_version, completion_threshold_bps
       ) VALUES ($1, $2, $3, 'exam', $4, NULL, $5, NULL, NULL)`,
      [aliasExamItemId, input.org, versionId, videoCount + 2, examId],
    )
  }
  await pool.query(
    `UPDATE elearning_exams SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, versionId],
  )
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [assignmentId, input.org, versionId, `${input.org}-src`, `hash-${assignmentId}`, actor('assigner')],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, input.org, assignmentId, versionId, userId],
  )
  if (input.examStatus === 'retired') {
    await pool.query(
      `UPDATE elearning_exams SET status = 'retired', updated_at = now() WHERE org_id = $1 AND id = $2`,
      [input.org, examId],
    )
  }
  if (input.versionStatus === 'retired') {
    await pool.query(
      `UPDATE elearning_course_versions SET status = 'retired', updated_at = now() WHERE org_id = $1 AND id = $2`,
      [input.org, versionId],
    )
  }
  if (input.courseStatus && input.courseStatus !== 'active') {
    await pool.query(
      `UPDATE elearning_courses SET status = $1, updated_at = now() WHERE org_id = $2 AND id = $3`,
      [input.courseStatus, input.org, courseId],
    )
  }

  const videoProgress = input.videoProgress ?? 'completed'
  if (videoProgress !== 'missing') {
    for (const itemId of videoItemIds) {
      await pool.query(
        `INSERT INTO elearning_progress (
           org_id, assignment_member_id, course_version_id, course_version_item_id,
           user_id, status, effective_ms, max_position_ms, completed_at, required_at_completion
         ) VALUES ($1, $2, $3, $4, $5, $6, 9000, 10000, $7, TRUE)`,
        [
          input.org,
          memberId,
          versionId,
          itemId,
          userId,
          videoProgress === 'completed' ? 'completed' : 'in_progress',
          videoProgress === 'completed' ? new Date().toISOString() : null,
        ],
      )
    }
  }

  return {
    org: input.org,
    userId,
    courseId,
    versionId,
    examId,
    examItemId,
    aliasExamItemId,
    videoItemIds,
    memberId,
    singleId,
    multipleId,
    trueFalseId,
  }
}

async function attachPublishedExamMount(seed: Seed): Promise<{
  courseId: string
  versionId: string
  examItemId: string
  memberId: string
}> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const examItemId = randomUUID()
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Exam service course mount', 'active', $3)`,
    [courseId, seed.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, seed.org, courseId, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
    [mediaId, seed.org, `${NS}/media/${mediaId}`, 'a'.repeat(64), actor('uploader')],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000)`,
    [videoItemId, seed.org, versionId, mediaId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'exam', 2, NULL, $4, NULL, NULL)`,
    [examItemId, seed.org, versionId, seed.examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [seed.org, versionId],
  )
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [assignmentId, seed.org, versionId, `${seed.org}-src-${versionId}`, `hash-${assignmentId}`, actor('assigner')],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, seed.org, assignmentId, versionId, seed.userId],
  )
  await pool.query(
    `INSERT INTO elearning_progress (
       org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, status, effective_ms, max_position_ms, completed_at, required_at_completion
     ) VALUES ($1, $2, $3, $4, $5, 'completed', 9000, 10000, $6, TRUE)`,
    [seed.org, memberId, versionId, videoItemId, seed.userId, new Date().toISOString()],
  )

  return { courseId, versionId, examItemId, memberId }
}

async function countOrg(table: string, org: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
    [org],
  )
  return result.rows[0].n
}

function perfectAnswers(seed: Seed) {
  return {
    [seed.singleId]: ['a'],
    [seed.multipleId]: ['c', 'a'],
    [seed.trueFalseId]: ['t'],
  }
}

function failAnswers(seed: Seed) {
  return {
    [seed.singleId]: ['b'],
    [seed.multipleId]: ['a'],
    [seed.trueFalseId]: ['f'],
  }
}

function assertValuesFree(payload: unknown, org: string, userId: string): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain(userId)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toContain('single secret')
  expect(blob).not.toContain('multi secret')
  expect(blob).not.toContain('tf secret')
  expect(blob).not.toMatch(/"correct"/)
  expect(blob).not.toContain(`${NS}/media/`)
}

const PUBLIC_SUBMIT_KEYS = [
  'attemptId',
  'attemptNo',
  'status',
  'autoScore',
  'totalScore',
  'passed',
  'duplicate',
] as const

function assertPublicSubmitJson(payload: unknown): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  expect(Object.keys(raw)).toEqual([...PUBLIC_SUBMIT_KEYS])
  expect(raw.status).toBe('graded')
  const blob = JSON.stringify(raw)
  expect(blob).not.toContain('answers')
  expect(blob).not.toContain('questions')
  expect(blob).not.toContain('awarded')
  expect(blob).not.toContain('selected')
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toMatch(/"correct"/)
  return raw
}

function captureStart(
  promise: Promise<Awaited<ReturnType<typeof startElearningExam>>>,
): Promise<Awaited<ReturnType<typeof startElearningExam>> | Error> {
  return promise.then(
    (value) => value,
    (error) => (error instanceof Error ? error : new Error(String(error))),
  )
}

function unwrapStart(
  value: Awaited<ReturnType<typeof startElearningExam>> | Error,
): Awaited<ReturnType<typeof startElearningExam>> {
  if (value instanceof ElearningExamError) {
    expect(value.code).not.toMatch(/unique|23505/i)
    throw value
  }
  if (value instanceof Error) throw value
  return value
}

// Both start backends must park on the elearning-exam:lock advisory statement
// behind the holder. An item-scoped key cannot wait on the exam key.
async function waitUntilBothExamLockWaiters(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> $1
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
          AND query LIKE '%/* elearning-exam:lock */%'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if ((result.rows[0]?.n ?? 0) >= 2) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    'timed out waiting for both exam-start backends to park on the elearning-exam:lock advisory lock',
  )
}

describe('elearning V0.1 exam service gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('requires completed prior videos and rejects missing or in-progress prerequisites', async () => {
    const missingOrg = orgId('prereq-miss')
    const progressOrg = orgId('prereq-prog')
    const readyOrg = orgId('prereq-ok')
    const partialOrg = orgId('prereq-partial')
    seededOrgIds.push(missingOrg, progressOrg, readyOrg, partialOrg)

    const missing = await seedPublishedExam({ org: missingOrg, videoProgress: 'missing' })
    await expect(startElearningExam(db, {
      orgId: missingOrg,
      userId: missing.userId,
      itemId: missing.examItemId,
    })).rejects.toMatchObject({ code: 'prerequisite_incomplete' })

    const progressing = await seedPublishedExam({ org: progressOrg, videoProgress: 'in_progress' })
    await expect(startElearningExam(db, {
      orgId: progressOrg,
      userId: progressing.userId,
      itemId: progressing.examItemId,
    })).rejects.toMatchObject({ code: 'prerequisite_incomplete' })

    const partial = await seedPublishedExam({
      org: partialOrg,
      videoCount: 2,
      videoProgress: 'completed',
    })
    await pool.query(
      `UPDATE elearning_progress
          SET status = 'in_progress', completed_at = NULL
        WHERE org_id = $1 AND course_version_item_id = $2`,
      [partialOrg, partial.videoItemIds[1]],
    )
    await expect(startElearningExam(db, {
      orgId: partialOrg,
      userId: partial.userId,
      itemId: partial.examItemId,
    })).rejects.toMatchObject({ code: 'prerequisite_incomplete' })

    const ready = await seedPublishedExam({ org: readyOrg, videoCount: 2, videoProgress: 'completed' })
    const started = await startElearningExam(db, {
      orgId: readyOrg,
      userId: ready.userId,
      itemId: ready.examItemId,
    })
    expect(started).toEqual(expect.objectContaining({
      status: 'started',
      attemptNo: 1,
      duplicate: false,
    }))
    expect(started.paper.questions.map((question) => question.questionRevisionId)).toEqual([
      ready.singleId,
      ready.multipleId,
      ready.trueFalseId,
    ])
    expect(started.paper.questions[0].points).toBe(10)
    assertValuesFree(started, readyOrg, ready.userId)
    expect(await countOrg('elearning_exam_attempts', missingOrg)).toBe(0)
    expect(await countOrg('elearning_exam_attempts', progressOrg)).toBe(0)
    expect(await countOrg('elearning_exam_attempts', partialOrg)).toBe(0)
  })

  it('returns an existing started attempt and serializes concurrent starts to one row', async () => {
    const org = orgId('start-once')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const first = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    const second = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    expect(second.attemptId).toBe(first.attemptId)
    expect(second.duplicate).toBe(true)
    expect(second.attemptNo).toBe(1)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)

    const raceOrg = orgId('start-race')
    seededOrgIds.push(raceOrg)
    const race = await seedPublishedExam({ org: raceOrg })
    const raced = await Promise.all([
      startElearningExam(db, { orgId: raceOrg, userId: race.userId, itemId: race.examItemId }),
      startElearningExam(db, { orgId: raceOrg, userId: race.userId, itemId: race.examItemId }),
    ])
    expect(raced[0].attemptId).toBe(raced[1].attemptId)
    expect(raced.filter((row) => row.duplicate)).toHaveLength(1)
    expect(await countOrg('elearning_exam_attempts', raceOrg)).toBe(1)
    const nos = await pool.query(
      `SELECT attempt_no, status FROM elearning_exam_attempts WHERE org_id = $1`,
      [raceOrg],
    )
    expect(Number(nos.rows[0].attempt_no)).toBe(1)
    expect(nos.rows[0].status).toBe('started')
    expect(nos.rows).toHaveLength(1)
  })

  it('blocks cross-org items, revoked members, withdrawn heads, and video items', async () => {
    const org = orgId('neg')
    const other = orgId('neg-other')
    seededOrgIds.push(org, other)
    const seed = await seedPublishedExam({ org })
    const outsider = await seedPublishedExam({ org: other })

    await expect(startElearningExam(db, {
      orgId: other,
      userId: outsider.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(startElearningExam(db, {
      orgId: org,
      userId: outsider.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })
    await expect(startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.videoItemIds[0],
    })).rejects.toMatchObject({ code: 'unsupported_item' })

    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot revoke'
        WHERE org_id = $2 AND id = $3`,
      [actor('revoker'), org, seed.memberId],
    )
    await expect(startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })
    expect(await countOrg('elearning_exam_attempts', org)).toBe(0)

    const withdrawnOrg = orgId('wd')
    seededOrgIds.push(withdrawnOrg)
    const withdrawn = await seedPublishedExam({ org: withdrawnOrg, courseStatus: 'withdrawn' })
    await expect(startElearningExam(db, {
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      itemId: withdrawn.examItemId,
    })).rejects.toMatchObject({ code: 'course_withdrawn' })

    const pinnedOrg = orgId('pinned')
    seededOrgIds.push(pinnedOrg)
    const pinned = await seedPublishedExam({
      org: pinnedOrg,
      versionStatus: 'retired',
      examStatus: 'retired',
      courseStatus: 'archived',
    })
    await expect(startElearningExam(db, {
      orgId: pinnedOrg,
      userId: pinned.userId,
      itemId: pinned.examItemId,
    })).resolves.toMatchObject({ status: 'started', duplicate: false })
  })

  it('enforces max_attempts after a graded paper and uses the next attempt_no', async () => {
    const org = orgId('max')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org, maxAttempts: 1 })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })
    await expect(startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'max_attempts' })
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)

    const twoOrg = orgId('max-two')
    seededOrgIds.push(twoOrg)
    const two = await seedPublishedExam({ org: twoOrg, maxAttempts: 2 })
    const first = await startElearningExam(db, {
      orgId: twoOrg,
      userId: two.userId,
      itemId: two.examItemId,
    })
    await submitElearningExam(db, {
      orgId: twoOrg,
      userId: two.userId,
      attemptId: first.attemptId,
      answers: failAnswers(two),
    })
    const retry = await startElearningExam(db, {
      orgId: twoOrg,
      userId: two.userId,
      itemId: two.examItemId,
    })
    expect(retry.attemptNo).toBe(2)
    expect(retry.attemptId).not.toBe(first.attemptId)
    expect(retry.duplicate).toBe(false)
  })

  it('autogrades pass and fail, writes one auto ledger row, and redacts secrets', async () => {
    const passOrg = orgId('pass')
    const failOrg = orgId('fail')
    seededOrgIds.push(passOrg, failOrg)
    const passing = await seedPublishedExam({ org: passOrg })
    const started = await startElearningExam(db, {
      orgId: passOrg,
      userId: passing.userId,
      itemId: passing.examItemId,
    })
    const passed = await submitElearningExam(db, {
      orgId: passOrg,
      userId: passing.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(passing),
    })
    expect(assertPublicSubmitJson(passed)).toEqual({
      attemptId: started.attemptId,
      attemptNo: 1,
      status: 'graded',
      autoScore: 30,
      totalScore: 30,
      passed: true,
      duplicate: false,
    })
    assertValuesFree(passed, passOrg, passing.userId)

    const failing = await seedPublishedExam({ org: failOrg })
    const failStart = await startElearningExam(db, {
      orgId: failOrg,
      userId: failing.userId,
      itemId: failing.examItemId,
    })
    const failed = await submitElearningExam(db, {
      orgId: failOrg,
      userId: failing.userId,
      attemptId: failStart.attemptId,
      answers: failAnswers(failing),
    })
    expect(failed).toEqual(expect.objectContaining({
      autoScore: 0,
      totalScore: 30,
      passed: false,
      duplicate: false,
    }))
    assertPublicSubmitJson(failed)
    assertValuesFree(failed, failOrg, failing.userId)

    const ledger = await pool.query(
      `SELECT kind, score, max_score, details, grader_id
         FROM elearning_grading_records WHERE org_id = $1`,
      [passOrg],
    )
    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toEqual(expect.objectContaining({
      kind: ELEARNING_EXAM_GRADE_KIND,
      grader_id: ELEARNING_EXAM_AUTO_GRADER,
    }))
    expect(Number(ledger.rows[0].score)).toBe(30)
    expect(Number(ledger.rows[0].max_score)).toBe(30)
    const details = ledger.rows[0].details as { questions: Array<{ awarded: number; selected: string[] }> }
    expect(details.questions.map((row) => row.awarded)).toEqual([10, 10, 10])
    expect(details.questions[1].selected).toEqual(['a', 'c'])
    assertValuesFree(ledger.rows[0].details, passOrg, passing.userId)

    const attempt = await pool.query(
      `SELECT status, auto_score, total_score, passed, answers
         FROM elearning_exam_attempts WHERE org_id = $1`,
      [passOrg],
    )
    expect(attempt.rows[0].status).toBe('graded')
    expect(Number(attempt.rows[0].auto_score)).toBe(30)
    expect(attempt.rows[0].passed).toBe(true)
    const storedAnswers = attempt.rows[0].answers as Record<string, string[]>
    expect(storedAnswers[passing.multipleId]).toEqual(['a', 'c'])
  })

  it('accepts mixed-case question UUID keys on submit and still autogrades', async () => {
    const org = orgId('uuid-case')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    const passed = await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: {
        [seed.singleId.toUpperCase()]: ['a'],
        [`${seed.multipleId.slice(0, 8).toUpperCase()}${seed.multipleId.slice(8)}`]: ['c', 'a'],
        [seed.trueFalseId]: ['t'],
      },
    })
    expect(passed).toEqual(expect.objectContaining({
      autoScore: 30,
      passed: true,
      duplicate: false,
    }))
    assertPublicSubmitJson(passed)
    const stored = await pool.query(
      `SELECT answers FROM elearning_exam_attempts WHERE org_id = $1`,
      [org],
    )
    const storedAnswers = stored.rows[0].answers as Record<string, string[]>
    expect(storedAnswers[seed.singleId]).toEqual(['a'])
    expect(storedAnswers[seed.multipleId]).toEqual(['a', 'c'])
  })

  it('replays identical graded answers and conflicts when the payload changes', async () => {
    const org = orgId('retry')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    const first = await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })
    const replay = await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: {
        [seed.singleId]: ['a'],
        [seed.multipleId]: ['a', 'c'],
        [seed.trueFalseId]: ['t'],
      },
    })
    expect(assertPublicSubmitJson(first)).toEqual({
      attemptId: started.attemptId,
      attemptNo: 1,
      status: 'graded',
      autoScore: 30,
      totalScore: 30,
      passed: true,
      duplicate: false,
    })
    expect(assertPublicSubmitJson(replay)).toEqual({
      attemptId: first.attemptId,
      attemptNo: 1,
      status: 'graded',
      autoScore: 30,
      totalScore: 30,
      passed: true,
      duplicate: true,
    })
    expect(await countOrg('elearning_grading_records', org)).toBe(1)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)

    await expect(submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: failAnswers(seed),
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(await countOrg('elearning_grading_records', org)).toBe(1)

    await pool.query(
      `UPDATE elearning_courses SET status = 'withdrawn' WHERE org_id = $1 AND id = $2`,
      [org, seed.courseId],
    )
    await expect(submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })).rejects.toMatchObject({ code: 'course_withdrawn' })
  })

  it('refuses submit after revoke and does not insert a second auto grade', async () => {
    const org = orgId('revoke-submit')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot revoke'
        WHERE org_id = $2 AND id = $3`,
      [actor('revoker'), org, seed.memberId],
    )
    await expect(submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })
    const attempt = await pool.query(
      `SELECT status, answers FROM elearning_exam_attempts WHERE org_id = $1`,
      [org],
    )
    expect(attempt.rows[0].status).toBe('started')
    expect(attempt.rows[0].answers).toBeNull()
    expect(await countOrg('elearning_grading_records', org)).toBe(0)
  })

  it('rejects start when pass_score exceeds the frozen paper total and creates no attempt', async () => {
    const org = orgId('pass-over')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org, passScore: 20 })
    await setTriggers(false)
    try {
      await pool.query(
        `UPDATE elearning_exams SET pass_score = 31, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [org, seed.examId],
      )
    } finally {
      await setTriggers(true)
    }
    await expect(startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })).rejects.toMatchObject({ code: 'unavailable' })
    expect(await countOrg('elearning_exam_attempts', org)).toBe(0)
    expect(await countOrg('elearning_grading_records', org)).toBe(0)
  })

  it('grades against frozen paper_snapshot.passScore after the live exam pass_score changes', async () => {
    const org = orgId('pass-frozen')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org, passScore: 20 })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    await setTriggers(false)
    try {
      await pool.query(
        `UPDATE elearning_exams SET pass_score = 100, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [org, seed.examId],
      )
    } finally {
      await setTriggers(true)
    }
    const passed = await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })
    expect(passed).toEqual(expect.objectContaining({
      autoScore: 30,
      totalScore: 30,
      passed: true,
      duplicate: false,
    }))

    const failOrg = orgId('pass-frozen-fail')
    seededOrgIds.push(failOrg)
    const failing = await seedPublishedExam({ org: failOrg, passScore: 20 })
    const failStart = await startElearningExam(db, {
      orgId: failOrg,
      userId: failing.userId,
      itemId: failing.examItemId,
    })
    await setTriggers(false)
    try {
      await pool.query(
        `UPDATE elearning_exams SET pass_score = 0, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [failOrg, failing.examId],
      )
    } finally {
      await setTriggers(true)
    }
    const failed = await submitElearningExam(db, {
      orgId: failOrg,
      userId: failing.userId,
      attemptId: failStart.attemptId,
      answers: failAnswers(failing),
    })
    expect(failed.passed).toBe(false)
    expect(failed.autoScore).toBe(0)
  })

  it('fails unavailable when a stored aggregate disagrees with a snapshot recompute', async () => {
    const org = orgId('agg-corrupt')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })
    await setTriggers(false)
    try {
      await pool.query(
        `UPDATE elearning_exam_attempts
            SET auto_score = 0
          WHERE org_id = $1 AND id = $2`,
        [org, started.attemptId],
      )
    } finally {
      await setTriggers(true)
    }
    await expect(submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })).rejects.toMatchObject({ code: 'unavailable' })
    expect(await countOrg('elearning_grading_records', org)).toBe(1)
  })

  it('serializes starts from two course items of the same exam and never leaks uniqueness errors', async () => {
    const org = orgId('alias-seq')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org, aliasExamItem: true })
    expect(seed.aliasExamItemId).toBeTruthy()
    const first = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    const second = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.aliasExamItemId as string,
    })
    expect(second.attemptId).toBe(first.attemptId)
    expect(second.duplicate).toBe(true)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)

    const raceOrg = orgId('alias-race')
    seededOrgIds.push(raceOrg)
    const race = await seedPublishedExam({ org: raceOrg, aliasExamItem: true })
    const aliasItemId = race.aliasExamItemId as string
    let raced: Awaited<ReturnType<typeof startElearningExam>>[]
    try {
      raced = await Promise.all([
        startElearningExam(db, { orgId: raceOrg, userId: race.userId, itemId: race.examItemId }),
        startElearningExam(db, { orgId: raceOrg, userId: race.userId, itemId: aliasItemId }),
      ])
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningExamError)
      expect((error as ElearningExamError).code).not.toMatch(/unique|23505/i)
      throw error
    }
    expect(raced[0].attemptId).toBe(raced[1].attemptId)
    expect(raced.filter((row) => row.duplicate)).toHaveLength(1)
    expect(await countOrg('elearning_exam_attempts', raceOrg)).toBe(1)
    const nos = await pool.query(
      `SELECT attempt_no, status FROM elearning_exam_attempts WHERE org_id = $1`,
      [raceOrg],
    )
    expect(nos.rows).toHaveLength(1)
    expect(Number(nos.rows[0].attempt_no)).toBe(1)
    expect(nos.rows[0].status).toBe('started')
  })

  it('serializes concurrent starts of the same exam from two published course versions onto one attempt', async () => {
    const org = orgId('cross-mount')
    seededOrgIds.push(org)
    const seed = await seedPublishedExam({ org })
    const mount = await attachPublishedExamMount(seed)
    expect(mount.versionId).not.toBe(seed.versionId)
    expect(mount.examItemId).not.toBe(seed.examItemId)
    expect(mount.memberId).not.toBe(seed.memberId)
    expect(await countOrg('elearning_assignment_members', org)).toBe(2)
    expect(await countOrg('elearning_course_versions', org)).toBe(2)

    const holder: PoolClient = await pool.connect()
    const captured: Array<ReturnType<typeof captureStart>> = []
    let raced: Awaited<ReturnType<typeof startElearningExam>>[] | undefined
    try {
      await holder.query('BEGIN')
      const holderPid = Number(
        (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid,
      )
      await holder.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [elearningExamLockKey(org, seed.userId, seed.examId)],
      )
      captured.push(
        captureStart(startElearningExam(db, {
          orgId: org,
          userId: seed.userId,
          itemId: seed.examItemId,
        })),
        captureStart(startElearningExam(db, {
          orgId: org,
          userId: seed.userId,
          itemId: mount.examItemId,
        })),
      )
      try {
        await waitUntilBothExamLockWaiters(holderPid)
        expect(await countOrg('elearning_exam_attempts', org)).toBe(0)
      } finally {
        await holder.query('ROLLBACK')
      }
      raced = (await Promise.all(captured)).map(unwrapStart)
    } finally {
      if (captured.length > 0) {
        await Promise.all(captured)
      }
      try {
        await holder.query('ROLLBACK')
      } catch {
        /* already released */
      }
      holder.release()
    }

    if (!raced) {
      throw new Error('cross-version start race did not settle')
    }
    expect(raced).toHaveLength(2)
    expect(raced[0].attemptId).toBe(raced[1].attemptId)
    expect(raced.filter((row) => row.duplicate)).toHaveLength(1)
    expect(raced.filter((row) => row.duplicate === false)).toHaveLength(1)
    expect(raced[0].attemptNo).toBe(1)
    expect(raced[1].attemptNo).toBe(1)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)
    const nos = await pool.query(
      `SELECT attempt_no, status, exam_id FROM elearning_exam_attempts WHERE org_id = $1`,
      [org],
    )
    expect(nos.rows).toHaveLength(1)
    expect(Number(nos.rows[0].attempt_no)).toBe(1)
    expect(nos.rows[0].status).toBe('started')
    expect(String(nos.rows[0].exam_id)).toBe(seed.examId)
    assertValuesFree(raced, org, seed.userId)
  })

  it('persists draft answers on a started attempt and replays them without grading', async () => {
    const org = orgId('draft')
    const other = orgId('draft-other')
    seededOrgIds.push(org, other)
    const seed = await seedPublishedExam({ org })
    const outsider = await seedPublishedExam({ org: other })
    const started = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    expect(Object.keys(started)).toEqual([
      'attemptId',
      'attemptNo',
      'status',
      'paper',
      'answers',
      'duplicate',
    ])
    expect(started.answers).toEqual({
      [seed.singleId]: [],
      [seed.multipleId]: [],
      [seed.trueFalseId]: [],
    })
    expect(JSON.stringify(started)).not.toContain('answerKey')
    expect(JSON.stringify(started)).not.toMatch(/"correct"/)

    const first = await saveElearningExamAnswers(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: { [seed.singleId]: ['a'], [seed.multipleId]: ['c', 'a'] },
    })
    expect(first.duplicate).toBe(false)
    expect(first.status).toBe('started')
    expect(first.answers).toEqual({
      [seed.singleId]: ['a'],
      [seed.multipleId]: ['a', 'c'],
      [seed.trueFalseId]: [],
    })
    expect(Object.keys(first)).toEqual(Object.keys(started))
    assertValuesFree(first, org, seed.userId)

    const same = await saveElearningExamAnswers(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: { [seed.singleId]: ['a'], [seed.multipleId]: ['a', 'c'], [seed.trueFalseId]: [] },
    })
    expect(same.duplicate).toBe(true)
    expect(same.answers).toEqual(first.answers)

    const replayed = await startElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.examItemId,
    })
    expect(replayed.duplicate).toBe(true)
    expect(replayed.attemptId).toBe(started.attemptId)
    expect(replayed.answers).toEqual(first.answers)
    expect(await countOrg('elearning_exam_attempts', org)).toBe(1)
    expect(await countOrg('elearning_grading_records', org)).toBe(0)

    await expect(saveElearningExamAnswers(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: { [seed.singleId]: ['z'] },
    })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(saveElearningExamAnswers(db, {
      orgId: other,
      userId: outsider.userId,
      attemptId: started.attemptId,
      answers: first.answers,
    })).rejects.toMatchObject({ code: 'not_found' })
    await expect(saveElearningExamAnswers(db, {
      orgId: org,
      userId: outsider.userId,
      attemptId: started.attemptId,
      answers: first.answers,
    })).rejects.toMatchObject({ code: 'not_found' })
    const stored = await pool.query(
      `SELECT answers, status FROM elearning_exam_attempts WHERE org_id = $1 AND id = $2`,
      [org, started.attemptId],
    )
    expect(stored.rows[0].status).toBe('started')
    expect(stored.rows[0].answers).toEqual(first.answers)

    await submitElearningExam(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })
    await expect(saveElearningExamAnswers(db, {
      orgId: org,
      userId: seed.userId,
      attemptId: started.attemptId,
      answers: perfectAnswers(seed),
    })).rejects.toMatchObject({ code: 'conflict' })
  })
})
