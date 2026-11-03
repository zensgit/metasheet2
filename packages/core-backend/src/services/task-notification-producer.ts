/**
 * Task notification producer: writes `task_notification_deliveries` rows (the outbox) in the same
 * transaction as the task or list write that produced the event (M4 PR-3b design
 * `docs/development/task-m4-pr3b-backend-design-20261001.md` §3.1, §5).
 *
 * Both entry points run on the caller's transaction client (`db`) and never open a transaction or
 * take a lock of their own. Order of work, each step returning 0 when it leaves nothing to do:
 *   1. the delivery channel names from the process switches (no switch on ⇒ nothing is read);
 *   2. the events that notify (none ⇒ nothing is read);
 *   3. per channel, the org precondition: one `EXISTS` on the org's integration rows;
 *   4. the task's members, one statement on the caller's client, so they are the post-write sets;
 *   5. recipients and rows from the pure planners, then one `INSERT … ON CONFLICT DO NOTHING`.
 *
 * ASSUMPTION(task-m4): [own-3b-01] no switch on ⇒ no row is written and no query is sent: the
 * only change on a request path while the pipeline is off is the in-memory check in step 1.
 * ASSUMPTION(task-m4): [own-3b-13] a DingTalk row is written only for an org that has an active
 * DingTalk integration row; there is no fallback to another org.
 * RULED(2026-10-07): [R05] [D13] the trigger set, the four recipient roles and their priority, the
 * actor's exclusion, and list members of every list holding the task (archived lists included) are
 * the pure functions' (`task-notifications.ts`); this module only feeds them.
 * RULED(2026-10-07): [R23] the outbox id is the column default (a uuid).
 */
import {
  planTaskEventDeliveries,
  planTaskListEventDeliveries,
  resolveListArchiveNotificationRecipients,
  resolveNotificationRecipients,
  TASK_NOTIFIABLE_EVENTS,
  TASK_NOTIFIABLE_LIST_EVENTS,
  TASK_NOTIFICATION_CHANNEL_DINGTALK,
  type TaskNotifiableEvent,
  type TaskNotifiableListEvent,
  type TaskNotificationChannel,
  type TaskNotificationDeliveryPlan,
} from '../tasks/task-notifications'
import { buildTaskListsOfTaskCondition } from '../tasks/task-list-access'
import { resolveTaskDeliveryChannelNames } from './task-notification-flags'
import type { Db } from './task-records'

/** One `task_events` row as its writer inserted it (the id is generated before the INSERT). */
export interface WrittenTaskEvent {
  id: string
  type: string
  actorId: string
  /** The bound `occurred_at`; `null` when the value is taken in SQL (a column default or a copy). */
  occurredAt: Date | null
}

function isNotifiableTaskEvent(type: string): type is TaskNotifiableEvent {
  return (TASK_NOTIFIABLE_EVENTS as readonly string[]).includes(type)
}

function isNotifiableListEvent(type: string): type is TaskNotifiableListEvent {
  return (TASK_NOTIFIABLE_LIST_EVENTS as readonly string[]).includes(type)
}

/**
 * The subset of `names` whose org precondition holds for `orgId`. The DingTalk channel needs an
 * active DingTalk integration row of that same org. A channel name this function does not know is
 * dropped. No name ⇒ no query.
 */
