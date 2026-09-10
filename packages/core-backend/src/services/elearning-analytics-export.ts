import { createHash, randomUUID } from 'node:crypto'

import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'
import {
  assertElearningRulesWithinAdminScope,
  elearningAdminScopeLockKey,
  ElearningAdminAccessError,
  type ElearningAdminAccessQueryable,
} from './elearning-admin-access'
import {
  deriveElearningAnalyticsExportStorageKey,
  getElearningAnalyticsExportStorage,
  type ElearningAnalyticsExportStorage,
} from './elearning-analytics-export-storage'

export const ELEARNING_ANALYTICS_EXPORT_JOB_KIND = 'analytics_export' as const
export const ELEARNING_ANALYTICS_EXPORT_CLEANUP_JOB_KIND = 'analytics_export_cleanup' as const
export const ELEARNING_ANALYTICS_EXPORT_REQUEST_DOMAIN =
  'elearning.analytics.export.request.v1' as const
export const ELEARNING_ANALYTICS_EXPORT_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_ANALYTICS_EXPORT_RETENTION_DAYS = 7 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256_RE = /^[0-9a-f]{64}$/
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const CSV_FORMULA_RE = /^[=+\-@\t\r]/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NUMERIC_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export type ElearningAnalyticsExportErrorCode =
  | 'disabled'
  | 'invalid_input'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'not_ready'
  | 'expired'
  | 'unavailable'

export class ElearningAnalyticsExportError extends Error {
  constructor(readonly code: ElearningAnalyticsExportErrorCode) {
    super(code)
    this.name = 'ElearningAnalyticsExportError'
  }
}

export interface ElearningAnalyticsExportQueryable extends ElearningAdminAccessQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAnalyticsExportDb extends ElearningAnalyticsExportQueryable {
  transaction<T>(run: (tx: ElearningAnalyticsExportQueryable) => Promise<T>): Promise<T>
}

export interface CreateElearningAnalyticsExportInput {
  orgId: unknown
  actorId: unknown
  isGlobalAdmin: unknown
  requestId: unknown
  departmentId: unknown
  periodStart: unknown
  periodEnd: unknown
}

export interface ReadElearningAnalyticsExportInput {
  orgId: unknown
  actorId: unknown
  isGlobalAdmin: unknown
  exportId: unknown
}

export type ElearningAnalyticsExportStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'expired'

export interface ElearningAnalyticsExportDto {
  exportId: string
  departmentId: string
  periodStart: string
  periodEnd: string
  status: ElearningAnalyticsExportStatus
  expiresAt: string
  completedAt: string | null
  errorCode: string | null
  duplicate: boolean
}

export interface DownloadElearningAnalyticsExportResult {
  exportId: string
  filename: string
  contentType: 'text/csv; charset=utf-8'
  content: Buffer
}

export interface MaterializeElearningAnalyticsExportInput {
  orgId: unknown
  exportId: unknown
}

export type MaterializeElearningAnalyticsExportResult = {
  outcome: 'materialized' | 'noop'
  exportId: string
}

export type CleanupElearningAnalyticsExportResult = {
  outcome: 'expired' | 'noop'
  exportId: string
}

interface PreparedCreate {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  requestId: string
  departmentId: string
  periodStart: string
  periodEnd: string
  requestHash: string
}

interface StoredExport {
  exportId: string
  actorId: string
  requestHash: string
  requestHashVersion: number
  departmentId: string
  periodStart: string
  periodEnd: string
  querySnapshot: Record<string, unknown>
  status: ElearningAnalyticsExportStatus
  storageKey: string | null
  fileSha256: string | null
  fileSizeBytes: number | null
  expiresAt: string
  completedAt: string | null
  errorCode: string | null
  expiredByClock: boolean
}

interface PreparedMaterialization {
  kind: 'materialize'
  orgId: string
  exportId: string
  storageKey: string
  digest: string
  content: Buffer
}

interface PreparedExpiredCleanup {
  kind: 'cleanup'
  orgId: string
  exportId: string
  storageKey: string | null
}

