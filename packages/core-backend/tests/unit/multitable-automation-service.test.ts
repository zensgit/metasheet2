import { describe, expect, it, vi, beforeEach } from 'vitest'

const automationLogMocks = vi.hoisted(() => ({
  record: vi.fn(async () => undefined),
  getByRule: vi.fn(async () => []),
  getRecent: vi.fn(async () => []),
  getById: vi.fn(async () => undefined),
  getStats: vi.fn(async () => ({
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    avgDuration: 0,
  })),
  cleanup: vi.fn(async () => 0),
}))

vi.mock('../../src/multitable/automation-log-service', () => ({
  AutomationLogService: class {
    record = automationLogMocks.record
    getByRule = automationLogMocks.getByRule
    getRecent = automationLogMocks.getRecent
    getById = automationLogMocks.getById
    getStats = automationLogMocks.getStats
    cleanup = automationLogMocks.cleanup
  },
}))

import { AutomationService, type AutomationRule, type AutomationEventPayload, type AutomationQueryFn } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

function createMockRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'atr_test1',
    sheet_id: 'sheet1',
    name: 'Test Rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'send_notification',
    action_config: { userIds: ['user_notify'], message: 'Record changed' },
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'user1',
    ...overrides,
  }
}

function createMockQuery(rules: AutomationRule[]): AutomationQueryFn {
  return vi.fn(async (_sql: string, _params?: unknown[]) => ({
    rows: rules,
    rowCount: rules.length,
  }))
}

function createMockDb(rules: AutomationRule[]) {
  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const method of ['selectAll', 'where', 'orderBy']) {
    chain[method] = vi.fn(chainFn)
  }
  chain.execute = vi.fn(async () => rules)
  return {
    selectFrom: vi.fn(() => chain),
  }
}

