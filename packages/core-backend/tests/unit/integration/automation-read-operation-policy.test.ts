import { describe, expect, it } from 'vitest'
import { AutomationReadLedgerError } from '../../../src/integration/automation-read-contracts'
import {
  AUTOMATION_READ_ACTION_TYPE, AUTOMATION_READ_OPERATION, deriveAutomationReadOperationPolicy,
  type AutomationReadOperationPolicyInput,
} from '../../../src/integration/automation-read-operation-policy'

type Row = Record<string, unknown>
const schedule = ['schedule.cron', 'schedule.interval', 'schedule.date_field']
const record = ['record.created', 'record.updated', 'record.deleted', 'field.value_changed']
function input(overrides: Row = {}): AutomationReadOperationPolicyInput {
  return { actionType: AUTOMATION_READ_ACTION_TYPE,
    actionConfig: { operation: AUTOMATION_READ_OPERATION, allowManual: false },
    actions: null, executionMode: null, triggerType: 'record.created', ...overrides } as AutomationReadOperationPolicyInput
}
function rejected(value: unknown) {
  let error: unknown
  try { deriveAutomationReadOperationPolicy(value as AutomationReadOperationPolicyInput) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(AutomationReadLedgerError)
  expect(error).toMatchObject({ code: 'AUTOMATION_READ_DENIED', message: 'AUTOMATION_READ_DENIED' })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('details')
  expect(String(error)).not.toContain('synthetic-private-hook')
}

describe('Private fixed single-operation rule policy (not creator/tenant/permission authority)', () => {
  it.each([...schedule.map(triggerType => ({ triggerType, family: 'schedule' })),
    ...record.map(triggerType => ({ triggerType, family: 'record' }))])('maps exactly $triggerType, with manual only when explicitly true', ({ triggerType, family }) => {
    const withoutManual = deriveAutomationReadOperationPolicy(input({ triggerType }))
    expect(withoutManual).toEqual({ actionType: AUTOMATION_READ_ACTION_TYPE, operation: AUTOMATION_READ_OPERATION,
      allowManual: false, allowedTriggers: [family] })
    expect(deriveAutomationReadOperationPolicy(input({ triggerType,
      actionConfig: { operation: AUTOMATION_READ_OPERATION, allowManual: true } })).allowedTriggers).toEqual(['manual', family])
    expect(withoutManual.allowedTriggers).not.toContain(family === 'schedule' ? 'record' : 'schedule')
  })
  it.each([null, 'legacy'])('uses the real eligible repository execution mode %s', executionMode => {
    expect(deriveAutomationReadOperationPolicy(input({ executionMode })).allowedTriggers).toEqual(['record'])
  })
  it.each([null, [], [{ type: AUTOMATION_READ_ACTION_TYPE,
    config: { operation: AUTOMATION_READ_OPERATION, allowManual: false } }]].map(actions => ({ actions })))(
    'accepts only null/empty or the identical single modern action %#', ({ actions }) => {
      expect(deriveAutomationReadOperationPolicy(input({ actions })).allowedTriggers).toEqual(['record'])
    },
  )
  it('returns a detached deeply frozen fixed contract without altering input material', () => {
    const supplied = input()
    const result = deriveAutomationReadOperationPolicy(supplied)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.allowedTriggers)).toBe(true)
    expect(Object.isFrozen(supplied.actionConfig)).toBe(false)
    const changedConfig = supplied.actionConfig as Row
    changedConfig.allowManual = true
    Object.assign(supplied, { triggerType: 'schedule.interval' })
    expect(result.allowedTriggers).toEqual(['record'])
    expect(result.allowManual).toBe(false)
    expect(Reflect.set(result.allowedTriggers, '0', 'manual')).toBe(false)
    expect(Reflect.set(result, 'allowManual', true)).toBe(false)
    expect(Reflect.ownKeys(result).sort()).toEqual(['actionType', 'allowManual', 'allowedTriggers', 'operation'])
  })
  it('accepts own data with null prototypes, never inherited policy', () => {
    const supplied = Object.assign(Object.create(null) as Row, input())
    Object.assign(supplied, { actionConfig: Object.assign(Object.create(null) as Row, input().actionConfig) })
    expect(deriveAutomationReadOperationPolicy(supplied as AutomationReadOperationPolicyInput).allowedTriggers).toEqual(['record'])
    rejected(Object.create(input()))
  })
  it.each([undefined, null, true, 1, [], {}, { ...input(), source: 'private-selector' },
    { ...input(), actionType: 'notify' }, { ...input(), actionType: 'integration_read_preview ' },
    ...['inline', 'sync', 'workflow_job_v1', '', false, undefined].map(executionMode => input({ executionMode })),
  ].map(value => ({ value })))('rejects wrong shape, action, or execution mode %#', ({ value }) => { rejected(value) })
  it.each(['manual', 'record', 'schedule', 'webhook.received', 'approval.completed', 'approval.task_created',
    'form.submitted', 'unknown', 'record.created ', 'schedule.CRON', '', null, undefined].map(triggerType => ({ triggerType })))(
    'does not invent a trigger fallback for %# even with allowManual true', ({ triggerType }) => {
      rejected(input({ triggerType, actionConfig: { operation: AUTOMATION_READ_OPERATION, allowManual: true } }))
    },
  )
  const invalidConfigs: unknown[] = [null, undefined, [], {}, { operation: AUTOMATION_READ_OPERATION },
    { allowManual: true }, { operation: 'plm.stock-preparation.apply.v1', allowManual: false },
    { operation: `${AUTOMATION_READ_OPERATION} `, allowManual: false },
    ...[undefined, null, 0, 1, 'false', 'true', {}].map(allowManual => ({ operation: AUTOMATION_READ_OPERATION, allowManual })),
    ...['selector', 'targetId', 'systemId', 'sql', 'budget', 'proof'].map(key => ({ operation: AUTOMATION_READ_OPERATION, allowManual: false, [key]: 'private' })),
  ]
  it.each(invalidConfigs.map(actionConfig => ({ actionConfig })))('rejects malformed or private-bearing action config %#', ({ actionConfig }) => {
    rejected(input({ actionConfig }))
    rejected(input({ actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: actionConfig }] }))
  })
  const one = { type: AUTOMATION_READ_ACTION_TYPE, config: { operation: AUTOMATION_READ_OPERATION, allowManual: false } }
  it.each([undefined, {}, '[]', false, [one, one], [null], [{}], [{ ...one, type: 'send_webhook' }],
    [{ ...one, config: { operation: AUTOMATION_READ_OPERATION, allowManual: true } }],
    [{ ...one, next: null }], [{ ...one, actions: [] }], [{ ...one, branches: [] }],
    [{ ...one, actionKey: 'custom' }], new Array(1)].map(actions => ({ actions })))(
    'rejects successor/branch/mismatched modern action material %#', ({ actions }) => { rejected(input({ actions })) },
  )
  it.each(['actionType', 'actionConfig', 'actions', 'executionMode', 'triggerType'])('requires explicit own enumerable data for %s', key => {
    const missing = input() as unknown as Row
    delete missing[key]
    rejected(missing)
    const hidden = input()
    Object.defineProperty(hidden, key, { enumerable: false, value: missing[key] })
    rejected(hidden)
  })
  it('rejects input/config/list/action hooks, hidden keys and custom prototypes without calling hooks', () => {
    let hooks = 0
    const getter = { enumerable: true, get() { hooks += 1; throw new Error('synthetic-private-hook') } }
    for (const key of ['actionType', 'actionConfig', 'actions', 'executionMode', 'triggerType']) {
      rejected(Object.defineProperty(input(), key, getter))
    }
    for (const key of ['operation', 'allowManual']) {
      rejected(input({ actionConfig: Object.defineProperty({ ...one.config }, key, getter) }))
    }
    for (const key of ['type', 'config']) {
      rejected(input({ actions: [Object.defineProperty({ ...one }, key, getter)] }))
    }
    const list = [one]
    Object.defineProperty(list, '0', getter)
    rejected(input({ actions: list }))
    for (const key of ['toJSON', Symbol('hidden')]) {
      const hidden = { value() { hooks += 1; return {} } }
      rejected(Object.defineProperty(input(), key, hidden))
      rejected(input({ actionConfig: Object.defineProperty({ ...one.config }, key, hidden) }))
      rejected(input({ actions: Object.defineProperty([one], key, hidden) }))
      rejected(input({ actions: [Object.defineProperty({ ...one }, key, hidden)] }))
    }
    const prototype = { toJSON() { hooks += 1; return {} } }
    rejected(Object.assign(Object.create(prototype) as Row, input()))
    rejected(input({ actionConfig: Object.assign(Object.create(prototype) as Row, one.config) }))
    rejected(input({ actions: Object.setPrototypeOf([one], prototype) }))
    expect(hooks).toBe(0)
  })
})