interface ProjectionSnapshotRow {
  statsDate: string
  periodStart: string
  periodEnd: string
  sourceVersion: string
  suppressed: boolean
  minGroupSize: number
  assignedCount: string | null
  completedCount: string | null
  completionRate: string | null
  creditAverage: string | null
  creditTotal: string | null
  examParticipantCount: string | null
  learnerCount: string | null
  learningSeconds: string | null
  memberCount: string | null
  overdueCount: string | null
}

function fail(code: ElearningAnalyticsExportErrorCode): never {
  throw new ElearningAnalyticsExportError(code)
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
    || !TIMESTAMP_RE.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) fail('invalid_input')
  return value
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_input')
  return value
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 1024) fail('unavailable')
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function storedNullableTimestamp(value: unknown): string | null {
  return value === null ? null : storedTimestamp(value)
}

function storedInteger(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('unavailable')
  return parsed
}

function storedNullableInteger(value: unknown): number | null {
  return value === null ? null : storedInteger(value)
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function storedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unavailable')
  return value as Record<string, unknown>
}

function storedDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('unavailable')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('unavailable')
  }
  return value
}

function storedMetric(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 128 || !NUMERIC_RE.test(value)) {
    fail('unavailable')
  }
  return value
}

function storedStatus(value: unknown): ElearningAnalyticsExportStatus {
  if (!['pending', 'running', 'succeeded', 'failed', 'expired'].includes(String(value))) {
    fail('unavailable')
  }
  return value as ElearningAnalyticsExportStatus
}

function storedErrorCode(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !ERROR_CODE_RE.test(value)) fail('unavailable')
  return value
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ))
}

export function hashElearningAnalyticsExportRequest(input: {
  actorId: string
  departmentId: string
  periodStart: string
  periodEnd: string
}): string {
  return createHash('sha256').update(canonical({
    actorId: input.actorId,
    departmentId: input.departmentId,
    domain: ELEARNING_ANALYTICS_EXPORT_REQUEST_DOMAIN,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    version: ELEARNING_ANALYTICS_EXPORT_REQUEST_HASH_VERSION,
  }), 'utf8').digest('hex')
}

function prepareCreate(input: CreateElearningAnalyticsExportInput): PreparedCreate {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const isGlobalAdmin = requireBoolean(input.isGlobalAdmin)
  const requestId = requireUuid(input.requestId)
  const departmentId = requireUuid(input.departmentId)
  const periodStart = requireTimestamp(input.periodStart)
  const periodEnd = requireTimestamp(input.periodEnd)
  if (periodStart >= periodEnd) fail('invalid_input')
  return {
    orgId,
    actorId,
    isGlobalAdmin,
    requestId,
    departmentId,
    periodStart,
    periodEnd,
    requestHash: hashElearningAnalyticsExportRequest({
      actorId,
      departmentId,
      periodStart,
      periodEnd,
    }),
  }
}

function mapScopeError(error: unknown): never {
  if (!(error instanceof ElearningAdminAccessError)) fail('unavailable')
  if (error.code === 'invalid_input') fail('invalid_input')
  if (['forbidden', 'scope_required', 'target_out_of_scope'].includes(error.code)) {
    fail('forbidden')
  }
  fail('unavailable')
}

async function assertActiveActor(
  db: ElearningAnalyticsExportQueryable,
  orgId: string,
  actorId: string,
): Promise<void> {
  const result = await db.query(
    `/* elearning-analytics-export:actor */
     SELECT 1 AS ok
     FROM user_orgs membership
     JOIN users account ON account.id = membership.user_id
     WHERE membership.org_id = $1
       AND membership.user_id = $2
       AND membership.is_active = true
       AND account.is_active = true
     FOR SHARE OF membership, account`,
    [orgId, actorId],
  )
  if (result.rows.length !== 1) fail('forbidden')
}

