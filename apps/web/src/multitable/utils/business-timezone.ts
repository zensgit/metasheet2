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
 * The server applies the same rule to zone-less text it receives (core-backend `multitable/date-time-wall-clock.ts`
 * + `business-timezone.ts`), so grid paste, import, prefill and REST agree with what this module shows.
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
 * a choice anybody made: the backend's property sanitizer (core-backend `multitable/field-codecs.ts`
 * `sanitizeFieldProperty`, dateTime branch) stamps `timezone: 'UTC'` onto every zone-less dateTime property
 * whenever fields are READ through the shared loader (`loaders.ts` loadFieldsForSheet → `serializeFieldRow`,
 * field-codecs.ts) — the field-create route does not write it — and no UI has ever offered a zone picker.
 * So a stored `'UTC'` is the legacy "unset" marker and resolves to the business timezone like an absent
 * one. (An integrator who really wants UTC wall clocks can write `'Etc/UTC'`.)
 *
 * CONTRAST (S4, do not unify): an automation rule's `triggerConfig.timezone === 'UTC'` means REAL UTC —
 * legacy rules were scheduled in UTC and must keep firing at the same instants (automation-trigger-timezone
 * helpers). The two `'UTC'`s carry different meanings on purpose.
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

/**
 * `Date.UTC` that keeps years 0000–0099 as themselves (N3). `Date.UTC(99, …)` means 1999 — a legacy
 * two-digit rule — which would silently move a `0099-…` instant by 1900 years through a wall-clock round
 * trip. `setUTCFullYear` has no such rule.
 */
