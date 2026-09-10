/**
 * Canonical course access evaluator.
 *
 * Visibility never creates an assignment. An active assignment wins when both
 * bases match; scope access is limited to the active course head/version.
 */
import {
  ElearningAudienceResolverError,
  listElearningAudienceCourseMatches,
  matchElearningAudienceRule,
} from './elearning-audience-resolver'

export type ElearningCourseAccessErrorCode =
  | 'not_found'
  | 'denied'
  | 'withdrawn'
  | 'unsupported_version'
  | 'unavailable'

export class ElearningCourseAccessError extends Error {
  constructor(readonly code: ElearningCourseAccessErrorCode) {
    super(code)
    this.name = 'ElearningCourseAccessError'
  }
}

export interface ElearningCourseAccessQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export type ElearningCourseAccessBasis =
  | {
      kind: 'assignment'
      assignmentMemberId: string
      scopeRevisionRuleId: null
      required: true
    }
  | {
      kind: 'visibility'
      assignmentMemberId: null
      scopeRevisionRuleId: string
      required: false
    }

export interface ElearningResolvedCourseAccess {
  courseId: string
  courseVersionId: string
  basis: ElearningCourseAccessBasis
}

export interface ElearningCourseAccessCandidate extends ElearningResolvedCourseAccess {
  assignmentDeadline: string | null
  assignmentAssignedAt: string | null
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(code: ElearningCourseAccessErrorCode): never {
  throw new ElearningCourseAccessError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('unavailable')
  const trimmed = value.trim()
  if (trimmed === '') fail('unavailable')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function optionalUuid(value: unknown): string | null {
  if (value == null) return null
  return requireUuid(value)
}

function optionalDate(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  fail('unavailable')
}

export async function resolveElearningCourseAccess(
  db: ElearningCourseAccessQueryable,
  input: { orgId: string; userId: string; courseVersionId: string },
): Promise<ElearningResolvedCourseAccess> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const versionId = requireUuid(input.courseVersionId)

  const head = await db.query(
    `/* elearning-access:lock-course */
     SELECT
       c.id AS course_id,
       c.status AS course_status,
       c.active_version_id,
       c.scope_id,
       v.status AS version_status
     FROM elearning_course_versions v
     JOIN elearning_courses c
       ON c.org_id = v.org_id AND c.id = v.course_id
     WHERE v.org_id = $1 AND v.id = $2
     FOR SHARE OF c, v`,
    [orgId, versionId],
  )
  const row = head.rows[0]
  if (!row) fail('not_found')
  const courseId = requireUuid(row.course_id)
  const courseStatus = requireActor(row.course_status)
  const versionStatus = requireActor(row.version_status)
  if (courseStatus === 'withdrawn') fail('withdrawn')

  const member = await db.query(
    `/* elearning-access:lock-assignment */
     SELECT m.id
       FROM elearning_assignment_members m
      WHERE m.org_id = $1
        AND m.user_id = $2
        AND m.course_version_id = $3
        AND m.revoked_at IS NULL
      ORDER BY m.assigned_at ASC, m.id ASC
      LIMIT 1
      FOR SHARE OF m`,
    [orgId, userId, versionId],
  )
  if (member.rows[0]) {
    if (versionStatus !== 'published' && versionStatus !== 'retired') {
      fail('unsupported_version')
    }
    return {
      courseId,
      courseVersionId: versionId,
      basis: {
        kind: 'assignment',
        assignmentMemberId: requireUuid(member.rows[0].id),
        scopeRevisionRuleId: null,
        required: true,
      },
    }
  }

  if (
    courseStatus !== 'active'
    || versionStatus !== 'published'
    || optionalUuid(row.active_version_id) !== versionId
    || row.scope_id == null
  ) {
    fail('denied')
  }

  const scope = await db.query(
    `/* elearning-access:lock-scope */
     SELECT s.active_revision_id
       FROM elearning_scopes s
      WHERE s.org_id = $1 AND s.id = $2
      FOR SHARE OF s`,
    [orgId, requireUuid(row.scope_id)],
  )
  const activeRevisionId = scope.rows[0]?.active_revision_id
  if (activeRevisionId == null) fail('denied')

  let rule: Awaited<ReturnType<typeof matchElearningAudienceRule>>
  try {
    rule = await matchElearningAudienceRule(db, {
      orgId,
      userId,
      scopeRevisionId: requireUuid(activeRevisionId),
    })
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) fail('unavailable')
    throw error
  }
  if (!rule) fail('denied')
  return {
    courseId,
    courseVersionId: versionId,
    basis: {
      kind: 'visibility',
      assignmentMemberId: null,
      scopeRevisionRuleId: rule.ruleId,
      required: false,
    },
  }
}

