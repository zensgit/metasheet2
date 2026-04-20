import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { evaluateCondition, evaluateConditions, type AutomationCondition, type ConditionGroup } from '../../src/multitable/automation-conditions'
import { AutomationExecutor, type AutomationRule, type AutomationDeps, type AutomationExecution } from '../../src/multitable/automation-executor'
import { AutomationScheduler, parseCronToIntervalMs } from '../../src/multitable/automation-scheduler'
import { matchesTrigger } from '../../src/multitable/automation-triggers'
import type { AutomationTrigger, AutomationTriggerType } from '../../src/multitable/automation-triggers'
import { EventBus } from '../../src/integration/events/event-bus'

// ── DB mock for AutomationLogService ──────────────────────────────────────

const _executeResults: unknown[] = []
const _executeTakeFirstResults: unknown[] = []

function makeChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => self
  const methods = [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
    'limit', 'offset', 'groupBy', 'insertInto', 'values',
    'onConflict', 'columns', 'doUpdateSet',
    'updateTable', 'set', 'deleteFrom', 'returningAll',
    'leftJoin',
  ]
  for (const m of methods) {
    self[m] = vi.fn(chainFn)
  }
  self.execute = vi.fn(async () => {
    return _executeResults.shift() ?? []
  })
  self.executeTakeFirst = vi.fn(async () => {
    return _executeTakeFirstResults.shift()
  })
  return self
}

const mockDb: Record<string, unknown> = {}
for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
  mockDb[m] = vi.fn(() => makeChain())
}

vi.mock('../../src/db/db', () => {
  const rootChain: Record<string, unknown> = {}
  for (const m of ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom']) {
    rootChain[m] = vi.fn(() => makeChain())
  }
  return { db: rootChain }
})

import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { AutomationService } from '../../src/multitable/automation-service'

// ── Helpers ─────────────────────────────────────────────────────────────

function createMockRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_1',
    name: 'Test Rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'update_record', config: { fields: { status: 'done' } } }],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function createMockDeps(overrides: Partial<AutomationDeps> = {}): AutomationDeps {
  return {
    eventBus: new EventBus(),
    queryFn: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    fetchFn: vi.fn(async () => new Response('OK', { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  }
}

function createExecution(overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    id: `axe_${Math.random().toString(36).slice(2)}`,
    ruleId: 'rule_1',
    triggeredBy: 'event',
    triggeredAt: new Date().toISOString(),
    status: 'success',
    steps: [],
    duration: 10,
    ...overrides,
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Condition Evaluation
// ═════════════════════════════════════════════════════════════════════════

describe('Condition Evaluation', () => {
  describe('evaluateCondition — equals', () => {
    it('returns true when field matches value', () => {
      expect(evaluateCondition({ fieldId: 'status', operator: 'equals', value: 'active' }, { status: 'active' })).toBe(true)
    })
    it('returns false when field does not match', () => {
      expect(evaluateCondition({ fieldId: 'status', operator: 'equals', value: 'active' }, { status: 'closed' })).toBe(false)
    })
    it('returns true for numeric equality', () => {
      expect(evaluateCondition({ fieldId: 'count', operator: 'equals', value: 42 }, { count: 42 })).toBe(true)
    })
  })

  describe('evaluateCondition — not_equals', () => {
    it('returns true when field differs', () => {
      expect(evaluateCondition({ fieldId: 'a', operator: 'not_equals', value: 1 }, { a: 2 })).toBe(true)
    })
    it('returns false when field matches', () => {
      expect(evaluateCondition({ fieldId: 'a', operator: 'not_equals', value: 1 }, { a: 1 })).toBe(false)
    })
  })

  describe('evaluateCondition — contains', () => {
    it('string contains substring', () => {
      expect(evaluateCondition({ fieldId: 'name', operator: 'contains', value: 'ell' }, { name: 'hello' })).toBe(true)
    })
    it('string does not contain substring', () => {
      expect(evaluateCondition({ fieldId: 'name', operator: 'contains', value: 'xyz' }, { name: 'hello' })).toBe(false)
    })
    it('array contains value', () => {
      expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: 'a' }, { tags: ['a', 'b'] })).toBe(true)
    })
    it('returns false for non-string/non-array', () => {
      expect(evaluateCondition({ fieldId: 'x', operator: 'contains', value: '1' }, { x: 123 })).toBe(false)
    })
  })

  describe('evaluateCondition — not_contains', () => {
    it('string does not contain', () => {
      expect(evaluateCondition({ fieldId: 'name', operator: 'not_contains', value: 'xyz' }, { name: 'hello' })).toBe(true)
    })
    it('string contains — returns false', () => {
      expect(evaluateCondition({ fieldId: 'name', operator: 'not_contains', value: 'ell' }, { name: 'hello' })).toBe(false)
    })
  })

  describe('evaluateCondition — greater_than / less_than', () => {
    it('numeric greater_than', () => {
      expect(evaluateCondition({ fieldId: 'n', operator: 'greater_than', value: 5 }, { n: 10 })).toBe(true)
      expect(evaluateCondition({ fieldId: 'n', operator: 'greater_than', value: 5 }, { n: 3 })).toBe(false)
    })
    it('numeric less_than', () => {
      expect(evaluateCondition({ fieldId: 'n', operator: 'less_than', value: 5 }, { n: 3 })).toBe(true)
      expect(evaluateCondition({ fieldId: 'n', operator: 'less_than', value: 5 }, { n: 10 })).toBe(false)
    })
    it('string comparison greater_than', () => {
      expect(evaluateCondition({ fieldId: 's', operator: 'greater_than', value: 'a' }, { s: 'b' })).toBe(true)
    })
    it('returns false for incompatible types', () => {
      expect(evaluateCondition({ fieldId: 'n', operator: 'greater_than', value: 5 }, { n: 'abc' })).toBe(false)
    })
  })

  describe('evaluateCondition — is_empty / is_not_empty', () => {
    it('is_empty: null', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_empty' }, { f: null })).toBe(true)
    })
    it('is_empty: undefined (missing field)', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_empty' }, {})).toBe(true)
    })
    it('is_empty: empty string', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_empty' }, { f: '' })).toBe(true)
    })
    it('is_empty: non-empty value', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_empty' }, { f: 'x' })).toBe(false)
    })
    it('is_not_empty: with value', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_not_empty' }, { f: 'x' })).toBe(true)
    })
    it('is_not_empty: null', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'is_not_empty' }, { f: null })).toBe(false)
    })
  })

  describe('evaluateCondition — in / not_in', () => {
    it('in: value is in list', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'in', value: [1, 2, 3] }, { f: 2 })).toBe(true)
    })
    it('in: value not in list', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'in', value: [1, 2, 3] }, { f: 5 })).toBe(false)
    })
    it('in: non-array value returns false', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'in', value: 'not-array' }, { f: 1 })).toBe(false)
    })
    it('not_in: value not in list', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'not_in', value: [1, 2] }, { f: 3 })).toBe(true)
    })
    it('not_in: value in list', () => {
      expect(evaluateCondition({ fieldId: 'f', operator: 'not_in', value: [1, 2] }, { f: 1 })).toBe(false)
    })
  })

  describe('evaluateConditions — group logic', () => {
    it('AND: all pass', () => {
      const group: ConditionGroup = {
        logic: 'and',
        conditions: [
          { fieldId: 'a', operator: 'equals', value: 1 },
          { fieldId: 'b', operator: 'equals', value: 2 },
        ],
      }
      expect(evaluateConditions(group, { a: 1, b: 2 })).toBe(true)
    })
    it('AND: one fails', () => {
      const group: ConditionGroup = {
        logic: 'and',
        conditions: [
          { fieldId: 'a', operator: 'equals', value: 1 },
          { fieldId: 'b', operator: 'equals', value: 99 },
        ],
      }
      expect(evaluateConditions(group, { a: 1, b: 2 })).toBe(false)
    })
    it('OR: one passes', () => {
      const group: ConditionGroup = {
        logic: 'or',
        conditions: [
          { fieldId: 'a', operator: 'equals', value: 99 },
          { fieldId: 'b', operator: 'equals', value: 2 },
        ],
      }
      expect(evaluateConditions(group, { a: 1, b: 2 })).toBe(true)
    })
    it('OR: none pass', () => {
      const group: ConditionGroup = {
        logic: 'or',
        conditions: [
          { fieldId: 'a', operator: 'equals', value: 99 },
          { fieldId: 'b', operator: 'equals', value: 99 },
        ],
      }
      expect(evaluateConditions(group, { a: 1, b: 2 })).toBe(false)
    })
    it('empty conditions returns true', () => {
      expect(evaluateConditions({ logic: 'and', conditions: [] }, { a: 1 })).toBe(true)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Trigger Matching
// ═════════════════════════════════════════════════════════════════════════

describe('Trigger Matching', () => {
  it('matches record.created trigger', () => {
    const trigger: AutomationTrigger = { type: 'record.created', config: {} }
    expect(matchesTrigger(trigger, 'record.created', {})).toBe(true)
  })

  it('does not match different trigger type', () => {
    const trigger: AutomationTrigger = { type: 'record.created', config: {} }
    expect(matchesTrigger(trigger, 'record.updated', {})).toBe(false)
  })

  it('matches record.deleted trigger', () => {
    const trigger: AutomationTrigger = { type: 'record.deleted', config: {} }
    expect(matchesTrigger(trigger, 'record.deleted', {})).toBe(true)
  })

  it('field.value_changed fires only on record.updated', () => {
    const trigger: AutomationTrigger = { type: 'field.value_changed', config: { fieldId: 'status' } }
    expect(matchesTrigger(trigger, 'record.created', { data: { status: 'x' } })).toBe(false)
    expect(matchesTrigger(trigger, 'record.updated', { changes: { status: 'x' } })).toBe(true)
  })

  it('field.value_changed with condition=equals', () => {
    const trigger: AutomationTrigger = { type: 'field.value_changed', config: { fieldId: 'status', condition: 'equals', value: 'done' } }
    expect(matchesTrigger(trigger, 'record.updated', { changes: { status: 'done' } })).toBe(true)
    expect(matchesTrigger(trigger, 'record.updated', { changes: { status: 'active' } })).toBe(false)
  })

  it('field.value_changed with condition=changed_to', () => {
    const trigger: AutomationTrigger = { type: 'field.value_changed', config: { fieldId: 'priority', condition: 'changed_to', value: 'high' } }
    expect(matchesTrigger(trigger, 'record.updated', { changes: { priority: 'high' } })).toBe(true)
    expect(matchesTrigger(trigger, 'record.updated', { changes: { priority: 'low' } })).toBe(false)
  })

  it('field.value_changed requires fieldId', () => {
    const trigger: AutomationTrigger = { type: 'field.value_changed', config: {} }
    expect(matchesTrigger(trigger, 'record.updated', { changes: { status: 'x' } })).toBe(false)
  })

  it('field.value_changed: field not in changes', () => {
    const trigger: AutomationTrigger = { type: 'field.value_changed', config: { fieldId: 'status' } }
    expect(matchesTrigger(trigger, 'record.updated', { changes: { other: 'x' } })).toBe(false)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Action Execution (via AutomationExecutor)
// ═════════════════════════════════════════════════════════════════════════

describe('AutomationExecutor', () => {
  let deps: AutomationDeps
  let executor: AutomationExecutor

  beforeEach(() => {
    deps = createMockDeps()
    executor = new AutomationExecutor(deps)
  })

  afterEach(() => {
    delete process.env.APP_BASE_URL
    delete process.env.PUBLIC_APP_URL
    delete process.env.DINGTALK_APP_KEY
    delete process.env.DINGTALK_APP_SECRET
    delete process.env.DINGTALK_AGENT_ID
  })

  it('executes update_record action successfully', async () => {
    const rule = createMockRule({
      actions: [{ type: 'update_record', config: { fields: { status: 'done' } } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: { status: 'active' }, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].actionType).toBe('update_record')
    expect(result.steps[0].status).toBe('success')
    expect(deps.queryFn).toHaveBeenCalled()
  })

  it('fails update_record with no fields', async () => {
    const rule = createMockRule({
      actions: [{ type: 'update_record', config: { fields: {} } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('No fields')
  })

  it('executes create_record action successfully', async () => {
    const rule = createMockRule({
      actions: [{ type: 'create_record', config: { sheetId: 'sheet_2', data: { title: 'New' } } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps[0].actionType).toBe('create_record')
  })

  it('executes send_webhook action successfully', async () => {
    const rule = createMockRule({
      actions: [{ type: 'send_webhook', config: { url: 'https://example.com/hook' } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps[0].actionType).toBe('send_webhook')
    expect(deps.fetchFn).toHaveBeenCalled()
  })

  it('retries webhook on failure then succeeds', async () => {
    let callCount = 0
    deps.fetchFn = vi.fn(async () => {
      callCount++
      if (callCount < 3) return new Response('Error', { status: 500 })
      return new Response('OK', { status: 200 })
    }) as unknown as typeof fetch
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{ type: 'send_webhook', config: { url: 'https://example.com/hook' } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(callCount).toBe(3)
  })

  it('fails webhook after all retries exhausted', async () => {
    deps.fetchFn = vi.fn(async () => new Response('Error', { status: 500 })) as unknown as typeof fetch
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{ type: 'send_webhook', config: { url: 'https://example.com/hook' } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('Webhook failed after')
  })

  it('fails send_webhook with no URL', async () => {
    const rule = createMockRule({
      actions: [{ type: 'send_webhook', config: {} }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('URL is required')
  })

  it('executes send_notification action successfully', async () => {
    const emitSpy = vi.spyOn(deps.eventBus, 'emit')
    const rule = createMockRule({
      actions: [{ type: 'send_notification', config: { userIds: ['u1', 'u2'], message: 'Hello' } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({ userIds: ['u1', 'u2'] }))
  })

  it('executes send_dingtalk_group_message action successfully', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'view_form', sheet_id: 'sheet_1', config: { publicForm: { enabled: true, publicToken: 'public-token' } } }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'view_grid' }] })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'dt_1',
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
          publicFormViewId: 'view_form',
          internalViewId: 'view_grid',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(result.steps[0].actionType).toBe('send_dingtalk_group_message')
    expect(queryFn).toHaveBeenCalledTimes(4)
    expect(fetchFn).toHaveBeenCalledTimes(1)

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://oapi.dingtalk.com/robot/send?access_token=test')
    expect(init.signal).toBeTruthy()
    const payload = JSON.parse(init.body as string)
    expect(payload.markdown.title).toBe('Record Incident ready')
    expect(payload.markdown.text).toContain('Status: open')
    expect(payload.markdown.text).toContain('/multitable/public-form/sheet_1/view_form?publicToken=public-token')
    expect(payload.markdown.text).toContain('/multitable/sheet_1/view_grid?recordId=r1')
    expect((queryFn.mock.calls[3]?.[0] as string) ?? '').toContain('INSERT INTO dingtalk_group_deliveries')
  })

  it('executes send_dingtalk_group_message across multiple destinations', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true },
          { id: 'dt_2', name: 'Escalation Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test-2', secret: null, enabled: true },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationIds: ['dt_1', 'dt_2'],
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
        },
      }],
    })

    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      destinationIds: ['dt_1', 'dt_2'],
      destinationNames: ['Ops Group', 'Escalation Group'],
      sentCount: 2,
    }))
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[0]?.[0] ?? '')).toContain('access_token=test')
    expect(String(fetchFn.mock.calls[1]?.[0] ?? '')).toContain('access_token=test-2')
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_group_deliveries'))
    expect(insertCalls).toHaveLength(2)
  })

  it('records DingTalk application error diagnostics for send_dingtalk_group_message', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 310000, errmsg: 'signature mismatch' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'dt_1',
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('signature mismatch')
    const insertArgs = queryFn.mock.calls[1]?.[1] as unknown[] | undefined
    expect(insertArgs?.[6]).toBe(200)
    expect(insertArgs?.[7]).toContain('signature mismatch')
    expect(insertArgs?.[8]).toContain('signature mismatch')
  })

  it('keeps send_dingtalk_group_message successful when delivery history persistence fails', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'view_form', sheet_id: 'sheet_1', config: { publicForm: { enabled: true, publicToken: 'public-token' } } }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'view_grid' }] })
      .mockRejectedValueOnce(new Error('delivery history unavailable'))
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'dt_1',
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
          publicFormViewId: 'view_form',
          internalViewId: 'view_grid',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(queryFn).toHaveBeenCalledTimes(4)
  })

  it('fails send_dingtalk_group_message when destination is missing', async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }))
    deps = createMockDeps({ queryFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'dt_missing',
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })

    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('destinations not found')
    expect(result.steps[0].error).toContain('dt_missing')
  })

  it('executes send_dingtalk_person_message action successfully', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'
    process.env.APP_BASE_URL = 'https://app.example.com'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'view_form', sheet_id: 'sheet_1', config: { publicForm: { enabled: true, publicToken: 'public-token' } } }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'view_grid' }] })
      .mockResolvedValueOnce({
        rows: [
          { local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' },
          { local_user_id: 'user_2', local_user_active: true, dingtalk_user_id: 'dt-user-2' },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1', 'user_2'],
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
          publicFormViewId: 'view_form',
          internalViewId: 'view_grid',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(result.steps[0].actionType).toBe('send_dingtalk_person_message')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [, sendInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    const payload = JSON.parse(sendInit.body as string)
    expect(payload.userid_list).toBe('dt-user-1,dt-user-2')
    expect(payload.msg.markdown.text).toContain('/multitable/public-form/sheet_1/view_form?publicToken=public-token')
    expect(payload.msg.markdown.text).toContain('/multitable/sheet_1/view_grid?recordId=r1')
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(insertCalls).toHaveLength(2)
  })

  it('executes send_dingtalk_person_message for member group recipients', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'group_1' }],
      })
      .mockResolvedValueOnce({
        rows: [
          { local_user_id: 'user_1' },
          { local_user_id: 'user_2' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' },
          { local_user_id: 'user_2', local_user_active: true, dingtalk_user_id: 'dt-user-2' },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          memberGroupIds: ['group_1'],
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident', status: 'open' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [, sendInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    const payload = JSON.parse(sendInit.body as string)
    expect(payload.userid_list).toBe('dt-user-1,dt-user-2')
    expect(result.steps[0].output).toMatchObject({
      notifiedUsers: 2,
      staticRecipientCount: 0,
      memberGroupRecipientCount: 2,
      dynamicRecipientCount: 0,
      memberGroupIds: ['group_1'],
    })
  })

  it('fails send_dingtalk_person_message when a user has no linked DingTalk account', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' }],
      })
      .mockResolvedValue({ rows: [] })
    deps = createMockDeps({ queryFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1', 'user_2'],
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1', actorId: 'user_1' })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('user_2')
    const insertCall = queryFn.mock.calls.find((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(insertCall?.[1]?.[1]).toBe('user_2')
  })

  it('executes send_dingtalk_person_message with dynamic record recipients', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' },
          { local_user_id: 'user_2', local_user_active: true, dingtalk_user_id: 'dt-user-2' },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIdFieldPath: 'record.assigneeUserIds',
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: {
        title: 'Incident',
        status: 'open',
        assigneeUserIds: ['user_1', { id: 'user_2' }, 'user_1'],
      },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const [, sendInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    const payload = JSON.parse(sendInit.body as string)
    expect(payload.userid_list).toBe('dt-user-1,dt-user-2')
    expect(result.steps[0].output).toMatchObject({
      notifiedUsers: 2,
      staticRecipientCount: 0,
      dynamicRecipientCount: 2,
      recipientFieldPath: 'assigneeUserIds',
    })
  })

  it('fails send_dingtalk_person_message when dynamic record path resolves no recipients', async () => {
    deps = createMockDeps()
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIdFieldPath: 'record.assigneeUserIds',
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { assigneeUserIds: [] },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('record field paths: assigneeUserIds')
  })

  it('merges multiple dynamic DingTalk person recipient fields from the record', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' },
          { local_user_id: 'user_2', local_user_active: true, dingtalk_user_id: 'dt-user-2' },
        ],
      })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'app-access-token' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 778899 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIdFieldPaths: ['record.assigneeUserIds', 'record.reviewerUserId'],
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: {
        title: 'Incident',
        status: 'open',
        assigneeUserIds: ['user_1'],
        reviewerUserId: 'user_2',
      },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(result.steps[0].output).toMatchObject({
      notifiedUsers: 2,
      staticRecipientCount: 0,
      dynamicRecipientCount: 2,
      recipientFieldPath: 'assigneeUserIds',
      recipientFieldPaths: ['assigneeUserIds', 'reviewerUserId'],
    })
  })

  it('fails send_notification with no userIds', async () => {
    const rule = createMockRule({
      actions: [{ type: 'send_notification', config: { message: 'Hi' } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('No user IDs')
  })

  it('fails send_notification with no message', async () => {
    const rule = createMockRule({
      actions: [{ type: 'send_notification', config: { userIds: ['u1'] } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('message is required')
  })

  it('executes lock_record action', async () => {
    const rule = createMockRule({
      actions: [{ type: 'lock_record', config: { locked: true } }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps[0].actionType).toBe('lock_record')
  })

  // ── Multi-step chains ─────────────────────────────────────────────────

  it('executes 2-step chain in order', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'update_record', config: { fields: { status: 'done' } } },
        { type: 'send_notification', config: { userIds: ['u1'], message: 'Updated' } },
      ],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].actionType).toBe('update_record')
    expect(result.steps[1].actionType).toBe('send_notification')
  })

  it('executes 3-step chain in order', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'update_record', config: { fields: { status: 'done' } } },
        { type: 'create_record', config: { data: { ref: 'r1' } } },
        { type: 'send_notification', config: { userIds: ['u1'], message: 'Done' } },
      ],
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
    expect(result.steps).toHaveLength(3)
  })

  it('failure at step 1 skips remaining steps', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'update_record', config: { fields: {} } }, // will fail
        { type: 'send_notification', config: { userIds: ['u1'], message: 'X' } },
      ],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[1].status).toBe('skipped')
  })

  it('failure at step 2 stops chain', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'update_record', config: { fields: { x: 1 } } },
        { type: 'send_notification', config: { message: 'no users' } }, // will fail
        { type: 'lock_record', config: { locked: true } },
      ],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })
    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('success')
    expect(result.steps[1].status).toBe('failed')
    expect(result.steps[2].status).toBe('skipped')
  })

  // ── Conditions ────────────────────────────────────────────────────────

  it('skips execution when conditions fail', async () => {
    const rule = createMockRule({
      conditions: {
        logic: 'and',
        conditions: [{ fieldId: 'status', operator: 'equals', value: 'active' }],
      },
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: { status: 'closed' }, sheetId: 'sheet_1' })
    expect(result.status).toBe('skipped')
    expect(result.steps).toHaveLength(0)
  })

  it('executes when conditions pass', async () => {
    const rule = createMockRule({
      conditions: {
        logic: 'and',
        conditions: [{ fieldId: 'status', operator: 'equals', value: 'active' }],
      },
    })
    const result = await executor.execute(rule, { recordId: 'r1', data: { status: 'active' }, sheetId: 'sheet_1' })
    expect(result.status).toBe('success')
  })

  it('records execution duration', async () => {
    const rule = createMockRule()
    const result = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(typeof result.duration).toBe('number')
    expect(result.duration).toBeGreaterThanOrEqual(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Scheduler
// ═════════════════════════════════════════════════════════════════════════

describe('AutomationScheduler', () => {
  let scheduler: AutomationScheduler
  let callback: ReturnType<typeof vi.fn>

  beforeEach(() => {
    callback = vi.fn()
    scheduler = new AutomationScheduler(callback)
  })

  afterEach(() => {
    scheduler.destroy()
  })

  it('registers an interval rule', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } },
    })
    scheduler.register(rule)
    expect(scheduler.isRegistered('rule_1')).toBe(true)
    expect(scheduler.activeCount).toBe(1)
  })

  it('unregisters a rule', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } },
    })
    scheduler.register(rule)
    scheduler.unregister('rule_1')
    expect(scheduler.isRegistered('rule_1')).toBe(false)
    expect(scheduler.activeCount).toBe(0)
  })

  it('replaces existing registration on re-register', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } },
    })
    scheduler.register(rule)
    scheduler.register(rule)
    expect(scheduler.activeCount).toBe(1)
  })

  it('ignores non-schedule triggers', () => {
    const rule = createMockRule({ trigger: { type: 'record.created', config: {} } })
    scheduler.register(rule)
    expect(scheduler.activeCount).toBe(0)
  })

  it('rejects interval < 1000ms', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.interval', config: { intervalMs: 500 } },
    })
    scheduler.register(rule)
    expect(scheduler.isRegistered('rule_1')).toBe(false)
  })

  it('registers cron expression', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.cron', config: { expression: '*/5 * * * *' } },
    })
    scheduler.register(rule)
    expect(scheduler.isRegistered('rule_1')).toBe(true)
  })

  it('rejects unsupported cron expression', () => {
    const rule = createMockRule({
      trigger: { type: 'schedule.cron', config: { expression: '0 12 1 */2 *' } },
    })
    scheduler.register(rule)
    expect(scheduler.isRegistered('rule_1')).toBe(false)
  })

  it('destroy clears all timers', () => {
    scheduler.register(createMockRule({ id: 'a', trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } } }))
    scheduler.register(createMockRule({ id: 'b', trigger: { type: 'schedule.interval', config: { intervalMs: 60000 } } }))
    expect(scheduler.activeCount).toBe(2)
    scheduler.destroy()
    expect(scheduler.activeCount).toBe(0)
  })
})

