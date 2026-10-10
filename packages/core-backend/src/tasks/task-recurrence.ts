/**
 * Task feature — recurring tasks: the closed rule set and its parser, the next due date, the
 * spawn-on-completion decision and plan, set/clear transitions, and the series-delete plan. PURE,
 * no I/O; every timestamp comes from an explicit argument.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.4
 * Lock:   task-feature-design-lock-20260917.md §3 (P2 scope), §4.2 (event words `recurrence_set` /
 *         `recurrence_cleared` / `recurrence_spawned`), §4.4 (four date columns + `time_zone`,
 *         `due_at` recomputed by the service layer), §13-18 (direction decided — E11)
 *
 * Only external import: `../utils/calendar-date` (`isValidIsoCalendarDate`, import-free and
 * I/O-free — D16). Civil-day stepping comes from `task-civil-date.ts` (D15: no new `Intl` site);
 * `due_at` comes from `task-dates.ts`'s `computeDueAt`; the per-instance delete check reuses
 * `task-deletion.ts`'s `planDeleteTask`. Task D's reminder module is NOT imported (it is not on
 * main): when a spawned task needs the default reminder, `planSpawn` says so and the service layer
 * computes it.
 */
import { isValidIsoCalendarDate } from '../utils/calendar-date'
import type { TaskRole } from './task-access'
import { addCivilDays, civilDayDiff, civilWeekday, daysInCivilMonth } from './task-civil-date'
import { computeDueAt } from './task-dates'
import { planDeleteTask, type TaskDeletionFailureReason, type TaskDeletionNodes } from './task-deletion'
import { isValidPrintableAsciiId, isValidTaskDomainId } from './task-ids'

// ── The rule (S14) ─────────────────────────────────────────────────────────────────────────────

// RULED(2026-10-09): [S14] the closed rule set: `freq` daily|weekly|monthly|yearly, `interval`
// 1..365 (required), `byWeekday` (weekly only, required there, 0 = Sunday … 6 = Saturday),
// `byMonthDay` 1..31 or 'last' (monthly only; absent ⇒ the anchor's day), `end` = exactly one of
// `{until: 'YYYY-MM-DD'}` / `{count: 1..365}`. No working-day frequency, no free-form expression.
export const TASK_RECURRENCE_FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const
export type TaskRecurrenceFreq = (typeof TASK_RECURRENCE_FREQS)[number]

export const TASK_RECURRENCE_INTERVAL_MAX = 365
// ASSUMPTION(task-e): [S14][D18] `end.count` is at most 365 occurrences. Out of range (0 or over 365)
// answers `invalid_recurrence` with `field: 'count'`, as S14 says for the rule's closed set; D18's
// `LIMIT` for the same ceiling is not followed (the two rows conflict; design doc §3 item 15). S14
// is ruled and D18 is not, and which code `count` answers is still an open owner question (design
// doc §7, question 3), so this tag stays whole.
export const TASK_RECURRENCE_COUNT_MAX = 365

export type TaskRecurrenceEnd = { until: string } | { count: number }

export interface TaskRecurrenceRule {
  freq: TaskRecurrenceFreq
  interval: number
  /** Weekly only. Canonical form: deduplicated, ascending. 0 = Sunday … 6 = Saturday. */
  byWeekday?: number[]
  /** Monthly only. */
  byMonthDay?: number | 'last'
  end?: TaskRecurrenceEnd
}

export type TaskRecurrenceRuleField = 'rule' | 'freq' | 'interval' | 'byWeekday' | 'byMonthDay' | 'end' | 'until' | 'count'

export type ParseRecurrenceRuleResult =
  | { ok: true; rule: TaskRecurrenceRule }
  | { ok: false; reason: 'invalid_recurrence'; field: TaskRecurrenceRuleField }

