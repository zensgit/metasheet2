/**
 * Policy for AuthService attendance self-service role backfill.
 *
 * Eligible never-revoked users (no attendance admission row) still bootstrap
 * `attendance_employee`. An explicit disabled attendance admission, including
 * `source = role_unassigned` from unassign, or an unread/unavailable admission
 * row, must skip assignment and must not merge attendance permissions.
 * Missing is meaningful only while holding the shared subject transaction lock:
 * unassign persists a role_unassigned witness even if there was no admission row.
 */

export const ATTENDANCE_SELF_SERVICE_NAMESPACE = 'attendance'
export const ROLE_UNASSIGNED_ADMISSION_SOURCE = 'role_unassigned'

export type AttendanceSelfServiceAdmissionRead = {
  found: boolean
  enabled?: boolean
  source?: string | null
  unavailable?: boolean
}

export type AttendanceSelfServiceBackfillDecision = 'bootstrap' | 'skip'

export function parseAttendanceSelfServiceAdmissionRows(
  rows: readonly unknown[],
): AttendanceSelfServiceAdmissionRead {
  const row = rows[0]
  if (!row || typeof row !== 'object') return { found: false }
  const record = row as { enabled?: unknown; source?: unknown }
  return {
    found: true,
    enabled: record.enabled === true,
    source: typeof record.source === 'string' ? record.source : null,
  }
}

export function unavailableAttendanceSelfServiceAdmission(): AttendanceSelfServiceAdmissionRead {
  return { found: false, unavailable: true }
}

export function decideAttendanceSelfServiceBackfill(input: {
  supportsProductMode: boolean
  role: string
  permissions: readonly string[]
  admission: AttendanceSelfServiceAdmissionRead
}): AttendanceSelfServiceBackfillDecision {
  if (!input.supportsProductMode) return 'skip'
  if (input.role === 'admin') return 'skip'
  if (input.permissions.some((permission) => permission.startsWith('attendance:'))) return 'skip'
  if (input.admission.unavailable) return 'skip'
  if (
    input.admission.found
    && (input.admission.enabled === false || input.admission.source === ROLE_UNASSIGNED_ADMISSION_SOURCE)
  ) {
    return 'skip'
  }
  return 'bootstrap'
}
