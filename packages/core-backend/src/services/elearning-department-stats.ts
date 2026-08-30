import {
  assertElearningRulesWithinAdminScope,
  ElearningAdminAccessError,
  type ElearningAdminAccessQueryable,
} from './elearning-admin-access'
import {
  ELEARNING_ANALYTICS_MIN_GROUP_SIZE,
} from './elearning-analytics-suppression'
import {
  buildElearningDepartmentStatsProjection,
  ElearningDepartmentStatsPolicyError,
  type ElearningDepartmentStatsProjection,
} from './elearning-department-stats-policy'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ElearningDepartmentStatsErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'

export class ElearningDepartmentStatsError extends Error {
  constructor(readonly code: ElearningDepartmentStatsErrorCode) {
    super(code)
    this.name = 'ElearningDepartmentStatsError'
  }
}

export type ElearningDepartmentStatsDb = ElearningAdminAccessQueryable

export interface GetElearningDepartmentStatsInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  departmentId: string
  periodStart: string
  periodEnd: string
}

const DEPARTMENT_STATS_SQL = `/* elearning-department-stats:aggregate */
WITH target_department AS (
  SELECT department.id
    FROM directory_departments department
    JOIN directory_integrations integration
      ON integration.id = department.integration_id
   WHERE integration.org_id = $1
     AND integration.status = 'active'
     AND department.id = $2::uuid
     AND department.is_active IS TRUE
),
department_users AS (
  SELECT DISTINCT link.local_user_id AS user_id
    FROM target_department department
    JOIN directory_account_departments membership
      ON membership.directory_department_id = department.id
    JOIN directory_accounts account
      ON account.id = membership.directory_account_id
     AND account.is_active IS TRUE
    JOIN directory_integrations integration
      ON integration.id = account.integration_id
     AND integration.org_id = $1
     AND integration.status = 'active'
    JOIN directory_account_links link
      ON link.directory_account_id = account.id
     AND link.link_status = 'linked'
     AND link.local_user_id IS NOT NULL
    JOIN users platform_user
      ON platform_user.id = link.local_user_id
     AND platform_user.is_active IS TRUE
    JOIN user_orgs org_membership
      ON org_membership.user_id = link.local_user_id
     AND org_membership.org_id = $1
     AND org_membership.is_active IS TRUE
),
period_assignments AS (
  SELECT
    member.id,
    member.user_id,
    member.course_version_id,
    assignment.deadline
  FROM elearning_assignment_members member
  JOIN elearning_assignments assignment
    ON assignment.org_id = member.org_id
   AND assignment.id = member.assignment_id
   AND assignment.course_version_id = member.course_version_id
  JOIN department_users department_user
    ON department_user.user_id = member.user_id
  WHERE member.org_id = $1
    AND member.assigned_at >= $3::timestamptz
    AND member.assigned_at < $4::timestamptz
    AND (member.revoked_at IS NULL OR member.revoked_at >= $4::timestamptz)
),
assignment_state AS (
  SELECT
    assignment.*,
    NOT EXISTS (
      SELECT 1
      FROM elearning_course_version_items item
      WHERE item.org_id = $1
        AND item.course_version_id = assignment.course_version_id
        AND (
          (
            item.item_type IN ('video', 'article', 'external_link')
            AND NOT EXISTS (
              SELECT 1
              FROM elearning_completion_evidence evidence
              WHERE evidence.org_id = $1
                AND evidence.user_id = assignment.user_id
                AND evidence.course_version_id = assignment.course_version_id
                AND evidence.course_version_item_id = item.id
                AND evidence.item_type = item.item_type
                AND evidence.completed_at < $4::timestamptz
            )
          )
          OR (
            item.item_type = 'exam'
            AND NOT EXISTS (
              SELECT 1
              FROM elearning_exam_attempts attempt
              WHERE attempt.org_id = $1
                AND attempt.user_id = assignment.user_id
                AND attempt.course_version_id = assignment.course_version_id
                AND attempt.course_version_item_id = item.id
                AND attempt.status = 'graded'
                AND attempt.passed IS TRUE
                AND attempt.graded_at < $4::timestamptz
            )
          )
        )
    ) AS completed
  FROM period_assignments assignment
),
credit_events AS (
  SELECT decision.user_id, decision.awarded_points AS points
    FROM elearning_credit_decisions decision
    JOIN department_users department_user ON department_user.user_id = decision.user_id
   WHERE decision.org_id = $1
     AND decision.occurred_at >= $3::timestamptz
     AND decision.occurred_at < $4::timestamptz
  UNION ALL
  SELECT adjustment.user_id, adjustment.points
    FROM elearning_credit_adjustments adjustment
    JOIN department_users department_user ON department_user.user_id = adjustment.user_id
   WHERE adjustment.org_id = $1
     AND adjustment.created_at >= $3::timestamptz
     AND adjustment.created_at < $4::timestamptz
),
assignment_rollup AS (
  SELECT
    count(*)::text AS assigned_count,
    count(*) FILTER (WHERE completed)::text AS completed_count,
    count(DISTINCT user_id)::text AS learner_count,
    count(*) FILTER (
      WHERE deadline < $4::timestamptz AND NOT completed
    )::text AS overdue_count
  FROM assignment_state
),
activity_rollup AS (
  SELECT
    (
      SELECT count(DISTINCT attempt.user_id)::text
      FROM elearning_exam_attempts attempt
      JOIN department_users department_user ON department_user.user_id = attempt.user_id
      WHERE attempt.org_id = $1
        AND attempt.started_at >= $3::timestamptz
        AND attempt.started_at < $4::timestamptz
    ) AS exam_participant_count,
    (
      SELECT floor(COALESCE(sum(evidence.effective_ms), 0)::numeric / 1000)::text
      FROM elearning_completion_evidence evidence
      JOIN department_users department_user ON department_user.user_id = evidence.user_id
      WHERE evidence.org_id = $1
        AND evidence.item_type = 'video'
        AND evidence.completed_at >= $3::timestamptz
        AND evidence.completed_at < $4::timestamptz
    ) AS learning_seconds,
    (SELECT COALESCE(sum(points), 0)::text FROM credit_events) AS credit_total
)
SELECT
  EXISTS (SELECT 1 FROM target_department) AS department_found,
  (SELECT count(*)::text FROM department_users) AS member_count,
  assignment_rollup.assigned_count,
  assignment_rollup.completed_count,
  assignment_rollup.learner_count,
  assignment_rollup.overdue_count,
  activity_rollup.exam_participant_count,
  activity_rollup.learning_seconds,
  activity_rollup.credit_total,
  to_char(
    statement_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS source_version
FROM assignment_rollup
CROSS JOIN activity_rollup`

