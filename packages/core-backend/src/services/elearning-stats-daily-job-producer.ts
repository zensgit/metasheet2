import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'

export const ELEARNING_STATS_DAILY_PROJECT_JOB_KIND = 'stats_daily_project' as const

const PRODUCE_SQL = `/* elearning-stats-daily:enqueue-due */
WITH projection_clock AS (
  SELECT ((clock_timestamp() AT TIME ZONE 'UTC')::date - 1) AS stats_date
),
inserted AS (
  INSERT INTO elearning_jobs (
    org_id,
    kind,
    occurrence_key,
    ref,
    payload,
    due_at
  )
  SELECT
    integration.org_id,
    'stats_daily_project',
    'department:' || lower(department.id::text)
      || ':date:' || to_char(projection_clock.stats_date, 'YYYY-MM-DD'),
    lower(department.id::text),
    jsonb_build_object(
      'statsDate',
      to_char(projection_clock.stats_date, 'YYYY-MM-DD')
    ),
    clock_timestamp()
  FROM projection_clock
  JOIN directory_integrations integration
    ON integration.status = 'active'
  JOIN directory_departments department
    ON department.integration_id = integration.id
   AND department.is_active IS TRUE
  ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING
  RETURNING id
)
SELECT
  to_char(projection_clock.stats_date, 'YYYY-MM-DD') AS stats_date,
  count(inserted.id)::text AS enqueued_count
FROM projection_clock
LEFT JOIN inserted ON TRUE
GROUP BY projection_clock.stats_date`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type ElearningStatsDailyJobProducerErrorCode = 'unavailable'

export class ElearningStatsDailyJobProducerError extends Error {
  constructor(readonly code: ElearningStatsDailyJobProducerErrorCode) {
    super(code)
    this.name = 'ElearningStatsDailyJobProducerError'
  }
}

export interface ElearningStatsDailyJobProducerDb {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>
}

export interface EnqueueElearningStatsDailyJobsResult {
  statsDate: string
  enqueuedCount: number
}

function fail(): never {
  throw new ElearningStatsDailyJobProducerError('unavailable')
}

function storedDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail()
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail()
  return value
}

function storedCount(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) fail()
  const count = Number(value)
  if (!Number.isSafeInteger(count)) fail()
  return count
}

export async function enqueueElearningStatsDailyJobs(
  db: ElearningStatsDailyJobProducerDb,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueueElearningStatsDailyJobsResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail()
  try {
    const result = await db.query(PRODUCE_SQL)
    if (result.rows.length !== 1) fail()
    const row = result.rows[0]
    return {
      statsDate: storedDate(row.stats_date),
      enqueuedCount: storedCount(row.enqueued_count),
    }
  } catch (error) {
    if (error instanceof ElearningStatsDailyJobProducerError) throw error
    fail()
  }
}

export const elearningStatsDailyJobProducerSql = PRODUCE_SQL
