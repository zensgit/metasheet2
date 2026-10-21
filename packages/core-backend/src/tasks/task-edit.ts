/**
 * Task feature — create/edit field rules for M4 PR-3a (R03): dates, time zone, `remindAt`,
 * `description`, `title` on edit, and `expectedVersion`. PURE, no I/O, no implicit clock.
 *
 * Design: docs/development/task-m4-pr3a-backend-design-20260930.md §5.1–§5.3, §4.4, §4.5
 *
 * Date and time validity is decided by `computeDueAt` (called in try/catch, its RangeError becomes
 * a reason here); time-zone validity and canonical naming by `validateViewerTimeZoneHeader`. This
 * module adds no `Intl` call of its own (D12) and no second date/time regex.
 *
 * RULED(2026-10-07): [R03] POST accepts the date keys, `timeZone` and `remindAt`; PATCH edits
 * `title`, `description`, the date keys, `timeZone` and `remindAt` under a required
 * `expectedVersion`. ASSUMPTION(task-m4): [D7] the stored zone is the canonical name.
 */
import { computeDueAt, validateViewerTimeZoneHeader } from './task-dates'
import { isStorableText, normalizeUserText } from './task-ids'
import { computeDefaultRemindAt, type TaskRemindPolicy } from './task-reminders'

// ASSUMPTION(task-m4): [own-08] description upper bound in code points; not trimmed; '' is stored
// as NULL.
export const TASK_DESCRIPTION_MAX_CODEPOINTS = 20000

export type TaskEditReason =
  | 'invalid_title'
  | 'invalid_description'
  | 'invalid_date'
  | 'invalid_time_zone'
  | 'time_zone_required'
  | 'invalid_remind_at'
  | 'invalid_version'

/** The four date columns plus the zone, in their canonical stored spelling. */
export interface TaskDateFields {
  /** `YYYY-MM-DD` or null. */
  dueDate: string | null
  /** `HH:MM:SS` or null. */
  dueTime: string | null
  startDate: string | null
  startTime: string | null
  /** Canonical IANA name or null. */
  timeZone: string | null
}

export const TASK_EMPTY_DATE_FIELDS: Readonly<TaskDateFields> = Object.freeze({
  dueDate: null,
  dueTime: null,
  startDate: null,
  startTime: null,
  timeZone: null,
})

/** Request-side keys; `undefined` means the key is absent (JSON has no `undefined`). */
export interface TaskDateInput {
  dueDate?: unknown
  dueTime?: unknown
  startDate?: unknown
  startTime?: unknown
  timeZone?: unknown
}

const DATE_KEYS = ['dueDate', 'dueTime', 'startDate', 'startTime'] as const

// ── expectedVersion ───────────────────────────────────────────────────────────────────────────

/** A positive safe integer JSON number; anything else (string, float, 0, missing) is invalid. */
export function parseExpectedVersion(raw: unknown): { ok: true; version: number } | { ok: false; reason: 'invalid_version' } {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
    return { ok: false, reason: 'invalid_version' }
  }
  return { ok: true, version: raw }
}

// ── remindAt ──────────────────────────────────────────────────────────────────────────────────

// ASSUMPTION(task-m4): [own-30] `remindAt` grammar: `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by `Z`
// or `±HH:MM`, uppercase `T` / `Z`, at most three fraction digits (the stored precision is
// milliseconds, so a longer fraction would be silently truncated), a real calendar date, and a
// resulting instant in years 0001–9999. The platform's lenient date parser is never used.
const REMIND_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/

function parseInstant(value: string): Date | null {
  const m = REMIND_AT_RE.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, '0'))
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  const wall = new Date(0)
  wall.setUTCFullYear(year, month - 1, day)
  wall.setUTCHours(hour, minute, second, ms)
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) return null
  let offsetMinutes = 0
  if (m[8] !== 'Z') {
    const offsetHours = Number(m[10])
    const offsetMins = Number(m[11])
    if (offsetHours > 23 || offsetMins > 59) return null
    offsetMinutes = (m[9] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMins)
  }
  const instant = new Date(wall.getTime() - offsetMinutes * 60000)
  const instantYear = instant.getUTCFullYear()
  if (instantYear < 1 || instantYear > 9999) return null
  return instant
}

