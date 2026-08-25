/**
 * E-learning V0.1 learner assigned-course list gate (real PostgreSQL).
 *
 * Assumes content/assessment + watch-progress migrations have already been
 * applied by the caller. Does not call up()/down() and does not write
 * kysely_migration.
 *
 * DATABASE_URL is required (packages/core-backend/.env is loaded when unset).
 * A missing URL throws (refuses skip-shaped green). HTTP/API surfaces are
 * out of this slice.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import { ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS } from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'
import {
  listElearningLearnerCourses,
  type ElearningLearnerCoursesQueryable,
} from '../../src/services/elearning-learner-courses'

function applyDotEnv(filePath: string): void {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (key === '' || process.env[key] !== undefined) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

applyDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'))

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 learner-courses service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-learn-${STAMP}`

const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
]

const db: ElearningLearnerCoursesQueryable = {
  async query(sql, params) {
    const result = await pool.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  },
}

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
  otherUserId: string
  courseId: string
  versionId: string
  title: string
  videoItemId: string
  extraVideoItemId: string
  examItemId: string
  extraExamItemId: string
  examId: string
  memberId: string
  assignmentId: string
  storageKey: string
}

async function insertAssignment(input: {
  org: string
  versionId: string
  userId: string
  deadline?: string | null
  assignedAt?: string
  sourceKey?: string
}): Promise<{ assignmentId: string; memberId: string }> {
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      assignmentId,
      input.org,
      input.versionId,
      input.sourceKey ?? `${input.org}-src-${assignmentId}`,
      `hash-${assignmentId}`,
      input.deadline ?? null,
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source, assigned_at
     ) VALUES ($1, $2, $3, $4, $5, 'manual', $6)`,
    [
      memberId,
      input.org,
      assignmentId,
      input.versionId,
      input.userId,
      input.assignedAt ?? new Date().toISOString(),
    ],
  )
  return { assignmentId, memberId }
}

async function seedCourse(input: {
  org: string
  userId: string
  otherUserId: string
  title: string
  assignedAt: string
  deadline?: string | null
  courseStatus?: 'active' | 'archived' | 'withdrawn'
  versionStatus?: 'published' | 'retired'
  extraAssignment?: boolean
}): Promise<Seed> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const extraMediaId = randomUUID()
  const examId = randomUUID()
  const extraExamId = randomUUID()
  const questionId = randomUUID()
  const extraQuestionId = randomUUID()
  const revisionId = randomUUID()
  const extraRevisionId = randomUUID()
  const extraVideoItemId = randomUUID()
  const videoItemId = randomUUID()
  const extraExamItemId = randomUUID()
  const examItemId = randomUUID()
  const storageKey = `${NS}/media/${mediaId}/storage-secret`

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, $3, 'active', $4)`,
    [courseId, input.org, input.title, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', $4, $5)`,
    [versionId, input.org, courseId, input.title, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES
       ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 20000, 'ready', $5),
       ($6, $2, $7, 'video/mp4', 'video/mp4', 2048, $8, 10000, 'ready', $5)`,
    [
      extraMediaId,
      input.org,
      `${NS}/media/${extraMediaId}/storage-secret`,
      'b'.repeat(64),
      actor('uploader'),
      mediaId,
      storageKey,
      'c'.repeat(64),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3), ($4, $2, $3)`,
    [questionId, input.org, actor('author'), extraQuestionId],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, explanation, points, created_by
     ) VALUES
       ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 'secret rationale', 10, $6),
       ($7, $2, $8, 1, 'single_choice', 'Pick extra', $4::jsonb, $5::jsonb, 'extra secret', 10, $6)`,
    [
      extraRevisionId,
      input.org,
      extraQuestionId,
      JSON.stringify([{ id: 'a', text: 'alpha' }, { id: 'b', text: 'beta' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
      revisionId,
      questionId,
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Extra exam', 'draft', 10, 3, $3), ($4, $2, 'Primary exam', 'draft', 10, 3, $3)`,
    [extraExamId, input.org, actor('author'), examId],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10), ($1, $4, $5, 1, 10)`,
    [input.org, extraExamId, extraRevisionId, examId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES
       ($1, $2, $3, 'video', 2, $4, NULL, 'video-v1-90pct', 9000),
       ($5, $2, $3, 'video', 1, $6, NULL, 'video-v1-90pct', 9000),
       ($7, $2, $3, 'exam', 4, NULL, $8, NULL, NULL),
       ($9, $2, $3, 'exam', 3, NULL, $10, NULL, NULL)`,
    [
      extraVideoItemId,
      input.org,
      versionId,
      extraMediaId,
      videoItemId,
      mediaId,
      extraExamItemId,
      extraExamId,
      examItemId,
      examId,
    ],
  )
  await pool.query(
    `UPDATE elearning_exams SET status = 'published', updated_at = now() WHERE org_id = $1 AND id IN ($2, $3)`,
    [input.org, examId, extraExamId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, versionId],
  )

  const { assignmentId, memberId } = await insertAssignment({
    org: input.org,
    versionId,
    userId: input.userId,
    deadline: input.deadline,
    assignedAt: input.assignedAt,
  })
  if (input.extraAssignment) {
    await insertAssignment({
      org: input.org,
      versionId,
      userId: input.userId,
      deadline: '1999-01-01T00:00:00.000Z',
      assignedAt: '2099-01-01T00:00:00.000Z',
      sourceKey: `${input.org}-src-dup-${versionId}`,
    })
  }
  await insertAssignment({
    org: input.org,
    versionId,
    userId: input.otherUserId,
    assignedAt: input.assignedAt,
    sourceKey: `${input.org}-src-other-${versionId}`,
  })

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

  return {
    org: input.org,
    userId: input.userId,
    otherUserId: input.otherUserId,
    courseId,
    versionId,
    title: input.title,
    videoItemId,
    extraVideoItemId,
    examItemId,
    extraExamItemId,
    examId,
    memberId,
    assignmentId,
    storageKey,
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

async function insertAttempt(input: {
  org: string
  examId: string
  versionId: string
  userId: string
  attemptNo: number
  status: 'started' | 'graded'
  passed?: boolean
}): Promise<string> {
  const attemptId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, user_id, attempt_no,
       paper_snapshot, answers, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULL, 'started')`,
    [
      attemptId,
      input.org,
      input.examId,
      input.versionId,
      input.userId,
      input.attemptNo,
      JSON.stringify({ domain: 'elearning.exam.paper.v1', secret: 'paper' }),
    ],
  )
  if (input.status === 'started') return attemptId
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
  return attemptId
}

function assertNoSecrets(payload: unknown, org: string, userId: string, otherUserId: string, storageKey: string): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain(userId)
  expect(blob).not.toContain(otherUserId)
  expect(blob).not.toContain(storageKey)
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain('sha256')
  expect(blob).not.toContain('paper_snapshot')
  expect(blob).not.toContain('answers')
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toContain('secret rationale')
  expect(blob).not.toContain('extra secret')
  expect(blob).not.toContain(`${NS}/media/`)
  expect(blob).not.toMatch(/"correct"/)
}

describe('elearning V0.1 learner assigned-course list (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('lists one active assigned course with first video/exam items and keeps an expired deadline', async () => {
    const org = orgId('active')
    seededOrgIds.push(org)
    const userId = actor('learner')
    const otherUserId = actor('other')
    const assignedAt = '2026-02-01T00:00:00.000Z'
    const seed = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Active assigned course',
      assignedAt,
      deadline: '2000-01-01T00:00:00.000Z',
      extraAssignment: true,
    })

    const rows = await listElearningLearnerCourses(db, { orgId: org, userId })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(expect.objectContaining({
      courseId: seed.courseId,
      courseVersionId: seed.versionId,
      title: 'Active assigned course',
      completed: false,
    }))
    expect(rows[0].assignment).toEqual({
      deadline: '2000-01-01T00:00:00.000Z',
      assignedAt,
    })
    expect(rows[0].video.itemId).toBe(seed.videoItemId)
    expect(rows[0].video.itemId).not.toBe(seed.extraVideoItemId)
    expect(rows[0].video).toEqual(expect.objectContaining({
      durationMs: 10_000,
      status: 'not_started',
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    }))
    expect(rows[0].exam.itemId).toBe(seed.examItemId)
    expect(rows[0].exam.itemId).not.toBe(seed.extraExamItemId)
    expect(rows[0].exam.latestAttempt).toBeNull()
    assertNoSecrets(rows, org, userId, otherUserId, seed.storageKey)
  })

  it('keeps archived+retired assigned access and excludes revoked, withdrawn, draft, and cross-org rows', async () => {
    const org = orgId('access')
    const otherOrg = orgId('cross')
    seededOrgIds.push(org, otherOrg)
    const userId = actor('learner')
    const otherUserId = actor('other')

    const archived = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Archived retired course',
      assignedAt: '2026-01-01T00:00:00.000Z',
      courseStatus: 'archived',
      versionStatus: 'retired',
    })
    const withdrawn = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Withdrawn course',
      assignedAt: '2026-01-02T00:00:00.000Z',
      courseStatus: 'withdrawn',
    })
    const revoked = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Revoked course',
      assignedAt: '2026-01-03T00:00:00.000Z',
    })
    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $2, revocation_reason = 'revoked'
        WHERE org_id = $1 AND id = $3`,
      [org, actor('revoker'), revoked.memberId],
    )

    const draftCourseId = randomUUID()
    const draftVersionId = randomUUID()
    await pool.query(
      `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
       VALUES ($1, $2, 'Draft course', 'active', $3)`,
      [draftCourseId, org, actor('author')],
    )
    await pool.query(
      `INSERT INTO elearning_course_versions
         (id, org_id, course_id, version, status, title, created_by)
       VALUES ($1, $2, $3, 1, 'draft', 'Draft course', $4)`,
      [draftVersionId, org, draftCourseId, actor('author')],
    )
    await setTriggers(false)
    try {
      await insertAssignment({
        org,
        versionId: draftVersionId,
        userId,
        assignedAt: '2026-01-04T00:00:00.000Z',
        sourceKey: `${org}-src-draft`,
      })
    } finally {
      await setTriggers(true)
    }

    await seedCourse({
      org: otherOrg,
      userId,
      otherUserId,
      title: 'Cross org course',
      assignedAt: '2026-01-05T00:00:00.000Z',
    })

    const rows = await listElearningLearnerCourses(db, { orgId: org, userId })
    expect(rows.map((row) => row.courseVersionId)).toEqual([archived.versionId])
    expect(rows[0].title).toBe('Archived retired course')
    expect(rows.some((row) => row.courseVersionId === withdrawn.versionId)).toBe(false)
    expect(rows.some((row) => row.courseVersionId === revoked.versionId)).toBe(false)
    expect(rows.some((row) => row.courseVersionId === draftVersionId)).toBe(false)
    assertNoSecrets(rows, org, userId, otherUserId, archived.storageKey)
  })

  it('projects the latest attempt aggregate and completes only on graded pass after video completion', async () => {
    const org = orgId('attempt')
    seededOrgIds.push(org)
    const userId = actor('learner')
    const otherUserId = actor('other')
    const seed = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Attempt course',
      assignedAt: '2026-03-01T00:00:00.000Z',
    })
    await insertProgress({
      org,
      memberId: seed.memberId,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId,
      status: 'completed',
    })
    const first = await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId,
      attemptNo: 1,
      status: 'graded',
      passed: false,
    })
    const latest = await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId,
      attemptNo: 2,
      status: 'graded',
      passed: true,
    })
    await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId: otherUserId,
      attemptNo: 1,
      status: 'graded',
      passed: true,
    })

    const rows = await listElearningLearnerCourses(db, { orgId: org, userId })
    expect(rows).toHaveLength(1)
    expect(rows[0].video.status).toBe('completed')
    expect(rows[0].exam.latestAttempt).toEqual(expect.objectContaining({
      attemptId: latest,
      attemptNo: 2,
      status: 'graded',
      autoScore: 10,
      totalScore: 10,
      passed: true,
    }))
    expect(rows[0].exam.latestAttempt?.attemptId).not.toBe(first)
    expect(rows[0].completed).toBe(true)
    expect(rows[0].exam.latestAttempt?.startedAt).toEqual(expect.any(String))
    expect(rows[0].exam.latestAttempt?.submittedAt).toEqual(expect.any(String))
    expect(rows[0].exam.latestAttempt?.gradedAt).toEqual(expect.any(String))
    assertNoSecrets(rows, org, userId, otherUserId, seed.storageKey)
  })

  it('keeps completed true when attempt 1 passed and attempt 2 is a started retake', async () => {
    const org = orgId('retake')
    seededOrgIds.push(org)
    const userId = actor('learner')
    const otherUserId = actor('other')
    const seed = await seedCourse({
      org,
      userId,
      otherUserId,
      title: 'Retake course',
      assignedAt: '2026-04-01T00:00:00.000Z',
    })
    await insertProgress({
      org,
      memberId: seed.memberId,
      versionId: seed.versionId,
      itemId: seed.videoItemId,
      userId,
      status: 'completed',
    })
    const first = await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId,
      attemptNo: 1,
      status: 'graded',
      passed: true,
    })
    const latest = await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId,
      attemptNo: 2,
      status: 'started',
    })
    await insertAttempt({
      org,
      examId: seed.examId,
      versionId: seed.versionId,
      userId: otherUserId,
      attemptNo: 1,
      status: 'graded',
      passed: false,
    })

    const rows = await listElearningLearnerCourses(db, { orgId: org, userId })
    expect(rows).toHaveLength(1)
    expect(rows[0].video.status).toBe('completed')
    expect(rows[0].exam.latestAttempt).toEqual(expect.objectContaining({
      attemptId: latest,
      attemptNo: 2,
      status: 'started',
      autoScore: null,
      totalScore: null,
      passed: null,
    }))
    expect(rows[0].exam.latestAttempt?.attemptId).not.toBe(first)
    expect(rows[0].exam.latestAttempt?.submittedAt).toBeNull()
    expect(rows[0].exam.latestAttempt?.gradedAt).toBeNull()
    expect(rows[0].completed).toBe(true)
    assertNoSecrets(rows, org, userId, otherUserId, seed.storageKey)
  })
})