function mapAccessCandidate(row: Record<string, unknown>): ElearningCourseAccessCandidate {
  const courseId = requireUuid(row.course_id)
  const courseVersionId = requireUuid(row.course_version_id)
  if (row.assignment_member_id != null) {
    return {
      courseId,
      courseVersionId,
      basis: {
        kind: 'assignment',
        assignmentMemberId: requireUuid(row.assignment_member_id),
        scopeRevisionRuleId: null,
        required: true,
      },
      assignmentDeadline: optionalDate(row.assignment_deadline),
      assignmentAssignedAt: optionalDate(row.assignment_assigned_at),
    }
  }
  return {
    courseId,
    courseVersionId,
    basis: {
      kind: 'visibility',
      assignmentMemberId: null,
      scopeRevisionRuleId: requireUuid(row.scope_revision_rule_id),
      required: false,
    },
    assignmentDeadline: null,
    assignmentAssignedAt: null,
  }
}

export async function listElearningCourseAccessCandidates(
  db: ElearningCourseAccessQueryable,
  input: { orgId: string; userId: string; limit: number },
): Promise<ElearningCourseAccessCandidate[]> {
  const orgId = requireActor(input.orgId)
  const userId = requireActor(input.userId)
  const limit = input.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('unavailable')

  const assignments = await db.query(
    `/* elearning-access:list-assignments */
     WITH assignment_access AS (
       SELECT DISTINCT ON (m.course_version_id)
         v.course_id,
         m.course_version_id,
         m.id AS assignment_member_id,
         NULL::uuid AS scope_revision_rule_id,
         a.deadline AS assignment_deadline,
         m.assigned_at AS assignment_assigned_at
       FROM elearning_assignment_members m
       JOIN elearning_assignments a
         ON a.org_id = m.org_id AND a.id = m.assignment_id
       JOIN elearning_course_versions v
         ON v.org_id = m.org_id AND v.id = m.course_version_id
       JOIN elearning_courses c
         ON c.org_id = v.org_id AND c.id = v.course_id
       WHERE m.org_id = $1
         AND m.user_id = $2
         AND m.revoked_at IS NULL
         AND c.status IN ('active', 'archived')
         AND v.status IN ('published', 'retired')
       ORDER BY m.course_version_id, m.assigned_at ASC, m.id ASC
     )
     SELECT
       course_id,
       course_version_id,
       assignment_member_id,
       scope_revision_rule_id,
       assignment_deadline,
       assignment_assigned_at
     FROM assignment_access
     ORDER BY assignment_assigned_at ASC, course_version_id ASC
     LIMIT $3`,
    [orgId, userId, limit],
  )
  const assigned = assignments.rows.map(mapAccessCandidate)
  if (assigned.length >= limit) return assigned

  let audienceMatches: Awaited<ReturnType<typeof listElearningAudienceCourseMatches>>
  try {
    audienceMatches = await listElearningAudienceCourseMatches(db, {
      orgId,
      userId,
      excludedCourseVersionIds: assigned.map((candidate) => candidate.courseVersionId),
      limit: limit - assigned.length,
    })
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) fail('unavailable')
    throw error
  }
  if (audienceMatches.length === 0) return assigned
  return [
    ...assigned,
    ...audienceMatches.map((match): ElearningCourseAccessCandidate => ({
      courseId: match.courseId,
      courseVersionId: match.courseVersionId,
      basis: {
        kind: 'visibility',
        assignmentMemberId: null,
        scopeRevisionRuleId: match.ruleId,
        required: false,
      },
      assignmentDeadline: null,
      assignmentAssignedAt: null,
    })),
  ]
}
