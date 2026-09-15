import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { pool as pgPool } from '../../src/db/pg'
import { MetaSheetServer } from '../../src/index'

describe('MetaSheetServer approval completion shutdown barrier', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  test('producer drain keeps listeners attached, then sink drain precedes pool.end', async () => {
    expect(pgPool).not.toBeNull()
    const order: string[] = []
    let releaseProducer!: () => void
    let releaseSink!: () => void
    const producerPending = new Promise<void>((resolve) => { releaseProducer = resolve })
    const sinkPending = new Promise<void>((resolve) => { releaseSink = resolve })
    const poolEnd = vi.spyOn(pgPool!, 'end').mockImplementation(async () => { order.push('pool') })
    const detachRecord = vi.fn(() => { order.push('record:detach') })
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const lifecycle = server as unknown as {
      durableDeliveryLoop: { stop(): Promise<void> } | null
      automationService: {
        stopProducerAdmissions(): Promise<void>
        drainTransitiveCompletionProducers(): Promise<void>
        detachCompletionConsumers(): void
        drainCompletionConsumers(): Promise<void>
      }
      approvalProjectionSweepScheduler: { stop(): Promise<void> } | null
      approvalProjectionService: { unsubscribe(bus: unknown): void; drainCompletionHandlers(): Promise<void> } | null
      recordApprovalCompletionSubscription: { detach(): void; drain(): Promise<void> } | null
      dingtalkInteractiveCardStreamWorker: { shutdown(): Promise<{ state: 'disabled'; reason: 'env_disabled' }> }
    }
    lifecycle.durableDeliveryLoop = {
      stop: vi.fn(() => {
        order.push('producer:start')
        return producerPending.then(() => { order.push('producer:done') })
      }),
    }
    lifecycle.automationService = {
      stopProducerAdmissions: vi.fn(async () => {}),
      drainTransitiveCompletionProducers: vi.fn(async () => {}),
      detachCompletionConsumers: vi.fn(() => { order.push('automation:detach') }),
      drainCompletionConsumers: vi.fn(async () => {}),
    }
    lifecycle.approvalProjectionSweepScheduler = { stop: vi.fn(async () => {}) }
    lifecycle.approvalProjectionService = {
      unsubscribe: vi.fn(() => { order.push('projection:detach') }),
      drainCompletionHandlers: vi.fn(async () => {}),
    }
    lifecycle.recordApprovalCompletionSubscription = {
      detach: detachRecord,
      drain: vi.fn(() => {
        order.push('sink:start')
        return sinkPending.then(() => { order.push('sink:done') })
      }),
    }
    lifecycle.dingtalkInteractiveCardStreamWorker = {
      shutdown: vi.fn(async () => ({ state: 'disabled', reason: 'env_disabled' })),
    }

    const stop = server.stop()
    await vi.waitFor(() => expect(order).toContain('producer:start'))
    expect(detachRecord).not.toHaveBeenCalled()
    expect(poolEnd).not.toHaveBeenCalled()
    releaseProducer()
    await vi.waitFor(() => expect(order).toContain('sink:start'))
    expect(order.indexOf('producer:done')).toBeLessThan(order.indexOf('record:detach'))
    expect(poolEnd).not.toHaveBeenCalled()
    releaseSink()
    await stop
    expect(order.indexOf('sink:done')).toBeLessThan(order.indexOf('pool'))
  })

  test('a producer stop failure preserves completion listeners and the database pool', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const detach = vi.fn()
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const lifecycle = server as unknown as {
      durableDeliveryLoop: { stop(): Promise<void> } | null
      recordApprovalCompletionSubscription: { detach(): void; drain(): Promise<void> } | null
    }
    lifecycle.durableDeliveryLoop = { stop: vi.fn().mockRejectedValue(new Error('producer sentinel')) }
    lifecycle.recordApprovalCompletionSubscription = { detach, drain: vi.fn(async () => {}) }

    await expect(server.stop()).rejects.toThrow('APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')
    expect(detach).not.toHaveBeenCalled()
    expect(poolEnd).not.toHaveBeenCalled()
  })

  test('observes an immediate producer rejection while the recovery worker is still draining', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const detach = vi.fn()
    let releaseRecovery!: () => void
    const recoveryPending = new Promise<void>((resolve) => { releaseRecovery = resolve })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
      const lifecycle = server as unknown as {
        durableDeliveryLoop: { stop(): Promise<void> } | null
        recoveryArchiveApplication: { stopWorker(): Promise<void> }
        recordApprovalCompletionSubscription: { detach(): void; drain(): Promise<void> } | null
      }
      lifecycle.durableDeliveryLoop = {
        stop: vi.fn().mockRejectedValue(new Error('producer sentinel')),
      }
      lifecycle.recoveryArchiveApplication = { stopWorker: () => recoveryPending }
      lifecycle.recordApprovalCompletionSubscription = { detach, drain: vi.fn(async () => {}) }

      const stop = server.stop()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(unhandled).not.toHaveBeenCalled()
      expect(detach).not.toHaveBeenCalled()
      expect(poolEnd).not.toHaveBeenCalled()
      releaseRecovery()
      await expect(stop).rejects.toThrow('APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')
      expect(poolEnd).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('an active HTTP request drains before completion listeners detach', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    let finishHttpDrain!: () => void
    const close = vi.fn((callback: (error?: Error) => void) => {
      finishHttpDrain = () => callback()
    })
    const detach = vi.fn()
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const lifecycle = server as unknown as {
      httpServer: { listening: boolean; close(callback: (error?: Error) => void): void }
      recordApprovalCompletionSubscription: { detach(): void; drain(): Promise<void> } | null
    }
    lifecycle.httpServer = { listening: true, close }
    lifecycle.recordApprovalCompletionSubscription = { detach, drain: vi.fn(async () => {}) }

    const stop = server.stop()
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(detach).not.toHaveBeenCalled()
    expect(poolEnd).not.toHaveBeenCalled()
    finishHttpDrain()
    await stop
    expect(detach).toHaveBeenCalledTimes(1)
    expect(poolEnd).toHaveBeenCalledTimes(1)
  })

  test('a DingTalk Stream close failure leaves completion listeners and the pool open', async () => {
    expect(pgPool).not.toBeNull()
    const poolEnd = vi.spyOn(pgPool!, 'end').mockResolvedValue(undefined)
    const detach = vi.fn()
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const lifecycle = server as unknown as {
      dingtalkInteractiveCardStreamWorker: {
        shutdown(): Promise<{ state: 'failed'; reason: 'client_stop_failed' }>
      } | null
      recordApprovalCompletionSubscription: { detach(): void; drain(): Promise<void> } | null
    }
    lifecycle.dingtalkInteractiveCardStreamWorker = {
      shutdown: vi.fn(async () => ({ state: 'failed', reason: 'client_stop_failed' })),
    }
    lifecycle.recordApprovalCompletionSubscription = { detach, drain: vi.fn(async () => {}) }

    await expect(server.stop()).rejects.toThrow('APPROVAL_COMPLETION_SHUTDOWN_BARRIER_FAILED')
    expect(detach).not.toHaveBeenCalled()
    expect(poolEnd).not.toHaveBeenCalled()
  })

  test('the bounded wait clears its timer on success and rejects a real timeout', async () => {
    vi.useFakeTimers()
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const target = server as unknown as {
      logger: { warn: (message: string) => void }
      waitForShutdownBarrier(tasks: Array<Promise<unknown>>, failureCode: string, timeoutMessage: string): Promise<void>
    }
    const warn = vi.spyOn(target.logger, 'warn')

    await target.waitForShutdownBarrier([Promise.resolve()], 'BARRIER_FAILED', 'timeout sentinel')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(warn).not.toHaveBeenCalledWith('timeout sentinel')

    const timedOut = target.waitForShutdownBarrier(
      [new Promise<void>(() => undefined)],
      'BARRIER_FAILED',
      'timeout sentinel',
    )
    const rejection = expect(timedOut).rejects.toThrow('BARRIER_FAILED')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
    expect(warn).toHaveBeenCalledWith('timeout sentinel')
  })

  test('a partial server start invokes the same idempotent shutdown path', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const target = server as unknown as { startOnce(): Promise<void> }
    vi.spyOn(target, 'startOnce').mockRejectedValue(new Error('startup sentinel'))
    const stop = vi.spyOn(server, 'stop').mockResolvedValue(undefined)

    await expect(server.start()).rejects.toThrow('startup sentinel')
    expect(stop).toHaveBeenCalledWith('STARTUP_FAILED')
  })
})
