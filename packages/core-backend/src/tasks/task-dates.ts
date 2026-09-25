/**
 * Task feature — due-date math. PURE, no I/O, no implicit clock (every function takes `now`
 * explicitly; nothing here calls `Date.now()` or `new Date()` without an argument).
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1, §2.3
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §4.4, 门 8
 *
 * Zoned wall-clock math probes `Intl.DateTimeFormat` for UTC offsets. For a civil time that does
 * not map to exactly one instant it follows PostgreSQL's `AT TIME ZONE` rule (the lock §4.4 SQL):
 * in a fall-back overlap it returns the LATER of the two instants, and in a spring-forward gap it
 * returns the post-transition instant. Candidate offsets are probed at the naive guess and at
 * ±24h from it, which brackets any DST transition near the target date. The unit tests pin
 * overlap and gap cases for east- and west-of-UTC zones.
 */

import { isValidIanaTimeZone } from '../multitable/automation-timezone'

interface ZonedWallClockParts {
  year: number
  /** 1-12. */
  month: number
  /** 1-31. */
  day: number
  /** 0-23. */
  hour: number
  minute: number
  second: number
  ms?: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()
// NOTE(task-b, design-gap — flag for owner ratification): the cache used to key on the RAW spelling
// callers passed in. A route forwarding a request-scoped viewer-tz header, or a task row's own
// `time_zone` column, can produce arbitrarily many distinct spellings of one valid zone (case,
// deprecated alias, …); each miss allocated a NEW native ICU formatter that was never evicted — an
// unbounded per-process growth reachable once per request. Keying on the CANONICAL name (below)
// collapses spellings of the same zone to one entry; the size cap is a second, independent bound in
// case a caller genuinely cycles through many distinct real zones (e.g. many different orgs' task
// rows) in one process lifetime.
const MAX_FORMATTER_CACHE_ENTRIES = 256
/** Raw spelling -> canonical zone name, bounded the same way (avoids a formatter build per call). */
const canonicalKeyCache = new Map<string, string>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  // Canonicalize the cache key first so two spellings of the same zone share one formatter. If
  // `timeZone` is not a recognized zone at all, this throws — falling through to the (identical)
  // construction below lets THAT call raise the error, so an unknown-zone caller (e.g.
  // `computeDueAt`'s "throws for an unknown IANA zone" contract) sees the same error shape as
  // before this cache change.
  let cacheKey = canonicalKeyCache.get(timeZone)
  if (cacheKey === undefined) {
    cacheKey = timeZone
    try {
      cacheKey = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
      if (canonicalKeyCache.size >= MAX_FORMATTER_CACHE_ENTRIES) {
        const oldest = canonicalKeyCache.keys().next().value
        if (oldest !== undefined) canonicalKeyCache.delete(oldest)
      }
      canonicalKeyCache.set(timeZone, cacheKey)
    } catch {
      // fall through — the construction below re-throws for the same reason.
    }
  }
  let fmt = formatterCache.get(cacheKey)
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
    if (formatterCache.size >= MAX_FORMATTER_CACHE_ENTRIES) {
      const oldestKey = formatterCache.keys().next().value
      if (oldestKey !== undefined) formatterCache.delete(oldestKey)
    }
    formatterCache.set(cacheKey, fmt)
  }
  return fmt
}

function getZonedParts(utcMs: number, timeZone: string): Omit<ZonedWallClockParts, 'ms'> {
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
  // Defensive: some V8 builds render local midnight as "24" rather than "00" under hourCycle h23.
  if (hour === 24) hour = 0
  return { year, month, day, hour, minute, second }
}

function timeZoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const p = getZonedParts(utcMs, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return (asUtc - utcMs) / 60000
}

/** True iff re-reading `utcMs` back through `getZonedParts` reproduces the exact requested civil time. */
function roundTripsToWallClock(
  utcMs: number,
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): boolean {
  const back = getZonedParts(utcMs, timeZone)
  return (
    back.year === wall.year &&
    back.month === wall.month &&
    back.day === wall.day &&
    back.hour === wall.hour &&
    back.minute === wall.minute &&
    back.second === wall.second
  )
}

/** ±1 day around the naive guess — wide enough to bracket any DST transition near the target civil
 * date, since no real IANA zone's UTC offset magnitude exceeds ~14h either side of it. */
const CANDIDATE_PROBE_SPAN_MS = 24 * 60 * 60 * 1000

/**
 * Local wall-clock (civil Y-M-D h:m:s[.ms] in `timeZone`) → UTC epoch-ms. Candidate-set resolution
 * (see the module docblock, correction 3, for why this replaced an order-dependent two-probe
 * scheme): probe the zone's UTC offset at three points spanning the naive UTC-as-local guess
 * (guess−24h, guess, guess+24h), convert each probed offset to a candidate UTC instant, then:
 *   - if one or more candidates round-trip back to the EXACT requested civil time, return the
 *     LATEST one that does (an overlap/fall-back ambiguity resolves to the later instant, matching
 *     PostgreSQL's `AT TIME ZONE`, not just whichever candidate this function happened to try
 *     first);
 *   - if NONE round-trips, the requested civil time was skipped entirely (a spring-forward gap) —
 *     return the latest candidate overall, the accepted post-transition instant.
 * Throws only on an invalid `timeZone`.
 */
