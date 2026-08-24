/**
 * Read-only V0.1 learner assigned-course list (assignment-only named pilot).
 * One row per course version. Public values and errors are values-free.
 */
import { ELEARNING_MEDIA_MIME } from './elearning-media-validation'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from './elearning-watch-progress'

export const ELEARNING_LEARNER_COURSES_LIMIT = 100 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ATTEMPT_STATUSES = ['started', 'submitted', 'graded', 'expired'] as const
const VIDEO_PROGRESS_STATUSES = ['in_progress', 'completed'] as const

export type ElearningLearnerCoursesErrorCode = 'invalid_input' | 'unavailable'

export type ElearningLearnerVideoStatus = 'not_started' | 'in_progress' | 'completed'

export type ElearningLearnerAttemptStatus = (typeof ATTEMPT_STATUSES)[number]

export class ElearningLearnerCoursesError extends Error {
  constructor(readonly code: ElearningLearnerCoursesErrorCode) {
    super(code)
    this.name = 'ElearningLearnerCoursesError'
  }
}

export interface ElearningLearnerCoursesQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ListElearningLearnerCoursesInput {
  orgId: string
  userId: string
}

export interface ElearningLearnerAssignment {
  deadline: string | null
  assignedAt: string
}

export interface ElearningLearnerVideo {
  itemId: string
  durationMs: number
  status: ElearningLearnerVideoStatus
  effectiveMs: number
  maxPositionMs: number
  completedAt: string | null
}

export interface ElearningLearnerExamAttempt {
  attemptId: string
  attemptNo: number
  status: ElearningLearnerAttemptStatus
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
  startedAt: string
  submittedAt: string | null
  gradedAt: string | null
}

export interface ElearningLearnerExam {
  itemId: string
  latestAttempt: ElearningLearnerExamAttempt | null
}

export interface ElearningLearnerCourse {
  courseId: string
  courseVersionId: string
  title: string
  assignment: ElearningLearnerAssignment
  video: ElearningLearnerVideo
  exam: ElearningLearnerExam
  completed: boolean
}

const LIST_SQL = `/* elearning-learner-courses:list */
WITH assigned_heads AS (
  SELECT DISTINCT ON (m.course_version_id)
    m.course_version_id AS course_version_id,
    m.assigned_at AS assigned_at,
    a.deadline AS deadline
  FROM elearning_assignment_members m
  JOIN elearning_assignments a
    ON a.org_id = m.org_id AND a.id = m.assignment_id
  WHERE m.org_id = $1
    AND m.user_id = $2
    AND m.revoked_at IS NULL
  ORDER BY m.course_version_id ASC, m.assigned_at ASC, m.id ASC
)
SELECT
  c.id AS course_id,
  v.id AS course_version_id,
  c.title AS title,
  assigned_heads.deadline AS assignment_deadline,
  assigned_heads.assigned_at AS assignment_assigned_at,
  video.item_id AS video_item_id,
  video.duration_ms AS video_duration_ms,
  progress.status AS video_status,
  progress.effective_ms AS video_effective_ms,
  progress.max_position_ms AS video_max_position_ms,
  progress.completed_at AS video_completed_at,
  exam.item_id AS exam_item_id,
  attempt.id AS attempt_id,
  attempt.attempt_no AS attempt_no,
  attempt.status AS attempt_status,
  attempt.auto_score AS attempt_auto_score,
  attempt.total_score AS attempt_total_score,
  attempt.passed AS attempt_passed,
  attempt.started_at AS attempt_started_at,
  attempt.submitted_at AS attempt_submitted_at,
  attempt.graded_at AS attempt_graded_at,
  EXISTS (
    SELECT 1
    FROM elearning_exam_attempts any_pass
    WHERE any_pass.org_id = $1
      AND any_pass.user_id = $2
      AND any_pass.exam_id = exam.exam_id
      AND any_pass.course_version_id = v.id
      AND any_pass.status = 'graded'
      AND any_pass.passed IS TRUE
  ) AS any_passed
FROM assigned_heads
JOIN elearning_course_versions v
  ON v.org_id = $1 AND v.id = assigned_heads.course_version_id
JOIN elearning_courses c
  ON c.org_id = v.org_id AND c.id = v.course_id
JOIN LATERAL (
  SELECT i.id AS item_id, media.duration_ms AS duration_ms
    FROM elearning_course_version_items i
    JOIN elearning_media media
      ON media.org_id = i.org_id AND media.id = i.media_id
   WHERE i.org_id = $1
     AND i.course_version_id = v.id
     AND i.item_type = 'video'
     AND i.completion_policy_version = '${ELEARNING_WATCH_POLICY_VERSION}'
     AND i.completion_threshold_bps = ${ELEARNING_WATCH_THRESHOLD_BPS}
     AND media.status = 'ready'
     AND media.mime_type = '${ELEARNING_MEDIA_MIME}'
     AND media.magic_mime_type = '${ELEARNING_MEDIA_MIME}'
     AND media.duration_ms IS NOT NULL
     AND media.duration_ms > 0
   ORDER BY i.position ASC, i.id ASC
   LIMIT 1
) video ON TRUE
JOIN LATERAL (
  SELECT i.id AS item_id, i.exam_id AS exam_id
    FROM elearning_course_version_items i
    JOIN elearning_exams e
      ON e.org_id = i.org_id AND e.id = i.exam_id
   WHERE i.org_id = $1
     AND i.course_version_id = v.id
     AND i.item_type = 'exam'
     AND e.status IN ('published', 'retired')
   ORDER BY i.position ASC, i.id ASC
   LIMIT 1
) exam ON TRUE
LEFT JOIN elearning_progress progress
  ON progress.org_id = $1
 AND progress.user_id = $2
 AND progress.course_version_item_id = video.item_id
LEFT JOIN LATERAL (
  SELECT
    att.id AS id,
    att.attempt_no AS attempt_no,
    att.status AS status,
    att.auto_score AS auto_score,
    att.total_score AS total_score,
    att.passed AS passed,
    att.started_at AS started_at,
    att.submitted_at AS submitted_at,
    att.graded_at AS graded_at
  FROM elearning_exam_attempts att
  WHERE att.org_id = $1
    AND att.user_id = $2
    AND att.exam_id = exam.exam_id
    AND att.course_version_id = v.id
  ORDER BY att.attempt_no DESC, att.id DESC
  LIMIT 1
) attempt ON TRUE
WHERE c.status IN ('active', 'archived')
  AND v.status IN ('published', 'retired')
ORDER BY assigned_heads.assigned_at ASC, assigned_heads.course_version_id ASC
LIMIT ${ELEARNING_LEARNER_COURSES_LIMIT}`