async function assertCurrentScope(
  db: ElearningAnalyticsExportQueryable,
  input: { orgId: string; actorId: string; isGlobalAdmin: boolean; departmentId: string },
): Promise<void> {
  try {
    await assertElearningRulesWithinAdminScope(db, {
      orgId: input.orgId,
      actorId: input.actorId,
      isGlobalAdmin: input.isGlobalAdmin,
      rules: [{
        subjectType: 'department',
        subjectRef: input.departmentId,
        includeChildren: false,
      }],
    })
  } catch (error) {
    mapScopeError(error)
  }
}

async function scopeSnapshot(
  db: ElearningAnalyticsExportQueryable,
  input: { orgId: string; actorId: string; isGlobalAdmin: boolean; departmentId: string },
): Promise<Record<string, unknown>> {
  if (input.isGlobalAdmin) {
    return { departmentId: input.departmentId, kind: 'global_admin', scopes: [] }
  }
  const result = await db.query(
    `/* elearning-analytics-export:scope-snapshot */
     SELECT id::text AS scope_id,
            directory_department_id::text AS department_id,
            include_children
     FROM elearning_admin_scopes
     WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL
     ORDER BY id ASC`,
    [input.orgId, input.actorId],
  )
  if (result.rows.length === 0) fail('forbidden')
  return {
    departmentId: input.departmentId,
    kind: 'delegated',
    scopes: result.rows.map((row) => ({
      departmentId: storedUuid(row.department_id),
      includeChildren: typeof row.include_children === 'boolean'
        ? row.include_children
        : fail('unavailable'),
      scopeId: storedUuid(row.scope_id),
    })),
  }
}

function parseStoredExport(row: Record<string, unknown>): StoredExport {
  const storageKey = row.storage_key === null ? null : storedText(row.storage_key)
  const fileSha256 = row.file_sha256 === null ? null : storedText(row.file_sha256)
  if (fileSha256 !== null && !SHA256_RE.test(fileSha256)) fail('unavailable')
  return {
    exportId: storedUuid(row.export_id),
    actorId: storedText(row.actor_id),
    requestHash: storedText(row.request_hash),
    requestHashVersion: storedInteger(row.request_hash_version),
    departmentId: storedUuid(row.department_id),
    periodStart: storedTimestamp(row.period_start),
    periodEnd: storedTimestamp(row.period_end),
    querySnapshot: storedObject(row.query_snapshot),
    status: storedStatus(row.status),
    storageKey,
    fileSha256,
    fileSizeBytes: storedNullableInteger(row.file_size_bytes),
    expiresAt: storedTimestamp(row.expires_at),
    completedAt: storedNullableTimestamp(row.completed_at),
    errorCode: storedErrorCode(row.error_code),
    expiredByClock: storedBoolean(row.expired_by_clock),
  }
}

function dto(row: StoredExport, duplicate: boolean): ElearningAnalyticsExportDto {
  return {
    exportId: row.exportId,
    departmentId: row.departmentId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    errorCode: row.errorCode,
    duplicate,
  }
}

const EXPORT_COLUMNS = `
  id::text AS export_id, actor_id, request_hash, request_hash_version,
  department_id::text AS department_id, period_start, period_end, query_snapshot, status,
  storage_key, file_sha256, file_size_bytes::text, expires_at, completed_at, error_code,
  (expires_at <= now()) AS expired_by_clock`