const RULE_KEYS = new Set(['freq', 'interval', 'byWeekday', 'byMonthDay', 'end'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(field: TaskRecurrenceRuleField): ParseRecurrenceRuleResult {
  return { ok: false, reason: 'invalid_recurrence', field }
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

/**
 * Validates and canonicalizes a rule. Any unknown key, wrong type, out-of-range value, or a key on
 * a `freq` it does not belong to ⇒ `invalid_recurrence` (422) with the offending key's name in
 * `field` — never the submitted value. The returned rule has a fixed key order and a sorted,
 * deduplicated `byWeekday`, so two equal rules serialize identically.
 */
export function parseRecurrenceRule(raw: unknown): ParseRecurrenceRuleResult {
  if (!isPlainObject(raw)) return invalid('rule')
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) return invalid('rule')
  }
  const freq = raw.freq
  if (typeof freq !== 'string' || !(TASK_RECURRENCE_FREQS as readonly string[]).includes(freq)) {
    return invalid('freq')
  }
  if (!isIntInRange(raw.interval, 1, TASK_RECURRENCE_INTERVAL_MAX)) return invalid('interval')
  const rule: TaskRecurrenceRule = { freq: freq as TaskRecurrenceFreq, interval: raw.interval }

  const hasWeekday = raw.byWeekday !== undefined
  if (freq === 'weekly') {
    if (!Array.isArray(raw.byWeekday) || raw.byWeekday.length === 0) return invalid('byWeekday')
    for (const day of raw.byWeekday) {
      if (!isIntInRange(day, 0, 6)) return invalid('byWeekday')
    }
    rule.byWeekday = [...new Set(raw.byWeekday as number[])].sort((a, b) => a - b)
  } else if (hasWeekday) {
    return invalid('byWeekday')
  }

  if (raw.byMonthDay !== undefined) {
    if (freq !== 'monthly') return invalid('byMonthDay')
    if (raw.byMonthDay !== 'last' && !isIntInRange(raw.byMonthDay, 1, 31)) return invalid('byMonthDay')
    rule.byMonthDay = raw.byMonthDay as number | 'last'
  }

  if (raw.end !== undefined) {
    // ASSUMPTION(task-e, own choice): `end: null` is not a spelling of "no end" — omit the key.
    if (!isPlainObject(raw.end)) return invalid('end')
    const endKeys = Object.keys(raw.end)
    if (endKeys.length !== 1) return invalid('end')
    if (endKeys[0] === 'until') {
      const until = raw.end.until
      if (typeof until !== 'string' || !isValidIsoCalendarDate(until)) return invalid('until')
      rule.end = { until }
    } else if (endKeys[0] === 'count') {
      if (!isIntInRange(raw.end.count, 1, TASK_RECURRENCE_COUNT_MAX)) return invalid('count')
      rule.end = { count: raw.end.count }
    } else {
      return invalid('end')
    }
  }
  return { ok: true, rule }
}

/** Parses a rule that is supposed to be valid already (a stored value or a parsed one). */
function requireRule(rule: unknown, fn: string): TaskRecurrenceRule {
  const parsed = parseRecurrenceRule(rule)
  if (parsed.ok === false) {
    throw new TypeError(`${fn}: the recurrence rule is not a valid rule`)
  }
  return (parsed as { ok: true; rule: TaskRecurrenceRule }).rule
}

function requireCivilDate(value: unknown, name: string, fn: string): string {
  if (typeof value !== 'string') throw new TypeError(`${fn}: ${name} must be a YYYY-MM-DD string`)
  if (!isValidIsoCalendarDate(value)) throw new RangeError(`${fn}: ${name} must be a real YYYY-MM-DD date`)
  return value
}

function splitCivil(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number)
  return [y, m, d]
}