export async function resolveTaskDeliveryChannelsForOrg(
  db: Db,
  orgId: string,
  names: readonly TaskNotificationChannel[],
): Promise<TaskNotificationChannel[]> {
  if (names.length === 0) return []
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM directory_integrations
        WHERE org_id = $1 AND provider = 'dingtalk' AND status = 'active'
     ) AS dingtalk_active`,
    [orgId],
  )
  const dingTalkActive = result.rows[0]?.dingtalk_active === true
  return names.filter((name) => name === TASK_NOTIFICATION_CHANNEL_DINGTALK && dingTalkActive)
}

/**
 * Inserts the planned rows in one statement and returns how many were new. A row whose
 * `(org_id, source_key)` already exists is left as it is (`DO NOTHING`), so a repeated call for the
 * same event, recipient and channel never adds or changes a row. The single INSERT text of the
 * outbox: the event producer here and the scheduler scans use it.
 */
export async function insertTaskNotificationDeliveries(
  db: Db,
  plans: readonly TaskNotificationDeliveryPlan[],
): Promise<number> {
  if (plans.length === 0) return 0
  const result = await db.query(
    `INSERT INTO task_notification_deliveries
       (org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
     SELECT r.org_id, r.source_type, r.source_id, r.source_key, r.recipient_user_id, r.recipient_role,
            r.channel, r.payload::jsonb
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
         AS r(org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, payload)
     ON CONFLICT (org_id, source_key) DO NOTHING
     RETURNING id`,
    [
      plans.map((plan) => plan.orgId),
      plans.map((plan) => plan.sourceType),
      plans.map((plan) => plan.sourceId),
      plans.map((plan) => plan.sourceKey),
      plans.map((plan) => plan.recipientUserId),
      plans.map((plan) => plan.recipientRole),
      plans.map((plan) => plan.channel),
      plans.map((plan) => JSON.stringify(plan.payload)),
    ],
  )
  return result.rows.length
}

interface TaskMemberIds {
  assigneeIds: string[]
  followerIds: string[]
  listMemberIds: string[]
}

/**
 * The task's assignees, followers and list members, read on the caller's client after its write,
 * in one statement. List members come from the lists of the task's org only
 * (`buildTaskListsOfTaskCondition`); the assignee and follower rows belong to the task id the
 * caller has already resolved in its org.
 */
async function loadTaskMemberIds(db: Db, input: { orgId: string; taskId: string }): Promise<TaskMemberIds> {
  const lists = buildTaskListsOfTaskCondition({ taskIdParam: input.taskId, orgParam: input.orgId })
  const result = await db.query(
    `SELECT 'assignee' AS member_kind, ta.user_id FROM task_assignees ta WHERE ta.task_id = $1
     UNION ALL
     SELECT 'follower' AS member_kind, tf.user_id FROM task_followers tf WHERE tf.task_id = $1
     UNION ALL
     SELECT 'list_member' AS member_kind, tlm.user_id
       FROM task_lists
       JOIN task_list_members tlm ON tlm.list_id = task_lists.id
      WHERE ${lists.sql}`,
    lists.params,
  )
  const ids: TaskMemberIds = { assigneeIds: [], followerIds: [], listMemberIds: [] }
  for (const row of result.rows) {
    const userId = String(row.user_id)
    if (row.member_kind === 'assignee') ids.assigneeIds.push(userId)
    else if (row.member_kind === 'follower') ids.followerIds.push(userId)
    else if (row.member_kind === 'list_member') ids.listMemberIds.push(userId)
  }
  return ids
}

/**
 * Event family. Call after the events are written, on the same client. `createdBy` is the task's
 * creator as the caller loaded it; the task row is not read again (a soft-deleted task is still
 * notified). Returns the number of rows written.
 */
export async function enqueueTaskEventNotifications(db: Db, input: {
  orgId: string
  taskId: string
  createdBy: string
  events: readonly WrittenTaskEvent[]
}): Promise<number> {
  const names = resolveTaskDeliveryChannelNames()
  if (names.length === 0) return 0
  const notifiable = input.events.filter((event) => isNotifiableTaskEvent(event.type))
  if (notifiable.length === 0) return 0
  const channels = await resolveTaskDeliveryChannelsForOrg(db, input.orgId, names)
  if (channels.length === 0) return 0
  const members = await loadTaskMemberIds(db, input)
  const plans: TaskNotificationDeliveryPlan[] = []
  for (const event of notifiable) {
    const recipients = resolveNotificationRecipients({
      event: event.type as TaskNotifiableEvent,
      creatorId: input.createdBy,
      assigneeIds: members.assigneeIds,
      followerIds: members.followerIds,
      listMemberIds: members.listMemberIds,
      actorId: event.actorId,
    })
    plans.push(...planTaskEventDeliveries({
      orgId: input.orgId,
      taskId: input.taskId,
      eventId: event.id,
      event: event.type as TaskNotifiableEvent,
      actorId: event.actorId,
      recipients,
      channels,
    }))
  }
  return insertTaskNotificationDeliveries(db, plans)
}

/**
 * List family: only `archived` notifies, and only the list's creator unless the creator is the
 * actor. Call after the list event is written, on the same client. Returns the number of rows
 * written.
 */
export async function enqueueTaskListEventNotifications(db: Db, input: {
  orgId: string
  listId: string
  listCreatorId: string
  actorId: string
  event: { id: string; type: string }
}): Promise<number> {
  const names = resolveTaskDeliveryChannelNames()
  if (names.length === 0) return 0
  if (!isNotifiableListEvent(input.event.type)) return 0
  if (resolveListArchiveNotificationRecipients({ listCreatorId: input.listCreatorId, actorId: input.actorId }).length === 0) {
    return 0
  }
  const channels = await resolveTaskDeliveryChannelsForOrg(db, input.orgId, names)
  if (channels.length === 0) return 0
  return insertTaskNotificationDeliveries(db, planTaskListEventDeliveries({
    orgId: input.orgId,
    listId: input.listId,
    eventId: input.event.id,
    event: input.event.type as TaskNotifiableListEvent,
    listCreatorId: input.listCreatorId,
    actorId: input.actorId,
    channels,
  }))
}
