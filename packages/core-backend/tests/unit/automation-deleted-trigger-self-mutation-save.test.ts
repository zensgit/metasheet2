/**
 * 客户反馈 2026-09-24 #3 (裁定 PR #6074) — rule-SAVE gate for「record.deleted + 同表 修改/删除/锁定 触发记录」.
 *
 * Under a `record.deleted` trigger the trigger record no longer exists, so a same-base update_record /
 * delete_record / lock_record of it can only ever no-op (and, before the executor fix, self-chained into three
 * execution logs). createRule and every SHAPE-changing (or re-enabling) updateRule refuse it with ONE stable code
 * and ONE fixed Chinese message. The escape hatches the customer needs are pinned just as hard:
 *   - a DISABLE-only update `{ enabled: false }` of an existing such rule SUCCEEDS (setRuleEnabled routes
 *     through updateRule — otherwise the rule could never be turned off);
 *   - a rename / conditions-only edit succeeds (no shape change);
 *   - deleteRule succeeds (it validates nothing).
 *
 * Every assertion is on the service's two outbound seams: the Kysely mock (was a row written / updated /
 * deleted?) and the thrown AutomationRuleValidationError (code + message).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationRuleValidationError,
  AutomationService,
  DELETED_TRIGGER_SELF_MUTATION_CODE,
  DELETED_TRIGGER_SELF_MUTATION_MESSAGE,
  validateDeletedTriggerSelfMutation,
} from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

const SHEET_ID = 'sheet_dt_1'
const RULE_ID = 'atr_dt_1'
const CROSS_BASE_TRIPLE = { targetBaseId: 'base_b', targetSheetId: 'sheet_b', targetRecordId: 'rec_b' }

interface Harness {
  service: AutomationService
  insertedRows: () => Record<string, unknown>[]
  updateSets: () => Record<string, unknown>[]
  deleteFromCalls: () => unknown[]
  /** The stored rule every getRule() returns (a fixed row, not a strict queue — fetch count is not the subject here). */
  setStored: (row: Record<string, unknown> | undefined) => void
  pushExecute: (rows: unknown) => void
}

function makeHarness(): Harness {
  const insertRows: Record<string, unknown>[] = []
  const setCalls: Record<string, unknown>[] = []
  const deleteFromCalls: unknown[] = []
  const executeResults: unknown[] = []
  let stored: Record<string, unknown> | undefined
  let lastVerb = ''

  // No rule in this suite carries a send_notification / DingTalk / approval action, so every other save-time
  // reader is contractually zero-DB; a blanket empty result keeps that honest (a gate that suddenly read the
  // DB would still pass, but nothing here depends on it).
  const queryFn = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))

  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const m of [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset',
    'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin',
  ]) {
    chain[m] = vi.fn(chainFn)
  }
  chain.insertInto = vi.fn((table: unknown) => { lastVerb = `insert:${String(table)}`; return chain })
  chain.updateTable = vi.fn((table: unknown) => { lastVerb = `update:${String(table)}`; return chain })
  chain.deleteFrom = vi.fn((table: unknown) => { lastVerb = `delete:${String(table)}`; deleteFromCalls.push(table); return chain })
  chain.values = vi.fn((row: unknown) => { insertRows.push(row as Record<string, unknown>); return chain })
  chain.set = vi.fn((row: unknown) => { setCalls.push(row as Record<string, unknown>); return chain })
  chain.execute = vi.fn(async () => {
    if (lastVerb.startsWith('insert')) return []
    return executeResults.shift() ?? []
  })
  chain.executeTakeFirst = vi.fn(async () => stored)

  const service = new AutomationService(new EventBus(), chain as never, queryFn as never)

  return {
    service,
    insertedRows: () => insertRows,
    updateSets: () => setCalls,
    deleteFromCalls: () => deleteFromCalls,
    setStored: (row) => { stored = row },
    pushExecute: (rows) => { executeResults.push(rows) },
  }
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: '记录删除时 → 删除记录',
    trigger_type: 'record.deleted',
    trigger_config: {},
    action_type: 'delete_record',
    action_config: {},
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'u1',
    conditions: null,
    actions: [{ type: 'delete_record', config: {} }],
    execution_mode: null,
    ...overrides,
  }
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    name: '记录删除时 → 删除记录',
    triggerType: 'record.deleted',
    triggerConfig: {},
    actionType: 'delete_record',
    actionConfig: {},
    actions: [{ type: 'delete_record', config: {} }],
    createdBy: 'u1',
    ...overrides,
  }
}

async function rejection(promise: Promise<unknown>): Promise<AutomationRuleValidationError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(AutomationRuleValidationError)
    return err as AutomationRuleValidationError
  }
  throw new Error('expected the save to be refused, but it resolved')
}

function expectSelfMutationRefusal(err: AutomationRuleValidationError): void {
  expect(err.code).toBe(DELETED_TRIGGER_SELF_MUTATION_CODE)
  expect(err.code).toBe('DELETED_TRIGGER_SELF_MUTATION')
  expect(err.message).toBe(DELETED_TRIGGER_SELF_MUTATION_MESSAGE)
  expect(err.message).toBe('记录删除时触发记录已不存在，不能再修改/删除/锁定它')
}

