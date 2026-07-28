/**
 * W4C-1 (#4556) — strict timezone conversion (lock section 5.1, W4C-R3/R33).
 *
 * Pure module: no DB, no routes, no Date.now — every instant is derived from
 * caller-supplied values. This is the ONE strict time contract every business
 * time admitted as W4 evidence must pass:
 *
 * - `parseAttendanceInstantMsV1` accepts only an explicit-offset RFC 3339
 *   profile (`YYYY-MM-DDTHH:MM:SS(.sss)?(Z|±HH:MM)`). Offset-less values that
 *   would otherwise use server-local time, whitespace, lowercase designators,
 *   and calendar-invalid dates all fail closed. There is no UTC fallback.
 * - `validateAttendanceIanaTimezoneV1` accepts only IANA zone identifiers the
 *   host tz database resolves (offset "zones" such as `+05:00` are rejected).
 *   It is the same strict validator the later slices use for default-rule and
 *   shift timezone writes.
 * - `resolveAttendanceLocalWallTimeV1` enumerates the UTC instants that
 *   round-trip to a frozen local date/time/timezone (lock 5.1 steps 1-7):
 *   zero matches -> `gap` (DST spring-forward), one -> `unique`, two ->
 *   `fold` with the earlier/later instants and their frozen offsets, invalid
 *   zone or more than two matches -> `invalid`. No caller catches a failure
 *   and retries in UTC.
 *
 * Values-free error discipline: closed `code` strings only.
 */

export class AttendanceW4TimeError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4TimeError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4TimeError(code)
}

// ---------------------------------------------------------------------------
// Strict instant parsing (explicit offset required; no server-local fallback).
// ---------------------------------------------------------------------------

const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/

function isCalendarValidUtc(year: number, month: number, day: number): boolean {
  const ms = Date.UTC(year, month - 1, day)
  const d = new Date(ms)
  return (
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
  )
}

/**
 * Strict explicit-offset instant parser. Returns epoch milliseconds.
 * Rejects (closed code `W4C1_INSTANT_INVALID`): non-strings, whitespace,
 * offset-less values, lowercase `t`/`z`, missing seconds, out-of-range
 * time/offset fields, and calendar-invalid dates.
 */
export function parseAttendanceInstantMsV1(value: unknown): number {
  const code = 'W4C1_INSTANT_INVALID'
  if (typeof value !== 'string') fail(code)
  const match = INSTANT_RE.exec(value)
  if (!match) fail(code)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || day > 31) fail(code)
  if (hour > 23 || minute > 59 || second > 59) fail(code)
  if (!isCalendarValidUtc(year, month, day)) fail(code)
  const fraction = match[7] ? Number(match[7]) : 0
  const millis = Math.round(fraction * 1000)
  let offsetMinutes = 0
  const offsetToken = match[8]
  if (offsetToken !== 'Z') {
    const sign = offsetToken.startsWith('-') ? -1 : 1
    const offHour = Number(offsetToken.slice(1, 3))
    const offMin = Number(offsetToken.slice(4, 6))
    if (offHour > 14 || offMin > 59) fail(code)
    offsetMinutes = sign * (offHour * 60 + offMin)
    if (Math.abs(offsetMinutes) > 14 * 60) fail(code)
  }
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millis)
  return wallAsUtc - offsetMinutes * 60_000
}

// ---------------------------------------------------------------------------
// Strict IANA zone validation.
// ---------------------------------------------------------------------------

const zoneFormatterCache = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatterCache.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    zoneFormatterCache.set(zone, formatter)
  }
  return formatter
}

/**
 * Strict IANA validator (lock 5.1 / 12.2): the zone must be a non-empty
 * whitespace-free string that is NOT an offset form (`+05:00`, `-08`, …) and
 * that the host IANA database resolves. Closed code `W4C1_TIMEZONE_INVALID`.
 */
export function validateAttendanceIanaTimezoneV1(zone: unknown): string {
  const code = 'W4C1_TIMEZONE_INVALID'
  if (typeof zone !== 'string' || zone.length === 0) fail(code)
  if (/\s/.test(zone)) fail(code)
  // ECMA-402 accepts pure offset time zones ("+05:00"); those are not IANA
  // identifiers and are rejected here so an offset can never masquerade as a
  // zone (no UTC-offset fallback path exists in this module).
  if (/^[+-]/.test(zone)) fail(code)
  try {
    zoneFormatter(zone)
  } catch {
    fail(code)
  }
  return zone
}

// ---------------------------------------------------------------------------
// Local wall-time -> UTC instant enumeration (lock 5.1 steps 1-7).
// ---------------------------------------------------------------------------

interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallPartsAt(zone: string, epochMs: number): WallParts {
  const parts = zoneFormatter(zone).formatToParts(epochMs)
  const out: Partial<Record<string, number>> = {}
  for (const part of parts) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day' ||
      part.type === 'hour' ||
      part.type === 'minute' ||
      part.type === 'second'
    ) {
      out[part.type] = Number(part.value)
    }
  }
  return {
    year: out.year as number,
    month: out.month as number,
    day: out.day as number,
    hour: out.hour as number,
    minute: out.minute as number,
    second: out.second as number,
  }
}

/** Zone offset (minutes east of UTC) at a given instant, from the tz database. */
export function attendanceZoneOffsetMinutesAtV1(zone: string, epochMs: number): number {
  const parts = wallPartsAt(zone, epochMs)
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const wholeSecondEpoch = Math.floor(epochMs / 1000) * 1000
  return Math.round((wallAsUtc - wholeSecondEpoch) / 60_000)
}

export type AttendanceLocalWallResolutionV1 =
  | { posture: 'unique'; epochMs: number; offsetMinutes: number }
  | {
      posture: 'fold'
      earlier: { epochMs: number; offsetMinutes: number }
      later: { epochMs: number; offsetMinutes: number }
    }
  | { posture: 'gap' }
  | { posture: 'invalid' }

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Enumerates UTC instants that round-trip to `dateKey (+dayOffset)` at
 * `timeHHMM` in `zone`:
 *
 * - zero matches -> `gap` (spring-forward local times do not exist);
 * - one match -> `unique`;
 * - two matches -> `fold` (fall-back repeated hour) with earlier/later
 *   instants and their frozen offsets;
 * - invalid zone or more than two matches -> `invalid`.
 *
 * Malformed date/time inputs throw `W4C1_LOCAL_WALL_INVALID` (they are frozen
 * contract values, not business evidence). There is deliberately NO fallback
 * that interprets the wall time as UTC.
 */
export function resolveAttendanceLocalWallTimeV1(
  dateKey: string,
  timeHHMM: string,
  dayOffset: 0 | 1,
  zone: string,
): AttendanceLocalWallResolutionV1 {
  const code = 'W4C1_LOCAL_WALL_INVALID'
  if (typeof dateKey !== 'string' || typeof timeHHMM !== 'string') fail(code)
  const dateMatch = DATE_KEY_RE.exec(dateKey)
  const timeMatch = TIME_HHMM_RE.exec(timeHHMM)
  if (!dateMatch || !timeMatch) fail(code)
  if (dayOffset !== 0 && dayOffset !== 1) fail(code)
  const year = Number(dateMatch[1])
  const month = Number(dateMatch[2])
  const day = Number(dateMatch[3])
  if (!isCalendarValidUtc(year, month, day)) fail(code)
  const hour = Number(timeMatch[1])
  const minute = Number(timeMatch[2])

  try {
    validateAttendanceIanaTimezoneV1(zone)
  } catch {
    return { posture: 'invalid' }
  }

  const wallAsUtc = Date.UTC(year, month - 1, day + dayOffset, hour, minute, 0)
  // Candidate offsets: the zone's offset well before, at, and well after the
  // wall time (26h covers every real-world transition delta).
  const probeOffsets = new Set<number>()
  for (const probe of [wallAsUtc - 26 * 3_600_000, wallAsUtc, wallAsUtc + 26 * 3_600_000]) {
    probeOffsets.add(attendanceZoneOffsetMinutesAtV1(zone, probe))
  }

  const matches: Array<{ epochMs: number; offsetMinutes: number }> = []
  for (const offset of probeOffsets) {
    const candidate = wallAsUtc - offset * 60_000
    const parts = wallPartsAt(zone, candidate)
    const roundTrips =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) ===
      wallAsUtc
    if (roundTrips && !matches.some((m) => m.epochMs === candidate)) {
      matches.push({ epochMs: candidate, offsetMinutes: offset })
    }
  }
  matches.sort((a, b) => a.epochMs - b.epochMs)

  if (matches.length === 0) return { posture: 'gap' }
  if (matches.length === 1) {
    return { posture: 'unique', epochMs: matches[0].epochMs, offsetMinutes: matches[0].offsetMinutes }
  }
  if (matches.length === 2) {
    return { posture: 'fold', earlier: matches[0], later: matches[1] }
  }
  return { posture: 'invalid' }
}

/** Calendar-valid `YYYY-MM-DD` guard shared by the calculator modules. */
export function isAttendanceCalendarDateKeyV1(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_KEY_RE.exec(value)
  if (!match) return false
  return isCalendarValidUtc(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** Strict `HH:MM` wall-time guard shared by the calculator modules. */
export function isAttendanceWallTimeHHMMV1(value: unknown): value is string {
  return typeof value === 'string' && TIME_HHMM_RE.test(value)
}
