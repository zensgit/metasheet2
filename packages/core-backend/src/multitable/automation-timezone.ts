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

/**
 * `Date.UTC` that keeps years 0000–0099 as themselves. `Date.UTC(99, …)` means 1999 (a legacy two-digit
 * rule), which would silently move a stored `0099-…` instant by 1900 years through any wall-clock round
 * trip. `setUTCFullYear` has no such rule.
 */
export function utcMsFromParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(hour, minute, second, 0)
  return d.getTime()
}

/** Offset (minutes) of `timeZone` at the given UTC instant: (localWallClock-as-UTC) − utc. */
function timeZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = getZonedParts(utcMs, timeZone)
  const asUtc = utcMsFromParts(p.year, p.month, p.day, p.hour, p.minute, p.second)
  return (asUtc - utcMs) / 60000
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Convert a LOCAL wall-clock (civil Y-M-D h:m in `timeZone`) to a UTC epoch-ms — the hard local→UTC direction.
 *
 * EXACT (客户反馈 2026-09-24 #4c, PR #6083 review S1/N1): the previous single-pass guess+correct read the
 * zone's offset at the wall clock TAKEN AS UTC, which is 4–14 hours away from the real instant. For up to
 * that many hours after every DST transition it therefore applied the WRONG offset (e.g. America/New_York
 * 2026-03-08 06:00 → 11:00Z instead of 10:00Z). This version tries every offset the zone has within a day
 * of the guess and keeps the candidate whose instant really maps back to that offset.
 *
 * DST rule (documented + tested, shared by the web `wallClockToUtcMs`):
 *   - a wall clock that does not exist (spring-forward GAP, e.g. NY 2026-03-08 02:30) → the POST-transition
 *     instant: the later candidate, i.e. the clock read with the pre-transition offset (02:30 EST = 07:30Z,
 *     which displays as 03:30 EDT);
 *   - a wall clock that exists twice (fall-back OVERLAP, e.g. NY 2026-11-01 01:30) → the EARLIER instant
 *     (01:30 EDT = 05:30Z).
 * Zones without DST (Asia/Shanghai) have exactly one candidate and are exact everywhere.
 *
 * Throws only on an invalid tz (callers guard).
 */
export function zonedWallClockToUtcMs(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timeZone: string,
): number {
  const utcGuess = utcMsFromParts(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second ?? 0)
  // Every offset the zone uses within ±1 day of the guess: 1 value normally, 2 around a transition.
  const offsets = new Set<number>([
    timeZoneOffsetMinutes(utcGuess - ONE_DAY_MS, timeZone),
    timeZoneOffsetMinutes(utcGuess, timeZone),
    timeZoneOffsetMinutes(utcGuess + ONE_DAY_MS, timeZone),
  ])
  const candidates: number[] = []
  const consistent: number[] = []
  for (const offset of offsets) {
    const utcMs = utcGuess - offset * 60000
    candidates.push(utcMs)
    // Self-consistent: the zone really is at `offset` at that instant, so it displays as `parts`.
    if (timeZoneOffsetMinutes(utcMs, timeZone) === offset) consistent.push(utcMs)
  }
  if (consistent.length === 1) return consistent[0]
  if (consistent.length > 1) return Math.min(...consistent) // overlap → earlier instant
  return Math.max(...candidates) // gap → post-transition instant
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

/** Max look-back when detecting a DST fall-back repeat (a fall-back overlap is at most a couple of hours). */
export const MAX_DST_FALLBACK_LOOKBACK_MS = 3 * 60 * 60 * 1000

/**
 * DST fall-back: a wall-clock minute that occurs TWICE (clock-back day) must fire ONCE. We always emit the
 * FIRST instant and suppress the SECOND. A candidate is the suppressed repeat iff some EARLIER UTC minute
 * within {@link MAX_DST_FALLBACK_LOOKBACK_MS} maps to the SAME local Y-M-D-H-m. An identical
 * local-date-hour-minute can only arise during a fall-back overlap, so this is false-positive-free for
 * ordinary days/crons. Defensive: any zoned-formatter throw is treated as "not a repeat" (never throws
 * inside a scan).
 *
 * Lifted here from `automation-scheduler.ts` (which pioneered it as `isZonedFallbackRepeat`) so the
 * SchedulerService cron path can reuse the SAME proven single-fire rule rather than growing a second,
 * subtly-different one. Owner review P2 (2026-07-12): the previous SchedulerService revision documented
 * the double-fire as an accepted limitation and claimed the sync lease absorbed it — it does not (the two
 * fires are an HOUR apart; a lease only blocks a concurrent run).
 */
export function isZonedFallbackRepeat(candidateMs: number, timeZone: string): boolean {
  let key: string
  try {
    key = zonedMinuteKey(candidateMs, timeZone)
  } catch {
    return false
  }
  const minuteMs = 60 * 1000
  for (let back = candidateMs - minuteMs; back >= candidateMs - MAX_DST_FALLBACK_LOOKBACK_MS; back -= minuteMs) {
    try {
      if (zonedMinuteKey(back, timeZone) === key) return true
    } catch {
      return false
    }
  }
  return false
}
