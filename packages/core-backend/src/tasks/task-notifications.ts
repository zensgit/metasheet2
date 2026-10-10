/**
 * Task feature — event-to-notification matrix and recipient resolution (§13-19 notification
 * fan-out). PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-notifications.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-19 `:781` (already-decided direction: "creator ∪
 *         assignee ∪ follower ∪ list_member 排除 actor;recipient_role 闭集"), §4.2 `:101` (`task_events`
 *         closed set)
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 * §3.4 D13 collects the v2 revision of §13-19's DETAIL rules this module implements (the DIRECTION
 * itself — "creator ∪ assignee ∪ follower ∪ list_member, exclude actor" — is already decided).
 *
 * The outbox row planners at the end of this file (M4 PR-3b design §5.2, added by PR-3b S1) are
 * the single definition of the row shape the producer and the two scheduler scans insert; the
 * payload parser is their inverse for the delivery worker.
 */
import { isValidIanaTimeZone } from '../multitable/automation-timezone'
import {
  buildTaskDailyDigestSourceKey,
  buildTaskEventSourceKey,
  buildTaskListEventSourceKey,
  buildTaskReminderSourceKey,
} from './task-reminders'

// ── Event → notification matrix: the D13 trigger closed set ──────────────────────────────────────

// ASSUMPTION(task-d): [D13] the trigger closed set is `completed`/`completed_by_any`/`reopened`/
// `deleted`/`commented` — `attachment_added` is deferred to P2 (D13: it joins the set when
// attachments ship). `self_completed`/`self_reopened` NEVER notify (a solo actor completing/
// reopening their own row in an `all`-mode task where others remain unaffected does not fan out).
// ASSUMPTION(task-d): [R05-opt] `assignee_added` is deliberately ABSENT from this literal array —
// notifying a newly added assignee is OFF by default. Adopting R05-opt means adding the literal string
// `'assignee_added'` to this array (there is no separate on/off flag to flip: a closed TS union
// this small has no clean way to be "widened" by a boolean without also touching every switch that
// exhaustively matches `TaskNotifiableEvent`, so the array literal itself IS the single point of
// truth — editing it is the whole change).
export const TASK_NOTIFIABLE_EVENTS = ['completed', 'completed_by_any', 'reopened', 'deleted', 'commented'] as const
export type TaskNotifiableEvent = (typeof TASK_NOTIFIABLE_EVENTS)[number]

// ── recipient_role closed set (D13 priority: creator > assignee > follower > list_member) ────────

export const TASK_NOTIFICATION_RECIPIENT_ROLES = ['creator', 'assignee', 'follower', 'list_member'] as const
export type TaskNotificationRecipientRole = (typeof TASK_NOTIFICATION_RECIPIENT_ROLES)[number]

// ── Delivery channel name (the outbox `channel` column) ──────────────────────────────────────────

// ASSUMPTION(task-m4): [D4] M4 has one delivery channel. The literal is the task line's own: the
// producer writes it into `task_notification_deliveries.channel`, the registered channel carries it
// as its `name`, and the worker claims only rows whose channel is registered (PR-3b design §5.1, §8.1).
export const TASK_NOTIFICATION_CHANNEL_DINGTALK = 'dingtalk_work_notification' as const
export type TaskNotificationChannel = typeof TASK_NOTIFICATION_CHANNEL_DINGTALK
/** Every channel name an outbox row may carry (M4: one). The planners below accept no other. */
export const TASK_NOTIFICATION_CHANNELS: readonly TaskNotificationChannel[] = [TASK_NOTIFICATION_CHANNEL_DINGTALK]

// ASSUMPTION(task-d): [D13] priority order, HIGHEST first — a user who holds several roles on the
// same task is recorded under only the highest-priority one.
const RECIPIENT_ROLE_PRIORITY: readonly TaskNotificationRecipientRole[] = ['creator', 'assignee', 'follower', 'list_member']

export interface TaskNotificationRecipient {
  userId: string
  recipientRole: TaskNotificationRecipientRole
}

