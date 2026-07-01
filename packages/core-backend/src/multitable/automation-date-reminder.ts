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
 * Timezone (T2-5): the day-bucket honors `config.timezone`. With timezone absent / 'UTC' / 'Etc/UTC' the
 * occurrence is bucketed in UTC EXACTLY as before (no behaviour change). With a valid non-UTC IANA zone the
 * source date's LOCAL calendar day is taken, shifted by ±offsetDays as civil days, then `timeOfDay` is the
 * LOCAL wall-clock on the reminder day, converted back to a UTC instant. A persisted-junk tz never throws —
 * it falls back to UTC bucketing. Editing a rule's timezone re-buckets `occurrence_ts`, so a bounded one-time
 * re-fire is possible (Q5, accepted); historical ledger rows are never rewritten.
 */

import { getZonedParts, isValidIanaTimeZone, zonedWallClockToUtcMs } from './automation-timezone'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Resolve a date-reminder timezone: a valid non-UTC IANA zone → that zone; absent / 'UTC' / 'Etc/UTC' /
 * invalid → `null` = the UTC path. PURE; never throws (invalid is filtered here, so the zoned helpers below
 * only ever run with a known-good zone, and a junk persisted tz degrades to UTC instead of mis-firing).
 */
function resolveReminderTimeZone(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const tz = raw.trim()
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return null
  if (!isValidIanaTimeZone(tz)) return null
  return tz
}

