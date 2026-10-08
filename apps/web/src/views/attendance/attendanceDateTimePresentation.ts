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
