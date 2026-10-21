import { createHash } from 'node:crypto'

import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'
import {
  ELEARNING_STATS_DAILY_DATASET,
} from '../db/migrations/zzzz20260830190000_create_elearning_stats_daily'
import {
  getElearningDepartmentStats,
  type ElearningDepartmentStatsDb,
} from './elearning-department-stats'
import type { ElearningDepartmentStatsProjection } from './elearning-department-stats-policy'

const SYSTEM_ACTOR = 'system:elearning-projection'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ERROR_CODE = 'RECONCILE_FAILED'

const DEPARTMENT_IDENTITY_SQL = `/* elearning-stats-daily:department-identity */
SELECT
  department.integration_id::text AS directory_integration_id,
  department.provider AS directory_provider
FROM directory_departments department
JOIN directory_integrations integration
  ON integration.id = department.integration_id
 AND integration.org_id = $1
 AND integration.status = 'active'
WHERE department.id = $2::uuid
  AND department.is_active IS TRUE
FOR SHARE OF department, integration`

const EXISTING_SQL = `/* elearning-stats-daily:existing */
SELECT payload_digest, projected_version::text, last_error
FROM elearning_stats_daily
WHERE org_id = $1
  AND dataset = 'department_overview'
  AND department_id = $2::uuid
  AND stats_date = $3::date
FOR UPDATE`

const REFRESH_NOOP_SQL = `/* elearning-stats-daily:refresh-noop */
UPDATE elearning_stats_daily
SET source_version = $5,
    last_error = NULL,
    last_projected_at = now(),
    updated_at = now()
WHERE org_id = $1
  AND dataset = 'department_overview'
  AND department_id = $2::uuid
  AND stats_date = $3::date
  AND payload_digest = $4
RETURNING projected_version::text`

const UPSERT_SQL = `/* elearning-stats-daily:upsert */
INSERT INTO elearning_stats_daily (
  org_id,
  directory_integration_id,
  directory_provider,
  department_id,
  dataset,
  stats_date,
  period_start,
  period_end,
  source_version,
  payload_digest,
  suppressed,
  min_group_size,
  assigned_count,
  completed_count,
  completion_rate,
  credit_average,
  credit_total,
  exam_participant_count,
  learner_count,
  learning_seconds,
  member_count,
  overdue_count
)
VALUES (
  $1, $2::uuid, $3, $4::uuid, 'department_overview', $5::date,
  $6::timestamptz, $7::timestamptz, $8, $9, $10, $11,
  $12::bigint, $13::bigint, $14::numeric, $15::numeric, $16::bigint,
  $17::bigint, $18::bigint, $19::bigint, $20::bigint, $21::bigint
)
ON CONFLICT (org_id, dataset, department_id, stats_date) DO UPDATE
SET directory_integration_id = EXCLUDED.directory_integration_id,
    directory_provider = EXCLUDED.directory_provider,
    period_start = EXCLUDED.period_start,
    period_end = EXCLUDED.period_end,
    source_version = EXCLUDED.source_version,
    payload_digest = EXCLUDED.payload_digest,
    suppressed = EXCLUDED.suppressed,
    min_group_size = EXCLUDED.min_group_size,
    assigned_count = EXCLUDED.assigned_count,
    completed_count = EXCLUDED.completed_count,
    completion_rate = EXCLUDED.completion_rate,
    credit_average = EXCLUDED.credit_average,
    credit_total = EXCLUDED.credit_total,
    exam_participant_count = EXCLUDED.exam_participant_count,
    learner_count = EXCLUDED.learner_count,
    learning_seconds = EXCLUDED.learning_seconds,
    member_count = EXCLUDED.member_count,
    overdue_count = EXCLUDED.overdue_count,
    projected_version = elearning_stats_daily.projected_version + 1,
    last_projected_at = now(),
    last_error = NULL,
    updated_at = now()
WHERE elearning_stats_daily.payload_digest <> EXCLUDED.payload_digest
RETURNING projected_version::text`

const RECORD_ERROR_SQL = `/* elearning-stats-daily:record-error */
UPDATE elearning_stats_daily
SET last_error = $4,
    updated_at = now()
WHERE org_id = $1
  AND dataset = 'department_overview'
  AND department_id = $2::uuid
  AND stats_date = $3::date`

export type ElearningStatsDailyProjectionErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unavailable'

export class ElearningStatsDailyProjectionError extends Error {
  constructor(readonly code: ElearningStatsDailyProjectionErrorCode) {
    super(code)
    this.name = 'ElearningStatsDailyProjectionError'
  }
}

export interface ElearningStatsDailyQueryable extends ElearningDepartmentStatsDb {}

export interface ElearningStatsDailyDb extends ElearningStatsDailyQueryable {
  transaction<T>(run: (tx: ElearningStatsDailyQueryable) => Promise<T>): Promise<T>
}

export interface ProjectElearningDepartmentStatsDailyInput {
  orgId: string
  departmentId: string
  statsDate: string
}

