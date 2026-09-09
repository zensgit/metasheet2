import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from './elearning-course-access'
import { normalizeElearningNotificationTimestamp } from './elearning-notification-delivery'

const EVENT_HASH_DOMAIN = 'elearning.notification.event.v1'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ElearningNotificationEventDb {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface CollectElearningNotificationEventsInput {
  since: string
  limit?: number
  assignments?: boolean
  enrollments?: boolean
  results?: boolean
}

export interface CollectElearningNotificationEventsResult {
  inserted: number
}

export type ElearningEventNotificationKind =
  | 'training_available'
  | 'result_published'

export interface CheckElearningEventNotificationEligibilityInput {
  orgId: string
  deliveryId: string
  recipientUserId: string
}

export class ElearningNotificationEventsError extends Error {
  constructor(readonly code: 'invalid_input' | 'conflict' | 'unavailable') {
    super(code)
    this.name = 'ElearningNotificationEventsError'
  }
}

type EventCandidate = {
  orgId: string
  recipientUserId: string
  kind: ElearningEventNotificationKind
  sourceKey: string
  occurredAt: string
  assignmentMemberId: string | null
  enrollmentId: string | null
  examAttemptId: string | null
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ElearningNotificationEventsError('invalid_input')
  }
  return value.trim()
}

function requiredUuid(value: unknown): string {
  const normalized = requiredText(value)
  if (!UUID_RE.test(normalized)) {
    throw new ElearningNotificationEventsError('invalid_input')
  }
  return normalized.toLowerCase()
}

function optionalUuid(value: unknown): string | null {
  return value == null ? null : requiredUuid(value)
}

function readKind(value: unknown): ElearningEventNotificationKind {
  if (value !== 'training_available' && value !== 'result_published') {
    throw new ElearningNotificationEventsError('invalid_input')
  }
  return value
}

function readLimit(value: unknown): number {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new ElearningNotificationEventsError('invalid_input')
  }
  return Number(limit)
}

function mapCandidate(row: Record<string, unknown>): EventCandidate {
  const kind = readKind(row.kind)
  const candidate = {
    orgId: requiredText(row.org_id),
    recipientUserId: requiredText(row.recipient_user_id),
    kind,
    sourceKey: requiredText(row.source_key),
    occurredAt: normalizeElearningNotificationTimestamp(row.occurred_at),
    assignmentMemberId: optionalUuid(row.assignment_member_id),
    enrollmentId: optionalUuid(row.enrollment_id),
    examAttemptId: optionalUuid(row.exam_attempt_id),
  }
  const validBasis = kind === 'training_available'
    ? Number(candidate.assignmentMemberId !== null)
      + Number(candidate.enrollmentId !== null) === 1
      && candidate.examAttemptId === null
    : candidate.assignmentMemberId === null
      && candidate.enrollmentId === null
      && candidate.examAttemptId !== null
  if (!validBasis) throw new ElearningNotificationEventsError('unavailable')
  return candidate
}

