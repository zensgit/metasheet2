const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const WEEKLY_REPORT_MIN_GROUP_SIZE = 5 as const

export const ELEARNING_ONBOARDING_WEEKLY_REPORT_JOB_KIND =
  'onboarding_weekly_report' as const

export type ElearningOnboardingWeeklyReportErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export class ElearningOnboardingWeeklyReportError extends Error {
  constructor(readonly code: ElearningOnboardingWeeklyReportErrorCode) {
    super(code)
    this.name = 'ElearningOnboardingWeeklyReportError'
  }
}

export interface ElearningOnboardingWeeklyReportQueryable {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}

export interface ElearningOnboardingWeeklyReportDb
  extends ElearningOnboardingWeeklyReportQueryable {
  transaction<T>(
    run: (tx: ElearningOnboardingWeeklyReportQueryable) => Promise<T>,
  ): Promise<T>
}

export interface EnqueueElearningOnboardingWeeklyReportsInput {
  weekStart: unknown
}

export interface EnqueueElearningOnboardingWeeklyReportsResult {
  weekStart: string
  enqueuedCount: number
}

export interface MaterializeElearningOnboardingWeeklyReportInput {
  orgId: unknown
  jobId: unknown
}

export interface GetElearningOnboardingWeeklyReportInput {
  orgId: unknown
  policyId: unknown
  weekStart: unknown
}

export interface ElearningOnboardingWeeklyReportDto {
  reportId: string
  policyId: string
  weekStart: string
  weekEnd: string
  suppressed: boolean
  minGroupSize: typeof WEEKLY_REPORT_MIN_GROUP_SIZE
  enqueuedCount: number | null
  assignedUserCount: number | null
  failedCount: number | null
  deadCount: number | null
  duplicate: boolean
}

export const elearningOnboardingWeeklyReportEnqueueSql = `/* elearning-onboarding:enqueue-weekly-report */
WITH inserted AS (
  INSERT INTO elearning_jobs (
    org_id,
    kind,
    occurrence_key,
    ref,
    payload,
    due_at
  )
  SELECT
    policy.org_id,
    'onboarding_weekly_report',
    'policy:' || policy.id::text || ':week:' || $1::text,
    policy.id::text,
    jsonb_build_object(
      'policyId', policy.id::text,
      'weekStart', $1::text
    ),
    ($1::date + interval '8 days')
  FROM elearning_onboarding_policies policy
  WHERE policy.status = 'active'
    AND policy.weekly_report_enabled IS TRUE
  ON CONFLICT (org_id, kind, occurrence_key) DO NOTHING
  RETURNING id
)
SELECT $1::text AS week_start, count(*)::text AS enqueued_count
FROM inserted`

const LOCK_JOB_SQL = `/* elearning-onboarding:lock-weekly-report-job */
SELECT id, org_id, kind, occurrence_key, ref, status, payload
FROM elearning_jobs
WHERE org_id = $1
  AND id = $2
  AND kind = 'onboarding_weekly_report'
FOR UPDATE`

const LOCK_POLICY_SQL = `/* elearning-onboarding:lock-weekly-report-policy */
SELECT id, org_id, status, weekly_report_enabled
FROM elearning_onboarding_policies
WHERE org_id = $1
  AND id = $2
FOR UPDATE`

const LOAD_REPORT_SQL = `/* elearning-onboarding:load-weekly-report */
SELECT
  id AS report_id,
  policy_id,
  week_start,
  week_end,
  suppressed,
  min_group_size,
  enqueued_count,
  assigned_user_count,
  failed_count,
  dead_count
FROM elearning_onboarding_weekly_reports
WHERE org_id = $1
  AND policy_id = $2
  AND week_start = $3::date`

const AGGREGATE_SQL = `/* elearning-onboarding:aggregate-weekly-report */
WITH measured AS (
  SELECT
    count(job.id)::text AS enqueued_count,
    count(effect.id)::text AS assigned_user_count,
    count(*) FILTER (WHERE job.status = 'failed')::text AS failed_count,
    count(*) FILTER (WHERE job.status = 'dead')::text AS dead_count,
    (count(job.id) < 5) AS suppressed,
    5::integer AS min_group_size
  FROM elearning_jobs job
  LEFT JOIN elearning_onboarding_assignment_effects effect
    ON effect.org_id = job.org_id
   AND effect.job_occurrence_key = job.occurrence_key
  WHERE job.org_id = $1
    AND job.kind = 'onboarding_assign'
    AND job.ref = $2
    AND job.due_at >= $3::date
    AND job.due_at < $4::date
)
SELECT
  measured.suppressed,
  measured.min_group_size,
  CASE WHEN measured.suppressed THEN NULL ELSE measured.enqueued_count END AS enqueued_count,
  CASE WHEN measured.suppressed THEN NULL ELSE measured.assigned_user_count END AS assigned_user_count,
  CASE WHEN measured.suppressed THEN NULL ELSE measured.failed_count END AS failed_count,
  CASE WHEN measured.suppressed THEN NULL ELSE measured.dead_count END AS dead_count
FROM measured`

