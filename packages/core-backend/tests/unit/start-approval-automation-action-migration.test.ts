import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL,
  AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL,
} from '../../src/db/migrations/zzzz20260610150000_create_automation_approval_bridges'

describe('start_approval automation action migration (W6-1)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL).toContain(actionType)
    }
  })

  it('adds start_approval on top of the prior condition_branch action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL).toContain('start_approval')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL).not.toContain('start_approval')
    expect(AUTOMATION_ACTION_TYPES_WITH_START_APPROVAL.filter((a) => a !== 'start_approval'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL])
  })

  it('rolls back only the start_approval widening', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL).not.toContain('start_approval')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL).toContain('condition_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_START_APPROVAL).toContain('wait_for_callback')
  })
})