export async function createElearningAnalyticsExport(
  db: ElearningAnalyticsExportDb,
  input: CreateElearningAnalyticsExportInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningAnalyticsExportDto> {
  const prepared = prepareCreate(input)
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('disabled')
  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['elearning-analytics-export-request', `${prepared.orgId}:${prepared.actorId}:${prepared.requestId}`],
      )
      await tx.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [elearningAdminScopeLockKey(prepared.orgId, prepared.actorId)],
      )
      await assertActiveActor(tx, prepared.orgId, prepared.actorId)
      await assertCurrentScope(tx, prepared)

      const existing = await tx.query(
        `/* elearning-analytics-export:request */
         SELECT ${EXPORT_COLUMNS}
         FROM elearning_export_jobs
         WHERE org_id = $1 AND actor_id = $2 AND request_id = $3::uuid
         FOR SHARE`,
        [prepared.orgId, prepared.actorId, prepared.requestId],
      )
      if (existing.rows.length > 1) fail('unavailable')
      if (existing.rows[0]) {
        const row = parseStoredExport(existing.rows[0])
        if (
          row.requestHash !== prepared.requestHash
          || row.requestHashVersion !== ELEARNING_ANALYTICS_EXPORT_REQUEST_HASH_VERSION
        ) fail('conflict')
        return dto(row, true)
      }

      const snapshot = await scopeSnapshot(tx, prepared)
      const projectionSnapshot = await buildProjectionSnapshot(tx, prepared)
      const exportId = randomUUID()
      const inserted = await tx.query(
        `/* elearning-analytics-export:create */
         INSERT INTO elearning_export_jobs (
           id, org_id, actor_id, request_id, request_hash, request_hash_version,
           directory_integration_id, directory_provider, department_id,
           period_start, period_end, scope_snapshot, query_snapshot, expires_at
         )
         SELECT $1::uuid, $2, $3, $4::uuid, $5, $6,
                department.integration_id, department.provider, department.id,
                $8::timestamptz, $9::timestamptz, $10::jsonb, $11::jsonb,
                now() + ($12::int * interval '1 day')
         FROM directory_departments department
         JOIN directory_integrations integration
           ON integration.id = department.integration_id
          AND integration.org_id = $2
          AND integration.status = 'active'
         WHERE department.id = $7::uuid AND department.is_active IS TRUE
         RETURNING ${EXPORT_COLUMNS}`,
        [
          exportId,
          prepared.orgId,
          prepared.actorId,
          prepared.requestId,
          prepared.requestHash,
          ELEARNING_ANALYTICS_EXPORT_REQUEST_HASH_VERSION,
          prepared.departmentId,
          prepared.periodStart,
          prepared.periodEnd,
          JSON.stringify(snapshot),
          JSON.stringify(projectionSnapshot),
          ELEARNING_ANALYTICS_EXPORT_RETENTION_DAYS,
        ],
      )
      if (inserted.rows.length !== 1 || !inserted.rows[0]) fail('unavailable')
      await tx.query(
        `/* elearning-analytics-export:enqueue */
         INSERT INTO elearning_jobs (org_id, kind, occurrence_key, ref, payload, due_at)
         VALUES
           ($1, $2, $3, $4::text, jsonb_build_object('exportJobId', $4::text), now()),
           ($1, $5, $6, $4::text, jsonb_build_object('exportJobId', $4::text),
             now() + ($7::int * interval '1 day'))`,
        [
          prepared.orgId,
          ELEARNING_ANALYTICS_EXPORT_JOB_KIND,
          `export:${exportId}`,
          exportId,
          ELEARNING_ANALYTICS_EXPORT_CLEANUP_JOB_KIND,
          `export:${exportId}:cleanup`,
          ELEARNING_ANALYTICS_EXPORT_RETENTION_DAYS,
        ],
      )
      return dto(parseStoredExport(inserted.rows[0]), false)
    })
  } catch (error) {
    if (error instanceof ElearningAnalyticsExportError) throw error
    fail('unavailable')
  }
}

async function readAuthorizedExport(
  db: ElearningAnalyticsExportDb,
  input: ReadElearningAnalyticsExportInput,
): Promise<StoredExport> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const isGlobalAdmin = requireBoolean(input.isGlobalAdmin)
  const exportId = requireUuid(input.exportId)
  return db.transaction(async (tx) => {
    await tx.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [elearningAdminScopeLockKey(orgId, actorId)],
    )
    await assertActiveActor(tx, orgId, actorId)
    const result = await tx.query(
      `/* elearning-analytics-export:read */
       SELECT ${EXPORT_COLUMNS}
       FROM elearning_export_jobs
       WHERE org_id = $1 AND id = $2::uuid AND actor_id = $3`,
      [orgId, exportId, actorId],
    )
    if (result.rows.length === 0) fail('not_found')
    if (result.rows.length !== 1 || !result.rows[0]) fail('unavailable')
    const row = parseStoredExport(result.rows[0])
    await assertCurrentScope(tx, { orgId, actorId, isGlobalAdmin, departmentId: row.departmentId })
    return row
  })
}

