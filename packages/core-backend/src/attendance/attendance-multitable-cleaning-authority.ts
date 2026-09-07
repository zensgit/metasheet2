import { createHash } from 'node:crypto'

type QueryResult = { rows: unknown[]; rowCount?: number }
export type AttendanceCleaningAuthorityQuery = (sql: string, params?: unknown[]) => Promise<QueryResult>

export class AttendanceMultitableCleaningAuthorityError extends Error {
  constructor() {
    super('ATTENDANCE_CLEANING_ANCHOR_UNAVAILABLE')
    this.name = 'AttendanceMultitableCleaningAuthorityError'
  }
}

export type RefreshAttendanceReportProjectionAnchorInput = {
  projectionRecordId: string
  canonicalRecordId: string
  sourceFingerprint: string
}

type CanonicalRow = {
  projection_record_id: string
  canonical_record_id: string
  org_id: string
  user_id: string
  work_date: string
  timezone: string
  first_in_at: Date | string | null
  last_out_at: Date | string | null
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
  status: string
  is_workday: boolean
  projection_owner: string
  current_calculation_id: string | null
  visibility_state: string
  visibility_reason: string
}

type CalculationRow = { id: string; version: number; mode: string; outcome: string }

function unavailable(): never {
  throw new AttendanceMultitableCleaningAuthorityError()
}

function nonEmpty(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) unavailable()
  return value
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) unavailable()
  return value
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) unavailable()
  return date.toISOString()
}

export function buildAttendanceCanonicalSourceDigest(input: CanonicalRow): string {
  const tuple = [
    'attendance-canonical-source-v1',
    nonEmpty(input.org_id),
    nonEmpty(input.canonical_record_id),
    nonEmpty(input.user_id),
    nonEmpty(input.work_date),
    nonEmpty(input.timezone),
    timestamp(input.first_in_at),
    timestamp(input.last_out_at),
    positiveInteger(input.work_minutes + 1) - 1,
    positiveInteger(input.late_minutes + 1) - 1,
    positiveInteger(input.early_leave_minutes + 1) - 1,
    nonEmpty(input.status),
    input.is_workday === true,
    nonEmpty(input.projection_owner),
    input.current_calculation_id === null ? null : nonEmpty(input.current_calculation_id),
    nonEmpty(input.visibility_state),
    nonEmpty(input.visibility_reason),
  ]
  return createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')
}

function assertRefreshInput(input: RefreshAttendanceReportProjectionAnchorInput): void {
  if (
    !input
    || !/^rec_[A-Za-z0-9_-]+$/.test(input.projectionRecordId)
    || !/^[0-9a-f]{40}$/.test(input.sourceFingerprint)
    || typeof input.canonicalRecordId !== 'string'
    || input.canonicalRecordId.length === 0
  ) unavailable()
}

async function loadCanonicalRow(
  query: AttendanceCleaningAuthorityQuery,
  input: RefreshAttendanceReportProjectionAnchorInput,
): Promise<CanonicalRow> {
  const result = await query(
    `SELECT projection.id AS projection_record_id,
            attendance_record.id AS canonical_record_id, attendance_record.org_id, attendance_record.user_id, attendance_record.work_date,
            attendance_record.timezone, attendance_record.first_in_at, attendance_record.last_out_at, attendance_record.work_minutes,
            attendance_record.late_minutes, attendance_record.early_leave_minutes, attendance_record.status, attendance_record.is_workday,
            attendance_record.projection_owner, attendance_record.current_calculation_id, attendance_record.visibility_state,
            attendance_record.visibility_reason
       FROM meta_records projection
       JOIN meta_sheets sheet ON sheet.id = projection.sheet_id AND sheet.deleted_at IS NULL
       JOIN plugin_multitable_object_registry registry
         ON registry.sheet_id = projection.sheet_id
        AND registry.plugin_name = 'plugin-attendance'
        AND registry.object_id = 'attendance_report_records'
       JOIN attendance_records attendance_record ON attendance_record.id = $2
        AND registry.project_id = attendance_record.org_id || ':attendance'
      WHERE projection.id = $1
      FOR UPDATE OF projection, attendance_record`,
    [input.projectionRecordId, input.canonicalRecordId],
  )
  const row = result.rows[0] as CanonicalRow | undefined
  if (!row || result.rows.length !== 1) unavailable()
  return row
}

