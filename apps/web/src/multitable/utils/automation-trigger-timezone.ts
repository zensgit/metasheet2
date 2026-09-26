// A7a (客户反馈 2026-09-24 #4c, 裁定见 PR #6074): schedule triggers (`schedule.date_field` reminders and
// `schedule.cron`) are authored in ONE business timezone — never the browser's local zone — and shown on a
// 24-hour clock. The backend has honoured `triggerConfig.timezone` since T2-5 (#3401: absent / 'UTC' /
// 'Etc/UTC' = UTC, any valid IANA zone = that zone's local wall-clock), but the editor never wrote it, so every
// rule saved before this change has been firing on UTC.
//
// Two rules this module owns, both PURE (no DOM, no locale, no NOW unless passed in):
//   1. NEW schedule configuration is saved with the business timezone.
//   2. A SAVED rule that already has this schedule type and no stored timezone (it has been firing on UTC)
//      keeps omitting the key on every edit. Silently stamping the business zone onto it would move its fire
//      time by the zone's offset (8h for Asia/Shanghai). Only the explicit "switch to business time" action
//      (which also re-expresses the stored time) may change it.
//
// The copy for all of this lives in meta-automation-labels.ts; this module is only the time math.

/** Default business timezone. Read it through `automationBusinessTimezone()`, never directly. */
export const DEFAULT_AUTOMATION_BUSINESS_TIMEZONE = 'Asia/Shanghai'

/**
 * The ONE place the automation editor learns the business timezone. A tenant/instance setting (A7b) can be
 * swapped in here without touching the editor or the labels.
 */
export function automationBusinessTimezone(): string {
  return DEFAULT_AUTOMATION_BUSINESS_TIMEZONE
}

/** Trigger types whose config carries a `timezone` the backend honours. */
export const TIMEZONE_AWARE_TRIGGER_TYPES = ['schedule.date_field', 'schedule.cron'] as const

export function isTimezoneAwareTriggerType(type: unknown): boolean {
  return typeof type === 'string' && (TIMEZONE_AWARE_TRIGGER_TYPES as readonly string[]).includes(type)
}

/** A stored/draft timezone value → trimmed non-empty string, or undefined for absent/blank/non-string. */
export function normalizeTriggerTimezone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const tz = raw.trim()
  return tz ? tz : undefined
}

/** Mirrors the backend's UTC set: absent / 'UTC' / 'Etc/UTC'. */
export function isUtcTriggerTimezone(tz: string | undefined): boolean {
  return tz === undefined || tz === 'UTC' || tz === 'Etc/UTC'
}

export interface StoredScheduleRuleLike {
  id?: string | null
  triggerType?: string | null
  triggerConfig?: Record<string, unknown> | null
  trigger?: { type?: string | null; config?: Record<string, unknown> | null } | null
}

/** The stored trigger config, merged the same way the editor's draftFromRule does. */
function storedTriggerConfig(rule: StoredScheduleRuleLike): Record<string, unknown> {
  return { ...(rule.triggerConfig ?? {}), ...(rule.trigger?.config ?? {}) }
}

/**
 * LEGACY = a SAVED rule (it has an id) whose stored trigger type is `triggerType`, with no stored timezone.
 * The backend has been firing it on UTC. A rule being switched INTO this trigger type from another type is
 * NOT legacy: that is new schedule configuration.
 */
export function isLegacyUtcScheduleRule(
  rule: StoredScheduleRuleLike | null | undefined,
  triggerType: string,
): boolean {
  if (!rule || !rule.id) return false
  if (!isTimezoneAwareTriggerType(triggerType)) return false
  if (rule.triggerType !== triggerType) return false
  return normalizeTriggerTimezone(storedTriggerConfig(rule).timezone) === undefined
}

/**
 * The timezone the save payload must carry for this trigger, or `undefined` = write nothing (leave the key as
 * the draft has it, i.e. absent for a legacy UTC rule).
 */
export function triggerTimezoneForSave(input: {
  triggerType: string
  draftTimezone: unknown
  storedRule: StoredScheduleRuleLike | null | undefined
}): string | undefined {
  if (!isTimezoneAwareTriggerType(input.triggerType)) return undefined
  const explicit = normalizeTriggerTimezone(input.draftTimezone)
  if (explicit) return explicit
  // LEGACY-PRESERVE GUARD: a saved rule that has been firing on UTC is never re-stamped silently.
  if (isLegacyUtcScheduleRule(input.storedRule, input.triggerType)) return undefined
  return automationBusinessTimezone()
}

/** The timezone the backend WILL use for this trigger after save (for display). Absent = 'UTC'. */
export function effectiveTriggerTimezone(input: {
  triggerType: string
  draftTimezone: unknown
  storedRule: StoredScheduleRuleLike | null | undefined
}): string {
  return triggerTimezoneForSave(input) ?? 'UTC'
}

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})$/

