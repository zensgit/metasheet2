import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH,
  AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH,
} from '../../src/db/migrations/zzzz20260611120000_add_parallel_branch_automation_action'

describe('parallel_branch automation action migration (A6-3-4 / W3-1)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH).toContain(actionType)
    }
  })

  it('adds parallel_branch on top of the prior start_approval action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH).toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).not.toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH.filter((a) => a !== 'parallel_branch'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH])
  })

  it('rolls back only the parallel_branch widening', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).not.toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).toContain('start_approval')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).toContain('condition_branch')
  })
})
