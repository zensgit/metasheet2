import { createHash } from 'node:crypto'

import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'
import { fenceWriterEntry } from '../multitable/canonical-sheet-fence'
import {
  deriveElearningProjectionBaseId,
  deriveElearningProjectionFieldId,
  deriveElearningProjectionRecordId,
  deriveElearningProjectionSheetId,
  ELEARNING_PROJECTION_SYSTEM_KIND,
  ELEARNING_PROJECTION_SYSTEM_OWNER,
  ELEARNING_STATS_MULTITABLE_SHEETS_TABLE,
} from '../multitable/elearning-projection-constants'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DIGEST_RE = /^[0-9a-f]{64}$/

const SOURCE_SQL = `/* elearning-stats-multitable:source */
SELECT
  stats.department_id::text,
  department.name AS department_name,
  stats.stats_date::text,
  stats.period_start,
  stats.period_end,
  stats.payload_digest,
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
  stats.projected_version::text
FROM elearning_stats_daily stats
JOIN directory_departments department
  ON department.id = stats.department_id
 AND department.integration_id = stats.directory_integration_id
 AND department.provider = stats.directory_provider
WHERE stats.org_id = $1
  AND stats.dataset = 'department_overview'
  AND stats.department_id = $2::uuid
  AND stats.stats_date = $3::date`

const RECONCILE_SCAN_SQL = `/* elearning-stats-multitable:reconcile-scan */
SELECT stats.org_id, stats.department_id::text, stats.stats_date::text
FROM elearning_stats_daily stats
LEFT JOIN elearning_stats_multitable_sheets mapping
  ON mapping.org_id = stats.org_id
LEFT JOIN meta_records record
  ON record.sheet_id = mapping.sheet_id
 AND record.id = 'rec_el_stats_' || substring(encode(digest(
       mapping.sheet_id || ':' || lower(stats.department_id::text) || ':' || stats.stats_date::text,
       'sha256'
     ), 'hex'), 1, 32)
WHERE stats.dataset = 'department_overview'
  AND (
    record.id IS NULL
    OR record.data ->> (
      'fld_el_stats_' || substring(encode(digest(
        mapping.sheet_id || ':projectedVersion',
        'sha256'
      ), 'hex'), 1, 32)
    ) IS DISTINCT FROM stats.projected_version::text
  )
ORDER BY stats.last_projected_at ASC, stats.org_id ASC,
         stats.department_id ASC, stats.stats_date ASC
LIMIT $1`

type FieldType = 'text' | 'date' | 'dateTime' | 'number' | 'checkbox'

interface ProjectionField {
  key: string
  name: string
  type: FieldType
}

const IDENTITY_FIELDS: readonly ProjectionField[] = [
  { key: 'departmentId', name: 'Department ID', type: 'text' },
  { key: 'departmentName', name: 'Department', type: 'text' },
  { key: 'statsDate', name: 'Statistics Date', type: 'date' },
  { key: 'periodStart', name: 'Period Start', type: 'dateTime' },
  { key: 'periodEnd', name: 'Period End', type: 'dateTime' },
  { key: 'suppressed', name: 'Suppressed', type: 'checkbox' },
  { key: 'minGroupSize', name: 'Minimum Group Size', type: 'number' },
  { key: 'projectedVersion', name: 'Projected Version', type: 'number' },
]

const METRIC_FIELDS: readonly ProjectionField[] = [
  { key: 'assignedCount', name: 'Assigned', type: 'number' },
  { key: 'completedCount', name: 'Completed', type: 'number' },
  { key: 'completionRate', name: 'Completion Rate', type: 'number' },
  { key: 'creditAverage', name: 'Average Credits', type: 'number' },
  { key: 'creditTotal', name: 'Total Credits', type: 'number' },
  { key: 'examParticipantCount', name: 'Exam Participants', type: 'number' },
  { key: 'learnerCount', name: 'Learners', type: 'number' },
  { key: 'learningSeconds', name: 'Learning Seconds', type: 'number' },
  { key: 'memberCount', name: 'Department Members', type: 'number' },
  { key: 'overdueCount', name: 'Overdue', type: 'number' },
]

export const ELEARNING_STATS_MULTITABLE_FIELDS = Object.freeze([
  ...IDENTITY_FIELDS,
  ...METRIC_FIELDS,
])
export const ELEARNING_STATS_MULTITABLE_METRIC_FIELDS = Object.freeze([...METRIC_FIELDS])

export type ElearningStatsMultitableProjectionErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'unavailable'

export class ElearningStatsMultitableProjectionError extends Error {
  constructor(readonly code: ElearningStatsMultitableProjectionErrorCode) {
    super(code)
    this.name = 'ElearningStatsMultitableProjectionError'
  }
}

export interface ElearningStatsMultitableQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}

export interface ElearningStatsMultitableDb extends ElearningStatsMultitableQueryable {
  transaction<T>(run: (tx: ElearningStatsMultitableQueryable) => Promise<T>): Promise<T>
}

