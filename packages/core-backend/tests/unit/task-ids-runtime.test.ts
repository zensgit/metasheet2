import { describe, expect, it } from 'vitest'
import { newTaskCommentId, newTaskEventId, newTaskId } from '../../src/services/task-ids-runtime'
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
})
