import { describe, expect, it } from 'vitest'
import { resolveCreateAssigneeIds } from '../../src/services/task-create'
import { newTaskEventId } from '../../src/services/task-ids-runtime'

describe('task create assignees', () => {
  it('inserts the creator when the field is omitted', () => {
    expect(resolveCreateAssigneeIds({ assignees: undefined, creatorId: 'u1' })).toEqual(['u1'])
  })

  it('inserts nobody when the array is empty', () => {
    expect(resolveCreateAssigneeIds({ assignees: [], creatorId: 'u1' })).toEqual([])
  })

  it('inserts only the listed users', () => {
    expect(resolveCreateAssigneeIds({ assignees: ['u2', 'u2'], creatorId: 'u1' })).toEqual(['u2'])
  })
})

describe('task event ids', () => {
  it('uses the tev_ prefix', () => {
    expect(newTaskEventId().startsWith('tev_')).toBe(true)
  })
})
