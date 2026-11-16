/**
 * Quiet hours: a daily window in a person's time zone during which a reminder that falls due is
 * suppressed and recorded, not delayed. Pure functions; no clock is read.
 *
 * Whether an instant is inside the window depends only on the local clock time at that instant, so
 * daylight-saving gaps and overlaps need no special handling.
 */
import { isValidIanaTimeZone } from '../multitable/automation-timezone'

export interface QuietHours {
  /** 'HH:mm', local, inclusive. */
  readonly start: string
  /** 'HH:mm', local, exclusive. A start later than the end means the window crosses midnight. */
  readonly end: string
  readonly timeZone: string
}

export type QuietHoursField = 'start' | 'end' | 'timeZone' | 'window'

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/
/** The shape the stored time zone column accepts. */
const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+/-]{1,64}$/

export function parseClockMinutes(text: unknown): number | null {
  if (typeof text !== 'string') return null
  const match = CLOCK.exec(text)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

export function isStorableTimeZone(timeZone: unknown): timeZone is string {
  return typeof timeZone === 'string' && TIME_ZONE_SHAPE.test(timeZone) && isValidIanaTimeZone(timeZone)
}

/** The first invalid field of a quiet-hours value, or null when it is valid. */
export function quietHoursProblem(value: { start: unknown; end: unknown; timeZone: unknown }): QuietHoursField | null {
  const start = parseClockMinutes(value.start)
  const end = parseClockMinutes(value.end)
  if (start === null) return 'start'
  if (end === null) return 'end'
  if (!isStorableTimeZone(value.timeZone)) return 'timeZone'
  if (start === end) return 'window'
  return null
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function localMinutes(instant: number, timeZone: string): number {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    formatters.set(timeZone, formatter)
  }
  let hour = 0
  let minute = 0
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'hour') hour = Number(part.value) % 24
    else if (part.type === 'minute') minute = Number(part.value)
  }
  return hour * 60 + minute
}

/** Throws RangeError for an invalid window; the callers validate before storing. */
export function isWithinQuietHours(instant: Date | number, quiet: QuietHours): boolean {
  const problem = quietHoursProblem(quiet)
  if (problem !== null) throw new RangeError(`invalid quiet hours: ${problem}`)
  const start = parseClockMinutes(quiet.start) as number
  const end = parseClockMinutes(quiet.end) as number
  const at = localMinutes(typeof instant === 'number' ? instant : instant.getTime(), quiet.timeZone)
  return start < end ? at >= start && at < end : at >= start || at < end
}