export interface ResolveNotificationRecipientsInput {
  event: TaskNotifiableEvent
  creatorId: string
  assigneeIds: string[]
  followerIds: string[]
  // ASSUMPTION(task-d): [D13] union of every member (read/edit/owner) of every list containing this
  // task — INCLUDING archived lists (archiving does not change anything on the task side).
  listMemberIds: string[]
  actorId: string
}

/**
 * D13: `creator ∪ assignee ∪ follower ∪ list_member`, EXCLUDING `actorId` (checked before
 * dedup-by-role, so the actor never appears under any role, even a lower-priority one). One person
 * in several sets ⇒ one row, at their HIGHEST-priority role (`RECIPIENT_ROLE_PRIORITY`) — sets are
 * consulted in priority order and a user already recorded is never re-recorded at a lower priority.
 * Output is sorted by `userId` (own choice, not ruling-derived — for a deterministic, diffable
 * result; the pack does not specify an output order). Throws for an event outside
 * `TASK_NOTIFIABLE_EVENTS` (a caller must not silently no-op-fan-out an unrecognized event name).
 */
export function resolveNotificationRecipients(input: ResolveNotificationRecipientsInput): TaskNotificationRecipient[] {
  if (!(TASK_NOTIFIABLE_EVENTS as readonly string[]).includes(input.event)) {
    throw new TypeError(`resolveNotificationRecipients: unknown event "${String(input.event)}"`)
  }
  // Driven BY `RECIPIENT_ROLE_PRIORITY` (not a parallel hard-coded call order) so that editing the
  // constant is the whole change if D13's priority is ever re-ruled — see the ASSUMPTION on that
  // constant above.
  const sourcesByRole: Record<TaskNotificationRecipientRole, string[]> = {
    creator: [input.creatorId],
    assignee: input.assigneeIds,
    follower: input.followerIds,
    list_member: input.listMemberIds,
  }
  const roleByUser = new Map<string, TaskNotificationRecipientRole>()
  for (const role of RECIPIENT_ROLE_PRIORITY) {
    for (const id of sourcesByRole[role]) {
      if (id === input.actorId) continue
      if (!roleByUser.has(id)) roleByUser.set(id, role)
    }
  }
  return [...roleByUser.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([userId, recipientRole]) => ({ userId, recipientRole }))
}

// ── Reminder-family recipients (R06) ──────────────────────────────────────────────────────────

export interface TaskAssigneeCompletionShape {
  userId: string
  completedAt: Date | null
}

// ASSUMPTION(task-d): [R06] the recipients are the incomplete assignees (completed_at IS NULL), and
// the creator when the task has no assignee — read LITERALLY: zero ASSIGNEE ROWS (not merely zero
// INCOMPLETE ones) falls back to the creator. A task with assignee rows that are ALL already
// complete returns an EMPTY array here (not the creator) — such a task should already be `done` and
// filtered out by `isReminderSkippedByTaskState` before this function is even reached; this
// function does not re-derive that skip itself. Followers never receive reminders (R06).
/** Reminder-family recipients: incomplete assignees, or `[creatorId]` when there are NO assignee
 * rows at all. */
export function resolveReminderRecipients(input: {
  assignees: TaskAssigneeCompletionShape[]
  creatorId: string
}): string[] {
  if (input.assignees.length === 0) return [input.creatorId]
  return input.assignees
    .filter((a) => a.completedAt === null || a.completedAt === undefined)
    .map((a) => a.userId)
}

// ASSUMPTION(task-d): [D13] the reminder AND daily-digest families always record
// `recipientRole: 'assignee'`, or `'creator'` for a zero-assignee task — never any other value
// from the four-way set above (they do not go through `resolveNotificationRecipients`'s priority
// resolution at all).
export function reminderRecipientRole(hasAssignees: boolean): TaskNotificationRecipientRole {
  return hasAssignees ? 'assignee' : 'creator'
}

// ── List-archive recipients (R05(e): the fourth `source_key` family) ─────────────────────────────

