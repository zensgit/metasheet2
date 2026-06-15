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
const _valuesCalls: unknown[] = []
const _setCalls: unknown[] = [] // A6-1: captures updateTable().set(...) payloads (job onSettled)

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
    self[m] = m === 'values'
      ? vi.fn((value: unknown) => { _valuesCalls.push(value); return self })
      : m === 'set'
        ? vi.fn((value: unknown) => { _setCalls.push(value); return self })
        : vi.fn(chainFn)
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
import { AutomationRuleValidationError, AutomationService } from '../../src/multitable/automation-service'
import { AutomationJobService } from '../../src/multitable/automation-job-service'
import { normalizeWorkflowJob } from '../../src/multitable/workflow-job-contract'

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
    // NIT-1: a `meta_sheets` lookup must resolve an EXISTING sheet so the ②b cross-base write-gate can
    // resolve a base. Empty rows model a MISSING / soft-deleted sheet, which the gate now (correctly)
    // fail-closes on — that is NOT the same-base intent of these specs. Returning a UNIFORM base for
    // every sheet keeps trigger and target in the same base → no gate fires (do NOT vary the base, or a
    // `create_record { sheetId }` to a different sheet becomes cross-base-without-targetBaseId → rejected).
    queryFn: vi.fn(async (sql: unknown) => {
      if (typeof sql === 'string' && /FROM meta_sheets/i.test(sql)) {
        return { rows: [{ base_id: 'base_mock' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
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

  it('executes send_email action successfully through NotificationService email channel', async () => {
    const send = vi.fn(async () => ({ id: 'notif_1', status: 'sent' as const }))
    deps = createMockDeps({ notificationService: { send } })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_email',
        config: {
          recipients: ['ops@example.com', 'owner@example.com'],
          subjectTemplate: 'Record {{record.title}} changed',
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
    expect(result.steps[0].actionType).toBe('send_email')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email',
      subject: 'Record Incident changed',
      content: 'Status: open',
      recipients: [
        { id: 'ops@example.com', type: 'email' },
        { id: 'owner@example.com', type: 'email' },
      ],
      metadata: expect.objectContaining({
        actionType: 'send_email',
        ruleId: 'rule_1',
        sheetId: 'sheet_1',
        recordId: 'r1',
      }),
    }))
  })

  it('converts send_email transport failures into failed automation steps', async () => {
    const send = vi.fn(async () => ({
      id: 'notif_1',
      status: 'failed' as const,
      failedReason: 'SMTP email transport blocked: missing provider env',
    }))
    deps = createMockDeps({ notificationService: { send } })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_email',
        config: {
          recipients: ['ops@example.com'],
          subjectTemplate: 'Record {{record.title}} changed',
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
    expect(result.steps[0]).toEqual(expect.objectContaining({
      actionType: 'send_email',
      status: 'failed',
      error: 'SMTP email transport blocked: missing provider env',
    }))
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      status: 'failed',
      failedReason: 'SMTP email transport blocked: missing provider env',
    }))
  })

  it('fails send_email with no recipients', async () => {
    const send = vi.fn(async () => ({ id: 'notif_1', status: 'sent' as const }))
    deps = createMockDeps({ notificationService: { send } })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_email',
        config: {
          recipients: [],
          subjectTemplate: 'Subject',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('at least one recipient')
    expect(send).not.toHaveBeenCalled()
  })

  it('fails send_email with missing templates', async () => {
    const send = vi.fn(async () => ({ id: 'notif_1', status: 'sent' as const }))
    deps = createMockDeps({ notificationService: { send } })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_email',
        config: {
          recipients: ['ops@example.com'],
          subjectTemplate: '',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('subjectTemplate is required')
    expect(send).not.toHaveBeenCalled()
  })

  it('fails send_email when NotificationService is not configured', async () => {
    const rule = createMockRule({
      actions: [{
        type: 'send_email',
        config: {
          recipients: ['ops@example.com'],
          subjectTemplate: 'Subject',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1' })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('NotificationService is not configured')
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
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain('sheet_id = $2')
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain('created_by = $3')
    expect(queryFn.mock.calls[0]?.[1]).toEqual([['dt_1'], 'sheet_1', 'user_1'])
    expect(String(queryFn.mock.calls[1]?.[0] ?? '')).toContain("type = 'form'")

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://oapi.dingtalk.com/robot/send?access_token=test')
    expect(init.signal).toBeTruthy()
    const payload = JSON.parse(init.body as string)
    expect(payload.markdown.title).toBe('Record Incident ready')
    expect(payload.markdown.text).toContain('Status: open')
    expect(payload.markdown.text).toContain('/multitable/public-form/sheet_1/view_form?publicToken=public-token')
    expect(payload.markdown.text).toContain('表单访问：任何获得链接的人可填写')
    expect(payload.markdown.text).toContain('/multitable/sheet_1/view_grid?recordId=r1')
    expect(payload.markdown.text).toContain('处理权限：需登录系统并具备该表格/视图访问权限')
    expect((queryFn.mock.calls[3]?.[0] as string) ?? '').toContain('INSERT INTO dingtalk_group_deliveries')
  })

  it('fails send_dingtalk_group_message when the internal processing view is not in the sheet', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
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
          internalViewId: 'missing_view',
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
    expect(result.steps[0].error).toContain('Internal view not found')
    expect(String(queryFn.mock.calls[1]?.[0] ?? '')).toContain('sheet_id = $2')
    expect(queryFn.mock.calls[1]?.[1]).toEqual(['missing_view', 'sheet_1'])
    expect(fetchFn).not.toHaveBeenCalled()
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

  it('fails send_dingtalk_group_message for legacy invalid webhook without fetch', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Legacy Group', webhook_url: 'https://example.com/hook', secret: null, enabled: true }],
      })
      .mockResolvedValue({ rows: [] })
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
    expect(result.steps[0].error).toContain('DingTalk robot URL')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      sentCount: 0,
      failedDestinationIds: ['dt_1'],
    }))
    expect(fetchFn).not.toHaveBeenCalled()
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_group_deliveries'))
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.[1]?.[8]).toContain('DingTalk robot URL')
  })

  it('validates all DingTalk group webhooks before sending any destination', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 'dt_valid', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true },
          { id: 'dt_legacy', name: 'Legacy Group', webhook_url: 'https://example.com/hook', secret: null, enabled: true },
        ],
      })
      .mockResolvedValue({ rows: [] })
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
          destinationIds: ['dt_valid', 'dt_legacy'],
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
    expect(result.steps[0].error).toContain('1 of 2 DingTalk destinations failed validation')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      sentCount: 0,
      failedDestinationIds: ['dt_legacy'],
    }))
    expect(fetchFn).not.toHaveBeenCalled()
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_group_deliveries'))
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.[1]?.[1]).toBe('dt_legacy')
  })

  it('executes send_dingtalk_group_message with dynamic record destinations', async () => {
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
          destinationIdFieldPaths: ['record.opsDestinationId', 'record.escalationDestinationIds'],
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
        opsDestinationId: 'dt_1',
        escalationDestinationIds: ['dt_2', { destinationId: 'dt_1' }],
      },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('success')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      destinationIds: ['dt_1', 'dt_2'],
      destinationNames: ['Ops Group', 'Escalation Group'],
      staticDestinationCount: 0,
      dynamicDestinationCount: 2,
      destinationFieldPath: 'opsDestinationId',
      destinationFieldPaths: ['opsDestinationId', 'escalationDestinationIds'],
      sentCount: 2,
    }))
    expect(fetchFn).toHaveBeenCalledTimes(2)
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

  it('notifies the rule creator when send_dingtalk_group_message fails', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ local_user_id: 'user_1', dingtalk_user_id: 'dt-user-1' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 })
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 310000, errmsg: 'signature mismatch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
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
      actorId: 'user_2',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      failureAlert: expect.objectContaining({ status: 'success', notifiedUsers: 1 }),
    }))
    expect(fetchFn).toHaveBeenCalledTimes(3)
    const [, notificationInit] = fetchFn.mock.calls[2] as [string, RequestInit]
    const payload = JSON.parse(notificationInit.body as string)
    expect(payload.userid_list).toBe('dt-user-1')
    expect(payload.msg.markdown.text).toContain('MetaSheet DingTalk group delivery failed')
    expect(payload.msg.markdown.text).toContain('Rule: rule_1')
    expect(payload.msg.markdown.text).toContain('signature mismatch')

    const personInsertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(personInsertCalls).toHaveLength(1)
    const insertArgs = personInsertCalls[0]?.[1] as unknown[] | undefined
    expect(insertArgs?.[1]).toBe('user_1')
    expect(insertArgs?.[2]).toBe('dt-user-1')
    expect(insertArgs?.[6]).toBe(true)
    expect(insertArgs?.[7]).toBe('success')
  })

  it('audits a skipped rule-creator alert when the creator is not linked to DingTalk', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ local_user_id: 'user_1', dingtalk_user_id: null }] })
      .mockResolvedValue({ rows: [], rowCount: 1 })
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
      actorId: 'user_2',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      failureAlert: expect.objectContaining({ status: 'skipped', reason: 'rule_creator_not_linked' }),
    }))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const personInsertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(personInsertCalls).toHaveLength(1)
    const insertArgs = personInsertCalls[0]?.[1] as unknown[] | undefined
    expect(insertArgs?.[1]).toBe('user_1')
    expect(insertArgs?.[6]).toBe(false)
    expect(insertArgs?.[7]).toBe('skipped')
    expect(insertArgs?.[10]).toContain('not linked')
  })

  it('keeps send_dingtalk_group_message successful when delivery history persistence fails', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'view_form', sheet_id: 'sheet_1', config: { publicForm: { enabled: true, publicToken: 'public-token', accessMode: 'dingtalk' } } }],
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
    const [, sendInit] = fetchFn.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(sendInit.body as string)
    expect(payload.markdown.text).toContain('表单访问：钉钉登录 + 绑定本地用户')
    expect(payload.markdown.text).toContain('允许范围：所有已绑定钉钉的本地用户可填写')
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

  it('fails send_dingtalk_group_message when the selected public form share is expired', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'dt_1', name: 'Ops Group', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: null, enabled: true }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'view_form',
          sheet_id: 'sheet_1',
          config: { publicForm: { enabled: true, publicToken: 'public-token', expiresAt: '2000-01-01T00:00:00.000Z' } },
        }],
      })
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
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
          publicFormViewId: 'view_form',
        },
      }],
    })

    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('Selected public form view has expired')
    expect(String(queryFn.mock.calls[1]?.[0] ?? '')).toContain("type = 'form'")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('scopes send_dingtalk_group_message destinations to the current sheet and rule creator', async () => {
    const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM dingtalk_group_destinations')) {
        expect(sql).toContain('sheet_id = $2')
        expect(sql).toContain('org_id IS NULL AND created_by = $3')
        expect(sql).toContain('FROM user_orgs uo')
        expect(sql).toContain('uo.org_id = dg.org_id')
        expect(params).toEqual([['dt_other_sheet'], 'sheet_1', 'user_1'])
      }
      return { rows: [], rowCount: 0 }
    })
    deps = createMockDeps({ queryFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      createdBy: 'user_1',
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationId: 'dt_other_sheet',
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })

    const result = await executor.execute(rule, {
      recordId: 'r1',
      sheetId: 'sheet_1',
      actorId: 'user_2',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('DingTalk destinations not found')
    expect(result.steps[0].error).toContain('dt_other_sheet')
    expect(result.steps[0].output).toEqual(expect.objectContaining({
      failureAlert: expect.objectContaining({ status: 'skipped', reason: 'rule_creator_not_linked' }),
    }))
    expect(queryFn).toHaveBeenCalledTimes(3)
  })

  it('fails send_dingtalk_group_message when dynamic record path resolves no destinations', async () => {
    deps = createMockDeps()
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_group_message',
        config: {
          destinationIdFieldPath: 'record.opsDestinationId',
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })

    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { opsDestinationId: [] },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('record field paths: opsDestinationId')
  })

  it('executes send_dingtalk_person_message action successfully', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'
    process.env.APP_BASE_URL = 'https://app.example.com'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'view_form',
          sheet_id: 'sheet_1',
          config: {
            publicForm: {
              enabled: true,
              publicToken: 'public-token',
              accessMode: 'dingtalk_granted',
              allowedUserIds: ['user_1'],
              allowedMemberGroupIds: ['group_1'],
            },
          },
        }],
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
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain("type = 'form'")
    const [, sendInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    const payload = JSON.parse(sendInit.body as string)
    expect(payload.userid_list).toBe('dt-user-1,dt-user-2')
    expect(payload.msg.markdown.text).toContain('/multitable/public-form/sheet_1/view_form?publicToken=public-token')
    expect(payload.msg.markdown.text).toContain('表单访问：钉钉登录 + 本地授权')
    expect(payload.msg.markdown.text).toContain('允许范围：1 个本地用户、1 个本地成员组通过钉钉校验后可填写')
    expect(payload.msg.markdown.text).toContain('/multitable/sheet_1/view_grid?recordId=r1')
    expect(payload.msg.markdown.text).toContain('处理权限：需登录系统并具备该表格/视图访问权限')
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(insertCalls).toHaveLength(2)
  })

  it('fails send_dingtalk_person_message when the internal processing view is not in the sheet', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'
    process.env.APP_BASE_URL = 'https://app.example.com'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch

    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Record {{record.title}} ready',
          bodyTemplate: 'Status: {{record.status}}',
          internalViewId: 'missing_view',
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
    expect(result.steps[0].error).toContain('Internal view not found')
    expect(String(queryFn.mock.calls[0]?.[0] ?? '')).toContain('sheet_id = $2')
    expect(queryFn.mock.calls[0]?.[1]).toEqual(['missing_view', 'sheet_1'])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails send_dingtalk_person_message when the selected public form view is not a form view', async () => {
    process.env.APP_BASE_URL = 'https://app.example.com'
    const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("type = 'form'")
      expect(params).toEqual(['view_grid', 'sheet_1'])
      return { rows: [], rowCount: 0 }
    })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
          publicFormViewId: 'view_grid',
        },
      }],
    })

    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { title: 'Incident' },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('Public form view not found')
    expect(fetchFn).not.toHaveBeenCalled()
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

  it('executes send_dingtalk_person_message with dynamic member group recipients from the record', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'group_1' }, { id: 'group_2' }],
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
          memberGroupIdFieldPaths: ['record.escalationGroupId', 'record.watcherGroupIds'],
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
        escalationGroupId: 'group_1',
        watcherGroupIds: [{ id: 'group_2' }, { subjectId: 'group_1' }],
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
      memberGroupRecipientCount: 2,
      dynamicRecipientCount: 0,
      dynamicMemberGroupRecipientCount: 2,
      memberGroupIds: ['group_1', 'group_2'],
      memberGroupRecipientFieldPath: 'escalationGroupId',
      memberGroupRecipientFieldPaths: ['escalationGroupId', 'watcherGroupIds'],
    })
  })

  it('skips unlinked DingTalk person recipients while sending to linked users', async () => {
    process.env.DINGTALK_APP_KEY = 'dt-app-key'
    process.env.DINGTALK_APP_SECRET = 'dt-app-secret'
    process.env.DINGTALK_AGENT_ID = '123456789'

    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ local_user_id: 'user_1', local_user_active: true, dingtalk_user_id: 'dt-user-1' }],
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
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1', actorId: 'user_1' })

    expect(result.status).toBe('success')
    expect(result.steps[0].output).toMatchObject({
      notifiedUsers: 1,
      skippedRecipientCount: 1,
      skippedUserIds: ['user_2'],
    })
    const [, sendInit] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(sendInit.body as string).userid_list).toBe('dt-user-1')
    const insertCalls = queryFn.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]?.[1]?.[1]).toBe('user_2')
    expect(insertCalls[0]?.[1]?.[7]).toBe('skipped')
    expect(insertCalls[1]?.[1]?.[1]).toBe('user_1')
    expect(insertCalls[1]?.[1]?.[7]).toBe('success')
  })

  it('marks DingTalk person delivery as skipped when all recipients are unlinked', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] })
    const fetchFn = vi.fn(async () => new Response('unexpected', { status: 500 })) as unknown as typeof fetch
    deps = createMockDeps({ queryFn, fetchFn })
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          userIds: ['user_1'],
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, { recordId: 'r1', sheetId: 'sheet_1', actorId: 'user_1' })

    expect(result.status).toBe('skipped')
    expect(result.steps[0]).toMatchObject({
      actionType: 'send_dingtalk_person_message',
      status: 'skipped',
      error: 'DingTalk account not linked for users: user_1',
      output: {
        notifiedUsers: 0,
        skippedRecipientCount: 1,
        skippedUserIds: ['user_1'],
      },
    })
    expect(fetchFn).not.toHaveBeenCalled()
    const insertCall = queryFn.mock.calls.find((call) => String(call[0]).includes('INSERT INTO dingtalk_person_deliveries'))
    expect(insertCall?.[1]?.[1]).toBe('user_1')
    expect(insertCall?.[1]?.[6]).toBe(false)
    expect(insertCall?.[1]?.[7]).toBe('skipped')
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

  it('fails send_dingtalk_person_message when dynamic member group record path resolves no recipients', async () => {
    deps = createMockDeps()
    executor = new AutomationExecutor(deps)

    const rule = createMockRule({
      actions: [{
        type: 'send_dingtalk_person_message',
        config: {
          memberGroupIdFieldPath: 'record.watcherGroupIds',
          titleTemplate: 'Title',
          bodyTemplate: 'Body',
        },
      }],
    })
    const result = await executor.execute(rule, {
      recordId: 'r1',
      data: { watcherGroupIds: [] },
      sheetId: 'sheet_1',
      actorId: 'user_1',
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0].error).toContain('member group record field paths: watcherGroupIds')
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
    _valuesCalls.length = 0
    logService = new AutomationLogService()
  })

  it('record() inserts an execution into the database', async () => {
    const exec = createExecution({ ruleId: 'r1' })
    // The insert chain needs an execute result
    _executeResults.push([])
    await logService.record(exec)
    // If it didn't throw, the insert was called
  })

  it('record() casts step arrays through jsonb instead of passing a raw PostgreSQL array', async () => {
    const exec = createExecution({
      ruleId: 'r1',
      steps: [
        {
          actionType: 'send_email',
          status: 'success',
          output: {
            notificationId: 'notif_1',
            notificationStatus: 'sent',
            recipientCount: 2,
          },
          durationMs: 205,
        },
      ],
    })

    _executeResults.push([])
    await logService.record(exec)

    const inserted = _valuesCalls.at(-1) as Record<string, unknown>

    expect(inserted.steps).not.toBe(exec.steps)
    expect(typeof (inserted.steps as { toOperationNode?: unknown }).toOperationNode).toBe('function')
  })

  it('record() scrubs the execution-level error and persists snapshot fields', async () => {
    const exec = createExecution({
      ruleId: 'r1',
      error: 'send_webhook failed: Authorization Bearer leakme.tok.en123456',
      sheetId: 'sheet_9',
      finishedAt: '2026-05-27T10:00:00.000Z',
      schemaVersion: 1,
      triggerEvent: { recordId: 'rec1', data: { secret: 'access_token=SECRETXYZ' } },
      ruleSnapshot: { id: 'r1', name: 'n', actions: [] } as unknown as AutomationRule,
    })
    _executeResults.push([])
    await logService.record(exec)
    const inserted = _valuesCalls.at(-1) as Record<string, unknown>

    // error is a plain string channel — assert it is scrubbed at write directly.
    expect(inserted.error).toContain('Bearer <redacted>')
    expect(inserted.error).not.toContain('leakme.tok.en123456')
    // snapshot scalar fields persisted as-is.
    expect(inserted.sheet_id).toBe('sheet_9')
    expect(inserted.finished_at).toBe('2026-05-27T10:00:00.000Z')
    expect(inserted.schema_version).toBe(1)
    // object channels are wrapped as jsonb RawBuilders (redacted before wrapping).
    expect(typeof (inserted.trigger_event as { toOperationNode?: unknown }).toOperationNode).toBe('function')
    expect(typeof (inserted.rule_snapshot as { toOperationNode?: unknown }).toOperationNode).toBe('function')
  })

  it('record() defaults schema_version and nulls absent snapshot fields', async () => {
    const exec = createExecution({ ruleId: 'r1' })
    delete (exec as Partial<AutomationExecution>).schemaVersion
    _executeResults.push([])
    await logService.record(exec)
    const inserted = _valuesCalls.at(-1) as Record<string, unknown>

    expect(inserted.schema_version).toBe(1)
    expect(inserted.sheet_id).toBeNull()
    expect(inserted.trigger_event).toBeNull()
    expect(inserted.rule_snapshot).toBeNull()
    expect(inserted.finished_at).toBeNull()
  })

  it('getByRule() maps snapshot columns and stays null-safe for legacy rows', async () => {
    const row = {
      id: 'axe_2',
      rule_id: 'r1',
      triggered_by: 'event',
      triggered_at: new Date('2026-01-01'),
      status: 'success',
      steps: [],
      error: null,
      duration: 10,
      created_at: new Date('2026-01-01'),
      sheet_id: 'sheet_9',
      trigger_event: { recordId: 'rec1' },
      rule_snapshot: { id: 'r1' },
      finished_at: new Date('2026-01-01T01:00:00Z'),
      schema_version: 1,
    }
    _executeResults.push([row])
    const [mapped] = await logService.getByRule('r1')
    expect(mapped.sheetId).toBe('sheet_9')
    expect(mapped.triggerEvent).toEqual({ recordId: 'rec1' })
    expect(mapped.ruleSnapshot).toEqual({ id: 'r1' })
    expect(mapped.finishedAt).toBe('2026-01-01T01:00:00.000Z')
    expect(mapped.schemaVersion).toBe(1)
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

  function makeRuleRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'atr_1',
      sheet_id: 'sheet_1',
      name: 'Rule',
      trigger_type: 'record.created',
      trigger_config: {},
      action_type: 'update_record',
      action_config: {},
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
      created_by: 'u1',
      conditions: null,
      actions: null,
      ...overrides,
    }
  }

  function makePublicFormViewRow(id: string, publicForm: Record<string, unknown> = {}) {
    return {
      id,
      type: 'form',
      config: {
        publicForm: {
          enabled: true,
          publicToken: `pub_${id}`,
          ...publicForm,
        },
      },
    }
  }

  beforeEach(() => {
    eventBus = new EventBus()
    queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    _valuesCalls.length = 0
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

  it('A6-2: createRule accepts wait_for_callback with workflow_job_v1', async () => {
    dbExecuteResults.push([]) // for insertInto().execute()
    const rule = await service.createRule('sheet_1', {
      name: 'Wait rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'wait_for_callback',
      actionConfig: {},
      actions: [{ type: 'wait_for_callback', config: {} }],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    expect(rule.action_type).toBe('wait_for_callback')
    expect(rule.actions).toEqual([{ type: 'wait_for_callback', config: {} }])
    expect(rule.execution_mode).toBe('workflow_job_v1')
  })

  it('W6-1: createRule accepts start_approval only with workflow_job_v1', async () => {
    const action = {
      type: 'start_approval',
      config: {
        templateId: 'tpl_1',
        formDataMapping: { amount: '{{record.amount}}', reviewer: '{{record.reviewer}}' },
      },
    } as const

    dbExecuteResults.push([])
    const rule = await service.createRule('sheet_1', {
      name: 'Approval rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: action.config,
      actions: [action],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    expect(rule.action_type).toBe('start_approval')
    expect(rule.actions).toEqual([action])
    expect(rule.execution_mode).toBe('workflow_job_v1')

    const promise = service.createRule('sheet_1', {
      name: 'Approval rule legacy',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: action.config,
      actions: [action],
      createdBy: 'user_1',
    })
    await expect(promise).rejects.toThrow('condition_branch/start_approval/parallel_branch requires execution_mode workflow_job_v1')
  })

  it('W6-1: createRule rejects invalid start_approval config before persistence', async () => {
    const promise = service.createRule('sheet_1', {
      name: 'Broken approval rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: { templateId: '', formDataMapping: {} },
      actions: [{ type: 'start_approval', config: { templateId: '', formDataMapping: {} } }],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toThrow('actionConfig.templateId is required')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('A6-3-1: createRule accepts condition_branch only with workflow_job_v1', async () => {
    const action = {
      type: 'condition_branch',
      config: {
        branches: [{
          key: 'vip',
          conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
          actions: [{ type: 'update_record', config: { fields: { status: 'vip' } } }],
        }],
        defaultBranch: {
          key: 'fallback',
          actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'fallback' } }],
        },
      },
    } as const

    dbExecuteResults.push([])
    const rule = await service.createRule('sheet_1', {
      name: 'Branch rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: action.config,
      actions: [action],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    expect(rule.action_type).toBe('condition_branch')
    expect(rule.actions).toEqual([action])
    expect(rule.execution_mode).toBe('workflow_job_v1')

    const promise = service.createRule('sheet_1', {
      name: 'Branch rule legacy',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: action.config,
      actions: [action],
      createdBy: 'user_1',
    })
    await expect(promise).rejects.toThrow('requires execution_mode workflow_job_v1')
  })

  it('A6-3-3: createRule ACCEPTS branch-local wait_for_callback in a workflow_job_v1 rule', async () => {
    dbExecuteResults.push([]) // for insertInto().execute()
    const rule = await service.createRule('sheet_1', {
      name: 'Branch-local wait',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: {
        branches: [{
          key: 'needs_wait',
          conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
          actions: [{ type: 'wait_for_callback', config: {} }],
        }],
      },
      actions: [{
        type: 'condition_branch',
        config: {
          branches: [{
            key: 'needs_wait',
            conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
            actions: [{ type: 'wait_for_callback', config: {} }],
          }],
        },
      }],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    // A6-3-3: branch-local wait is no longer rejected; the rule persists.
    expect(rule).toBeTruthy()
  })

  it('A6-3-3: createRule still rejects branch-local start_approval (out of scope)', async () => {
    const promise = service.createRule('sheet_1', {
      name: 'Nested approval branch',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: {
        branches: [{
          key: 'needs_approval',
          conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
          actions: [{ type: 'start_approval', config: {} }],
        }],
      },
      actions: [{
        type: 'condition_branch',
        config: {
          branches: [{
            key: 'needs_approval',
            conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
            actions: [{ type: 'start_approval', config: {} }],
          }],
        },
      }],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toThrow('cannot contain start_approval until A6-3-3')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('A6-3-1: createRule rejects parallel_branch inside a condition_branch branch', async () => {
    const nestedParallel = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [{
          key: 'nested',
          actions: [{ type: 'update_record', config: { fields: { status: 'nested' } } }],
        }],
      },
    }
    const promise = service.createRule('sheet_1', {
      name: 'Nested parallel branch',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: {
        branches: [{
          key: 'needs_parallel',
          conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
          actions: [nestedParallel],
        }],
      },
      actions: [{
        type: 'condition_branch',
        config: {
          branches: [{
            key: 'needs_parallel',
            conditions: { logic: 'and', conditions: [{ fieldId: 'status', operator: 'equals', value: 'pending' }] },
            actions: [nestedParallel],
          }],
        },
      }],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toThrow('cannot contain parallel_branch until a later nested-DAG slice')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('A6-3-4: createRule accepts parallel_branch only with workflow_job_v1', async () => {
    const action = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          {
            key: 'ops',
            label: 'Ops',
            actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }],
          },
          {
            key: 'notify',
            actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ready' } }],
          },
        ],
      },
    } as const

    dbExecuteResults.push([])
    const rule = await service.createRule('sheet_1', {
      name: 'Parallel rule',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'parallel_branch',
      actionConfig: action.config,
      actions: [action],
      executionMode: 'workflow_job_v1',
      createdBy: 'user_1',
    })

    expect(rule.action_type).toBe('parallel_branch')
    expect(rule.actions).toEqual([action])
    expect(rule.execution_mode).toBe('workflow_job_v1')

    const promise = service.createRule('sheet_1', {
      name: 'Parallel rule legacy',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'parallel_branch',
      actionConfig: action.config,
      actions: [action],
      createdBy: 'user_1',
    })
    await expect(promise).rejects.toThrow('requires execution_mode workflow_job_v1')
  })

  it('A6-3-4: createRule rejects unsupported actions inside parallel_branch branches', async () => {
    const unsupportedActions = [
      { type: 'wait_for_callback', config: {}, expected: 'cannot contain wait_for_callback in A6-3-4' },
      {
        type: 'parallel_branch',
        config: {
          joinMode: 'all',
          branches: [{
            key: 'nested',
            actions: [{ type: 'update_record', config: { fields: { status: 'nested' } } }],
          }],
        },
        expected: 'cannot contain parallel_branch in A6-3-4',
      },
    ]

    for (const unsupportedAction of unsupportedActions) {
      const promise = service.createRule('sheet_1', {
        name: 'Parallel bad branch',
        triggerType: 'record.created',
        triggerConfig: {},
        actionType: 'parallel_branch',
        actionConfig: {
          joinMode: 'all',
          branches: [{
            key: 'unsupported',
            actions: [{ type: unsupportedAction.type, config: unsupportedAction.config }],
          }],
        },
        actions: [{
          type: 'parallel_branch',
          config: {
            joinMode: 'all',
            branches: [{
              key: 'unsupported',
              actions: [{ type: unsupportedAction.type, config: unsupportedAction.config }],
            }],
          },
        }],
        executionMode: 'workflow_job_v1',
        createdBy: 'user_1',
      })

      await expect(promise).rejects.toThrow(unsupportedAction.expected)
    }
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('createRule normalizes legacy DingTalk title and content fields', async () => {
    dbExecuteResults.push([])
    const rule = await service.createRule('sheet_1', {
      name: 'DingTalk group',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_dingtalk_group_message',
      actionConfig: {
        destinationId: 'group_1',
        title: 'Please fill',
        content: 'Open form',
      },
      createdBy: 'user_1',
    })

    expect(rule.action_config).toMatchObject({
      destinationId: 'group_1',
      titleTemplate: 'Please fill',
      bodyTemplate: 'Open form',
    })
  })

  it('createRule rejects invalid DingTalk person configs before insert', async () => {
    const promise = service.createRule('sheet_1', {
      name: 'Bad DingTalk person',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_dingtalk_person_message',
      actionConfig: {
        userIds: [','],
        memberGroupIds: [],
        userIdFieldPath: 'record.',
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
      },
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('At least one local userId, memberGroupId, record recipient field path, or member group record field path is required')

    expect(dbExecuteResults).toHaveLength(0)
  })

  it('createRule rejects invalid V1 DingTalk actions before insert', async () => {
    const promise = service.createRule('sheet_1', {
      name: 'Bad DingTalk action',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'notify',
      actionConfig: {},
      actions: [
        {
          type: 'send_dingtalk_group_message',
          config: {
            destinationIds: [],
            destinationIdFieldPath: 'record.',
            titleTemplate: 'Please fill',
            bodyTemplate: 'Open form',
          },
        },
      ],
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('At least one DingTalk destination or record destination field path is required')

    expect(dbExecuteResults).toHaveLength(0)
  })

  it('createRule rejects invalid DingTalk public form links before insert', async () => {
    queryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const promise = service.createRule('sheet_1', {
      name: 'Bad DingTalk link',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_dingtalk_group_message',
      actionConfig: {
        destinationId: 'group_1',
        titleTemplate: 'Please fill',
        bodyTemplate: 'Open form',
        publicFormViewId: 'view_missing',
      },
      createdBy: 'user_1',
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('Public form view not found: view_missing')

    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('FROM meta_views'), ['sheet_1', ['view_missing']])
    expect(dbExecuteResults).toHaveLength(0)
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

  it('executeRule returns the execution even when log persistence fails', async () => {
    const logFailure = vi.spyOn(service.logs, 'record').mockRejectedValueOnce(new Error('jsonb insert failed'))

    const execution = await service.executeRule(
      createMockRule({ actions: [] }),
      { sheetId: 'sheet_1', recordId: 'rec_1', data: {}, _triggeredBy: 'test' },
    )

    expect(logFailure).toHaveBeenCalledOnce()
    expect(execution.status).toBe('success')
    expect(execution.steps).toEqual([])
  })

  it('executeRule records failed send_email transport executions', async () => {
    const send = vi.fn(async () => ({
      id: 'notif_1',
      status: 'failed' as const,
      failedReason: 'SMTP email transport blocked: missing provider env',
    }))
    service = new AutomationService(eventBus, makeMockDb() as never, queryFn, undefined, null, {}, { send })
    const logSpy = vi.spyOn(service.logs, 'record').mockResolvedValueOnce()

    const execution = await service.executeRule(
      createMockRule({
        actions: [{
          type: 'send_email',
          config: {
            recipients: ['ops@example.com'],
            subjectTemplate: 'Record {{record.title}} changed',
            bodyTemplate: 'Status: {{record.status}}',
          },
        }],
      }),
      {
        sheetId: 'sheet_1',
        recordId: 'rec_1',
        data: { title: 'Incident', status: 'open' },
        _triggeredBy: 'test',
      },
    )

    expect(execution.status).toBe('failed')
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      steps: [
        expect.objectContaining({
          actionType: 'send_email',
          status: 'failed',
          error: 'SMTP email transport blocked: missing provider env',
        }),
      ],
    }))
  })

  it('executeRule records successful send_email notification results', async () => {
    const send = vi.fn(async () => ({
      id: 'notif_success_1',
      status: 'sent' as const,
    }))
    service = new AutomationService(eventBus, makeMockDb() as never, queryFn, undefined, null, {}, { send })
    const logSpy = vi.spyOn(service.logs, 'record').mockResolvedValueOnce()

    const execution = await service.executeRule(
      createMockRule({
        actions: [{
          type: 'send_email',
          config: {
            recipients: ['ops@example.com', 'owner@example.com'],
            subjectTemplate: 'Record {{record.title}} changed',
            bodyTemplate: 'Status: {{record.status}}',
          },
        }],
      }),
      {
        sheetId: 'sheet_1',
        recordId: 'rec_1',
        data: { title: 'Incident', status: 'open' },
        _triggeredBy: 'test',
      },
    )

    expect(execution.status).toBe('success')
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      steps: [
        expect.objectContaining({
          actionType: 'send_email',
          status: 'success',
          output: expect.objectContaining({
            notificationId: 'notif_success_1',
            notificationStatus: 'sent',
            recipientCount: 2,
          }),
        }),
      ],
    }))
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
    const updatedRow = makeRuleRow({ name: 'Updated' })
    dbExecuteResults.push([updatedRow])
    const rule = await service.updateRule('atr_1', 'sheet_1', { name: 'Updated' })
    expect(rule).not.toBeNull()
    expect(rule!.name).toBe('Updated')
    expect(queryFn).not.toHaveBeenCalled()
  })

  it('A6-2: updateRule accepts wait_for_callback with workflow_job_v1', async () => {
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'update_record',
      action_config: { fields: { status: 'before' } },
      actions: [{ type: 'update_record', config: { fields: { status: 'before' } } }],
    }))
    dbExecuteResults.push([makeRuleRow({
      action_type: 'wait_for_callback',
      action_config: {},
      actions: [{ type: 'wait_for_callback', config: {} }],
      execution_mode: 'workflow_job_v1',
    })])

    const rule = await service.updateRule('atr_1', 'sheet_1', {
      actionType: 'wait_for_callback',
      actionConfig: {},
      actions: [{ type: 'wait_for_callback', config: {} }],
      executionMode: 'workflow_job_v1',
    })

    expect(rule?.action_type).toBe('wait_for_callback')
    expect(rule?.actions).toEqual([{ type: 'wait_for_callback', config: {} }])
    expect(rule?.execution_mode).toBe('workflow_job_v1')
  })

  it('W6-1: updateRule accepts start_approval with workflow_job_v1', async () => {
    const action = {
      type: 'start_approval',
      config: {
        templateId: 'tpl_1',
        formDataMapping: { amount: '{{record.amount}}' },
      },
    }
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'update_record',
      action_config: { fields: { status: 'before' } },
      actions: [{ type: 'update_record', config: { fields: { status: 'before' } } }],
    }))
    dbExecuteResults.push([makeRuleRow({
      action_type: 'start_approval',
      action_config: action.config,
      actions: [action],
      execution_mode: 'workflow_job_v1',
    })])

    const rule = await service.updateRule('atr_1', 'sheet_1', {
      actionType: 'start_approval',
      actionConfig: action.config,
      actions: [action],
      executionMode: 'workflow_job_v1',
    })

    expect(rule?.action_type).toBe('start_approval')
    expect(rule?.actions).toEqual([action])
    expect(rule?.execution_mode).toBe('workflow_job_v1')
  })

  it('W6-1: updateRule rejects turning a start_approval rule back to legacy', async () => {
    const action = {
      type: 'start_approval',
      config: {
        templateId: 'tpl_1',
        formDataMapping: { amount: '{{record.amount}}' },
      },
    }
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'start_approval',
      action_config: action.config,
      actions: [action],
      execution_mode: 'workflow_job_v1',
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', { executionMode: null })

    await expect(promise).rejects.toThrow('condition_branch/start_approval/parallel_branch requires execution_mode workflow_job_v1')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('A6-3-4: updateRule accepts parallel_branch with workflow_job_v1', async () => {
    const action = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          { key: 'ops', actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }] },
          { key: 'notify', actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ok' } }] },
        ],
      },
    }
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'update_record',
      action_config: { fields: { status: 'before' } },
      actions: [{ type: 'update_record', config: { fields: { status: 'before' } } }],
    }))
    dbExecuteResults.push([makeRuleRow({
      action_type: 'parallel_branch',
      action_config: action.config,
      actions: [action],
      execution_mode: 'workflow_job_v1',
    })])

    const rule = await service.updateRule('atr_1', 'sheet_1', {
      actionType: 'parallel_branch',
      actionConfig: action.config,
      actions: [action],
      executionMode: 'workflow_job_v1',
    })

    expect(rule?.action_type).toBe('parallel_branch')
    expect(rule?.actions).toEqual([action])
    expect(rule?.execution_mode).toBe('workflow_job_v1')
  })

  it('A6-3-4: updateRule rejects turning a parallel_branch rule back to legacy', async () => {
    const action = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          { key: 'ops', actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }] },
        ],
      },
    }
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'parallel_branch',
      action_config: action.config,
      actions: [action],
      execution_mode: 'workflow_job_v1',
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', { executionMode: null })

    await expect(promise).rejects.toThrow('requires execution_mode workflow_job_v1')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('A6-3-1: updateRule rejects turning a condition_branch rule back to legacy', async () => {
    const branchAction = {
      type: 'condition_branch',
      config: {
        branches: [{
          key: 'vip',
          conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
          actions: [{ type: 'update_record', config: { fields: { status: 'vip' } } }],
        }],
      },
    }
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'condition_branch',
      action_config: branchAction.config,
      actions: [branchAction],
      execution_mode: 'workflow_job_v1',
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', { executionMode: null })

    await expect(promise).rejects.toThrow('requires execution_mode workflow_job_v1')
    expect(dbExecuteResults).toHaveLength(0)
  })

  it('updateRule validates the merged state when only actionType changes to DingTalk', async () => {
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'notify',
      action_config: {},
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', {
      actionType: 'send_dingtalk_group_message',
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('At least one DingTalk destination or record destination field path is required')

    expect(dbExecuteResults).toHaveLength(0)
  })

  it('updateRule rejects merged invalid DingTalk configs before update', async () => {
    dbExecuteTakeFirstResults.push(makeRuleRow({
      name: 'DingTalk person',
      action_type: 'send_dingtalk_person_message',
      action_config: {
        userIds: ['user_1'],
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', {
      actionConfig: {
        userIds: [],
        memberGroupIds: [','],
        userIdFieldPath: 'record.',
        titleTemplate: 'New title',
        bodyTemplate: 'New body',
      },
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('At least one local userId, memberGroupId, record recipient field path, or member group record field path is required')

    expect(dbExecuteResults).toHaveLength(0)
  })

  it('updateRule rejects invalid V1 DingTalk actions before update', async () => {
    dbExecuteTakeFirstResults.push(makeRuleRow({
      action_type: 'notify',
      action_config: {},
      actions: [
        {
          type: 'update_record',
          config: { fields: { status: 'done' } },
        },
      ],
    }))

    const promise = service.updateRule('atr_1', 'sheet_1', {
      actions: [
        {
          type: 'send_dingtalk_person_message',
          config: {
            userIds: [],
            memberGroupIdFieldPaths: ['record.'],
            titleTemplate: 'Please fill',
            bodyTemplate: 'Open form',
          },
        },
      ],
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('At least one local userId, memberGroupId, record recipient field path, or member group record field path is required')

    expect(dbExecuteResults).toHaveLength(0)
  })

  it('updateRule rejects invalid merged DingTalk public form links before update', async () => {
    dbExecuteTakeFirstResults.push(makeRuleRow({
      name: 'DingTalk person',
      action_type: 'send_dingtalk_person_message',
      action_config: {
        userIds: ['user_1'],
        titleTemplate: 'Old title',
        bodyTemplate: 'Old body',
      },
    }))
    queryFn.mockResolvedValueOnce({
      rows: [
        makePublicFormViewRow('view_expired', {
          expiresAt: Date.now() - 1_000,
        }),
      ],
      rowCount: 1,
    })

    const promise = service.updateRule('atr_1', 'sheet_1', {
      actionConfig: {
        userIds: ['user_1'],
        titleTemplate: 'New title',
        bodyTemplate: 'New body',
        publicFormViewId: 'view_expired',
      },
    })

    await expect(promise).rejects.toBeInstanceOf(AutomationRuleValidationError)
    await expect(promise).rejects.toThrow('Selected public form view has expired: view_expired')

    expect(queryFn).toHaveBeenCalledWith(expect.stringContaining('FROM meta_views'), ['sheet_1', ['view_expired']])
    expect(dbExecuteResults).toHaveLength(0)
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

  it('A6-1: createRule writes execution_mode to the INSERT row + returned rule; rejects an invalid mode', async () => {
    // Self-contained capturing db so we can inspect the INSERT payload — the row whitelist at
    // createRule 384-396 that a returned-object assertion alone would not catch (wire-vs-fixture).
    const insertValues: Record<string, unknown>[] = []
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const m of [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy',
      'insertInto', 'onConflict', 'columns', 'doUpdateSet', 'updateTable', 'set', 'deleteFrom',
      'returningAll', 'leftJoin',
    ]) chain[m] = vi.fn(chainFn)
    chain.values = vi.fn((v: Record<string, unknown>) => { insertValues.push(v); return chain })
    chain.execute = vi.fn(async () => [])
    chain.executeTakeFirst = vi.fn(async () => undefined)
    const localService = new AutomationService(
      new EventBus(),
      chain as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })) as never,
    )

    const rule = await localService.createRule('sheet_1', {
      name: 'opt-in', triggerType: 'record.created', triggerConfig: {},
      actionType: 'update_record', actionConfig: { fields: { status: 'done' } }, createdBy: 'u1',
      executionMode: 'workflow_job_v1',
    })
    expect(insertValues.at(-1)?.execution_mode).toBe('workflow_job_v1') // INSERT-row whitelist guard
    expect(rule.execution_mode).toBe('workflow_job_v1')                 // returned-object whitelist guard

    await expect(localService.createRule('sheet_1', {
      name: 'bad', triggerType: 'record.created', triggerConfig: {},
      actionType: 'update_record', actionConfig: { fields: { status: 'done' } },
      executionMode: 'nope' as unknown as string,
    })).rejects.toThrow(AutomationRuleValidationError)
  })

  it('A6-1: updateRule writes execution_mode into the UPDATE set payload', async () => {
    const setPayloads: Record<string, unknown>[] = []
    const ruleRow = makeRuleRow({ execution_mode: 'workflow_job_v1' })
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const m of [
      'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy',
      'insertInto', 'values', 'onConflict', 'columns', 'doUpdateSet', 'updateTable', 'deleteFrom',
      'returningAll', 'leftJoin',
    ]) chain[m] = vi.fn(chainFn)
    chain.set = vi.fn((v: Record<string, unknown>) => { setPayloads.push(v); return chain })
    chain.execute = vi.fn(async () => [ruleRow])
    chain.executeTakeFirst = vi.fn(async () => ruleRow)
    const localService = new AutomationService(
      new EventBus(),
      chain as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })) as never,
    )

    const updated = await localService.updateRule('atr_1', 'sheet_1', { executionMode: 'workflow_job_v1' })
    expect(setPayloads.at(-1)?.execution_mode).toBe('workflow_job_v1') // UPDATE-set whitelist guard
    expect(updated?.execution_mode).toBe('workflow_job_v1')
  })
})

