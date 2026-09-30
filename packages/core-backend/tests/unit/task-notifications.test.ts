import { describe, expect, it } from 'vitest'
import {
  TASK_NOTIFIABLE_EVENTS,
  TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN,
  reminderRecipientRole,
  resolveListArchiveNotificationRecipients,
  resolveNotificationRecipients,
  resolveReminderRecipients,
  type ResolveNotificationRecipientsInput,
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
  describe('TASK_NOTIFIABLE_EVENTS / opt-in flag', () => {
    it('is the D13 closed set (attachment_added deferred to P2)', () => {
      expect(TASK_NOTIFIABLE_EVENTS).toEqual(['completed', 'completed_by_any', 'reopened', 'deleted', 'commented'])
    })

    it('assignee_added is NOT notifiable by default (R05-opt)', () => {
      expect(TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN).toBe(false)
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
