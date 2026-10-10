import { describe, expect, it } from 'vitest'
import {
  newTaskCommentId,
  newTaskEventId,
  newTaskGroupId,
  newTaskId,
  newTaskListEventId,
  newTaskListId,
} from '../../src/services/task-ids-runtime'
import { isValidTaskDomainId } from '../../src/tasks/task-ids'

describe('task-ids-runtime', () => {
  it('newTaskId returns a tsk_ id that passes the four-conjunct CHECK', () => {
    const id = newTaskId()
    expect(id.startsWith('tsk_')).toBe(true)
    expect(isValidTaskDomainId(id)).toBe(true)
  })

  it('newTaskEventId returns a tev_ id that passes the four-conjunct CHECK', () => {
    const id = newTaskEventId()
    expect(id.startsWith('tev_')).toBe(true)
    expect(isValidTaskDomainId(id)).toBe(true)
  })

  it('newTaskCommentId returns a tcmt_ id that passes the four-conjunct CHECK', () => {
    const id = newTaskCommentId()
    expect(id.startsWith('tcmt_')).toBe(true)
    expect(isValidTaskDomainId(id)).toBe(true)
  })

  it('generates distinct ids across repeated calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newTaskCommentId()))
    expect(ids.size).toBe(20)
  })

  // RULED(2026-10-07): [R23] tgrp_ / tlev_ prefixes.
  it.each([
    ['newTaskListId', newTaskListId, 'tlst_'],
    ['newTaskGroupId', newTaskGroupId, 'tgrp_'],
    ['newTaskListEventId', newTaskListEventId, 'tlev_'],
  ] as const)('%s returns an id with its M4 prefix that passes the four-conjunct CHECK', (_name, gen, prefix) => {
    const id = gen()
    expect(id.startsWith(prefix)).toBe(true)
    expect(/^[a-z]+_[A-Za-z0-9]+$/.test(id)).toBe(true)
    expect(isValidTaskDomainId(id)).toBe(true)
  })

  it('M4 generators produce distinct ids across repeated calls', () => {
    for (const gen of [newTaskListId, newTaskGroupId, newTaskListEventId]) {
      const ids = new Set(Array.from({ length: 20 }, () => gen()))
      expect(ids.size).toBe(20)
    }
  })
})