function formatCivil(year: number, month: number, day: number, fn: string): string {
  if (year < 1 || year > 9999) throw new RangeError(`${fn}: result is outside 0001..9999`)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// RULED(2026-10-09): [S14] the next due date always steps forward FROM THE CURRENT INSTANCE's due
// date; for monthly/yearly the day (and for yearly the month) come from the rule day / the series
// anchor, and are clamped to the target month's length — never taken from the previous, already
// clamped occurrence, so 01-31 → 02-28 → 03-31 does not drift.
// ASSUMPTION(task-e, own choice): the anchor is the due date of the series' FIRST occurrence (for a
// task that has no series yet: its own due date); the caller loads it. This is the default answer to
// an open owner question (design §7, question 1): with it, editing the current occurrence's due date
// moves later daily/weekly occurrences but not the day (or, yearly, the month and day) of later
// monthly/yearly ones. Weeks start on MONDAY, which only matters for weekly rules with `interval > 1`.
/**
 * - daily: `current + interval` days.
 * - weekly: the first matching weekday strictly after `current` inside current's Monday-start week;
 *   if none, the first matching weekday of the week `interval` weeks later.
 * - monthly: month = current's month + `interval`; day = `byMonthDay` ('last' ⇒ month end) or the
 *   anchor's day, clamped to the month length.
 * - yearly: year = current's year + `interval`; month/day = the anchor's, Feb 29 clamped to Feb 28
 *   in a common year.
 * The result is always strictly later than `current`. RangeError past 9999-12-31.
 */
export function nextOccurrenceDueDate(rule: TaskRecurrenceRule, current: string, anchor: string): string {
  const fn = 'nextOccurrenceDueDate'
  const r = requireRule(rule, fn)
  const cur = requireCivilDate(current, 'current', fn)
  const anc = requireCivilDate(anchor, 'anchor', fn)
  switch (r.freq) {
    case 'daily':
      return addCivilDays(cur, r.interval)
    case 'weekly': {
      // Monday-based index: Monday = 0 … Sunday = 6.
      const wanted = (r.byWeekday as number[]).map((d) => (d + 6) % 7).sort((a, b) => a - b)
      const curIndex = (civilWeekday(cur) + 6) % 7
      const monday = addCivilDays(cur, -curIndex)
      const laterThisWeek = wanted.find((index) => index > curIndex)
      if (laterThisWeek !== undefined) return addCivilDays(monday, laterThisWeek)
      return addCivilDays(monday, 7 * r.interval + wanted[0])
    }
    case 'monthly': {
      const [cy, cm] = splitCivil(cur)
      const [, , anchorDay] = splitCivil(anc)
      const total = cy * 12 + (cm - 1) + r.interval
      const year = Math.floor(total / 12)
      const month = (total % 12) + 1
      if (year > 9999) throw new RangeError(`${fn}: result is outside 0001..9999`)
      const length = daysInCivilMonth(year, month)
      const ruleDay = r.byMonthDay === 'last' ? length : (r.byMonthDay ?? anchorDay)
      return formatCivil(year, month, Math.min(ruleDay, length), fn)
    }
    case 'yearly': {
      const [cy] = splitCivil(cur)
      const [, anchorMonth, anchorDay] = splitCivil(anc)
      const year = cy + r.interval
      if (year > 9999) throw new RangeError(`${fn}: result is outside 0001..9999`)
      return formatCivil(year, anchorMonth, Math.min(anchorDay, daysInCivilMonth(year, anchorMonth)), fn)
    }
    default:
      throw new TypeError(`${fn}: unknown freq`)
  }
}

// ASSUMPTION(task-e, own choice): `until` is inclusive (an occurrence due ON the until date is still
// spawned); `count` is the TOTAL number of occurrences including the first one, and the caller passes
// the 1-based position of the occurrence being checked.
/** Whether an occurrence due on `dueDate`, at 1-based position `occurrenceNumber`, is inside the rule's end. */
export function isWithinRecurrenceEnd(rule: TaskRecurrenceRule, dueDate: string, occurrenceNumber: number): boolean {
  const fn = 'isWithinRecurrenceEnd'
  const r = requireRule(rule, fn)
  const due = requireCivilDate(dueDate, 'dueDate', fn)
  if (typeof occurrenceNumber !== 'number' || !Number.isSafeInteger(occurrenceNumber) || occurrenceNumber < 1) {
    throw new TypeError(`${fn}: occurrenceNumber must be a positive integer`)
  }
  if (!r.end) return true
  if ('until' in r.end) return due <= r.end.until
  return occurrenceNumber <= r.end.count
}

// ── Spawning (S15 / S16 / D3) ──────────────────────────────────────────────────────────────────

function requireBoolean(value: unknown, name: string, fn: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${fn}: ${name} must be a boolean`)
  return value
}

// RULED(2026-10-09): [S15] the spawn hook sits on every write that flips a task from open to
// done (not on an event type), and spawns at most once per task: a task that already has a
// `recurrence_spawned` event never spawns again — reopening and completing it again included.
// ASSUMPTION(task-e): [D3] the caller supplies `alreadySpawned`, read from that event under the
// structure lock.
/** True iff this write flipped open → done, the task has a rule, and it has not spawned before. */
export function shouldSpawnOnFlip(input: {
  wasDone: boolean
  done: boolean
  recurrence: TaskRecurrenceRule | null
  alreadySpawned: boolean
}): boolean {
  const fn = 'shouldSpawnOnFlip'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const wasDone = requireBoolean(input.wasDone, 'wasDone', fn)
  const done = requireBoolean(input.done, 'done', fn)
  const alreadySpawned = requireBoolean(input.alreadySpawned, 'alreadySpawned', fn)
  if (input.recurrence === null) return false
  // A stored rule that no longer parses is corrupt data, not a user error.
  requireRule(input.recurrence, fn)
  return !wasDone && done && !alreadySpawned
}

/** The fields of the completed instance that a spawn reads. */
export interface TaskOccurrenceSource {
  id: string
  title: string
  description: string | null
  completionMode: 'all' | 'any'
  timeZone: string
  dueDate: string | null
  dueTime: string | null
  startDate: string | null
  startTime: string | null
  remindAt: Date | null
  isMilestone: boolean
  parentId: string | null
  depth: number
  createdBy: string
  recurrence: TaskRecurrenceRule
  /** `recurrence_series_id`; `null` when this task is the first occurrence. */
  seriesId: string | null
  assigneeIds: readonly string[]
  followerIds: readonly string[]
  listIds: readonly string[]
  fieldValues: readonly { fieldId: string; value: unknown }[]
}

export interface SpawnedTaskRow {
  id: string
  title: string
  description: string | null
  status: 'open'
  completionMode: 'all' | 'any'
  timeZone: string
  dueDate: string
  dueTime: string | null
  dueAt: Date
  startDate: string | null
  startTime: string | null
  isMilestone: boolean
  parentId: string | null
  depth: number
  createdBy: string
  recurrence: TaskRecurrenceRule
  seriesId: string
  previousOccurrenceId: string
}

/** `shifted`: keep the source's offset from `due_at`. `default_policy`: compute it from that user's policy. */
export type SpawnReminder = { kind: 'shifted'; remindAt: Date } | { kind: 'default_policy'; policyUserId: string }

export type TaskRecurrenceEventType = 'created' | 'recurrence_spawned' | 'recurrence_set' | 'recurrence_cleared' | 'deleted'

export interface TaskRecurrenceEvent {
  taskId: string
  type: TaskRecurrenceEventType
  userId: string
  occurredAt: Date
  payload: Record<string, unknown>
}

export type PlanSpawnResult =
  | { ok: false; reason: 'no_due_date' | 'series_ended' }
  | {
      ok: true
      task: SpawnedTaskRow
      assignees: { userId: string; completedAt: null; assignedBy: string }[]
      followerIds: string[]
      listIds: string[]
      fieldValues: { fieldId: string; value: unknown }[]
      reminder: SpawnReminder
      events: TaskRecurrenceEvent[]
    }

function requireNullableString(value: unknown, name: string, fn: string): string | null {
  if (value !== null && typeof value !== 'string') throw new TypeError(`${fn}: ${name} must be a string or null`)
  return value as string | null
}

function requireStringArray(value: unknown, name: string, fn: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError(`${fn}: ${name} must be an array of non-empty strings`)
  }
  return [...new Set(value as string[])]
}

function requireNow(now: unknown, fn: string): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError(`${fn}: now must be a valid Date`)
  return now
}

function requireActor(actorId: unknown, fn: string): string {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError(`${fn}: actorId must be a non-empty string`)
  return actorId
}

function validateSource(source: unknown, fn: string): TaskOccurrenceSource {
  if (!isPlainObject(source)) throw new TypeError(`${fn}: source must be an object`)
  const s = source as unknown as TaskOccurrenceSource
  if (!isValidTaskDomainId(s.id)) throw new TypeError(`${fn}: source.id must be a valid task id`)
  if (typeof s.title !== 'string' || s.title.length === 0) throw new TypeError(`${fn}: source.title must be a non-empty string`)
  requireNullableString(s.description, 'source.description', fn)
  if (s.completionMode !== 'all' && s.completionMode !== 'any') throw new TypeError(`${fn}: source.completionMode must be all|any`)
  if (typeof s.timeZone !== 'string' || s.timeZone.length === 0) throw new TypeError(`${fn}: source.timeZone must be a non-empty string`)
  requireNullableString(s.dueDate, 'source.dueDate', fn)
  requireNullableString(s.dueTime, 'source.dueTime', fn)
  requireNullableString(s.startDate, 'source.startDate', fn)
  requireNullableString(s.startTime, 'source.startTime', fn)
  if (s.remindAt !== null && (!(s.remindAt instanceof Date) || Number.isNaN(s.remindAt.getTime()))) {
    throw new TypeError(`${fn}: source.remindAt must be a valid Date or null`)
  }
  requireBoolean(s.isMilestone, 'source.isMilestone', fn)
  if (s.parentId !== null && !isValidTaskDomainId(s.parentId)) throw new TypeError(`${fn}: source.parentId must be a task id or null`)
  if (!isIntInRange(s.depth, 0, 4)) throw new TypeError(`${fn}: source.depth must be an integer 0..4`)
  if (!isValidPrintableAsciiId(s.createdBy)) throw new TypeError(`${fn}: source.createdBy must be a printable id`)
  if (s.seriesId !== null && !isValidTaskDomainId(s.seriesId)) throw new TypeError(`${fn}: source.seriesId must be a task id or null`)
  requireStringArray(s.assigneeIds, 'source.assigneeIds', fn)
  requireStringArray(s.followerIds, 'source.followerIds', fn)
  requireStringArray(s.listIds, 'source.listIds', fn)
  if (!Array.isArray(s.fieldValues) || s.fieldValues.some((fv) => !isPlainObject(fv) || typeof fv.fieldId !== 'string')) {
    throw new TypeError(`${fn}: source.fieldValues must be an array of { fieldId, value }`)
  }
  return s
}

// RULED(2026-10-09): [S16] the carried set: title, description, completion mode, time zone,
// due/start TIME of day, assignees (fresh rows: not completed, `assignedBy` = the series creator),
// followers, list memberships, field values, milestone flag, parent and depth, the rule itself, the
// series id (= the first occurrence's id) and `previous_occurrence_id`. NOT carried: subtasks,
// comments, attachments, dependencies. `created_by` stays the original creator; the new task's
// `created` event is attributed to whoever completed the source. Reminder: a source `remind_at` is
// re-applied at the same offset from the new `due_at`; with none, the original creator's default
// reminder policy applies (computed by the service layer).
/**
 * Plans the next occurrence of `source`. `no_due_date`: the source's due date was cleared after the
 * rule was set. `series_ended`: the next occurrence would fall outside `end`. Otherwise returns the
 * new row (due date stepped, start date shifted by the same number of civil days, `due_at`
 * recomputed with `computeDueAt` in the source's time zone) and two events: `recurrence_spawned` on
 * the source (payload `{ spawnedTaskId }`) and `created` on the new task.
 */
export function planSpawn(input: {
  source: TaskOccurrenceSource
  /** Due date of the series' first occurrence (equal to `source.dueDate` when `source.seriesId` is null). */
  anchorDueDate: string
  /** 1-based position of `source` in its series. */
  occurrenceNumber: number
  /** Id for the new task, generated by the caller. */
  newTaskId: string
  actorId: string
  now: Date
}): PlanSpawnResult {
  const fn = 'planSpawn'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  const source = validateSource(input.source, fn)
  const rule = requireRule(source.recurrence, fn)
  const anchor = requireCivilDate(input.anchorDueDate, 'anchorDueDate', fn)
  if (!isIntInRange(input.occurrenceNumber, 1, Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${fn}: occurrenceNumber must be a positive integer`)
  }
  if (!isValidTaskDomainId(input.newTaskId) || input.newTaskId === source.id) {
    throw new TypeError(`${fn}: newTaskId must be a new valid task id`)
  }
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)

  if (source.dueDate === null) return { ok: false, reason: 'no_due_date' }
  const currentDue = requireCivilDate(source.dueDate, 'source.dueDate', fn)
  const nextDue = nextOccurrenceDueDate(rule, currentDue, anchor)
  if (!isWithinRecurrenceEnd(rule, nextDue, input.occurrenceNumber + 1)) {
    return { ok: false, reason: 'series_ended' }
  }

  const shift = civilDayDiff(currentDue, nextDue)
  const nextStart = source.startDate === null ? null : addCivilDays(requireCivilDate(source.startDate, 'source.startDate', fn), shift)
  const nextDueAt = computeDueAt({ dueDate: nextDue, dueTime: source.dueTime, timeZone: source.timeZone })
  let reminder: SpawnReminder
  if (source.remindAt !== null) {
    const currentDueAt = computeDueAt({ dueDate: currentDue, dueTime: source.dueTime, timeZone: source.timeZone })
    const offsetMs = currentDueAt.getTime() - source.remindAt.getTime()
    reminder = { kind: 'shifted', remindAt: new Date(nextDueAt.getTime() - offsetMs) }
  } else {
    reminder = { kind: 'default_policy', policyUserId: source.createdBy }
  }

  const seriesId = source.seriesId ?? source.id
  const task: SpawnedTaskRow = {
    id: input.newTaskId,
    title: source.title,
    description: source.description,
    status: 'open',
    completionMode: source.completionMode,
    timeZone: source.timeZone,
    dueDate: nextDue,
    dueTime: source.dueTime,
    dueAt: nextDueAt,
    startDate: nextStart,
    startTime: source.startTime,
    isMilestone: source.isMilestone,
    parentId: source.parentId,
    depth: source.depth,
    createdBy: source.createdBy,
    recurrence: rule,
    seriesId,
    previousOccurrenceId: source.id,
  }
  return {
    ok: true,
    task,
    assignees: requireStringArray(source.assigneeIds, 'source.assigneeIds', fn).map((userId) => ({
      userId,
      completedAt: null,
      assignedBy: source.createdBy,
    })),
    followerIds: requireStringArray(source.followerIds, 'source.followerIds', fn),
    listIds: requireStringArray(source.listIds, 'source.listIds', fn),
    fieldValues: source.fieldValues.map((fv) => ({ fieldId: fv.fieldId, value: fv.value })),
    reminder,
    events: [
      { taskId: source.id, type: 'recurrence_spawned', userId: actorId, occurredAt: now, payload: { spawnedTaskId: input.newTaskId } },
      { taskId: input.newTaskId, type: 'created', userId: actorId, occurredAt: now, payload: {} },
    ],
  }
}