export interface ProjectElearningStatsMultitableInput {
  orgId: string
  departmentId: string
  statsDate: string
}

export type ProjectElearningStatsMultitableResult = {
  outcome: 'projected' | 'noop'
  baseId: string
  sheetId: string
  recordId: string
  suppressed: boolean
}

function fail(code: ElearningStatsMultitableProjectionErrorCode): never {
  throw new ElearningStatsMultitableProjectionError(code)
}

function requireText(value: unknown, maxLength = 512): string {
  if (typeof value !== 'string') fail('unavailable')
  const text = value.trim()
  if (text === '' || text.length > maxLength || text.includes('\0')) {
    fail('unavailable')
  }
  return text
}

function inputText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > 512 || text.includes('\0')) fail('invalid_input')
  return text
}

function inputUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function inputDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('invalid_input')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail('invalid_input')
  }
  return value
}

function readUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function readDate(value: unknown): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) fail('unavailable')
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail('unavailable')
  }
  return value
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function readInteger(value: unknown, minimum = 0): number {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) fail('unavailable')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail('unavailable')
  return parsed
}

function readDecimal(value: unknown, minimum?: number, maximum?: number): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) fail('unavailable')
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('unavailable')
  if (minimum !== undefined && parsed < minimum) fail('unavailable')
  if (maximum !== undefined && parsed > maximum) fail('unavailable')
  return parsed
}

function readTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) fail('unavailable')
  return date.toISOString()
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function buildProjectionData(
  orgId: string,
  row: Record<string, unknown>,
): { data: Record<string, string | number | boolean>; suppressed: boolean } {
  const departmentId = readUuid(row.department_id)
  const statsDate = readDate(row.stats_date)
  const suppressed = readBoolean(row.suppressed)
  if (typeof row.payload_digest !== 'string' || !DIGEST_RE.test(row.payload_digest)) {
    fail('unavailable')
  }
  const values: Record<string, string | number | boolean> = {
    departmentId,
    departmentName: requireText(row.department_name, 1024),
    statsDate,
    periodStart: readTimestamp(row.period_start),
    periodEnd: readTimestamp(row.period_end),
    suppressed,
    minGroupSize: readInteger(String(row.min_group_size), 5),
    projectedVersion: readInteger(row.projected_version, 1),
  }
  if (!suppressed) {
    Object.assign(values, {
      assignedCount: readInteger(row.assigned_count),
      completedCount: readInteger(row.completed_count),
      completionRate: readDecimal(row.completion_rate, 0, 1),
      creditAverage: readDecimal(row.credit_average),
      creditTotal: readInteger(row.credit_total, Number.MIN_SAFE_INTEGER),
      examParticipantCount: readInteger(row.exam_participant_count),
      learnerCount: readInteger(row.learner_count),
      learningSeconds: readInteger(row.learning_seconds),
      memberCount: readInteger(row.member_count),
      overdueCount: readInteger(row.overdue_count),
    })
  }
  const data: Record<string, string | number | boolean> = {}
  for (const field of ELEARNING_STATS_MULTITABLE_FIELDS) {
    if (Object.hasOwn(values, field.key)) {
      data[deriveElearningProjectionFieldId(orgId, field.key)] = values[field.key]!
    }
  }
  return { data, suppressed }
}

async function ensureProjectionObjects(
  tx: ElearningStatsMultitableQueryable,
  orgId: string,
  baseId: string,
  sheetId: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
     VALUES ($1, 'Cloud Classroom Statistics', 'table', '#5b8def', $2, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [baseId, ELEARNING_PROJECTION_SYSTEM_OWNER],
  )
  const base = await tx.query(
    `SELECT id, owner_id, deleted_at
       FROM meta_bases
      WHERE id = $1
      FOR UPDATE`,
    [baseId],
  )
  const baseRow = base.rows[0]
  if (
    base.rows.length !== 1
    || baseRow?.owner_id !== ELEARNING_PROJECTION_SYSTEM_OWNER
    || baseRow.deleted_at !== null
  ) fail('unavailable')

  await tx.query(
    `INSERT INTO meta_sheets (id, base_id, name, description, system_kind)
     VALUES ($1, $2, 'Department Learning Statistics',
             'System-managed e-learning aggregate read model', $3)
     ON CONFLICT (id) DO NOTHING`,
    [sheetId, baseId, ELEARNING_PROJECTION_SYSTEM_KIND],
  )
  const sheet = await tx.query(
    `SELECT id, base_id, system_kind
       FROM meta_sheets
      WHERE id = $1
      FOR UPDATE`,
    [sheetId],
  )
  const sheetRow = sheet.rows[0]
  if (
    sheet.rows.length !== 1
    || sheetRow?.base_id !== baseId
    || sheetRow.system_kind !== ELEARNING_PROJECTION_SYSTEM_KIND
  ) fail('unavailable')

  for (let order = 0; order < ELEARNING_STATS_MULTITABLE_FIELDS.length; order += 1) {
    const field = ELEARNING_STATS_MULTITABLE_FIELDS[order]!
    await tx.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
       ON CONFLICT (id) DO NOTHING`,
      [deriveElearningProjectionFieldId(orgId, field.key), sheetId, field.name, field.type, order],
    )
  }
  const fields = await tx.query(
    `SELECT id, sheet_id, name, type, property, "order"
       FROM meta_fields
      WHERE sheet_id = $1
      ORDER BY "order", id`,
    [sheetId],
  )
  if (fields.rows.length !== ELEARNING_STATS_MULTITABLE_FIELDS.length) fail('unavailable')
  for (let order = 0; order < ELEARNING_STATS_MULTITABLE_FIELDS.length; order += 1) {
    const expected = ELEARNING_STATS_MULTITABLE_FIELDS[order]!
    const actual = fields.rows[order]
    if (
      actual?.id !== deriveElearningProjectionFieldId(orgId, expected.key)
      || actual.sheet_id !== sheetId
      || actual.name !== expected.name
      || actual.type !== expected.type
      || Number(actual.order) !== order
      || JSON.stringify(actual.property) !== '{}'
    ) fail('unavailable')
  }

  await tx.query(
    `INSERT INTO ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
       (org_id, base_id, sheet_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId, baseId, sheetId],
  )
  const mapping = await tx.query(
    `SELECT org_id, base_id, sheet_id
       FROM ${ELEARNING_STATS_MULTITABLE_SHEETS_TABLE}
      WHERE org_id = $1
      FOR UPDATE`,
    [orgId],
  )
  const mappingRow = mapping.rows[0]
  if (
    mapping.rows.length !== 1
    || mappingRow?.base_id !== baseId
    || mappingRow.sheet_id !== sheetId
  ) fail('unavailable')
}

