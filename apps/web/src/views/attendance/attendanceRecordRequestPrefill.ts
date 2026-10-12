import { parseDateTimeTextToUtcMs, wallClockInZone } from '../../multitable/utils/business-timezone'
import { normalizeAttendanceTimeZone } from './attendanceDateTimePresentation'

export const ATTENDANCE_RECORD_REQUEST_PREFILL_KEY = 'attendanceRecordRequestPrefill'

export interface AttendanceRecordRequestPrefill {
  principalKey: string
  orgId: string
  workDate: string
  requestType: 'time_correction' | 'missed_check_in' | 'missed_check_out'
  /** Original absolute instants, including their seconds and milliseconds. */
  requestedInAt: string
  requestedOutAt: string
  inTimeZone: string
  outTimeZone: string
}

const ABSOLUTE = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i
const WALL = /^((?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
const pad = (value: number, width = 2) => String(value).padStart(width, '0')

/** Display only in the historical event/record zone; never a browser-zone fallback. */
export function formatRecordRequestTime(instant: string, timeZone: string): string {
  if (!instant) return ''
  const ms = Date.parse(instant)
  const clock = wallClockInZone(ms, timeZone)
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}.${pad(new Date(ms).getUTCMilliseconds(), 3)}`
}

/** Unedited values retain the exact source; edits use the displayed IANA zone. */
export function resolveRecordRequestTime(value: string, original: string, timeZone: string): string | null {
  if (!value) return ''
  const match = WALL.exec(value)
  if (!match || !normalizeAttendanceTimeZone(timeZone)) return null
  const canonical = `${match[1]}:${match[2] ?? '00'}.${(match[3] ?? '').padEnd(3, '0')}`
  if (original && canonical === formatRecordRequestTime(original, timeZone)) return original
  const base = parseDateTimeTextToUtcMs(`${match[1]}:${match[2] ?? '00'}`, timeZone, { requireTime: true })
  if (base === null) return null
  const instant = new Date(base + Number((match[3] ?? '').padEnd(3, '0'))).toISOString()
  // The shared parser chooses the earlier overlap occurrence. Gaps must not silently shift.
  return formatRecordRequestTime(instant, timeZone) === canonical ? instant : null
}

/** History state is untrusted and must belong to the current actor and organization. */
export function readAttendanceRecordRequestPrefill(
  value: unknown,
  principalKey: string | null,
  orgId: string,
): AttendanceRecordRequestPrefill | null {
  // The principal helper's opaque-token fallback must never be copied into browser history.
  if (!principalKey || principalKey.startsWith('token:') || !value || typeof value !== 'object') return null
  const draft = value as Record<string, unknown>
  if (draft.principalKey !== principalKey || draft.orgId !== orgId) return null
  if (typeof draft.workDate !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(draft.workDate)) return null
  const workDate = new Date(`${draft.workDate}T00:00:00Z`)
  if (!Number.isFinite(workDate.getTime()) || workDate.toISOString().slice(0, 10) !== draft.workDate) return null
  if (typeof draft.requestType !== 'string' || !['time_correction', 'missed_check_in', 'missed_check_out'].includes(draft.requestType)) return null
  const inTimeZone = normalizeAttendanceTimeZone(typeof draft.inTimeZone === 'string' ? draft.inTimeZone : null)
  const outTimeZone = normalizeAttendanceTimeZone(typeof draft.outTimeZone === 'string' ? draft.outTimeZone : null)
  if (!inTimeZone || !outTimeZone) return null
  for (const value of [draft.requestedInAt, draft.requestedOutAt]) {
    if (typeof value !== 'string' || (value !== '' && (!ABSOLUTE.test(value) || !Number.isFinite(Date.parse(value)) || parseDateTimeTextToUtcMs(value, 'UTC') === null))) return null
  }
  return {
    principalKey, orgId, workDate: draft.workDate,
    requestType: draft.requestType as AttendanceRecordRequestPrefill['requestType'],
    requestedInAt: draft.requestedInAt as string,
    requestedOutAt: draft.requestedOutAt as string,
    inTimeZone, outTimeZone,
  }
}
