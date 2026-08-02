/**
 * W4C-3c P20 — one canonical active-current helper for ordinary attendance-record
 * readers (lock §7.6 / §12.6 / OD-W4C-31).
 *
 * Every ordinary consumer must go through these helpers (or the SQL fragments they
 * export). Direct base-table reads without the active predicate are history /
 * write-lock / operator-audit only and remain classified separately.
 *
 * The four P20 surfaces — anomaly listing, makeup-anomaly facts, open-record
 * attribution, and DecisionTrace — each call a distinct load function so a
 * mutation that drops the predicate from one surface fails only that surface's
 * positive control.
 */

export const ATTENDANCE_ACTIVE_CURRENT_RELATION_V1 = 'attendance_current_records' as const

/** Explicit active predicate for callers that must touch the base table (e.g. FOR UPDATE). */
export const ATTENDANCE_ACTIVE_CURRENT_VISIBILITY_PREDICATE_V1 =
  "visibility_state = 'active'" as const

export type AttendanceActiveCurrentQueryFnV1 = (
  sqlText: string,
  params?: readonly unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>

function asRows<T extends Record<string, unknown>>(
  result: { rows: Array<Record<string, unknown>> } | Array<Record<string, unknown>>,
): T[] {
  const rows = Array.isArray(result) ? result : result.rows
  return rows as T[]
}

export interface AttendanceActiveCurrentKeyV1 {
  readonly orgId: string
  readonly userId: string
  readonly workDate: string
}

export interface AttendanceActiveCurrentRangeV1 {
  readonly orgId: string
  readonly userId: string
  readonly from: string
  readonly to: string
}

export interface AttendanceActiveCurrentOpenRangeV1 {
  readonly orgId: string
  readonly userId: string
  readonly workDates: readonly string[]
}

/**
 * DecisionTrace / single-day ordinary current row.
 * Relation is always the canonical active-current view.
 */
export async function loadActiveCurrentAttendanceRecordForDecisionTraceV1<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  query: AttendanceActiveCurrentQueryFnV1,
  key: AttendanceActiveCurrentKeyV1,
  columns = 'id, status, is_workday, work_minutes, late_minutes, early_leave_minutes, meta, source_batch_id, created_at, updated_at',
): Promise<T | null> {
  const result = await query(
    `SELECT ${columns}
       FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1}
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
      LIMIT 1`,
    [key.orgId, key.userId, key.workDate],
  )
  const rows = asRows<T>(result)
  return rows[0] ?? null
}

/**
 * Anomaly listing ordinary current rows for a user/date range.
 */
export async function listActiveCurrentAttendanceRecordsForAnomalyListingV1<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  query: AttendanceActiveCurrentQueryFnV1,
  range: AttendanceActiveCurrentRangeV1 & {
    readonly excludedStatuses: readonly string[]
    readonly owedPunchOnly?: boolean
    readonly limit?: number
    readonly offset?: number
    readonly countOnly?: boolean
  },
): Promise<T[]> {
  const owedPunchClause = range.owedPunchOnly
    ? ` AND COALESCE(is_workday, true) = true
        AND (
          (status = 'partial' AND (first_in_at IS NULL OR last_out_at IS NULL))
          OR status = 'absent'
        )`
    : ''
  const owedPunchRowClause = range.owedPunchOnly
    ? ` AND COALESCE(current_record.is_workday, true) = true
        AND (
          (current_record.status = 'partial' AND (current_record.first_in_at IS NULL OR current_record.last_out_at IS NULL))
          OR current_record.status = 'absent'
        )`
    : ''
  if (range.countOnly) {
    const result = await query(
      `SELECT COUNT(*)::int AS total
         FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1}
        WHERE user_id = $1
          AND org_id = $2
          AND work_date BETWEEN $3 AND $4
          AND COALESCE(is_workday, true) = true
          AND COALESCE(status, '') <> ALL($5)${owedPunchClause}`,
      [range.userId, range.orgId, range.from, range.to, range.excludedStatuses],
    )
    return asRows<T>(result)
  }
  const limit = range.limit ?? 50
  const offset = range.offset ?? 0
  const result = await query(
    `SELECT current_record.*,
            current_calc.version AS current_calculation_version,
            latest_calc.id::text AS latest_calculation_id,
            latest_calc.version AS latest_calculation_version
       FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1} current_record
       LEFT JOIN attendance_record_calculations current_calc
         ON current_calc.id = current_record.current_calculation_id
        AND current_calc.attendance_record_id = current_record.id
        AND current_calc.org_id = current_record.org_id
       LEFT JOIN LATERAL (
         SELECT calculation.id, calculation.version
           FROM attendance_record_calculations calculation
          WHERE calculation.attendance_record_id = current_record.id
            AND calculation.org_id = current_record.org_id
            AND calculation.outcome = 'completed'
          ORDER BY calculation.version DESC
          LIMIT 1
       ) latest_calc ON TRUE
      WHERE current_record.user_id = $1
        AND current_record.org_id = $2
        AND current_record.work_date BETWEEN $3 AND $4
        AND COALESCE(current_record.is_workday, true) = true
        AND COALESCE(current_record.status, '') <> ALL($5)${owedPunchRowClause}
      ORDER BY current_record.work_date DESC
      LIMIT $6 OFFSET $7`,
    [range.userId, range.orgId, range.from, range.to, range.excludedStatuses, limit, offset],
  )
  return asRows<T>(result)
}