export interface ScheduleDateFieldConfig {
  /** The DATE/dateTime field whose value anchors the reminder. */
  dateFieldId: string
  /** Whole days before/after the date value. >= 0. */
  offsetDays: number
  /** Fire this many days BEFORE the date, or AFTER it. */
  direction: 'before' | 'after'
  /** When on the reminder day to fire, 'HH:mm' in `timezone` (LOCAL wall-clock). Default '09:00'. */
  timeOfDay?: string
  /** IANA timezone for the day-bucket + timeOfDay (T2-5). Absent/'UTC' = UTC bucketing. Invalid → UTC. */
  timezone?: string
  /**
   * SERVER-SET activation instant (ISO): when this rule BECAME a date-reminder (create-as-date_field or a
   * conversion from another trigger). The firing floor is `max(rule.createdAt, effectiveAt)`, so a rule
   * converted from a months-old automation never backfills occurrences from before its conversion. Never
   * client-trusted — overwritten on activation, preserved verbatim while the rule stays date_field. Absent on
   * pre-fix rules ⇒ the floor falls back to `createdAt`.
   */
  effectiveAt?: string
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

/**
 * Sanity cap for `offsetDays` (whole days before/after the date value). 100 years is far beyond any real
 * reminder and keeps the candidate-range math (`nowMs ± signedDays*DAY ± slack`) safely inside the JS Date
 * range — an uncapped value (e.g. 1e12) overflows `new Date(ms).toISOString()` with a RangeError and aborts
 * the whole scan for that rule. Enforced fail-closed at save (validateDateFieldTriggerAtSave).
 */
export const MAX_DATE_REMINDER_OFFSET_DAYS = 36500

/**
 * Runtime defense (mirrors the junk-tz "degrade, never throw" posture): the save cap only guards the API
 * path, so a PERSISTED out-of-range `offsetDays` (direct-DB write, or a rule saved before the cap existed)
 * would still overflow the occurrence/range math's `new Date(ms).toISOString()` and abort the WHOLE scan
 * for the rule. Clamp the magnitude here so a junk value degrades to a bounded (if meaningless) occurrence
 * instead of throwing. Junk/non-finite → 0.
 */
function clampOffsetDays(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  const t = Math.trunc(raw)
  return Math.max(-MAX_DATE_REMINDER_OFFSET_DAYS, Math.min(MAX_DATE_REMINDER_OFFSET_DAYS, t))
}

/**
 * Retain the date-reminder idempotency ledger for one year. The ledger is a dedupe/audit record, not user
 * content; rule deletion still cascades immediately, while long-lived active rules age by actual `fired_at`.
 */
export const DATE_REMINDER_LEDGER_RETENTION_DAYS = 365
export const DATE_REMINDER_LEDGER_RETENTION_MS = DATE_REMINDER_LEDGER_RETENTION_DAYS * DAY_MS
export const DATE_REMINDER_LEDGER_SWEEP_INTERVAL_MS = DAY_MS

/** PURE cutoff for ledger aging. Rows with fired_at older than this can be deleted. */
export function dateReminderLedgerRetentionCutoffIso(nowMs: number): string {
  return new Date(nowMs - DATE_REMINDER_LEDGER_RETENTION_MS).toISOString()
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

/** Today's UTC `timeOfDay` boundary (ms epoch) for the calendar day containing `nowMs`. PURE. */
function utcTimeOfDayBoundaryMs(nowMs: number, timeOfDay: string | undefined): number {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + parseTimeOfDayMinutes(timeOfDay) * 60 * 1000
}

/**
 * The `timeOfDay` boundary (ms epoch) on the LOCAL calendar day containing `nowMs`, expressed as a UTC instant.
 * tz must be a resolved, valid non-UTC zone. PURE; throws only on an invalid tz (caller guards/catches).
 */
function zonedTimeOfDayBoundaryMs(nowMs: number, timeOfDay: string | undefined, tz: string): number {
  const p = getZonedParts(nowMs, tz)
  const mins = parseTimeOfDayMinutes(timeOfDay)
  return zonedWallClockToUtcMs(
    { year: p.year, month: p.month, day: p.day, hour: Math.floor(mins / 60), minute: mins % 60, second: 0 },
    tz,
  )
}

/**
 * DR-A: ms from `nowMs` until the NEXT `timeOfDay` boundary (today's if still ahead, else tomorrow's). The
 * scheduler arms a `setTimeout` to this instant and re-arms each day, so the scan runs at ~the configured
 * LOCAL time rather than anchored to server-boot time. With no/UTC tz the math is UTC (UNCHANGED). With a
 * non-UTC zone "tomorrow" is the next LOCAL civil day (NOT today+24h — DST-safe), and a junk tz falls back to
 * the UTC math (never throws). PURE.
 */
export function nextDateReminderTimerDelayMs(
  timeOfDay: string | undefined,
  nowMs: number,
  timezone?: string,
): number {
  const tz = resolveReminderTimeZone(timezone)
  if (!tz) {
    const today = utcTimeOfDayBoundaryMs(nowMs, timeOfDay)
    const target = today > nowMs ? today : today + DAY_MS
    return target - nowMs
  }
  try {
    const today = zonedTimeOfDayBoundaryMs(nowMs, timeOfDay, tz)
    if (today > nowMs) return today - nowMs
    // Next LOCAL civil day's boundary (handles month/DST rollover; +DAY_MS on the UTC instant could drift).
    const p = getZonedParts(nowMs, tz)
    const nextCivil = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
    const mins = parseTimeOfDayMinutes(timeOfDay)
    const target = zonedWallClockToUtcMs(
      {
        year: nextCivil.getUTCFullYear(),
        month: nextCivil.getUTCMonth() + 1,
        day: nextCivil.getUTCDate(),
        hour: Math.floor(mins / 60),
        minute: mins % 60,
        second: 0,
      },
      tz,
    )
    return target - nowMs
  } catch {
    const today = utcTimeOfDayBoundaryMs(nowMs, timeOfDay)
    const target = today > nowMs ? today : today + DAY_MS
    return target - nowMs
  }
}

/**
 * DR-B: has today's `timeOfDay` boundary already passed at `nowMs`? When true at register/restart the
 * scheduler runs ONE immediate catch-up scan — still gated by the firing window + `ruleCreatedAt`, so it can
 * never backfill-blast — so a deploy after the configured time still delivers today's reminders. With no/UTC
 * tz the boundary is UTC (UNCHANGED); a non-UTC zone uses the LOCAL boundary; a junk tz falls back to UTC
 * (never throws). PURE.
 */
export function dateReminderTimeOfDayPassed(
  timeOfDay: string | undefined,
  nowMs: number,
  timezone?: string,
): boolean {
  const tz = resolveReminderTimeZone(timezone)
  if (!tz) return utcTimeOfDayBoundaryMs(nowMs, timeOfDay) <= nowMs
  try {
    return zonedTimeOfDayBoundaryMs(nowMs, timeOfDay, tz) <= nowMs
  } catch {
    return utcTimeOfDayBoundaryMs(nowMs, timeOfDay) <= nowMs
  }
}

/**
 * The literal calendar day of a FLOATING (date-only) value. A `date`-type field stores a bare 'YYYY-MM-DD'
 * (the date-picker output — field-codecs passes `date` values through un-normalized, only `dateTime` is
 * toISOString-normalized), so a date-only field has NO instant and its day must be read straight from the
 * string, NOT re-derived by parsing to a UTC instant and re-zoning (which shifts back a civil day in a
 * negative-offset zone). Falls back to the parsed instant's UTC parts for a Date object or a non-bare string
 * (a date-only value persisted as full-ISO-midnight still yields the right civil day). Month is 1-based to
 * match `getZonedParts`. PURE.
 */
function floatingCalendarDay(value: unknown, parsed: Date): { year: number; month: number; day: number } {
  if (typeof value === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
    if (m) {
      // Normalize through Date.UTC so any out-of-range component rolls over EXACTLY as the instant path would —
      // floating and instant never diverge on junk input (and unparseable values were already rejected above).
      const norm = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      return { year: norm.getUTCFullYear(), month: norm.getUTCMonth() + 1, day: norm.getUTCDate() }
    }
  }
  return { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() }
}

/**
 * PURE occurrence: the instant a record's reminder should fire, day-bucketed in `config.timezone` (UTC when
 * absent/'UTC'/invalid). Returns an ISO string, or null if the date value is absent/unparseable. NEVER reads
 * NOW. The UTC path is byte-identical to pre-T2-5; the zoned path day-buckets in LOCAL time and converts back.
 *
 * `opts.floating` (a `date`-type field): the value is a FLOATING calendar day with no instant, so the anchor
 * day is the LITERAL 'YYYY-MM-DD' (it does NOT move with timezone); `timeOfDay` is still placed as the LOCAL
 * wall-clock in `config.timezone`. Default (absent/false, a `dateTime` field) keeps the instant→local-day
 * semantics → BYTE-IDENTICAL for every existing caller. The day-source is the only difference; the civil-day
 * shift + timeOfDay conversion + junk-tz→UTC defense are shared.
 */
export function computeDateReminderOccurrence(
  dateValue: unknown,
  config: { offsetDays?: number; direction?: 'before' | 'after'; timeOfDay?: string; timezone?: string },
  opts: { floating?: boolean } = {},
): string | null {
  if (dateValue === null || dateValue === undefined || dateValue === '') return null
  const d = dateValue instanceof Date ? dateValue : new Date(String(dateValue))
  const t = d.getTime()
  if (Number.isNaN(t)) return null

  const offset = clampOffsetDays(config.offsetDays)
  const signedDays = config.direction === 'after' ? offset : -offset
  const tz = resolveReminderTimeZone(config.timezone)

  // FLOATING (date-only) → the literal calendar day; otherwise the day is derived from the instant per-path.
  const floatingDay = opts.floating ? floatingCalendarDay(dateValue, d) : null
  const utcDay = () =>
    floatingDay ?? { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }

  if (!tz) {
    // Day-bucket: strip the source time-of-day to UTC midnight, then shift by whole days. (UNCHANGED for
    // instant; for floating the literal day equals the UTC-midnight day, so this stays byte-identical too.)
    const base = utcDay()
    const dayUtcMidnight = Date.UTC(base.year, base.month - 1, base.day)
    const reminderDay = dayUtcMidnight + signedDays * DAY_MS
    const occurrenceMs = reminderDay + parseTimeOfDayMinutes(config.timeOfDay) * 60 * 1000
    return new Date(occurrenceMs).toISOString()
  }

  try {
    // Zoned day-bucket: the anchor day is the FLOATING literal day (date-only) or the instant's LOCAL calendar
    // day (dateTime); shift by whole CIVIL days, then set the LOCAL `timeOfDay` and convert back to a UTC instant.
    const p = floatingDay ?? getZonedParts(t, tz)
    const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + signedDays))
    const mins = parseTimeOfDayMinutes(config.timeOfDay)
    const occurrenceMs = zonedWallClockToUtcMs(
      {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: Math.floor(mins / 60),
        minute: mins % 60,
        second: 0,
      },
      tz,
    )
    return new Date(occurrenceMs).toISOString()
  } catch {
    // Runtime defense (Q6): a persisted-junk tz must never throw — degrade to UTC bucketing (floating-aware).
    const base = utcDay()
    const dayUtcMidnight = Date.UTC(base.year, base.month - 1, base.day)
    const reminderDay = dayUtcMidnight + signedDays * DAY_MS
    const occurrenceMs = reminderDay + parseTimeOfDayMinutes(config.timeOfDay) * 60 * 1000
    return new Date(occurrenceMs).toISOString()
  }
}

