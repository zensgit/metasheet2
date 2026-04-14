import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { evaluateCondition, evaluateConditions, type AutomationCondition, type ConditionGroup } from '../../src/multitable/automation-conditions'
import { AutomationExecutor, type AutomationRule, type AutomationDeps, type AutomationExecution } from '../../src/multitable/automation-executor'
import { AutomationScheduler, parseCronToIntervalMs } from '../../src/multitable/automation-scheduler'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { matchesTrigger } from '../../src/multitable/automation-triggers'
import type { AutomationTrigger, AutomationTriggerType } from '../../src/multitable/automation-triggers'
import { EventBus } from '../../src/integration/events/event-bus'

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
// Execution Log Service
// ═════════════════════════════════════════════════════════════════════════

describe('AutomationLogService', () => {
  let logService: AutomationLogService

  beforeEach(() => {
    logService = new AutomationLogService(10) // small buffer for testing
  })

  it('records and retrieves executions', () => {
    const exec = createExecution({ ruleId: 'r1' })
    logService.record(exec)
    expect(logService.size).toBe(1)
    expect(logService.getById(exec.id)).toEqual(exec)
  })

  it('getByRule filters by ruleId', () => {
    logService.record(createExecution({ ruleId: 'r1' }))
    logService.record(createExecution({ ruleId: 'r2' }))
    logService.record(createExecution({ ruleId: 'r1' }))
    expect(logService.getByRule('r1')).toHaveLength(2)
    expect(logService.getByRule('r2')).toHaveLength(1)
  })

  it('getRecent returns newest first', () => {
    const e1 = createExecution({ ruleId: 'r1' })
    const e2 = createExecution({ ruleId: 'r1' })
    logService.record(e1)
    logService.record(e2)
    const recent = logService.getRecent()
    expect(recent[0].id).toBe(e2.id)
    expect(recent[1].id).toBe(e1.id)
  })

  it('circular buffer evicts oldest entries', () => {
    for (let i = 0; i < 15; i++) {
      logService.record(createExecution({ ruleId: 'r1' }))
    }
    expect(logService.size).toBe(10) // maxLogs=10
  })

  it('getByRule respects limit', () => {
    for (let i = 0; i < 8; i++) {
      logService.record(createExecution({ ruleId: 'r1' }))
    }
    expect(logService.getByRule('r1', 3)).toHaveLength(3)
  })

  it('getStats calculates correctly', () => {
    logService.record(createExecution({ ruleId: 'r1', status: 'success', duration: 10 }))
    logService.record(createExecution({ ruleId: 'r1', status: 'success', duration: 20 }))
    logService.record(createExecution({ ruleId: 'r1', status: 'failed', duration: 5 }))
    logService.record(createExecution({ ruleId: 'r1', status: 'skipped', duration: 1 }))

    const stats = logService.getStats('r1')
    expect(stats.total).toBe(4)
    expect(stats.success).toBe(2)
    expect(stats.failed).toBe(1)
    expect(stats.skipped).toBe(1)
    expect(stats.avgDuration).toBe(9) // (10+20+5+1)/4 = 9
  })

  it('getStats returns zeros for unknown rule', () => {
    const stats = logService.getStats('nonexistent')
    expect(stats.total).toBe(0)
    expect(stats.avgDuration).toBe(0)
  })

  it('clear empties all logs', () => {
    logService.record(createExecution())
    logService.record(createExecution())
    logService.clear()
    expect(logService.size).toBe(0)
  })
})