function hashEvent(candidate: EventCandidate): string {
  const canonical = JSON.stringify({
    assignmentMemberId: candidate.assignmentMemberId,
    channel: 'platform',
    domain: EVENT_HASH_DOMAIN,
    dueAt: candidate.occurredAt,
    enrollmentId: candidate.enrollmentId,
    examAttemptId: candidate.examAttemptId,
    kind: candidate.kind,
    payload: {},
    recipientRole: 'learner',
    recipientUserId: candidate.recipientUserId,
    version: 1,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function collectElearningNotificationEvents(
  db: ElearningNotificationEventDb,
  input: CollectElearningNotificationEventsInput,
): Promise<CollectElearningNotificationEventsResult> {
  const since = normalizeElearningNotificationTimestamp(input?.since)
  const limit = readLimit(input?.limit)
  const assignments = input?.assignments === true
  const enrollments = input?.enrollments === true
  const results = input?.results === true
  let candidates: Awaited<ReturnType<ElearningNotificationEventDb['query']>>
  try {
    candidates = await db.query(
    `/* elearning-notification-events:collect */
     WITH event_candidates AS (
       SELECT member.org_id,
              member.user_id AS recipient_user_id,
              'training_available'::text AS kind,
              'training_available:assignment_member:' || member.id::text AS source_key,
              member.assigned_at AS occurred_at,
              member.id AS assignment_member_id,
              NULL::uuid AS enrollment_id,
              NULL::uuid AS exam_attempt_id
         FROM elearning_assignment_members member
         JOIN user_orgs membership
           ON membership.user_id = member.user_id
          AND membership.org_id = member.org_id
          AND membership.is_active = TRUE
         JOIN users local_user
           ON local_user.id = membership.user_id
          AND local_user.is_active = TRUE
         JOIN elearning_course_versions version
           ON version.org_id = member.org_id
          AND version.id = member.course_version_id
         JOIN elearning_courses course
           ON course.org_id = version.org_id
          AND course.id = version.course_id
        WHERE member.revoked_at IS NULL
          AND $3::boolean
          AND member.assigned_at >= $1::timestamptz
          AND course.status <> 'withdrawn'
       UNION ALL
       SELECT enrollment.org_id,
              enrollment.user_id AS recipient_user_id,
              'training_available'::text AS kind,
              'training_available:enrollment:' || enrollment.id::text AS source_key,
              enrollment.enrolled_at AS occurred_at,
              NULL::uuid AS assignment_member_id,
              enrollment.id AS enrollment_id,
              NULL::uuid AS exam_attempt_id
         FROM elearning_course_enrollments enrollment
         JOIN user_orgs membership
           ON membership.user_id = enrollment.user_id
          AND membership.org_id = enrollment.org_id
          AND membership.is_active = TRUE
         JOIN users local_user
           ON local_user.id = membership.user_id
          AND local_user.is_active = TRUE
         JOIN elearning_course_versions version
           ON version.org_id = enrollment.org_id
          AND version.id = enrollment.course_version_id
         JOIN elearning_courses course
           ON course.org_id = version.org_id
          AND course.id = version.course_id
        WHERE enrollment.enrolled_at >= $1::timestamptz
          AND $4::boolean
          AND course.status <> 'withdrawn'
       UNION ALL
       SELECT attempt.org_id,
              attempt.user_id AS recipient_user_id,
              'result_published'::text AS kind,
              'result_published:exam_attempt:' || attempt.id::text AS source_key,
              attempt.graded_at AS occurred_at,
              NULL::uuid AS assignment_member_id,
              NULL::uuid AS enrollment_id,
              attempt.id AS exam_attempt_id
         FROM elearning_exam_attempts attempt
         JOIN user_orgs membership
           ON membership.user_id = attempt.user_id
          AND membership.org_id = attempt.org_id
          AND membership.is_active = TRUE
         JOIN users local_user
           ON local_user.id = membership.user_id
          AND local_user.is_active = TRUE
         JOIN elearning_course_versions version
           ON version.org_id = attempt.org_id
          AND version.id = attempt.course_version_id
         JOIN elearning_courses course
           ON course.org_id = version.org_id
          AND course.id = version.course_id
        WHERE attempt.status = 'graded'
          AND $5::boolean
          AND attempt.graded_at IS NOT NULL
          AND attempt.graded_at >= $1::timestamptz
          AND course.status <> 'withdrawn'
     )
     SELECT candidate.org_id, candidate.recipient_user_id, candidate.kind,
            candidate.source_key, candidate.occurred_at,
            candidate.assignment_member_id, candidate.enrollment_id,
            candidate.exam_attempt_id
       FROM event_candidates candidate
      WHERE NOT EXISTS (
        SELECT 1
          FROM elearning_notification_deliveries delivery
         WHERE delivery.org_id = candidate.org_id
           AND delivery.source_key = candidate.source_key
      )
      ORDER BY candidate.occurred_at ASC,
               candidate.org_id ASC,
               candidate.source_key ASC
      LIMIT $2`,
      [since, limit, assignments, enrollments, results],
    )
  } catch {
    throw new ElearningNotificationEventsError('unavailable')
  }

  let inserted = 0
  for (const row of candidates.rows) {
    let candidate: EventCandidate
    try {
      candidate = mapCandidate(row)
    } catch {
      throw new ElearningNotificationEventsError('unavailable')
    }
    let result: Awaited<ReturnType<ElearningNotificationEventDb['query']>>
    try {
      result = await db.query(
      `/* elearning-notification-events:insert */
       INSERT INTO elearning_notification_deliveries (
         id, org_id, assignment_member_id, enrollment_id, exam_attempt_id,
         kind, source_key, request_hash, request_hash_version,
         recipient_role, recipient_user_id, channel, payload,
         due_at, next_attempt_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, 1,
         'learner', $9, 'platform', '{}'::jsonb,
         $10::timestamptz, $10::timestamptz
       )
       ON CONFLICT (org_id, source_key) DO NOTHING`,
      [
        randomUUID(),
        candidate.orgId,
        candidate.assignmentMemberId,
        candidate.enrollmentId,
        candidate.examAttemptId,
        candidate.kind,
        candidate.sourceKey,
        hashEvent(candidate),
        candidate.recipientUserId,
        candidate.occurredAt,
      ],
      )
    } catch {
      throw new ElearningNotificationEventsError('unavailable')
    }
    if (result.rowCount === 1) {
      inserted += 1
      continue
    }
    if (result.rowCount !== 0) {
      throw new ElearningNotificationEventsError('unavailable')
    }
    let existing: Awaited<ReturnType<ElearningNotificationEventDb['query']>>
    try {
      existing = await db.query(
        `/* elearning-notification-events:load-conflict */
         SELECT request_hash, request_hash_version
           FROM elearning_notification_deliveries
          WHERE org_id = $1 AND source_key = $2`,
        [candidate.orgId, candidate.sourceKey],
      )
    } catch {
      throw new ElearningNotificationEventsError('unavailable')
    }
    const existingRow = existing.rows[0]
    if (
      existing.rows.length !== 1
      || existingRow.request_hash !== hashEvent(candidate)
      || existingRow.request_hash_version !== 1
    ) {
      throw new ElearningNotificationEventsError('conflict')
    }
  }
  return { inserted }
}

export async function checkElearningEventNotificationEligibility(
  db: ElearningNotificationEventDb,
  input: CheckElearningEventNotificationEligibilityInput,
): Promise<boolean> {
  let orgId: string
  let deliveryId: string
  let recipientUserId: string
  try {
    orgId = requiredText(input?.orgId)
    deliveryId = requiredUuid(input?.deliveryId)
    recipientUserId = requiredText(input?.recipientUserId)
  } catch (error) {
    if (error instanceof ElearningNotificationEventsError) throw error
    throw new ElearningNotificationEventsError('invalid_input')
  }

  let source: { kind: ElearningEventNotificationKind; courseVersionId: string }
  try {
    const result = await db.query(
      `/* elearning-notification-events:eligibility-source */
       SELECT delivery.kind,
              COALESCE(member.course_version_id, enrollment.course_version_id, attempt.course_version_id) AS course_version_id
         FROM elearning_notification_deliveries delivery
         JOIN user_orgs membership
           ON membership.user_id = delivery.recipient_user_id
          AND membership.org_id = delivery.org_id
          AND membership.is_active = TRUE
         JOIN users local_user
           ON local_user.id = membership.user_id
          AND local_user.is_active = TRUE
         LEFT JOIN elearning_assignment_members member
           ON member.org_id = delivery.org_id
          AND member.id = delivery.assignment_member_id
          AND member.user_id = delivery.recipient_user_id
          AND member.revoked_at IS NULL
         LEFT JOIN elearning_course_enrollments enrollment
           ON enrollment.org_id = delivery.org_id
          AND enrollment.id = delivery.enrollment_id
          AND enrollment.user_id = delivery.recipient_user_id
         LEFT JOIN elearning_exam_attempts attempt
           ON attempt.org_id = delivery.org_id
          AND attempt.id = delivery.exam_attempt_id
          AND attempt.user_id = delivery.recipient_user_id
          AND attempt.status = 'graded'
          AND attempt.graded_at IS NOT NULL
         JOIN elearning_course_versions version
           ON version.org_id = delivery.org_id
          AND version.id = COALESCE(member.course_version_id, enrollment.course_version_id, attempt.course_version_id)
         JOIN elearning_courses course
           ON course.org_id = version.org_id
          AND course.id = version.course_id
          AND course.status <> 'withdrawn'
        WHERE delivery.org_id = $1
          AND delivery.id = $2
          AND delivery.recipient_user_id = $3
          AND delivery.kind IN ('training_available', 'result_published')
        LIMIT 1`,
      [orgId, deliveryId, recipientUserId],
    )
    if (!result.rows[0]) return false
    source = {
      kind: readKind(result.rows[0].kind),
      courseVersionId: requiredUuid(result.rows[0].course_version_id),
    }
  } catch {
    throw new ElearningNotificationEventsError('unavailable')
  }

  try {
    await resolveElearningCourseAccess(db, {
      orgId,
      userId: recipientUserId,
      courseVersionId: source.courseVersionId,
    })
  } catch (error) {
    if (error instanceof ElearningCourseAccessError && error.code !== 'unavailable') {
      return false
    }
    throw new ElearningNotificationEventsError('unavailable')
  }
  return true
}