const INSERT_REPORT_SQL = `/* elearning-onboarding:insert-weekly-report */
INSERT INTO elearning_onboarding_weekly_reports (
  org_id,
  policy_id,
  week_start,
  week_end,
  suppressed,
  min_group_size,
  enqueued_count,
  assigned_user_count,
  failed_count,
  dead_count
)
VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10)
ON CONFLICT (org_id, policy_id, week_start) DO NOTHING
RETURNING
  id AS report_id,
  policy_id,
  week_start,
  week_end,
  suppressed,
  min_group_size,
  enqueued_count,
  assigned_user_count,
  failed_count,
  dead_count`

function fail(code: ElearningOnboardingWeeklyReportErrorCode): never {
  throw new ElearningOnboardingWeeklyReportError(code)
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireOrgId(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const orgId = value.trim()
  if (orgId === '' || orgId.length > 512 || orgId.includes('\0')) fail('invalid_input')
  return orgId
}

function requireCanonicalDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('invalid_input')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('invalid_input')
  }
  return value
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function assertClosedWeek(weekStart: string): void {
  const currentDate = new Date().toISOString().slice(0, 10)
  if (addDays(weekStart, 7) > currentDate) fail('invalid_input')
}

function count(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('unavailable')
  return parsed
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : count(value)
}

function storedReport(row: Record<string, unknown>): ElearningOnboardingWeeklyReportDto {
  const reportId = requireUuid(row.report_id)
  const policyId = requireUuid(row.policy_id)
  const weekStart = requireCanonicalDate(row.week_start)
  const weekEnd = requireCanonicalDate(row.week_end)
  if (weekEnd !== addDays(weekStart, 7)) fail('unavailable')
  if (typeof row.suppressed !== 'boolean') fail('unavailable')
  if (count(row.min_group_size) !== WEEKLY_REPORT_MIN_GROUP_SIZE) fail('unavailable')
  const counts = [
    nullableCount(row.enqueued_count),
    nullableCount(row.assigned_user_count),
    nullableCount(row.failed_count),
    nullableCount(row.dead_count),
  ]
  if (row.suppressed ? counts.some((value) => value !== null) : counts.some((value) => value === null)) {
    fail('unavailable')
  }
  return {
    reportId,
    policyId,
    weekStart,
    weekEnd,
    suppressed: row.suppressed,
    minGroupSize: WEEKLY_REPORT_MIN_GROUP_SIZE,
    enqueuedCount: counts[0],
    assignedUserCount: counts[1],
    failedCount: counts[2],
    deadCount: counts[3],
    duplicate: false,
  }
}

function duplicate(report: ElearningOnboardingWeeklyReportDto): ElearningOnboardingWeeklyReportDto {
  return { ...report, duplicate: true }
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input')
  return value as Record<string, unknown>
}

function requireClosedPayload(value: unknown): { policyId: string; weekStart: string } {
  const payload = payloadObject(value)
  const keys = Object.keys(payload).sort()
  if (keys.length !== 2 || keys[0] !== 'policyId' || keys[1] !== 'weekStart') {
    fail('invalid_input')
  }
  return {
    policyId: requireUuid(payload.policyId),
    weekStart: requireCanonicalDate(payload.weekStart),
  }
}

function valuesFree(error: unknown): ElearningOnboardingWeeklyReportError {
  if (error instanceof ElearningOnboardingWeeklyReportError) return error
  return new ElearningOnboardingWeeklyReportError('unavailable')
}

export async function enqueueElearningOnboardingWeeklyReports(
  db: ElearningOnboardingWeeklyReportQueryable,
  input: EnqueueElearningOnboardingWeeklyReportsInput,
): Promise<EnqueueElearningOnboardingWeeklyReportsResult> {
  const weekStart = requireCanonicalDate(input.weekStart)
  assertClosedWeek(weekStart)
  try {
    const result = await db.query(elearningOnboardingWeeklyReportEnqueueSql, [weekStart])
    if (result.rows.length !== 1) fail('unavailable')
    const row = result.rows[0]
    if (typeof row.week_start !== 'string' || row.week_start !== weekStart) fail('unavailable')
    return { weekStart, enqueuedCount: count(row.enqueued_count) }
  } catch (error) {
    throw valuesFree(error)
  }
}