/**
 * PURE firing-window predicate. A record's occurrence fires iff:
 *   - it is DUE (`occurrence <= now`), AND
 *   - it is within the recent scan window (`occurrence > now - scanWindowMs`) — so a fresh rule on a sheet of
 *     long-past records does NOT backfill-blast, and a replica that was down longer than the window skips
 *     missed reminders rather than replaying history, AND
 *   - it is at/after the rule's FLOOR (`occurrence >= floorMs`) — a rule never reaches into the past relative
 *     to when it was authored AS A DATE-REMINDER. The floor is `dateReminderFloorMs` = max(createdAt,
 *     effectiveAt), so a rule CONVERTED from another trigger (old createdAt) never backfills before its
 *     conversion.
 * `scanWindowMs` is the fixed `DATE_REMINDER_GRACE_WINDOW_MS` grace (DR-D — decoupled from any per-rule
 * cadence). At-most-once by construction (paired with claim-then-fire). All bounds are explicit product
 * semantics, locked by goldens.
 */
export function isDateReminderDue(
  occurrenceIso: string,
  nowMs: number,
  scanWindowMs: number,
  floorMs: number,
): boolean {
  const occ = new Date(occurrenceIso).getTime()
  if (Number.isNaN(occ)) return false
  if (occ > nowMs) return false // not yet due
  if (occ <= nowMs - scanWindowMs) return false // older than the recent window — never backfill
  if (occ < floorMs) return false // rule does not reach before its authoring/activation
  return true
}

