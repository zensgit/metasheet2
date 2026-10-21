import { describe, expect, it } from 'vitest'
import type { TaskRole } from '../../src/tasks/task-access'
import { planDeleteTask, type TaskDeletionNodes } from '../../src/tasks/task-deletion'

function nodes(entries: Array<[string, string | null]>): TaskDeletionNodes {
  return new Map(entries.map(([id, parentId]) => [id, { parentId }]))
}

describe('task-deletion', () => {
  describe('planDeleteTask', () => {
    it('forbidden: a role without the delete ability (e.g. assignee) is rejected', () => {
      const roles: TaskRole[] = ['assignee']
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: nodes([['tsk_1', null]]), roles })
      expect(result).toEqual({ ok: false, reason: 'forbidden' })
    })
    it('forbidden: follower cannot delete', () => {
      const roles: TaskRole[] = ['follower']
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: nodes([['tsk_1', null]]), roles })
      expect(result).toEqual({ ok: false, reason: 'forbidden' })
    })
    it('has_children: creator CAN delete in principle, but the task still has an undeleted child', () => {
      const roles: TaskRole[] = ['creator']
      const treeNodes = nodes([
        ['tsk_1', null],
        ['tsk_2', 'tsk_1'],
      ])
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: treeNodes, roles })
      expect(result).toEqual({ ok: false, reason: 'has_children' })
    })
    it('check order: forbidden wins even when children ALSO exist (ability checked first)', () => {
      const roles: TaskRole[] = ['assignee']
      const treeNodes = nodes([
        ['tsk_1', null],
        ['tsk_2', 'tsk_1'],
      ])
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: treeNodes, roles })
      expect(result).toEqual({ ok: false, reason: 'forbidden' })
    })
    it('ok: creator, no children -> deletable, event deleted', () => {
      const roles: TaskRole[] = ['creator']
      const treeNodes = nodes([
        ['tsk_1', null],
        ['tsk_2', null], // unrelated sibling, not a child
      ])
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: treeNodes, roles })
      expect(result).toEqual({ ok: true, events: [{ type: 'deleted' }] })
    })
    it('a role union that includes creator can delete', () => {
      const roles: TaskRole[] = ['assignee', 'creator']
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: nodes([['tsk_1', null]]), roles })
      expect(result.ok).toBe(true)
    })
    it('no change on rejection paths -> no events key at all (not an empty transition object)', () => {
      const roles: TaskRole[] = ['follower']
      const result = planDeleteTask({ taskId: 'tsk_1', nodes: nodes([['tsk_1', null]]), roles })
      expect(result.ok).toBe(false)
      expect('events' in result).toBe(false)
    })
  })
})

describe('task-c review round 1', () => {
  it('ok even when an UNRELATED task elsewhere has a parent', () => {
    const treeNodes = nodes([
      ['tsk_1', null],
      ['tsk_other_parent', null],
      ['tsk_other_child', 'tsk_other_parent'],
    ])
    const result = planDeleteTask({ taskId: 'tsk_1', nodes: treeNodes, roles: ['creator'] })
    expect(result).toEqual({ ok: true, events: [{ type: 'deleted' }] })
  })
  it('not_found when the task is not in the undeleted map (missing or already deleted)', () => {
    const result = planDeleteTask({ taskId: 'tsk_gone', nodes: nodes([['tsk_1', null]]), roles: ['creator'] })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})