function fail(code: ElearningLearnerCoursesErrorCode): never {
  throw new ElearningLearnerCoursesError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return null
    return parsed
  }
  return null
}

function asBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value
  return null
}

function requireBoolean(value: unknown): boolean {
  const parsed = asBoolean(value)
  if (parsed === null) fail('unavailable')
  return parsed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function requireTitle(value: unknown): string {
  const text = asText(value)
  if (!text || text.trim() === '') fail('unavailable')
  return text
}

function requireNonNegInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null || parsed < 0) fail('unavailable')
  return parsed
}

function requirePositiveInt(value: unknown): number {
  const parsed = asSafeInt(value)
  if (parsed === null || parsed <= 0) fail('unavailable')
  return parsed
}

function asIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const parsed = new Date(trimmed)
    if (Number.isNaN(parsed.getTime())) return null
    return parsed.toISOString()
  }
  return null
}

function requireIsoTimestamp(value: unknown): string {
  const iso = asIsoTimestamp(value)
  if (!iso) fail('unavailable')
  return iso
}

function optionalIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const iso = asIsoTimestamp(value)
  if (!iso) fail('unavailable')
  return iso
}

function optionalScore(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = asFiniteNumber(value)
  if (parsed === null || parsed < 0) fail('unavailable')
  return parsed
}

function isAttemptStatus(value: string): value is ElearningLearnerAttemptStatus {
  return (ATTEMPT_STATUSES as readonly string[]).includes(value)
}

function isVideoProgressStatus(value: string): value is 'in_progress' | 'completed' {
  return (VIDEO_PROGRESS_STATUSES as readonly string[]).includes(value)
}

