import { describe, expect, test, vi } from 'vitest'

import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationScheduler } from '../../src/multitable/automation-scheduler'
import { AutomationService } from '../../src/multitable/automation-service'
import type { AutomationRule } from '../../src/multitable/automation-executor'

function intervalRule(): AutomationRule {
  return {
    id: 'rule_lifecycle',
    name: 'lifecycle',
    sheetId: 'sheet_lifecycle',
    trigger: { type: 'schedule.interval', config: { intervalMs: 1_000 } },
    actions: [],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
  }
}

describe('automation lifecycle ownership', () => {
  test('shutdown reaps the producer subscriptions left by a partial init', async () => {
    const bus = new EventBus()
    const originalSubscribe = bus.subscribe.bind(bus)
    const unsubscribe = vi.spyOn(bus, 'unsubscribe')
    let attempts = 0
    vi.spyOn(bus, 'subscribe').mockImplementation(((...args: Parameters<EventBus['subscribe']>) => {
      attempts += 1
      if (attempts === 3) throw new Error('automation init sentinel')
      return originalSubscribe(...args)
    }) as EventBus['subscribe'])
    const service = new AutomationService(
      bus,
      {} as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })),
    )
    const handleEvent = vi.spyOn(service, 'handleEvent')

    expect(() => service.init()).toThrow('automation init sentinel')
    await service.shutdown()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    bus.emit('multitable.record.created', { sheetId: 'sheet_1', recordId: 'record_1' })
    expect(handleEvent).not.toHaveBeenCalled()
  })

  test('scheduler destroy waits for the callback already admitted by its timer', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const callback = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
      const scheduler = new AutomationScheduler(callback)
      scheduler.register(intervalRule())
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))

      let destroyed = false
      const destroy = scheduler.destroy().then(() => { destroyed = true })
      await Promise.resolve()
      expect(destroyed).toBe(false)
      release()
      await destroy
      await vi.advanceTimersByTimeAsync(2_000)
      expect(callback).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  test('producer admission stops before completion consumers detach, then both sets drain', async () => {
    const bus = new EventBus()
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const service = new AutomationService(bus, {} as never, query)
    let releaseRecord!: () => void
    let releaseBridge!: () => void
    let releaseTrigger!: () => void
    const bridgePending = new Promise<void>((resolve) => { releaseBridge = resolve })
    const triggerPending = new Promise<void>((resolve) => { releaseTrigger = resolve })
    const handleEvent = vi.spyOn(service, 'handleEvent').mockImplementation(
      () => new Promise<void>((resolve) => { releaseRecord = resolve }),
    )
    const handleBridge = vi.spyOn(service, 'handleApprovalCompletionEvent').mockImplementation(
      () => bridgePending,
    )
    const handleTrigger = vi.spyOn(service, 'handleApprovalCompletionTrigger').mockImplementation(
      () => triggerPending,
    )
    service.init()

    bus.emit('multitable.record.updated', { sheetId: 'sheet_lifecycle', recordId: 'record_1' })
    bus.emit('approval.approved', {
      version: 1,
      eventId: 'approval_lifecycle',
      eventType: 'approval.approved',
      source: 'approval-product',
      approval: { instanceId: 'apr_1', templateId: 'tpl_1' },
      transition: { toStatus: 'approved' },
    })
    await vi.waitFor(() => {
      expect(handleEvent).toHaveBeenCalledTimes(1)
      expect(handleBridge).toHaveBeenCalledTimes(1)
      expect(handleTrigger).toHaveBeenCalledTimes(1)
    })

    let producersStopped = false
    const stopProducers = service.stopProducerAdmissions().then(() => { producersStopped = true })
    await Promise.resolve()
    expect(producersStopped).toBe(false)
    releaseRecord()
    await stopProducers

    bus.emit('multitable.record.updated', { sheetId: 'sheet_lifecycle', recordId: 'record_2' })
    expect(handleEvent).toHaveBeenCalledTimes(1)
    bus.emit('approval.approved', {
      version: 1,
      eventId: 'approval_lifecycle_2',
      eventType: 'approval.approved',
      source: 'approval-product',
      approval: { instanceId: 'apr_2', templateId: 'tpl_1' },
      transition: { toStatus: 'approved' },
    })
    expect(handleBridge).toHaveBeenCalledTimes(2)

    releaseBridge()
    await service.drainTransitiveCompletionProducers()
    service.detachCompletionConsumers()
    service.detachCompletionConsumers()
    releaseTrigger()
    await service.drainCompletionConsumers()

    bus.emit('approval.approved', {
      version: 1,
      eventId: 'approval_lifecycle_3',
      eventType: 'approval.approved',
      source: 'approval-product',
      approval: { instanceId: 'apr_3', templateId: 'tpl_1' },
      transition: { toStatus: 'approved' },
    })
    expect(handleBridge).toHaveBeenCalledTimes(2)
    expect(handleTrigger).toHaveBeenCalledTimes(2)
  })

  test('standalone shutdown preserves a completion emitted by an already-admitted producer', async () => {
    const bus = new EventBus()
    const service = new AutomationService(
      bus,
      {} as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })),
    )
    let releaseProducer!: () => void
    const producerPending = new Promise<void>((resolve) => { releaseProducer = resolve })
    const completionEvent = {
      version: 1 as const,
      eventId: 'approval_shutdown_late_completion',
      eventType: 'approval.approved' as const,
      source: 'approval-product' as const,
      approval: { instanceId: 'apr_shutdown_late', templateId: 'tpl_1' },
      transition: { toStatus: 'approved' as const },
    }
    const handleEvent = vi.spyOn(service, 'handleEvent').mockImplementation(async () => {
      await producerPending
      bus.emit('approval.approved', completionEvent)
    })
    const handleBridge = vi.spyOn(service, 'handleApprovalCompletionEvent').mockResolvedValue(undefined)
    const handleTrigger = vi.spyOn(service, 'handleApprovalCompletionTrigger').mockResolvedValue(undefined)
    service.init()

    bus.emit('multitable.record.updated', { sheetId: 'sheet_lifecycle', recordId: 'record_late' })
    await vi.waitFor(() => expect(handleEvent).toHaveBeenCalledTimes(1))
    let shutdownDone = false
    const shutdown = service.shutdown().then(() => { shutdownDone = true })
    await Promise.resolve()
    expect(shutdownDone).toBe(false)

    releaseProducer()
    await shutdown
    expect(handleBridge).toHaveBeenCalledTimes(1)
    expect(handleTrigger).toHaveBeenCalledTimes(1)

    bus.emit('approval.approved', { ...completionEvent, eventId: 'approval_after_shutdown' })
    expect(handleBridge).toHaveBeenCalledTimes(1)
    expect(handleTrigger).toHaveBeenCalledTimes(1)
  })

  test('transitive completion drain reaches a fixed point', async () => {
    const bus = new EventBus()
    const service = new AutomationService(
      bus,
      {} as never,
      vi.fn(async () => ({ rows: [], rowCount: 0 })),
    )
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = new Promise<void>((resolve) => { releaseFirst = resolve })
    const second = new Promise<void>((resolve) => { releaseSecond = resolve })
    const secondEvent = {
      version: 1 as const,
      eventId: 'approval_transitive_2',
      eventType: 'approval.approved' as const,
      source: 'approval-product' as const,
      approval: { instanceId: 'apr_transitive_2', templateId: 'tpl_1' },
      transition: { toStatus: 'approved' as const },
    }
    const handleBridge = vi.spyOn(service, 'handleApprovalCompletionEvent')
      .mockImplementationOnce(async () => {
        await first
        bus.emit('approval.approved', secondEvent)
      })
      .mockImplementationOnce(() => second)
    vi.spyOn(service, 'handleApprovalCompletionTrigger').mockResolvedValue(undefined)
    service.init()

    bus.emit('approval.approved', {
      ...secondEvent,
      eventId: 'approval_transitive_1',
      approval: { instanceId: 'apr_transitive_1', templateId: 'tpl_1' },
    })
    await vi.waitFor(() => expect(handleBridge).toHaveBeenCalledTimes(1))
    let drained = false
    const drain = service.drainTransitiveCompletionProducers().then(() => { drained = true })
    releaseFirst()
    await vi.waitFor(() => expect(handleBridge).toHaveBeenCalledTimes(2))
    expect(drained).toBe(false)
    releaseSecond()
    await drain

    service.detachCompletionConsumers()
    await service.shutdown()
  })
})