async function loadSelectedCalculation(
  query: AttendanceCleaningAuthorityQuery,
  record: CanonicalRow,
): Promise<{ selector: 'current_calculation' | 'latest_completed_calculation'; calculation: CalculationRow } | null> {
  if (record.projection_owner === 'w4' && record.current_calculation_id) {
    const current = await query(
      `SELECT id, version, mode, outcome
         FROM attendance_record_calculations
        WHERE id = $1 AND attendance_record_id = $2 AND org_id = $3
        FOR KEY SHARE`,
      [record.current_calculation_id, record.canonical_record_id, record.org_id],
    )
    const calculation = current.rows[0] as CalculationRow | undefined
    if (current.rows.length === 1 && calculation?.mode === 'authoritative' && calculation.outcome === 'completed') {
      return { selector: 'current_calculation', calculation }
    }
  }
  const latest = await query(
    `SELECT id, version, mode, outcome
       FROM attendance_record_calculations
      WHERE attendance_record_id = $1 AND org_id = $2 AND outcome = 'completed'
      ORDER BY version DESC
      LIMIT 1
      FOR KEY SHARE`,
    [record.canonical_record_id, record.org_id],
  )
  const calculation = latest.rows[0] as CalculationRow | undefined
  if (latest.rows.length === 0) return null
  if (latest.rows.length !== 1 || !calculation || !nonEmpty(calculation.id) || positiveInteger(calculation.version) < 1) unavailable()
  return { selector: 'latest_completed_calculation', calculation }
}

export async function refreshAttendanceReportProjectionAnchor(
  query: AttendanceCleaningAuthorityQuery,
  input: RefreshAttendanceReportProjectionAnchorInput,
): Promise<void> {
  try {
    assertRefreshInput(input)
    const record = await loadCanonicalRow(query, input)
    const selected = await loadSelectedCalculation(query, record)
    if (!selected) {
      await withholdAttendanceReportProjectionAnchors(query, [record.projection_record_id])
      return
    }
    const { selector, calculation } = selected
    const digest = buildAttendanceCanonicalSourceDigest(record)
    const existing = await query(
      `SELECT canonical_record_id
         FROM attendance_report_projection_anchors
        WHERE projection_record_id = $1
        FOR UPDATE`,
      [input.projectionRecordId],
    )
    const bound = existing.rows[0] as { canonical_record_id?: unknown } | undefined
    if (existing.rows.length > 1 || (bound && bound.canonical_record_id !== record.canonical_record_id)) unavailable()
    const written = await query(
      `INSERT INTO attendance_report_projection_anchors (
         projection_record_id, org_id, canonical_record_id, source_selector,
         source_calculation_id, source_calculation_version, canonical_source_digest, source_fingerprint
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (projection_record_id) DO UPDATE
          SET source_selector = EXCLUDED.source_selector,
              source_calculation_id = EXCLUDED.source_calculation_id,
              source_calculation_version = EXCLUDED.source_calculation_version,
              canonical_source_digest = EXCLUDED.canonical_source_digest,
              source_fingerprint = EXCLUDED.source_fingerprint,
              updated_at = now()
        WHERE attendance_report_projection_anchors.org_id = EXCLUDED.org_id
          AND attendance_report_projection_anchors.canonical_record_id = EXCLUDED.canonical_record_id
       RETURNING projection_record_id`,
      [
        record.projection_record_id,
        record.org_id,
        record.canonical_record_id,
        selector,
        nonEmpty(calculation.id),
        positiveInteger(calculation.version),
        digest,
        input.sourceFingerprint,
      ],
    )
    if (written.rows.length !== 1) unavailable()
  } catch (error) {
    if (error instanceof AttendanceMultitableCleaningAuthorityError) throw error
    unavailable()
  }
}

export async function withholdAttendanceReportProjectionAnchors(
  query: AttendanceCleaningAuthorityQuery,
  projectionRecordIds: readonly string[],
): Promise<void> {
  try {
    if (!Array.isArray(projectionRecordIds) || projectionRecordIds.length === 0 || projectionRecordIds.some(id => !/^rec_[A-Za-z0-9_-]+$/.test(id))) {
      unavailable()
    }
    await query(
      `DELETE FROM attendance_report_projection_anchors anchor
        USING meta_records projection, plugin_multitable_object_registry registry
       WHERE anchor.projection_record_id = projection.id
         AND projection.sheet_id = registry.sheet_id
         AND registry.plugin_name = 'plugin-attendance'
         AND registry.object_id = 'attendance_report_records'
         AND anchor.projection_record_id = ANY($1::text[])`,
      [projectionRecordIds],
    )
  } catch (error) {
    if (error instanceof AttendanceMultitableCleaningAuthorityError) throw error
    unavailable()
  }
}