function mapVideo(row: Record<string, unknown>): ElearningLearnerVideo {
  const itemId = requireUuid(row.video_item_id)
  const durationMs = requirePositiveInt(row.video_duration_ms)
  const rawStatus = row.video_status
  if (rawStatus === null || rawStatus === undefined) {
    if (
      row.video_effective_ms != null
      || row.video_max_position_ms != null
      || row.video_completed_at != null
    ) {
      fail('unavailable')
    }
    return {
      itemId,
      durationMs,
      status: 'not_started',
      effectiveMs: 0,
      maxPositionMs: 0,
      completedAt: null,
    }
  }
  const statusText = asText(rawStatus)
  if (!statusText || !isVideoProgressStatus(statusText)) fail('unavailable')
  const completedAt = optionalIsoTimestamp(row.video_completed_at)
  if (statusText === 'completed') {
    if (!completedAt) fail('unavailable')
  } else if (completedAt !== null) {
    fail('unavailable')
  }
  return {
    itemId,
    durationMs,
    status: statusText,
    effectiveMs: requireNonNegInt(row.video_effective_ms),
    maxPositionMs: requireNonNegInt(row.video_max_position_ms),
    completedAt,
  }
}

function mapLatestAttempt(row: Record<string, unknown>): ElearningLearnerExamAttempt | null {
  const attemptIdRaw = row.attempt_id
  if (attemptIdRaw === null || attemptIdRaw === undefined) {
    if (
      row.attempt_no != null
      || row.attempt_status != null
      || row.attempt_auto_score != null
      || row.attempt_total_score != null
      || row.attempt_passed != null
      || row.attempt_started_at != null
      || row.attempt_submitted_at != null
      || row.attempt_graded_at != null
    ) {
      fail('unavailable')
    }
    return null
  }
  const statusText = asText(row.attempt_status)
  if (!statusText || !isAttemptStatus(statusText)) fail('unavailable')
  const autoScore = optionalScore(row.attempt_auto_score)
  const totalScore = optionalScore(row.attempt_total_score)
  const passed = row.attempt_passed == null ? null : asBoolean(row.attempt_passed)
  if (row.attempt_passed != null && passed === null) fail('unavailable')
  const submittedAt = optionalIsoTimestamp(row.attempt_submitted_at)
  const gradedAt = optionalIsoTimestamp(row.attempt_graded_at)
  if (autoScore !== null && totalScore !== null && autoScore > totalScore) fail('unavailable')

  if (statusText === 'started') {
    if (
      autoScore !== null
      || totalScore !== null
      || passed !== null
      || submittedAt !== null
      || gradedAt !== null
    ) {
      fail('unavailable')
    }
  } else if (statusText === 'submitted' || statusText === 'expired') {
    if (
      submittedAt === null
      || autoScore !== null
      || totalScore !== null
      || passed !== null
      || gradedAt !== null
    ) {
      fail('unavailable')
    }
  } else if (
    autoScore === null
    || totalScore === null
    || passed === null
    || submittedAt === null
    || gradedAt === null
  ) {
    fail('unavailable')
  }

  return {
    attemptId: requireUuid(attemptIdRaw),
    attemptNo: requirePositiveInt(row.attempt_no),
    status: statusText,
    autoScore,
    totalScore,
    passed,
    startedAt: requireIsoTimestamp(row.attempt_started_at),
    submittedAt,
    gradedAt,
  }
}

function mapCourse(row: Record<string, unknown>): ElearningLearnerCourse {
  const video = mapVideo(row)
  const latestAttempt = mapLatestAttempt(row)
  const anyPassed = requireBoolean(row.any_passed)
  return {
    courseId: requireUuid(row.course_id),
    courseVersionId: requireUuid(row.course_version_id),
    title: requireTitle(row.title),
    assignment: {
      deadline: optionalIsoTimestamp(row.assignment_deadline),
      assignedAt: requireIsoTimestamp(row.assignment_assigned_at),
    },
    video,
    exam: {
      itemId: requireUuid(row.exam_item_id),
      latestAttempt,
    },
    // Monotonic: video completed AND any graded pass for this org/user/exam/version.
    completed: video.status === 'completed' && anyPassed,
  }
}

export async function listElearningLearnerCourses(
  db: ElearningLearnerCoursesQueryable,
  input: ListElearningLearnerCoursesInput,
): Promise<ElearningLearnerCourse[]> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)

  try {
    const result = await db.query(LIST_SQL, [orgId, userId])
    if (!Array.isArray(result.rows)) fail('unavailable')
    if (result.rows.length > ELEARNING_LEARNER_COURSES_LIMIT) fail('unavailable')
    const courses: ElearningLearnerCourse[] = []
    const seen = new Set<string>()
    for (const row of result.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) fail('unavailable')
      const course = mapCourse(row)
      if (seen.has(course.courseVersionId)) fail('unavailable')
      seen.add(course.courseVersionId)
      courses.push(course)
    }
    return courses
  } catch (error) {
    if (error instanceof ElearningLearnerCoursesError) throw error
    fail('unavailable')
  }
}
