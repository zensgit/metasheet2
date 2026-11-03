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
 * Reuses (does not reimplement) the imported date-reminder occurrence and due-window functions and
 * the imported IANA zone validator; lock `:140`/`:253` names that occurrence function as the
 * required all-day implementation. The occurrence function falls back to UTC on an invalid zone
 * and never throws, so this module validates the zone itself before calling it and throws on an
 * invalid zone. `time_zone` is also validated at write (task-dates.ts `computeDueAt` /
 * `validateViewerTimeZoneHeader`); the check here is a second, independent one.
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 */
import { computeDateReminderOccurrence, isDateReminderDue } from '../multitable/automation-date-reminder'
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import { isOverdue, viewerNextMidnight, viewerToday, type TaskDueShape } from './task-dates'
import { buildTaskScopeCondition, type TaskScopeCondition } from './task-access'

// ── default_remind_policy (§13-7 / R02③): closed set ─────────────────────────────────────────────

export type TaskRemindPolicy = { mode: 'default' } | { mode: 'none' }

export type ParseRemindPolicyReason = 'invalid_policy'
export type ParseRemindPolicyResult = { ok: true; policy: TaskRemindPolicy } | { ok: false; reason: ParseRemindPolicyReason }

// ASSUMPTION(task-d): [R02③] an unknown value is 422 and a missing row means `default`; the
// missing-row half is about the ROW being absent from `task_user_settings` entirely. This function
// additionally treats a `null`/`undefined` COLUMN VALUE (a row exists, but `default_remind_policy`
// itself is null) the same way — defaulting to `{mode:'default'}` — generalizing "missing" to cover
// both cases; ANY other
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
  /** The TASK's own IANA zone (never the viewer's zone — lock §4.4). */
  timeZone: string
  policy: TaskRemindPolicy
}

/** Scheduled branch offset (lock §4.4: "due_time − 30min"). */
const SCHEDULED_REMIND_OFFSET_MS = 30 * 60 * 1000
/** All-day branch local time-of-day (lock §4.4: "18:00"). */
const ALL_DAY_REMIND_TIME_OF_DAY = '18:00'

// ASSUMPTION(task-d, own choice — not ruling-derived): the all-day branch accepts only a strict,
// real `YYYY-MM-DD` calendar date and throws otherwise, before the occurrence function is called
// (lock §4.4 / R15: never silently coerce). The occurrence function parses its date argument with
// the platform's lenient `Date` parser, which rejects neither a nonexistent date (`2026-02-30`) nor
// a non-padded one (`2026-3-8`). The check is the same two steps as `task-dates.ts`'s private
// `parseIsoDate` (strict regex, then a UTC round-trip) and stays local rather than imported, as the
// name validators of `task-lists.ts` and `task-groups.ts` do.
function assertValidCalendarDateString(dueDate: string, fn = 'computeDefaultRemindAt', name = 'dueDate'): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate)
  if (!m) {
    throw new RangeError(`${fn}: ${name} must be YYYY-MM-DD, got "${dueDate}"`)
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`${fn}: "${dueDate}" is not a real calendar date`)
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
 * All-day: validates that `dueDate` is a STRICT, REAL `YYYY-MM-DD` calendar date and that
 * `timeZone` is a valid IANA zone, BOTH before calling anything else, and THROWS on either failure
 * (it never falls back to UTC and never rolls a nonexistent date over to a nearby real one); then
 * calls the imported occurrence function for 18:00 local time on `dueDate` in `timeZone`, zero days
 * before, as a floating time (lock `:140`/`:253`, reused verbatim).
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

// ── Write-time enqueue guard (R06: remind_at ≤ now at write is neither enqueued nor backfilled) ─

/** Strictly-future check at WRITE time — the write path's own gate, separate from the scan-time
 * window below. A `remindAt` at or before `writtenAt` is never enqueued (no backfill on write). */
export function shouldEnqueueReminder(remindAt: Date, writtenAt: Date): boolean {
  return remindAt.getTime() > writtenAt.getTime()
}

// ── Scan-time firing window (R06) ─────────────────────────────────────────────────────────────

