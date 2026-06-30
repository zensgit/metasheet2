/**
 * Timezone helpers for automation scheduling (T2-5) — PURE, dependency-free.
 *
 * Wall-clock ↔ UTC conversion via `Intl.DateTimeFormat` with a per-tz formatter cache. Mirrors the proven
 * pattern in `plugins/plugin-attendance` (getZonedParts / timeZoneOffset / zonedTimeToUtc) so the codebase
 * has ONE shape for zoned-time math rather than a second hand-rolled variant.
 *
 * IMPORTANT: the UTC default scheduling path NEVER calls into this module — callers branch on
 * "timezone absent / 'UTC' / 'Etc/UTC'" and only enter the zoned path for an explicit non-UTC IANA zone. That
 * branch is what keeps the pre-T2-5 UTC behaviour byte-identical (no regression).
 *
 * No new runtime dependency: IANA validity + conversion ride entirely on the platform `Intl` API.
 */

export interface ZonedParts {
  year: number
  /** 1-12. */
  month: number
  /** 1-31. */
  day: number
  /** 0-23. */
  hour: number
  minute: number
  second: number
}

/**
 * Per-tz `Intl.DateTimeFormat` cache. Constructing a formatter is the expensive part; the minute-scan in
 * `nextCronOccurrenceMs` calls `getZonedParts` up to ~1440×/day so the cache matters. `hourCycle: 'h23'` keeps
 * midnight as hour `0` (some V8 builds otherwise render it as `24` under `hour12: false`, which would make a
 * midnight cron silently never match — see the defensive `24 → 0` normalize below).
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

/** True iff `timeZone` is a valid IANA zone (the platform `Intl` accepts it). PURE; never throws. */
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false
  try {
    // Constructing with an unknown timeZone throws RangeError; a known zone does not.
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

/**
 * Wall-clock fields of a UTC instant in `timeZone`. This UTC→local direction is EXACT and unambiguous.
 * Throws only when `timeZone` is invalid — callers validate/guard first (the scheduler/date-reminder loops
 * wrap this in try/catch so a persisted-junk tz can never throw mid-scan).
 */
export function getZonedParts(utcMs: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(utcMs)
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      case 'hour':
        hour = Number(part.value)
        break
      case 'minute':
        minute = Number(part.value)
        break
      case 'second':
        second = Number(part.value)
        break
      default:
        break
    }
  }
  // Defensive: portable across V8 builds that render local midnight as "24" rather than "00".
  if (hour === 24) hour = 0
  return { year, month, day, hour, minute, second }
}

/** Offset (minutes) of `timeZone` at the given UTC instant: (localWallClock-as-UTC) − utc. */
function timeZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = getZonedParts(utcMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return (asUtc - utcMs) / 60000
}

/**
 * Convert a LOCAL wall-clock (civil Y-M-D h:m in `timeZone`) to a UTC epoch-ms — the hard local→UTC direction.
 * Single-pass guess+correct, matching the plugin-attendance precedent. Exact for times away from DST edges
 * (the date-reminder default 09:00 is far from typical 02:00–03:00 transitions). At an exact spring-forward
 * gap the result lands on the post-transition instant; at a fall-back overlap it resolves to one offset —
 * both acceptable bounded edges (Q5 documents the bounded one-time re-bucket tolerance). Throws only on an
 * invalid tz (callers guard).
 */
export function zonedWallClockToUtcMs(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): number {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  )
  const offset = timeZoneOffsetMinutes(utcGuess, timeZone)
  return utcGuess - offset * 60000
}

/**
 * Stable LOCAL minute key `"Y-M-D-H-m"` of a UTC instant in `timeZone` (seconds dropped). Used by the cron
 * scan to dedup a DST fall-back: two distinct UTC instants share the SAME key only during a fall-back overlap,
 * so an exact key match against an earlier instant uniquely identifies the repeated wall-clock minute.
 */
export function zonedMinuteKey(utcMs: number, timeZone: string): string {
  const p = getZonedParts(utcMs, timeZone)
  return `${p.year}-${p.month}-${p.day}-${p.hour}-${p.minute}`
}
