/**
 * Multitable date-time wall clocks — 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074.
 *
 * STORAGE IS UNCHANGED: a `dateTime` value is a UTC instant (ISO-8601 `Z`). This module is the server half of
 * the rule "date-times are DISPLAYED and PARSED in ONE business timezone, never the process's or browser's":
 *
 *   - {@link parseDateTimeText}: text → instant. A string carrying its own zone (`Z`, `±hh:mm`) is absolute
 *     and keeps its meaning. A ZONE-LESS string (`2026-09-24 09:00`, `2026-09-24T09:00:00.000`,
 *     `2026年9月24日 9:30`, full-width digits…) is a wall clock in the given zone. `new Date(text)` would have
 *     read it in the PROCESS zone — the S1 bug: the same import file meant different instants on a UTC
 *     container and on a China laptop.
 *   - {@link formatDateTimeWallClock}: instant → `YYYY-MM-DD HH:mm` (24-hour) in the given zone — the ONE
 *     export/display format, identical to what the web shows, so an export re-imports to the same minute.
 *
 * ONE converter: the local→UTC math is `zonedWallClockToUtcMs` from ./automation-timezone (made exact there,
 * with the documented DST gap/overlap rule) — not a fourth hand-rolled variant.
 *
 * PURE: no env, no logger. Callers resolve the zone (see business-timezone.ts `resolveDateTimeFieldTimeZone`).
 */
import { getZonedParts, utcMsFromParts, zonedWallClockToUtcMs } from './automation-timezone'

export type DateTimeParse =
  | { kind: 'empty' }
  | { kind: 'instant'; ms: number; hasZone: boolean }
  | { kind: 'invalid' }

// Full-width forms people type on a Chinese IME, mapped to the ASCII the grammar below reads.
const FULLWIDTH_DIGITS = '０１２３４５６７８９'

/**
 * Normalise the spellings a person types before parsing: full-width digits and punctuation → ASCII,
 * `2026年9月24日 9:30` / `9时30分` → `2026-9-24 9:30`, runs of whitespace → one space. Pure text rewriting; no
 * date semantics (a normalised string that is still not a date is rejected by the grammar).
 */
export function normalizeDateTimeText(input: unknown): string {
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
  // 年/月/日 date words → ISO-ish separators (the space after 日 is the date/time separator).
  text = text.replace(/^(\d{1,4})年(\d{1,2})月(\d{1,2})日\s*/, '$1-$2-$3 ')
  // 9时30分 / 9点30分 / 9时5分 / 9时30分15秒 → 9:30 / 9:05 / 9:30:15 (minutes and seconds padded to the grammar's two digits)
  text = text.replace(/(\d{1,2})[时點点](\d{1,2})分?(?:(\d{1,2})秒)?$/, (_m, h: string, mi: string, s?: string) =>
    `${h}:${mi.padStart(2, '0')}${s ? `:${s.padStart(2, '0')}` : ''}`)
  return text.replace(/\s+/g, ' ').trim()
}

// Absolute: ISO date + time + explicit zone designator (`Z` or ±hh:mm / ±hhmm). Space or `T` between.
const ABSOLUTE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})$/i

// Wall clock: `YYYY<sep>M<sep>D` with ONE separator (`-`, `/` or `.` — the back-reference rejects a MIXED
// spelling such as 2026-09/24, N7), then optionally a space or `T` and `H:mm[:ss[.fff]]`.
const WALL_CLOCK_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/

// A string that is not in either grammar but still names its zone (RFC 2822 `GMT`, `new Date().toString()`
// output with `GMT+0800`, …) is absolute, so `Date.parse` cannot make it process-zone dependent.
const EXPLICIT_ZONE_MARKER_RE = /(?:\bGMT\b|\bUTC\b|\bZ$|[+-]\d{2}:?\d{2}\b)/i

function daysInMonth(year: number, month: number): number {
  return new Date(utcMsFromParts(year, month + 1, 0)).getUTCDate()
}