export async function getElearningAnalyticsExport(
  db: ElearningAnalyticsExportDb,
  input: ReadElearningAnalyticsExportInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningAnalyticsExportDto> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('disabled')
  try {
    return dto(await readAuthorizedExport(db, input), false)
  } catch (error) {
    if (error instanceof ElearningAnalyticsExportError) throw error
    fail('unavailable')
  }
}

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const safe = CSV_FORMULA_RE.test(raw) ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}

const CSV_HEADERS = [
  'departmentId', 'statsDate', 'periodStart', 'periodEnd', 'sourceVersion',
  'suppressed', 'minGroupSize', 'assignedCount', 'completedCount', 'completionRate',
  'creditAverage', 'creditTotal', 'examParticipantCount', 'learnerCount',
  'learningSeconds', 'memberCount', 'overdueCount',
] as const

function exportCsv(rows: ProjectionSnapshotRow[], departmentId: string): Buffer {
  const output = [CSV_HEADERS.map(csvCell).join(',')]
  for (const row of rows) {
    const metrics = [
      row.assignedCount, row.completedCount, row.completionRate, row.creditAverage,
      row.creditTotal, row.examParticipantCount, row.learnerCount,
      row.learningSeconds, row.memberCount, row.overdueCount,
    ]
    if (row.suppressed ? metrics.some((value) => value !== null) : metrics.some((value) => value === null)) {
      fail('unavailable')
    }
    output.push([
      departmentId,
      row.statsDate,
      row.periodStart,
      row.periodEnd,
      row.sourceVersion,
      row.suppressed,
      row.minGroupSize,
      ...metrics,
    ].map(csvCell).join(','))
  }
  return Buffer.from(`\uFEFF${output.join('\r\n')}\r\n`, 'utf8')
}

const PROJECTION_SNAPSHOT_KEYS = [
  'dataset',
  'departmentId',
  'periodEnd',
  'periodStart',
  'rows',
  'version',
] as const

const PROJECTION_ROW_KEYS = [
  'assignedCount',
  'completedCount',
  'completionRate',
  'creditAverage',
  'creditTotal',
  'examParticipantCount',
  'learnerCount',
  'learningSeconds',
  'memberCount',
  'minGroupSize',
  'overdueCount',
  'periodEnd',
  'periodStart',
  'sourceVersion',
  'statsDate',
  'suppressed',
] as const

function projectionSnapshotRow(value: Record<string, unknown>): ProjectionSnapshotRow {
  if (Object.keys(value).sort().join('\0') !== [...PROJECTION_ROW_KEYS].sort().join('\0')) {
    fail('unavailable')
  }
  const row: ProjectionSnapshotRow = {
    statsDate: storedDate(value.statsDate),
    periodStart: storedTimestamp(value.periodStart),
    periodEnd: storedTimestamp(value.periodEnd),
    sourceVersion: storedText(value.sourceVersion),
    suppressed: storedBoolean(value.suppressed),
    minGroupSize: storedInteger(value.minGroupSize),
    assignedCount: storedMetric(value.assignedCount),
    completedCount: storedMetric(value.completedCount),
    completionRate: storedMetric(value.completionRate),
    creditAverage: storedMetric(value.creditAverage),
    creditTotal: storedMetric(value.creditTotal),
    examParticipantCount: storedMetric(value.examParticipantCount),
    learnerCount: storedMetric(value.learnerCount),
    learningSeconds: storedMetric(value.learningSeconds),
    memberCount: storedMetric(value.memberCount),
    overdueCount: storedMetric(value.overdueCount),
  }
  if (row.minGroupSize < 5 || row.periodStart >= row.periodEnd) fail('unavailable')
  const metrics = [
    row.assignedCount, row.completedCount, row.completionRate, row.creditAverage,
    row.creditTotal, row.examParticipantCount, row.learnerCount,
    row.learningSeconds, row.memberCount, row.overdueCount,
  ]
  if (row.suppressed ? metrics.some((metric) => metric !== null) : metrics.some((metric) => metric === null)) {
    fail('unavailable')
  }
  return row
}