// ── Set / clear (E11, S17) ─────────────────────────────────────────────────────────────────────

function requireOptionalStoredRule(value: unknown, fn: string): TaskRecurrenceRule | null {
  if (value === null) return null
  return requireRule(value, fn)
}

function sameRule(a: TaskRecurrenceRule | null, b: TaskRecurrenceRule | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type ApplySetRecurrenceResult =
  | { ok: false; reason: 'invalid_recurrence'; field: TaskRecurrenceRuleField }
  | { ok: false; reason: 'due_required' }
  | { ok: true; recurrence: TaskRecurrenceRule; noop: boolean; events: TaskRecurrenceEvent[] }

// ASSUMPTION(task-e, own choice): the body is parsed BEFORE the due-date precondition is checked,
// so a request that fails both answers `invalid_recurrence`.
/**
 * Sets (or replaces) the rule. The task must have a due date (E11 ⇒ `due_required`, 422). An equal
 * rule (after canonicalization) is a no-op with no event; otherwise `recurrence_set`. Who may call
 * this is decided by the route with `can(roles, 'edit')`.
 */
export function applySetRecurrence(input: {
  taskId: string
  current: TaskRecurrenceRule | null
  next: unknown
  dueDate: string | null
  actorId: string
  now: Date
}): ApplySetRecurrenceResult {
  const fn = 'applySetRecurrence'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (!isValidTaskDomainId(input.taskId)) throw new TypeError(`${fn}: taskId must be a valid task id`)
  const current = requireOptionalStoredRule(input.current, fn)
  requireNullableString(input.dueDate, 'dueDate', fn)
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)
  const parsed = parseRecurrenceRule(input.next)
  if (parsed.ok === false) {
    const failed = parsed as { ok: false; reason: 'invalid_recurrence'; field: TaskRecurrenceRuleField }
    return { ok: false, reason: 'invalid_recurrence', field: failed.field }
  }
  const next = (parsed as { ok: true; rule: TaskRecurrenceRule }).rule
  if (input.dueDate === null) return { ok: false, reason: 'due_required' }
  requireCivilDate(input.dueDate, 'dueDate', fn)
  if (sameRule(current, next)) return { ok: true, recurrence: next, noop: true, events: [] }
  return {
    ok: true,
    recurrence: next,
    noop: false,
    events: [{ taskId: input.taskId, type: 'recurrence_set', userId: actorId, occurredAt: now, payload: {} }],
  }
}

