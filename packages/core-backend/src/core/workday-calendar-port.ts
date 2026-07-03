/**
 * T3-2 — Business/work-day calendar wired to approval SLA.
 *
 * A hexagonal PORT that lets the approval SLA path refine a deadline against a
 * working-day / business-time calendar WITHOUT ever reading `attendance_*` tables
 * or taking a compile-time dependency on the attendance plugin. The attendance
 * plugin registers a PROVIDER (adapter) wrapping its `resolveEffectiveCalendar`.
 *
 * When no provider is bound (attendance absent / unregistered) the SLA path
 * FAILS OPEN to natural elapsed arithmetic (see ApprovalMetricsService).
 *
 * See docs/development/t3-2-business-calendar-sla-design-lock-20260703.md.
 */

/**
 * A recurring intra-day non-counting window (Q6, v1: recurring windows / day masks,
 * NOT absolute date ranges). Minutes-of-day `[startMinuteOfDay, endMinuteOfDay)` in the
 * calendar timezone. When `daysOfWeek` is present it restricts the window to those
 * weekdays (0 = Sunday … 6 = Saturday); absent → applies to every working day.
 */
export interface RecurringWindow {
  startMinuteOfDay: number
  endMinuteOfDay: number
  daysOfWeek?: number[]
}

/**
 * A resolved, snapshot working-time calendar for one org. `isWorkingDay` is a pure
 * day-mask lookup (holidays / rest days baked in at resolve time); `nonCountingWindows`
 * are recurring intra-day windows that do not count toward the SLA even on a working day.
 */
export interface WorkdayCalendar {
  timezone: string
  isWorkingDay(dayIso: string): boolean
  nonCountingWindows: RecurringWindow[]
}

/**
 * The port. `resolve` returns the working-time context for `orgId` as of the `asOf`
 * snapshot instant, or `null` when the provider owns no calendar for that org (a
 * foreign / unauthorized org is the provider's decision — approval passes the resolved
 * org, never a raw attendance id). A throw is treated as fail-open by the caller.
 */
export interface WorkdayCalendarPort {
  resolve(orgId: string, asOf: Date): Promise<WorkdayCalendar | null>
}

/**
 * Single-provider registry. Unlike the view registries (keyed by view type) there is
 * exactly one working-day calendar provider process-wide; binding a second one replaces
 * the first (logged). Unbound → `get()` returns `undefined` → the SLA path fails open.
 */
class WorkdayCalendarRegistryImpl {
  private provider: WorkdayCalendarPort | undefined
  private static instance: WorkdayCalendarRegistryImpl

  private constructor() {}

  static getInstance(): WorkdayCalendarRegistryImpl {
    if (!WorkdayCalendarRegistryImpl.instance) {
      WorkdayCalendarRegistryImpl.instance = new WorkdayCalendarRegistryImpl()
    }
    return WorkdayCalendarRegistryImpl.instance
  }

  register(provider: WorkdayCalendarPort): void {
    if (this.provider) {
      console.warn('WorkdayCalendarPort provider is being replaced')
    }
    this.provider = provider
  }

  unregister(): void {
    this.provider = undefined
  }

  get(): WorkdayCalendarPort | undefined {
    return this.provider
  }

  has(): boolean {
    return this.provider !== undefined
  }

  /** Clear the bound provider (test isolation). */
  clear(): void {
    this.provider = undefined
  }
}

export function getWorkdayCalendarRegistry(): WorkdayCalendarRegistryImpl {
  return WorkdayCalendarRegistryImpl.getInstance()
}

/** Register the process-wide working-day calendar provider (convenience). */
export function registerWorkdayCalendarProvider(provider: WorkdayCalendarPort): void {
  getWorkdayCalendarRegistry().register(provider)
}

/** Unregister the working-day calendar provider (convenience / test teardown). */
export function unregisterWorkdayCalendarProvider(): void {
  getWorkdayCalendarRegistry().unregister()
}

export { WorkdayCalendarRegistryImpl }

// ---------------------------------------------------------------------------
// Pure business-time deadline arithmetic (no DB, no port — fully unit-testable).
// ---------------------------------------------------------------------------

const MINUTES_PER_DAY = 1440
const MS_PER_MINUTE = 60_000

/** Default forward-search horizon (Q10): if no deadline is found inside this many days, clamp + flag. */
export const WORKDAY_SEARCH_CAP_DAYS = 366

export interface WorkdayDeadlineResult {
  /** The computed business-time due instant (or the clamped horizon end when exhausted). */
  dueAt: Date
  /** True when the forward search hit the day cap without consuming the full SLA budget. */
  clamped: boolean
}

/**
 * Read the calendar-timezone wall-clock day (`YYYY-MM-DD`) and minute-of-day (0..1439)
 * of an instant. Uses `Intl` (DST-correct) with an h23 hour cycle. Throws if the
 * timezone is invalid — the caller treats that as fail-open.
 */
