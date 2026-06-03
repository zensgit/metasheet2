import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK,
  AUTOMATION_ACTION_TYPES_WITH_WAIT_FOR_CALLBACK,
} from '../../src/db/migrations/zzzz20260603140000_add_wait_for_callback_automation_action'

describe('wait_for_callback automation action migration (A6-2)', () => {
  it('keeps the database action constraint in sync with app-level action types', () => {
    // The LATEST chk_automation_action_type constraint must accept EVERY app action type —
    // adding an action type without widening the constraint would break inserts (this guards it).
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_WAIT_FOR_CALLBACK).toContain(actionType)
    }
  })

  it('adds wait_for_callback on top of the prior (send_email) action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_WAIT_FOR_CALLBACK).toContain('wait_for_callback')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK).not.toContain('wait_for_callback')
    expect(AUTOMATION_ACTION_TYPES_WITH_WAIT_FOR_CALLBACK.filter((a) => a !== 'wait_for_callback'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK])
  })

  it('rolls back only the wait_for_callback widening (keeps send_email etc.)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK).not.toContain('wait_for_callback')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK).toContain('send_email')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK).toContain('lock_record')
  })
})
