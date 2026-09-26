function parseInstant(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function normalizeAttendanceTimeZone(timeZone: string | null | undefined): string | null {
  const normalized = String(timeZone ?? '').trim()
  if (!normalized) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format(0)
    return normalized
  } catch {
    return null
  }
}

function dateParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).map(part => [part.type, part.value]))
}

export function formatAttendanceDateKey(
  date: Date,
  timeZone: string | null | undefined,
): string | null {
  const normalized = normalizeAttendanceTimeZone(timeZone)
  if (!normalized) return null
  const parts = dateParts(date, normalized)
  if (parts.year && parts.month && parts.day) {
    return `${parts.year}-${parts.month}-${parts.day}`
  }
  return null
}

const ATTENDANCE_DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Civil-day shift of a YYYY-MM-DD key. Not 24h×N, so a DST boundary cannot skip a work date. */
export function shiftAttendanceDateKey(dateKey: string, deltaDays: number): string | null {
  if (!Number.isInteger(deltaDays)) return null
  const match = ATTENDANCE_DATE_KEY.exec(dateKey.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year
    || utc.getUTCMonth() !== month - 1
    || utc.getUTCDate() !== day
  ) return null
  utc.setUTCDate(utc.getUTCDate() + deltaDays)
  const shiftedYear = String(utc.getUTCFullYear()).padStart(4, '0')
  const shiftedMonth = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const shiftedDay = String(utc.getUTCDate()).padStart(2, '0')
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`
}

/** Lookback used by the manual missed-punch reminder default window. */
export const ATTENDANCE_CIVIL_DATE_LOOKBACK_DAYS = 30

/**
 * Inclusive work-date window in an attendance rule IANA zone.
 * Returns null when the zone is missing or invalid — callers must not substitute UTC.
 */
export function attendanceCivilDateWindow(
  now: Date,
  timeZone: string | null | undefined,
  lookbackDays = ATTENDANCE_CIVIL_DATE_LOOKBACK_DAYS,
): { from: string; to: string } | null {
  if (!Number.isInteger(lookbackDays) || lookbackDays < 0) return null
  const to = formatAttendanceDateKey(now, timeZone)
  if (!to) return null
  const from = shiftAttendanceDateKey(to, -lookbackDays)
  if (!from) return null
  return { from, to }
}

export function formatAttendanceClockTime(
  value: string | Date | null | undefined,
  timeZone: string | null | undefined,
  includeSeconds = false,
): string | null {
  const date = parseInstant(value)
  if (!date) return null
  const normalized = normalizeAttendanceTimeZone(timeZone)
  if (!normalized) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: normalized,
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]))
  if (parts.hour && parts.minute) {
    return includeSeconds && parts.second
      ? `${parts.hour}:${parts.minute}:${parts.second}`
      : `${parts.hour}:${parts.minute}`
  }
  return null
}

export function formatAttendanceDateTime(
  value: string | null | undefined,
  locale: string,
  timeZone: string | null | undefined,
): string {
  const date = parseInstant(value)
  if (!date) return '--'
  const normalized = normalizeAttendanceTimeZone(timeZone)
  return normalized ? date.toLocaleString(locale, { timeZone: normalized }) : '--'
}

export function formatAttendanceWeekday(
  date: Date,
  locale: string,
  timeZone: string | null | undefined,
): string | null {
  const normalized = normalizeAttendanceTimeZone(timeZone)
  return normalized
    ? new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: normalized }).format(date)
    : null
}
