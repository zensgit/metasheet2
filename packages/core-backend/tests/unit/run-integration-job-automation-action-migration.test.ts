import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import { AUTOMATION_ACTION_TYPES_WITH_FWB } from '../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB,
  AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB,
} from '../../src/db/migrations/zzzz20261106111300_add_run_integration_job_automation_action'

describe('run_integration_job automation action migration (R-69 1b-ii)', () => {
  it('keeps the latest database action constraint in sync with app-level action types', () => {
    // This migration widens chk_automation_action_type to the CURRENT ALL_ACTION_TYPES — so a future
    // action type added to the app without a DB migration trips this drift guard RED.
    for (const actionType of ALL_ACTION_TYPES) {
      expect(AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB).toContain(actionType)
    }
  })

  it('adds run_integration_job on top of the prior FWB action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB).toContain('run_integration_job')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB).not.toContain('run_integration_job')
    expect(AUTOMATION_ACTION_TYPES_WITH_RUN_INTEGRATION_JOB.filter((a) => a !== 'run_integration_job'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB])
    expect([...AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB]).toEqual([...AUTOMATION_ACTION_TYPES_WITH_FWB])
  })

  it('rolls back only the run_integration_job widening (write_approval_form_values + record_click remain)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB).toContain('write_approval_form_values')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_RUN_INTEGRATION_JOB).toContain('record_click')
  })
})
