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
  /**
   * @deprecated v1 IGNORES this (DR-D). Scheduling is `timeOfDay`-aligned daily (see automation-scheduler),
   * and the dedup/backfill window is the fixed `DATE_REMINDER_GRACE_WINDOW_MS` constant — neither rides on a
   * per-rule cadence knob. Retained only so older persisted rules don't break; it drives nothing.
   */
  scanIntervalMs?: number
}

/**
 * The dedup/backfill RECENT WINDOW — FIXED, decoupled from any per-rule cadence (DR-D). An occurrence fires
 * only if it is within this window of NOW (and `>= ruleCreatedAt`), so a fresh rule never backfill-blasts and
 * a leader down longer than the window skips missed reminders (the documented at-most-once tradeoff). 48h =
 * 2× the daily scan grace; a script-set `scanIntervalMs` can no longer silently distort it.
 */
export const DATE_REMINDER_GRACE_WINDOW_MS = 2 * DAY_MS

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

/** Today's UTC `timeOfDay` boundary (ms epoch) for the calendar day containing `nowMs`. PURE. */
function utcTimeOfDayBoundaryMs(nowMs: number, timeOfDay: string | undefined): number {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + parseTimeOfDayMinutes(timeOfDay) * 60 * 1000
}

/**
 * DR-A: ms from `nowMs` until the NEXT UTC `timeOfDay` boundary (today's if still ahead, else tomorrow's).
 * The scheduler arms a `setTimeout` to this instant and re-arms each day, so the scan runs at ~the configured
 * time rather than anchored to server-boot time. PURE.
 */
export function nextDateReminderTimerDelayMs(timeOfDay: string | undefined, nowMs: number): number {
  const today = utcTimeOfDayBoundaryMs(nowMs, timeOfDay)
  const target = today > nowMs ? today : today + DAY_MS
  return target - nowMs
}

/**
 * DR-B: has today's UTC `timeOfDay` boundary already passed at `nowMs`? When true at register/restart the
 * scheduler runs ONE immediate catch-up scan — still gated by the firing window + `ruleCreatedAt`, so it can
 * never backfill-blast — so a deploy after the configured time still delivers today's reminders. PURE.
 */
export function dateReminderTimeOfDayPassed(timeOfDay: string | undefined, nowMs: number): boolean {
  return utcTimeOfDayBoundaryMs(nowMs, timeOfDay) <= nowMs
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
 * `scanWindowMs` is the fixed `DATE_REMINDER_GRACE_WINDOW_MS` grace (DR-D — decoupled from any per-rule
 * cadence). At-most-once by construction (paired with claim-then-fire). All bounds are explicit product
 * semantics, locked by goldens.
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