describe('AutomationService', () => {
  let bus: EventBus
  let service: AutomationService

  beforeEach(() => {
    bus = new EventBus()
    automationLogMocks.record.mockClear()
    automationLogMocks.getByRule.mockClear()
    automationLogMocks.getRecent.mockClear()
    automationLogMocks.getById.mockClear()
    automationLogMocks.getStats.mockClear()
    automationLogMocks.cleanup.mockClear()
  })

  describe('rule matching', () => {
    it('matches record.created trigger on multitable.record.created event', async () => {
      const rule = createMockRule({ trigger_type: 'record.created', action_type: 'send_notification' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: { field1: 'value1' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({
        sheetId: 'sheet1',
        recordId: 'rec1',
        userIds: ['user_notify'],
        message: 'Record changed',
      }))
    })

    it('matches record.updated trigger on multitable.record.updated event', async () => {
      const rule = createMockRule({ trigger_type: 'record.updated', action_type: 'send_notification' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { field1: 'new_value' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({
        sheetId: 'sheet1',
        recordId: 'rec1',
      }))
    })

    it('matches field.value_changed trigger when specific field is in changes', async () => {
      const rule = createMockRule({
        trigger_type: 'field.value_changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'send_notification',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { status_field: 'done' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({
        recordId: 'rec1',
      }))
    })

    it('does not match field.value_changed trigger when field is not in changes', async () => {
      const rule = createMockRule({
        trigger_type: 'field.value_changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'send_notification',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { other_field: 'value' },
        actorId: 'user1',
      })

      expect(emitSpy).not.toHaveBeenCalledWith('automation.notification', expect.anything())
    })

    it('does not match field.value_changed trigger on record.created events', async () => {
      const rule = createMockRule({
        trigger_type: 'field.value_changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'send_notification',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: { status_field: 'new' },
        actorId: 'user1',
      })

      expect(emitSpy).not.toHaveBeenCalledWith('automation.notification', expect.anything())
    })
  })

  describe('notify action', () => {
    it('emits automation.notification event with action_config merged', async () => {
      const rule = createMockRule({
        action_type: 'send_notification',
        action_config: { userIds: ['user_a', 'user_b'], message: 'Record changed' },
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({
        sheetId: 'sheet1',
        recordId: 'rec1',
        actorId: 'user1',
        userIds: ['user_a', 'user_b'],
        message: 'Record changed',
      }))
    })
  })

  describe('update_field action', () => {
    it('runs update_record query and emits follow-up update event', async () => {
      const rule = createMockRule({
        action_type: 'update_record',
        action_config: { fields: { target_field: 'auto_value' } },
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
      })

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE meta_records SET'),
        expect.arrayContaining(['{target_field}', JSON.stringify('auto_value'), 'rec1', 'sheet1']),
      )

      // Should emit follow-up update event with incremented depth
      expect(emitSpy).toHaveBeenCalledWith('multitable.record.updated', expect.objectContaining({
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { target_field: 'auto_value' },
        _automationDepth: 1,
      }))
    })
  })

  describe('recursion guard', () => {
    it('blocks execution at depth >= 3', async () => {
      const rule = createMockRule({ action_type: 'send_notification' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
        _automationDepth: 3,
      })

      expect(emitSpy).not.toHaveBeenCalled()
      // Query should not even be called for rule loading
      expect(query).not.toHaveBeenCalled()
    })

    it('allows execution at depth < 3', async () => {
      const rule = createMockRule({ action_type: 'send_notification' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, createMockDb([rule]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
        _automationDepth: 2,
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notification', expect.objectContaining({
        recordId: 'rec1',
        userIds: ['user_notify'],
      }))
    })
  })

  describe('disabled rules', () => {
    it('skips disabled rules (query returns only enabled)', async () => {
      // The query only returns enabled rules, so we simulate empty result
      const query = createMockQuery([])
      service = new AutomationService(bus, createMockDb([]) as never, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
      })

      expect(emitSpy).not.toHaveBeenCalled()
    })
  })

  describe('init / shutdown', () => {
    it('subscribes to events on init and unsubscribes on shutdown', () => {
      const query = createMockQuery([])
      service = new AutomationService(bus, createMockDb([]) as never, query)

      const subscribeSpy = vi.spyOn(bus, 'subscribe')
      const unsubscribeSpy = vi.spyOn(bus, 'unsubscribe')

      service.init()
      expect(subscribeSpy).toHaveBeenCalledTimes(3)
      expect(subscribeSpy).toHaveBeenCalledWith(
        'multitable.record.created',
        expect.any(Function),
      )
      expect(subscribeSpy).toHaveBeenCalledWith(
        'multitable.record.updated',
        expect.any(Function),
      )
      expect(subscribeSpy).toHaveBeenCalledWith(
        'multitable.record.deleted',
        expect.any(Function),
      )

      service.shutdown()
      expect(unsubscribeSpy).toHaveBeenCalledTimes(3)
    })
  })
})

import {
  AutomationRuleValidationError,
  parseCreateRuleInput,
  parseDingTalkAutomationDeliveryLimit,
  parseUpdateRuleInput,
  preflightDingTalkAutomationCreate,
  preflightDingTalkAutomationUpdate,
  serializeAutomationRule,
} from '../../src/multitable/automation-service'

describe('M5 — Automation route helpers', () => {
  describe('serializeAutomationRule', () => {
    it('emits the legacy route shape (camelCase + nested trigger)', () => {
      const rule = createMockRule({
        id: 'atr_x',
        sheet_id: 'sheet_x',
        name: 'My Rule',
        trigger_type: 'record.updated',
        trigger_config: { fieldId: 'f1' },
        action_type: 'send_notification',
        action_config: { message: 'hi' },
        created_at: '2026-01-02T03:04:05Z',
        updated_at: '2026-01-02T03:04:05Z',
        created_by: 'user_a',
        conditions: undefined,
        actions: null,
      })

      const out = serializeAutomationRule(rule)

      expect(out).toEqual({
        id: 'atr_x',
        sheetId: 'sheet_x',
        name: 'My Rule',
        triggerType: 'record.updated',
        triggerConfig: { fieldId: 'f1' },
        trigger: { type: 'record.updated', config: { fieldId: 'f1' } },
        conditions: undefined,
        actions: undefined,
        actionType: 'send_notification',
        actionConfig: { message: 'hi' },
        enabled: true,
        createdAt: '2026-01-02T03:04:05Z',
        updatedAt: '2026-01-02T03:04:05Z',
        createdBy: 'user_a',
      })
    })

    it('falls back to empty string / undefined for null name and createdBy', () => {
      const rule = createMockRule({ name: null, created_by: null })
      const out = serializeAutomationRule(rule)
      expect(out.name).toBe('')
      expect(out.createdBy).toBeUndefined()
    })
  })

  describe('parseDingTalkAutomationDeliveryLimit', () => {
    it('defaults to 50 when value is missing or non-numeric', () => {
      expect(parseDingTalkAutomationDeliveryLimit(undefined)).toBe(50)
      expect(parseDingTalkAutomationDeliveryLimit('not-a-number')).toBe(50)
      expect(parseDingTalkAutomationDeliveryLimit(123 as unknown)).toBe(50)
    })

    it('clamps below 1 to 1 and above 200 to 200', () => {
      expect(parseDingTalkAutomationDeliveryLimit('0')).toBe(1)
      expect(parseDingTalkAutomationDeliveryLimit('-5')).toBe(1)
      expect(parseDingTalkAutomationDeliveryLimit('5000')).toBe(200)
    })

    it('floors fractional values inside the valid range', () => {
      expect(parseDingTalkAutomationDeliveryLimit('25.7')).toBe(25)
      expect(parseDingTalkAutomationDeliveryLimit('200.9')).toBe(200)
    })
  })

  describe('parseCreateRuleInput', () => {
    it('extracts a well-formed body and forwards createdBy', () => {
      const body = {
        name: 'rule',
        triggerType: 'record.created',
        triggerConfig: { foo: 'bar' },
        actionType: 'send_notification',
        actionConfig: { userIds: ['u1'], message: 'hi' },
        enabled: false,
        conditions: { logic: 'and', conditions: [] },
      }

      const input = parseCreateRuleInput(body, 'user_a')

      expect(input.name).toBe('rule')
      expect(input.triggerType).toBe('record.created')
      expect(input.triggerConfig).toEqual({ foo: 'bar' })
      expect(input.actionType).toBe('send_notification')
      expect(input.actionConfig).toEqual({ userIds: ['u1'], message: 'hi' })
      expect(input.enabled).toBe(false)
      expect(input.createdBy).toBe('user_a')
      expect(input.conditions).toEqual({ logic: 'and', conditions: [] })
    })

    it('falls back to first action when actionType / actionConfig are absent', () => {
      const body = {
        triggerType: 'record.created',
        actions: [{ type: 'send_notification', config: { message: 'hi' } }],
      }

      const input = parseCreateRuleInput(body, null)

      expect(input.actionType).toBe('send_notification')
      expect(input.actionConfig).toEqual({ message: 'hi' })
      expect(input.actions).toEqual([{ type: 'send_notification', config: { message: 'hi' } }])
    })

    it('throws AutomationRuleValidationError for unknown trigger type', () => {
      expect(() =>
        parseCreateRuleInput(
          { triggerType: 'never', actionType: 'send_notification' },
          null,
        ),
      ).toThrow(AutomationRuleValidationError)
    })

    it('throws AutomationRuleValidationError for unknown action type', () => {
      expect(() =>
        parseCreateRuleInput(
          { triggerType: 'record.created', actionType: 'shrug' },
          null,
        ),
      ).toThrow(AutomationRuleValidationError)
    })

    it('defaults enabled to true and treats missing optional fields safely', () => {
      const input = parseCreateRuleInput(
        { triggerType: 'record.created', actionType: 'send_notification' },
        null,
      )
      expect(input.enabled).toBe(true)
      expect(input.triggerConfig).toEqual({})
      expect(input.actionConfig).toEqual({})
      expect(input.conditions).toBeNull()
      expect(input.actions).toBeNull()
    })
  })

  describe('parseUpdateRuleInput', () => {
    it('returns null when no recognised fields are present', () => {
      expect(parseUpdateRuleInput(undefined)).toBeNull()
      expect(parseUpdateRuleInput({})).toBeNull()
      expect(parseUpdateRuleInput({ ignored: 'x' })).toBeNull()
    })

    it('returns just the touched fields', () => {
      const out = parseUpdateRuleInput({ enabled: false })
      expect(out).toEqual({ enabled: false })
    })

    it('passes triggerConfig / actionConfig as objects (not stringified)', () => {
      const out = parseUpdateRuleInput({
        triggerConfig: { f: 'v' },
        actionConfig: { x: 1 },
      })
      expect(out?.triggerConfig).toEqual({ f: 'v' })
      expect(out?.actionConfig).toEqual({ x: 1 })
    })

    it('preserves explicit null for conditions and actions', () => {
      const out = parseUpdateRuleInput({ conditions: null, actions: null })
      expect(out?.conditions).toBeNull()
      expect(out?.actions).toBeNull()
    })

    it('rejects an invalid trigger type', () => {
      expect(() => parseUpdateRuleInput({ triggerType: 'nope' }))
        .toThrow(AutomationRuleValidationError)
    })

    it('rejects an invalid action type', () => {
      expect(() => parseUpdateRuleInput({ actionType: 'nope' }))
        .toThrow(AutomationRuleValidationError)
    })

    it('accepts the legacy `notify` and `update_field` action types', () => {
      expect(parseUpdateRuleInput({ actionType: 'notify' })?.actionType).toBe('notify')
      expect(parseUpdateRuleInput({ actionType: 'update_field' })?.actionType).toBe('update_field')
    })
  })

  describe('preflightDingTalkAutomationCreate', () => {
    it('returns input unchanged for non-DingTalk action types', async () => {
      const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const input = {
        triggerType: 'record.created',
        actionType: 'send_notification',
        actionConfig: { message: 'hi', userIds: ['u1'] },
        actions: null,
      }

      const out = await preflightDingTalkAutomationCreate(queryFn as never, 'sheet_x', input as never)

      expect(out.actionType).toBe('send_notification')
      expect(out.actionConfig).toEqual({ message: 'hi', userIds: ['u1'] })
      expect(out.actions).toBeNull()
    })

    it('throws AutomationRuleValidationError when action config is invalid', async () => {
      const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const input = {
        triggerType: 'record.created',
        actionType: 'send_dingtalk_group_message',
        // missing destinationId / templates → validateDingTalkAutomationActionConfigs fails
        actionConfig: {},
        actions: null,
      }

      await expect(
        preflightDingTalkAutomationCreate(queryFn as never, 'sheet_x', input as never),
      ).rejects.toBeInstanceOf(AutomationRuleValidationError)
    })
  })

  describe('preflightDingTalkAutomationUpdate', () => {
    it('returns input unchanged when the update does not touch action fields', async () => {
      const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const service = { getRule: vi.fn(async () => null) }
      const input = { name: 'renamed' }

      const out = await preflightDingTalkAutomationUpdate(
        queryFn as never,
        'sheet_x',
        'atr_1',
        input as never,
        service as never,
      )

      expect(out).toEqual({ name: 'renamed' })
      expect(service.getRule).not.toHaveBeenCalled()
    })

    it('returns null when existing rule belongs to a different sheet', async () => {
      const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const existing = createMockRule({ id: 'atr_1', sheet_id: 'other_sheet' })
      const service = { getRule: vi.fn(async () => existing) }

      const out = await preflightDingTalkAutomationUpdate(
        queryFn as never,
        'sheet_x',
        'atr_1',
        { actionConfig: { foo: 'bar' } } as never,
        service as never,
      )

      expect(out).toBeNull()
    })

    it('returns null when existing rule is missing', async () => {
      const queryFn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const service = { getRule: vi.fn(async () => null) }

      const out = await preflightDingTalkAutomationUpdate(
        queryFn as never,
        'sheet_x',
        'atr_1',
        { actionType: 'send_notification' } as never,
        service as never,
      )

      expect(out).toBeNull()
    })
  })
})