function projectionSnapshotRowFromDb(value: Record<string, unknown>): ProjectionSnapshotRow {
  return projectionSnapshotRow({
    statsDate: value.stats_date,
    periodStart: value.period_start,
    periodEnd: value.period_end,
    sourceVersion: value.source_version,
    suppressed: value.suppressed,
    minGroupSize: value.min_group_size,
    assignedCount: value.assigned_count,
    completedCount: value.completed_count,
    completionRate: value.completion_rate,
    creditAverage: value.credit_average,
    creditTotal: value.credit_total,
    examParticipantCount: value.exam_participant_count,
    learnerCount: value.learner_count,
    learningSeconds: value.learning_seconds,
    memberCount: value.member_count,
    overdueCount: value.overdue_count,
  })
}

async function buildProjectionSnapshot(
  db: ElearningAnalyticsExportQueryable,
  input: Pick<PreparedCreate, 'orgId' | 'departmentId' | 'periodStart' | 'periodEnd'>,
): Promise<Record<string, unknown>> {
  const stats = await db.query(
    `/* elearning-analytics-export:snapshot */
     SELECT to_char(stats_date, 'YYYY-MM-DD') AS stats_date,
            period_start, period_end, source_version, suppressed,
            min_group_size, assigned_count::text, completed_count::text,
            completion_rate::text, credit_average::text, credit_total::text,
            exam_participant_count::text, learner_count::text,
            learning_seconds::text, member_count::text, overdue_count::text
     FROM elearning_stats_daily
     WHERE org_id = $1
       AND dataset = 'department_overview'
       AND department_id = $2::uuid
       AND period_start >= $3::timestamptz
       AND period_end <= $4::timestamptz
     ORDER BY stats_date ASC`,
    [input.orgId, input.departmentId, input.periodStart, input.periodEnd],
  )
  return {
    dataset: 'department_overview',
    departmentId: input.departmentId,
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    rows: stats.rows.map(projectionSnapshotRowFromDb),
    version: 1,
  }
}

function parseProjectionSnapshot(
  value: Record<string, unknown>,
  row: Pick<StoredExport, 'departmentId' | 'periodStart' | 'periodEnd'>,
): { content: Buffer; digest: string } {
  if (
    Object.keys(value).sort().join('\0') !== [...PROJECTION_SNAPSHOT_KEYS].sort().join('\0')
    || value.version !== 1
    || value.dataset !== 'department_overview'
    || value.departmentId !== row.departmentId
    || value.periodStart !== row.periodStart
    || value.periodEnd !== row.periodEnd
    || !Array.isArray(value.rows)
  ) fail('unavailable')
  const rows = value.rows.map((item) => projectionSnapshotRow(storedObject(item)))
  const content = exportCsv(rows, row.departmentId)
  return { content, digest: createHash('sha256').update(content).digest('hex') }
}

