import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD,
  AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD,
} from '../../src/db/migrations/zzzz20260614120000_add_delete_record_automation_action'

describe('delete_record automation action migration (Phase C2)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    // This migration widens chk_automation_action_type to the CURRENT ALL_ACTION_TYPES — so a future
    // action type added to the app without a DB migration trips this drift guard RED.
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD).toContain(actionType)
    }
  })

  it('adds delete_record on top of the prior parallel_branch action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD).toContain('delete_record')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD).not.toContain('delete_record')
    expect(AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD.filter((a) => a !== 'delete_record'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD])
  })

  it('rolls back only the delete_record widening (parallel_branch + create_record remain)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD).not.toContain('delete_record')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD).toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD).toContain('create_record')
  })
})