// ASSUMPTION(task-d): [R06] `W`, the scan/backfill grace window, is a SINGLE-POINT constant here —
// R06's value is 2 hours, and W must not be smaller than the scheduler's tick interval (PR-3b,
// which sets `TASKS_SCHEDULER_INTERVAL_MS`, owns keeping that inequality true).
export const TASK_REMINDER_SCAN_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * R06: `floor ≤ remind_at ≤ now` AND `remind_at > now − W` — calls the imported due-window check
 * DIRECTLY (reused as is, lock/plan `:171`), rather than reimplementing its three-way bound check.
 * `floor` is the `occurred_at` of the event that most recently WROTE the current `remind_at` (a
 * `created` or `remind_changed` `task_events` row) — the caller reads that timestamp; this function
 * does not derive it. A `remindAt` outside the window is neither generated nor backfilled (R06).
 */
export function isTaskReminderDue(remindAt: Date, now: Date, floor: Date): boolean {
  return isDateReminderDue(remindAt.toISOString(), now.getTime(), TASK_REMINDER_SCAN_WINDOW_MS, floor.getTime())
}

// ASSUMPTION(task-d): [R06] a task that is done or soft-deleted when its reminder falls due gets no
// reminder (skipped) — a tiny pure predicate
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

// ── outbox source_key builders — all four families ───────────────────────────────────────────────

// ASSUMPTION(task-d): [R05/R06/R07] the ruling items fix only the PREFIX of each family
// (`task_reminder:<taskId>:<remind_at>:…`, `task_daily:<date>:…`,
// `task_list_event:<listId>:<eventId>:recipient:<uid>:channel:<ch>` for the fourth family — R05(e)).
// The `…`/interior shape for the reminder and daily families, and the THIRD family (regular
// completed/reopened/deleted/commented event notifications) entirely, are not fixed by any ruling
// item. This module fills them in with one shape for all four families: each key ends in
// `:recipient:<userId>:channel:<channel>`, the suffix the repo's existing reminder outbox keys
// already use. `channel` is a caller-supplied string, not a closed enum here: no ruling item gives
// a closed channel set for tasks, and that existing outbox keeps its channel as plain `text`
// resolved at runtime, with no DDL CHECK, so this module does not add one either.

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
 * The daily digest holds the viewer's overdue tasks and the open tasks due today or tomorrow.
 * `status !== 'open'` or `completedByViewer` ⇒ `false` first (R07: open tasks the viewer has not
 * completed). Otherwise: overdue (`isOverdue`) OR due at/before tomorrow in `viewerTz` — scheduled:
 * `dueAt` before the START of the day AFTER tomorrow; all-day: `dueDate <= tomorrow`.
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
  /** The RECIPIENT's own configured `time_zone` (never a fallback to the task's own zone — R07
   * always uses the recipient's own time_zone; `task-settings.ts`'s `parseSettingsPatch` is what
   * makes sure a user with `dailyReminderEnabled` can never have a null `timeZone` in the first place).
   * Bound as `$3`, same slot `task-access.ts`'s `buildTaskPendingCondition` uses for viewer tz. */
  viewerTzParam: string
}

/**
 * SQL text for R07's content rule, DERIVED FROM `buildTaskScopeCondition({view:'assigned'})` (the
 * same derived-from-the-assigned-arm requirement `buildTaskPendingCondition` already follows) —
 * never writes its own role arm. Mirrors `isInDailyDigest` above; the `isOverdue`-equivalent half
 * is dropped here (it is the same logically-subsumed redundancy noted above) since a SQL predicate
 * has no reviewability benefit from restating it, only extra text.
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

// ── Scheduler-side scan pieces (M4 PR-3b design §6.2 / §6.3; added by PR-3b S1) ─────────────────
//
// Everything below is consumed by the task scheduler's two scans. The rules stay here (gate 20:
// the service only calls them). Items the owner ruled on 2026-10-07 are tagged RULED(2026-10-07);
// the rest stay ASSUMPTION(task-m4).

/** Reminder scan page size: one page of candidate tasks per query (ASSUMPTION(task-m4): [own-3b-08]). */
export const TASK_REMINDER_SCAN_BATCH = 500

// RULED(2026-10-07): [R06] the floor of a reminder is the `occurred_at` of the most recent
// `task_events` row that WROTE the current `remind_at`: the task's `created` event or a
// `remind_changed` event. The scan's LATERAL subquery filters on exactly this set; a row with no
// such event has no floor and is never enqueued (fail closed).
export const TASK_REMINDER_FLOOR_EVENT_TYPES = ['created', 'remind_changed'] as const

