/**
 * L2 assignment-reminder intent producer.
 *
 * This service consumes a server-persisted job identity. It neither creates
 * jobs nor sends notifications. Frequency and quiet-hour policy belong to the
 * later job producer; this boundary verifies its occurrence key against
 * authoritative assignment data before creating one durable delivery intent.
 */
import {
  deriveElearningAssignmentCourseStatus,
  type ElearningAssignmentExamStatus,
  type ElearningAssignmentVideoStatus,
} from './elearning-assignment-lifecycle'
import {
  ElearningNotificationDeliveryError,
  enqueueElearningNotificationDelivery,
  normalizeElearningNotificationTimestamp,
  type ElearningNotificationDeliveryDb,
} from './elearning-notification-delivery'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COURSE_HEAD_STATUSES = ['active', 'archived', 'withdrawn'] as const

export const ELEARNING_ASSIGNMENT_REMINDER_JOB_KIND = 'assignment_reminder' as const

export type ElearningAssignmentReminderErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export class ElearningAssignmentReminderError extends Error {
  constructor(readonly code: ElearningAssignmentReminderErrorCode) {
    super(code)
    this.name = 'ElearningAssignmentReminderError'
  }
}

export interface ProduceElearningAssignmentReminderInput {
  /** Authoritative persisted job.org_id. */
  orgId: string
  /** Persisted job.ref; never a client-supplied recipient. */
  assignmentMemberId: string
  /** Persisted job.occurrence_key, verified against server-owned assignment data. */
  occurrenceKey: string
  /** Persisted job.payload.windowStart, owned by the future policy producer. */
  windowStart: string | Date
  /** Persisted job.due_at; quiet-hour policy may move it after windowStart. */
  dueAt: string | Date
}

export interface CheckElearningAssignmentReminderEligibilityInput {
  /** Authoritative persisted delivery.org_id. */
  orgId: string
  /** Persisted delivery.assignment_member_id. */
  assignmentMemberId: string
  /** Persisted delivery.recipient_user_id; must still match the member. */
  recipientUserId: string
}

export type ProduceElearningAssignmentReminderResult =
  | { outcome: 'ineligible' }
  | { outcome: 'enqueued'; deliveryId: string }
  | { outcome: 'duplicate'; deliveryId: string }

type CourseHeadStatus = (typeof COURSE_HEAD_STATUSES)[number]

interface AssignmentReminderCandidate {
  assignmentId: string
  courseVersionId: string
  eligible: boolean
  memberId: string
  userId: string
}