export function utcMsFromWallClock(clock: Omit<WallClock, 'second'> & { second?: number }): number {
  const d = new Date(0)
  d.setUTCFullYear(clock.year, clock.month - 1, clock.day)
  d.setUTCHours(clock.hour, clock.minute, clock.second ?? 0, 0)
  return d.getTime()
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

/** Offset (minutes east of UTC) of `timeZone` at a UTC instant — year-0099-safe, unlike Date.UTC-based probes. */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  return (utcMsFromWallClock(wallClockInZone(utcMs, timeZone)) - utcMs) / 60_000
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * UTC instant of a wall clock in `timeZone` (the hard local → UTC direction). EXACT: tries every offset the
 * zone has within a day of the guess and keeps the candidate whose instant really maps back to that offset.
 * Asia/Shanghai has no DST, so it has exactly one candidate and is exact for every input.
 *
 * DST rule (N1 — documented, tested, and the SAME rule as core-backend `automation-timezone.ts`):
 *   - a wall clock that does not exist (spring-forward GAP, e.g. America/New_York 2026-03-08 02:30) →
 *     the POST-transition instant: the later candidate, i.e. the clock read with the pre-transition
 *     offset (02:30 EST = 07:30Z, which displays as 03:30 EDT);
 *   - a wall clock that exists twice (fall-back OVERLAP, e.g. 2026-11-01 01:30) → the EARLIER instant
 *     (01:30 EDT = 05:30Z).
 */
export function wallClockToUtcMs(clock: Omit<WallClock, 'second'> & { second?: number }, timeZone: string): number {
  const guess = utcMsFromWallClock(clock)
  const offsets = new Set<number>([
    zoneOffsetMinutes(guess - ONE_DAY_MS, timeZone),
    zoneOffsetMinutes(guess, timeZone),
    zoneOffsetMinutes(guess + ONE_DAY_MS, timeZone),
  ])
  const candidates: number[] = []
  const consistent: number[] = []
  for (const offset of offsets) {
    const utcMs = guess - offset * 60_000
    candidates.push(utcMs)
    if (zoneOffsetMinutes(utcMs, timeZone) === offset) consistent.push(utcMs)
  }
  if (consistent.length === 1) return consistent[0]
  if (consistent.length > 1) return Math.min(...consistent) // overlap → earlier instant
  return Math.max(...candidates) // gap → post-transition instant
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `YYYY-MM-DD HH:mm` (24-hour) — the ONE display/edit format for date-times. */
export function formatWallClock(clock: WallClock): string {
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`
}

// ---------------------------------------------------------------------------------------------------------
// Text → instant (B2). The grammar is shared with the server (core-backend `date-time-wall-clock.ts`) so a
// string the editor accepts is a string the import / paste / REST path accepts, and vice versa.
// ---------------------------------------------------------------------------------------------------------

// Full-width forms people type on a Chinese IME, mapped to the ASCII the grammar reads.
const FULLWIDTH_DIGITS = '０１２３４５６７８９'

/**
 * Normalise the spellings a person types before parsing: full-width digits and punctuation → ASCII,
 * `2026年9月24日 9:30` / `9时30分` → `2026-9-24 9:30`, runs of whitespace → one space. Pure text rewriting; no
 * date semantics (a normalised string that is still not a date is rejected by the grammar).
 */
export function normalizeDateTimeInput(input: unknown): string {
  let text = String(input ?? '').trim()
  if (!text) return ''
  text = text.replace(/[０-９]/g, (ch) => String(FULLWIDTH_DIGITS.indexOf(ch)))
  // Full-width colon / hyphen / slash / dot. (The full-width IDEOGRAPHIC SPACE U+3000 is Unicode
  // whitespace, so the final `\s+` collapse below already folds it to one ASCII space.)
  text = text
    .replace(/：/g, ':')
    .replace(/－/g, '-')
    .replace(/／/g, '/')
    .replace(/．/g, '.')
  text = text.replace(/^(\d{1,4})年(\d{1,2})月(\d{1,2})日\s*/, '$1-$2-$3 ')
  text = text.replace(/(\d{1,2})[时點点](\d{1,2})分?(?:(\d{1,2})秒)?$/, (_m, h: string, mi: string, s?: string) =>
    `${h}:${mi.padStart(2, '0')}${s ? `:${s.padStart(2, '0')}` : ''}`)
  return text.replace(/\s+/g, ' ').trim()
}

// Absolute: ISO date + time + explicit zone designator (`Z` or ±hh:mm / ±hhmm). Space or `T` between. Such a
// string names its own instant and is NOT re-read as a business wall clock.
const ABSOLUTE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i

// Wall clock: `YYYY<sep>M<sep>D` with ONE separator (`-`, `/` or `.` — the back-reference rejects a MIXED
// spelling such as 2026-09/24, N7), then optionally a space or `T` and `H:mm[:ss[.fff]]`.
const WALL_CLOCK_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/

// Outside both grammars but naming its zone (RFC 2822 `GMT`, `Date#toString` output): absolute, so
// `Date.parse` cannot make it browser-zone dependent.
const EXPLICIT_ZONE_MARKER_RE = /(?:\bGMT\b|\bUTC\b|\bZ$|[+-]\d{2}:?\d{2}\b)/i

function daysInMonth(year: number, month: number): number {
  return new Date(utcMsFromWallClock({ year, month: month + 1, day: 0, hour: 0, minute: 0 })).getUTCDate()
}

function isValidWallClock(clock: WallClock): boolean {
  return Number.isInteger(clock.year) && clock.year >= 0 && clock.year <= 9999
    && clock.month >= 1 && clock.month <= 12
    && clock.day >= 1 && clock.day <= daysInMonth(clock.year, clock.month)
    && clock.hour >= 0 && clock.hour <= 23
    && clock.minute >= 0 && clock.minute <= 59
    && clock.second >= 0 && clock.second <= 59
}

/**
 * UTC epoch-ms of date-time TEXT, or `null` when it is not one. Absolute strings keep their instant; a
 * zone-less wall clock is read in `timeZone`. With `requireTime` a bare date is `null` (the interactive
 * editors require the time so a bare date never silently means midnight); without it a bare date is
 * midnight in the zone (stored / prefilled / imported values).
 */
export function parseDateTimeTextToUtcMs(text: unknown, timeZone: string, options?: { requireTime?: boolean }): number | null {
  const normalized = normalizeDateTimeInput(text)
  if (!normalized) return null

  const absolute = ABSOLUTE_RE.exec(normalized)
  if (absolute) {
    const [, y, mo, d, h, mi, s, frac, zone] = absolute
    const clock: WallClock = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) }
    if (!isValidWallClock(clock)) return null
    const millis = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
    let offsetMinutes = 0
    if (zone.toUpperCase() !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
    }
    return utcMsFromWallClock(clock) + millis - offsetMinutes * 60_000
  }

  const wall = WALL_CLOCK_RE.exec(normalized)
  if (wall) {
    const [, y, , mo, d, h, mi, s] = wall
    if (h === undefined && options?.requireTime) return null
    const clock: WallClock = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h ?? 0), minute: Number(mi ?? 0), second: Number(s ?? 0) }
    if (!isValidWallClock(clock)) return null
    return wallClockToUtcMs(clock, timeZone)
  }

  if (EXPLICIT_ZONE_MARKER_RE.test(normalized)) {
    const ms = Date.parse(normalized)
    if (Number.isFinite(ms)) return ms
  }
  return null
}

// A calendar day (date-only `date` field, #3417 floating day): `YYYY<sep>M<sep>D` with ONE separator, an
// optional trailing time part that is IGNORED (the day is the day as written).
const CALENDAR_DAY_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ].*)?$/