/**
 * Makeup-anomaly fact derivation ordinary current row.
 */
export async function loadActiveCurrentAttendanceRecordForMakeupAnomalyFactsV1<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  query: AttendanceActiveCurrentQueryFnV1,
  key: AttendanceActiveCurrentKeyV1,
): Promise<T | null> {
  const result = await query(
    `SELECT status, first_in_at, last_out_at, late_minutes, early_leave_minutes, is_workday, meta
       FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1}
      WHERE org_id = $1 AND user_id = $2 AND work_date = $3
      LIMIT 1`,
    [key.orgId, key.userId, key.workDate],
  )
  const rows = asRows<T>(result)
  return rows[0] ?? null
}

/**
 * Open-record work-date attribution ordinary current rows.
 */
export async function listActiveCurrentOpenRecordsForWorkDateResolverV1<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  query: AttendanceActiveCurrentQueryFnV1,
  range: AttendanceActiveCurrentOpenRangeV1,
): Promise<T[]> {
  if (!range.userId || range.workDates.length === 0) return []
  const result = await query(
    `SELECT user_id, org_id, work_date, first_in_at, last_out_at, status
       FROM ${ATTENDANCE_ACTIVE_CURRENT_RELATION_V1}
      WHERE org_id = $1
        AND user_id = $2
        AND work_date = ANY($3::date[])
        AND first_in_at IS NOT NULL
        AND last_out_at IS NULL`,
    [range.orgId, range.userId, range.workDates],
  )
  return asRows<T>(result)
}

/**
 * Mutation helper used by tests: the surface-specific function source must
 * contain the active-current relation (or the explicit visibility predicate).
 * Dropping either from one surface must fail only that surface's control.
 */
export function assertActiveCurrentSurfaceSourceV1(
  surface: 'anomaly_listing' | 'makeup_anomaly_facts' | 'open_record_attribution' | 'decision_trace',
  source: string,
): void {
  // Accept either the relation literal or the singular constant identifier used in source
  // (function bodies interpolate ATTENDANCE_ACTIVE_CURRENT_RELATION_V1 rather than inlining the string).
  const hasRelation =
    source.includes(ATTENDANCE_ACTIVE_CURRENT_RELATION_V1)
    || source.includes('ATTENDANCE_ACTIVE_CURRENT_RELATION_V1')
  const hasPredicate = source.includes(ATTENDANCE_ACTIVE_CURRENT_VISIBILITY_PREDICATE_V1)
    || source.includes("visibility_state = 'active'")
    || source.includes('visibility_state = "active"')
  if (!hasRelation && !hasPredicate) {
    const error = new Error(`ATTENDANCE_P20_ACTIVE_CURRENT_SURFACE_MISSING:${surface}`)
    ;(error as Error & { code: string }).code = 'ATTENDANCE_P20_ACTIVE_CURRENT_SURFACE_MISSING'
    throw error
  }
}