describe('validateDeletedTriggerSelfMutation — the pure rule', () => {
  it('flags every same-base trigger-record mutation under record.deleted, top level and nested', () => {
    for (const type of ['update_record', 'delete_record', 'lock_record', 'update_field']) {
      expect(validateDeletedTriggerSelfMutation('record.deleted', type, {}, null)).toBe(DELETED_TRIGGER_SELF_MUTATION_MESSAGE)
    }
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'send_webhook', {}, [
      { type: 'send_webhook', config: {} },
      { type: 'lock_record', config: { locked: true } },
    ] as never)).toBe(DELETED_TRIGGER_SELF_MUTATION_MESSAGE)
  })

  it('does not flag other triggers, non-mutating actions, or a COMPLETE explicit cross-base target', () => {
    expect(validateDeletedTriggerSelfMutation('record.created', 'delete_record', {}, null)).toBeNull()
    expect(validateDeletedTriggerSelfMutation('record.updated', 'lock_record', {}, null)).toBeNull()
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'send_webhook', { url: 'https://example.test' }, null)).toBeNull()
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'send_notification', { userIds: ['u1'] }, [
      { type: 'send_email', config: {} },
    ] as never)).toBeNull()
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'delete_record', CROSS_BASE_TRIPLE, null)).toBeNull()
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'update_record', { fields: { a: 1 }, ...CROSS_BASE_TRIPLE }, null)).toBeNull()
  })

  it('an INCOMPLETE cross-base target still resolves to the trigger record (the executor falls back to context.recordId)', () => {
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'delete_record', { targetBaseId: 'base_b' }, null))
      .toBe(DELETED_TRIGGER_SELF_MUTATION_MESSAGE)
    expect(validateDeletedTriggerSelfMutation('record.deleted', 'delete_record', { targetSheetId: 'sheet_b', targetRecordId: 'rec_b' }, null))
      .toBe(DELETED_TRIGGER_SELF_MUTATION_MESSAGE)
  })
})

describe('createRule — refuses the shape, writes nothing', () => {
  let h: Harness
  beforeEach(() => { h = makeHarness() })

  it('record.deleted + same-base delete_record (the customer rule) → DELETED_TRIGGER_SELF_MUTATION, no insert', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, createInput()))
    expectSelfMutationRefusal(err)
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('record.deleted + same-base update_record / lock_record → refused', async () => {
    const update = await rejection(h.service.createRule(SHEET_ID, createInput({
      actionType: 'update_record',
      actionConfig: { fields: { status: 'archived' } },
      actions: [{ type: 'update_record', config: { fields: { status: 'archived' } } }],
    })))
    expectSelfMutationRefusal(update)
    const lock = await rejection(h.service.createRule(SHEET_ID, createInput({
      actionType: 'lock_record',
      actionConfig: { locked: true },
      actions: [{ type: 'lock_record', config: { locked: true } }],
    })))
    expectSelfMutationRefusal(lock)
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('record.deleted + update_record NESTED in a parallel_branch → refused (the flattening is checked too)', async () => {
    const branch = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          { key: 'a', actions: [{ type: 'update_record', config: { fields: { status: 'a' } } }] },
          { key: 'b', actions: [{ type: 'update_record', config: { fields: { status: 'b' } } }] },
        ],
      },
    }
    const err = await rejection(h.service.createRule(SHEET_ID, createInput({
      actionType: 'parallel_branch',
      actionConfig: branch.config,
      actions: [branch],
      executionMode: 'workflow_job_v1',
    })))
    expectSelfMutationRefusal(err)
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('the v0 alias update_field is folded onto update_record before the gate and refused the same way', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, createInput({
      actionType: 'update_field',
      actionConfig: { fieldId: 'status', value: 'archived' },
      actions: undefined,
    })))
    expectSelfMutationRefusal(err)
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('ALLOWS record.deleted + a COMPLETE cross-base delete_record (another record in another base)', async () => {
    const rule = await h.service.createRule(SHEET_ID, createInput({
      actionConfig: CROSS_BASE_TRIPLE,
      actions: [{ type: 'delete_record', config: CROSS_BASE_TRIPLE }],
    }))
    expect(rule.trigger_type).toBe('record.deleted')
    expect(h.insertedRows()).toHaveLength(1)
  })

  it('ALLOWS record.deleted + a non-mutating action, and record.created + delete_record (unchanged)', async () => {
    await h.service.createRule(SHEET_ID, createInput({
      actionType: 'send_webhook',
      actionConfig: { url: 'https://example.test/hook', method: 'POST' },
      actions: [{ type: 'send_webhook', config: { url: 'https://example.test/hook', method: 'POST' } }],
    }))
    await h.service.createRule(SHEET_ID, createInput({ triggerType: 'record.created' }))
    expect(h.insertedRows()).toHaveLength(2)
  })
})