describe('parseCronToIntervalMs', () => {
  it('*/5 * * * * => 5 minutes', () => {
    expect(parseCronToIntervalMs('*/5 * * * *')).toBe(5 * 60 * 1000)
  })
  it('*/1 * * * * => 1 minute', () => {
    expect(parseCronToIntervalMs('*/1 * * * *')).toBe(60 * 1000)
  })
  it('0 * * * * => 1 hour', () => {
    expect(parseCronToIntervalMs('0 * * * *')).toBe(60 * 60 * 1000)
  })
  it('0 0 * * * => 1 day', () => {
    expect(parseCronToIntervalMs('0 0 * * *')).toBe(24 * 60 * 60 * 1000)
  })
  it('0 0 * * 1 => 1 week', () => {
    expect(parseCronToIntervalMs('0 0 * * 1')).toBe(7 * 24 * 60 * 60 * 1000)
  })
  it('invalid expression returns null', () => {
    expect(parseCronToIntervalMs('invalid')).toBe(null)
  })
  it('too few parts returns null', () => {
    expect(parseCronToIntervalMs('* * *')).toBe(null)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Execution Log Service (Kysely-backed)
// ═════════════════════════════════════════════════════════════════════════

describe('AutomationLogService', () => {
  let logService: AutomationLogService

  beforeEach(() => {
    _executeResults.length = 0
    _executeTakeFirstResults.length = 0
    logService = new AutomationLogService()
  })

  it('record() inserts an execution into the database', async () => {
    const exec = createExecution({ ruleId: 'r1' })
    // The insert chain needs an execute result
    _executeResults.push([])
    await logService.record(exec)
    // If it didn't throw, the insert was called
  })

  it('getByRule() returns mapped executions', async () => {
    const row = {
      id: 'axe_1',
      rule_id: 'r1',
      triggered_by: 'event',
      triggered_at: new Date('2026-01-01'),
      status: 'success',
      steps: [],
      error: null,
      duration: 10,
      created_at: new Date('2026-01-01'),
    }
    _executeResults.push([row])
    const results = await logService.getByRule('r1')
    expect(results).toHaveLength(1)
    expect(results[0].ruleId).toBe('r1')
    expect(results[0].status).toBe('success')
  })

  it('getRecent() returns mapped executions', async () => {
    const rows = [
      {
        id: 'axe_2', rule_id: 'r1', triggered_by: 'event',
        triggered_at: new Date(), status: 'success', steps: [],
        error: null, duration: 5, created_at: new Date(),
      },
    ]
    _executeResults.push(rows)
    const results = await logService.getRecent(10)
    expect(results).toHaveLength(1)
  })

  it('getById() returns a single execution', async () => {
    const row = {
      id: 'axe_3', rule_id: 'r1', triggered_by: 'event',
      triggered_at: new Date(), status: 'failed', steps: '[]',
      error: 'boom', duration: 2, created_at: new Date(),
    }
    _executeTakeFirstResults.push(row)
    const result = await logService.getById('axe_3')
    expect(result).toBeDefined()
    expect(result!.id).toBe('axe_3')
    expect(result!.status).toBe('failed')
    expect(result!.error).toBe('boom')
  })

  it('getById() returns undefined for missing execution', async () => {
    _executeTakeFirstResults.push(undefined)
    const result = await logService.getById('nonexistent')
    expect(result).toBeUndefined()
  })

  it('getStats() returns aggregate stats', async () => {
    _executeTakeFirstResults.push({
      total: 4,
      success: 2,
      failed: 1,
      skipped: 1,
      avg_duration: 9,
    })
    const stats = await logService.getStats('r1')
    expect(stats.total).toBe(4)
    expect(stats.success).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(stats.avgDuration).toBe(9)
  })

  it('getStats() returns zeros for unknown rule', async () => {
    _executeTakeFirstResults.push(undefined)
    const stats = await logService.getStats('nonexistent')
    expect(stats.total).toBe(0)
    expect(stats.avgDuration).toBe(0)
  })

  it('cleanup() deletes old rows', async () => {
    _executeTakeFirstResults.push({ numDeletedRows: BigInt(5) })
    const count = await logService.cleanup(30)
    expect(count).toBe(5)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// AutomationService — Kysely-backed rule CRUD
// ═════════════════════════════════════════════════════════════════════════

describe('AutomationService — Rule CRUD', () => {
  let service: AutomationService
  let eventBus: EventBus
  let queryFn: ReturnType<typeof vi.fn>

  // Build a Kysely mock that returns controllable results
  let dbExecuteResults: unknown[]
  let dbExecuteTakeFirstResults: unknown[]

  function makeMockDb() {
    dbExecuteResults = []
    dbExecuteTakeFirstResults = []

    const chain: Record<string, unknown> = {}
    const chainFn = (..._args: unknown[]) => chain
    const methods = [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy',
      'limit', 'offset', 'groupBy', 'insertInto', 'values',
      'onConflict', 'columns', 'doUpdateSet',
      'updateTable', 'set', 'deleteFrom', 'returningAll',
      'leftJoin',
    ]
    for (const m of methods) {
      chain[m] = vi.fn(chainFn)
    }
    chain.execute = vi.fn(async () => {
      return dbExecuteResults.shift() ?? []
    })
    chain.executeTakeFirst = vi.fn(async () => {
      return dbExecuteTakeFirstResults.shift()
    })
    return chain
  }

  beforeEach(() => {
    eventBus = new EventBus()
    queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const db = makeMockDb()
    service = new AutomationService(eventBus, db as never, queryFn)
  })

  it('createRule inserts a rule and returns it', async () => {
    dbExecuteResults.push([]) // for insertInto().execute()
    const rule = await service.createRule('sheet_1', {
      name: 'My Rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'update_record',
      actionConfig: { fields: { status: 'done' } },
      createdBy: 'user_1',
    })

    expect(rule.id).toMatch(/^atr_/)
    expect(rule.sheet_id).toBe('sheet_1')
    expect(rule.name).toBe('My Rule')
    expect(rule.trigger_type).toBe('record.created')
    expect(rule.enabled).toBe(true)
  })

  it('getRule returns a rule when found', async () => {
    const mockRow = {
      id: 'atr_123',
      sheet_id: 'sheet_1',
      name: 'Test',
      trigger_type: 'record.created',
      trigger_config: {},
      action_type: 'update_record',
      action_config: { fields: { x: 1 } },
      enabled: true,
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01'),
      created_by: 'user_1',
      conditions: null,
      actions: null,
    }
    dbExecuteTakeFirstResults.push(mockRow)
    const rule = await service.getRule('atr_123')
    expect(rule).not.toBeNull()
    expect(rule!.id).toBe('atr_123')
    expect(rule!.trigger_type).toBe('record.created')
  })

  it('getRule returns null when not found', async () => {
    dbExecuteTakeFirstResults.push(undefined)
    const rule = await service.getRule('nonexistent')
    expect(rule).toBeNull()
  })

  it('listRules returns rules for a sheet', async () => {
    dbExecuteResults.push([
      {
        id: 'atr_1', sheet_id: 'sheet_1', name: 'R1',
        trigger_type: 'record.created', trigger_config: {},
        action_type: 'update_record', action_config: {},
        enabled: true, created_at: new Date(), updated_at: new Date(),
        created_by: 'u1', conditions: null, actions: null,
      },
      {
        id: 'atr_2', sheet_id: 'sheet_1', name: 'R2',
        trigger_type: 'record.updated', trigger_config: {},
        action_type: 'send_notification', action_config: {},
        enabled: false, created_at: new Date(), updated_at: new Date(),
        created_by: 'u1', conditions: null, actions: null,
      },
    ])
    const rules = await service.listRules('sheet_1')
    expect(rules).toHaveLength(2)
    expect(rules[0].id).toBe('atr_1')
    expect(rules[1].id).toBe('atr_2')
  })

  it('updateRule returns updated rule', async () => {
    const updatedRow = {
      id: 'atr_1', sheet_id: 'sheet_1', name: 'Updated',
      trigger_type: 'record.created', trigger_config: {},
      action_type: 'update_record', action_config: {},
      enabled: true, created_at: new Date(), updated_at: new Date(),
      created_by: 'u1', conditions: null, actions: null,
    }
    dbExecuteResults.push([updatedRow])
    const rule = await service.updateRule('atr_1', 'sheet_1', { name: 'Updated' })
    expect(rule).not.toBeNull()
    expect(rule!.name).toBe('Updated')
  })

  it('updateRule returns null when rule not found', async () => {
    dbExecuteResults.push([]) // empty RETURNING
    const rule = await service.updateRule('nonexistent', 'sheet_1', { name: 'X' })
    expect(rule).toBeNull()
  })

  it('deleteRule returns true when deleted', async () => {
    dbExecuteResults.push([{ numDeletedRows: BigInt(1) }])
    const deleted = await service.deleteRule('atr_1', 'sheet_1')
    expect(deleted).toBe(true)
  })

  it('deleteRule returns false when not found', async () => {
    dbExecuteResults.push([{ numDeletedRows: BigInt(0) }])
    const deleted = await service.deleteRule('nonexistent', 'sheet_1')
    expect(deleted).toBe(false)
  })

  it('setRuleEnabled enables a rule', async () => {
    const updatedRow = {
      id: 'atr_1', sheet_id: 'sheet_1', name: 'Rule',
      trigger_type: 'schedule.cron', trigger_config: { expression: '*/5 * * * *' },
      action_type: 'update_record', action_config: {},
      enabled: true, created_at: new Date(), updated_at: new Date(),
      created_by: 'u1', conditions: null, actions: null,
    }
    dbExecuteResults.push([updatedRow])
    const rule = await service.setRuleEnabled('atr_1', true)
    expect(rule).not.toBeNull()
    expect(rule!.enabled).toBe(true)
  })

  it('setRuleEnabled returns null when rule not found', async () => {
    dbExecuteResults.push([])
    const rule = await service.setRuleEnabled('nonexistent', false)
    expect(rule).toBeNull()
  })

  it('loadEnabledRules returns only enabled rules via Kysely', async () => {
    dbExecuteResults.push([
      {
        id: 'atr_1', sheet_id: 'sheet_1', name: 'Active',
        trigger_type: 'record.created', trigger_config: {},
        action_type: 'update_record', action_config: {},
        enabled: true, created_at: new Date(), updated_at: new Date(),
        created_by: 'u1', conditions: null, actions: null,
      },
    ])
    const rules = await service.loadEnabledRules('sheet_1')
    expect(rules).toHaveLength(1)
    expect(rules[0].enabled).toBe(true)
  })
})
