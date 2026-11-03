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
  applyRenameList,
  applyUnarchive,
  canAddTaskToList,
  canListAction,
  canRemoveListMember,
  canRemoveTaskFromList,
  parseIncludeArchived,
  parseTaskListMemberRole,
  parseTaskListName,
  planAddTaskToList,
  planRemoveTaskFromList,
  toTaskListMemberships,
  validateTaskListName,
  visibleTaskListIds,
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

    it('an unknown role THROWS rather than silently becoming editor (item 2, independent review)', () => {
      expect(() =>
        toTaskListMemberships([{ listId: 'l1', role: 'admin' as never }]),
      ).toThrow(TypeError)
      expect(() =>
        toTaskListMemberships([{ listId: 'l1', role: '' as never }]),
      ).toThrow(TypeError)
      expect(() =>
        toTaskListMemberships([{ listId: 'l1', role: null as never }]),
      ).toThrow(TypeError)
    })

    it('a valid row before the bad one is processed fine — the throw happens exactly at the bad row', () => {
      expect(() =>
        toTaskListMemberships([
          { listId: 'l1', role: 'read' },
          { listId: 'l2', role: 'bogus' as never },
        ]),
      ).toThrow(/l2/)
    })
  })

  describe('parseTaskListMemberRole (route-boundary guard, item 1)', () => {
    it('accepts "read" and "edit"', () => {
      expect(parseTaskListMemberRole('read')).toEqual({ ok: true, role: 'read' })
      expect(parseTaskListMemberRole('edit')).toEqual({ ok: true, role: 'edit' })
    })

    it('rejects "owner" — ownership only ever moves via applyTransferOwner (R12(c))', () => {
      expect(parseTaskListMemberRole('owner')).toEqual({ ok: false, reason: 'invalid_role' })
    })

    it('rejects an unrecognized string', () => {
      expect(parseTaskListMemberRole('admin')).toEqual({ ok: false, reason: 'invalid_role' })
      expect(parseTaskListMemberRole('READ')).toEqual({ ok: false, reason: 'invalid_role' })
    })

    it('rejects a non-string', () => {
      expect(parseTaskListMemberRole(42)).toEqual({ ok: false, reason: 'invalid_role' })
      expect(parseTaskListMemberRole(null)).toEqual({ ok: false, reason: 'invalid_role' })
      expect(parseTaskListMemberRole(undefined)).toEqual({ ok: false, reason: 'invalid_role' })
      expect(parseTaskListMemberRole({})).toEqual({ ok: false, reason: 'invalid_role' })
      expect(parseTaskListMemberRole(['read'])).toEqual({ ok: false, reason: 'invalid_role' })
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

    describe('item 1 (independent review): runtime role closed-set guard', () => {
      it('role "owner" is rejected -> invalid_role (owner only via applyTransferOwner)', () => {
        const result = applyAddMember({
          members: [],
          userId: 'u2',
          role: 'owner' as never,
          actorId: ACTOR,
          isActiveInOrg: true,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('role "admin" (unrecognized string) is rejected -> invalid_role', () => {
        const result = applyAddMember({
          members: [],
          userId: 'u2',
          role: 'admin' as never,
          actorId: ACTOR,
          isActiveInOrg: true,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('role "READ" (wrong case) is rejected -> invalid_role', () => {
        const result = applyAddMember({
          members: [],
          userId: 'u2',
          role: 'READ' as never,
          actorId: ACTOR,
          isActiveInOrg: true,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('a non-string role is rejected -> invalid_role', () => {
        const result = applyAddMember({
          members: [],
          userId: 'u2',
          role: 42 as never,
          actorId: ACTOR,
          isActiveInOrg: true,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('the role guard runs BEFORE the already-a-member noop — a bad role is rejected even for an existing member', () => {
        const result = applyAddMember({
          members: [member('u2', 'read')],
          userId: 'u2',
          role: 'owner' as never,
          actorId: ACTOR,
          isActiveInOrg: true,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })
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

    describe('item 1 (independent review): runtime role closed-set guard', () => {
      it('role "owner" is rejected -> invalid_role', () => {
        const result = applyChangeMemberRole({
          members: [member('u2', 'read')],
          userId: 'u2',
          role: 'owner' as never,
          actorId: ACTOR,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('role "admin" (unrecognized string) is rejected -> invalid_role', () => {
        const result = applyChangeMemberRole({
          members: [member('u2', 'read')],
          userId: 'u2',
          role: 'admin' as never,
          actorId: ACTOR,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('role "READ" (wrong case) is rejected -> invalid_role', () => {
        const result = applyChangeMemberRole({
          members: [member('u2', 'read')],
          userId: 'u2',
          role: 'READ' as never,
          actorId: ACTOR,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('a non-string role is rejected -> invalid_role', () => {
        const result = applyChangeMemberRole({
          members: [member('u2', 'read')],
          userId: 'u2',
          role: null as never,
          actorId: ACTOR,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
      })

      it('the role guard runs BEFORE not_found — a bad role is rejected even for a nonexistent member', () => {
        const result = applyChangeMemberRole({
          members: [],
          userId: 'ghost',
          role: 'owner' as never,
          actorId: ACTOR,
        })
        expect(result).toEqual({ ok: false, reason: 'invalid_role' })
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

describe('task-lists M4 PR-3a additions', () => {
  describe('parseTaskListName', () => {
    it('accepts what validateTaskListName accepts, normalized', () => {
      expect(parseTaskListName('  备料复核  ')).toEqual({ ok: true, name: '备料复核' })
      expect(parseTaskListName('e\u0301')).toEqual({ ok: true, name: '\u00e9' })
      expect(parseTaskListName('\u{1F600}'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS))).toEqual({
        ok: true,
        name: '\u{1F600}'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS),
      })
    })

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['number', 7],
      ['array', ['a']],
      ['empty', ''],
      ['blank', '   '],
    ])('%s -> invalid_name', (_label, raw) => {
      expect(parseTaskListName(raw)).toEqual({ ok: false, reason: 'invalid_name' })
    })

    it('over 100 code points -> name_too_long', () => {
      expect(parseTaskListName('\u{1F600}'.repeat(TASK_LIST_NAME_MAX_CODEPOINTS + 1))).toEqual({ ok: false, reason: 'name_too_long' })
    })

    it.each([
      ['U+0000 inside', 'a\u0000b'],
      ['lone high surrogate', 'a\uD800b'],
      ['lone low surrogate', 'a\uDC00'],
    ])('%s -> invalid_name (not storable as sent)', (_label, raw) => {
      expect(validateTaskListName(raw).ok).toBe(true)
      expect(parseTaskListName(raw)).toEqual({ ok: false, reason: 'invalid_name' })
    })
  })

  describe('applyRenameList', () => {
    it('the same name -> no change, no event', () => {
      expect(applyRenameList({ currentName: '备料', name: '备料', actorId: ACTOR })).toEqual({ changed: false, name: '备料', events: [] })
    })

    it('a different name -> the new name and one renamed event by the actor', () => {
      expect(applyRenameList({ currentName: '备料', name: '复核', actorId: ACTOR })).toEqual({
        changed: true,
        name: '复核',
        events: [{ type: 'renamed', userId: ACTOR }],
      })
    })
  })

  describe('parseIncludeArchived', () => {
    it.each([
      ['absent', false, undefined],
      ["'false'", false, 'false'],
      ["'true'", true, 'true'],
    ])('%s -> includeArchived %s', (_label, expected, raw) => {
      expect(parseIncludeArchived(raw)).toEqual({ ok: true, includeArchived: expected })
    })

    it.each([
      ['empty string', ''],
      ['TRUE', 'TRUE'],
      ['1', '1'],
      ['0', '0'],
      ['yes', 'yes'],
      ['boolean true', true],
      ['repeated key', ['true', 'true']],
      ['nested key', { a: 'true' }],
      ['null', null],
    ])('%s -> invalid_filter', (_label, raw) => {
      expect(parseIncludeArchived(raw)).toEqual({ ok: false, reason: 'invalid_filter' })
    })
  })

  // S6, [own-14]: who may ask for a removal. The transition's own rules are applyRemoveMember's.
  describe('canRemoveListMember', () => {
    it.each([
      ['none', false, false],
      ['none', true, false],
      ['read', false, false],
      ['read', true, true],
      ['edit', false, true],
      ['edit', true, true],
      ['owner', false, true],
      ['owner', true, true],
    ] as const)('role %s, isSelf %s -> %s', (role, isSelf, expected) => {
      expect(canRemoveListMember({ role, isSelf })).toBe(expected)
    })

    it('a non-member is refused even for themselves; a member without manage_members is allowed only for themselves', () => {
      expect(canRemoveListMember({ role: 'none', isSelf: true })).toBe(false)
      for (const role of ['read', 'edit', 'owner'] as const) {
        expect(canRemoveListMember({ role, isSelf: false })).toBe(canListAction({ role }, 'manage_members'))
        expect(canRemoveListMember({ role, isSelf: true })).toBe(true)
      }
    })
  })
})

// S7 (design §3.4, §4.1, §5.5): the two-sided item rules and the detail's list ids.
describe('task-lists M4 PR-3a S7 additions', () => {
  const task = { createdBy: 'creator', assigneeIds: ['assignee'], followerIds: ['follower'] }

  // [own-25] (a1): the list's add_item and edit on the task from a direct role.
  describe('canAddTaskToList', () => {
    it.each([
      ['none', 'creator', false],
      ['read', 'creator', false],
      ['edit', 'creator', true],
      ['owner', 'creator', true],
      ['read', 'assignee', false],
      ['edit', 'assignee', true],
      ['owner', 'assignee', true],
      ['edit', 'follower', false],
      ['owner', 'follower', false],
      ['edit', 'stranger', false],
      ['owner', 'stranger', false],
    ] as const)('list role %s, caller %s -> %s', (listRole, me, expected) => {
      expect(canAddTaskToList({ listRole, task, me })).toBe(expected)
    })

    it('list identity never counts: one input object, and memberships passed alongside are ignored', () => {
      expect(canAddTaskToList.length).toBe(1)
      const withMemberships = { listRole: 'edit', task, me: 'editor', listMemberships: [{ listId: 'l1', role: 'editor' }] }
      expect(canAddTaskToList(withMemberships as never)).toBe(false)
      const onTask = { listRole: 'owner', task: { ...task, listMemberships: [{ listId: 'l1', role: 'editor' }] }, me: 'editor' }
      expect(canAddTaskToList(onTask as never)).toBe(false)
    })
  })

  // [own-25]: a member with remove_item and edit on the task, or (a2) the creator when the item exists.
  describe('canRemoveTaskFromList', () => {
    it.each([
      ['edit', ['list-editor'], false, true, true],
      ['owner', ['list-editor'], false, false, true],
      ['edit', ['assignee'], false, false, true],
      ['edit', ['none'], false, false, false],
      ['edit', ['follower', 'list-reader'], false, true, false],
      ['read', ['list-reader'], false, true, false],
      ['read', ['assignee', 'list-reader'], false, true, false],
      ['none', ['list-editor'], false, true, false],
      ['none', ['creator'], true, true, true],
      ['none', ['creator'], true, false, false],
      ['read', ['creator', 'list-reader'], true, true, true],
      ['read', ['creator', 'list-reader'], true, false, false],
      ['edit', ['creator'], true, false, true],
    ] as const)('list role %s, task roles %j, creator %s, item %s -> %s', (listRole, taskRoles, isTaskCreator, itemExists, expected) => {
      expect(canRemoveTaskFromList({ listRole, taskRoles: [...taskRoles], isTaskCreator, itemExists })).toBe(expected)
    })

    it('the member way follows canListAction(remove_item); the creator way needs the item', () => {
      for (const listRole of ['none', 'read', 'edit', 'owner'] as const) {
        expect(canRemoveTaskFromList({ listRole, taskRoles: ['list-editor'], isTaskCreator: false, itemExists: true }))
          .toBe(listRole !== 'none' && canListAction({ role: listRole }, 'remove_item'))
        expect(canRemoveTaskFromList({ listRole, taskRoles: ['creator'], isTaskCreator: true, itemExists: true })).toBe(true)
      }
    })
  })

  // [own-25] (a2) [own-46]: ids only, byte order, each once.
  describe('visibleTaskListIds', () => {
    const all = ['tlst_b1', 'tlst_A1', 'tlst_c1', 'tlst_A1']
    it('the creator sees every list holding the task, in byte order, each once', () => {
      expect(visibleTaskListIds({ isTaskCreator: true, taskListIds: all, memberListIds: ['tlst_c1'] }))
        .toEqual(['tlst_A1', 'tlst_b1', 'tlst_c1'])
    })

    it('anyone else sees only the lists they are a member of', () => {
      expect(visibleTaskListIds({ isTaskCreator: false, taskListIds: all, memberListIds: ['tlst_c1', 'tlst_A1'] }))
        .toEqual(['tlst_A1', 'tlst_c1'])
      expect(visibleTaskListIds({ isTaskCreator: false, taskListIds: all, memberListIds: [] })).toEqual([])
    })

    it('byte order, not a locale order: upper case before lower case', () => {
      expect(visibleTaskListIds({ isTaskCreator: true, taskListIds: ['tlst_alpha', 'tlst_Beta', 'tlst_Zeta'], memberListIds: [] }))
        .toEqual(['tlst_Beta', 'tlst_Zeta', 'tlst_alpha'])
    })
  })
})