export type ParseRemindAtResult =
  | { ok: true; remindAt: Date | null | undefined }
  | { ok: false; reason: 'invalid_remind_at' }

/** `undefined` ⇒ absent; `null` ⇒ explicitly none; a string ⇒ the instant it names. */
export function parseRemindAtInput(raw: unknown): ParseRemindAtResult {
  if (raw === undefined) return { ok: true, remindAt: undefined }
  if (raw === null) return { ok: true, remindAt: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_remind_at' }
  const instant = parseInstant(raw)
  return instant === null ? { ok: false, reason: 'invalid_remind_at' } : { ok: true, remindAt: instant }
}

// ── dates ─────────────────────────────────────────────────────────────────────────────────────

export type PlanTaskDatesResult =
  | { ok: true; next: TaskDateFields; dueAt: Date | null; touchedDates: boolean }
  | { ok: false; reason: 'invalid_date' | 'invalid_time_zone' | 'time_zone_required' }

function validDate(date: string): boolean {
  try {
    computeDueAt({ dueDate: date, dueTime: null, timeZone: 'UTC' })
    return true
  } catch {
    return false
  }
}

/** `HH:MM` / `HH:MM:SS` → `HH:MM:SS`, or null when `computeDueAt` rejects it. */
function canonicalTime(date: string, time: string): string | null {
  try {
    computeDueAt({ dueDate: date, dueTime: time, timeZone: 'UTC' })
  } catch {
    return null
  }
  return time.length === 5 ? `${time}:00` : time
}

// ASSUMPTION(task-m4): [own-07] a request that touches any of the four date keys, and leaves the
// task with a date, must carry a non-empty `timeZone` in the same body; clearing a date never
// clears its time implicitly; no "start before due" rule.
// ASSUMPTION(task-m4): [own-29] the empty string `timeZone` is read as `null` (no zone): with a
// date left on the task it is TIME_ZONE_REQUIRED, with none it clears the zone. Any other string
// that is not a named IANA zone (whitespace-only included) is INVALID_TIME_ZONE.
/**
 * Merges the date keys of `input` onto `current` (absent = keep, `null` = clear) and validates the
 * result. Step 1, before anything else, is a type gate: each date key, when present, is `null` or
 * a non-empty string (anything else ⇒ `invalid_date`), and `timeZone` is `null` or a string
 * (otherwise `invalid_time_zone`). Never throws for request data.
 */
export function planTaskDates(current: TaskDateFields, input: TaskDateInput): PlanTaskDatesResult {
  for (const key of DATE_KEYS) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string' || value.length === 0) return { ok: false, reason: 'invalid_date' }
  }
  if (input.timeZone !== undefined && input.timeZone !== null && typeof input.timeZone !== 'string') {
    return { ok: false, reason: 'invalid_time_zone' }
  }

  const pick = (key: (typeof DATE_KEYS)[number]): string | null => {
    const value = input[key]
    return value === undefined ? current[key] : (value as string | null)
  }
  const dueDate = pick('dueDate')
  const rawDueTime = pick('dueTime')
  const startDate = pick('startDate')
  const rawStartTime = pick('startTime')

  if (dueDate !== null && !validDate(dueDate)) return { ok: false, reason: 'invalid_date' }
  if (startDate !== null && !validDate(startDate)) return { ok: false, reason: 'invalid_date' }
  if (rawDueTime !== null && dueDate === null) return { ok: false, reason: 'invalid_date' }
  if (rawStartTime !== null && startDate === null) return { ok: false, reason: 'invalid_date' }
  const dueTime = rawDueTime === null ? null : canonicalTime(dueDate as string, rawDueTime)
  if (rawDueTime !== null && dueTime === null) return { ok: false, reason: 'invalid_date' }
  const startTime = rawStartTime === null ? null : canonicalTime(startDate as string, rawStartTime)
  if (rawStartTime !== null && startTime === null) return { ok: false, reason: 'invalid_date' }

  // `undefined` = key absent; `null` = explicitly no zone ('' is read the same way, [own-29]).
  const zoneInput: string | null | undefined = input.timeZone === '' ? null : (input.timeZone as string | null | undefined)
  let timeZone = current.timeZone
  if (zoneInput !== undefined) {
    if (zoneInput === null) {
      timeZone = null
    } else {
      const canonical = validateViewerTimeZoneHeader(zoneInput)
      if (canonical === null) return { ok: false, reason: 'invalid_time_zone' }
      timeZone = canonical
    }
  }

  const hasDate = dueDate !== null || startDate !== null
  const touchedDates = DATE_KEYS.some((key) => input[key] !== undefined)
  if (hasDate && timeZone === null) return { ok: false, reason: 'time_zone_required' }
  if (hasDate && touchedDates && (zoneInput === undefined || zoneInput === null)) {
    return { ok: false, reason: 'time_zone_required' }
  }

  // `timeZone` is either validated above or the stored value; a stored value the platform no
  // longer accepts surfaces as a reason, not as a throw.
  let dueAt: Date | null = null
  if (dueDate !== null) {
    try {
      dueAt = computeDueAt({ dueDate, dueTime, timeZone: timeZone as string })
    } catch {
      return { ok: false, reason: 'invalid_time_zone' }
    }
    // ASSUMPTION(task-m4): [own-38] the derived due instant must not pass the end of year 9999 (the
    // top of the instant range [own-30] gives `remindAt`); a due date whose instant does is
    // INVALID_DATE. There is no lower check: `computeDueAt` accepts due dates from 0100-01-01 on
    // (its calendar probe rejects years 0000–0099), and no time zone moves such a date's instant
    // below year 0099, inside the range.
    if (dueAt.getUTCFullYear() > 9999) return { ok: false, reason: 'invalid_date' }
  }
  return { ok: true, next: { dueDate, dueTime, startDate, startTime, timeZone }, dueAt, touchedDates }
}