export type ApplyClearRecurrenceResult =
  | { ok: false; reason: 'not_current_occurrence' }
  | { ok: true; recurrence: null; noop: boolean; events: TaskRecurrenceEvent[] }

// RULED(2026-10-09): [S17] ending the recurrence is only allowed on the series' latest, still-open
// occurrence (an earlier one answers 422 `not_current_occurrence`); a task that has no rule is a
// no-op whatever its position.
export function applyClearRecurrence(input: {
  taskId: string
  current: TaskRecurrenceRule | null
  isLatestOpenOccurrence: boolean
  actorId: string
  now: Date
}): ApplyClearRecurrenceResult {
  const fn = 'applyClearRecurrence'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (!isValidTaskDomainId(input.taskId)) throw new TypeError(`${fn}: taskId must be a valid task id`)
  const current = requireOptionalStoredRule(input.current, fn)
  const isLatestOpen = requireBoolean(input.isLatestOpenOccurrence, 'isLatestOpenOccurrence', fn)
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)
  if (current === null) return { ok: true, recurrence: null, noop: true, events: [] }
  if (!isLatestOpen) return { ok: false, reason: 'not_current_occurrence' }
  return {
    ok: true,
    recurrence: null,
    noop: false,
    events: [{ taskId: input.taskId, type: 'recurrence_cleared', userId: actorId, occurredAt: now, payload: {} }],
  }
}

