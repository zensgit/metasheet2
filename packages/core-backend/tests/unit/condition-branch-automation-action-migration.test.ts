import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH,
  AUTOMATION_ACTION_TYPES_WITH_CONDITION_BRANCH,
} from '../../src/db/migrations/zzzz20260605130000_add_condition_branch_automation_action'

describe('condition_branch automation action migration (A6-3-1)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    // The LATEST chk_automation_action_type constraint must accept EVERY app action type.
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_CONDITION_BRANCH).toContain(actionType)
    }
  })

  it('adds condition_branch on top of the prior wait_for_callback action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_CONDITION_BRANCH).toContain('condition_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH).not.toContain('condition_branch')
    expect(AUTOMATION_ACTION_TYPES_WITH_CONDITION_BRANCH.filter((a) => a !== 'condition_branch'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH])
  })

  it('rolls back only the condition_branch widening', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH).not.toContain('condition_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH).toContain('wait_for_callback')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH).toContain('lock_record')
  })
})