// ASSUMPTION(task-d): [R05(e)] archiving a list notifies the list's CREATOR (excluding the actor,
// same as every other family — an owner/editor who archives their OWN created list gets no
// notification).
// ASSUMPTION(task-d): [D13] recorded with `recipientRole: 'list_member'` even though the recipient
// is specifically the creator — the `task_list_events` recipient-role closed set has no separate
// "list creator" value, so this is the closest bucket (D13 records this family as `list_member`).
/** See the two ASSUMPTION notes immediately above for the ruling this implements. */
export function resolveListArchiveNotificationRecipients(input: {
  listCreatorId: string
  actorId: string
}): TaskNotificationRecipient[] {
  if (input.listCreatorId === input.actorId) return []
  return [{ userId: input.listCreatorId, recipientRole: 'list_member' }]
}

// ── Outbox row planners — the four families (M4 PR-3b design §5.2; added by PR-3b S1) ────────────
//
// The producer and the two scheduler scans turn recipient sets into rows of
// `task_notification_deliveries` through these four functions and nowhere else, so the row shape
// has one definition. A row carries ids and enum values only: no title, no body, no URL (the
// worker re-reads the task / list at send time and renders the text then; ASSUMPTION(task-m4):
// [own-3b-09]). Items the owner ruled on 2026-10-07 are tagged RULED(2026-10-07); the rest stay
// ASSUMPTION(task-m4).

/** `source_type` closed set, one value per family. */
export const TASK_NOTIFICATION_SOURCE_TYPES = ['task_event', 'task_reminder', 'task_daily', 'task_list_event'] as const
export type TaskNotificationSourceType = (typeof TASK_NOTIFICATION_SOURCE_TYPES)[number]

// RULED(2026-10-07): [R05] [D13] the only `task_list_events` type that produces a notification
// is `archived`. The producer checks an event against this literal before planning; the planner
// rejects anything else.
export const TASK_NOTIFIABLE_LIST_EVENTS = ['archived'] as const
export type TaskNotifiableListEvent = (typeof TASK_NOTIFIABLE_LIST_EVENTS)[number]

export type TaskNotificationPayload =
  | { kind: 'task_event'; event: TaskNotifiableEvent; taskId: string; eventId: string; actorId: string }
  | { kind: 'task_reminder'; taskId: string; remindAt: string }
  | { kind: 'task_daily'; date: string; timeZone: string }
  | { kind: 'task_list_event'; event: TaskNotifiableListEvent; listId: string; eventId: string; actorId: string }

/** One row to insert (column names in camelCase; the producer's INSERT maps them). */
export interface TaskNotificationDeliveryPlan {
  orgId: string
  sourceType: TaskNotificationSourceType
  sourceId: string
  sourceKey: string
  recipientUserId: string
  recipientRole: TaskNotificationRecipientRole
  channel: TaskNotificationChannel
  payload: TaskNotificationPayload
}

