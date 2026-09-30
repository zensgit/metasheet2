/**
 * Task feature — reminder computation: default `remind_at` policy + algorithm, the write-time and
 * scan-time firing window, outbox `source_key` builders for all four families, and the daily-digest
 * predicate (TS) + condition builder (SQL). PURE, no I/O; every timestamp comes from an explicit
 * `now`/`writtenAt`/`floor` argument (never `Date.now()`/`new Date()` implicitly).
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-reminders.ts`
 * Lock:   task-feature-design-lock-20260917.md §4.4 `:140` (remind_at default algorithm, already
 *         decided), §13-7 (`task_user_settings`, suggested)
 *
 * Reuses (does not reimplement) `../multitable/automation-date-reminder.ts`'s
 * `computeDateReminderOccurrence`/`isDateReminderDue` (lock `:140`/`:253` names
 * `computeDateReminderOccurrence` itself as the required all-day implementation) and
 * `../multitable/automation-timezone.ts`'s `isValidIanaTimeZone`. `computeDateReminderOccurrence`
 * silently degrades an invalid tz to UTC (it never throws) — this module validates the tz itself
 * BEFORE calling it and throws, so a persisted-junk `tasks.time_zone` cannot silently mis-fire a
 * reminder (task-dates.ts's `computeDueAt`/`validateViewerTimeZoneHeader` already documents the
 * companion write-time guard: `time_zone` is validated at write, so a well-formed task row should
 * never reach here with a bad zone — this is defense in depth, not the primary guard).
 *
 * This whole module implements the M4 ruling pack v2 (PROPOSED, not owner-ratified) — every
 * `ASSUMPTION(task-d)` comment below names the ruling id it implements the RECOMMENDED value of.
 */
import { computeDateReminderOccurrence, isDateReminderDue } from '../multitable/automation-date-reminder'
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import { isOverdue, viewerNextMidnight, viewerToday, type TaskDueShape } from './task-dates'
import { buildTaskScopeCondition, type TaskScopeCondition } from './task-access'

// ── default_remind_policy (§13-7 / R02③): closed set ─────────────────────────────────────────────

export type TaskRemindPolicy = { mode: 'default' } | { mode: 'none' }

export type ParseRemindPolicyReason = 'invalid_policy'
export type ParseRemindPolicyResult = { ok: true; policy: TaskRemindPolicy } | { ok: false; reason: ParseRemindPolicyReason }