// ── Series delete (E11, S17) ───────────────────────────────────────────────────────────────────

/** A broken `previous_occurrence_id` chain (fork, cycle, two heads, duplicate id): data corruption. */
export class TaskRecurrenceSeriesCorruptError extends Error {
  readonly code = 'TASK_RECURRENCE_SERIES_CORRUPT'
  constructor(message: string) {
    super(message)
    this.name = 'TaskRecurrenceSeriesCorruptError'
  }
}

export interface TaskSeriesMember {
  id: string
  previousOccurrenceId: string | null
  status: 'open' | 'done'
  /** Soft-deleted already. Deleted members still belong in the list: they keep the chain intact. */
  deleted: boolean
  hasRecurrence: boolean
  /** The acting user's roles on THIS member. */
  actorRoles: TaskRole[]
}

/** Orders a series along its `previousOccurrenceId` links, first occurrence first. */
function orderSeries(members: readonly TaskSeriesMember[]): TaskSeriesMember[] {
  const ids = new Set(members.map((m) => m.id))
  if (ids.size !== members.length) throw new TaskRecurrenceSeriesCorruptError('series: duplicate member id')
  const heads = members.filter((m) => m.previousOccurrenceId === null || !ids.has(m.previousOccurrenceId))
  if (heads.length !== 1) throw new TaskRecurrenceSeriesCorruptError(`series: expected one first occurrence, found ${heads.length}`)
  const byPrevious = new Map<string, TaskSeriesMember>()
  for (const member of members) {
    const prev = member.previousOccurrenceId
    if (prev === null || !ids.has(prev)) continue
    if (byPrevious.has(prev)) throw new TaskRecurrenceSeriesCorruptError('series: two occurrences share one predecessor')
    byPrevious.set(prev, member)
  }
  const ordered: TaskSeriesMember[] = [heads[0]]
  const seen = new Set<string>([heads[0].id])
  let cursor = byPrevious.get(heads[0].id)
  while (cursor !== undefined) {
    if (seen.has(cursor.id)) throw new TaskRecurrenceSeriesCorruptError('series: the chain loops')
    seen.add(cursor.id)
    ordered.push(cursor)
    cursor = byPrevious.get(cursor.id)
  }
  if (ordered.length !== members.length) throw new TaskRecurrenceSeriesCorruptError('series: some occurrences are not on the chain')
  return ordered
}