function requireId(fn: string, name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fn}: ${name} must be a non-empty string`)
  }
}

function requireInput(fn: string, input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(`${fn}: input must be an object`)
  }
}

function requireChannels(fn: string, channels: unknown): asserts channels is readonly TaskNotificationChannel[] {
  if (!Array.isArray(channels)) {
    throw new TypeError(`${fn}: channels must be an array`)
  }
  for (const channel of channels) {
    if (!(TASK_NOTIFICATION_CHANNELS as readonly string[]).includes(channel as string)) {
      throw new TypeError(`${fn}: unknown channel "${String(channel)}"`)
    }
  }
}

function requireRecipients(fn: string, recipients: unknown): asserts recipients is readonly TaskNotificationRecipient[] {
  if (!Array.isArray(recipients)) {
    throw new TypeError(`${fn}: recipients must be an array`)
  }
  for (const r of recipients) {
    if (typeof r !== 'object' || r === null) {
      throw new TypeError(`${fn}: each recipient must be an object`)
    }
    requireId(fn, 'recipient.userId', (r as { userId?: unknown }).userId)
    const role = (r as { recipientRole?: unknown }).recipientRole
    if (!(TASK_NOTIFICATION_RECIPIENT_ROLES as readonly string[]).includes(role as string)) {
      throw new TypeError(`${fn}: unknown recipientRole "${String(role)}"`)
    }
  }
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Keeps the first row per `source_key`; the unique index would reject the rest anyway, this only
 * makes the planned list deterministic (own choice, not ruling-derived). */
function dedupeBySourceKey(rows: TaskNotificationDeliveryPlan[]): TaskNotificationDeliveryPlan[] {
  const seen = new Set<string>()
  const out: TaskNotificationDeliveryPlan[] = []
  for (const row of rows) {
    if (seen.has(row.sourceKey)) continue
    seen.add(row.sourceKey)
    out.push(row)
  }
  return out
}

export interface PlanTaskEventDeliveriesInput {
  orgId: string
  taskId: string
  /** The `task_events.id` that triggered the notification. */
  eventId: string
  event: TaskNotifiableEvent
  actorId: string
  /** Already resolved by `resolveNotificationRecipients` (actor excluded, one role per user). */
  recipients: readonly TaskNotificationRecipient[]
  channels: readonly TaskNotificationChannel[]
}

/**
 * Family 3 (`task_event`): one row per recipient × channel. `source_id` is the task id; the payload
 * is `{ kind, event, taskId, eventId, actorId }`. Throws for an event outside
 * `TASK_NOTIFIABLE_EVENTS`, an unknown channel or role, or an empty id. Empty `channels` ⇒ `[]`.
 */
export function planTaskEventDeliveries(input: PlanTaskEventDeliveriesInput): TaskNotificationDeliveryPlan[] {
  const fn = 'planTaskEventDeliveries'
  requireInput(fn, input)
  const { orgId, taskId, eventId, event, actorId, recipients, channels } = input
  requireId(fn, 'orgId', orgId)
  requireId(fn, 'taskId', taskId)
  requireId(fn, 'eventId', eventId)
  requireId(fn, 'actorId', actorId)
  if (!(TASK_NOTIFIABLE_EVENTS as readonly string[]).includes(event as string)) {
    throw new TypeError(`${fn}: unknown event "${String(event)}"`)
  }
  requireRecipients(fn, recipients)
  requireChannels(fn, channels)
  const rows: TaskNotificationDeliveryPlan[] = []
  for (const recipient of recipients) {
    for (const channel of channels) {
      rows.push({
        orgId,
        sourceType: 'task_event',
        sourceId: taskId,
        sourceKey: buildTaskEventSourceKey({ taskId, eventId, userId: recipient.userId, channel }),
        recipientUserId: recipient.userId,
        recipientRole: recipient.recipientRole,
        channel,
        payload: { kind: 'task_event', event, taskId, eventId, actorId },
      })
    }
  }
  return dedupeBySourceKey(rows)
}

export interface PlanTaskReminderDeliveriesInput {
  orgId: string
  taskId: string
  /** The task's current `remind_at` (goes into the source key and the payload as ISO text). */
  remindAt: Date
  creatorId: string
  /** The task's assignee rows (`resolveReminderRecipients` picks the incomplete ones). */
  assignees: readonly TaskAssigneeCompletionShape[]
  channels: readonly TaskNotificationChannel[]
}

/**
 * Family 1 (`task_reminder`): recipients are `resolveReminderRecipients` (incomplete assignees, or
 * the creator when the task has no assignee rows) at `reminderRecipientRole`; one row per recipient
 * × channel; payload `{ kind, taskId, remindAt }` with `remindAt` as ISO-8601 text.
 */
export function planTaskReminderDeliveries(input: PlanTaskReminderDeliveriesInput): TaskNotificationDeliveryPlan[] {
  const fn = 'planTaskReminderDeliveries'
  requireInput(fn, input)
  const { orgId, taskId, remindAt, creatorId, assignees, channels } = input
  requireId(fn, 'orgId', orgId)
  requireId(fn, 'taskId', taskId)
  requireId(fn, 'creatorId', creatorId)
  if (!(remindAt instanceof Date) || Number.isNaN(remindAt.getTime())) {
    throw new TypeError(`${fn}: remindAt must be a valid Date`)
  }
  if (!Array.isArray(assignees)) {
    throw new TypeError(`${fn}: assignees must be an array`)
  }
  for (const a of assignees) {
    requireId(fn, 'assignee.userId', (a as { userId?: unknown })?.userId)
  }
  requireChannels(fn, channels)
  const recipientRole = reminderRecipientRole(assignees.length > 0)
  const remindAtIso = remindAt.toISOString()
  const rows: TaskNotificationDeliveryPlan[] = []
  for (const userId of resolveReminderRecipients({ assignees, creatorId })) {
    for (const channel of channels) {
      rows.push({
        orgId,
        sourceType: 'task_reminder',
        sourceId: taskId,
        sourceKey: buildTaskReminderSourceKey({ taskId, remindAt, userId, channel }),
        recipientUserId: userId,
        recipientRole,
        channel,
        payload: { kind: 'task_reminder', taskId, remindAt: remindAtIso },
      })
    }
  }
  return dedupeBySourceKey(rows)
}

export interface PlanTaskDailyDigestDeliveryInput {
  orgId: string
  userId: string
  /** The recipient's local calendar date (`YYYY-MM-DD`), from `resolveDailyDigestOccurrence`. */
  date: string
  /** The recipient's configured `task_user_settings.time_zone`. */
  timeZone: string
  channels: readonly TaskNotificationChannel[]
}

// RULED(2026-10-07): [R05] [D13] the digest row is recorded as `assignee` (the digest is derived from
// the recipient's own assigned arm; there is no zero-assignee branch here). `source_id` is the
// recipient, so the per-source index groups one user's digests.
/**
 * Family 2 (`task_daily`): one row per channel for one recipient; payload `{ kind, date, timeZone }`.
 * Throws on a malformed date or an invalid zone.
 */
export function planTaskDailyDigestDelivery(input: PlanTaskDailyDigestDeliveryInput): TaskNotificationDeliveryPlan[] {
  const fn = 'planTaskDailyDigestDelivery'
  requireInput(fn, input)
  const { orgId, userId, date, timeZone, channels } = input
  requireId(fn, 'orgId', orgId)
  requireId(fn, 'userId', userId)
  if (typeof date !== 'string' || !CALENDAR_DATE_RE.test(date)) {
    throw new TypeError(`${fn}: date must be YYYY-MM-DD`)
  }
  if (!isValidIanaTimeZone(timeZone)) {
    throw new TypeError(`${fn}: timeZone must be a valid IANA zone`)
  }
  requireChannels(fn, channels)
  const rows: TaskNotificationDeliveryPlan[] = channels.map((channel) => ({
    orgId,
    sourceType: 'task_daily',
    sourceId: userId,
    sourceKey: buildTaskDailyDigestSourceKey({ date, userId, channel }),
    recipientUserId: userId,
    recipientRole: 'assignee',
    channel,
    payload: { kind: 'task_daily', date, timeZone },
  }))
  return dedupeBySourceKey(rows)
}

export interface PlanTaskListEventDeliveriesInput {
  orgId: string
  listId: string
  /** The `task_list_events.id` that triggered the notification. */
  eventId: string
  event: TaskNotifiableListEvent
  listCreatorId: string
  actorId: string
  channels: readonly TaskNotificationChannel[]
}

/**
 * Family 4 (`task_list_event`): recipients are `resolveListArchiveNotificationRecipients` (the
 * list's creator unless they are the actor); one row per recipient × channel; payload
 * `{ kind, event, listId, eventId, actorId }`. Throws for an event outside
 * `TASK_NOTIFIABLE_LIST_EVENTS`.
 */
export function planTaskListEventDeliveries(input: PlanTaskListEventDeliveriesInput): TaskNotificationDeliveryPlan[] {
  const fn = 'planTaskListEventDeliveries'
  requireInput(fn, input)
  const { orgId, listId, eventId, event, listCreatorId, actorId, channels } = input
  requireId(fn, 'orgId', orgId)
  requireId(fn, 'listId', listId)
  requireId(fn, 'eventId', eventId)
  requireId(fn, 'listCreatorId', listCreatorId)
  requireId(fn, 'actorId', actorId)
  if (!(TASK_NOTIFIABLE_LIST_EVENTS as readonly string[]).includes(event as string)) {
    throw new TypeError(`${fn}: unknown list event "${String(event)}"`)
  }
  requireChannels(fn, channels)
  const rows: TaskNotificationDeliveryPlan[] = []
  for (const recipient of resolveListArchiveNotificationRecipients({ listCreatorId, actorId })) {
    for (const channel of channels) {
      rows.push({
        orgId,
        sourceType: 'task_list_event',
        sourceId: listId,
        sourceKey: buildTaskListEventSourceKey({ listId, eventId, userId: recipient.userId, channel }),
        recipientUserId: recipient.userId,
        recipientRole: recipient.recipientRole,
        channel,
        payload: { kind: 'task_list_event', event, listId, eventId, actorId },
      })
    }
  }
  return dedupeBySourceKey(rows)
}

// ── Payload parser — the planners' inverse, for the delivery worker (design §7.3) ────────────────

export type ParseTaskNotificationPayloadReason = 'payload_invalid' | 'unknown_kind'
export type ParseTaskNotificationPayloadResult =
  | { ok: true; payload: TaskNotificationPayload }
  | { ok: false; reason: ParseTaskNotificationPayloadReason }

function hasExactKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Reads a stored `payload` back into `TaskNotificationPayload`. A non-object, an unknown `kind`
 * (`unknown_kind`), a missing / extra / mistyped field, an event outside its closed set, a
 * non-canonical ISO `remindAt`, a malformed `date` or an invalid `timeZone` all fail
 * (`payload_invalid`); the worker records such a row as `failed` with the reason as `last_error`
 * and never retries it. The returned payload is a fresh object, not the input.
 */
export function parseTaskNotificationPayload(raw: unknown): ParseTaskNotificationPayloadResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'payload_invalid' }
  }
  const obj = raw as Record<string, unknown>
  const kind = obj.kind
  if (!(TASK_NOTIFICATION_SOURCE_TYPES as readonly string[]).includes(kind as string)) {
    return { ok: false, reason: 'unknown_kind' }
  }
  const invalid: ParseTaskNotificationPayloadResult = { ok: false, reason: 'payload_invalid' }
  switch (kind as TaskNotificationSourceType) {
    case 'task_event': {
      if (!hasExactKeys(obj, ['kind', 'event', 'taskId', 'eventId', 'actorId'])) return invalid
      const { event, taskId, eventId, actorId } = obj
      if (!(TASK_NOTIFIABLE_EVENTS as readonly string[]).includes(event as string)) return invalid
      if (!isNonEmptyString(taskId) || !isNonEmptyString(eventId) || !isNonEmptyString(actorId)) return invalid
      return { ok: true, payload: { kind: 'task_event', event: event as TaskNotifiableEvent, taskId, eventId, actorId } }
    }
    case 'task_reminder': {
      if (!hasExactKeys(obj, ['kind', 'taskId', 'remindAt'])) return invalid
      const { taskId, remindAt } = obj
      if (!isNonEmptyString(taskId) || !isNonEmptyString(remindAt)) return invalid
      const parsed = new Date(remindAt)
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== remindAt) return invalid
      return { ok: true, payload: { kind: 'task_reminder', taskId, remindAt } }
    }
    case 'task_daily': {
      if (!hasExactKeys(obj, ['kind', 'date', 'timeZone'])) return invalid
      const { date, timeZone } = obj
      if (!isNonEmptyString(date) || !CALENDAR_DATE_RE.test(date)) return invalid
      if (!isNonEmptyString(timeZone) || !isValidIanaTimeZone(timeZone)) return invalid
      return { ok: true, payload: { kind: 'task_daily', date, timeZone } }
    }
    case 'task_list_event': {
      if (!hasExactKeys(obj, ['kind', 'event', 'listId', 'eventId', 'actorId'])) return invalid
      const { event, listId, eventId, actorId } = obj
      if (!(TASK_NOTIFIABLE_LIST_EVENTS as readonly string[]).includes(event as string)) return invalid
      if (!isNonEmptyString(listId) || !isNonEmptyString(eventId) || !isNonEmptyString(actorId)) return invalid
      return {
        ok: true,
        payload: { kind: 'task_list_event', event: event as TaskNotifiableListEvent, listId, eventId, actorId },
      }
    }
  }
}