// ── create-time remind_at (lock §4.4 default algorithm) ──────────────────────────────────────

/** True when creation must read the creator's `default_remind_policy`: no `remindAt` key and a due date. */
export function needsDefaultRemindPolicy(input: { remindAt: Date | null | undefined; dueDate: string | null }): boolean {
  return input.remindAt === undefined && input.dueDate !== null
}

/**
 * Create-time `remind_at`: an explicit `remindAt` (instant or `null`) wins; otherwise no due date ⇒
 * `null`; otherwise the lock §4.4 default from the creator's policy, in the TASK's own zone (never
 * a viewer zone). `policy` is required exactly when `needsDefaultRemindPolicy` is true.
 */
export function resolveCreateRemindAt(input: {
  remindAt: Date | null | undefined
  dates: TaskDateFields
  dueAt: Date | null
  policy: TaskRemindPolicy | null
}): Date | null {
  if (input.remindAt !== undefined) return input.remindAt
  if (input.dates.dueDate === null) return null
  if (input.policy === null) throw new TypeError('resolveCreateRemindAt: a default reminder needs the creator policy')
  return computeDefaultRemindAt({
    dueDate: input.dates.dueDate,
    dueTime: input.dates.dueTime,
    dueAt: input.dueAt,
    timeZone: input.dates.timeZone as string,
    policy: input.policy,
  })
}

// ── PATCH ─────────────────────────────────────────────────────────────────────────────────────

