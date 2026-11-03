import { formatAttendanceClockTime } from './attendanceDateTimePresentation'

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/
const LONG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface RecordReportCellPresentation {
  text: string
  title?: string
}

export function presentRecordInstantClock(value: string, timeZone: string | null): string | null {
  const trimmed = value.trim()
  if (!INSTANT_RE.test(trimmed) || !timeZone) return null
  return formatAttendanceClockTime(trimmed, timeZone)
}

function presentToken(value: string, timeZone: string | null): string {
  const clock = presentRecordInstantClock(value, timeZone)
  if (clock) return clock
  if (LONG_ID_RE.test(value) || (value.length > 28 && !/\s/.test(value))) {
    return `${value.slice(0, 8)}…`
  }
  return value
}

export function presentRecordReportCell(value: string, timeZone: string | null): RecordReportCellPresentation {
  const full = value ?? ''
  if (!full || full === '--') return { text: full }
  const text = full.includes(' / ')
    ? full.split(' / ').map(part => presentToken(part.trim(), timeZone)).filter(part => part && part !== '--').join(' / ') || '--'
    : presentToken(full, timeZone)
  if (text === full) return { text }
  return { text, title: full }
}