function tzParts(instant: Date, timeZone: string): { dayIso: string; minuteOfDay: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const parts = fmt.formatToParts(instant)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  return { dayIso: `${year}-${month}-${day}`, minuteOfDay: hour * 60 + minute }
}

/** Weekday (0 = Sunday … 6 = Saturday) of a `YYYY-MM-DD` calendar date (tz-independent). */
function weekdayOf(dayIso: string): number {
  return new Date(`${dayIso}T00:00:00Z`).getUTCDay()
}

/**
 * The non-counting minute intervals `[a, b)` (minutes-of-day) that apply on `dayIso`,
 * merged and clamped to `[0, 1440)`. Windows whose `daysOfWeek` excludes the day are ignored.
 */
function nonCountingIntervalsForDay(dayIso: string, windows: RecurringWindow[]): Array<[number, number]> {
  if (!windows.length) return []
  const weekday = weekdayOf(dayIso)
  const raw: Array<[number, number]> = []
  for (const w of windows) {
    if (Array.isArray(w.daysOfWeek) && !w.daysOfWeek.includes(weekday)) continue
    const a = Math.max(0, Math.min(MINUTES_PER_DAY, Math.floor(w.startMinuteOfDay)))
    const b = Math.max(0, Math.min(MINUTES_PER_DAY, Math.floor(w.endMinuteOfDay)))
    if (b > a) raw.push([a, b])
  }
  if (!raw.length) return []
  raw.sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1]
    if (raw[i][0] <= last[1]) last[1] = Math.max(last[1], raw[i][1])
    else merged.push(raw[i])
  }
  return merged
}

/**
 * The counting sub-segments `[a, b)` (minutes-of-day) inside `[fromMinute, toMinute)` on
 * `dayIso` — i.e. the requested range minus the non-counting windows.
 */
function countingSegments(
  dayIso: string,
  fromMinute: number,
  toMinute: number,
  windows: RecurringWindow[],
): Array<[number, number]> {
  const intervals = nonCountingIntervalsForDay(dayIso, windows)
  const segments: Array<[number, number]> = []
  let cursor = fromMinute
  for (const [a, b] of intervals) {
    if (b <= cursor || a >= toMinute) continue
    if (a > cursor) segments.push([cursor, Math.min(a, toMinute)])
    cursor = Math.max(cursor, b)
    if (cursor >= toMinute) break
  }
  if (cursor < toMinute) segments.push([cursor, toMinute])
  return segments.filter(([a, b]) => b > a)
}

/**
 * Walk forward from `start`, counting ONLY minutes that fall on a working day AND outside every
 * non-counting window (in the calendar's timezone), until `durationMinutes` have been consumed.
 *
 * Pure and DB-free. Real-millisecond arithmetic is used within a day and to hop to the next local
 * midnight; on a DST-transition day this can be off by the transition amount (accepted v1 imprecision,
 * documented). Caps the search at `capDays` days (Q10): if the budget is not consumed inside the
 * horizon the result is clamped to the horizon end and `clamped` is true.
 */
export function computeWorkdayDeadline(
  start: Date,
  durationMinutes: number,
  calendar: WorkdayCalendar,
  capDays: number = WORKDAY_SEARCH_CAP_DAYS,
): WorkdayDeadlineResult {
  const tz = calendar.timezone
  let remaining = Math.max(0, durationMinutes)
  let cursorMs = start.getTime()

  if (remaining === 0) return { dueAt: new Date(cursorMs), clamped: false }

  for (let day = 0; day <= capDays; day++) {
    const { dayIso, minuteOfDay } = tzParts(new Date(cursorMs), tz)
    if (calendar.isWorkingDay(dayIso)) {
      const segments = countingSegments(dayIso, minuteOfDay, MINUTES_PER_DAY, calendar.nonCountingWindows)
      for (const [a, b] of segments) {
        const segMinutes = b - a
        if (remaining <= segMinutes) {
          // The budget exhausts `remaining` minutes into this counting segment. `a` is the
          // segment's starting minute-of-day; `cursorMs` is at `minuteOfDay`, so the real
          // offset from the cursor is (a - minuteOfDay) + remaining.
          const offsetMinutes = a - minuteOfDay + remaining
          return { dueAt: new Date(cursorMs + offsetMinutes * MS_PER_MINUTE), clamped: false }
        }
        remaining -= segMinutes
      }
    }
    // Hop to the next local midnight (minutes left in this tz-day).
    cursorMs += (MINUTES_PER_DAY - minuteOfDay) * MS_PER_MINUTE
  }
  // Horizon exhausted without consuming the budget → clamp + flag (caller logs).
  return { dueAt: new Date(cursorMs), clamped: true }
}