// ASSUMPTION(task-d): [R02③] "缺省未知值 422 并配负例;缺行视为 default" is written about the ROW
// being absent from `task_user_settings` entirely. This function additionally treats a `null`/
// `undefined` COLUMN VALUE (a row exists, but `default_remind_policy` itself is null) the same way
// — defaulting to `{mode:'default'}` — generalizing "missing" to cover both cases; ANY other
// non-matching value (wrong shape, unknown `mode`, extra/missing keys) is rejected. This is the
// ROW-READ context specifically. `task-settings.ts`'s `parseSettingsPatch` — the PATCH-WRITE
// context — does NOT call this function with a `null` `defaultRemindPolicy`: an explicit `null`
// inside a patch body has no "reset to default" semantics and is rejected as `invalid_policy`
// BEFORE reaching here (see the ASSUMPTION note above `parseSettingsPatch`'s own `null` check) —
// only `undefined` (key absent from the patch) means "leave the current value alone" there.
/** `{"mode":"default"}` | `{"mode":"none"}`; missing (row or value) defaults to `{mode:'default'}`. */
export function parseRemindPolicy(raw: unknown): ParseRemindPolicyResult {
  if (raw === null || raw === undefined) {
    return { ok: true, policy: { mode: 'default' } }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_policy' }
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  const mode = (raw as { mode?: unknown }).mode
  if (keys.length === 1 && (mode === 'default' || mode === 'none')) {
    return { ok: true, policy: { mode } }
  }
  return { ok: false, reason: 'invalid_policy' }
}

// ── remind_at default algorithm (lock §4.4 `:140`, already decided) ──────────────────────────────

export interface ComputeDefaultRemindAtInput {
  /** `YYYY-MM-DD`, required when `dueTime` is absent (all-day branch); ignored for scheduled. */
  dueDate: string | null
  /** Presence marks "scheduled"; absence/`null` marks "all-day". */
  dueTime?: string | null
  /** Already-computed `due_at` (e.g. via `task-dates.ts`'s `computeDueAt`) — required for the
   * scheduled branch; ignored for all-day. */
  dueAt: Date | null
  /** The TASK's own IANA zone (never the viewer's — lock §4.4 "不用查看者时区"). */
  timeZone: string
  policy: TaskRemindPolicy
}

/** Scheduled branch offset (lock §4.4: "due_time − 30min"). */
const SCHEDULED_REMIND_OFFSET_MS = 30 * 60 * 1000
/** All-day branch local time-of-day (lock §4.4: "18:00"). */
const ALL_DAY_REMIND_TIME_OF_DAY = '18:00'

// ASSUMPTION(task-d, own choice — not ruling-derived, fixing a real bug found in independent
// review): `computeDateReminderOccurrence` (the function this module reuses for the all-day branch)
// parses its `dateValue` with `new Date(String(dateValue))` — the PLATFORM's lenient Date parser,
// not a strict `YYYY-MM-DD` parser. Two confirmed silent-corruption cases: `new
// Date('2026-02-30')` (Feb 30 does not exist) does NOT throw or yield `Invalid Date` — it silently
// ROLLS OVER to March 2; `new Date('2026-3-8')` (non-zero-padded, not canonical ISO) silently
// parses as a valid date instead of being rejected as malformed. Both would make
// `computeDefaultRemindAt` return a WRONG (but plausible-looking) reminder instant instead of
// erroring — exactly the class of bug lock §4.4/R15's "never silently coerce" philosophy exists to
// prevent. Mirrors `task-dates.ts`'s PRIVATE (unexported) `parseIsoDate` helper's exact two-step
// check (strict regex, THEN a UTC round-trip to catch a syntactically-valid-but-nonexistent date
// like day 30 of February) rather than importing it — same "small shared helper stays local"
// pattern this module tree already uses for `task-lists.ts`'s/`task-groups.ts`'s name validators,
// so this file does not create a new cross-module dependency for an ~8-line check.
function assertValidCalendarDateString(dueDate: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate)
  if (!m) {
    throw new RangeError(`computeDefaultRemindAt: dueDate must be YYYY-MM-DD, got "${dueDate}"`)
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`computeDefaultRemindAt: "${dueDate}" is not a real calendar date`)
  }
}

// ASSUMPTION(task-d): [D6] (already in `task-b`/lock territory — restated here because this is
// where the arithmetic actually runs) the scheduled branch is PURE instant arithmetic
// (`dueAt − 30min`); a `due_time` in `00:00`-`00:29` rolling the reminder onto the PREVIOUS calendar
// day is a straightforward RESULT of that arithmetic, not a separate branch, and DST is not handled
// specially (the subtraction is on the UTC instant, which is DST-agnostic by construction).
/**
 * `policy.mode === 'none'` ⇒ `null` (no default reminder). No due date at all (`dueDate` AND
 * `dueAt` both null/absent) ⇒ `null`. Scheduled (`dueTime` present): `dueAt − 30min` — throws if
 * `dueTime` is given without a computed `dueAt` (caller contract violation, not a data problem).
 * All-day: validates `dueDate` is a STRICT, REAL `YYYY-MM-DD` calendar date and `timeZone` via
 * `isValidIanaTimeZone`, BOTH before calling anything else, and THROWS on either failure (never
 * silently degrades to UTC or rolls a nonexistent date over to a nearby real one — the opposite of
 * `computeDateReminderOccurrence`'s own lenient/fallback behavior for both), then calls
 * `computeDateReminderOccurrence(dueDate, {timeOfDay:'18:00', offsetDays:0, timezone: timeZone},
 * {floating:true})` (lock `:140`/`:253`, reused verbatim).
 */
