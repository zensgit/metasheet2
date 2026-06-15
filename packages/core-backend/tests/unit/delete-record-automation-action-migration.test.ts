import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_DELETE_RECORD,
  AUTOMATION_ACTION_TYPES_WITH_DELETE_RECORD,
} from '../../src/db/migrations/zzzz20260614120000_add_delete_record_automation_action'

describe('delete_record automation action migration (Phase C2)', () => {
  it('keeps this constraint in sync with app-level action types except those added by later migrations', () => {
    // No longer the LATEST migration (record_click widened the constraint afterwards — see
    // record-click-automation-action-migration.test.ts for the live "latest in sync" guard). Every
    // app-level action type except the ones introduced by a strictly-later migration must be here.
    const ADDED_BY_LATER_MIGRATIONS = new Set<string>(['record_click'])
    for (const actionType of ALL_ACTION_TYPES) {
      if (ADDED_BY_LATER_MIGRATIONS.has(actionType)) continue
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