function validateMembers(members: unknown, fn: string): TaskSeriesMember[] {
  if (!Array.isArray(members) || members.length === 0) throw new TypeError(`${fn}: members must be a non-empty array`)
  for (const m of members) {
    if (!isPlainObject(m)) throw new TypeError(`${fn}: every member must be an object`)
    if (!isValidTaskDomainId(m.id)) throw new TypeError(`${fn}: member.id must be a valid task id`)
    if (m.previousOccurrenceId !== null && !isValidTaskDomainId(m.previousOccurrenceId)) {
      throw new TypeError(`${fn}: member.previousOccurrenceId must be a task id or null`)
    }
    if (m.status !== 'open' && m.status !== 'done') throw new TypeError(`${fn}: member.status must be open|done`)
    requireBoolean(m.deleted, 'member.deleted', fn)
    requireBoolean(m.hasRecurrence, 'member.hasRecurrence', fn)
    if (!Array.isArray(m.actorRoles)) throw new TypeError(`${fn}: member.actorRoles must be an array`)
  }
  return members as TaskSeriesMember[]
}

export type PlanSeriesDeleteResult =
  | { ok: false; reason: TaskDeletionFailureReason; taskId: string }
  | { ok: true; deleteIds: string[]; clearRecurrenceIds: string[]; events: TaskRecurrenceEvent[] }