export interface TaskEditableState extends TaskDateFields {
  title: string
  description: string | null
  dueAt: Date | null
  remindAt: Date | null
}

export interface TaskPatchInput extends TaskDateInput {
  title?: unknown
  description?: unknown
  remindAt?: unknown
}

/** Closed task-event words a PATCH can write, in the order they are written. */
export type TaskPatchEventType =
  | 'title_changed'
  | 'description_changed'
  | 'due_changed'
  | 'start_changed'
  | 'remind_changed'

export type PlanTaskPatchResult =
  | { ok: true; next: TaskEditableState; changed: boolean; events: TaskPatchEventType[] }
  | { ok: false; reason: Exclude<TaskEditReason, 'invalid_version'> }

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right
  return left.getTime() === right.getTime()
}

function codePointLength(value: string): number {
  let n = 0
  for (const _ of value) n += 1
  return n
}

// ASSUMPTION(task-m4): [own-31] `description` is stored exactly as sent (no NFC normalization,
// no trimming); U+0000 and lone surrogates are INVALID_DESCRIPTION, the same storable-text rule as
// titles and comment bodies.
// ASSUMPTION(task-m4): [own-06] PATCH never derives `remind_at`: an absent key leaves it, `null`
// clears it, an instant sets it. Moving the due date without `remindAt` leaves the reminder where
// it was (design §12-Q2).
// ASSUMPTION(task-m4): [own-18] one event per changed surface, payload `{}`; a zone change counts
// for `due_changed` / `start_changed` only when the task has that date; a zone-only change on a
// task with no dates is a change (version + 1) with no event.
/**
 * Merges `input` onto `current` key by key (absent = keep; `null` = clear, except `title`), runs the
 * §5.1 checks in the order title → description → dates → remindAt, recomputes `dueAt`, and lists
 * the changed surfaces. `changed` is false exactly when every stored column would be unchanged.
 */
export function planTaskPatch(current: TaskEditableState, input: TaskPatchInput): PlanTaskPatchResult {
  let title = current.title
  if (input.title !== undefined) {
    const normalized = normalizeUserText(input.title)
    if (normalized === null || !isStorableText(normalized)) return { ok: false, reason: 'invalid_title' }
    title = normalized
  }

  let description = current.description
  if (input.description !== undefined) {
    if (input.description === null) {
      description = null
    } else if (typeof input.description !== 'string' || !isStorableText(input.description)) {
      return { ok: false, reason: 'invalid_description' }
    } else if (codePointLength(input.description) > TASK_DESCRIPTION_MAX_CODEPOINTS) {
      return { ok: false, reason: 'invalid_description' }
    } else {
      description = input.description.length === 0 ? null : input.description
    }
  }

  const dates = planTaskDates(current, input)
  if (dates.ok === false) return { ok: false, reason: dates.reason }

  const remind = parseRemindAtInput(input.remindAt)
  if (remind.ok === false) return { ok: false, reason: 'invalid_remind_at' }
  const remindAt = remind.remindAt === undefined ? current.remindAt : remind.remindAt

  const next: TaskEditableState = { ...dates.next, title, description, dueAt: dates.dueAt, remindAt }
  const zoneChanged = next.timeZone !== current.timeZone
  const events: TaskPatchEventType[] = []
  if (next.title !== current.title) events.push('title_changed')
  if (next.description !== current.description) events.push('description_changed')
  if (next.dueDate !== current.dueDate || next.dueTime !== current.dueTime || (zoneChanged && next.dueDate !== null)) {
    events.push('due_changed')
  }
  if (next.startDate !== current.startDate || next.startTime !== current.startTime || (zoneChanged && next.startDate !== null)) {
    events.push('start_changed')
  }
  if (!sameInstant(next.remindAt, current.remindAt)) events.push('remind_changed')
  const changed = events.length > 0 || zoneChanged || !sameInstant(next.dueAt, current.dueAt)
  return { ok: true, next, changed, events }
}
