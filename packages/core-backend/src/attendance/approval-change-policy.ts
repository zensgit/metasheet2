/**
 * Attendance change-policy reader (D03 / D30 / R3).
 *
 * Tri-state, and never `loadSettings` / `getSettings`: those swallow read failures
 * into defaults and cache them. A query failure rolls the caller's transaction back.
 * A successful read of an invalid enum is business-off. Zero rows are the code
 * defaults below — they do not tighten the separate correction window (D60).
 */

export interface AttendanceChangePhasePolicyV1 {
  readonly beforeEvent: boolean
  readonly afterEvent: boolean
}

export interface AttendanceChangePolicyV1 {
  readonly leave: AttendanceChangePhasePolicyV1
  readonly businessTrip: AttendanceChangePhasePolicyV1
}

export type AttendanceChangePolicyReadV1 =
  | { readonly status: 'ready'; readonly source: 'code_default' | 'row'; readonly policy: AttendanceChangePolicyV1 }
  | { readonly status: 'off'; readonly reason: 'invalid_enum' }
  | { readonly status: 'fault' }

export type AttendanceCorrectionWindowReadV1 =
  | { readonly status: 'not_enforced' }
  | { readonly status: 'ready'; readonly maxDays: number }
  | { readonly status: 'off'; readonly reason: 'invalid_enum' }
  | { readonly status: 'fault' }

type QueryRows = readonly { readonly value?: unknown }[] | { readonly rows?: readonly { readonly value?: unknown }[] }

const CONFIRMATION_MODES = new Set(['sequential', 'concurrent'])

export function attendanceChangePolicyKeyV1(orgId: string): string {
  return `attendance.change_policy:${orgId}`
}

export function attendanceCorrectionWindowKeyV1(orgId: string): string {
  return `attendance.correction_window:${orgId}`
}

/** Leave and business trip may be requested before the event. After-event stays closed until D04/D06 say otherwise. */
export function defaultAttendanceChangePolicyV1(): AttendanceChangePolicyV1 {
  return {
    leave: { beforeEvent: true, afterEvent: false },
    businessTrip: { beforeEvent: true, afterEvent: false },
  }
}

function rowsOf(result: QueryRows | null | undefined): readonly { readonly value?: unknown }[] | null {
  if (result == null) return null
  if (Array.isArray(result)) return result
  const record = result as { rows?: unknown }
  return Array.isArray(record.rows) ? record.rows as readonly { readonly value?: unknown }[] : null
}

function phaseOf(value: unknown): AttendanceChangePhasePolicyV1 | 'invalid' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'invalid'
  const record = value as { beforeEvent?: unknown; afterEvent?: unknown }
  if (typeof record.beforeEvent !== 'boolean' || typeof record.afterEvent !== 'boolean') return 'invalid'
  return { beforeEvent: record.beforeEvent, afterEvent: record.afterEvent }
}

export function interpretAttendanceChangePolicyValueV1(value: unknown): AttendanceChangePolicyReadV1 {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { status: 'off', reason: 'invalid_enum' }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'off', reason: 'invalid_enum' }
  }
  const record = parsed as { leave?: unknown; businessTrip?: unknown; confirmationMode?: unknown }
  if (record.confirmationMode !== undefined && !CONFIRMATION_MODES.has(String(record.confirmationMode))) {
    return { status: 'off', reason: 'invalid_enum' }
  }
  const leave = phaseOf(record.leave)
  const businessTrip = phaseOf(record.businessTrip)
  if (leave === 'invalid' || businessTrip === 'invalid') return { status: 'off', reason: 'invalid_enum' }
  return { status: 'ready', source: 'row', policy: { leave, businessTrip } }
}

export async function readAttendanceChangePolicyV1(
  query: (sql: string, params: readonly unknown[]) => Promise<QueryRows>,
  orgId: string,
): Promise<AttendanceChangePolicyReadV1> {
  let result: QueryRows
  try {
    result = await query('SELECT value FROM system_configs WHERE key = $1', [attendanceChangePolicyKeyV1(orgId)])
  } catch {
    return { status: 'fault' }
  }
  const rows = rowsOf(result)
  if (rows === null) return { status: 'fault' }
  if (rows.length === 0) return { status: 'ready', source: 'code_default', policy: defaultAttendanceChangePolicyV1() }
  if (rows.length !== 1) return { status: 'fault' }
  return interpretAttendanceChangePolicyValueV1(rows[0]?.value)
}

/**
 * D60 reader. Separate from the change-policy reader. Zero rows do not install
 * the 30-day window; that window applies only when a row says so.
 */
export async function readAttendanceCorrectionWindowV1(
  query: (sql: string, params: readonly unknown[]) => Promise<QueryRows>,
  orgId: string,
): Promise<AttendanceCorrectionWindowReadV1> {
  let result: QueryRows
  try {
    result = await query('SELECT value FROM system_configs WHERE key = $1', [attendanceCorrectionWindowKeyV1(orgId)])
  } catch {
    return { status: 'fault' }
  }
  const rows = rowsOf(result)
  if (rows === null) return { status: 'fault' }
  if (rows.length === 0) return { status: 'not_enforced' }
  if (rows.length !== 1) return { status: 'fault' }
  let parsed: unknown = rows[0]?.value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return { status: 'off', reason: 'invalid_enum' }
    }
  }
  const maxDays = typeof parsed === 'object' && parsed !== null
    ? (parsed as { maxDays?: unknown }).maxDays
    : undefined
  if (typeof maxDays !== 'number' || !Number.isInteger(maxDays) || maxDays < 0 || maxDays > 180) {
    return { status: 'off', reason: 'invalid_enum' }
  }
  return { status: 'ready', maxDays }
}
