import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_RECORD_CLICK,
  AUTOMATION_ACTION_TYPES_WITH_RECORD_CLICK,
} from '../../src/db/migrations/zzzz20260615150000_add_record_click_automation_action'

describe('record_click automation action migration (B1-a1)', () => {
  it('keeps this constraint in sync with app-level action types except those added by later migrations', () => {
    // No longer the LATEST migration (send_dingtalk_approval_card widened the constraint afterwards —
    // see approval-card-automation-action-migration.test.ts for the live "latest in sync" guard).
    const ADDED_BY_LATER_MIGRATIONS = new Set<string>(['send_dingtalk_approval_card', 'write_approval_form_values'])
    for (const actionType of ALL_ACTION_TYPES) {
      if (ADDED_BY_LATER_MIGRATIONS.has(actionType)) continue
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