export async function projectElearningStatsToMultitable(
  db: ElearningStatsMultitableDb,
  input: ProjectElearningStatsMultitableInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectElearningStatsMultitableResult> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('unavailable')
  const orgId = inputText(input.orgId)
  const departmentId = inputUuid(input.departmentId)
  const statsDate = inputDate(input.statsDate)
  const baseId = deriveElearningProjectionBaseId(orgId)
  const sheetId = deriveElearningProjectionSheetId(orgId)
  const recordId = deriveElearningProjectionRecordId(orgId, departmentId, statsDate)

  return db.transaction(async (tx) => {
    await fenceWriterEntry(tx.query.bind(tx), sheetId)
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `elearning-stats-multitable:${orgId}:${departmentId}:${statsDate}`,
    ])
    const source = await tx.query(SOURCE_SQL, [orgId, departmentId, statsDate])
    if (source.rows.length !== 1) fail('not_found')
    const { data, suppressed } = buildProjectionData(orgId, source.rows[0]!)
    await ensureProjectionObjects(tx, orgId, baseId, sheetId)

    const existing = await tx.query(
      `SELECT sheet_id, data, version
         FROM meta_records
        WHERE id = $1
        FOR UPDATE`,
      [recordId],
    )
    if (existing.rows.length > 1) fail('unavailable')
    const current = existing.rows[0]
    if (current?.sheet_id !== undefined && current.sheet_id !== sheetId) fail('unavailable')
    const digest = createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex')
    const currentDigest = current
      ? createHash('sha256').update(canonicalJson(current.data), 'utf8').digest('hex')
      : null
    if (currentDigest === digest) {
      return { outcome: 'noop', baseId, sheetId, recordId, suppressed }
    }

    const written = await tx.query(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
       VALUES ($1, $2, $3::jsonb, 1, $4, $4)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             version = meta_records.version + 1,
             modified_by = EXCLUDED.modified_by,
             updated_at = now()
       WHERE meta_records.sheet_id = EXCLUDED.sheet_id
       RETURNING id`,
      [recordId, sheetId, JSON.stringify(data), ELEARNING_PROJECTION_SYSTEM_OWNER],
    )
    if (written.rows.length !== 1) fail('unavailable')
    return { outcome: 'projected', baseId, sheetId, recordId, suppressed }
  })
}

export async function reconcileElearningStatsMultitable(
  db: ElearningStatsMultitableDb,
  limit = 200,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ scanned: number; projected: number; failed: number }> {
  if (!isElearningAnalyticsSurfaceEnabled(env)) fail('unavailable')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('invalid_input')
  const rows = await db.query(RECONCILE_SCAN_SQL, [limit])
  let projected = 0
  let failed = 0
  for (const row of rows.rows) {
    try {
      const result = await projectElearningStatsToMultitable(db, {
        orgId: inputText(row.org_id),
        departmentId: inputUuid(row.department_id),
        statsDate: inputDate(row.stats_date),
      }, env)
      if (result.outcome === 'projected') projected += 1
    } catch {
      failed += 1
    }
  }
  return { scanned: rows.rows.length, projected, failed }
}

export const elearningStatsMultitableSql = Object.freeze({
  reconcileScan: RECONCILE_SCAN_SQL,
  source: SOURCE_SQL,
})