export function computeDefaultRemindAt(input: ComputeDefaultRemindAtInput): Date | null {
  const { dueDate, dueTime, dueAt, timeZone, policy } = input
  if (policy.mode === 'none') return null
  if (dueTime) {
    if (!dueAt) {
      throw new TypeError('computeDefaultRemindAt: dueTime given without a computed dueAt')
    }
    return new Date(dueAt.getTime() - SCHEDULED_REMIND_OFFSET_MS)
  }
  if (!dueDate) return null
  assertValidCalendarDateString(dueDate)
  if (!isValidIanaTimeZone(timeZone)) {
    throw new RangeError(`computeDefaultRemindAt: invalid IANA time zone "${timeZone}"`)
  }
  const occurrenceIso = computeDateReminderOccurrence(
    dueDate,
    { offsetDays: 0, direction: 'before', timeOfDay: ALL_DAY_REMIND_TIME_OF_DAY, timezone: timeZone },
    { floating: true },
  )
  return occurrenceIso === null ? null : new Date(occurrenceIso)
}

// ── Write-time enqueue guard (R06: "写入时 remind_at ≤ now 就不入队、不补发") ─────────────────────

/** Strictly-future check at WRITE time — the write path's own gate, separate from the scan-time
 * window below. A `remindAt` at or before `writtenAt` is never enqueued (no backfill on write). */
export function shouldEnqueueReminder(remindAt: Date, writtenAt: Date): boolean {
  return remindAt.getTime() > writtenAt.getTime()
}

// ── Scan-time firing window (R06) ─────────────────────────────────────────────────────────────

// ASSUMPTION(task-d): [R06] `W`, the scan/backfill grace window, is a SINGLE-POINT constant here —
// R06's recommended value is 2 hours, "不小于调度间隔" (not smaller than the scheduler's tick
// interval; PR-3b, which sets `TASKS_SCHEDULER_INTERVAL_MS`, owns keeping that inequality true).
export const TASK_REMINDER_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * R06: `floor ≤ remind_at ≤ now` AND `remind_at > now − W` — calls `isDateReminderDue` DIRECTLY
 * (lock/plan `:171` "原样复用"), rather than reimplementing its three-way bound check. `floor` is
 * the `occurred_at` of the event that most recently WROTE the current `remind_at` (a `created` or
 * `remind_changed` `task_events` row) — the caller reads that timestamp; this function does not
 * derive it. A `remindAt` outside the window is neither generated nor backfilled (R06).
 */
export function isTaskReminderDue(remindAt: Date, now: Date, floor: Date): boolean {
  return isDateReminderDue(remindAt.toISOString(), now.getTime(), TASK_REMINDER_SCAN_WINDOW_MS, floor.getTime())
}

// ASSUMPTION(task-d): [R06] "到点时任务已完成或已软删,就不发 (skipped)" — a tiny pure predicate
// over already-loaded task state, kept here (not invented as a throwaway inline check at the PR-3b
// call site) because it is a named part of R06's recommended algorithm and is independently
// testable/mutable.
// ASSUMPTION(task-d): [R06] third skip condition: a queued delivery was created against a SPECIFIC
// `remind_at` value at enqueue time; by the time the scanner reaches it, the task's CURRENT
// `remind_at` may have since changed (the due date/time was edited, recomputing a new `remind_at`)
// or been cleared entirely (policy flipped to `{mode:'none'}`, or the due date/time removed). A
// delivery whose `remind_at` no longer matches the task's LIVE `remind_at` — including the task's
// live `remind_at` now being `null` — is stale and must never fire: the task has already had a
// fresh reminder (re)scheduled against its new `remind_at` (or none at all), and this stale
// delivery is not that one. Compared BY VALUE (`getTime()`), not by reference — two `Date` objects
// for the same instant must compare equal, matching every other instant comparison in this module.
/** `true` ⇒ the worker must record this delivery as `skipped` rather than sending it. */
export function isReminderSkippedByTaskState(
  task: { status: 'open' | 'done'; deletedAt: Date | null; remindAt: Date | null },
  deliveryRemindAt: Date,
): boolean {
  if (task.status !== 'open' || task.deletedAt !== null) return true
  if (task.remindAt === null) return true
  return task.remindAt.getTime() !== deliveryRemindAt.getTime()
}

