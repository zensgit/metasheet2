import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_CONDITION_BRANCH,
  AUTOMATION_ACTION_TYPES_WITH_CONDITION_BRANCH,
} from '../../src/db/migrations/zzzz20260605130000_add_condition_branch_automation_action'

describe('condition_branch automation action migration (A6-3-1)', () => {
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
