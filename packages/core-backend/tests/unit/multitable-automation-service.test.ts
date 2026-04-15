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