// RULED(2026-10-09): [S17] deleting any occurrence soft-deletes it plus every LATER (along the
// chain), undeleted, still-open occurrence; completed ones other than the target stay. Each one must
// pass task C's delete check (only the creator may delete; a task with undeleted subtasks is
// refused, A4) — one refusal refuses the whole plan. Afterwards the latest surviving occurrence loses
// its rule, so nothing in the series can spawn again.
/**
 * `members`: the whole series (deleted members included — they keep the chain intact).
 * `nodes`: the org's undeleted task node map, as for `planDeleteTask`.
 */
export function planSeriesDelete(input: {
  targetId: string
  members: readonly TaskSeriesMember[]
  nodes: TaskDeletionNodes
  actorId: string
  now: Date
}): PlanSeriesDeleteResult {
  const fn = 'planSeriesDelete'
  if (!isPlainObject(input)) throw new TypeError(`${fn}: input must be an object`)
  if (!isValidTaskDomainId(input.targetId)) throw new TypeError(`${fn}: targetId must be a valid task id`)
  const members = validateMembers(input.members, fn)
  if (!(input.nodes instanceof Map)) throw new TypeError(`${fn}: nodes must be a Map`)
  const actorId = requireActor(input.actorId, fn)
  const now = requireNow(input.now, fn)

  const ordered = orderSeries(members)
  const targetIndex = ordered.findIndex((m) => m.id === input.targetId)
  if (targetIndex === -1 || ordered[targetIndex].deleted) {
    return { ok: false, reason: 'not_found', taskId: input.targetId }
  }
  const toDelete = [
    ordered[targetIndex],
    ...ordered.slice(targetIndex + 1).filter((m) => !m.deleted && m.status === 'open'),
  ]
  for (const member of toDelete) {
    const verdict = planDeleteTask({ taskId: member.id, nodes: input.nodes, roles: member.actorRoles })
    if (verdict.ok === false) {
      return { ok: false, reason: (verdict as { ok: false; reason: TaskDeletionFailureReason }).reason, taskId: member.id }
    }
  }
  const deleting = new Set(toDelete.map((m) => m.id))
  const survivors = ordered.filter((m) => !m.deleted && !deleting.has(m.id))
  const latest = survivors.length > 0 ? survivors[survivors.length - 1] : undefined
  const clearRecurrenceIds = latest !== undefined && latest.hasRecurrence ? [latest.id] : []
  const events: TaskRecurrenceEvent[] = [
    ...toDelete.map((m): TaskRecurrenceEvent => ({ taskId: m.id, type: 'deleted', userId: actorId, occurredAt: now, payload: {} })),
    ...clearRecurrenceIds.map((id): TaskRecurrenceEvent => ({ taskId: id, type: 'recurrence_cleared', userId: actorId, occurredAt: now, payload: {} })),
  ]
  return { ok: true, deleteIds: toDelete.map((m) => m.id), clearRecurrenceIds, events }
}