// ── outbox source_key builders — all four families (§3.1 "source_key 四族构造器") ────────────────

// ASSUMPTION(task-d): [R05/R06/R07] the M4 ruling pack quotes only the PREFIX of each family
// verbatim (`task_reminder:<taskId>:<remind_at>:…`, `task_daily:<date>:…`,
// `task_list_event:<listId>:<eventId>:recipient:<uid>:channel:<ch>` for the fourth family — R05(e)).
// The `…`/interior shape for the reminder and daily families, and the THIRD family (regular
// completed/reopened/deleted/commented event notifications) entirely, are not spelled out
// character-for-character anywhere in the pack. This module fills them in by following the ONE
// concrete precedent that IS in the repo — `UnscheduledReminderService.ts`'s
// `'unscheduled:' + id + ':recipient:' + userId + ':channel:' + channel` — extended to all four
// families for a consistent, reviewable shape. `channel` is a caller-supplied string, not a closed
// enum here: the pack gives no closed channel set for tasks, and the attendance precedent
// (`attendance_notification_deliveries.channel`) is untyped `text` resolved at runtime, not a DDL
// CHECK, so this module does not invent one either.

function requireNonEmpty(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}

/** Family 1 — single-task reminder (R06). */
export function buildTaskReminderSourceKey(input: {
  taskId: string
  remindAt: Date
  userId: string
  channel: string
}): string {
  requireNonEmpty('taskId', input.taskId)
  requireNonEmpty('userId', input.userId)
  requireNonEmpty('channel', input.channel)
  return `task_reminder:${input.taskId}:${input.remindAt.toISOString()}:recipient:${input.userId}:channel:${input.channel}`
}

/** Family 2 — per-(user, local date, channel) daily digest (R07). `date` is the RECIPIENT's local
 * calendar date (`YYYY-MM-DD`, per `viewerToday(now, userTimeZone)`), not a UTC date. */
export function buildTaskDailyDigestSourceKey(input: { date: string; userId: string; channel: string }): string {
  requireNonEmpty('date', input.date)
  requireNonEmpty('userId', input.userId)
  requireNonEmpty('channel', input.channel)
  return `task_daily:${input.date}:recipient:${input.userId}:channel:${input.channel}`
}

/** Family 3 — a regular `task_events` notification (`completed`/`completed_by_any`/`reopened`/
 * `deleted`/`commented` — the D13 trigger set in `task-notifications.ts`). `eventId` is the
 * `task_events.id` (a `tev_…` id) that triggered the notification. */
export function buildTaskEventSourceKey(input: {
  taskId: string
  eventId: string
  userId: string
  channel: string
}): string {
  requireNonEmpty('taskId', input.taskId)
  requireNonEmpty('eventId', input.eventId)
  requireNonEmpty('userId', input.userId)
  requireNonEmpty('channel', input.channel)
  return `task_event:${input.taskId}:${input.eventId}:recipient:${input.userId}:channel:${input.channel}`
}

/** Family 4 — a `task_list_events` notification (R05(e): list archive notifies the list's creator). */
export function buildTaskListEventSourceKey(input: {
  listId: string
  eventId: string
  userId: string
  channel: string
}): string {
  requireNonEmpty('listId', input.listId)
  requireNonEmpty('eventId', input.eventId)
  requireNonEmpty('userId', input.userId)
  requireNonEmpty('channel', input.channel)
  return `task_list_event:${input.listId}:${input.eventId}:recipient:${input.userId}:channel:${input.channel}`
}

// ── Daily digest content (R07) ────────────────────────────────────────────────────────────────

export interface TaskDailyDigestShape extends TaskDueShape {
  status: 'open' | 'done'
  /** Whether the RECIPIENT's own `task_assignees` row is already completed. */
  completedByViewer: boolean
}

function addCivilDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

// ASSUMPTION(task-d): [R07] the digest set is the union of overdue tasks and tasks due on or before
// tomorrow in the recipient's time zone. Implemented here as a straight OR of `isOverdue`
// (reused from `task-dates.ts`, same rule 1/rule 3 the badge/pending path uses) with a "due at or
// before tomorrow" check — even though, read literally, ANY overdue task's due date/instant is
// ALSO at-or-before tomorrow (past ⊆ future-bounded-by-tomorrow), so the union is logically
// subsumed by the second clause alone. This function still evaluates BOTH clauses (rather than
// silently dropping the redundant one) so it stays a direct, reviewable transcription of the ruling
// text, and so a future change to either half (e.g. the digest excluding already-overdue items)
// only has to touch one clause.
/**
 * "已逾期的任务与今明两天将截止的未完成任务" (《任务设置》:13). `status !== 'open'` or
 * `completedByViewer` ⇒ `false` first (R07: "加 status open、本人未完成"). Otherwise: overdue
 * (`isOverdue`) OR due at/before tomorrow in `viewerTz` — scheduled: `dueAt` before the START of
 * the day AFTER tomorrow; all-day: `dueDate <= tomorrow`.
 */
export function isInDailyDigest(task: TaskDailyDigestShape, now: Date, viewerTz: string): boolean {
  if (task.status !== 'open' || task.completedByViewer) return false
  if (isOverdue(task, now, viewerTz)) return true
  if (task.dueTime) {
    if (!task.dueAt) return false
    const startOfTomorrow = viewerNextMidnight(now, viewerTz)
    const startOfDayAfterTomorrow = viewerNextMidnight(startOfTomorrow, viewerTz)
    return task.dueAt.getTime() < startOfDayAfterTomorrow.getTime()
  }
  if (!task.dueDate) return false
  const tomorrow = addCivilDays(viewerToday(now, viewerTz), 1)
  return task.dueDate <= tomorrow
}

export interface TaskDailyDigestConditionInput {
  actorParam: string
  orgParam: string
  /** The RECIPIENT's own configured `time_zone` (never a fallback to the task's own zone — R07's
   * "按用户 time_zone" is unconditional; `task-settings.ts`'s `parseSettingsPatch` is what makes
   * sure a user with `dailyReminderEnabled` can never have a null `timeZone` in the first place).
   * Bound as `$3`, same slot `task-access.ts`'s `buildTaskPendingCondition` uses for viewer tz. */
  viewerTzParam: string
}

/**
 * SQL text for R07's content rule, DERIVED FROM `buildTaskScopeCondition({view:'assigned'})` (same
 * "由 assigned 臂派生" requirement `buildTaskPendingCondition` already follows) — never writes its
 * own role arm. Mirrors `isInDailyDigest` above; the `isOverdue`-equivalent half is dropped here (it
 * is the same logically-subsumed redundancy noted above) since a SQL predicate has no reviewability
 * benefit from restating it, only extra text.
 */
export function buildTaskDailyDigestCondition(input: TaskDailyDigestConditionInput): TaskScopeCondition {
  const { actorParam, orgParam, viewerTzParam } = input
  const base = buildTaskScopeCondition({ view: 'assigned', actorParam, orgParam })
  const notCompletedByMe =
    `NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id ` +
    `AND ta_done.user_id = $1 AND ta_done.completed_at IS NOT NULL)`
  const dueWithinTomorrow =
    `((tasks.due_time IS NOT NULL AND tasks.due_at < (((now() AT TIME ZONE $3)::date + 2)::timestamp AT TIME ZONE $3)) OR ` +
    `(tasks.due_time IS NULL AND tasks.due_date <= ((now() AT TIME ZONE $3)::date + 1)))`
  const sql = `${base.sql} AND tasks.status = 'open' AND ${notCompletedByMe} AND ${dueWithinTomorrow}`
  return { sql, params: [...base.params, viewerTzParam] }
}
