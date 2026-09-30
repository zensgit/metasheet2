import { describe, expect, it } from 'vitest'
import {
  TASK_LIST_MEMBER_SOFT_LIMIT,
  TASK_LISTS_PER_TASK_SOFT_LIMIT,
  TASK_LIST_NAME_MAX_CODEPOINTS,
  TASK_LIST_ACTIONS,
  applyAddMember,
  applyArchive,
  applyChangeMemberRole,
  applyRemoveMember,
  applyTransferOwner,
  applyUnarchive,
  canListAction,
  planAddTaskToList,
  planRemoveTaskFromList,
  toTaskListMemberships,
  validateTaskListName,
  type TaskListMemberRow,
} from '../../src/tasks/task-lists'

const NOW = new Date('2026-09-30T09:00:00.000Z')
const ACTOR = 'actor'

function member(userId: string, role: TaskListMemberRow['role']): TaskListMemberRow {
  return { userId, role }
}

describe('task-lists', () => {
  describe('toTaskListMemberships', () => {
    it('maps read -> reader, edit -> editor, owner -> editor', () => {
      expect(
        toTaskListMemberships([
          { listId: 'l1', role: 'read' },
          { listId: 'l2', role: 'edit' },
          { listId: 'l3', role: 'owner' },
        ]),
      ).toEqual([
        { listId: 'l1', role: 'reader' },
        { listId: 'l2', role: 'editor' },
        { listId: 'l3', role: 'editor' },
      ])
    })

    it('empty input -> empty output', () => {
      expect(toTaskListMemberships([])).toEqual([])
    })
  })

  describe('canListAction', () => {
    it('every action is false for role "none" and no creator override', () => {
      for (const action of TASK_LIST_ACTIONS) {
        expect(canListAction({ role: 'none' }, action)).toBe(false)
      }
    })

    it('read role: only view is true', () => {
      for (const action of TASK_LIST_ACTIONS) {
        expect(canListAction({ role: 'read' }, action)).toBe(action === 'view')
      }
    })

    it('edit role: everything but transfer_owner', () => {
      for (const action of TASK_LIST_ACTIONS) {
        expect(canListAction({ role: 'edit' }, action)).toBe(action !== 'transfer_owner')
      }
    })

    it('owner role: everything', () => {
      for (const action of TASK_LIST_ACTIONS) {
        expect(canListAction({ role: 'owner' }, action)).toBe(true)
      }
    })

    it('§13-14: creator can archive/unarchive even at role "read" or "none"', () => {
      expect(canListAction({ role: 'read', isCreator: true }, 'archive')).toBe(true)
      expect(canListAction({ role: 'read', isCreator: true }, 'unarchive')).toBe(true)
      expect(canListAction({ role: 'none', isCreator: true }, 'archive')).toBe(true)
    })

    it('creator override is scoped to archive/unarchive only — not e.g. rename', () => {
      expect(canListAction({ role: 'read', isCreator: true }, 'rename')).toBe(false)
      expect(canListAction({ role: 'none', isCreator: true }, 'manage_members')).toBe(false)
    })

    it('isCreator: false behaves exactly like isCreator omitted', () => {
      expect(canListAction({ role: 'read', isCreator: false }, 'archive')).toBe(false)
    })

    it('throws for an action outside the closed set', () => {
      expect(() => canListAction({ role: 'owner' }, 'delete' as never)).toThrow(TypeError)
    })
  })

  describe('validateTaskListName', () => {
    it('accepts a normal name', () => {
      expect(validateTaskListName('备料复核')).toEqual({ ok: true, name: '备料复核' })
    })

    it('rejects blank/whitespace-only -> invalid_name', () => {
      expect(validateTaskListName('')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(validateTaskListName('   ')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(validateTaskListName('​')).toEqual({ ok: false, reason: 'invalid_name' })
    })

    it('boundary: exactly 100 code points is accepted', () => {
      const name = 'a'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS)
      const result = validateTaskListName(name)
      expect(result.ok).toBe(true)
    })

    it('boundary: 101 code points is rejected -> name_too_long', () => {
      const name = 'a'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS + 1)
      expect(validateTaskListName(name)).toEqual({ ok: false, reason: 'name_too_long' })
    })

    it('counts by Unicode code point, not UTF-16 unit (astral-plane emoji)', () => {
      // U+1F600 is 1 code point / 2 UTF-16 units — 100 of them must be accepted, not rejected as 200.
      const name = '😀'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS)
      expect(validateTaskListName(name).ok).toBe(true)
      const tooLong = '😀'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS + 1)
      expect(validateTaskListName(tooLong)).toEqual({ ok: false, reason: 'name_too_long' })
    })

    it('rejects a non-string', () => {
      expect(validateTaskListName(42)).toEqual({ ok: false, reason: 'invalid_name' })
      expect(validateTaskListName(null)).toEqual({ ok: false, reason: 'invalid_name' })
    })
  })

  describe('applyAddMember', () => {
    it('adds a new member with the given assignable role', () => {
      const result = applyAddMember({
        members: [member('creator', 'owner')],
        userId: 'u2',
        role: 'read',
        actorId: ACTOR,
        isActiveInOrg: true,
      })
      expect(result).toEqual({
        ok: true,
        members: [member('creator', 'owner'), member('u2', 'read')],
        events: [{ type: 'member_added', userId: ACTOR, targetUserId: 'u2' }],
      })
    })

    it('already a member -> noop, no event, role unchanged even if a different role was requested', () => {
      const result = applyAddMember({
        members: [member('u2', 'read')],
        userId: 'u2',
        role: 'edit',
        actorId: ACTOR,
        isActiveInOrg: true,
      })
      expect(result).toEqual({ ok: true, members: [member('u2', 'read')], events: [] })
    })

    it('R17: not active in org -> 422 inactive_org_member, no mutation', () => {
      const result = applyAddMember({
        members: [],
        userId: 'u2',
        role: 'read',
        actorId: ACTOR,
        isActiveInOrg: false,
      })
      expect(result).toEqual({ ok: false, reason: 'inactive_org_member' })
    })

    it('already-a-member noop takes priority over the inactive-org check', () => {
      const result = applyAddMember({
        members: [member('u2', 'read')],
        userId: 'u2',
        role: 'read',
        actorId: ACTOR,
        isActiveInOrg: false,
      })
      expect(result).toEqual({ ok: true, members: [member('u2', 'read')], events: [] })
    })

    it('D14 boundary: at the soft limit -> 422 limit', () => {
      const members = Array.from({ length: TASK_LIST_MEMBER_SOFT_LIMIT }, (_, i) => member(`u${i}`, 'read'))
      const result = applyAddMember({ members, userId: 'new', role: 'read', actorId: ACTOR, isActiveInOrg: true })
      expect(result).toEqual({ ok: false, reason: 'limit' })
    })

    it('D14 boundary: one below the soft limit -> succeeds', () => {
      const members = Array.from({ length: TASK_LIST_MEMBER_SOFT_LIMIT - 1 }, (_, i) => member(`u${i}`, 'read'))
      const result = applyAddMember({ members, userId: 'new', role: 'read', actorId: ACTOR, isActiveInOrg: true })
      expect(result.ok).toBe(true)
    })
  })

  describe('applyRemoveMember', () => {
    it('not a member -> noop, no event', () => {
      const result = applyRemoveMember({ members: [], userId: 'ghost', actorId: ACTOR, createdBy: 'creator' })
      expect(result).toEqual({ ok: true, members: [], events: [] })
    })

    it('removes an ordinary member', () => {
      const result = applyRemoveMember({
        members: [member('creator', 'owner'), member('u2', 'edit')],
        userId: 'u2',
        actorId: ACTOR,
        createdBy: 'creator',
      })
      expect(result).toEqual({
        ok: true,
        members: [member('creator', 'owner')],
        events: [{ type: 'member_removed', userId: ACTOR, targetUserId: 'u2' }],
      })
    })

    it('R12(b): created_by can never be removed, even at role read', () => {
      const result = applyRemoveMember({
        members: [member('creator', 'read')],
        userId: 'creator',
        actorId: ACTOR,
        createdBy: 'creator',
      })
      expect(result).toEqual({ ok: false, reason: 'created_by_immutable' })
    })

    it('R12(c): the current owner cannot be removed directly — must transfer first', () => {
      const result = applyRemoveMember({
        members: [member('someone-else', 'owner')],
        userId: 'someone-else',
        actorId: ACTOR,
        createdBy: 'creator',
      })
      expect(result).toEqual({ ok: false, reason: 'owner_must_transfer' })
    })

    it('created_by_immutable takes priority over owner_must_transfer for the same row', () => {
      const result = applyRemoveMember({
        members: [member('creator', 'owner')],
        userId: 'creator',
        actorId: ACTOR,
        createdBy: 'creator',
      })
      expect(result).toEqual({ ok: false, reason: 'created_by_immutable' })
    })
  })

  describe('applyChangeMemberRole', () => {
    it('not a member -> not_found', () => {
      expect(applyChangeMemberRole({ members: [], userId: 'ghost', role: 'edit', actorId: ACTOR })).toEqual({
        ok: false,
        reason: 'not_found',
      })
    })

    it('current role is owner -> owner_must_transfer', () => {
      const result = applyChangeMemberRole({
        members: [member('u2', 'owner')],
        userId: 'u2',
        role: 'edit',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'owner_must_transfer' })
    })

    it('same role requested -> noop, no event', () => {
      const result = applyChangeMemberRole({
        members: [member('u2', 'read')],
        userId: 'u2',
        role: 'read',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: true, members: [member('u2', 'read')], events: [] })
    })

    it('changes read -> edit', () => {
      const result = applyChangeMemberRole({
        members: [member('u2', 'read')],
        userId: 'u2',
        role: 'edit',
        actorId: ACTOR,
      })
      expect(result).toEqual({
        ok: true,
        members: [member('u2', 'edit')],
        events: [{ type: 'member_role_changed', userId: ACTOR, targetUserId: 'u2' }],
      })
    })
  })

  describe('applyTransferOwner', () => {
    it('from is not the current owner -> not_owner', () => {
      const result = applyTransferOwner({
        members: [member('u1', 'edit'), member('u2', 'read')],
        fromUserId: 'u1',
        toUserId: 'u2',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'not_owner' })
    })

    it('target is not a member -> target_not_member', () => {
      const result = applyTransferOwner({
        members: [member('u1', 'owner')],
        fromUserId: 'u1',
        toUserId: 'ghost',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'target_not_member' })
    })

    it('from === to -> noop, no event', () => {
      const result = applyTransferOwner({
        members: [member('u1', 'owner')],
        fromUserId: 'u1',
        toUserId: 'u1',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: true, members: [member('u1', 'owner')], events: [] })
    })

    it('R12(d): transfers ownership, original owner demoted to edit (never read)', () => {
      const result = applyTransferOwner({
        members: [member('u1', 'owner'), member('u2', 'read')],
        fromUserId: 'u1',
        toUserId: 'u2',
        actorId: ACTOR,
      })
      expect(result).toEqual({
        ok: true,
        members: [member('u1', 'edit'), member('u2', 'owner')],
        events: [{ type: 'owner_transferred', userId: ACTOR, targetUserId: 'u2' }],
      })
    })

    it('not_owner is checked before target_not_member', () => {
      const result = applyTransferOwner({
        members: [member('u1', 'edit')],
        fromUserId: 'u1',
        toUserId: 'ghost',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'not_owner' })
    })
  })

  describe('applyArchive / applyUnarchive', () => {
    it('archives an active list', () => {
      const result = applyArchive({ archivedAt: null, now: NOW, actorId: ACTOR })
      expect(result).toEqual({ archivedAt: NOW, events: [{ type: 'archived', userId: ACTOR }] })
    })

    it('already archived -> noop, preserves original archivedAt', () => {
      const originally = new Date('2026-01-01T00:00:00.000Z')
      const result = applyArchive({ archivedAt: originally, now: NOW, actorId: ACTOR })
      expect(result).toEqual({ archivedAt: originally, events: [] })
    })

    it('unarchives an archived list', () => {
      const result = applyUnarchive({ archivedAt: NOW, actorId: ACTOR })
      expect(result).toEqual({ archivedAt: null, events: [{ type: 'unarchived', userId: ACTOR }] })
    })

    it('not archived -> noop', () => {
      const result = applyUnarchive({ archivedAt: null, actorId: ACTOR })
      expect(result).toEqual({ archivedAt: null, events: [] })
    })
  })

  describe('planAddTaskToList / planRemoveTaskFromList — D2 two-event plan', () => {
    it('adding a task to a new list emits BOTH task_events.list_added and task_list_events.item_added', () => {
      const result = planAddTaskToList({ currentListIds: [], listId: 'l1', actorId: ACTOR })
      expect(result).toEqual({
        ok: true,
        changed: true,
        taskEvents: [{ type: 'list_added', userId: ACTOR }],
        listEvents: [{ type: 'item_added', userId: ACTOR }],
      })
    })

    it('already in the list -> noop, no events', () => {
      const result = planAddTaskToList({ currentListIds: ['l1'], listId: 'l1', actorId: ACTOR })
      expect(result).toEqual({ ok: true, changed: false, taskEvents: [], listEvents: [] })
    })

    it('D14 boundary: at the per-task list soft limit -> 422 limit', () => {
      const currentListIds = Array.from({ length: TASK_LISTS_PER_TASK_SOFT_LIMIT }, (_, i) => `l${i}`)
      const result = planAddTaskToList({ currentListIds, listId: 'new', actorId: ACTOR })
      expect(result).toEqual({ ok: false, reason: 'limit' })
    })

    it('D14 boundary: one below the per-task list soft limit -> succeeds', () => {
      const currentListIds = Array.from({ length: TASK_LISTS_PER_TASK_SOFT_LIMIT - 1 }, (_, i) => `l${i}`)
      const result = planAddTaskToList({ currentListIds, listId: 'new', actorId: ACTOR })
      expect(result.ok).toBe(true)
    })

    it('removing a task from a list emits BOTH task_events.list_removed and task_list_events.item_removed', () => {
      const result = planRemoveTaskFromList({ currentListIds: ['l1', 'l2'], listId: 'l1', actorId: ACTOR })
      expect(result).toEqual({
        changed: true,
        taskEvents: [{ type: 'list_removed', userId: ACTOR }],
        listEvents: [{ type: 'item_removed', userId: ACTOR }],
      })
    })

    it('not in the list -> noop, no events', () => {
      const result = planRemoveTaskFromList({ currentListIds: ['l2'], listId: 'l1', actorId: ACTOR })
      expect(result).toEqual({ changed: false, taskEvents: [], listEvents: [] })
    })
  })
})
