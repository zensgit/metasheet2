import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_FWB,
  AUTOMATION_ACTION_TYPES_WITH_FWB,
} from '../../src/db/migrations/zzzz20260719210000_add_write_approval_form_values_automation_action'

describe('write_approval_form_values automation action migration (FWB D11)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_FWB).toContain(actionType)
    }
  })

  it('adds only write_approval_form_values to the prior approval-card action set', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_FWB).toContain('write_approval_form_values')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).not.toContain('write_approval_form_values')
    expect(AUTOMATION_ACTION_TYPES_WITH_FWB.filter((a) => a !== 'write_approval_form_values'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_FWB])
  })

  it('rolls back to the approval-card constraint surface', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).toContain('send_dingtalk_approval_card')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).toContain('record_click')
  })
})
