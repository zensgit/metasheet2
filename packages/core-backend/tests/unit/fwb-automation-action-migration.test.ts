import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_FWB,
  AUTOMATION_ACTION_TYPES_WITH_FWB,
} from '../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'

describe('write_approval_form_values automation action migration (FWB activation)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    // This migration widens chk_automation_action_type to the CURRENT ALL_ACTION_TYPES — so a future
    // action type added to the app without a DB migration trips this drift guard RED.
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_FWB).toContain(actionType)
    }
  })

  it('adds write_approval_form_values on top of the prior approval-card action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_FWB).toContain('write_approval_form_values')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).not.toContain('write_approval_form_values')
    expect(AUTOMATION_ACTION_TYPES_WITH_FWB.filter((a) => a !== 'write_approval_form_values'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_FWB])
  })

  it('rolls back only the FWB widening (send_dingtalk_approval_card + record_click remain)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).toContain('send_dingtalk_approval_card')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_FWB).toContain('record_click')
  })
})
