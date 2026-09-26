/**
 * Multitable business timezone — 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074.
 *
 * STORAGE IS UNCHANGED: a `dateTime` / `createdTime` / `modifiedTime` value is a UTC instant (ISO-8601
 * with `Z`). What this module changes is how the web turns that instant into a wall clock and back:
 *
 *   - DISPLAY and PARSING both use ONE business timezone, never the browser's local zone. A Beijing user
 *     who types 09:00 stores 01:00Z and sees 09:00 again; a colleague whose laptop is set to New York sees
 *     the SAME 09:00 (with a small 北京时间 hint), not 21:00 of the previous day.
 *   - The zone is: an explicit non-UTC `field.property.timezone` → else the server-provided instance
 *     business timezone (`MULTITABLE_BUSINESS_TIMEZONE`, echoed as `businessTimezone` on the multitable
 *     context / form-context responses) → else {@link DEFAULT_BUSINESS_TIMEZONE}.
 *   - The format is fixed `YYYY-MM-DD HH:mm`, 24-hour, built from `formatToParts` so neither the browser
 *     locale (12h `AM/PM` under en-US) nor the OS clock setting can change it.
 *
 * Date-only `date` fields (floating calendar day, #3417) never pass through here.
 *
 * Pure except for the one reactive holder of the server-provided zone; no dependency beyond `Intl`.
 */
import { ref } from 'vue'
import { formatUtcOffset, getTimezoneOffsetMinutes } from '../../utils/timezones'

/** Owner ruling (PR #6074): the business timezone when neither the field nor the server names one. */
export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai'

/** IANA ids whose wall clock is China Standard Time — labelled 北京时间 in the zone hint. */
const BEIJING_TIME_ZONES: ReadonlySet<string> = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Chungking',
  'Asia/Harbin',
  'PRC',
])

/** True iff `value` is a timezone the platform `Intl` accepts. Never throws. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

// Reactive so every computed / render that formats a dateTime re-evaluates when the server's value
// arrives after first paint (the context response lands after the grid shell mounts).
const businessTimezoneState = ref<string>(DEFAULT_BUSINESS_TIMEZONE)

/** The instance business timezone currently in force (server-provided, else the default). */
export function getBusinessTimezone(): string {
  return businessTimezoneState.value
}

/**
 * Adopt the server-provided business timezone. Only a valid zone is accepted; anything else (an older
 * server that does not send the key, junk) is ignored so the last good value — initially the default —
 * stays. Returns whether the value was adopted.
 */
export function setBusinessTimezone(value: unknown): boolean {
  if (!isValidTimeZone(value)) return false
  businessTimezoneState.value = value.trim()
  return true
}

/** Restore the default (tests). */
export function resetBusinessTimezone(): void {
  businessTimezoneState.value = DEFAULT_BUSINESS_TIMEZONE
}

/**
 * The zone a `dateTime` field is displayed AND edited in.
 *
 * `property.timezone` wins only when it names a valid zone OTHER THAN the literal `'UTC'`. `'UTC'` is not
 * a choice anybody made: the backend's property sanitizer (core-backend `multitable/field-codecs.ts`,
 * dateTime branch) stamps `timezone: 'UTC'` onto every dateTime field that arrives without one — at field
 * create AND on every serialize — and no UI has ever offered a zone picker. So a stored `'UTC'` is the
 * legacy "unset" marker and resolves to the business timezone like an absent one. (An integrator who
 * really wants UTC wall clocks can write `'Etc/UTC'`.)
 */
export function resolveDateTimeTimezone(property?: Record<string, unknown> | null): string {
  const raw = typeof property?.timezone === 'string' ? property.timezone.trim() : ''
  if (raw && raw !== 'UTC' && isValidTimeZone(raw)) return raw
  return getBusinessTimezone()
}

export interface WallClock {
  year: number
  /** 1-12 */
  month: number
  /** 1-31 */
  day: number
  /** 0-23 */
  hour: number
  minute: number
  second: number
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23, not hour12:false — some engines render midnight as "24" under hour12:false.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsFormatterCache.set(timeZone, formatter)
  }
  return formatter
}

/** Wall clock of a UTC instant in `timeZone`. Exact (UTC → local is unambiguous). */
export function wallClockInZone(utcMs: number, timeZone: string): WallClock {
  const clock: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of partsFormatter(timeZone).formatToParts(utcMs)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day'
      || part.type === 'hour' || part.type === 'minute' || part.type === 'second') {
      clock[part.type] = Number(part.value)
    }
  }
  if (clock.hour === 24) clock.hour = 0
  return clock
}

/**
 * UTC instant of a wall clock in `timeZone` (the hard local → UTC direction). Guess + two-step offset
 * correction: exact everywhere except a DST spring-forward gap (a wall clock that does not exist lands on
 * the post-transition instant). Asia/Shanghai has no DST, so the default zone is exact for every input.
 */