export interface TaskReminderScanConditionInput {
  /** The tick's anchored `now` (`$1`). */
  nowParam: Date
  /** `TASK_REMINDER_SCAN_WINDOW_MS` in milliseconds (`$2`, bound as `int`). */
  windowMsParam: number
  /**
   * Keyset cursor, `remind_at` half (`$3`): `'-infinity'` for the first page
   * (`TASK_REMINDER_SCAN_CURSOR_START`), otherwise the previous page's last `remind_at` EXACTLY as
   * stored — preferably the database's own text of it (`tasks.remind_at::text`). A JS `Date` keeps
   * milliseconds only; it is exact for every value the application writes (millisecond ISO text)
   * but not for a microsecond value written by SQL, where a truncated cursor sorts below the row it
   * came from and the next page reads that row again (with a full page of such rows the scan would
   * not advance).
   */
  afterAtParam: Date | string
  /** Keyset cursor, `id` half (`$4`): the previous page's last row id, or `''` for the first page. */
  afterIdParam: string
}

// The text forms a cursor may take besides `'-infinity'`: PostgreSQL's ISO output of a
// timestamptz (`2026-10-07 11:30:00.123456+00`) or an ISO-8601 instant (`2026-10-07T11:30:00.123Z`).
// Words PostgreSQL would also accept (`'yesterday'`, `'now'`) are refused.
const TIMESTAMPTZ_TEXT_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2}){0,2})$/

/** The first page's keyset cursor (ASSUMPTION(task-m4): [own-3b-15]): `('-infinity', '')`. */
export const TASK_REMINDER_SCAN_CURSOR_START: Readonly<Pick<TaskReminderScanConditionInput, 'afterAtParam' | 'afterIdParam'>> =
  Object.freeze({ afterAtParam: '-infinity' as const, afterIdParam: '' })

/**
 * The ORDER BY the keyset condition below is only correct with. The service must emit this text
 * verbatim after the condition; a page is the first `TASK_REMINDER_SCAN_BATCH` rows in this order.
 */
export const TASK_REMINDER_SCAN_ORDER_BY = 'tasks.remind_at ASC, tasks.id ASC'

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

// RULED(2026-10-07): [R06] ASSUMPTION(task-m4): [own-3b-15] the candidate window in SQL is
// `now − W < remind_at ≤ now` over open, live tasks with a `remind_at`; the floor and the same
// window are judged again per row in TS by `isTaskReminderDue` (the floor is deliberately NOT in
// SQL, so its TS guard stays mutation-visible). The `(remind_at, id)` row comparison is the keyset
// cursor: one tick drains the whole window page by page instead of re-reading the same oldest rows
// every tick.
// The scan is cross-org on purpose (each row carries its own `org_id`, read by the caller); there is
// no org clause here and none may be added — the org clause text is emitted only by
// `task-access.ts`.
/**
 * `{ sql, params }` TEXT selecting one page of reminder candidates. `$1` = now, `$2` = window ms,
 * `$3` / `$4` = keyset cursor (`remind_at`, `id`). A caller appending its own parameters (the page
 * LIMIT) numbers them from `params.length + 1`. Must be paired with `TASK_REMINDER_SCAN_ORDER_BY`.
 */
export function buildTaskReminderScanCondition(input: TaskReminderScanConditionInput): TaskScopeCondition {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('buildTaskReminderScanCondition: input must be an object')
  }
  const { nowParam, windowMsParam, afterAtParam, afterIdParam } = input
  if (!isValidDate(nowParam)) {
    throw new TypeError('buildTaskReminderScanCondition: nowParam must be a valid Date')
  }
  if (!Number.isSafeInteger(windowMsParam) || windowMsParam <= 0 || windowMsParam > 2_147_483_647) {
    throw new TypeError('buildTaskReminderScanCondition: windowMsParam must be a positive int4')
  }
  const cursorAtOk =
    afterAtParam === '-infinity' ||
    isValidDate(afterAtParam) ||
    (typeof afterAtParam === 'string' && TIMESTAMPTZ_TEXT_RE.test(afterAtParam))
  if (!cursorAtOk) {
    throw new TypeError(
      "buildTaskReminderScanCondition: afterAtParam must be '-infinity', a valid Date or a timestamptz text",
    )
  }
  if (typeof afterIdParam !== 'string') {
    throw new TypeError('buildTaskReminderScanCondition: afterIdParam must be a string')
  }
  const sql =
    'tasks.remind_at IS NOT NULL AND tasks.remind_at <= $1::timestamptz ' +
    "AND tasks.remind_at > ($1::timestamptz - ($2::int * interval '1 millisecond')) " +
    "AND tasks.status = 'open' AND tasks.deleted_at IS NULL " +
    'AND (tasks.remind_at, tasks.id) > ($3::timestamptz, $4::text)'
  return { sql, params: [nowParam, windowMsParam, afterAtParam, afterIdParam] }
}