async function prepareMaterialization(
  db: ElearningAnalyticsExportDb,
  orgId: string,
  exportId: string,
): Promise<PreparedMaterialization | PreparedExpiredCleanup | null> {
  return db.transaction(async (tx) => {
    const result = await tx.query(
      `/* elearning-analytics-export:materialize-lock */
       SELECT ${EXPORT_COLUMNS}
       FROM elearning_export_jobs
       WHERE org_id = $1 AND id = $2::uuid
       FOR UPDATE`,
      [orgId, exportId],
    )
    if (result.rows.length === 0) fail('not_found')
    if (result.rows.length !== 1 || !result.rows[0]) fail('unavailable')
    const row = parseStoredExport(result.rows[0])
    if (row.status === 'expired' || row.expiredByClock) {
      if (row.status !== 'expired') {
        const expired = await tx.query(
          `/* elearning-analytics-export:materialize-expire */
           UPDATE elearning_export_jobs
           SET status = 'expired', expired_at = now(), updated_at = now()
           WHERE org_id = $1 AND id = $2::uuid AND status <> 'expired' AND expires_at <= now()
           RETURNING id`,
          [orgId, exportId],
        )
        if (expired.rows.length !== 1) fail('unavailable')
      }
      return { kind: 'cleanup', orgId, exportId, storageKey: row.storageKey }
    }
    if (row.status === 'succeeded') return null
    const { content, digest } = parseProjectionSnapshot(row.querySnapshot, row)
    const storageKey = deriveElearningAnalyticsExportStorageKey({ orgId, exportId })
    if (row.status !== 'pending') {
      if (
        row.storageKey !== storageKey
        || row.fileSha256 !== digest
        || row.fileSizeBytes !== content.length
      ) fail('unavailable')
      if (row.status === 'running') {
        return { kind: 'materialize', orgId, exportId, storageKey, digest, content }
      }
    }
    const updated = await tx.query(
      `/* elearning-analytics-export:materialize-claim */
       UPDATE elearning_export_jobs
       SET status = 'running', storage_key = $3, file_sha256 = $4,
           file_size_bytes = $5, error_code = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2::uuid AND status IN ('pending', 'failed')
       RETURNING id`,
      [orgId, exportId, storageKey, digest, content.length],
    )
    if (updated.rows.length !== 1) fail('unavailable')
    return { kind: 'materialize', orgId, exportId, storageKey, digest, content }
  })
}

async function markMaterializationFailed(
  db: ElearningAnalyticsExportDb,
  input: PreparedMaterialization,
): Promise<void> {
  await db.query(
    `/* elearning-analytics-export:materialize-failed */
     UPDATE elearning_export_jobs
     SET status = 'failed', error_code = 'STORAGE_UNAVAILABLE', updated_at = now()
     WHERE org_id = $1 AND id = $2::uuid AND status = 'running' AND file_sha256 = $3`,
    [input.orgId, input.exportId, input.digest],
  )
}