export function wallClockToUtcMs(clock: Omit<WallClock, 'second'> & { second?: number }, timeZone: string): number {
  const guess = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second ?? 0)
  const firstOffset = getTimezoneOffsetMinutes(timeZone, new Date(guess))
  let utcMs = guess - firstOffset * 60_000
  const secondOffset = getTimezoneOffsetMinutes(timeZone, new Date(utcMs))
  if (secondOffset !== firstOffset) utcMs = guess - secondOffset * 60_000
  return utcMs
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `YYYY-MM-DD HH:mm` (24-hour) — the ONE display/edit format for date-times. */
export function formatWallClock(clock: WallClock): string {
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`
}

// A zone-less ISO-ish string (no `Z`, no ±hh:mm). `new Date()` would read it in the BROWSER's zone; we
// read it as a business wall clock instead, so display never depends on where the browser is.
const ZONELESS_DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/

/** UTC epoch-ms of a stored date-time value, or `null` when it is empty / not a date-time. */
export function dateTimeValueToUtcMs(value: unknown, timeZone: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  const zoneless = ZONELESS_DATE_TIME_RE.exec(text)
  if (zoneless) {
    const [, y, mo, d, h, mi, s] = zoneless
    const clock = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) }
    return isValidWallClock(clock) ? wallClockToUtcMs(clock, timeZone) : null
  }
  const ms = new Date(text).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** `YYYY-MM-DD HH:mm` of a stored value in `timeZone`, or `null` when the value is not a date-time. */
export function formatDateTimeInZone(value: unknown, timeZone: string): string | null {
  const ms = dateTimeValueToUtcMs(value, timeZone)
  return ms === null ? null : formatWallClock(wallClockInZone(ms, timeZone))
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isValidWallClock(clock: WallClock): boolean {
  return clock.month >= 1 && clock.month <= 12
    && clock.day >= 1 && clock.day <= daysInMonth(clock.year, clock.month)
    && clock.hour >= 0 && clock.hour <= 23
    && clock.minute >= 0 && clock.minute <= 59
    && clock.second >= 0 && clock.second <= 59
}

// What the editor accepts: `YYYY-MM-DD HH:mm` (the canonical form it shows), plus the spellings a person
// actually types — `/` or `.` date separators, one-digit month/day/hour, a `T` instead of the space, and
// optional seconds. The time is REQUIRED: a bare date is rejected rather than silently meaning midnight.
const DATE_TIME_INPUT_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?$/

export type DateTimeInputParse =
  | { ok: true; value: string | null }
  | { ok: false }

/**
 * Parse editor text as a wall clock in `timeZone`. Empty → `{ ok: true, value: null }` (clear the cell);
 * a valid wall clock → `{ ok: true, value: <UTC ISO> }`; anything else → `{ ok: false }` (keep typing —
 * the caller must NOT turn an unparseable draft into a clear).
 */
export function parseDateTimeInput(text: string, timeZone: string): DateTimeInputParse {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { ok: true, value: null }
  const match = DATE_TIME_INPUT_RE.exec(trimmed)
  if (!match) return { ok: false }
  const [, y, mo, d, h, mi, s] = match
  const clock: WallClock = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s ?? 0),
  }
  if (!isValidWallClock(clock)) return { ok: false }
  return { ok: true, value: new Date(wallClockToUtcMs(clock, timeZone)).toISOString() }
}

/** Offset (minutes east of UTC) the BROWSER is at, at `at`. */
function browserOffsetMinutes(at: Date): number {
  return -at.getTimezoneOffset()
}

/**
 * Whether a person looking at this browser would read a different wall clock than the business zone
 * shows — i.e. whether the zone hint is needed. Compared by UTC offset at `at`, not by id: a browser in
 * Asia/Singapore reads the same clock as Asia/Shanghai and needs no hint.
 */
export function browserTimezoneDiffers(timeZone: string, at: Date = new Date()): boolean {
  if (!isValidTimeZone(timeZone)) return false
  return browserOffsetMinutes(at) !== getTimezoneOffsetMinutes(timeZone, at)
}

/** Human label of a business zone: 北京时间 / Beijing time, else `<id> (UTC±hh:mm)`. */
export function businessTimezoneLabel(timeZone: string, isZh: boolean, at: Date = new Date()): string {
  if (BEIJING_TIME_ZONES.has(timeZone)) return isZh ? '北京时间' : 'Beijing time'
  if (!isValidTimeZone(timeZone)) return timeZone
  return `${timeZone} (${formatUtcOffset(getTimezoneOffsetMinutes(timeZone, at))})`
}

/** The zone hint to show next to a date-time editor: '' when the browser already reads that clock. */
export function dateTimeZoneHint(timeZone: string, isZh: boolean, at: Date = new Date()): string {
  return browserTimezoneDiffers(timeZone, at) ? businessTimezoneLabel(timeZone, isZh, at) : ''
}
