import { describe, expect, test, vi } from 'vitest'

import { EventBus } from '../../src/integration/events/event-bus'
import { ApprovalRecordProjectionService } from '../../src/multitable/approval-record-projection-service'
import { ApprovalProjectionSweepScheduler } from '../../src/services/ApprovalProjectionSweepScheduler'
import type { ApprovalCompletionEventV1 } from '../../src/services/ApprovalCompletionEvent'

function completionEvent(): ApprovalCompletionEventV1 {
  return {
    version: 1,
    eventId: 'evt_projection_lifecycle',
    eventType: 'approval.approved',
    occurredAt: '2026-09-16T00:00:00.000Z',
    source: 'approval-product',
    approval: {
      instanceId: 'apr_projection_lifecycle',
      requestNo: null,
      templateId: 'tpl_projection_lifecycle',
      templateVersionId: null,
      publishedDefinitionId: null,
      businessKey: null,
      workflowKey: null,
    },
    transition: {
      action: 'approve',
      fromStatus: 'pending',
      toStatus: 'approved',
      fromVersion: 1,
      toVersion: 2,
      nodeKey: 'node_1',
    },
    actor: null,
    requester: { id: 'user_1' },
  }
}

describe('approval projection lifecycle', () => {
  test('a partial subscribe rolls back only the projection ids already registered', () => {
    const bus = new EventBus()
    const originalSubscribe = bus.subscribe.bind(bus)
    const unsubscribe = vi.spyOn(bus, 'unsubscribe')
    let attempts = 0
    vi.spyOn(bus, 'subscribe').mockImplementation(((...args: Parameters<EventBus['subscribe']>) => {
      attempts += 1
      if (attempts === 3) throw new Error('projection subscribe sentinel')
      return originalSubscribe(...args)
    }) as EventBus['subscribe'])
    const service = new ApprovalRecordProjectionService()
    const reconcile = vi.spyOn(service, 'reconcile')

    expect(() => service.subscribe(bus)).toThrow('projection subscribe sentinel')
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    bus.emit('approval.approved', completionEvent())
    expect(reconcile).not.toHaveBeenCalled()
  })

  test('precisely detaches its completion listeners and drains an admitted reconcile', async () => {
    const bus = new EventBus()
    const sibling = vi.fn()
    bus.subscribe('approval.approved', sibling)
    const service = new ApprovalRecordProjectionService()
    let release!: () => void
    const reconcile = vi.spyOn(service, 'reconcile').mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ status: 'absent' }) }),
    )

    service.subscribe(bus)
    bus.emit('approval.approved', completionEvent())
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1))

    service.unsubscribe(bus)
    service.unsubscribe(bus)
    bus.emit('approval.approved', completionEvent())
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(sibling).toHaveBeenCalledTimes(2)

    let drained = false
    const drain = service.drainCompletionHandlers().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await drain
  })

  test('sweep stop closes admission and waits for the current tick', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const sweep = vi.fn(() => new Promise<{ scanned: number; reconciled: number }>((resolve) => {
        release = () => resolve({ scanned: 1, reconciled: 1 })
      }))
      const scheduler = new ApprovalProjectionSweepScheduler({
        service: { sweep } as ApprovalRecordProjectionService,
        intervalMs: 30_000,
      })
      scheduler.start()
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(1))

      let stopped = false
      const stop = scheduler.stop().then(() => { stopped = true })
      await Promise.resolve()
      expect(stopped).toBe(false)
      release()
      await stop
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sweep).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
