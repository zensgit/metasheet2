import { describe, expect, it } from 'vitest'
import {
  TASK_NOTIFIABLE_EVENTS,
  TASK_NOTIFIABLE_LIST_EVENTS,
  TASK_NOTIFICATION_CHANNELS,
  TASK_NOTIFICATION_CHANNEL_DINGTALK,
  TASK_NOTIFICATION_SOURCE_TYPES,
  parseTaskNotificationPayload,
  planTaskDailyDigestDelivery,
  planTaskEventDeliveries,
  planTaskListEventDeliveries,
  planTaskReminderDeliveries,
  reminderRecipientRole,
  resolveListArchiveNotificationRecipients,
  resolveNotificationRecipients,
  resolveReminderRecipients,
  type ResolveNotificationRecipientsInput,
  type TaskNotificationDeliveryPlan,
} from '../../src/tasks/task-notifications'

const ACTOR = 'actor'

function baseInput(overrides: Partial<ResolveNotificationRecipientsInput> = {}): ResolveNotificationRecipientsInput {
  return {
    event: 'completed',
    creatorId: 'creator',
    assigneeIds: [],
    followerIds: [],
    listMemberIds: [],
    actorId: ACTOR,
    ...overrides,
  }
}

describe('task-notifications', () => {
  describe('TASK_NOTIFIABLE_EVENTS', () => {
    it('is the D13 closed set (attachment_added deferred to P2)', () => {
      expect(TASK_NOTIFIABLE_EVENTS).toEqual(['completed', 'completed_by_any', 'reopened', 'deleted', 'commented'])
    })

    it('assignee_added is NOT notifiable by default (R05-opt) — absent from the array itself', () => {
      expect((TASK_NOTIFIABLE_EVENTS as readonly string[]).includes('assignee_added')).toBe(false)
    })

    it('self_completed / self_reopened are NOT notifiable', () => {
      expect((TASK_NOTIFIABLE_EVENTS as readonly string[]).includes('self_completed')).toBe(false)
      expect((TASK_NOTIFIABLE_EVENTS as readonly string[]).includes('self_reopened')).toBe(false)
    })
  })

  describe('resolveNotificationRecipients', () => {
    it('throws for an event outside the closed set', () => {
      expect(() => resolveNotificationRecipients(baseInput({ event: 'assignee_added' as never }))).toThrow(TypeError)
      expect(() => resolveNotificationRecipients(baseInput({ event: 'self_completed' as never }))).toThrow(TypeError)
    })

    it('creator ∪ assignee ∪ follower ∪ list_member, each in their own role', () => {
      const result = resolveNotificationRecipients(
        baseInput({
          creatorId: 'creator',
          assigneeIds: ['assignee1'],
          followerIds: ['follower1'],
          listMemberIds: ['member1'],
        }),
      )
      expect(result).toEqual([
        { userId: 'assignee1', recipientRole: 'assignee' },
        { userId: 'creator', recipientRole: 'creator' },
        { userId: 'follower1', recipientRole: 'follower' },
        { userId: 'member1', recipientRole: 'list_member' },
      ])
    })

    it('excludes the actor even when the actor holds a role', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'creator', assigneeIds: [ACTOR], actorId: ACTOR }),
      )
      expect(result).toEqual([{ userId: 'creator', recipientRole: 'creator' }])
    })

    it('excludes the actor when the actor IS the creator', () => {
      const result = resolveNotificationRecipients(baseInput({ creatorId: ACTOR, assigneeIds: ['a1'] }))
      expect(result).toEqual([{ userId: 'a1', recipientRole: 'assignee' }])
    })

    it('a person in multiple roles is recorded ONCE at their HIGHEST-priority role: creator > assignee', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'u1', assigneeIds: ['u1'], followerIds: ['u1'], listMemberIds: ['u1'] }),
      )
      expect(result).toEqual([{ userId: 'u1', recipientRole: 'creator' }])
    })

    it('priority: assignee > follower when not the creator', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'creator', assigneeIds: ['u1'], followerIds: ['u1'] }),
      )
      expect(result).toEqual([
        { userId: 'creator', recipientRole: 'creator' },
        { userId: 'u1', recipientRole: 'assignee' },
      ])
    })

    it('priority: follower > list_member', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'creator', followerIds: ['u1'], listMemberIds: ['u1'] }),
      )
      expect(result).toEqual([
        { userId: 'creator', recipientRole: 'creator' },
        { userId: 'u1', recipientRole: 'follower' },
      ])
    })

    it('no recipients besides the (excluded) actor -> empty array', () => {
      const result = resolveNotificationRecipients(baseInput({ creatorId: ACTOR }))
      expect(result).toEqual([])
    })

    it('output is sorted by userId (deterministic)', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'zzz', assigneeIds: ['aaa'], followerIds: ['mmm'] }),
      )
      expect(result.map((r) => r.userId)).toEqual(['aaa', 'mmm', 'zzz'])
    })

    it('duplicate ids within the SAME set are deduped', () => {
      const result = resolveNotificationRecipients(baseInput({ creatorId: 'creator', assigneeIds: ['a1', 'a1'] }))
      expect(result).toEqual([
        { userId: 'a1', recipientRole: 'assignee' },
        { userId: 'creator', recipientRole: 'creator' },
      ])
    })

    it('every notifiable event is accepted without throwing', () => {
      for (const event of TASK_NOTIFIABLE_EVENTS) {
        expect(() => resolveNotificationRecipients(baseInput({ event }))).not.toThrow()
      }
    })

    // Negative control (M4-b): reordering the `consider` calls to put follower before assignee
    // would flip a user who is BOTH an assignee and a follower to `recipientRole: 'follower'` —
    // this test pins the priority-dependent case that mutation would break.
    it('mutation-sensitive: assignee+follower same user resolves to assignee, not follower', () => {
      const result = resolveNotificationRecipients(
        baseInput({ creatorId: 'creator', assigneeIds: ['dual'], followerIds: ['dual'] }),
      )
      expect(result.find((r) => r.userId === 'dual')?.recipientRole).toBe('assignee')
    })
  })

  describe('resolveReminderRecipients', () => {
    it('zero assignee rows -> [creatorId]', () => {
      expect(resolveReminderRecipients({ assignees: [], creatorId: 'creator' })).toEqual(['creator'])
    })

    it('incomplete assignees only', () => {
      const result = resolveReminderRecipients({
        assignees: [
          { userId: 'a1', completedAt: null },
          { userId: 'a2', completedAt: null },
        ],
        creatorId: 'creator',
      })
      expect(result).toEqual(['a1', 'a2'])
    })

    it('excludes already-completed assignees', () => {
      const result = resolveReminderRecipients({
        assignees: [
          { userId: 'a1', completedAt: new Date('2026-01-01') },
          { userId: 'a2', completedAt: null },
        ],
        creatorId: 'creator',
      })
      expect(result).toEqual(['a2'])
    })

    it('all assignees complete (non-zero rows) -> empty array, NOT creatorId', () => {
      const result = resolveReminderRecipients({
        assignees: [{ userId: 'a1', completedAt: new Date('2026-01-01') }],
        creatorId: 'creator',
      })
      expect(result).toEqual([])
    })

    it('followers are never included (not part of this input at all)', () => {
      // Type-level: `resolveReminderRecipients` takes no followerIds parameter, so there is nothing
      // to assert here beyond the signature — this test documents the intent.
      const result = resolveReminderRecipients({ assignees: [{ userId: 'a1', completedAt: null }], creatorId: 'creator' })
      expect(result).toEqual(['a1'])
    })
  })

  describe('reminderRecipientRole', () => {
    it('hasAssignees: true -> assignee', () => {
      expect(reminderRecipientRole(true)).toBe('assignee')
    })

    it('hasAssignees: false -> creator', () => {
      expect(reminderRecipientRole(false)).toBe('creator')
    })
  })

  describe('resolveListArchiveNotificationRecipients', () => {
    it('notifies the list creator with recipientRole list_member (R05(e))', () => {
      const result = resolveListArchiveNotificationRecipients({ listCreatorId: 'creator', actorId: ACTOR })
      expect(result).toEqual([{ userId: 'creator', recipientRole: 'list_member' }])
    })

    it('creator archiving their own list -> excluded, empty array', () => {
      const result = resolveListArchiveNotificationRecipients({ listCreatorId: ACTOR, actorId: ACTOR })
      expect(result).toEqual([])
    })
  })
})