describe('updateRule — refuses shape changes INTO the combination, lets the operator out', () => {
  let h: Harness
  beforeEach(() => { h = makeHarness() })

  it('DISABLE-only `{ enabled: false }` of an EXISTING such rule SUCCEEDS (setRuleEnabled routes through updateRule)', async () => {
    h.setStored(storedRow())
    h.pushExecute([storedRow({ enabled: false })])

    const updated = await h.service.setRuleEnabled(RULE_ID, SHEET_ID, false)

    expect(updated).not.toBeNull()
    expect(updated?.enabled).toBe(false)
    expect(h.updateSets()).toHaveLength(1)
    expect(h.updateSets()[0]).toMatchObject({ enabled: false })
  })

  it('a rename of an EXISTING such rule succeeds (no shape change)', async () => {
    h.setStored(storedRow())
    h.pushExecute([storedRow({ name: 'renamed' })])

    const updated = await h.service.updateRule(RULE_ID, SHEET_ID, { name: 'renamed' })

    expect(updated?.name).toBe('renamed')
    expect(h.updateSets()).toHaveLength(1)
  })

  it('a conditions-only edit of an EXISTING such rule succeeds (no shape change)', async () => {
    h.setStored(storedRow())
    h.pushExecute([storedRow()])

    const updated = await h.service.updateRule(RULE_ID, SHEET_ID, {
      conditions: { conjunction: 'AND', conditions: [{ fieldId: 'status', operator: 'equals', value: 'x' }] } as never,
    })

    expect(updated).not.toBeNull()
    expect(h.updateSets()).toHaveLength(1)
  })

  it('RE-ENABLING an existing such rule is refused (enabled is not a bypass for arming a rule that can only no-op)', async () => {
    h.setStored(storedRow({ enabled: false }))

    const err = await rejection(h.service.setRuleEnabled(RULE_ID, SHEET_ID, true))

    expectSelfMutationRefusal(err)
    expect(h.updateSets()).toHaveLength(0)
  })

  it('re-saving the EXISTING shape from the editor (full payload) is refused until the action or trigger changes', async () => {
    h.setStored(storedRow())

    const err = await rejection(h.service.updateRule(RULE_ID, SHEET_ID, {
      name: '记录删除时 → 删除记录',
      triggerType: 'record.deleted',
      triggerConfig: {},
      actionType: 'delete_record',
      actionConfig: {},
      actions: [{ type: 'delete_record', config: {} }],
    }))

    expectSelfMutationRefusal(err)
    expect(h.updateSets()).toHaveLength(0)
  })

  it('changing ONLY the trigger of a record.created + delete_record rule to record.deleted is refused', async () => {
    h.setStored(storedRow({ trigger_type: 'record.created' }))

    const err = await rejection(h.service.updateRule(RULE_ID, SHEET_ID, { triggerType: 'record.deleted' }))

    expectSelfMutationRefusal(err)
    expect(h.updateSets()).toHaveLength(0)
  })

  it('changing ONLY the actions of a record.deleted + send_webhook rule to lock_record is refused', async () => {
    h.setStored(storedRow({
      action_type: 'send_webhook',
      action_config: { url: 'https://example.test/hook', method: 'POST' },
      actions: [{ type: 'send_webhook', config: { url: 'https://example.test/hook', method: 'POST' } }],
    }))

    const err = await rejection(h.service.updateRule(RULE_ID, SHEET_ID, {
      actionType: 'lock_record',
      actionConfig: { locked: true },
      actions: [{ type: 'lock_record', config: { locked: true } }],
    }))

    expectSelfMutationRefusal(err)
    expect(h.updateSets()).toHaveLength(0)
  })

  it('fixing the rule — swapping the action for send_webhook — saves normally', async () => {
    h.setStored(storedRow())
    const fixed = storedRow({
      action_type: 'send_webhook',
      action_config: { url: 'https://example.test/hook', method: 'POST' },
      actions: [{ type: 'send_webhook', config: { url: 'https://example.test/hook', method: 'POST' } }],
    })
    h.pushExecute([fixed])

    const updated = await h.service.updateRule(RULE_ID, SHEET_ID, {
      actionType: 'send_webhook',
      actionConfig: { url: 'https://example.test/hook', method: 'POST' },
      actions: [{ type: 'send_webhook', config: { url: 'https://example.test/hook', method: 'POST' } }],
    })

    expect(updated?.action_type).toBe('send_webhook')
    expect(h.updateSets()).toHaveLength(1)
  })

  it('fixing the rule — moving the trigger to record.created — saves normally', async () => {
    h.setStored(storedRow())
    h.pushExecute([storedRow({ trigger_type: 'record.created' })])

    const updated = await h.service.updateRule(RULE_ID, SHEET_ID, { triggerType: 'record.created' })

    expect(updated?.trigger_type).toBe('record.created')
    expect(h.updateSets()).toHaveLength(1)
  })
})

describe('deleteRule — always allowed', () => {
  it('deletes an EXISTING such rule (nothing to validate on the way out)', async () => {
    const h = makeHarness()
    h.setStored(storedRow())
    h.pushExecute([{ numDeletedRows: 1n }])

    expect(await h.service.deleteRule(RULE_ID, SHEET_ID)).toBe(true)
    expect(h.deleteFromCalls()).toEqual(['automation_rules'])
  })
})