export async function materializeElearningOnboardingWeeklyReport(
  db: ElearningOnboardingWeeklyReportDb,
  input: MaterializeElearningOnboardingWeeklyReportInput,
): Promise<ElearningOnboardingWeeklyReportDto> {
  const orgId = requireOrgId(input.orgId)
  const jobId = requireUuid(input.jobId)
  try {
    return await db.transaction(async (tx) => {
      const jobResult = await tx.query(LOCK_JOB_SQL, [orgId, jobId])
      if (jobResult.rows.length !== 1) fail('not_found')
      const job = jobResult.rows[0]
      const payload = requireClosedPayload(job.payload)
      assertClosedWeek(payload.weekStart)
      if (job.status !== 'running') fail('conflict')
      const expectedOccurrenceKey = `policy:${payload.policyId}:week:${payload.weekStart}`
      if (job.ref !== payload.policyId || job.occurrence_key !== expectedOccurrenceKey) {
        fail('conflict')
      }
      const policyResult = await tx.query(LOCK_POLICY_SQL, [orgId, payload.policyId])
      if (policyResult.rows.length !== 1) fail('not_found')

      const existingResult = await tx.query(LOAD_REPORT_SQL, [orgId, payload.policyId, payload.weekStart])
      if (existingResult.rows.length > 1) fail('unavailable')
      if (existingResult.rows.length === 1) {
        return duplicate(storedReport(existingResult.rows[0]))
      }

      const policy = policyResult.rows[0]
      if (
        !['active', 'retired'].includes(String(policy.status))
        || policy.weekly_report_enabled !== true
      ) fail('not_found')
      const weekEnd = addDays(payload.weekStart, 7)
      const aggregateResult = await tx.query(AGGREGATE_SQL, [
        orgId,
        payload.policyId,
        payload.weekStart,
        weekEnd,
      ])
      if (aggregateResult.rows.length !== 1) fail('unavailable')
      const aggregate = aggregateResult.rows[0]
      if (typeof aggregate.suppressed !== 'boolean') fail('unavailable')
      if (count(aggregate.min_group_size) !== WEEKLY_REPORT_MIN_GROUP_SIZE) fail('unavailable')
      const values = [
        nullableCount(aggregate.enqueued_count),
        nullableCount(aggregate.assigned_user_count),
        nullableCount(aggregate.failed_count),
        nullableCount(aggregate.dead_count),
      ]
      if (aggregate.suppressed ? values.some((value) => value !== null) : values.some((value) => value === null)) {
        fail('unavailable')
      }
      const insertedResult = await tx.query(INSERT_REPORT_SQL, [
        orgId,
        payload.policyId,
        payload.weekStart,
        weekEnd,
        aggregate.suppressed,
        WEEKLY_REPORT_MIN_GROUP_SIZE,
        ...values,
      ])
      if (insertedResult.rows.length === 1) return storedReport(insertedResult.rows[0])

      const racedResult = await tx.query(LOAD_REPORT_SQL, [orgId, payload.policyId, payload.weekStart])
      if (racedResult.rows.length === 1) return duplicate(storedReport(racedResult.rows[0]))
      fail('conflict')
    })
  } catch (error) {
    throw valuesFree(error)
  }
}

export async function getElearningOnboardingWeeklyReport(
  db: ElearningOnboardingWeeklyReportQueryable,
  input: GetElearningOnboardingWeeklyReportInput,
): Promise<ElearningOnboardingWeeklyReportDto> {
  const orgId = requireOrgId(input.orgId)
  const policyId = requireUuid(input.policyId)
  const weekStart = requireCanonicalDate(input.weekStart)
  try {
    const result = await db.query(LOAD_REPORT_SQL, [orgId, policyId, weekStart])
    if (result.rows.length === 0) fail('not_found')
    if (result.rows.length !== 1) fail('unavailable')
    return storedReport(result.rows[0])
  } catch (error) {
    throw valuesFree(error)
  }
}

export const elearningOnboardingWeeklyReportSql = {
  enqueue: elearningOnboardingWeeklyReportEnqueueSql,
  lockJob: LOCK_JOB_SQL,
  lockPolicy: LOCK_POLICY_SQL,
  load: LOAD_REPORT_SQL,
  aggregate: AGGREGATE_SQL,
  insert: INSERT_REPORT_SQL,
}