// ── PR-3b S1 additions: outbox row planners and the payload parser (design §5.2, §7.3) ──────────

describe('task-notifications — outbox row planners (PR-3b S1)', () => {
  const CH = TASK_NOTIFICATION_CHANNEL_DINGTALK
  const USER_TEXT_KEYS = ['title', 'content', 'body', 'text', 'url', 'link', 'name']

  function expectNoUserText(rows: TaskNotificationDeliveryPlan[]): void {
    for (const row of rows) {
      for (const key of USER_TEXT_KEYS) {
        expect(Object.keys(row.payload)).not.toContain(key)
        expect(Object.keys(row)).not.toContain(key)
      }
    }
  }

  describe('closed sets', () => {
    it('TASK_NOTIFICATION_SOURCE_TYPES is the four families', () => {
      expect(TASK_NOTIFICATION_SOURCE_TYPES).toEqual(['task_event', 'task_reminder', 'task_daily', 'task_list_event'])
    })

    it('TASK_NOTIFIABLE_LIST_EVENTS is only archived (R05(e))', () => {
      expect(TASK_NOTIFIABLE_LIST_EVENTS).toEqual(['archived'])
    })

    it('TASK_NOTIFICATION_CHANNELS is the single DingTalk channel name', () => {
      expect(TASK_NOTIFICATION_CHANNELS).toEqual(['dingtalk_work_notification'])
      expect(TASK_NOTIFICATION_CHANNEL_DINGTALK).toBe('dingtalk_work_notification')
    })
  })

  describe('planTaskEventDeliveries (family 3)', () => {
    const base = {
      orgId: 'org-1',
      taskId: 't1',
      eventId: 'tev_1',
      event: 'completed' as const,
      actorId: 'actor',
      recipients: [
        { userId: 'u1', recipientRole: 'follower' as const },
        { userId: 'u2', recipientRole: 'creator' as const },
      ],
      channels: [CH],
    }

    it('one row per recipient × channel with the exact row shape and an id-only payload', () => {
      const rows = planTaskEventDeliveries(base)
      expect(rows).toEqual([
        {
          orgId: 'org-1',
          sourceType: 'task_event',
          sourceId: 't1',
          sourceKey: 'task_event:t1:tev_1:recipient:u1:channel:dingtalk_work_notification',
          recipientUserId: 'u1',
          recipientRole: 'follower',
          channel: 'dingtalk_work_notification',
          payload: { kind: 'task_event', event: 'completed', taskId: 't1', eventId: 'tev_1', actorId: 'actor' },
        },
        {
          orgId: 'org-1',
          sourceType: 'task_event',
          sourceId: 't1',
          sourceKey: 'task_event:t1:tev_1:recipient:u2:channel:dingtalk_work_notification',
          recipientUserId: 'u2',
          recipientRole: 'creator',
          channel: 'dingtalk_work_notification',
          payload: { kind: 'task_event', event: 'completed', taskId: 't1', eventId: 'tev_1', actorId: 'actor' },
        },
      ])
      expectNoUserText(rows)
    })

    it('payload keys are exactly kind/event/taskId/eventId/actorId', () => {
      const [row] = planTaskEventDeliveries(base)
      expect(Object.keys(row.payload).sort()).toEqual(['actorId', 'event', 'eventId', 'kind', 'taskId'])
    })

    it('no channels (pipeline off) -> no rows; no recipients -> no rows', () => {
      expect(planTaskEventDeliveries({ ...base, channels: [] })).toEqual([])
      expect(planTaskEventDeliveries({ ...base, recipients: [] })).toEqual([])
    })

    it('a recipient listed twice yields one row (deduped by source_key)', () => {
      const rows = planTaskEventDeliveries({ ...base, recipients: [base.recipients[0], base.recipients[0]] })
      expect(rows).toHaveLength(1)
    })

    it('every notifiable event is accepted; self_completed / assignee_added / unknown are rejected', () => {
      for (const event of TASK_NOTIFIABLE_EVENTS) {
        expect(planTaskEventDeliveries({ ...base, event })[0].payload).toMatchObject({ event })
      }
      for (const event of ['self_completed', 'self_reopened', 'assignee_added', 'x', '']) {
        expect(() => planTaskEventDeliveries({ ...base, event: event as never })).toThrow(TypeError)
      }
    })

    it('rejects an unknown channel, an unknown role, an empty id, a non-array, and a non-object input', () => {
      expect(() => planTaskEventDeliveries({ ...base, channels: ['email'] as never })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, recipients: [{ userId: 'u1', recipientRole: 'observer' as never }] })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, recipients: [{ userId: '', recipientRole: 'creator' }] })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, orgId: '' })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, taskId: 7 as never })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, eventId: '' })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, actorId: '' })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, recipients: 'u1' as never })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries({ ...base, channels: CH as never })).toThrow(TypeError)
      expect(() => planTaskEventDeliveries('x' as never)).toThrow(TypeError)
    })
  })

  describe('planTaskReminderDeliveries (family 1)', () => {
    const remindAt = new Date('2026-10-07T01:00:00.000Z')
    const base = { orgId: 'org-1', taskId: 't1', remindAt, creatorId: 'creator', channels: [CH] }

    it('incomplete assignees only, role assignee, remindAt as ISO text in key and payload', () => {
      const rows = planTaskReminderDeliveries({
        ...base,
        assignees: [
          { userId: 'a1', completedAt: null },
          { userId: 'a2', completedAt: new Date('2026-10-01T00:00:00.000Z') },
        ],
      })
      expect(rows).toEqual([
        {
          orgId: 'org-1',
          sourceType: 'task_reminder',
          sourceId: 't1',
          sourceKey: 'task_reminder:t1:2026-10-07T01:00:00.000Z:recipient:a1:channel:dingtalk_work_notification',
          recipientUserId: 'a1',
          recipientRole: 'assignee',
          channel: 'dingtalk_work_notification',
          payload: { kind: 'task_reminder', taskId: 't1', remindAt: '2026-10-07T01:00:00.000Z' },
        },
      ])
      expectNoUserText(rows)
    })

    it('zero assignee rows -> the creator at role creator', () => {
      const rows = planTaskReminderDeliveries({ ...base, assignees: [] })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ recipientUserId: 'creator', recipientRole: 'creator', sourceId: 't1' })
    })

    it('all assignees complete -> no rows (not the creator)', () => {
      expect(planTaskReminderDeliveries({ ...base, assignees: [{ userId: 'a1', completedAt: new Date() }] })).toEqual([])
    })

    it('no channels -> no rows; the same channel twice -> one row', () => {
      const assignees = [{ userId: 'a1', completedAt: null }]
      expect(planTaskReminderDeliveries({ ...base, assignees, channels: [] })).toEqual([])
      expect(planTaskReminderDeliveries({ ...base, assignees, channels: [CH, CH] })).toHaveLength(1)
    })

    it('rejects an invalid remindAt, a bad assignee row, and a non-object input', () => {
      const assignees = [{ userId: 'a1', completedAt: null }]
      expect(() => planTaskReminderDeliveries({ ...base, assignees, remindAt: '2026-10-07' as never })).toThrow(TypeError)
      expect(() => planTaskReminderDeliveries({ ...base, assignees, remindAt: new Date(NaN) })).toThrow(TypeError)
      expect(() => planTaskReminderDeliveries({ ...base, assignees: [{ userId: '', completedAt: null }] })).toThrow(TypeError)
      expect(() => planTaskReminderDeliveries({ ...base, assignees: 'a1' as never })).toThrow(TypeError)
      expect(() => planTaskReminderDeliveries({ ...base, assignees, creatorId: '' })).toThrow(TypeError)
      expect(() => planTaskReminderDeliveries('x' as never)).toThrow(TypeError)
    })
  })

  describe('planTaskDailyDigestDelivery (family 2)', () => {
    const base = { orgId: 'org-1', userId: 'u1', date: '2026-10-07', timeZone: 'Asia/Shanghai', channels: [CH] }

    it('one row per channel: source_id is the recipient, role assignee ([D13]), payload {kind,date,timeZone}', () => {
      const rows = planTaskDailyDigestDelivery(base)
      expect(rows).toEqual([
        {
          orgId: 'org-1',
          sourceType: 'task_daily',
          sourceId: 'u1',
          sourceKey: 'task_daily:2026-10-07:recipient:u1:channel:dingtalk_work_notification',
          recipientUserId: 'u1',
          recipientRole: 'assignee',
          channel: 'dingtalk_work_notification',
          payload: { kind: 'task_daily', date: '2026-10-07', timeZone: 'Asia/Shanghai' },
        },
      ])
      expectNoUserText(rows)
      expect(Object.keys(rows[0].payload).sort()).toEqual(['date', 'kind', 'timeZone'])
    })

    it('no channels -> no rows', () => {
      expect(planTaskDailyDigestDelivery({ ...base, channels: [] })).toEqual([])
    })

    it('rejects a malformed date, an invalid zone, an empty id, and a non-object input', () => {
      expect(() => planTaskDailyDigestDelivery({ ...base, date: '2026/10/07' })).toThrow(TypeError)
      expect(() => planTaskDailyDigestDelivery({ ...base, date: 'x' })).toThrow(TypeError)
      expect(() => planTaskDailyDigestDelivery({ ...base, timeZone: 'Not/AZone' })).toThrow(TypeError)
      expect(() => planTaskDailyDigestDelivery({ ...base, userId: '' })).toThrow(TypeError)
      expect(() => planTaskDailyDigestDelivery('x' as never)).toThrow(TypeError)
    })
  })

  describe('planTaskListEventDeliveries (family 4)', () => {
    const base = {
      orgId: 'org-1',
      listId: 'tlst_1',
      eventId: 'tlev_1',
      event: 'archived' as const,
      listCreatorId: 'c1',
      actorId: 'actor',
      channels: [CH],
    }

    it('the list creator at role list_member with an id-only payload', () => {
      const rows = planTaskListEventDeliveries(base)
      expect(rows).toEqual([
        {
          orgId: 'org-1',
          sourceType: 'task_list_event',
          sourceId: 'tlst_1',
          sourceKey: 'task_list_event:tlst_1:tlev_1:recipient:c1:channel:dingtalk_work_notification',
          recipientUserId: 'c1',
          recipientRole: 'list_member',
          channel: 'dingtalk_work_notification',
          payload: { kind: 'task_list_event', event: 'archived', listId: 'tlst_1', eventId: 'tlev_1', actorId: 'actor' },
        },
      ])
      expectNoUserText(rows)
    })

    it('the creator archiving their own list -> no rows; no channels -> no rows', () => {
      expect(planTaskListEventDeliveries({ ...base, listCreatorId: 'actor' })).toEqual([])
      expect(planTaskListEventDeliveries({ ...base, channels: [] })).toEqual([])
    })

    it('rejects any list event other than archived, an empty id, and a non-object input', () => {
      for (const event of ['renamed', 'unarchived', 'member_added', 'x']) {
        expect(() => planTaskListEventDeliveries({ ...base, event: event as never })).toThrow(TypeError)
      }
      expect(() => planTaskListEventDeliveries({ ...base, listId: '' })).toThrow(TypeError)
      expect(() => planTaskListEventDeliveries('x' as never)).toThrow(TypeError)
    })
  })

  describe('parseTaskNotificationPayload (the planners\' inverse)', () => {
    it('round-trips every family\'s payload as a fresh object', () => {
      const payloads = [
        planTaskEventDeliveries({
          orgId: 'o', taskId: 't1', eventId: 'tev_1', event: 'commented', actorId: 'a',
          recipients: [{ userId: 'u1', recipientRole: 'assignee' }], channels: [CH],
        })[0].payload,
        planTaskReminderDeliveries({
          orgId: 'o', taskId: 't1', remindAt: new Date('2026-10-07T01:00:00.000Z'), creatorId: 'c', assignees: [], channels: [CH],
        })[0].payload,
        planTaskDailyDigestDelivery({ orgId: 'o', userId: 'u1', date: '2026-10-07', timeZone: 'UTC', channels: [CH] })[0].payload,
        planTaskListEventDeliveries({
          orgId: 'o', listId: 'l1', eventId: 'tlev_1', event: 'archived', listCreatorId: 'c', actorId: 'a', channels: [CH],
        })[0].payload,
      ]
      for (const payload of payloads) {
        const stored = JSON.parse(JSON.stringify(payload)) as unknown
        const result = parseTaskNotificationPayload(stored)
        expect(result).toEqual({ ok: true, payload })
        expect(result.ok && result.payload).not.toBe(stored)
      }
    })

    it('non-object / null / array / string -> payload_invalid', () => {
      for (const raw of [null, undefined, 'x', 42, [], ['task_event']]) {
        expect(parseTaskNotificationPayload(raw)).toEqual({ ok: false, reason: 'payload_invalid' })
      }
    })

    it('missing or unknown kind -> unknown_kind', () => {
      expect(parseTaskNotificationPayload({})).toEqual({ ok: false, reason: 'unknown_kind' })
      expect(parseTaskNotificationPayload({ kind: 'attachment_added' })).toEqual({ ok: false, reason: 'unknown_kind' })
      expect(parseTaskNotificationPayload({ kind: 7 })).toEqual({ ok: false, reason: 'unknown_kind' })
    })

    it('task_event: extra key, missing key, wrong type, or an event outside the closed set -> payload_invalid', () => {
      const good = { kind: 'task_event', event: 'completed', taskId: 't1', eventId: 'tev_1', actorId: 'a' }
      expect(parseTaskNotificationPayload(good).ok).toBe(true)
      expect(parseTaskNotificationPayload({ ...good, title: 'T' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ ...good, actorId: undefined })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ kind: 'task_event', event: 'completed', taskId: 't1', eventId: 'tev_1' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ ...good, taskId: 1 })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ ...good, taskId: '' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ ...good, event: 'self_completed' })).toEqual({ ok: false, reason: 'payload_invalid' })
    })

    it('task_reminder: remindAt must be the canonical ISO form the planner wrote', () => {
      expect(parseTaskNotificationPayload({ kind: 'task_reminder', taskId: 't1', remindAt: '2026-10-07T01:00:00.000Z' }).ok).toBe(true)
      for (const remindAt of ['2026-10-07T01:00:00Z', '2026-10-07 01:00:00', 'x', '', 1759798800000]) {
        expect(parseTaskNotificationPayload({ kind: 'task_reminder', taskId: 't1', remindAt })).toEqual({ ok: false, reason: 'payload_invalid' })
      }
      expect(parseTaskNotificationPayload({ kind: 'task_reminder', taskId: 't1' })).toEqual({ ok: false, reason: 'payload_invalid' })
    })

    it('task_daily: date must be YYYY-MM-DD and timeZone a valid IANA zone', () => {
      expect(parseTaskNotificationPayload({ kind: 'task_daily', date: '2026-10-07', timeZone: 'Asia/Shanghai' }).ok).toBe(true)
      expect(parseTaskNotificationPayload({ kind: 'task_daily', date: '2026/10/07', timeZone: 'UTC' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ kind: 'task_daily', date: '2026-10-07', timeZone: 'Not/AZone' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ kind: 'task_daily', date: '2026-10-07', timeZone: 'UTC', extra: 1 })).toEqual({ ok: false, reason: 'payload_invalid' })
    })

    it('task_list_event: only archived', () => {
      const good = { kind: 'task_list_event', event: 'archived', listId: 'l1', eventId: 'tlev_1', actorId: 'a' }
      expect(parseTaskNotificationPayload(good).ok).toBe(true)
      expect(parseTaskNotificationPayload({ ...good, event: 'renamed' })).toEqual({ ok: false, reason: 'payload_invalid' })
      expect(parseTaskNotificationPayload({ ...good, listId: '' })).toEqual({ ok: false, reason: 'payload_invalid' })
    })
  })
})