// ── Daily digest timing (R07: fixed 09:00 in the recipient's `time_zone`) ────────────────────────

// RULED(2026-10-07): [R07] the digest is sent at 09:00 local time, not configurable in M4.
export const TASK_DAILY_DIGEST_TIME_OF_DAY = '09:00'

/**
 * The instant of 09:00 on `localDate` (a strict, real `YYYY-MM-DD`) in `timeZone`, through the same
 * all-day conversion path `computeDefaultRemindAt` uses (no new Intl call site, D12). Both inputs
 * are validated first and the function THROWS on a bad date or zone rather than degrading to UTC:
 * `TypeError` for a value that is not a `YYYY-MM-DD` string, `RangeError` for a well-formed date
 * that does not exist (`2026-02-30`) or an invalid zone (the same classes `computeDefaultRemindAt`
 * uses for those two). On a day where local 09:00 is skipped or repeated the conversion decides
 * the instant; the scan window makes an hour of drift harmless.
 */
export function computeDailyDigestSendAt(localDate: string, timeZone: string): Date {
  if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new TypeError(`computeDailyDigestSendAt: localDate must be a YYYY-MM-DD string, got "${String(localDate)}"`)
  }
  assertValidCalendarDateString(localDate, 'computeDailyDigestSendAt', 'localDate')
  if (!isValidIanaTimeZone(timeZone)) {
    throw new RangeError(`computeDailyDigestSendAt: invalid IANA time zone "${String(timeZone)}"`)
  }
  const occurrenceIso = computeDateReminderOccurrence(
    localDate,
    { offsetDays: 0, direction: 'before', timeOfDay: TASK_DAILY_DIGEST_TIME_OF_DAY, timezone: timeZone },
    { floating: true },
  )
  if (occurrenceIso === null) {
    throw new RangeError(`computeDailyDigestSendAt: no occurrence for "${localDate}" in "${timeZone}"`)
  }
  return new Date(occurrenceIso)
}

export interface TaskDailyDigestOccurrence {
  /** The recipient's local calendar date of `now` (`viewerToday`), the `date` of the digest's source key. */
  localDate: string
  /** 09:00 of that date in the recipient's zone. */
  sendAt: Date
  /** Whether `sendAt ≤ now < sendAt + TASK_REMINDER_SCAN_WINDOW_MS`. */
  due: boolean
}

// RULED(2026-10-07): [R07] ASSUMPTION(task-m4): [own-3b-02] the digest is due from 09:00 local for
// one scan window W; later than that the day's digest is not sent (no catch-up at 15:00). The
// floor passed to the shared window predicate is the epoch: a digest has no write time, the window
// is its only lower bound.
/**
 * The digest occurrence for `now` in `timeZone`: the local date, its 09:00 instant and whether the
 * digest is due right now. Throws (never degrades) on an invalid zone or a non-Date `now`.
 */
export function resolveDailyDigestOccurrence(now: Date, timeZone: string): TaskDailyDigestOccurrence {
  if (!isValidDate(now)) {
    throw new TypeError('resolveDailyDigestOccurrence: now must be a valid Date')
  }
  if (!isValidIanaTimeZone(timeZone)) {
    throw new RangeError(`resolveDailyDigestOccurrence: invalid IANA time zone "${String(timeZone)}"`)
  }
  const localDate = viewerToday(now, timeZone)
  const sendAt = computeDailyDigestSendAt(localDate, timeZone)
  const due = isDateReminderDue(sendAt.toISOString(), now.getTime(), TASK_REMINDER_SCAN_WINDOW_MS, 0)
  return { localDate, sendAt, due }
}

/** `sendAt ≤ now < sendAt + W` for the recipient's local date of `now` (see `resolveDailyDigestOccurrence`). */
export function isDailyDigestDue(now: Date, timeZone: string): boolean {
  return resolveDailyDigestOccurrence(now, timeZone).due
}
