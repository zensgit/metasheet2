/**
 * FWB production-path unit: executor registration + fail-closed when disabled.
 */
import { describe, expect, test, vi } from 'vitest'

import { ALL_ACTION_TYPES } from '../../src/multitable/automation-actions'
import { AutomationExecutor, type AutomationDeps, type ExecutionContext } from '../../src/multitable/automation-executor'

function makeDeps(over: Partial<AutomationDeps> = {}): AutomationDeps {
  return {
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => 'sub'), unsubscribe: vi.fn() } as never,
    queryFn: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    ...over,
  }
}

function ctx(): ExecutionContext {
  return {
    executionId: 'exec_1',
    ruleId: 'rule_1',
    sheetId: 'sheet_1',
    recordId: '',
    recordData: {},
    ruleCreatedBy: 'creator_1',
    actorId: 'approver_1',
    triggerEvent: {
      eventId: 'evt_1',
      eventType: 'approval.approved',
      approval: { instanceId: 'inst_1', templateId: 'tpl_1' },
      _automationDepth: 0,
    },
  }
}

describe('FWB production path — executor registration', () => {
  test('write_approval_form_values is a canonical action type', () => {
    expect(ALL_ACTION_TYPES).toContain('write_approval_form_values')
  })

  test('executor fail-closes when no transaction seam', async () => {
    const exec = new AutomationExecutor(makeDeps())
    const result = await exec.runSingleAction(
      { type: 'write_approval_form_values', config: { mode: 'create', mappings: [], confirmationId: 'x' } },
      ctx(),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/transaction seam/i)
  })

  test('executor fail-closes when FWB flag is OFF (default)', async () => {
    const transaction = vi.fn(async (handler: (c: { query: AutomationDeps['queryFn'] }) => Promise<unknown>) =>
      handler({ query: async () => ({ rows: [], rowCount: 0 }) }),
    )
    const exec = new AutomationExecutor(makeDeps({ transaction }))
    const result = await exec.runSingleAction(
      {
        type: 'write_approval_form_values',
        config: {
          mode: 'create',
          mappings: [{ formFieldId: 'a', targetFieldId: 'b' }],
          confirmationId: 'fwbc_x',
        },
      },
      ctx(),
    )
    expect(result.actionType).toBe('write_approval_form_values')
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/disabled|APPROVAL_FWB|DURABLE/i)
    expect(transaction).not.toHaveBeenCalled()
  })
})
