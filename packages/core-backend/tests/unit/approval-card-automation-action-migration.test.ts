import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD,
  AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD,
} from '../../src/db/migrations/zzzz20260705150000_add_send_dingtalk_approval_card_automation_action'

describe('send_dingtalk_approval_card automation action migration (A-2b)', () => {
  it('keeps this constraint in sync with app-level action types except those added by later migrations', () => {
    // No longer the LATEST migration (write_approval_form_values widened the constraint afterwards —
    // see fwb-automation-action-migration.test.ts for the live "latest in sync" guard).
    const ADDED_BY_LATER_MIGRATIONS = new Set<string>(['write_approval_form_values'])
    for (const actionType of ALL_ACTION_TYPES) {
      if (ADDED_BY_LATER_MIGRATIONS.has(actionType)) continue
      expect(AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD).toContain(actionType)
    }
  })

  it('adds send_dingtalk_approval_card on top of the prior record_click action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD).toContain('send_dingtalk_approval_card')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD).not.toContain('send_dingtalk_approval_card')
    expect(AUTOMATION_ACTION_TYPES_WITH_APPROVAL_CARD.filter((a) => a !== 'send_dingtalk_approval_card'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD])
  })

  it('rolls back only the approval-card widening (record_click + delete_record remain)', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD).toContain('record_click')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_APPROVAL_CARD).toContain('delete_record')
  })
})