function fail(code: ElearningDepartmentStatsErrorCode): never {
  throw new ElearningDepartmentStatsError(code)
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > 512 || text.includes('\0')) fail('invalid_input')
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireTimestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || !CANONICAL_TIMESTAMP_RE.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail('invalid_input')
  return value
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('unavailable')
  return value
}

function storedCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    fail('unavailable')
  }
  const count = Number(value)
  if (!Number.isSafeInteger(count)) fail('unavailable')
  return count
}

function storedSignedInteger(value: unknown): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) {
    fail('unavailable')
  }
  const integer = Number(value)
  if (!Number.isSafeInteger(integer)) fail('unavailable')
  return integer
}

function mapAdminScopeError(error: unknown): never {
  if (!(error instanceof ElearningAdminAccessError)) fail('unavailable')
  if (error.code === 'invalid_input') fail('invalid_input')
  if (
    error.code === 'forbidden'
    || error.code === 'scope_required'
    || error.code === 'target_out_of_scope'
  ) fail('forbidden')
  fail('unavailable')
}

export async function getElearningDepartmentStats(
  db: ElearningDepartmentStatsDb,
  input: GetElearningDepartmentStatsInput,
): Promise<ElearningDepartmentStatsProjection> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const departmentId = requireUuid(input.departmentId)
  const periodStart = requireTimestamp(input.periodStart)
  const periodEnd = requireTimestamp(input.periodEnd)
  if (periodStart >= periodEnd) fail('invalid_input')

  try {
    await assertElearningRulesWithinAdminScope(db, {
      orgId,
      actorId,
      isGlobalAdmin: input.isGlobalAdmin,
      rules: [{
        subjectType: 'department',
        subjectRef: departmentId,
        includeChildren: false,
      }],
    })
  } catch (error) {
    mapAdminScopeError(error)
  }

  let row: Record<string, unknown> | undefined
  try {
    const result = await db.query(DEPARTMENT_STATS_SQL, [
      orgId,
      departmentId,
      periodStart,
      periodEnd,
    ])
    if (result.rows.length !== 1) fail('unavailable')
    row = result.rows[0]
  } catch (error) {
    if (error instanceof ElearningDepartmentStatsError) throw error
    fail('unavailable')
  }
  if (!row || typeof row.department_found !== 'boolean') fail('unavailable')
  if (!row.department_found) fail('not_found')

  try {
    return buildElearningDepartmentStatsProjection({
      orgId,
      departmentId,
      periodStart,
      periodEnd,
      sourceVersion: storedText(row.source_version),
      minGroupSize: ELEARNING_ANALYTICS_MIN_GROUP_SIZE,
      counters: {
        assignedCount: storedCount(row.assigned_count),
        completedCount: storedCount(row.completed_count),
        creditTotal: storedSignedInteger(row.credit_total),
        examParticipantCount: storedCount(row.exam_participant_count),
        learnerCount: storedCount(row.learner_count),
        learningSeconds: storedCount(row.learning_seconds),
        memberCount: storedCount(row.member_count),
        overdueCount: storedCount(row.overdue_count),
      },
    })
  } catch (error) {
    if (error instanceof ElearningDepartmentStatsPolicyError) fail('unavailable')
    if (error instanceof ElearningDepartmentStatsError) throw error
    fail('unavailable')
  }
}
