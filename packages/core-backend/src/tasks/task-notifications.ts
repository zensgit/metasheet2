/**
 * Task feature — event-to-notification matrix and recipient resolution (§13-19 notification
 * fan-out). PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-notifications.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-19 `:781` (already-decided direction: "creator ∪
 *         assignee ∪ follower ∪ list_member 排除 actor;recipient_role 闭集"), §4.2 `:101` (`task_events`
 *         closed set)
 *
 * This whole module implements the M4 ruling pack v2 (PROPOSED, not owner-ratified) — every
 * `ASSUMPTION(task-d)` comment below names the ruling id it implements the RECOMMENDED value of.
 * §3.4 D13 collects the v2 revision of §13-19's DETAIL rules this module implements (the DIRECTION
 * itself — "creator ∪ assignee ∪ follower ∪ list_member, exclude actor" — is already decided).
 */

// ── Event → notification matrix: the D13 trigger closed set ──────────────────────────────────────

// ASSUMPTION(task-d): [D13] the trigger closed set is `completed`/`completed_by_any`/`reopened`/
// `deleted`/`commented` — `attachment_added` is explicitly deferred to P2 (D13: "P2 附件上线时再加
// attachment_added"). `self_completed`/`self_reopened` NEVER notify (a solo actor completing/
// reopening their own row in an `all`-mode task where others remain unaffected does not fan out).
// `assignee_added` is likewise NOT in this set by default — see `TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN`
// below (R05-opt).
export const TASK_NOTIFIABLE_EVENTS = ['completed', 'completed_by_any', 'reopened', 'deleted', 'commented'] as const
export type TaskNotifiableEvent = (typeof TASK_NOTIFIABLE_EVENTS)[number]

/** `true` ⇒ `assignee_added` is NOT a notifiable event by default (R05-opt: "被加负责人收通知" is
 * the pack's own invented design — no corpus source page — and defaults to OFF; owner must name it
 * explicitly to turn it on). This constant exists so a future flip is a one-line, greppable change
 * rather than a silent removal of a line from `TASK_NOTIFIABLE_EVENTS`. */
export const TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN = false

// ── recipient_role closed set (D13 priority: creator > assignee > follower > list_member) ────────

export const TASK_NOTIFICATION_RECIPIENT_ROLES = ['creator', 'assignee', 'follower', 'list_member'] as const
export type TaskNotificationRecipientRole = (typeof TASK_NOTIFICATION_RECIPIENT_ROLES)[number]

/** Priority order, HIGHEST first — a user who holds several roles on the same task is recorded
 * under only the highest-priority one (D13). */
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
  /** Union of every member (read/edit/owner) of every list containing this task — INCLUDING
   * archived lists (D13: "已归档清单也算,因为归档不改变任务侧行为"). */
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
  const roleByUser = new Map<string, TaskNotificationRecipientRole>()
  const consider = (ids: string[], role: TaskNotificationRecipientRole) => {
    for (const id of ids) {
      if (id === input.actorId) continue
      if (!roleByUser.has(id)) roleByUser.set(id, role)
    }
  }
  consider([input.creatorId], 'creator')
  consider(input.assigneeIds, 'assignee')
  consider(input.followerIds, 'follower')
  consider(input.listMemberIds, 'list_member')
  return [...roleByUser.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([userId, recipientRole]) => ({ userId, recipientRole }))
}

// ── Reminder-family recipients (R06) ──────────────────────────────────────────────────────────

export interface TaskAssigneeCompletionShape {
  userId: string
  completedAt: Date | null
}

// ASSUMPTION(task-d): [R06] "收件人为未完成的负责人(completed_at IS NULL),零负责人时发给
// creator" — read LITERALLY: zero ASSIGNEE ROWS (not merely zero INCOMPLETE ones) falls back to the
// creator. A task with assignee rows that are ALL already complete returns an EMPTY array here
// (not the creator) — such a task should already be `done` and filtered out by
// `isReminderSkippedByTaskState` before this function is even reached; this function does not
// re-derive that skip itself. Followers never receive reminders (R06: "关注人不收提醒",《创建任务》
// :26).
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

/** D13: the reminder AND daily-digest families always record `recipientRole: 'assignee'`, or
 * `'creator'` for a zero-assignee task — never any other value from the four-way set above (they
 * do not go through `resolveNotificationRecipients`'s priority resolution at all). */
export function reminderRecipientRole(hasAssignees: boolean): TaskNotificationRecipientRole {
  return hasAssignees ? 'assignee' : 'creator'
}

// ── List-archive recipients (R05(e): the fourth `source_key` family) ─────────────────────────────

/**
 * R05(e): archiving a list notifies the list's CREATOR (excluding the actor, same as every other
 * family — an owner/editor who archives their OWN created list gets no notification). D13: recorded
 * with `recipientRole: 'list_member'` even though the recipient is specifically the creator — the
 * `task_list_events` recipient-role closed set has no separate "list creator" value, so this is the
 * closest bucket (D13's exact words: "recipient_role='list_member'").
 */
export function resolveListArchiveNotificationRecipients(input: {
  listCreatorId: string
  actorId: string
}): TaskNotificationRecipient[] {
  if (input.listCreatorId === input.actorId) return []
  return [{ userId: input.listCreatorId, recipientRole: 'list_member' }]
}
