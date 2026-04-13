import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../src/multitable/records', () => ({
  patchRecord: vi.fn(async () => ({
    id: 'rec1',
    sheetId: 'sheet1',
    version: 2,
    data: {},
  })),
}))

import { patchRecord } from '../../src/multitable/records'
import { AutomationService, type AutomationRule, type AutomationEventPayload, type AutomationQueryFn } from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

function createMockRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'atr_test1',
    sheet_id: 'sheet1',
    name: 'Test Rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'notify',
    action_config: { channel: 'general' },
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

describe('AutomationService', () => {
  let bus: EventBus
  let service: AutomationService

  beforeEach(() => {
    bus = new EventBus()
  })

  describe('rule matching', () => {
    it('matches record.created trigger on multitable.record.created event', async () => {
      const rule = createMockRule({ trigger_type: 'record.created', action_type: 'notify' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: { field1: 'value1' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notify', expect.objectContaining({
        ruleId: 'atr_test1',
        sheetId: 'sheet1',
        recordId: 'rec1',
        channel: 'general',
      }))
    })

    it('matches record.updated trigger on multitable.record.updated event', async () => {
      const rule = createMockRule({ trigger_type: 'record.updated', action_type: 'notify' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { field1: 'new_value' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notify', expect.objectContaining({
        ruleId: 'atr_test1',
        sheetId: 'sheet1',
      }))
    })

    it('matches field.changed trigger when specific field is in changes', async () => {
      const rule = createMockRule({
        trigger_type: 'field.changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'notify',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { status_field: 'done' },
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notify', expect.objectContaining({
        ruleId: 'atr_test1',
      }))
    })

    it('does not match field.changed trigger when field is not in changes', async () => {
      const rule = createMockRule({
        trigger_type: 'field.changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'notify',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.updated', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { other_field: 'value' },
        actorId: 'user1',
      })

      expect(emitSpy).not.toHaveBeenCalledWith('automation.notify', expect.anything())
    })

    it('does not match field.changed trigger on record.created events', async () => {
      const rule = createMockRule({
        trigger_type: 'field.changed',
        trigger_config: { fieldId: 'status_field' },
        action_type: 'notify',
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: { status_field: 'new' },
        actorId: 'user1',
      })

      expect(emitSpy).not.toHaveBeenCalledWith('automation.notify', expect.anything())
    })
  })

  describe('notify action', () => {
    it('emits automation.notify event with action_config merged', async () => {
      const rule = createMockRule({
        action_type: 'notify',
        action_config: { channel: '#alerts', message: 'Record changed' },
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notify', expect.objectContaining({
        ruleId: 'atr_test1',
        sheetId: 'sheet1',
        recordId: 'rec1',
        actorId: 'user1',
        channel: '#alerts',
        message: 'Record changed',
        _automationDepth: 1,
      }))
    })
  })

  describe('update_field action', () => {
    it('calls patchRecord and emits follow-up event', async () => {
      const rule = createMockRule({
        action_type: 'update_field',
        action_config: { fieldId: 'target_field', value: 'auto_value' },
      })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
      })

      // Should have called patchRecord with the correct args
      expect(patchRecord).toHaveBeenCalledWith({
        query,
        sheetId: 'sheet1',
        recordId: 'rec1',
        changes: { target_field: 'auto_value' },
      })

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
      const rule = createMockRule({ action_type: 'notify' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

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
      const rule = createMockRule({ action_type: 'notify' })
      const query = createMockQuery([rule])
      service = new AutomationService(bus, query)

      const emitSpy = vi.spyOn(bus, 'emit')

      await service.handleEvent('multitable.record.created', {
        sheetId: 'sheet1',
        recordId: 'rec1',
        data: {},
        actorId: 'user1',
        _automationDepth: 2,
      })

      expect(emitSpy).toHaveBeenCalledWith('automation.notify', expect.objectContaining({
        _automationDepth: 3,
      }))
    })
  })

  describe('disabled rules', () => {
    it('skips disabled rules (query returns only enabled)', async () => {
      // The query only returns enabled rules, so we simulate empty result
      const query = createMockQuery([])
      service = new AutomationService(bus, query)

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
      service = new AutomationService(bus, query)

      const subscribeSpy = vi.spyOn(bus, 'subscribe')
      const unsubscribeSpy = vi.spyOn(bus, 'unsubscribe')

      service.init()
      expect(subscribeSpy).toHaveBeenCalledTimes(2)
      expect(subscribeSpy).toHaveBeenCalledWith(
        'multitable.record.created',
        expect.any(Function),
      )
      expect(subscribeSpy).toHaveBeenCalledWith(
        'multitable.record.updated',
        expect.any(Function),
      )

      service.shutdown()
      expect(unsubscribeSpy).toHaveBeenCalledTimes(2)
    })
  })
})
