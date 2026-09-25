/**
 * Task feature — due-date math. PURE, no I/O, no implicit clock (every function takes `now`
 * explicitly; nothing here calls `Date.now()` or `new Date()` without an argument).
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1, §2.3
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §4.4, 门 8
 *
 * Zoned wall-clock math is a local, dependency-free re-implementation of the SAME technique as
 * `../multitable/automation-timezone.ts` (`Intl.DateTimeFormat` offset probing) — deliberately NOT
 * imported from there, because design §0 allows exactly one external import for this whole module
 * tree (`isValidIanaTimeZone`) and that file also exports non-pure-contract helpers. Keeping this a
 * private copy avoids widening the allowed-import surface while matching the proven algorithm.
 *
 * THREE corrections versus a byte-for-byte copy of that file's `zonedWallClockToUtcMs`:
 *
 * 1. The offset probe here is computed from a WHOLE-SECOND guess (milliseconds zeroed) and the
 *    input's milliseconds are added back afterward. The original computes the probe instant
 *    directly from a guess that may carry sub-second precision, which for a `:59.999`-style input
 *    yields an offset in fractional minutes (since the DST-probe formatter only has whole-second
 *    resolution) and a result off by up to ~1ms. That never surfaces in that file's callers (they
 *    only ever pass whole seconds), but `computeDueAt`'s all-day rule needs an exact
 *    `23:59:59.999` local instant, so the split is required here for byte-identical results.
 *
 * 2. The original is genuinely single-pass: one offset probe at the naive UTC-as-local guess. That
 *    is correct for a WEST-of-UTC zone's spring-forward gap (the guess instant is still on the
 *    pre-transition side, so the probed offset is the pre-transition one, and subtracting it lands
 *    past the transition — correct). It is WRONG for an EAST-of-UTC zone's gap (e.g. Asia/Beirut's
 *    2026-03-29 00:00→01:00 jump): there the naive guess instant is already numerically past the
 *    transition, so the probed offset is the POST-transition one, and subtracting it lands an hour
 *    short — still on the wrong side of the gap.
 *
 * 3. [Correction added after the ratify-round review — the previous revision of this file probed
 *    only TWO candidate offsets (at the naive guess, then re-probed at whichever instant that guess
 *    produced) and returned the FIRST one that round-tripped. That is not just imprecise, it is
 *    SIGN-DEPENDENT: for a west-of-UTC zone's fall-back overlap the first candidate found this way
 *    is the EARLIER of the two valid instants, but for an east-of-UTC zone it is the LATER one —
 *    the same civil-time ambiguity resolves to opposite occurrences depending on which side of UTC
 *    the zone sits, purely as an artifact of probe order. PostgreSQL's `AT TIME ZONE` (the lock's
 *    own SQL, §4.4) is NOT sign-dependent: for both an overlap and a gap it deterministically picks
 *    the LATER UTC instant. This module now matches that: it collects candidate offsets probed at
 *    the naive guess and at ±24h from it (wide enough to bracket any DST transition near the target
 *    civil date, since no real zone's UTC offset magnitude exceeds ~14h), converts each to a
 *    candidate UTC instant, and returns the LATEST candidate that round-trips back to the exact
 *    requested civil time — or, if none round-trips (a spring-forward gap), the latest candidate
 *    overall (the accepted post-transition instant, same as correction 2's gap behavior, now
 *    derived from the same one-rule candidate set instead of a special-cased two-probe scheme).
 *    Verified against `taskb-r1/oracle_dates.py`'s independent zoneinfo computation for
 *    Asia/Beirut 2026-03-29 (that file also lists Africa/Cairo 2026-04-24, but Node's bundled ICU
 *    tzdata disagrees with Python's zoneinfo about Cairo's 2026 rule — Egypt's DST rule changed
 *    more than once in recent years and the two runtimes' bundled data have not always agreed on
 *    the year at which each version applies — so this module does not pin or test that zone), and
 *    independently against `Intl.DateTimeFormat` round-trip checks for America/Havana, Atlantic/
 *    Azores, America/Santiago and Europe/Berlin (see the DST-boundary describe blocks in
 *    tests/unit/task-dates.test.ts for the exact fixtures and cited PG-SQL values).
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

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  // Canonicalize the cache key first so two spellings of the same zone share one formatter. If
  // `timeZone` is not a recognized zone at all, this throws — falling through to the (identical)
  // construction below lets THAT call raise the error, so an unknown-zone caller (e.g.
  // `computeDueAt`'s "throws for an unknown IANA zone" contract) sees the same error shape as
  // before this cache change.
  let cacheKey = timeZone
  try {
    cacheKey = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    // fall through — the construction below re-throws for the same reason.
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
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

function parseTimeOfDay(dueTime: string): { hour: number; minute: number; second: number } {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dueTime)
  if (!m) throw new RangeError(`computeDueAt: dueTime must be HH:MM or HH:MM:SS, got "${dueTime}"`)
  return { hour: Number(m[1]), minute: Number(m[2]), second: m[3] ? Number(m[3]) : 0 }
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
 * `OFFSET_FORM_RE` guard above). Returns the CANONICAL zone name (e.g. `Asia/Calcutta` → `Asia/
 * Kolkata`) so two spellings of the same zone collapse to one string for a caller that keys a cache
 * or a `COALESCE($3, …)` bind value on it. `isValidIanaTimeZone` is the ONE external import this
 * module tree is allowed.
 */
export function validateViewerTimeZoneHeader(headerValue: unknown): string | null {
  if (typeof headerValue !== 'string') return null
  const trimmed = headerValue.trim()
  if (trimmed.length === 0) return null
  if (OFFSET_FORM_RE.test(trimmed)) return null
  if (!isValidIanaTimeZone(trimmed)) return null
  return canonicalTimeZoneName(trimmed)
}

/**
 * Resolves the viewer's effective timezone: an invalid or missing header value falls back to the
 * task's own `timeZone` (lock §4.4). Delegates the header-only decision to
 * `validateViewerTimeZoneHeader`.
 */
export function resolveViewerTimeZone(headerValue: unknown, taskTimeZone: string): string {
  return validateViewerTimeZoneHeader(headerValue) ?? taskTimeZone
}
