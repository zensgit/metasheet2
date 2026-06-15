import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK,
  AUTOMATION_ACTION_TYPES_WITH_RECORD_CLICK,
} from '../../src/db/migrations/zzzz20260615180000_add_record_click_automation_action'

describe('record_click automation action migration (B1-a1 button/action field)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    // This migration widens chk_automation_action_type to the CURRENT ALL_ACTION_TYPES — so a future
    // action type added to the app without a DB migration trips this drift guard RED.
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_RECORD_CLICK).toContain(actionType)
    }
  })

  it('adds record_click on top of the prior delete_record action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_RECORD_CLICK).toContain('record_click')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK).not.toContain('record_click')
    expect(AUTOMATION_ACTION_TYPES_WITH_RECORD_CLICK.filter((a) => a !== 'record_click'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK])
  })

  it('rolls back only the record_click widening (delete_record + parallel_branch remain)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK).not.toContain('record_click')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK).toContain('delete_record')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK).toContain('parallel_branch')
  })
})