export type ProjectElearningDepartmentStatsDailyResult =
  | {
      outcome: 'projected'
      projectedVersion: number
      suppressed: boolean
    }
  | {
      outcome: 'noop'
      projectedVersion: number
      suppressed: boolean
    }

function fail(code: ElearningStatsDailyProjectionErrorCode): never {
  throw new ElearningStatsDailyProjectionError(code)
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

function readText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') fail('unavailable')
  return value
}

function readVersion(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) fail('unavailable')
  const version = Number(value)
  if (!Number.isSafeInteger(version)) fail('unavailable')
  return version
}

function utcPeriod(statsDate: string): { start: string; end: string } {
  const start = new Date(`${statsDate}T00:00:00.000Z`)
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

function projectionDigest(projection: ElearningDepartmentStatsProjection): string {
  const payload = 'metrics' in projection
    ? {
        departmentId: projection.departmentId,
        metrics: projection.metrics,
        periodEnd: projection.periodEnd,
        periodStart: projection.periodStart,
        suppressed: false,
      }
    : {
        departmentId: projection.departmentId,
        periodEnd: projection.periodEnd,
        periodStart: projection.periodStart,
        suppressed: true,
      }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

function metricParams(
  projection: ElearningDepartmentStatsProjection,
): Array<string | null> {
  if (!('metrics' in projection)) return Array.from({ length: 10 }, () => null)
  return [
    String(projection.metrics.assignedCount),
    String(projection.metrics.completedCount),
    projection.metrics.completionRate.toFixed(9),
    projection.metrics.creditAverage.toFixed(9),
    String(projection.metrics.creditTotal),
    String(projection.metrics.examParticipantCount),
    String(projection.metrics.learnerCount),
    String(projection.metrics.learningSeconds),
    String(projection.metrics.memberCount),
    String(projection.metrics.overdueCount),
  ]
}

async function recordFailure(
  db: ElearningStatsDailyQueryable,
  orgId: string,
  departmentId: string,
  statsDate: string,
): Promise<void> {
  try {
    await db.query(RECORD_ERROR_SQL, [orgId, departmentId, statsDate, ERROR_CODE])
  } catch {
    // The durable job ledger also records a values-free failure. A missing row
    // or deploy-window table absence must not replace the original error.
  }
}

export async function projectElearningDepartmentStatsDaily(
  db: ElearningStatsDailyDb,
  input: ProjectElearningDepartmentStatsDailyInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectElearningDepartmentStatsDailyResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('unavailable')
  const orgId = requireText(input.orgId)
  const departmentId = requireUuid(input.departmentId)
  const statsDate = requireDate(input.statsDate)
  const period = utcPeriod(statsDate)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`elearning-stats-daily:${orgId}:${departmentId}:${statsDate}`],
      )
      const identity = await tx.query(DEPARTMENT_IDENTITY_SQL, [orgId, departmentId])
      if (identity.rows.length !== 1) fail('not_found')
      const integrationId = requireUuid(identity.rows[0]?.directory_integration_id)
      const provider = readText(identity.rows[0]?.directory_provider)

      const projection = await getElearningDepartmentStats(tx, {
        orgId,
        actorId: SYSTEM_ACTOR,
        isGlobalAdmin: true,
        departmentId,
        periodStart: period.start,
        periodEnd: period.end,
      })
      const digest = projectionDigest(projection)
      const existing = await tx.query(EXISTING_SQL, [orgId, departmentId, statsDate])
      if (existing.rows.length > 1) fail('unavailable')
      const current = existing.rows[0]
      if (current && readText(current.payload_digest) === digest) {
        const projectedVersion = readVersion(current.projected_version)
        const refreshed = await tx.query(REFRESH_NOOP_SQL, [
          orgId,
          departmentId,
          statsDate,
          digest,
          projection.sourceVersion,
        ])
        if (refreshed.rows.length !== 1) fail('unavailable')
        return {
          outcome: 'noop' as const,
          projectedVersion,
          suppressed: projection.suppressed,
        }
      }

      const written = await tx.query(UPSERT_SQL, [
        orgId,
        integrationId,
        provider,
        departmentId,
        statsDate,
        period.start,
        period.end,
        projection.sourceVersion,
        digest,
        projection.suppressed,
        5,
        ...metricParams(projection),
      ])
      if (written.rows.length !== 1) fail('unavailable')
      return {
        outcome: 'projected' as const,
        projectedVersion: readVersion(written.rows[0]?.projected_version),
        suppressed: projection.suppressed,
      }
    })
  } catch (error) {
    if (
      error instanceof ElearningStatsDailyProjectionError
      && (error.code === 'invalid_input' || error.code === 'not_found')
    ) throw error
    await recordFailure(db, orgId, departmentId, statsDate)
    fail('unavailable')
  }
}

export const elearningStatsDailySql = Object.freeze({
  dataset: ELEARNING_STATS_DAILY_DATASET,
  departmentIdentity: DEPARTMENT_IDENTITY_SQL,
  existing: EXISTING_SQL,
  refreshNoop: REFRESH_NOOP_SQL,
  recordError: RECORD_ERROR_SQL,
  upsert: UPSERT_SQL,
})