export async function materializeElearningAnalyticsExport(
  db: ElearningAnalyticsExportDb,
  input: MaterializeElearningAnalyticsExportInput,
  storage: ElearningAnalyticsExportStorage = getElearningAnalyticsExportStorage(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<MaterializeElearningAnalyticsExportResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('disabled')
  const orgId = requireText(input.orgId)
  const exportId = requireUuid(input.exportId)
  let prepared: PreparedMaterialization | PreparedExpiredCleanup | null = null
  try {
    prepared = await prepareMaterialization(db, orgId, exportId)
    if (!prepared) return { outcome: 'noop', exportId }
    if (prepared.kind === 'cleanup') {
      if (prepared.storageKey !== null) await storage.delete(prepared.storageKey)
      return { outcome: 'noop', exportId }
    }
    try {
      await storage.put(prepared.storageKey, prepared.content)
    } catch {
      const existing = await storage.get(prepared.storageKey).catch(() => null)
      if (!existing || createHash('sha256').update(existing).digest('hex') !== prepared.digest) {
        await markMaterializationFailed(db, prepared).catch(() => undefined)
        fail('unavailable')
      }
    }
    const finalized = await db.query(
      `/* elearning-analytics-export:materialize-complete */
       UPDATE elearning_export_jobs
       SET status = 'succeeded', completed_at = now(), error_code = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2::uuid AND status = 'running'
         AND storage_key = $3 AND file_sha256 = $4 AND file_size_bytes = $5
       RETURNING id`,
      [orgId, exportId, prepared.storageKey, prepared.digest, prepared.content.length],
    )
    if (finalized.rows.length !== 1) {
      const replay = await db.query(
        `/* elearning-analytics-export:materialize-replay */
         SELECT status, storage_key, file_sha256, file_size_bytes::text
         FROM elearning_export_jobs
         WHERE org_id = $1 AND id = $2::uuid`,
        [orgId, exportId],
      )
      const replayRow = replay.rows[0]
      const matchingClaim = replay.rows.length === 1
        && replayRow?.storage_key === prepared.storageKey
        && replayRow.file_sha256 === prepared.digest
        && storedInteger(replayRow.file_size_bytes) === prepared.content.length
      if (matchingClaim && replayRow?.status === 'succeeded') {
        return { outcome: 'noop', exportId }
      }
      if (matchingClaim && replayRow?.status === 'expired') {
        await storage.delete(prepared.storageKey)
        return { outcome: 'noop', exportId }
      }
      fail('unavailable')
    }
    return { outcome: 'materialized', exportId }
  } catch (error) {
    if (error instanceof ElearningAnalyticsExportError) throw error
    if (prepared?.kind === 'materialize') {
      await markMaterializationFailed(db, prepared).catch(() => undefined)
    }
    fail('unavailable')
  }
}

export async function downloadElearningAnalyticsExport(
  db: ElearningAnalyticsExportDb,
  input: ReadElearningAnalyticsExportInput,
  storage: ElearningAnalyticsExportStorage = getElearningAnalyticsExportStorage(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<DownloadElearningAnalyticsExportResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('disabled')
  try {
    const row = await readAuthorizedExport(db, input)
    if (row.status === 'expired' || row.expiredByClock) fail('expired')
    if (row.status !== 'succeeded') fail('not_ready')
    if (!row.storageKey || !row.fileSha256 || row.fileSizeBytes === null) fail('unavailable')
    const content = await storage.get(row.storageKey)
    if (
      content.length !== row.fileSizeBytes
      || createHash('sha256').update(content).digest('hex') !== row.fileSha256
    ) fail('unavailable')
    return {
      exportId: row.exportId,
      filename: `elearning-department-stats-${row.exportId}.csv`,
      contentType: 'text/csv; charset=utf-8',
      content,
    }
  } catch (error) {
    if (error instanceof ElearningAnalyticsExportError) throw error
    fail('unavailable')
  }
}

export async function cleanupElearningAnalyticsExport(
  db: ElearningAnalyticsExportDb,
  input: MaterializeElearningAnalyticsExportInput,
  storage: ElearningAnalyticsExportStorage = getElearningAnalyticsExportStorage(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CleanupElearningAnalyticsExportResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('disabled')
  const orgId = requireText(input.orgId)
  const exportId = requireUuid(input.exportId)
  try {
    const prepared = await db.transaction(async (tx) => {
      const found = await tx.query(
        `/* elearning-analytics-export:cleanup-lock */
         SELECT storage_key, status, (expires_at <= now()) AS expired_by_clock
         FROM elearning_export_jobs
         WHERE org_id = $1 AND id = $2::uuid
         FOR UPDATE`,
        [orgId, exportId],
      )
      if (found.rows.length === 0) fail('not_found')
      if (found.rows.length !== 1 || !found.rows[0]) fail('unavailable')
      const row = found.rows[0]
      const status = storedStatus(row.status)
      if (status !== 'expired' && !storedBoolean(row.expired_by_clock)) return null
      if (status !== 'expired') {
        const updated = await tx.query(
          `/* elearning-analytics-export:cleanup-expire */
           UPDATE elearning_export_jobs
           SET status = 'expired', expired_at = now(), updated_at = now()
           WHERE org_id = $1 AND id = $2::uuid AND status <> 'expired' AND expires_at <= now()
           RETURNING id`,
          [orgId, exportId],
        )
        if (updated.rows.length !== 1) fail('unavailable')
      }
      return {
        storageKey: row.storage_key === null ? null : storedText(row.storage_key),
      }
    })
    if (!prepared) return { outcome: 'noop', exportId }
    if (prepared.storageKey !== null) await storage.delete(prepared.storageKey)
    return { outcome: 'expired', exportId }
  } catch (error) {
    if (error instanceof ElearningAnalyticsExportError) throw error
    fail('unavailable')
  }
}

export const elearningAnalyticsExportCsvCell = csvCell