/**
 * The calendar day named by import text for a date-only field — `YYYY-MM-DD`, or `null` when the text
 * names no day. NO timezone math (PR #6083 review item 2): the previous
 * `new Date(text).toISOString().split('T')[0]` turned a locally-parsed `9/24/26` into UTC midnight-shifted
 * text, i.e. the PREVIOUS day on any UTC+ browser. Rules, in order:
 *   1. the ISO-ish grammar (also 年月日, full-width, `/` `.`) → the day as written;
 *   2. text that names its own zone (`Z`, `±hh:mm`, `GMT`) → the UTC calendar day of that instant;
 *   3. anything else `Date.parse` accepts (`9/24/26`, `Sep 24 2026`) → its LOCAL calendar components, which
 *      are the day as written for a zone-less spelling regardless of where the browser is.
 */
export function calendarDayFromText(input: unknown): string | null {
  const text = normalizeDateTimeInput(input)
  if (!text) return null
  const match = CALENDAR_DAY_RE.exec(text)
  if (match) {
    const [, y, , mo, d] = match
    const clock: WallClock = { year: Number(y), month: Number(mo), day: Number(d), hour: 0, minute: 0, second: 0 }
    if (!isValidWallClock(clock)) return null
    return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`
  }
  // An ISO-like shape that failed the grammar (mixed separators `2026-09/24`, impossible day) is refused
  // outright (N7) — V8's lenient legacy parser would otherwise accept it below.
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]|$)/.test(text)) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return null
  const date = new Date(ms)
  if (EXPLICIT_ZONE_MARKER_RE.test(text)) {
    return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  }
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** UTC epoch-ms of a stored date-time value, or `null` when it is empty / not a date-time. */
export function dateTimeValueToUtcMs(value: unknown, timeZone: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  // A zone-less stored string (legacy / prefill) is a business wall clock, never a browser-zone read.
  return parseDateTimeTextToUtcMs(value, timeZone)
}

/** `YYYY-MM-DD HH:mm` of a stored value in `timeZone`, or `null` when the value is not a date-time. */
export function formatDateTimeInZone(value: unknown, timeZone: string): string | null {
  const ms = dateTimeValueToUtcMs(value, timeZone)
  return ms === null ? null : formatWallClock(wallClockInZone(ms, timeZone))
}

export type DateTimeInputParse =
  | { ok: true; value: string | null }
  | { ok: false }

/**
 * Parse editor text as a wall clock in `timeZone`. Empty → `{ ok: true, value: null }` (clear the cell);
 * a valid date-time → `{ ok: true, value: <UTC ISO> }`; anything else → `{ ok: false }` (keep typing —
 * the caller must NOT turn an unparseable draft into a clear, and must not drop it silently either: see
 * MetaDateTimeInput.vue's invalid-draft contract).
 *
 * Accepted: `YYYY-MM-DD HH:mm` (the canonical form), `/` or `.` date separators, one-digit month/day/hour,
 * `T`, optional seconds / millis, full-width digits / colon, `2026年9月24日 9:30`, and an ISO string with
 * `Z` / `±hh:mm` (absolute). The time is REQUIRED: a bare date is rejected rather than silently meaning
 * midnight. Mixed separators (`2026-09/24`) and impossible dates are rejected.
 */
export function parseDateTimeInput(text: string, timeZone: string): DateTimeInputParse {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { ok: true, value: null }
  const ms = parseDateTimeTextToUtcMs(trimmed, timeZone, { requireTime: true })
  if (ms === null) return { ok: false }
  return { ok: true, value: new Date(ms).toISOString() }
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

// ---------------------------------------------------------------------------------------------------------
// Picker bridge (S3). Element Plus's date-time panel works in the BROWSER's local time: it hands out / takes
// a `Date` whose LOCAL components are what the person sees. We never want the browser zone to mean
// anything, so the bridge is: business wall clock ⇄ a Date whose local components equal that wall clock.
// ---------------------------------------------------------------------------------------------------------

/**
 * A `Date` whose LOCAL components equal the business wall clock of `value` in `timeZone` (what the picker
 * should highlight), or `null` when `value` is not a date-time. Not an instant — do not store it.
 * (Caveat: if that wall clock falls into the BROWSER's own DST gap, the browser normalises it forward by
 * an hour — one wall-clock hour per year on a DST laptop, only for the picker's initial highlight.)
 */
export function pickerDateForValue(value: unknown, timeZone: string): Date | null {
  const ms = dateTimeValueToUtcMs(value, timeZone)
  if (ms === null) return null
  const c = wallClockInZone(ms, timeZone)
  return new Date(c.year, c.month - 1, c.day, c.hour, c.minute, 0, 0)
}

/** The stored UTC ISO of what the picker returned: its LOCAL components read as a wall clock in `timeZone`. */
export function valueForPickerDate(picked: Date | null | undefined, timeZone: string): string | null {
  if (!picked || Number.isNaN(picked.getTime())) return null
  const clock: WallClock = {
    year: picked.getFullYear(),
    month: picked.getMonth() + 1,
    day: picked.getDate(),
    hour: picked.getHours(),
    minute: picked.getMinutes(),
    second: 0,
  }
  return new Date(wallClockToUtcMs(clock, timeZone)).toISOString()
}
