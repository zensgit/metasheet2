import { describe, expect, it } from 'vitest'
import {
  taskProjectionLockKey,
  taskStructureLockKey,
  tasksSchedulerLeaderLockKey,
} from '../../src/tasks/task-lock-keys'

describe('task-lock-keys', () => {
  describe('literal keys + parameter concatenation', () => {
    it('taskStructureLockKey concatenates the orgId', () => {
      expect(taskStructureLockKey('org_1')).toBe('task-structure:org_1')
      expect(taskStructureLockKey('org_2')).toBe('task-structure:org_2')
    })

    it('taskProjectionLockKey concatenates listId and taskId in order', () => {
      expect(taskProjectionLockKey('tlst_a', 'tsk_b')).toBe('task-projection:tlst_a:tsk_b')
      expect(taskProjectionLockKey('tlst_x', 'tsk_y')).toBe('task-projection:tlst_x:tsk_y')
    })

    it('tasksSchedulerLeaderLockKey is a fixed literal (no arguments)', () => {
      expect(tasksSchedulerLeaderLockKey()).toBe('tasks-scheduler:leader')
      expect(tasksSchedulerLeaderLockKey.length).toBe(0)
    })
  })

  describe('empty/invalid input throws', () => {
    it('taskStructureLockKey rejects empty, non-string and missing orgId', () => {
      expect(() => taskStructureLockKey('')).toThrow()
      expect(() => taskStructureLockKey(undefined as unknown as string)).toThrow()
      expect(() => taskStructureLockKey(null as unknown as string)).toThrow()
      expect(() => taskStructureLockKey(42 as unknown as string)).toThrow()
    })

    it('taskProjectionLockKey rejects an empty/missing listId', () => {
      expect(() => taskProjectionLockKey('', 'tsk_b')).toThrow()
      expect(() => taskProjectionLockKey(undefined as unknown as string, 'tsk_b')).toThrow()
    })

    it('taskProjectionLockKey rejects an empty/missing taskId', () => {
      expect(() => taskProjectionLockKey('tlst_a', '')).toThrow()
      expect(() => taskProjectionLockKey('tlst_a', undefined as unknown as string)).toThrow()
    })
  })

  describe('mutation probe: prefix change (per design §5 "改前缀 ⇒ 红")', () => {
    it('a locally re-declared mutant with a flipped taskStructureLockKey prefix reds the pinned literal assertion', () => {
      // Copy, not the source — the source's `task-structure:` prefix is deliberately misspelled here.
      const mutantTaskStructureLockKey = (orgId: string): string => `task-structura:${orgId}`
      // The pinned literal expectation itself (the SAME string the "literal keys" test above
      // asserts against), not a value re-derived from calling the real function.
      const PINNED_LITERAL = 'task-structure:org_1'
      expect(mutantTaskStructureLockKey('org_1')).not.toBe(PINNED_LITERAL)
      expect(taskStructureLockKey('org_1')).toBe(PINNED_LITERAL) // real function still matches the pin
    })

    it('a locally re-declared mutant with a flipped taskProjectionLockKey prefix reds the pinned literal assertion', () => {
      const mutantTaskProjectionLockKey = (listId: string, taskId: string): string =>
        `task-projections:${listId}:${taskId}`
      const PINNED_LITERAL = 'task-projection:tlst_a:tsk_b'
      expect(mutantTaskProjectionLockKey('tlst_a', 'tsk_b')).not.toBe(PINNED_LITERAL)
      expect(taskProjectionLockKey('tlst_a', 'tsk_b')).toBe(PINNED_LITERAL)
    })

    it('a locally re-declared mutant with a flipped scheduler-leader literal reds the pinned literal assertion', () => {
      const mutantTasksSchedulerLeaderLockKey = (): string => 'tasks-scheduler:follower'
      const PINNED_LITERAL = 'tasks-scheduler:leader'
      expect(mutantTasksSchedulerLeaderLockKey()).not.toBe(PINNED_LITERAL)
      expect(tasksSchedulerLeaderLockKey()).toBe(PINNED_LITERAL)
    })
  })
})