/** 'H:mm' / 'HH:mm' → { hour, minute }, or null on junk (the backend then uses its 09:00 default). */
export function parseTriggerTimeOfDay(raw: unknown): { hour: number; minute: number } | null {
  if (typeof raw !== 'string') return null
  const m = TIME_OF_DAY_RE.exec(raw.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTriggerTimeOfDay(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`
}

/**
 * The time the backend will actually use: a valid time, else its 09:00 default
 * (automation-date-reminder.ts parseTimeOfDayMinutes: junk/absent → 540 = 09:00, in the rule's timezone).
 */
function effectiveTriggerTimeParts(raw: unknown): { hour: number; minute: number } {
  return parseTriggerTimeOfDay(raw) ?? { hour: 9, minute: 0 }
}

/** The time the backend will actually use: a valid 'HH:mm' (zero-padded), else its 09:00 default. */
export function effectiveTriggerTimeOfDay(raw: unknown): string {
  const parsed = effectiveTriggerTimeParts(raw)
  return formatTriggerTimeOfDay(parsed.hour, parsed.minute)
}

/**
 * 24-hour picker options: 00:00 … 23:45 in 15-minute steps, plus the current value when it is a valid
 * off-grid time (a stored '09:07' must stay visible and selected, never silently snapped).
 */
export function triggerTimeOfDayOptions(current: unknown): string[] {
  const options: string[] = []
  for (let h = 0; h < 24; h += 1) {
    for (let m = 0; m < 60; m += 15) options.push(formatTriggerTimeOfDay(h, m))
  }
  // The stored string itself (not a normalized copy), so the select's model value always has an option.
  if (typeof current === 'string' && parseTriggerTimeOfDay(current) && !options.includes(current)) {
    options.push(current)
    options.sort()
  }
  return options
}

interface ZonedWallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function zonedWallClock(ms: number, timezone: string): ZonedWallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute') }
}

/**
 * The wall-clock in `timezone` of the instant `utcTimeOfDay` UTC on the reference day. `dayShift` is how
 * many civil days that wall-clock moved (+1 = next day, -1 = previous day). Empty/junk input = the backend's
 * 09:00 default. Asia/Shanghai has no DST, so the reference day is irrelevant for it; for a DST zone the
 * result is "as of the reference day".
 */
export function utcTimeOfDayInZone(
  utcTimeOfDay: unknown,
  timezone: string,
  referenceMs: number = Date.now(),
): { time: string; dayShift: number } {
  const parsed = effectiveTriggerTimeParts(utcTimeOfDay)
  const ref = new Date(referenceMs)
  const instant = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), parsed.hour, parsed.minute)
  if (isUtcTriggerTimezone(timezone)) return { time: formatTriggerTimeOfDay(parsed.hour, parsed.minute), dayShift: 0 }
  const local = zonedWallClock(instant, timezone)
  const localDay = Date.UTC(local.year, local.month - 1, local.day)
  const utcDay = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())
  return {
    time: formatTriggerTimeOfDay(local.hour, local.minute),
    dayShift: Math.round((localDay - utcDay) / 86_400_000),
  }
}

/**
 * The explicit "switch to business time" conversion for a legacy UTC date reminder: the SAME instant
 * re-expressed in the business zone ((hh + 8) mod 24 for Asia/Shanghai). An empty time was the backend's
 * 09:00 UTC default, so it becomes 17:00. `dayShift` = 1 when the converted time crossed midnight — the
 * reminder DAY does not move with it, so such a reminder fires one day earlier than before.
 */
export function convertLegacyUtcTimeOfDay(
  utcTimeOfDay: unknown,
  businessTimezone: string = automationBusinessTimezone(),
  referenceMs: number = Date.now(),
): { timeOfDay: string; dayShift: number } {
  const { time, dayShift } = utcTimeOfDayInZone(utcTimeOfDay, businessTimezone, referenceMs)
  return { timeOfDay: time, dayShift }
}

/** Fixed sample anchor for the live example line (Sep 30): deterministic, never "today". */
const SAMPLE_ANCHOR = { year: 2026, month: 9, day: 30 }
const MAX_SAMPLE_OFFSET_DAYS = 36500

export interface DateReminderExample {
  anchor: { year: number; month: number; day: number }
  reminder: { year: number; month: number; day: number }
  offsetDays: number
  direction: 'before' | 'after'
  /** The configured time in the rule's own timezone. */
  time: string
  /** Business-zone wall-clock of the fire instant. Converted only for a UTC rule; else equals `reminder`/`time`. */
  business: { year: number; month: number; day: number; time: string }
}

/**
 * The live example for the reminder panel: "date Sep 30, 3 days before → Sep 27 09:00". Computed for a
 * date-only field (the literal calendar day), matching computeDateReminderOccurrence's floating path.
 */
export function dateReminderExample(input: {
  offsetDays: unknown
  direction: unknown
  timeOfDay: unknown
  timezone: string
  businessTimezone: string
}): DateReminderExample {
  const rawOffset = Number(input.offsetDays)
  const offsetDays = Number.isFinite(rawOffset)
    ? Math.min(MAX_SAMPLE_OFFSET_DAYS, Math.max(0, Math.trunc(rawOffset)))
    : 0
  const direction = input.direction === 'after' ? 'after' : 'before'
  const shifted = new Date(Date.UTC(
    SAMPLE_ANCHOR.year,
    SAMPLE_ANCHOR.month - 1,
    SAMPLE_ANCHOR.day + (direction === 'after' ? offsetDays : -offsetDays),
  ))
  const reminder = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
  const time = effectiveTriggerTimeOfDay(input.timeOfDay)
  let business = { ...reminder, time }
  if (isUtcTriggerTimezone(input.timezone) && !isUtcTriggerTimezone(input.businessTimezone)) {
    const parsed = effectiveTriggerTimeParts(time)
    const instant = Date.UTC(reminder.year, reminder.month - 1, reminder.day, parsed.hour, parsed.minute)
    const local = zonedWallClock(instant, input.businessTimezone)
    business = {
      year: local.year,
      month: local.month,
      day: local.day,
      time: formatTriggerTimeOfDay(local.hour, local.minute),
    }
  }
  return { anchor: { ...SAMPLE_ANCHOR }, reminder, offsetDays, direction, time, business }
}