function zonedWallClockToUtcMs(parts: ZonedWallClockParts, timeZone: string): number {
  const ms = parts.ms ?? 0
  const wall = {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
  // Offset probed from a whole-second guess — see the module docblock (correction 1) for why `ms`
  // is split out and added back at the end rather than folded into the guess itself.
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
  const probeInstants = [utcGuess - CANDIDATE_PROBE_SPAN_MS, utcGuess, utcGuess + CANDIDATE_PROBE_SPAN_MS]
  const candidates = new Set<number>()
  for (const probe of probeInstants) {
    const offset = timeZoneOffsetMinutes(probe, timeZone)
    candidates.add(utcGuess - offset * 60000)
  }
  let latestRoundTripping: number | null = null
  let latestOverall: number | null = null
  for (const candidate of candidates) {
    if (latestOverall === null || candidate > latestOverall) latestOverall = candidate
    if (
      roundTripsToWallClock(candidate, wall, timeZone) &&
      (latestRoundTripping === null || candidate > latestRoundTripping)
    ) {
      latestRoundTripping = candidate
    }
  }
  return (latestRoundTripping ?? latestOverall ?? utcGuess) + ms
}

export interface ComputeDueAtInput {
  /** `YYYY-MM-DD`. */
  dueDate: string
  /** `HH:MM` or `HH:MM:SS`; absent/`null` means an all-day task. */
  dueTime?: string | null
  /** IANA zone the task itself is anchored to. */
  timeZone: string
}

function parseIsoDate(dueDate: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate)
  if (!m) throw new RangeError(`computeDueAt: dueDate must be YYYY-MM-DD, got "${dueDate}"`)
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`computeDueAt: "${dueDate}" is not a real calendar date`)
  }
  return { year, month, day }
}

function parseTimeOfDay(dueTime: string): { hour: number; minute: number; second: number } {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dueTime)
  if (!m) throw new RangeError(`computeDueAt: dueTime must be HH:MM or HH:MM:SS, got "${dueTime}"`)
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = m[3] ? Number(m[3]) : 0
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`computeDueAt: "${dueTime}" is not a real time of day`)
  }
  return { hour, minute, second }
}

/**
 * `due_at` (lock §4.4): scheduled = the `(dueDate, dueTime)` instant in `timeZone`; all-day =
 * `dueDate` at local `23:59:59.999` in `timeZone`. Never depends on a viewer timezone — same task,
 * any viewer, byte-identical output (门 5).
 */
export function computeDueAt(input: ComputeDueAtInput): Date {
  const { year, month, day } = parseIsoDate(input.dueDate)
  if (input.dueTime) {
    const { hour, minute, second } = parseTimeOfDay(input.dueTime)
    return new Date(zonedWallClockToUtcMs({ year, month, day, hour, minute, second, ms: 0 }, input.timeZone))
  }
  return new Date(
    zonedWallClockToUtcMs({ year, month, day, hour: 23, minute: 59, second: 59, ms: 999 }, input.timeZone),
  )
}

/** `YYYY-MM-DD` civil date of `now` as seen from `viewerTz`. */
export function viewerToday(now: Date, viewerTz: string): string {
  const p = getZonedParts(now.getTime(), viewerTz)
  const mm = String(p.month).padStart(2, '0')
  const dd = String(p.day).padStart(2, '0')
  return `${p.year}-${mm}-${dd}`
}

/** The next local midnight (00:00:00.000) after `now`, as seen from `viewerTz`, as a UTC instant. */
export function viewerNextMidnight(now: Date, viewerTz: string): Date {
  const p = getZonedParts(now.getTime(), viewerTz)
  // Feed (y, m, day+1, 0, 0, 0) through Date.UTC first so month/day rollover (incl. month/year
  // boundaries and variable month lengths) is handled by the platform, then re-read as civil parts.
  const nextDayUtcMidnight = Date.UTC(p.year, p.month - 1, p.day + 1, 0, 0, 0, 0)
  const next = new Date(nextDayUtcMidnight)
  return new Date(
    zonedWallClockToUtcMs(
      {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
        ms: 0,
      },
      viewerTz,
    ),
  )
}

/** Minimal task shape these predicates need. `dueTime` presence is what marks "scheduled" vs "all-day". */
export interface TaskDueShape {
  dueAt: Date | null
  /** `YYYY-MM-DD`, used by the all-day rule; ignored (may be null) for a scheduled task. */
  dueDate: string | null
  /** Presence (truthy) means scheduled; falsy means all-day. */
  dueTime?: string | null
  /** The task's own zone — used as the "viewer" for `isOverdue`, which takes no viewer parameter. */
  timeZone: string
}

