import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InMemoryDelayService } from '../../src/services/DelayService'
import { messageBus } from '../../src/integration/messaging/message-bus'

vi.mock('../../src/integration/messaging/message-bus', () => ({
  messageBus: {
    publish: vi.fn()
  }
}))

describe('InMemoryDelayService', () => {
  let service: InMemoryDelayService

  beforeEach(() => {
    vi.useFakeTimers()
    service = new InMemoryDelayService()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should schedule and deliver a message', async () => {
    const id = await service.schedule('test.topic', { foo: 'bar' }, 1000)

    expect(id).toBeDefined()
    expect(messageBus.publish).not.toHaveBeenCalled()

    // Fast forward time
    vi.advanceTimersByTime(1000)

    expect(messageBus.publish).toHaveBeenCalledWith(
      'test.topic',
      { foo: 'bar' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-delayed-id': id
        })
      })
    )
  })

  it('should cancel a scheduled message', async () => {
    const id = await service.schedule('test.topic', { foo: 'bar' }, 1000)

    const cancelled = await service.cancel(id)
    expect(cancelled).toBe(true)

    // Fast forward time
    vi.advanceTimersByTime(1000)

    expect(messageBus.publish).not.toHaveBeenCalled()
  })

  it('should return false when cancelling non-existent message', async () => {
    const cancelled = await service.cancel('non-existent')
    expect(cancelled).toBe(false)
  })
})