describe('AutomationService — retryExecution (A5)', () => {
  let service: AutomationService

  beforeEach(() => {
    const eventBus = new EventBus()
    const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    // Minimal kysely-ish stub; retryExecution collaborators are spied, so the db is unused.
    service = new AutomationService(eventBus, {} as never, queryFn)
  })

  function storedExecution(over: Partial<AutomationExecution> = {}): AutomationExecution {
    return {
      id: 'axe_orig',
      ruleId: 'atr_1',
      triggeredBy: 'event',
      triggeredAt: '2026-05-29T00:00:00.000Z',
      status: 'failed',
      steps: [],
      triggerEvent: { recordId: 'rec1', data: { name: 'Bolt' } },
      ...over,
    }
  }
  // Shape returned by service.getRule (DB-ish AutomationRule row).
  function currentRule(over: Record<string, unknown> = {}) {
    return {
      id: 'atr_1', sheet_id: 'sheet_1', name: 'R', trigger_type: 'record.created',
      trigger_config: {}, action_type: 'send_webhook', action_config: { url: 'https://x', token: 'LIVE-TOKEN' },
      enabled: true, actions: null, conditions: null,
      ...over,
    } as never
  }

  it('404 NOT_FOUND when the original execution is missing', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(undefined)
    const r = await service.retryExecution('axe_missing', 'admin1')
    expect(r).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })

  it('409 NOT_RETRYABLE for success/running originals', async () => {
    for (const status of ['success', 'running'] as const) {
      vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ status }))
      const r = await service.retryExecution('axe_orig', 'admin1')
      expect(r).toMatchObject({ status: 409, code: 'NOT_RETRYABLE' })
    }
  })

  it('409 MISSING_TRIGGER_EVENT fail-closed: absent / empty {} / array — never silent empty-context retry', async () => {
    const getRule = vi.spyOn(service, 'getRule')
    const execSpy = vi.spyOn(service, 'executeRule')
    for (const bad of [undefined, {}, [] as unknown, 'x' as unknown, 0 as unknown]) {
      vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ triggerEvent: bad }))
      const r = await service.retryExecution('axe_orig', 'admin1')
      expect(r).toMatchObject({ status: 409, code: 'MISSING_TRIGGER_EVENT' })
    }
    // fail-closed: never loaded the rule nor executed anything
    expect(getRule).not.toHaveBeenCalled()
    expect(execSpy).not.toHaveBeenCalled()
  })

  it('a record-less scheduler trigger ({_triggeredBy:"schedule"}) is still retryable (non-empty object)', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ status: 'failed', triggerEvent: { _triggeredBy: 'schedule' } }))
    vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(storedExecution({ id: 'axe_new', status: 'success' }))
    const r = await service.retryExecution('axe_orig', 'admin1')
    expect('execution' in r).toBe(true)
    expect(execSpy.mock.calls[0][1]).toEqual({ _triggeredBy: 'schedule' }) // passes the non-empty guard
  })

  it('409 RULE_MISSING_OR_DISABLED when current rule is gone or disabled', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution())
    const getRule = vi.spyOn(service, 'getRule').mockResolvedValue(null)
    expect(await service.retryExecution('axe_orig', 'admin1')).toMatchObject({ status: 409, code: 'RULE_MISSING_OR_DISABLED' })
    getRule.mockResolvedValue(currentRule({ enabled: false }))
    expect(await service.retryExecution('axe_orig', 'admin1')).toMatchObject({ status: 409, code: 'RULE_MISSING_OR_DISABLED' })
  })

  it('failed retry delegates to executeRule with stored trigger_event + retry provenance', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution())
    vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const newExec = storedExecution({ id: 'axe_new', status: 'success', rerunOfExecutionId: 'axe_orig', initiatedBy: 'admin1' })
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(newExec)
    const r = await service.retryExecution('axe_orig', 'admin1')
    expect(r).toEqual({ execution: newExec })
    const [, triggerEvent, retryMeta] = execSpy.mock.calls[0]
    expect(triggerEvent).toEqual({ recordId: 'rec1', data: { name: 'Bolt' } }) // original stored trigger event reused
    expect(retryMeta).toEqual({ rerunOfExecutionId: 'axe_orig', initiatedBy: 'admin1', rootExecutionId: 'axe_orig' })
  })

  it('D1 — retry uses the CURRENT rule (live token), never the redacted rule_snapshot', async () => {
    // stored snapshot carries a scrubbed token; the current rule carries the real one.
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({
      ruleSnapshot: { id: 'atr_1', actions: [{ type: 'send_webhook', config: { token: '<redacted>' } }] } as never,
    }))
    vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(storedExecution({ id: 'axe_new', status: 'success' }))
    await service.retryExecution('axe_orig', 'admin1')
    const execRule = execSpy.mock.calls[0][0] as { actions: { config: Record<string, unknown> }[] }
    expect(execRule.actions[0].config.token).toBe('LIVE-TOKEN') // from current rule
    expect(JSON.stringify(execRule)).not.toContain('<redacted>') // never the snapshot
  })

  it('redacted field inside the stored trigger_event replays deterministically (no crash)', async () => {
    // A1 may scrub a secret-shaped record field to <redacted>; retry passes it through unchanged.
    const redactedEvent = { recordId: 'rec1', data: { name: 'Bolt', token: '<redacted>' } }
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ triggerEvent: redactedEvent }))
    vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(storedExecution({ id: 'axe_new', status: 'success' }))
    const r = await service.retryExecution('axe_orig', 'admin1')
    expect('execution' in r).toBe(true)
    expect(execSpy.mock.calls[0][1]).toEqual(redactedEvent) // passed through verbatim
  })

  it('skipped originals are retryable (delegates with the current rule)', async () => {
    vi.spyOn(service.logs, 'getById').mockResolvedValue(storedExecution({ status: 'skipped' }))
    vi.spyOn(service, 'getRule').mockResolvedValue(currentRule())
    const execSpy = vi.spyOn(service, 'executeRule').mockResolvedValue(storedExecution({ id: 'axe_new', status: 'success' }))
    const r = await service.retryExecution('axe_orig', 'admin1')
    expect('execution' in r).toBe(true)
    expect(execSpy).toHaveBeenCalledTimes(1) // skipped → re-runs against the current rule (its conditions may now pass)
  })
})