// NOTE(task-b, design-gap — flag for owner ratification): design §1's signature for `isOverdue` is
// `(task, now)`, with no viewer-tz parameter, so its all-day rule-3 branch had no way to honor a
// viewer's timezone and instead defaulted to the task's own `timeZone`. That silently broke the
// invariant `isOverdue ⇒ isOverdueOrToday` for a viewer whose tz differs from the task's (see the
// property test below). `viewerTz` is added here as an OPTIONAL third parameter defaulting to
// `task.timeZone` — every existing call site is unaffected — so the invariant now holds when a
// caller passes the same `viewerTz` to both functions.
/**
 * Rule 1 (scheduled): `due_at < now`. Rule 3 (all-day): `due_date < viewerToday(now, viewerTz)`.
 */
export function isOverdue(task: TaskDueShape, now: Date, viewerTz: string = task.timeZone): boolean {
  if (task.dueTime) {
    if (!task.dueAt) return false
    return task.dueAt.getTime() < now.getTime()
  }
  if (!task.dueDate) return false
  return task.dueDate < viewerToday(now, viewerTz)
}

/**
 * Rule 2 (scheduled): `due_at < viewerNextMidnight(now, viewerTz)`. Rule 3 (all-day):
 * `due_date <= viewerToday(now, viewerTz)`.
 */
export function isOverdueOrToday(task: TaskDueShape, now: Date, viewerTz: string): boolean {
  if (task.dueTime) {
    if (!task.dueAt) return false
    return task.dueAt.getTime() < viewerNextMidnight(now, viewerTz).getTime()
  }
  if (!task.dueDate) return false
  return task.dueDate <= viewerToday(now, viewerTz)
}

/** A bare UTC-offset string (`+05:30`, `-8`, `Z`, …). `Intl.DateTimeFormat` accepts these as a
 * `timeZone` value without throwing — they round-trip through `resolvedOptions().timeZone`
 * unchanged — so `isValidIanaTimeZone` (which only checks "does construction throw") passes them.
 * PostgreSQL's `AT TIME ZONE` reads a bare offset with the OPPOSITE sign convention from the POSIX/
 * ICU one `Intl` uses, so accepting one here would silently apply an offset backwards relative to
 * the SQL `buildTaskPendingCondition` (task-access.ts) hands to `COALESCE($3, tasks.time_zone)`.
 * This module rejects the offset FORM outright rather than trying to invert the sign, since a bare
 * offset also carries no DST information — matching a real named zone is what `resolveViewerTimeZone`
 * exists to do. */
const OFFSET_FORM_RE = /^(?:[+-]\d{1,2}(?::?\d{2})?|Z)$/i
/** An IANA-style named zone: ASCII segments separated by '/', first character a letter. */
const NAMED_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

function canonicalTimeZoneName(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return null
  }
}

/**
 * Validates a viewer-supplied tz header value IN ISOLATION — no task-tz fallback, `null` on any
 * failure (missing, blank, not a real zone per `isValidIanaTimeZone`, or a bare-offset form per the
 * `OFFSET_FORM_RE` guard above). Returns the CANONICAL zone name (the platform's canonical spelling, e.g. `Asia/Kolkata` and
 * `Asia/Calcutta` collapse to one name) so two spellings of the same zone collapse to one string for a caller that keys a cache
 * or a `COALESCE($3, …)` bind value on it. `isValidIanaTimeZone` is the ONE external import this
 * module tree is allowed.
 */
export function validateViewerTimeZoneHeader(headerValue: unknown): string | null {
  if (typeof headerValue !== 'string') return null
  const trimmed = headerValue.trim()
  if (trimmed.length === 0) return null
  if (OFFSET_FORM_RE.test(trimmed)) return null
  if (!isValidIanaTimeZone(trimmed)) return null
  const canonical = canonicalTimeZoneName(trimmed)
  // Check the CANONICAL value, not only the raw input: some non-ASCII spellings pass the raw offset
  // guard above yet canonicalize to a bare offset. Only a named zone (starts with a letter, ASCII
  // name segments) is accepted.
  if (canonical === null || !NAMED_ZONE_RE.test(canonical) || OFFSET_FORM_RE.test(canonical)) return null
  return canonical
}

/**
 * Resolves the viewer's effective timezone: an invalid or missing header value falls back to the
 * task's own `timeZone` (lock §4.4). Delegates the header-only decision to
 * `validateViewerTimeZoneHeader`.
 */
export function resolveViewerTimeZone(headerValue: unknown, taskTimeZone: string): string {
  return validateViewerTimeZoneHeader(headerValue) ?? taskTimeZone
}
