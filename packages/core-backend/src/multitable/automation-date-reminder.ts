/**
 * Date-reminder trigger (`schedule.date_field`) — PURE core logic (2026-06-28).
 *
 * A date-reminder fires relative to the value of a record's DATE field: "N days before/after the date in
 * field X". Unlike `schedule.cron`/`schedule.interval` (fixed wall-clock cadence), the fire time is
 * DATA-DRIVEN — every record has its own occurrence derived from its date value. This module holds the pure,
 * NOW-free helpers (occurrence computation, the firing-window predicate, the SQL pre-filter range, cadence);
 * the scan/dedupe/fire orchestration lives in AutomationService.evaluateDateReminders.
 *
 * Two invariants make idempotency work and MUST hold:
 *   1. `computeDateReminderOccurrence` is a PURE function of (dateValue, config) — it NEVER reads NOW or tick
 *      time. The dedup key is (rule, record, occurrence); if tick time leaked into the occurrence, the key
 *      would change every tick and every tick would re-fire.
 *   2. The occurrence is DAY-BUCKETED: the source date's time-of-day is stripped (UTC midnight) before the
 *      ±offsetDays shift, then `timeOfDay` sets when on the reminder day it fires. So editing the deadline's
 *      time within the same reminder day does not change the occurrence → no re-spam. (Day-bucketing assumes
 *      offsetDays granularity; sub-day offsets are a future revisit — out of v1.)
 *
 * Timezone: v1 buckets in UTC (date fields are stored as `toISOString()` = UTC). A tz-aware day boundary
 * needs an IANA tz library and is deferred; `config.timezone` is accepted+persisted but only `'UTC'` is
 * honored in v1 (documented limitation).
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface ScheduleDateFieldConfig {
  /** The DATE/dateTime field whose value anchors the reminder. */
  dateFieldId: string
  /** Whole days before/after the date value. >= 0. */
  offsetDays: number
  /** Fire this many days BEFORE the date, or AFTER it. */
  direction: 'before' | 'after'
  /** When on the reminder day to fire, 'HH:mm' (UTC, v1). Default '09:00'. */
  timeOfDay?: string
  /** Persisted but v1 honors only 'UTC' (documented limitation). */
  timezone?: string
  /** Scan cadence override in ms (default 24h). Not load-bearing for correctness — the window is. */
  scanIntervalMs?: number
}

/** Default daily scan — matches the "N days before" semantic. */
export const DEFAULT_DATE_REMINDER_SCAN_INTERVAL_MS = DAY_MS

/** Clamp the scan cadence to [1h, 7d]; default daily. */
export function dateReminderScanIntervalMs(config: Partial<ScheduleDateFieldConfig>): number {
  const raw = typeof config.scanIntervalMs === 'number' ? config.scanIntervalMs : DEFAULT_DATE_REMINDER_SCAN_INTERVAL_MS
  const MIN = 60 * 60 * 1000
  const MAX = 7 * DAY_MS
  if (!Number.isFinite(raw) || raw < MIN) return MIN
  if (raw > MAX) return MAX
  return Math.floor(raw)
}

/** Parse 'HH:mm' → minutes-since-midnight, or 540 (09:00) on junk. */
function parseTimeOfDayMinutes(timeOfDay: string | undefined): number {
  if (typeof timeOfDay !== 'string') return 9 * 60
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim())
  if (!m) return 9 * 60
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return 9 * 60
  return hh * 60 + mm
}

/**
 * PURE occurrence: the instant a record's reminder should fire, day-bucketed in UTC. Returns an ISO string,
 * or null if the date value is absent/unparseable. NEVER reads NOW.
 */
export function computeDateReminderOccurrence(
  dateValue: unknown,
  config: { offsetDays?: number; direction?: 'before' | 'after'; timeOfDay?: string },
): string | null {
  if (dateValue === null || dateValue === undefined || dateValue === '') return null
  const d = dateValue instanceof Date ? dateValue : new Date(String(dateValue))
  const t = d.getTime()
  if (Number.isNaN(t)) return null

  // Day-bucket: strip the source time-of-day to UTC midnight, then shift by whole days.
  const dayUtcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const offset = Number.isFinite(config.offsetDays) ? Math.trunc(config.offsetDays) : 0
  const signedDays = config.direction === 'after' ? offset : -offset
  const reminderDay = dayUtcMidnight + signedDays * DAY_MS
  const occurrenceMs = reminderDay + parseTimeOfDayMinutes(config.timeOfDay) * 60 * 1000
  return new Date(occurrenceMs).toISOString()
}

/**
 * PURE firing-window predicate. A record's occurrence fires iff:
 *   - it is DUE (`occurrence <= now`), AND
 *   - it is within the recent scan window (`occurrence > now - scanWindowMs`) — so a fresh rule on a sheet of
 *     long-past records does NOT backfill-blast, and a replica that was down longer than the window skips
 *     missed reminders rather than replaying history, AND
 *   - it is at/after the rule's creation (`occurrence >= ruleCreatedAtMs`) — a rule never reaches into the
 *     past relative to when it was authored.
 * `scanWindowMs` should be the scan cadence plus grace (see `dateReminderScanWindowMs`). At-most-once by
 * construction (paired with claim-then-fire). All bounds are explicit product semantics, locked by goldens.
 */
export function isDateReminderDue(
  occurrenceIso: string,
  nowMs: number,
  scanWindowMs: number,
  ruleCreatedAtMs: number,
): boolean {
  const occ = new Date(occurrenceIso).getTime()
  if (Number.isNaN(occ)) return false
  if (occ > nowMs) return false // not yet due
  if (occ <= nowMs - scanWindowMs) return false // older than the recent window — never backfill
  if (occ < ruleCreatedAtMs) return false // rule does not reach into the past
  return true
}

/** The recent window = one scan cadence + a grace multiple, so a single missed tick still catches up. */
export function dateReminderScanWindowMs(scanIntervalMs: number): number {
  return scanIntervalMs * 2
}

/**
 * PURE coarse date-VALUE range for the SQL pre-filter. Only records whose date field falls in this window
 * can possibly produce an occurrence in the firing window, so SQL fetches just those (ISO strings sort
 * chronologically → a plain string BETWEEN works, no cast that could throw on legacy junk). Deliberately
 * GENEROUS (±2 day slack for day-bucketing + timeOfDay); the JS predicate (`isDateReminderDue`) is the exact
 * gate. Returns inclusive ISO bounds.
 */
export function dateReminderCandidateDateRange(
  nowMs: number,
  config: { offsetDays?: number; direction?: 'before' | 'after' },
  scanWindowMs: number,
): { loIso: string; hiIso: string } {
  const offset = Number.isFinite(config.offsetDays) ? Math.trunc(config.offsetDays) : 0
  const signedDays = config.direction === 'after' ? offset : -offset
  // occurrence = dateDay + signedDays*DAY (+timeOfDay). Inverting: dateDay = occurrence - signedDays*DAY.
  // occurrence ∈ (now - window, now]  ⇒  dateDay ∈ (now - window, now] - signedDays*DAY. Add ±2d slack.
  const SLACK = 2 * DAY_MS
  const occLo = nowMs - scanWindowMs
  const occHi = nowMs
  const lo = occLo - signedDays * DAY_MS - SLACK
  const hi = occHi - signedDays * DAY_MS + SLACK
  return { loIso: new Date(lo).toISOString(), hiIso: new Date(hi).toISOString() }
}