export function isValidWallClockParts(p: { year: number; month: number; day: number; hour: number; minute: number; second: number }): boolean {
  return Number.isInteger(p.year) && p.year >= 0 && p.year <= 9999
    && p.month >= 1 && p.month <= 12
    && p.day >= 1 && p.day <= daysInMonth(p.year, p.month)
    && p.hour >= 0 && p.hour <= 23
    && p.minute >= 0 && p.minute <= 59
    && p.second >= 0 && p.second <= 59
}

/**
 * Parse text as a date-time.
 *
 * - blank → `empty`;
 * - explicit zone → `instant` (absolute, `hasZone: true`);
 * - zone-less wall clock → `instant` in `timeZone` (`hasZone: false`). The time part is optional unless
 *   `requireTime` (the interactive editors require it so a bare date never silently means midnight; imports
 *   and the API read a bare date as midnight in the zone);
 * - anything else → `invalid`. Zone-less text outside the grammar is NEVER handed to `Date.parse`.
 */
export function parseDateTimeText(
  input: unknown,
  timeZone: string,
  options?: { requireTime?: boolean },
): DateTimeParse {
  const text = normalizeDateTimeText(input)
  if (!text) return { kind: 'empty' }

  const absolute = ABSOLUTE_RE.exec(text)
  if (absolute) {
    const [, y, mo, d, h, mi, s, frac, zone] = absolute
    const parts = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(s ?? 0) }
    if (!isValidWallClockParts(parts)) return { kind: 'invalid' }
    const millis = frac ? Number(`0.${frac}`) * 1000 : 0
    let offsetMinutes = 0
    if (zone.toUpperCase() !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
    }
    const ms = utcMsFromParts(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) + Math.round(millis) - offsetMinutes * 60_000
    return { kind: 'instant', ms, hasZone: true }
  }

  const wall = WALL_CLOCK_RE.exec(text)
  if (wall) {
    const [, y, , mo, d, h, mi, s] = wall
    if (h === undefined && options?.requireTime) return { kind: 'invalid' }
    const parts = {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h ?? 0),
      minute: Number(mi ?? 0),
      second: Number(s ?? 0),
    }
    if (!isValidWallClockParts(parts)) return { kind: 'invalid' }
    return { kind: 'instant', ms: zonedWallClockToUtcMs(parts, timeZone), hasZone: false }
  }

  if (EXPLICIT_ZONE_MARKER_RE.test(text)) {
    const ms = Date.parse(text)
    if (Number.isFinite(ms)) return { kind: 'instant', ms, hasZone: true }
  }
  return { kind: 'invalid' }
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/** `YYYY-MM-DD HH:mm` (24-hour) of a UTC instant in `timeZone` — the one export/display format. */
export function formatDateTimeWallClock(utcMs: number, timeZone: string): string {
  const p = getZonedParts(utcMs, timeZone)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * UTC epoch-ms of a STORED date-time value (ISO string, epoch number or Date), or `null` when empty /
 * not a date-time. A zone-less stored string is read as a wall clock in `timeZone`.
 */
export function dateTimeValueToUtcMs(value: unknown, timeZone: string): number | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const parsed = parseDateTimeText(value, timeZone)
  return parsed.kind === 'instant' ? parsed.ms : null
}

/** `YYYY-MM-DD HH:mm` of a stored value in `timeZone`, or `null` when it is not a date-time. */
export function formatDateTimeValue(value: unknown, timeZone: string): string | null {
  const ms = dateTimeValueToUtcMs(value, timeZone)
  return ms === null ? null : formatDateTimeWallClock(ms, timeZone)
}

/**
 * Filter comparison key of a date-time: the instant floored to the MINUTE, matching the displayed
 * `HH:mm` — a cell stored as 09:00:30 `is` the filter value 09:00 the user can see. `null` when the value
 * is empty or unparseable.
 */
export function dateTimeMinuteKey(value: unknown, timeZone: string): number | null {
  const ms = dateTimeValueToUtcMs(value, timeZone)
  return ms === null ? null : Math.floor(ms / 60_000)
}
