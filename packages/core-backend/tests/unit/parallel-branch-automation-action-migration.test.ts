import { describe, expect, it } from 'vitest'
import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import {
  AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH,
  AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH,
} from '../../src/db/migrations/zzzz20260611120000_add_parallel_branch_automation_action'

describe('parallel_branch automation action migration (A6-3-4 / W3-1)', () => {
  it('keeps this constraint in sync with app-level action types except those added by later migrations', () => {
    // This is no longer the LATEST migration (delete_record widened the constraint afterwards — see
    // `delete-record-automation-action-migration.test.ts` for the live "latest in sync" guard). Every
    // app-level action type except the ones introduced by a strictly-later migration must already be here.
    const ADDED_BY_LATER_MIGRATIONS = new Set<string>(['delete_record', 'record_click'])
    for (const actionType of ALL_ACTION_TYPES) {
      if (ADDED_BY_LATER_MIGRATIONS.has(actionType)) continue
      expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH).toContain(actionType)
    }
  })

  it('adds parallel_branch on top of the prior start_approval action set, and nothing else', () => {
    expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH).toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).not.toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_WITH_PARALLEL_BRANCH.filter((a) => a !== 'parallel_branch'))
      .toEqual([...AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH])
  })

  it('rolls back only the parallel_branch widening', () => {
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).not.toContain('parallel_branch')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).toContain('start_approval')
    expect(AUTOMATION_ACTION_TYPES_BEFORE_PARALLEL_BRANCH).toContain('condition_branch')
  })
})