describe('AutomationExecutor — A6-1 job lifecycle hooks', () => {
  let deps: AutomationDeps
  let executor: AutomationExecutor

  beforeEach(() => {
    deps = createMockDeps()
    executor = new AutomationExecutor(deps)
  })

  // A recording lifecycle; throwOn lets a test simulate a job-write failure at a phase.
  function recordingLifecycle(throwOn?: { phase: 'start' | 'settled'; index: number }) {
    const calls: string[] = []
    return {
      calls,
      factory: (_executionId: string) => ({
        onStart: async (i: number) => {
          calls.push(`start:${i}`)
          if (throwOn?.phase === 'start' && throwOn.index === i) throw new Error('job create failed')
        },
        onSettled: async (i: number, _a: unknown, r: { status: string }) => {
          calls.push(`settled:${i}:${r.status}`)
          if (throwOn?.phase === 'settled' && throwOn.index === i) throw new Error('job update failed')
        },
        onSkipped: async (i: number) => { calls.push(`skipped:${i}`) },
      }),
    }
  }

  it('fires onStart→onSettled per action in order for an opted-in (factory-supplied) run', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'send_webhook', config: { url: 'https://example.com/a' } },
        { type: 'send_webhook', config: { url: 'https://example.com/b' } },
      ],
    })
    const lc = recordingLifecycle()
    const execution = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' }, lc.factory)
    expect(execution.status).toBe('success')
    expect(lc.calls).toEqual(['start:0', 'settled:0:success', 'start:1', 'settled:1:success'])
  })

  it('fires onSkipped for the fail-stop remainder', async () => {
    const rule = createMockRule({
      actions: [
        { type: 'send_webhook', config: {} }, // missing url → fails
        { type: 'send_webhook', config: { url: 'https://example.com/b' } },
      ],
    })
    const lc = recordingLifecycle()
    const execution = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' }, lc.factory)
    expect(execution.status).toBe('failed')
    expect(lc.calls).toEqual(['start:0', 'settled:0:failed', 'skipped:1'])
  })

  it('FAIL-CLOSED (a): onStart throw → side effect NEVER runs + execution failed', async () => {
    const rule = createMockRule({ actions: [{ type: 'send_webhook', config: { url: 'https://example.com/a' } }] })
    const lc = recordingLifecycle({ phase: 'start', index: 0 })
    const execution = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' }, lc.factory)
    expect(execution.status).toBe('failed') // outer catch, not a swallowed step
    expect(deps.fetchFn).not.toHaveBeenCalled() // the webhook (side effect) never fired
    expect(execution.error).toContain('job create failed')
  })

  it('FAIL-CLOSED (b): onSettled throw AFTER the action → side effect ran once + execution failed', async () => {
    const rule = createMockRule({ actions: [{ type: 'send_webhook', config: { url: 'https://example.com/a' } }] })
    const lc = recordingLifecycle({ phase: 'settled', index: 0 })
    const execution = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' }, lc.factory)
    expect(execution.status).toBe('failed') // NOT pretended successful
    expect(deps.fetchFn).toHaveBeenCalledTimes(1) // the action DID run (must not pretend otherwise)
    expect(execution.steps[0]).toMatchObject({
      actionType: 'send_webhook',
      status: 'success',
      output: { httpStatus: 200 },
    })
    expect(execution.error).toContain('job update failed')
  })

  it('legacy run (no factory) fires no lifecycle and behaves exactly as today', async () => {
    const rule = createMockRule({ actions: [{ type: 'send_webhook', config: { url: 'https://example.com/a' } }] })
    const execution = await executor.execute(rule, { recordId: 'r1', data: {}, sheetId: 'sheet_1' })
    expect(execution.status).toBe('success')
    expect(execution.steps).toHaveLength(1) // legacy steps unchanged; no jobs involved
  })

  it('A6-3-1: condition_branch selects one branch and wires nested C1 job metadata', async () => {
    let executionId = ''
    const events: Array<{
      phase: string
      index: number
      type: string
      status?: string
      stepKey?: string
      jobId?: string
      upstreamJobId?: string | null
    }> = []
    const lifecycle = {
      factory: (id: string) => {
        executionId = id
        return {
          onStart: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'start', index, type: action.type, ...meta })
          },
          onSettled: async (index: number, action: { type: string }, result: { status: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'settled', index, type: action.type, status: result.status, ...meta })
          },
          onSkipped: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'skipped', index, type: action.type, ...meta })
          },
        }
      },
    }
    const rule = createMockRule({
      actions: [
        {
          type: 'condition_branch',
          config: {
            branches: [
              {
                key: 'vip',
                label: 'VIP',
                conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
                actions: [{ type: 'update_record', config: { fields: { status: 'vip' } } }],
              },
              {
                key: 'standard',
                conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'standard' }] },
                actions: [{ type: 'send_webhook', config: { url: 'https://example.com/standard' } }],
              },
            ],
          },
        },
        { type: 'send_webhook', config: { url: 'https://example.com/after' } },
      ],
    })

    const execution = await executor.execute(rule, {
      recordId: 'r1',
      data: { tier: 'vip' },
      sheetId: 'sheet_1',
    }, lifecycle.factory)

    expect(execution.status).toBe('success')
    expect(execution.steps).toHaveLength(2)
    expect(execution.steps[0]).toMatchObject({
      actionType: 'condition_branch',
      status: 'success',
      output: { selectedBranchKey: 'vip', selectedBranchLabel: 'VIP', matched: true },
    })
    expect(events).toEqual([
      { phase: 'start', index: 0, type: 'condition_branch' },
      {
        phase: 'start',
        index: 0,
        type: 'update_record',
        stepKey: '0.branch.vip.0',
        jobId: `${executionId}:job:0:branch:vip:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'settled',
        index: 0,
        type: 'update_record',
        status: 'success',
        stepKey: '0.branch.vip.0',
        jobId: `${executionId}:job:0:branch:vip:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      { phase: 'settled', index: 0, type: 'condition_branch', status: 'success' },
      {
        phase: 'start',
        index: 1,
        type: 'send_webhook',
        upstreamJobId: `${executionId}:job:0:branch:vip:0`,
      },
      { phase: 'settled', index: 1, type: 'send_webhook', status: 'success' },
    ])
    expect(deps.fetchFn).toHaveBeenCalledTimes(1) // non-selected branch webhook did not run; only the after action did.
  })

  it('A6-3-1: condition_branch fails closed in legacy mode and skips later actions', async () => {
    const rule = createMockRule({
      actions: [
        {
          type: 'condition_branch',
          config: {
            branches: [{
              key: 'vip',
              conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
              actions: [{ type: 'update_record', config: { fields: { status: 'vip' } } }],
            }],
          },
        },
        { type: 'send_webhook', config: { url: 'https://example.com/after' } },
      ],
    })

    const execution = await executor.execute(rule, { recordId: 'r1', data: { tier: 'vip' }, sheetId: 'sheet_1' })

    expect(execution.status).toBe('failed')
    expect(execution.steps).toEqual([
      {
        actionType: 'condition_branch',
        status: 'failed',
        error: 'condition_branch requires execution_mode workflow_job_v1',
        durationMs: 0,
      },
      { actionType: 'send_webhook', status: 'skipped', durationMs: 0 },
    ])
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('A6-3-4: parallel_branch runs all branches and upstreams the next top-level job from the parent join', async () => {
    let executionId = ''
    const events: Array<{
      phase: string
      index: number
      type: string
      status?: string
      stepKey?: string
      jobId?: string
      upstreamJobId?: string | null
    }> = []
    const lifecycle = {
      factory: (id: string) => {
        executionId = id
        return {
          onStart: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'start', index, type: action.type, ...meta })
          },
          onSettled: async (index: number, action: { type: string }, result: { status: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'settled', index, type: action.type, status: result.status, ...meta })
          },
          onSkipped: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'skipped', index, type: action.type, ...meta })
          },
        }
      },
    }
    const rule = createMockRule({
      actions: [
        {
          type: 'parallel_branch',
          config: {
            joinMode: 'all',
            branches: [
              {
                key: 'ops',
                label: 'Ops',
                actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }],
              },
              {
                key: 'notify',
                actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'done' } }],
              },
            ],
          },
        },
        { type: 'send_webhook', config: { url: 'https://example.com/after' } },
      ],
    })

    const execution = await executor.execute(rule, {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    }, lifecycle.factory)

    expect(execution.status).toBe('success')
    expect(execution.steps).toHaveLength(2)
    expect(execution.steps[0]).toMatchObject({
      actionType: 'parallel_branch',
      status: 'success',
      output: {
        joinMode: 'all',
        branchCount: 2,
        resolvedBranchKeys: ['ops', 'notify'],
        failedBranchKeys: [],
        branchStatuses: { ops: 'resolved', notify: 'resolved' },
      },
    })
    expect(events).toEqual([
      { phase: 'start', index: 0, type: 'parallel_branch' },
      {
        phase: 'start',
        index: 0,
        type: 'update_record',
        stepKey: '0.parallel.ops.0',
        jobId: `${executionId}:job:0:parallel:ops:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'settled',
        index: 0,
        type: 'update_record',
        status: 'success',
        stepKey: '0.parallel.ops.0',
        jobId: `${executionId}:job:0:parallel:ops:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'start',
        index: 0,
        type: 'send_notification',
        stepKey: '0.parallel.notify.0',
        jobId: `${executionId}:job:0:parallel:notify:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'settled',
        index: 0,
        type: 'send_notification',
        status: 'success',
        stepKey: '0.parallel.notify.0',
        jobId: `${executionId}:job:0:parallel:notify:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      { phase: 'settled', index: 0, type: 'parallel_branch', status: 'success' },
      {
        phase: 'start',
        index: 1,
        type: 'send_webhook',
        upstreamJobId: `${executionId}:job:0`,
      },
      { phase: 'settled', index: 1, type: 'send_webhook', status: 'success' },
    ])
    expect(deps.fetchFn).toHaveBeenCalledTimes(1) // only the after action uses fetch
  })

  it('A6-3-4: branch failure skips only that branch tail, still runs siblings, then fails parent and skips downstream', async () => {
    let executionId = ''
    const events: Array<{
      phase: string
      index: number
      type: string
      status?: string
      stepKey?: string
      jobId?: string
      upstreamJobId?: string | null
    }> = []
    const lifecycle = {
      factory: (id: string) => {
        executionId = id
        return {
          onStart: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'start', index, type: action.type, ...meta })
          },
          onSettled: async (index: number, action: { type: string }, result: { status: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'settled', index, type: action.type, status: result.status, ...meta })
          },
          onSkipped: async (index: number, action: { type: string }, meta?: { stepKey?: string; jobId?: string; upstreamJobId?: string | null }) => {
            events.push({ phase: 'skipped', index, type: action.type, ...meta })
          },
        }
      },
    }
    const rule = createMockRule({
      actions: [
        {
          type: 'parallel_branch',
          config: {
            joinMode: 'all',
            branches: [
              {
                key: 'bad',
                actions: [
                  { type: 'send_notification', config: { userIds: [], message: 'missing users' } },
                  { type: 'update_record', config: { fields: { should_not_run: true } } },
                ],
              },
              {
                key: 'good',
                actions: [{ type: 'update_record', config: { fields: { status: 'good' } } }],
              },
            ],
          },
        },
        { type: 'send_webhook', config: { url: 'https://example.com/after' } },
      ],
    })

    const execution = await executor.execute(rule, {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    }, lifecycle.factory)

    expect(execution.status).toBe('failed')
    expect(execution.steps).toEqual([
      expect.objectContaining({
        actionType: 'parallel_branch',
        status: 'failed',
        output: expect.objectContaining({
          resolvedBranchKeys: ['good'],
          failedBranchKeys: ['bad'],
          branchStatuses: { bad: 'failed', good: 'resolved' },
        }),
      }),
      { actionType: 'send_webhook', status: 'skipped', durationMs: 0 },
    ])
    expect(events).toEqual([
      { phase: 'start', index: 0, type: 'parallel_branch' },
      {
        phase: 'start',
        index: 0,
        type: 'send_notification',
        stepKey: '0.parallel.bad.0',
        jobId: `${executionId}:job:0:parallel:bad:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'settled',
        index: 0,
        type: 'send_notification',
        status: 'failed',
        stepKey: '0.parallel.bad.0',
        jobId: `${executionId}:job:0:parallel:bad:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'skipped',
        index: 0,
        type: 'update_record',
        stepKey: '0.parallel.bad.1',
        jobId: `${executionId}:job:0:parallel:bad:1`,
        upstreamJobId: `${executionId}:job:0:parallel:bad:0`,
      },
      {
        phase: 'start',
        index: 0,
        type: 'update_record',
        stepKey: '0.parallel.good.0',
        jobId: `${executionId}:job:0:parallel:good:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      {
        phase: 'settled',
        index: 0,
        type: 'update_record',
        status: 'success',
        stepKey: '0.parallel.good.0',
        jobId: `${executionId}:job:0:parallel:good:0`,
        upstreamJobId: `${executionId}:job:0`,
      },
      { phase: 'settled', index: 0, type: 'parallel_branch', status: 'failed' },
      { phase: 'skipped', index: 1, type: 'send_webhook' },
    ])
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('A6-3-4: parallel_branch runtime rejects unsupported persisted child actions before child jobs or side effects', async () => {
    const events: Array<{ phase: string; index: number; type: string; status?: string }> = []
    const lifecycle = {
      factory: () => ({
        onStart: async (index: number, action: { type: string }) => {
          events.push({ phase: 'start', index, type: action.type })
        },
        onSettled: async (index: number, action: { type: string }, result: { status: string }) => {
          events.push({ phase: 'settled', index, type: action.type, status: result.status })
        },
        onSkipped: async (index: number, action: { type: string }) => {
          events.push({ phase: 'skipped', index, type: action.type })
        },
      }),
    }
    const rule = createMockRule({
      actions: [
        {
          type: 'parallel_branch',
          config: {
            joinMode: 'all',
            branches: [{
              key: 'bad',
              actions: [{ type: 'send_webhook', config: { url: 'https://example.com/should-not-run' } }],
            }],
          },
        },
        { type: 'send_webhook', config: { url: 'https://example.com/after' } },
      ],
    })

    const execution = await executor.execute(rule, {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    }, lifecycle.factory)

    expect(execution.status).toBe('failed')
    expect(execution.steps).toEqual([
      expect.objectContaining({
        actionType: 'parallel_branch',
        status: 'failed',
        error: 'parallel_branch.branches[0].actions cannot contain send_webhook in A6-3-4',
      }),
      { actionType: 'send_webhook', status: 'skipped', durationMs: 0 },
    ])
    expect(events).toEqual([
      { phase: 'start', index: 0, type: 'parallel_branch' },
      { phase: 'settled', index: 0, type: 'parallel_branch', status: 'failed' },
      { phase: 'skipped', index: 1, type: 'send_webhook' },
    ])
    expect(deps.fetchFn).not.toHaveBeenCalled()
  })

  it('A6-3-4: parallel_branch runtime rejects persisted configs over branch/action bounds before child jobs', async () => {
    const events: Array<{ phase: string; index: number; type: string; status?: string }> = []
    const lifecycle = {
      factory: () => ({
        onStart: async (index: number, action: { type: string }) => {
          events.push({ phase: 'start', index, type: action.type })
        },
        onSettled: async (index: number, action: { type: string }, result: { status: string }) => {
          events.push({ phase: 'settled', index, type: action.type, status: result.status })
        },
        onSkipped: async (index: number, action: { type: string }) => {
          events.push({ phase: 'skipped', index, type: action.type })
        },
      }),
    }
    const branches = Array.from({ length: 11 }, (_unused, index) => ({
      key: `branch_${index}`,
      actions: [{ type: 'update_record', config: { fields: { status: `b${index}` } } }],
    }))
    const rule = createMockRule({
      actions: [{
        type: 'parallel_branch',
        config: { joinMode: 'all', branches },
      }],
    })

    const execution = await executor.execute(rule, {
      recordId: 'r1',
      data: {},
      sheetId: 'sheet_1',
    }, lifecycle.factory)

    expect(execution.status).toBe('failed')
    expect(execution.steps).toEqual([
      expect.objectContaining({
        actionType: 'parallel_branch',
        status: 'failed',
        error: 'parallel_branch.branches exceeds max 10',
      }),
    ])
    expect(events).toEqual([
      { phase: 'start', index: 0, type: 'parallel_branch' },
      { phase: 'settled', index: 0, type: 'parallel_branch', status: 'failed' },
    ])
    expect(deps.queryFn).not.toHaveBeenCalled()
  })
})

describe('AutomationService — A6-1 opt-in path choice', () => {
  let service: AutomationService
  beforeEach(() => {
    service = new AutomationService(new EventBus(), {} as never, vi.fn(async () => ({ rows: [], rowCount: 0 })))
  })

  it('opt-OUT rule (no execution_mode) → executor.execute called WITHOUT a job factory (no jobs)', async () => {
    const execSpy = vi.spyOn(service['executor'], 'execute').mockResolvedValue(storedExecutionForPath())
    await service.executeRule(execRule({ executionMode: undefined }), { recordId: 'r1' })
    expect(execSpy.mock.calls[0][2]).toBeUndefined() // 3rd arg = jobLifecycleFactory
  })

  it('opt-IN rule (workflow_job_v1) → executor.execute called WITH a job factory', async () => {
    const execSpy = vi.spyOn(service['executor'], 'execute').mockResolvedValue(storedExecutionForPath())
    await service.executeRule(execRule({ executionMode: 'workflow_job_v1' }), { recordId: 'r1' })
    expect(typeof execSpy.mock.calls[0][2]).toBe('function')
  })

  it('opt-IN rule pre-creates the parent execution before side effects, then final-updates it', async () => {
    const events: string[] = []
    const fetchFn = vi.fn(async () => {
      events.push('side-effect')
      return new Response('OK', { status: 200 })
    }) as unknown as typeof fetch
    service = new AutomationService(
      new EventBus(),
      {} as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })),
      fetchFn,
    )
    vi.spyOn(service.logs, 'record').mockImplementation(async () => { events.push('parent-start') })
    vi.spyOn(service.logs, 'updateRecordedExecution').mockImplementation(async () => { events.push('parent-final') })

    const execution = await service.executeRule(execRule({
      executionMode: 'workflow_job_v1',
      actions: [{ type: 'send_webhook', config: { url: 'https://example.com/hook' } }],
    }), { recordId: 'r1', data: {} })

    expect(execution.status).toBe('success')
    expect(events).toEqual(['parent-start', 'side-effect', 'parent-final'])
  })

  it('opt-IN rule fails before side effects when the parent execution cannot be pre-created', async () => {
    const fetchFn = vi.fn(async () => new Response('OK', { status: 200 })) as unknown as typeof fetch
    service = new AutomationService(
      new EventBus(),
      {} as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })),
      fetchFn,
    )
    vi.spyOn(service.logs, 'record').mockRejectedValue(new Error('parent execution insert failed'))

    await expect(service.executeRule(execRule({
      executionMode: 'workflow_job_v1',
      actions: [{ type: 'send_webhook', config: { url: 'https://example.com/hook' } }],
    }), { recordId: 'r1', data: {} })).rejects.toThrow('parent execution insert failed')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  function execRule(over: Record<string, unknown>) {
    return {
      id: 'rule_1', name: 'R', sheetId: 'sheet_1', trigger: { type: 'record.created', config: {} },
      actions: [{ type: 'update_record', config: { fields: { x: 1 } } }], enabled: true,
      createdBy: 'u1', createdAt: '2026-01-01T00:00:00Z', ...over,
    } as never
  }
  function storedExecutionForPath(): AutomationExecution {
    return { id: 'axe_1', ruleId: 'rule_1', triggeredBy: 'event', triggeredAt: '2026-05-30T00:00:00Z', status: 'success', steps: [] }
  }
})

describe('AutomationJobService — A6-1 persistence + C1 read', () => {
  beforeEach(() => { _valuesCalls.length = 0; _setCalls.length = 0; _executeResults.length = 0; _executeTakeFirstResults.length = 0 })

  it('onStart inserts a running job; onSettled redacts result/error and maps status to C1', async () => {
    const svc = new AutomationJobService()
    const lc = svc.lifecycleFor('axe_x', { id: 'rule_1', sheetId: 'sheet_1' })
    _executeResults.push([]) // onStart insert
    await lc.onStart(0, { type: 'send_webhook', config: {} } as never)
    const inserted = _valuesCalls.at(-1) as Record<string, unknown>
    expect(inserted.id).toBe('axe_x:job:0')
    expect(inserted.status).toBe('running')
    expect(inserted.upstream_job_id).toBeNull()

    _executeResults.push([]) // onSettled update
    await lc.onSettled(0, { type: 'send_webhook' } as never, {
      actionType: 'send_webhook', status: 'failed',
      error: 'connect postgres://u:SECRETPW@h/db failed', output: { token: 'LIVE-SECRET' }, durationMs: 5,
    } as never)
    const upd = _setCalls.at(-1) as Record<string, unknown> // updateTable().set(...) payload
    expect(upd.status).toBe('failed') // C1 (failed identity)
    expect(String(upd.error)).not.toContain('SECRETPW') // redactString
    expect(JSON.stringify(upd)).not.toContain('LIVE-SECRET') // redactValue on result (token key masked)
  })

  it('listByExecution maps rows to C1 views that pass normalizeWorkflowJob (error string-or-absent)', async () => {
    const svc = new AutomationJobService()
    _executeResults.push([
      { id: 'axe_x:job:0', execution_id: 'axe_x', step_key: '0', status: 'resolved', upstream_job_id: null, result: { ok: true }, error: null },
      { id: 'axe_x:job:1', execution_id: 'axe_x', step_key: '1', status: 'failed', upstream_job_id: 'axe_x:job:0', result: null, error: 'boom' },
    ])
    const views = await svc.listByExecution('axe_x')
    expect(views[0].status).toBe('resolved')
    expect(views[0].error).toBeUndefined() // null → absent (C1)
    expect(views[1].error).toBe('boom')
    for (const v of views) expect(() => normalizeWorkflowJob(v)).not.toThrow()
  })
})
