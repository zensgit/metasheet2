import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_WAIT_FOR_CALLBACK,
  AUTOMATION_ACTION_TYPES_WITH_WAIT_FOR_CALLBACK,
} from '../../src/db/migrations/zzzz20260603140000_add_wait_for_callback_automation_action'

describe('wait_for_callback automation action migration (A6-2)', () => {
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
