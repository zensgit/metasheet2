/**
 * Admin assignment lifecycle: org-scoped progress lookup and explicit
 * single-member revocation. Valid assignment means an unrevoked member.
 * Deadline expiry is not revoke. Progress, evidence, attempts, and the
 * parent assignment are never deleted or reset. Errors are values-free.
 */
export const ELEARNING_ASSIGNMENT_PROGRESS_LIMIT = 100 as const
export const ELEARNING_REVOCATION_REASON_MAX = 500 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MEMBER_SOURCES = ['manual', 'rule', 'import'] as const
const VIDEO_STATUSES = ['not_started', 'in_progress', 'completed'] as const
const EXAM_STATUSES = [
  'not_started',
  'started',
  'submitted',
  'awaiting_manual',
  'graded',
  'expired',
] as const
const COURSE_STATUSES = ['not_started', 'in_progress', 'completed'] as const

export type ElearningAssignmentLifecycleErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export type ElearningAssignmentMemberSource = (typeof MEMBER_SOURCES)[number]
export type ElearningAssignmentVideoStatus = (typeof VIDEO_STATUSES)[number]
export type ElearningAssignmentExamStatus = (typeof EXAM_STATUSES)[number]
export type ElearningAssignmentCourseStatus = (typeof COURSE_STATUSES)[number]

export class ElearningAssignmentLifecycleError extends Error {
  constructor(readonly code: ElearningAssignmentLifecycleErrorCode) {
    super(code)
    this.name = 'ElearningAssignmentLifecycleError'
  }
}

export interface ElearningAssignmentLifecycleQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAssignmentLifecycleDb extends ElearningAssignmentLifecycleQueryable {
  transaction<T>(
    handler: (tx: ElearningAssignmentLifecycleQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ListElearningAssignmentProgressInput {
  orgId: string
  assignmentId: string
  cursor?: string | null
  limit?: number
  /** Internal SQL-level row filter. Public routes set this for delegated admins. */
  scopeActorId?: string | null
}

export interface ElearningAssignmentProgressMember {
  memberId: string
  userId: string
  source: ElearningAssignmentMemberSource
  assignedAt: string
  revokedAt: string | null
  overdue: boolean
  videoStatus: ElearningAssignmentVideoStatus
  examStatus: ElearningAssignmentExamStatus
  passed: boolean
  courseStatus: ElearningAssignmentCourseStatus
}

export interface ElearningAssignmentProgressResult {
  assignmentId: string
  courseVersionId: string
  deadline: string | null
  members: ElearningAssignmentProgressMember[]
  nextCursor: string | null
}

export interface RevokeElearningAssignmentMemberInput {
  orgId: string
  actorId: string
  assignmentId: string
  memberId: string
  reason: string
}

export interface ElearningAssignmentRevocationResult {
  assignmentId: string
  memberId: string
  revoked: true
  duplicate: boolean
}

export function elearningAssignmentRevokeLockKey(
  orgId: string,
  assignmentId: string,
  memberId: string,
): string {
  return `elearning-revoke:${orgId}:${assignmentId}:${memberId}`
}

const ASSIGNMENT_SQL = `/* elearning-lifecycle:lock-assignment */
SELECT id, course_version_id, deadline
  FROM elearning_assignments
 WHERE org_id = $1 AND id = $2
 FOR SHARE`

const MEMBERS_SQL = `/* elearning-lifecycle:page-members */
SELECT
  m.id AS member_id,
  m.user_id AS user_id,
  m.source AS source,
  m.assigned_at AS assigned_at,
  m.revoked_at AS revoked_at,
  (m.revoked_at IS NULL AND a.deadline IS NOT NULL AND a.deadline < now()) AS overdue,
  progress.status AS video_status,
  attempt.status AS exam_status,
  EXISTS (
    SELECT 1
      FROM elearning_exam_attempts any_pass
     WHERE any_pass.org_id = m.org_id
       AND any_pass.user_id = m.user_id
       AND any_pass.course_version_id = a.course_version_id
       AND exam.exam_id IS NOT NULL
       AND any_pass.exam_id = exam.exam_id
       AND any_pass.course_version_item_id = exam.item_id
       AND any_pass.status = 'graded'
       AND any_pass.passed IS TRUE
  ) AS passed
  FROM elearning_assignments a
  JOIN elearning_assignment_members m
    ON m.org_id = a.org_id AND m.assignment_id = a.id
  LEFT JOIN LATERAL (
    SELECT i.id AS item_id
      FROM elearning_course_version_items i
     WHERE i.org_id = a.org_id
       AND i.course_version_id = a.course_version_id
       AND i.item_type = 'video'
     ORDER BY i.position ASC, i.id ASC
     LIMIT 1
  ) video ON TRUE
  LEFT JOIN elearning_progress progress
    ON progress.org_id = m.org_id
   AND progress.user_id = m.user_id
   AND progress.assignment_member_id = m.id
   AND progress.course_version_item_id = video.item_id
  LEFT JOIN LATERAL (
    SELECT i.id AS item_id, i.exam_id AS exam_id
      FROM elearning_course_version_items i
     WHERE i.org_id = a.org_id
       AND i.course_version_id = a.course_version_id
       AND i.item_type = 'exam'
     ORDER BY i.position ASC, i.id ASC
     LIMIT 1
  ) exam ON TRUE
  LEFT JOIN LATERAL (
    SELECT att.status AS status
      FROM elearning_exam_attempts att
     WHERE att.org_id = m.org_id
       AND att.user_id = m.user_id
       AND att.course_version_id = a.course_version_id
       AND exam.exam_id IS NOT NULL
       AND att.exam_id = exam.exam_id
       AND att.course_version_item_id = exam.item_id
     ORDER BY att.attempt_no DESC, att.id DESC
     LIMIT 1
  ) attempt ON TRUE
 WHERE a.org_id = $1
   AND a.id = $2
   AND ($3::uuid IS NULL OR m.id > $3::uuid)
   AND (
     $5::text IS NULL
     OR EXISTS (
       WITH RECURSIVE allowed_departments AS (
         SELECT
           scope.directory_integration_id AS integration_id,
           scope.directory_department_id AS department_id,
           scope.include_children,
           ARRAY[scope.directory_department_id]::uuid[] AS path
         FROM elearning_admin_scopes scope
         JOIN directory_integrations integration
           ON integration.id = scope.directory_integration_id
          AND integration.org_id = scope.org_id
          AND integration.status = 'active'
         JOIN directory_departments department
           ON department.id = scope.directory_department_id
          AND department.integration_id = scope.directory_integration_id
          AND department.is_active = TRUE
         WHERE scope.org_id = m.org_id
           AND scope.user_id = $5
           AND scope.revoked_at IS NULL
         UNION ALL
         SELECT
           parent.integration_id,
           child.id,
           parent.include_children,
           parent.path || child.id
         FROM allowed_departments parent
         JOIN directory_departments parent_department
           ON parent_department.id = parent.department_id
          AND parent_department.integration_id = parent.integration_id
         JOIN directory_departments child
           ON child.integration_id = parent.integration_id
          AND child.external_parent_department_id =
            parent_department.external_department_id
          AND child.is_active = TRUE
         WHERE parent.include_children = TRUE
           AND NOT child.id = ANY(parent.path)
       )
       SELECT 1
       FROM users platform_user
       JOIN user_orgs membership
         ON membership.user_id = platform_user.id
        AND membership.org_id = m.org_id
        AND membership.is_active = TRUE
       JOIN directory_account_links link
         ON link.local_user_id = platform_user.id
        AND link.link_status = 'linked'
       JOIN directory_accounts account
         ON account.id = link.directory_account_id
        AND account.is_active = TRUE
       JOIN directory_account_departments account_department
         ON account_department.directory_account_id = account.id
       JOIN allowed_departments allowed
         ON allowed.integration_id = account.integration_id
        AND allowed.department_id = account_department.directory_department_id
       WHERE platform_user.id = m.user_id
         AND platform_user.is_active = TRUE
     )
   )
 ORDER BY m.id ASC
 LIMIT $4`

const REVOKE_LOCK_SQL = `/* elearning-lifecycle:revoke-lock */
SELECT pg_advisory_xact_lock(hashtext($1))`

const LOAD_MEMBER_SQL = `/* elearning-lifecycle:load-member */
SELECT
  member.id,
  member.assignment_id,
  member.revocation_reason,
  member.revoked_at,
  plan_link.training_plan_assignment_id
 FROM elearning_assignment_members member
 LEFT JOIN elearning_training_plan_assignment_items plan_link
   ON plan_link.org_id = member.org_id
  AND plan_link.assignment_id = member.assignment_id
 WHERE member.org_id = $1
   AND member.assignment_id = $2
   AND member.id = $3
 FOR UPDATE OF member`

const REVOKE_MEMBER_SQL = `/* elearning-lifecycle:revoke-member */
UPDATE elearning_assignment_members
   SET revoked_at = now(),
       revoked_by = $4,
       revocation_reason = $5
 WHERE org_id = $1
   AND assignment_id = $2
   AND id = $3
   AND revoked_at IS NULL
 RETURNING id, assignment_id`

function fail(code: ElearningAssignmentLifecycleErrorCode): never {
  throw new ElearningAssignmentLifecycleError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function optionalCursor(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return requireUuid(value)
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return ELEARNING_ASSIGNMENT_PROGRESS_LIMIT
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_input')
  if (value < 1 || value > ELEARNING_ASSIGNMENT_PROGRESS_LIMIT) fail('invalid_input')
  return value
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > ELEARNING_REVOCATION_REASON_MAX) {
    fail('invalid_input')
  }
  return trimmed
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function asBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value
  return null
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

function isMemberSource(value: string): value is ElearningAssignmentMemberSource {
  return (MEMBER_SOURCES as readonly string[]).includes(value)
}

function isVideoStatus(value: string): value is Exclude<ElearningAssignmentVideoStatus, 'not_started'> {
  return value === 'in_progress' || value === 'completed'
}

function isExamStatus(value: string): value is Exclude<ElearningAssignmentExamStatus, 'not_started'> {
  return (EXAM_STATUSES as readonly string[]).includes(value) && value !== 'not_started'
}

export function deriveElearningAssignmentCourseStatus(
  videoStatus: ElearningAssignmentVideoStatus,
  examStatus: ElearningAssignmentExamStatus,
  passed: boolean,
): ElearningAssignmentCourseStatus {
  if (videoStatus === 'completed' && passed) return 'completed'
  if (videoStatus === 'not_started' && examStatus === 'not_started') return 'not_started'
  return 'in_progress'
}

function mapMember(row: Record<string, unknown>): ElearningAssignmentProgressMember {
  const memberId = requireUuid(row.member_id)
  const userId = asText(row.user_id)?.trim()
  if (!userId) fail('unavailable')
  const sourceText = asText(row.source)
  if (!sourceText || !isMemberSource(sourceText)) fail('unavailable')
  const overdue = asBoolean(row.overdue)
  if (overdue === null) fail('unavailable')
  const passed = asBoolean(row.passed)
  if (passed === null) fail('unavailable')

  const rawVideo = row.video_status
  let videoStatus: ElearningAssignmentVideoStatus
  if (rawVideo === null || rawVideo === undefined) {
    videoStatus = 'not_started'
  } else {
    const videoText = asText(rawVideo)
    if (!videoText || !isVideoStatus(videoText)) fail('unavailable')
    videoStatus = videoText
  }

  const rawExam = row.exam_status
  let examStatus: ElearningAssignmentExamStatus
  if (rawExam === null || rawExam === undefined) {
    examStatus = 'not_started'
  } else {
    const examText = asText(rawExam)
    if (!examText || !isExamStatus(examText)) fail('unavailable')
    examStatus = examText
  }

  const courseStatus = deriveElearningAssignmentCourseStatus(videoStatus, examStatus, passed)
  if (!(COURSE_STATUSES as readonly string[]).includes(courseStatus)) fail('unavailable')

  return {
    memberId,
    userId,
    source: sourceText,
    assignedAt: requireIsoTimestamp(row.assigned_at),
    revokedAt: optionalIsoTimestamp(row.revoked_at),
    overdue,
    videoStatus,
    examStatus,
    passed,
    courseStatus,
  }
}

export async function listElearningAssignmentProgress(
  db: ElearningAssignmentLifecycleDb,
  input: ListElearningAssignmentProgressInput,
): Promise<ElearningAssignmentProgressResult> {
  const orgId = requireActor(input.orgId)
  const assignmentId = requireUuid(input.assignmentId)
  const cursor = optionalCursor(input.cursor)
  const limit = requireLimit(input.limit)
  const scopeActorId = input.scopeActorId == null
    ? null
    : requireActor(input.scopeActorId)

  try {
    return await db.transaction(async (tx) => {
      const assignment = await tx.query(ASSIGNMENT_SQL, [orgId, assignmentId])
      const assignmentRow = assignment.rows[0]
      if (!assignmentRow) fail('not_found')
      const loadedId = requireUuid(assignmentRow.id)
      const courseVersionId = requireUuid(assignmentRow.course_version_id)
      if (loadedId !== assignmentId) fail('unavailable')
      const deadline = optionalIsoTimestamp(assignmentRow.deadline)

      const page = await tx.query(MEMBERS_SQL, [
        orgId,
        assignmentId,
        cursor,
        limit + 1,
        scopeActorId,
      ])
      if (!Array.isArray(page.rows)) fail('unavailable')
      if (page.rows.length > limit + 1) fail('unavailable')
      const hasMore = page.rows.length > limit
      const rows = hasMore ? page.rows.slice(0, limit) : page.rows
      const members = rows.map(mapMember)
      const nextCursor = hasMore ? members[members.length - 1]?.memberId ?? null : null
      if (hasMore && !nextCursor) fail('unavailable')
      return {
        assignmentId,
        courseVersionId,
        deadline,
        members,
        nextCursor,
      }
    })
  } catch (error) {
    if (error instanceof ElearningAssignmentLifecycleError) throw error
    fail('unavailable')
  }
}

export async function revokeElearningAssignmentMember(
  db: ElearningAssignmentLifecycleDb,
  input: RevokeElearningAssignmentMemberInput,
): Promise<ElearningAssignmentRevocationResult> {
  const orgId = requireActor(input.orgId)
  const actorId = requireActor(input.actorId)
  const assignmentId = requireUuid(input.assignmentId)
  const memberId = requireUuid(input.memberId)
  const reason = requireReason(input.reason)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(REVOKE_LOCK_SQL, [
        elearningAssignmentRevokeLockKey(orgId, assignmentId, memberId),
      ])
      const existing = await tx.query(LOAD_MEMBER_SQL, [orgId, assignmentId, memberId])
      const row = existing.rows[0]
      if (!row) fail('not_found')
      const loadedId = requireUuid(row.id)
      const loadedAssignmentId = requireUuid(row.assignment_id)
      if (loadedId !== memberId || loadedAssignmentId !== assignmentId) fail('unavailable')
      if (row.training_plan_assignment_id != null) fail('conflict')

      if (row.revoked_at != null) {
        const storedReason = asText(row.revocation_reason)
        if (!storedReason) fail('unavailable')
        if (storedReason !== reason) fail('conflict')
        return {
          assignmentId,
          memberId,
          revoked: true as const,
          duplicate: true,
        }
      }

      const updated = await tx.query(REVOKE_MEMBER_SQL, [
        orgId,
        assignmentId,
        memberId,
        actorId,
        reason,
      ])
      if (!updated.rows[0]) fail('unavailable')
      return {
        assignmentId,
        memberId,
        revoked: true as const,
        duplicate: false,
      }
    })
  } catch (error) {
    if (error instanceof ElearningAssignmentLifecycleError) throw error
    fail('unavailable')
  }
}
