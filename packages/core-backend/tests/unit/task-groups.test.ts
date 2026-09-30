import { describe, expect, it } from 'vitest'
import {
  TASK_GROUPS_PER_SCOPE_SOFT_LIMIT,
  TASK_GROUP_NAME_MAX_CODEPOINTS,
  applyCreateGroup,
  applyDeleteGroup,
  applyMoveItem,
  applyRenameGroup,
  validateTaskGroupName,
  type TaskGroupRow,
} from '../../src/tasks/task-groups'

const ACTOR = 'actor'

function group(id: string, isDefault: boolean, position = 0): TaskGroupRow {
  return { id, scope: 'list', isDefault, position }
}

describe('task-groups', () => {
  describe('validateTaskGroupName', () => {
    it('accepts a normal name', () => {
      expect(validateTaskGroupName('本周重点')).toEqual({ ok: true, name: '本周重点' })
    })

    it('rejects blank -> invalid_name', () => {
      expect(validateTaskGroupName('   ')).toEqual({ ok: false, reason: 'invalid_name' })
    })

    it('boundary: exactly 100 code points ok, 101 rejected', () => {
      expect(validateTaskGroupName('a'.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS)).ok).toBe(true)
      expect(validateTaskGroupName('a'.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS + 1))).toEqual({
        ok: false,
        reason: 'name_too_long',
      })
    })
  })

  describe('applyCreateGroup', () => {
    it('creates a LIST-scope group and emits group_created', () => {
      const result = applyCreateGroup({ id: 'tgrp_1', scope: 'list', name: 'Backlog', existingCount: 2, actorId: ACTOR })
      expect(result).toEqual({
        ok: true,
        group: { id: 'tgrp_1', scope: 'list', name: 'Backlog', position: 2, isDefault: false },
        events: [{ type: 'group_created', userId: ACTOR }],
      })
    })

    it('D2: a USER-scope (personal) group emits NO task_list_events', () => {
      const result = applyCreateGroup({ id: 'tgrp_1', scope: 'user', name: 'My focus', existingCount: 0, actorId: ACTOR })
      expect(result.ok).toBe(true)
      expect(result.ok && result.events).toEqual([])
    })

    it('new groups are never the default group', () => {
      const result = applyCreateGroup({ id: 'tgrp_1', scope: 'list', name: 'X', existingCount: 0, actorId: ACTOR })
      expect(result.ok && result.group.isDefault).toBe(false)
    })

    it('D14 boundary: at the per-scope soft limit -> 422 limit', () => {
      const result = applyCreateGroup({
        id: 'tgrp_new',
        scope: 'list',
        name: 'X',
        existingCount: TASK_GROUPS_PER_SCOPE_SOFT_LIMIT,
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'limit' })
    })

    it('D14 boundary: one below the soft limit -> succeeds', () => {
      const result = applyCreateGroup({
        id: 'tgrp_new',
        scope: 'list',
        name: 'X',
        existingCount: TASK_GROUPS_PER_SCOPE_SOFT_LIMIT - 1,
        actorId: ACTOR,
      })
      expect(result.ok).toBe(true)
    })

    it('item 9 (independent review): an unrecognized scope THROWS TypeError', () => {
      expect(() =>
        applyCreateGroup({ id: 'tgrp_1', scope: 'team' as never, name: 'X', existingCount: 0, actorId: ACTOR }),
      ).toThrow(TypeError)
    })
  })

  describe('applyRenameGroup', () => {
    it('renames and emits group_renamed for a list-scope group', () => {
      const result = applyRenameGroup({ scope: 'list', name: 'New', previousName: 'Old', actorId: ACTOR })
      expect(result).toEqual({ name: 'New', events: [{ type: 'group_renamed', userId: ACTOR }] })
    })

    it('same name -> noop, no event', () => {
      const result = applyRenameGroup({ scope: 'list', name: 'Same', previousName: 'Same', actorId: ACTOR })
      expect(result).toEqual({ name: 'Same', events: [] })
    })

    it('D2: user-scope rename emits no event', () => {
      const result = applyRenameGroup({ scope: 'user', name: 'New', previousName: 'Old', actorId: ACTOR })
      expect(result).toEqual({ name: 'New', events: [] })
    })

    it('item 9 (independent review): an unrecognized scope THROWS TypeError', () => {
      expect(() =>
        applyRenameGroup({ scope: 'team' as never, name: 'New', previousName: 'Old', actorId: ACTOR }),
      ).toThrow(TypeError)
    })
  })

  describe('applyDeleteGroup', () => {
    it('group not found -> not_found', () => {
      const result = applyDeleteGroup({ group: undefined, defaultGroupId: 'def', scope: 'list', actorId: ACTOR })
      expect(result).toEqual({ ok: false, reason: 'not_found' })
    })

    it('cannot delete the default group -> is_default', () => {
      const result = applyDeleteGroup({
        group: group('def', true),
        defaultGroupId: 'def',
        scope: 'list',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: false, reason: 'is_default' })
    })

    it('deletes a non-default group, items reassigned to the default group, emits group_deleted', () => {
      const result = applyDeleteGroup({
        group: group('g2', false),
        defaultGroupId: 'def',
        scope: 'list',
        actorId: ACTOR,
      })
      expect(result).toEqual({
        ok: true,
        reassignToGroupId: 'def',
        events: [{ type: 'group_deleted', userId: ACTOR }],
      })
    })

    it('D2: user-scope delete emits no event', () => {
      const result = applyDeleteGroup({
        group: { id: 'g2', scope: 'user', isDefault: false, position: 0 },
        defaultGroupId: 'def',
        scope: 'user',
        actorId: ACTOR,
      })
      expect(result).toEqual({ ok: true, reassignToGroupId: 'def', events: [] })
    })

    it('item 9 (independent review): an unrecognized scope THROWS TypeError', () => {
      expect(() =>
        applyDeleteGroup({ group: group('g2', false), defaultGroupId: 'def', scope: 'team' as never, actorId: ACTOR }),
      ).toThrow(TypeError)
    })
  })

  describe('applyMoveItem', () => {
    it('same group, identical order -> noop (no positions, no events)', () => {
      const result = applyMoveItem({
        scope: 'list',
        fromGroupId: 'g1',
        toGroupId: 'g1',
        previousOrderedItemIds: ['a', 'b', 'c'],
        nextOrderedItemIds: ['a', 'b', 'c'],
        actorId: ACTOR,
      })
      expect(result).toEqual({ changed: false, positions: [], taskEvents: [] })
    })

    it('same group, reordered -> recomputes integer positions, no group_changed event', () => {
      const result = applyMoveItem({
        scope: 'list',
        fromGroupId: 'g1',
        toGroupId: 'g1',
        previousOrderedItemIds: ['a', 'b', 'c'],
        nextOrderedItemIds: ['b', 'a', 'c'],
        actorId: ACTOR,
      })
      expect(result).toEqual({
        changed: true,
        positions: [
          { itemId: 'b', groupId: 'g1', position: 0 },
          { itemId: 'a', groupId: 'g1', position: 1 },
          { itemId: 'c', groupId: 'g1', position: 2 },
        ],
        taskEvents: [],
      })
    })

    it('cross-group move in a LIST-scope: emits task_events.group_changed', () => {
      const result = applyMoveItem({
        scope: 'list',
        fromGroupId: 'g1',
        toGroupId: 'g2',
        previousOrderedItemIds: ['a'],
        nextOrderedItemIds: ['x', 'a'],
        actorId: ACTOR,
      })
      expect(result.changed).toBe(true)
      expect(result.taskEvents).toEqual([{ type: 'group_changed', userId: ACTOR }])
      expect(result.positions).toEqual([
        { itemId: 'x', groupId: 'g2', position: 0 },
        { itemId: 'a', groupId: 'g2', position: 1 },
      ])
    })

    it('D2: cross-group move in a USER-scope (personal) never emits task_events', () => {
      const result = applyMoveItem({
        scope: 'user',
        fromGroupId: 'g1',
        toGroupId: 'g2',
        previousOrderedItemIds: ['a'],
        nextOrderedItemIds: ['a'],
        actorId: ACTOR,
      })
      expect(result.changed).toBe(true)
      expect(result.taskEvents).toEqual([])
    })

    it('cross-group move with an unchanged next-order array still counts as changed (group differs)', () => {
      const result = applyMoveItem({
        scope: 'list',
        fromGroupId: 'g1',
        toGroupId: 'g2',
        previousOrderedItemIds: ['a', 'b'],
        nextOrderedItemIds: ['a', 'b'],
        actorId: ACTOR,
      })
      expect(result.changed).toBe(true)
      expect(result.taskEvents).toEqual([{ type: 'group_changed', userId: ACTOR }])
    })

    it('item 9 (independent review): an unrecognized scope THROWS TypeError', () => {
      expect(() =>
        applyMoveItem({
          scope: 'team' as never,
          fromGroupId: 'g1',
          toGroupId: 'g1',
          previousOrderedItemIds: ['a'],
          nextOrderedItemIds: ['a'],
          actorId: ACTOR,
        }),
      ).toThrow(TypeError)
    })

    // item 12 (independent review): arraysEqual's length check, isolated. If `previous` were the
    // LONGER array, `.every()` alone would already fail on the extra trailing element(s) even
    // without an explicit length check — so that direction can't tell the length check apart from
    // `.every()`. The direction that DOES depend on the length check is the opposite one: `next` is
    // LONGER than `previous`, and `previous` is an exact PREFIX of `next` — `.every()` iterating
    // over `previous`'s (shorter) indices alone would find every one of them equal and wrongly
    // report "no change" without the length check catching the leftover length mismatch first.
    it('same group, SAME-LENGTH-PREFIX but different length (next is previous + one more item) -> changed: true', () => {
      const result = applyMoveItem({
        scope: 'list',
        fromGroupId: 'g1',
        toGroupId: 'g1',
        previousOrderedItemIds: ['a', 'b'],
        nextOrderedItemIds: ['a', 'b', 'c'],
        actorId: ACTOR,
      })
      expect(result.changed).toBe(true)
      expect(result.positions).toEqual([
        { itemId: 'a', groupId: 'g1', position: 0 },
        { itemId: 'b', groupId: 'g1', position: 1 },
        { itemId: 'c', groupId: 'g1', position: 2 },
      ])
      expect(result.taskEvents).toEqual([]) // same group -> no group_changed regardless
    })
  })
})