/**
 * The "no reach before authoring" FLOOR for a date-reminder = max(rule createdAt, the date-field activation
 * `effectiveAt`). `effectiveAt` is SERVER-SET when the rule becomes a date_field rule (create or conversion),
 * so a rule converted from a months-old automation does not treat its old `createdAt` as the floor and
 * backfill the recent window. Falls back to `createdAt` when `effectiveAt` is absent/unparseable (pre-fix
 * date_field rules, which were authored as date_field at createdAt). PURE.
 */
export function dateReminderFloorMs(ruleCreatedAtMs: number, effectiveAt: string | undefined): number {
  if (typeof effectiveAt !== 'string' || !effectiveAt) return ruleCreatedAtMs
  const eff = new Date(effectiveAt).getTime()
  return Number.isNaN(eff) ? ruleCreatedAtMs : Math.max(ruleCreatedAtMs, eff)
}

/**
 * PURE coarse date-VALUE range for the SQL pre-filter. Only records whose date field falls in this window
 * can possibly produce an occurrence in the firing window, so SQL fetches just those (ISO date strings sort
 * chronologically → a plain string BETWEEN works, no cast that could throw on legacy junk). Deliberately
 * GENEROUS (±2 day slack for day-bucketing + timeOfDay); the JS predicate (`isDateReminderDue`) is the exact
 * gate. Returns inclusive bounds.
 *
 * Bounds are DATE-ONLY and widened a day on each end so the lexicographic `data->>field BETWEEN lo AND hi` is
 * exact for BOTH a bare 'YYYY-MM-DD' (date-type, the date-picker output) AND a full-ISO
 * 'YYYY-MM-DDTHH:mm:ss.sssZ' (dateTime). A bare date equal to a full-ISO bound's day sorts BEFORE it (the bare
 * string is a prefix) and would be wrongly EXCLUDED at the exact boundary day; truncating lo to its civil day
 * (start) and extending hi to the day AFTER makes the range a strict SUPERSET of the old window on both ends,
 * so no record that should fire is ever dropped by the pre-filter, regardless of how its date value is stored.
 */
export function dateReminderCandidateDateRange(
  nowMs: number,
  config: { offsetDays?: number; direction?: 'before' | 'after' },
  scanWindowMs: number,
): { loIso: string; hiIso: string } {
  const offset = clampOffsetDays(config.offsetDays)
  const signedDays = config.direction === 'after' ? offset : -offset
  // occurrence = dateDay + signedDays*DAY (+timeOfDay). Inverting: dateDay = occurrence - signedDays*DAY.
  // occurrence ∈ (now - window, now]  ⇒  dateDay ∈ (now - window, now] - signedDays*DAY. Add ±2d slack.
  const SLACK = 2 * DAY_MS
  const occLo = nowMs - scanWindowMs
  const occHi = nowMs
  const lo = occLo - signedDays * DAY_MS - SLACK
  const hi = occHi - signedDays * DAY_MS + SLACK
  const dateOnly = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  // lo → start of its civil day (≤ a bare date that day); hi → the day AFTER (≥ any time component that day).
  return { loIso: dateOnly(lo), hiIso: dateOnly(hi + DAY_MS) }
}