const CANDIDATE_SQL = `/* elearning-assignment-reminder:load-candidate */
SELECT
  member.id AS member_id,
  member.assignment_id AS assignment_id,
  member.user_id AS user_id,
  member.revoked_at AS revoked_at,
  assignment.course_version_id AS course_version_id,
  assignment.deadline AS deadline,
  course.status AS course_head_status,
  progress.status AS video_status,
  attempt.status AS exam_status,
  EXISTS (
    SELECT 1
      FROM elearning_exam_attempts any_pass
     WHERE any_pass.org_id = member.org_id
       AND any_pass.user_id = member.user_id
       AND any_pass.course_version_id = assignment.course_version_id
       AND exam.exam_id IS NOT NULL
       AND any_pass.exam_id = exam.exam_id
       AND any_pass.course_version_item_id = exam.item_id
       AND any_pass.status = 'graded'
       AND any_pass.passed IS TRUE
  ) AS passed
  FROM elearning_assignment_members member
  JOIN elearning_assignments assignment
    ON assignment.org_id = member.org_id
   AND assignment.id = member.assignment_id
  JOIN elearning_course_versions course_version
    ON course_version.org_id = assignment.org_id
   AND course_version.id = assignment.course_version_id
  JOIN elearning_courses course
    ON course.org_id = course_version.org_id
   AND course.id = course_version.course_id
  LEFT JOIN LATERAL (
    SELECT item.id AS item_id
      FROM elearning_course_version_items item
     WHERE item.org_id = assignment.org_id
       AND item.course_version_id = assignment.course_version_id
       AND item.item_type = 'video'
     ORDER BY item.position ASC, item.id ASC
     LIMIT 1
  ) video ON TRUE
  LEFT JOIN elearning_progress progress
    ON progress.org_id = member.org_id
   AND progress.user_id = member.user_id
   AND progress.assignment_member_id = member.id
   AND progress.course_version_item_id = video.item_id
  LEFT JOIN LATERAL (
    SELECT item.id AS item_id, item.exam_id AS exam_id
      FROM elearning_course_version_items item
     WHERE item.org_id = assignment.org_id
       AND item.course_version_id = assignment.course_version_id
       AND item.item_type = 'exam'
     ORDER BY item.position ASC, item.id ASC
     LIMIT 1
  ) exam ON TRUE
  LEFT JOIN LATERAL (
    SELECT exam_attempt.status AS status
      FROM elearning_exam_attempts exam_attempt
     WHERE exam_attempt.org_id = member.org_id
       AND exam_attempt.user_id = member.user_id
       AND exam_attempt.course_version_id = assignment.course_version_id
       AND exam.exam_id IS NOT NULL
       AND exam_attempt.exam_id = exam.exam_id
       AND exam_attempt.course_version_item_id = exam.item_id
     ORDER BY exam_attempt.attempt_no DESC, exam_attempt.id DESC
     LIMIT 1
  ) attempt ON TRUE
 WHERE member.org_id = $1
   AND member.id = $2`

function fail(code: ElearningAssignmentReminderErrorCode): never {
  throw new ElearningAssignmentReminderError(code)
}

function hasSupportedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return false
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (
    trimmed === ''
    || trimmed !== value
    || trimmed.length > max
    || !hasSupportedText(trimmed)
  ) {
    fail('invalid_input')
  }
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function storedText(value: unknown, max = 512): string {
  if (
    typeof value !== 'string'
    || value === ''
    || value !== value.trim()
    || value.length > max
    || !hasSupportedText(value)
  ) {
    fail('unavailable')
  }
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function storedVideoStatus(value: unknown): ElearningAssignmentVideoStatus {
  if (value === null || value === undefined) return 'not_started'
  if (value === 'in_progress' || value === 'completed') return value
  fail('unavailable')
}

function storedExamStatus(value: unknown): ElearningAssignmentExamStatus {
  if (value === null || value === undefined) return 'not_started'
  if (
    value === 'started'
    || value === 'submitted'
    || value === 'awaiting_manual'
    || value === 'graded'
    || value === 'expired'
  ) {
    return value
  }
  fail('unavailable')
}

function storedCourseHeadStatus(value: unknown): CourseHeadStatus {
  if ((COURSE_HEAD_STATUSES as readonly unknown[]).includes(value)) {
    return value as CourseHeadStatus
  }
  fail('unavailable')
}

function compactWindowTimestamp(value: string): string {
  return value.endsWith('.000Z') ? `${value.slice(0, -5)}Z` : value
}

export function deriveElearningAssignmentReminderOccurrenceKey(input: {
  assignmentId: string
  userId: string
  windowStart: string
}): string {
  const assignmentId = requireUuid(input.assignmentId)
  const userId = requireText(input.userId, 256)
  const windowStart = normalizeElearningNotificationTimestamp(input.windowStart)
  return `assignment:${assignmentId}:user:${encodeURIComponent(userId)}:window:${compactWindowTimestamp(windowStart)}`
}

async function loadAssignmentReminderCandidate(
  db: ElearningNotificationDeliveryDb,
  orgId: string,
  assignmentMemberId: string,
): Promise<AssignmentReminderCandidate> {
  const loaded = await db.query(CANDIDATE_SQL, [orgId, assignmentMemberId])
  const row = loaded.rows[0]
  if (!row) fail('not_found')

  const memberId = storedUuid(row.member_id)
  if (memberId !== assignmentMemberId) fail('unavailable')
  const assignmentId = storedUuid(row.assignment_id)
  const courseVersionId = storedUuid(row.course_version_id)
  const userId = storedText(row.user_id, 256)
  const deadline = storedTimestamp(row.deadline)
  const courseHeadStatus = storedCourseHeadStatus(row.course_head_status)
  const videoStatus = storedVideoStatus(row.video_status)
  const examStatus = storedExamStatus(row.exam_status)
  if (typeof row.passed !== 'boolean') fail('unavailable')

  const courseStatus = deriveElearningAssignmentCourseStatus(
    videoStatus,
    examStatus,
    row.passed,
  )
  return {
    assignmentId,
    courseVersionId,
    eligible: (
      row.revoked_at == null
      && deadline !== null
      && courseHeadStatus !== 'withdrawn'
      && courseStatus !== 'completed'
      && !(videoStatus === 'completed' && examStatus === 'awaiting_manual')
    ),
    memberId,
    userId,
  }
}

export async function checkElearningAssignmentReminderEligibility(
  db: ElearningNotificationDeliveryDb,
  input: CheckElearningAssignmentReminderEligibilityInput,
): Promise<boolean> {
  const orgId = requireText(input.orgId, 256)
  const assignmentMemberId = requireUuid(input.assignmentMemberId)
  const recipientUserId = requireText(input.recipientUserId, 256)
  try {
    const candidate = await loadAssignmentReminderCandidate(
      db,
      orgId,
      assignmentMemberId,
    )
    if (candidate.userId !== recipientUserId) fail('unavailable')
    return candidate.eligible
  } catch (error) {
    if (error instanceof ElearningAssignmentReminderError) throw error
    fail('unavailable')
  }
}

export async function produceElearningAssignmentReminder(
  db: ElearningNotificationDeliveryDb,
  input: ProduceElearningAssignmentReminderInput,
): Promise<ProduceElearningAssignmentReminderResult> {
  const orgId = requireText(input.orgId, 256)
  const assignmentMemberId = requireUuid(input.assignmentMemberId)
  const occurrenceKey = requireText(input.occurrenceKey)
  let windowStart: string
  let dueAt: string
  try {
    windowStart = normalizeElearningNotificationTimestamp(input.windowStart)
    dueAt = normalizeElearningNotificationTimestamp(input.dueAt)
  } catch (error) {
    if (error instanceof ElearningNotificationDeliveryError) fail('invalid_input')
    fail('unavailable')
  }
  if (Date.parse(dueAt) < Date.parse(windowStart)) fail('invalid_input')

  try {
    const candidate = await loadAssignmentReminderCandidate(
      db,
      orgId,
      assignmentMemberId,
    )

    const expectedOccurrenceKey = deriveElearningAssignmentReminderOccurrenceKey({
      assignmentId: candidate.assignmentId,
      userId: candidate.userId,
      windowStart,
    })
    if (occurrenceKey !== expectedOccurrenceKey) fail('invalid_input')

    if (!candidate.eligible) {
      return { outcome: 'ineligible' }
    }

    const delivery = await enqueueElearningNotificationDelivery(db, {
      orgId,
      assignmentMemberId: candidate.memberId,
      recipientUserId: candidate.userId,
      sourceKey: expectedOccurrenceKey,
      dueAt,
      payload: {
        assignmentId: candidate.assignmentId,
        assignmentMemberId: candidate.memberId,
        courseVersionId: candidate.courseVersionId,
        windowStart,
      },
    })
    return delivery.duplicate
      ? { outcome: 'duplicate', deliveryId: delivery.deliveryId }
      : { outcome: 'enqueued', deliveryId: delivery.deliveryId }
  } catch (error) {
    if (error instanceof ElearningAssignmentReminderError) throw error
    if (error instanceof ElearningNotificationDeliveryError) {
      if (error.code === 'not_found' || error.code === 'not_eligible') {
        return { outcome: 'ineligible' }
      }
      if (error.code === 'conflict') fail('conflict')
    }
    fail('unavailable')
  }
}
