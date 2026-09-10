import {
  assertElearningRulesWithinAdminScope,
  ElearningAdminAccessError,
  type ElearningAdminAccessQueryable,
} from './elearning-admin-access'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/

const READ_SQL = `/* elearning-stats-daily:read */
SELECT
  to_char(stats.stats_date, 'YYYY-MM-DD') AS stats_date,
  to_char(stats.period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AS period_start,
  to_char(stats.period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AS period_end,
  stats.source_version,
  stats.suppressed,
  stats.min_group_size,
  stats.assigned_count::text,
  stats.completed_count::text,
  stats.completion_rate::text,
  stats.credit_average::text,
  stats.credit_total::text,
  stats.exam_participant_count::text,
  stats.learner_count::text,
  stats.learning_seconds::text,
  stats.member_count::text,
  stats.overdue_count::text,
  stats.projected_version::text,
  to_char(
    stats.last_projected_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS last_projected_at,
  stats.last_error
FROM elearning_stats_daily stats
WHERE stats.org_id = $1
  AND stats.dataset = 'department_overview'
  AND stats.department_id = $2::uuid
  AND stats.stats_date = $3::date`

export type ElearningStatsDailyReadErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'

export class ElearningStatsDailyReadError extends Error {
  constructor(readonly code: ElearningStatsDailyReadErrorCode) {
    super(code)
    this.name = 'ElearningStatsDailyReadError'
  }
}

export type ElearningStatsDailyReadDb = ElearningAdminAccessQueryable

export interface GetElearningDepartmentStatsDailyInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  departmentId: string
  statsDate: string
}

interface ElearningDepartmentStatsDailyBase {
  departmentId: string
  statsDate: string
  periodStart: string
  periodEnd: string
  sourceVersion: string
  minGroupSize: number
  projectedVersion: number
  lastProjectedAt: string
  lastErrorCode: string | null
}

export interface ElearningDepartmentStatsDailySuppressed
  extends ElearningDepartmentStatsDailyBase {
  suppressed: true
}

export interface ElearningDepartmentStatsDailyVisible
  extends ElearningDepartmentStatsDailyBase {
  suppressed: false
  metrics: {
    assignedCount: number
    completedCount: number
    completionRate: number
    creditAverage: number
    creditTotal: number
    examParticipantCount: number
    learnerCount: number
    learningSeconds: number
    memberCount: number
    overdueCount: number
  }
}

export type ElearningDepartmentStatsDaily =
  | ElearningDepartmentStatsDailySuppressed
  | ElearningDepartmentStatsDailyVisible

function fail(code: ElearningStatsDailyReadErrorCode): never {
  throw new ElearningStatsDailyReadError(code)
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

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('invalid_input')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_input')
  }
  return value
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    fail('unavailable')
  }
  return value
}

function storedTimestamp(value: unknown): string {
  if (
    typeof value !== 'string'
    || !TIMESTAMP_RE.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail('unavailable')
  return value
}

function storedInteger(value: unknown, allowNegative = false): number {
  const pattern = allowNegative ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/
  if (typeof value !== 'string' || !pattern.test(value)) fail('unavailable')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) fail('unavailable')
  return result
}

function storedPositiveInteger(value: unknown): number {
  const result = typeof value === 'number' ? value : Number.NaN
  if (!Number.isSafeInteger(result) || result < 1) fail('unavailable')
  return result
}

function storedDecimal(value: unknown, min?: number, max?: number): number {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    fail('unavailable')
  }
  const result = Number(value)
  if (
    !Number.isFinite(result)
    || (min !== undefined && result < min)
    || (max !== undefined && result > max)
  ) fail('unavailable')
  return result
}

function storedErrorCode(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !ERROR_CODE_RE.test(value)) fail('unavailable')
  return value
}

function mapScopeError(error: unknown): never {
  if (!(error instanceof ElearningAdminAccessError)) fail('unavailable')
  if (error.code === 'invalid_input') fail('invalid_input')
  if (
    error.code === 'forbidden'
    || error.code === 'scope_required'
    || error.code === 'target_out_of_scope'
  ) fail('forbidden')
  fail('unavailable')
}

function requireNullMetrics(row: Record<string, unknown>): void {
  for (const key of [
    'assigned_count',
    'completed_count',
    'completion_rate',
    'credit_average',
    'credit_total',
    'exam_participant_count',
    'learner_count',
    'learning_seconds',
    'member_count',
    'overdue_count',
  ]) {
    if (row[key] !== null) fail('unavailable')
  }
}

export async function getElearningDepartmentStatsDaily(
  db: ElearningStatsDailyReadDb,
  input: GetElearningDepartmentStatsDailyInput,
): Promise<ElearningDepartmentStatsDaily> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const departmentId = requireUuid(input.departmentId)
  const statsDate = requireDate(input.statsDate)

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
    mapScopeError(error)
  }

  let row: Record<string, unknown> | undefined
  try {
    const result = await db.query(READ_SQL, [orgId, departmentId, statsDate])
    if (result.rows.length > 1) fail('unavailable')
    row = result.rows[0]
  } catch (error) {
    if (error instanceof ElearningStatsDailyReadError) throw error
    fail('unavailable')
  }
  if (!row) fail('not_found')
  if (row.stats_date !== statsDate || typeof row.suppressed !== 'boolean') {
    fail('unavailable')
  }
  const minGroupSize = storedPositiveInteger(row.min_group_size)
  if (minGroupSize < 5) fail('unavailable')
  const common = {
    departmentId,
    statsDate,
    periodStart: storedTimestamp(row.period_start),
    periodEnd: storedTimestamp(row.period_end),
    sourceVersion: storedText(row.source_version),
    minGroupSize,
    projectedVersion: storedInteger(row.projected_version),
    lastProjectedAt: storedTimestamp(row.last_projected_at),
    lastErrorCode: storedErrorCode(row.last_error),
  }
  if (row.suppressed) {
    requireNullMetrics(row)
    return { ...common, suppressed: true }
  }
  const assignedCount = storedInteger(row.assigned_count)
  const completedCount = storedInteger(row.completed_count)
  const overdueCount = storedInteger(row.overdue_count)
  if (completedCount > assignedCount || overdueCount > assignedCount) fail('unavailable')
  return {
    ...common,
    suppressed: false,
    metrics: {
      assignedCount,
      completedCount,
      completionRate: storedDecimal(row.completion_rate, 0, 1),
      creditAverage: storedDecimal(row.credit_average),
      creditTotal: storedInteger(row.credit_total, true),
      examParticipantCount: storedInteger(row.exam_participant_count),
      learnerCount: storedInteger(row.learner_count),
      learningSeconds: storedInteger(row.learning_seconds),
      memberCount: storedInteger(row.member_count),
      overdueCount,
    },
  }
}

export const elearningStatsDailyReadSql = READ_SQL
