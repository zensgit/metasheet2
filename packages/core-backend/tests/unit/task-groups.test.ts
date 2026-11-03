import { describe, expect, it } from 'vitest'
import {
  TASK_DEFAULT_GROUP_NAME,
  TASK_GROUPS_PER_SCOPE_SOFT_LIMIT,
  TASK_GROUP_NAME_MAX_CODEPOINTS,
  applyCreateGroup,
  applyDeleteGroup,
  applyMoveItem,
  applyRenameGroup,
  parseTargetGroupId,
  parseTaskGroupName,
  planGroupItemOrder,
  planGroupPositionsAfterDelete,
  syntheticUserDefaultGroup,
  userGroupsWithDefault,
  validateTaskGroupName,
  type TaskGroupRow,
  type TaskGroupView,
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

    it('boundary counts code points, not UTF-16 units (astral plane)', () => {
      const emoji = '\u{1F600}'
      expect(validateTaskGroupName(emoji.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS)).ok).toBe(true)
      expect(validateTaskGroupName(emoji.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS + 1))).toEqual({
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
    it('a group row whose scope disagrees with the scope argument THROWS TypeError', () => {
      expect(() =>
        applyDeleteGroup({ group: group('g2', false), defaultGroupId: 'def', scope: 'user', actorId: ACTOR }),
      ).toThrow(TypeError)
    })

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

  // ── M4 PR-3a S8 (design task-m4-pr3a-backend-design-20260930.md §3.5, §4.1) ──────────────────

  describe('parseTaskGroupName', () => {
    it('takes the validateTaskGroupName rules', () => {
      expect(parseTaskGroupName('  本周重点 ')).toEqual({ ok: true, name: '本周重点' })
      expect(parseTaskGroupName('   ')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName(7)).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName(undefined)).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName('a'.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS + 1))).toEqual({ ok: false, reason: 'name_too_long' })
      expect(parseTaskGroupName('a'.repeat(TASK_GROUP_NAME_MAX_CODEPOINTS)).ok).toBe(true)
    })

    it('a name Postgres cannot store as sent (U+0000, a lone surrogate) is invalid_name', () => {
      expect(parseTaskGroupName('分\u0000组')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName('分\uD800组')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName('分\uDC00组')).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseTaskGroupName('分\u{1F600}组')).toEqual({ ok: true, name: '分\u{1F600}组' })
    })
  })

  describe('the personal default group before its row exists', () => {
    it('syntheticUserDefaultGroup is the default group with a null id at position 0', () => {
      expect(syntheticUserDefaultGroup()).toEqual({ id: null, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true })
      // A fresh object every call: a caller changing one cannot change the next.
      expect(syntheticUserDefaultGroup()).not.toBe(syntheticUserDefaultGroup())
    })

    it('userGroupsWithDefault: no rows ⇒ exactly the synthetic group; a default row ⇒ the rows unchanged', () => {
      expect(userGroupsWithDefault([])).toEqual([syntheticUserDefaultGroup()])
      const rows: TaskGroupView[] = [
        { id: 'tgrp_d', scope: 'user', name: '默认分组', position: 0, isDefault: true },
        { id: 'tgrp_a', scope: 'user', name: 'A', position: 1, isDefault: false },
      ]
      expect(userGroupsWithDefault(rows)).toEqual(rows)
    })

    it('userGroupsWithDefault: rows without a default row get the synthetic group first', () => {
      const rows: TaskGroupView[] = [{ id: 'tgrp_a', scope: 'user', name: 'A', position: 1, isDefault: false }]
      expect(userGroupsWithDefault(rows)).toEqual([syntheticUserDefaultGroup(), rows[0]])
    })

    it('userGroupsWithDefault: only a true isDefault counts', () => {
      const rows = [{ id: 'tgrp_a', scope: 'user', name: 'A', position: 0, isDefault: 'true' }] as unknown as TaskGroupView[]
      expect(userGroupsWithDefault(rows)[0]).toEqual(syntheticUserDefaultGroup())
    })
  })

  describe('parseTargetGroupId', () => {
    it('null is the default group; an id string is passed on', () => {
      expect(parseTargetGroupId({ groupId: null, position: 0 })).toEqual({ ok: true, groupId: null })
      expect(parseTargetGroupId({ groupId: 'tgrp_1' })).toEqual({ ok: true, groupId: 'tgrp_1' })
      expect(parseTargetGroupId({ groupId: 'anything!~' })).toEqual({ ok: true, groupId: 'anything!~' })
    })

    it('a missing key, a non-string, a string that cannot be an id and a body that is not an object are invalid_group', () => {
      const bodies: unknown[] = [
        {}, { position: 0 }, { groupId: undefined }, { groupId: '' }, { groupId: 7 }, { groupId: false }, { groupId: [] },
        { groupId: {} }, { groupId: ['tgrp_1'] }, { groupId: 'tgrp 1' }, { groupId: 'tgrp_\u0000' }, { groupId: '分组' },
        null, undefined, 'tgrp_1', 7, [{ groupId: 'tgrp_1' }],
      ]
      for (const body of bodies) expect(parseTargetGroupId(body), JSON.stringify(body)).toEqual({ ok: false, reason: 'invalid_group' })
    })

    it('an inherited groupId is not the body\'s key', () => {
      const body = Object.create({ groupId: 'tgrp_1' }) as Record<string, unknown>
      expect(parseTargetGroupId(body)).toEqual({ ok: false, reason: 'invalid_group' })
    })
  })

  describe('planGroupItemOrder', () => {
    it('inserts into the visible order without the moved task; hidden rows follow in their order', () => {
      expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H'], taskId: 'X', position: 2 })).toEqual({
        ok: true, before: ['A', 'B', 'H'], after: ['A', 'B', 'X', 'H'],
      })
      expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H'], taskId: 'X', position: 1 })).toEqual({
        ok: true, before: ['A', 'B', 'H'], after: ['A', 'X', 'B', 'H'],
      })
      expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H1', 'H2'], taskId: 'X', position: 0 })).toEqual({
        ok: true, before: ['A', 'B', 'H1', 'H2'], after: ['X', 'A', 'B', 'H1', 'H2'],
      })
    })

    it('a task already in the group is taken out first: the index space has one entry fewer', () => {
      expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'X', 'B'], hiddenOrderedIds: [], taskId: 'X', position: 2 })).toEqual({
        ok: true, before: ['A', 'X', 'B'], after: ['A', 'B', 'X'],
      })
      expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'X', 'B'], hiddenOrderedIds: [], taskId: 'X', position: 3 })).toEqual({
        ok: false, reason: 'invalid_position',
      })
    })

    it('the same visible order gives equal before and after (the no-op), even when hidden rows sat between visible ones', () => {
      const plan = planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H'], taskId: 'A', position: 0 })
      expect(plan).toEqual({ ok: true, before: ['A', 'B', 'H'], after: ['A', 'B', 'H'] })
    })

    it('an empty group takes exactly position 0', () => {
      expect(planGroupItemOrder({ visibleOrderedIds: [], hiddenOrderedIds: [], taskId: 'X', position: 0 })).toEqual({
        ok: true, before: [], after: ['X'],
      })
      expect(planGroupItemOrder({ visibleOrderedIds: [], hiddenOrderedIds: [], taskId: 'X', position: 1 })).toEqual({
        ok: false, reason: 'invalid_position',
      })
    })

    it('hidden rows do not count toward the index space', () => {
      expect(planGroupItemOrder({ visibleOrderedIds: ['A'], hiddenOrderedIds: ['H1', 'H2'], taskId: 'X', position: 2 })).toEqual({
        ok: false, reason: 'invalid_position',
      })
    })

    it('a position that is not a non-negative safe integer JSON number is invalid_position', () => {
      const bad: unknown[] = [-1, 1.5, '1', '0', null, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, true, [0], {}]
      for (const position of bad) {
        expect(planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: [], taskId: 'X', position }), String(position))
          .toEqual({ ok: false, reason: 'invalid_position' })
      }
      // -0 is the integer 0.
      expect(planGroupItemOrder({ visibleOrderedIds: ['A'], hiddenOrderedIds: [], taskId: 'X', position: -0 })).toEqual({
        ok: true, before: ['A'], after: ['X', 'A'],
      })
    })

    it('the moved task among the hidden rows is a caller error', () => {
      expect(() => planGroupItemOrder({ visibleOrderedIds: ['A'], hiddenOrderedIds: ['X'], taskId: 'X', position: 0 })).toThrow(TypeError)
    })

    it('feeds applyMoveItem: an unchanged visible order is its no-op, a changed one rewrites the whole group', () => {
      const same = planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H'], taskId: 'B', position: 1 })
      if (!same.ok) throw new Error('expected a plan')
      expect(applyMoveItem({ scope: 'list', fromGroupId: 'g', toGroupId: 'g', previousOrderedItemIds: same.before, nextOrderedItemIds: same.after, actorId: ACTOR }))
        .toEqual({ changed: false, positions: [], taskEvents: [] })
      const moved = planGroupItemOrder({ visibleOrderedIds: ['A', 'B'], hiddenOrderedIds: ['H'], taskId: 'B', position: 0 })
      if (!moved.ok) throw new Error('expected a plan')
      expect(applyMoveItem({ scope: 'list', fromGroupId: 'g', toGroupId: 'g', previousOrderedItemIds: moved.before, nextOrderedItemIds: moved.after, actorId: ACTOR }))
        .toEqual({
          changed: true,
          positions: [
            { itemId: 'B', groupId: 'g', position: 0 },
            { itemId: 'A', groupId: 'g', position: 1 },
            { itemId: 'H', groupId: 'g', position: 2 },
          ],
          taskEvents: [],
        })
    })
  })

  describe('planGroupPositionsAfterDelete', () => {
    it('renumbers the remaining groups from 0 and returns only the ones that move', () => {
      const groups = [
        { id: 'def', position: 0 },
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 3 },
      ]
      expect(planGroupPositionsAfterDelete({ groups, deletedGroupId: 'a' })).toEqual([
        { id: 'b', position: 1 },
        { id: 'c', position: 2 },
      ])
      expect(planGroupPositionsAfterDelete({ groups, deletedGroupId: 'c' })).toEqual([])
      expect(planGroupPositionsAfterDelete({ groups, deletedGroupId: 'missing' })).toEqual([])
    })

    it('orders by position, then id in byte order; input order does not matter', () => {
      const groups = [
        { id: 'tgrp_c', position: 2 },
        { id: 'tgrp_a', position: 2 },
        { id: 'tgrp_B', position: 2 },
        { id: 'def', position: 0 },
        { id: 'gone', position: 1 },
      ]
      // Byte order puts 'tgrp_B' before 'tgrp_a'; a locale compare would not.
      expect(planGroupPositionsAfterDelete({ groups, deletedGroupId: 'gone' })).toEqual([
        { id: 'tgrp_B', position: 1 },
        { id: 'tgrp_c', position: 3 },
      ])
    })

    it('does not change its input', () => {
      const groups = [{ id: 'b', position: 2 }, { id: 'a', position: 1 }]
      const copy = JSON.parse(JSON.stringify(groups))
      planGroupPositionsAfterDelete({ groups, deletedGroupId: 'a' })
      expect(groups).toEqual(copy)
    })
  })
})
