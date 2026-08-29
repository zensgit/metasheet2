/**
 * Read-only learner course list for assignments and visible self-study.
 * One row per course version. Public values and errors are values-free.
 */
import { ELEARNING_MEDIA_MIME } from './elearning-media-validation'
import {
  ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
  evaluateElearningCourseProgress,
} from './elearning-course-progress-policy'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
} from './elearning-watch-progress'
import {
  listElearningCourseAccessCandidates,
  type ElearningCourseAccessCandidate,
} from './elearning-course-access'
import { matchElearningAudienceRuleIds } from './elearning-audience-resolver'

export const ELEARNING_LEARNER_COURSES_LIMIT = 100 as const
const ELEARNING_COURSE_VERSION_MAX_ITEMS_FOR_LIST =
  ELEARNING_LEARNER_COURSES_LIMIT * 10_000

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ATTEMPT_STATUSES = [
  'started',
  'submitted',
  'awaiting_manual',
  'graded',
  'expired',
] as const
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

export interface ElearningLearnerCoursesDb extends ElearningLearnerCoursesQueryable {
  transaction<T>(
    handler: (tx: ElearningLearnerCoursesQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ListElearningLearnerCoursesInput {
  orgId: string
  userId: string
}

export interface ElearningLearnerAssignment {
  deadline: string | null
  assignedAt: string
}

export interface ElearningLearnerAccess {
  kind: 'assignment' | 'visibility'
  required: boolean
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

export interface ElearningLearnerAssessmentCourse {
  courseId: string
  courseVersionId: string
  title: string
  access: ElearningLearnerAccess
  assignment: ElearningLearnerAssignment | null
  video: ElearningLearnerVideo
  exam: ElearningLearnerExam
  completed: boolean
}

export interface ElearningLearnerContentItem {
  itemId: string
  itemType: 'article' | 'external_link'
  title: string
  status: 'not_started' | 'completed'
  completedAt: string | null
}

export interface ElearningLearnerContentCourse {
  courseId: string
  courseVersionId: string
  title: string
  access: ElearningLearnerAccess
  assignment: ElearningLearnerAssignment | null
  items: ElearningLearnerContentItem[]
  completed: boolean
}

export type ElearningLearnerCourse =
  | ElearningLearnerAssessmentCourse
  | ElearningLearnerContentCourse

const DETAILS_SQL = `/* elearning-learner-courses:details */
WITH access_input AS (
  SELECT
    course_version_id,
    assignment_member_id,
    scope_revision_rule_id,
    ordinality
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) WITH ORDINALITY AS input(
    course_version_id,
    assignment_member_id,
    scope_revision_rule_id,
    ordinality
  )
)
SELECT
  c.id AS course_id,
  v.id AS course_version_id,
  c.title AS title,
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
      AND any_pass.course_version_item_id = exam.item_id
      AND any_pass.status = 'graded'
      AND any_pass.passed IS TRUE
  ) AS any_passed
FROM access_input access
JOIN elearning_course_versions v
  ON v.org_id = $1 AND v.id = access.course_version_id
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
    AND att.course_version_item_id = exam.item_id
  ORDER BY att.attempt_no DESC, att.id DESC
  LIMIT 1
) attempt ON TRUE
WHERE (
  access.assignment_member_id IS NOT NULL
  AND access.scope_revision_rule_id IS NULL
  AND c.status IN ('active', 'archived')
  AND v.status IN ('published', 'retired')
  AND EXISTS (
    SELECT 1
    FROM elearning_assignment_members current_member
    WHERE current_member.org_id = $1
      AND current_member.id = access.assignment_member_id
      AND current_member.user_id = $2
      AND current_member.course_version_id = v.id
      AND current_member.revoked_at IS NULL
  )
) OR (
  access.assignment_member_id IS NULL
  AND access.scope_revision_rule_id IS NOT NULL
  AND c.status = 'active'
  AND v.status = 'published'
  AND c.active_version_id = v.id
  AND EXISTS (
    SELECT 1
    FROM elearning_scopes current_scope
    JOIN elearning_scope_revision_rules current_rule
      ON current_rule.org_id = current_scope.org_id
     AND current_rule.scope_revision_id = current_scope.active_revision_id
    WHERE current_scope.org_id = $1
      AND current_scope.id = c.scope_id
      AND current_rule.id = access.scope_revision_rule_id
  )
)
ORDER BY access.ordinality ASC`

const CONTENT_DETAILS_SQL = `/* elearning-learner-courses:content-details */
WITH access_input AS (
  SELECT
    course_version_id,
    assignment_member_id,
    scope_revision_rule_id,
    ordinality
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) WITH ORDINALITY AS input(
    course_version_id,
    assignment_member_id,
    scope_revision_rule_id,
    ordinality
  )
)
SELECT
  c.id AS course_id,
  v.id AS course_version_id,
  c.title AS title,
  item.id AS item_id,
  item.item_type AS item_type,
  item.position AS item_position,
  revision.id AS item_revision_id,
  revision.title AS item_title,
  evidence.completed_at AS item_completed_at,
  evidence.item_type AS evidence_item_type,
  evidence.content_revision_id AS evidence_revision_id
FROM access_input access
JOIN elearning_course_versions v
  ON v.org_id = $1 AND v.id = access.course_version_id
JOIN elearning_courses c
  ON c.org_id = v.org_id AND c.id = v.course_id
JOIN elearning_course_version_items item
  ON item.org_id = v.org_id AND item.course_version_id = v.id
 AND item.item_type IN ('article', 'external_link')
JOIN elearning_content_revisions revision
  ON revision.org_id = item.org_id
 AND revision.id = CASE
   WHEN item.item_type = 'article' THEN item.article_revision_id
   ELSE item.external_link_revision_id
 END
 AND revision.item_type = item.item_type
LEFT JOIN elearning_completion_evidence evidence
  ON evidence.org_id = $1
 AND evidence.user_id = $2
 AND evidence.course_version_item_id = item.id
WHERE NOT EXISTS (
  SELECT 1
    FROM elearning_course_version_items other_item
   WHERE other_item.org_id = item.org_id
     AND other_item.course_version_id = item.course_version_id
     AND other_item.item_type NOT IN ('article', 'external_link')
)
AND (
  (
    access.assignment_member_id IS NOT NULL
    AND access.scope_revision_rule_id IS NULL
    AND c.status IN ('active', 'archived')
    AND v.status IN ('published', 'retired')
    AND EXISTS (
      SELECT 1
        FROM elearning_assignment_members current_member
       WHERE current_member.org_id = $1
         AND current_member.id = access.assignment_member_id
         AND current_member.user_id = $2
         AND current_member.course_version_id = v.id
         AND current_member.revoked_at IS NULL
    )
  ) OR (
    access.assignment_member_id IS NULL
    AND access.scope_revision_rule_id IS NOT NULL
    AND c.status = 'active'
    AND v.status = 'published'
    AND c.active_version_id = v.id
    AND EXISTS (
      SELECT 1
        FROM elearning_scopes current_scope
        JOIN elearning_scope_revision_rules current_rule
          ON current_rule.org_id = current_scope.org_id
         AND current_rule.scope_revision_id = current_scope.active_revision_id
       WHERE current_scope.org_id = $1
         AND current_scope.id = c.scope_id
         AND current_rule.id = access.scope_revision_rule_id
    )
  )
)
ORDER BY access.ordinality ASC, item.position ASC, item.id ASC`

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
  } else if (statusText === 'awaiting_manual') {
    if (
      autoScore === null
      || totalScore !== null
      || passed !== null
      || submittedAt === null
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

function mapCourse(
  row: Record<string, unknown>,
  candidate: ElearningCourseAccessCandidate,
): ElearningLearnerAssessmentCourse {
  const courseId = requireUuid(row.course_id)
  const courseVersionId = requireUuid(row.course_version_id)
  if (courseId !== candidate.courseId || courseVersionId !== candidate.courseVersionId) {
    fail('unavailable')
  }
  const video = mapVideo(row)
  const latestAttempt = mapLatestAttempt(row)
  const anyPassed = requireBoolean(row.any_passed)
  const courseProgress = evaluateElearningCourseProgress({
    itemStates: [
      video.status,
      anyPassed ? 'completed' : latestAttempt === null ? 'not_started' : 'in_progress',
    ],
    policyVersion: ELEARNING_COURSE_PROGRESS_POLICY_VERSION,
  })
  const assignment = candidate.basis.kind === 'assignment'
    ? {
        deadline: candidate.assignmentDeadline,
        assignedAt: candidate.assignmentAssignedAt ?? fail('unavailable'),
      }
    : null
  return {
    courseId,
    courseVersionId,
    title: requireTitle(row.title),
    access: {
      kind: candidate.basis.kind,
      required: candidate.basis.required,
    },
    assignment,
    video,
    exam: {
      itemId: requireUuid(row.exam_item_id),
      latestAttempt,
    },
    // Monotonic: any historic graded pass keeps the exam item completed.
    completed: courseProgress.status === 'completed',
  }
}

function assignmentFor(
  candidate: ElearningCourseAccessCandidate,
): ElearningLearnerAssignment | null {
  return candidate.basis.kind === 'assignment'
    ? {
        deadline: candidate.assignmentDeadline,
        assignedAt: candidate.assignmentAssignedAt ?? fail('unavailable'),
      }
    : null
}

function mapContentItem(row: Record<string, unknown>): ElearningLearnerContentItem {
  const itemId = requireUuid(row.item_id)
  const itemRevisionId = requireUuid(row.item_revision_id)
  const itemType = asText(row.item_type)
  if (itemType !== 'article' && itemType !== 'external_link') fail('unavailable')
  const completedAt = optionalIsoTimestamp(row.item_completed_at)
  if (completedAt === null) {
    if (row.evidence_item_type != null || row.evidence_revision_id != null) {
      fail('unavailable')
    }
  } else if (
    row.evidence_item_type !== itemType
    || requireUuid(row.evidence_revision_id) !== itemRevisionId
  ) fail('unavailable')
  return {
    itemId,
    itemType,
    title: requireTitle(row.item_title),
    status: completedAt === null ? 'not_started' : 'completed',
    completedAt,
  }
}

function mapContentCourses(
  rows: Array<Record<string, unknown>>,
  candidates: Map<string, ElearningCourseAccessCandidate>,
): Map<string, ElearningLearnerContentCourse> {
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const versionId = requireUuid(row.course_version_id)
    if (!candidates.has(versionId)) fail('unavailable')
    const group = grouped.get(versionId) ?? []
    group.push(row)
    grouped.set(versionId, group)
  }
  const courses = new Map<string, ElearningLearnerContentCourse>()
  for (const [versionId, group] of grouped) {
    const candidate = candidates.get(versionId) ?? fail('unavailable')
    const first = group[0] ?? fail('unavailable')
    const courseId = requireUuid(first.course_id)
    if (courseId !== candidate.courseId) fail('unavailable')
    const positions = new Set<number>()
    const itemIds = new Set<string>()
    const items = group.map((row) => {
      if (
        requireUuid(row.course_id) !== courseId
        || requireUuid(row.course_version_id) !== versionId
        || requireTitle(row.title) !== requireTitle(first.title)
      ) fail('unavailable')
      const position = requirePositiveInt(row.item_position)
      const item = mapContentItem(row)
      if (positions.has(position) || itemIds.has(item.itemId)) fail('unavailable')
      positions.add(position)
      itemIds.add(item.itemId)
      return { position, item }
    })
    items.sort((left, right) => left.position - right.position)
    courses.set(versionId, {
      courseId,
      courseVersionId: versionId,
      title: requireTitle(first.title),
      access: {
        kind: candidate.basis.kind,
        required: candidate.basis.required,
      },
      assignment: assignmentFor(candidate),
      items: items.map(({ item }) => item),
      completed: items.every(({ item }) => item.status === 'completed'),
    })
  }
  return courses
}

export async function listElearningLearnerCourses(
  db: ElearningLearnerCoursesDb,
  input: ListElearningLearnerCoursesInput,
): Promise<ElearningLearnerCourse[]> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)

  try {
    return await db.transaction(async (tx) => {
      const candidates = await listElearningCourseAccessCandidates(tx, {
        orgId,
        userId,
        limit: ELEARNING_LEARNER_COURSES_LIMIT + 1,
      })
      if (candidates.length > ELEARNING_LEARNER_COURSES_LIMIT) fail('unavailable')
      if (candidates.length === 0) return []

      const visibilityRuleIds = [...new Set(candidates.flatMap((candidate) =>
        candidate.basis.kind === 'visibility' ? [candidate.basis.scopeRevisionRuleId] : [],
      ))]
      if (visibilityRuleIds.length > 0) {
        const matchedRuleIds = await matchElearningAudienceRuleIds(tx, {
          orgId,
          userId,
          ruleIds: visibilityRuleIds,
          lockDependencies: true,
        })
        const matched = new Set(matchedRuleIds)
        if (visibilityRuleIds.some((ruleId) => !matched.has(ruleId))) fail('unavailable')
      }

      const versionIds = candidates.map((candidate) => candidate.courseVersionId)
      const assignmentMemberIds = candidates.map((candidate) => candidate.basis.assignmentMemberId)
      const scopeRevisionRuleIds = candidates.map((candidate) => candidate.basis.scopeRevisionRuleId)
      const queryParams = [
        orgId,
        userId,
        versionIds,
        assignmentMemberIds,
        scopeRevisionRuleIds,
      ]
      const contentResult = await tx.query(CONTENT_DETAILS_SQL, queryParams)
      const result = await tx.query(DETAILS_SQL, queryParams)
      if (!Array.isArray(result.rows) || !Array.isArray(contentResult.rows)) {
        fail('unavailable')
      }
      if (
        result.rows.length > ELEARNING_LEARNER_COURSES_LIMIT
        || contentResult.rows.length > ELEARNING_COURSE_VERSION_MAX_ITEMS_FOR_LIST
      ) fail('unavailable')
      const details = new Map<string, ElearningLearnerCourse>()
      const candidateByVersion = new Map(
        candidates.map((candidate) => [candidate.courseVersionId, candidate] as const),
      )
      for (const [versionId, course] of mapContentCourses(
        contentResult.rows,
        candidateByVersion,
      )) details.set(versionId, course)
      for (const row of result.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) fail('unavailable')
        const versionId = requireUuid(row.course_version_id)
        const candidate = candidateByVersion.get(versionId)
        if (!candidate || details.has(versionId)) fail('unavailable')
        details.set(versionId, mapCourse(row, candidate))
      }
      if (details.size !== candidates.length) fail('unavailable')
      return candidates.map(
        (candidate) => details.get(candidate.courseVersionId) ?? fail('unavailable'),
      )
    })
  } catch (error) {
    if (error instanceof ElearningLearnerCoursesError) throw error
    fail('unavailable')
  }
}
