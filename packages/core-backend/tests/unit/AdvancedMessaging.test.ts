import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { messageBus } from '../../src/integration/messaging/message-bus'
import { dlqService } from '../../src/services/DeadLetterQueueService'
import { delayService } from '../../src/services/DelayService'

// Mock DLQ service
vi.mock('../../src/services/DeadLetterQueueService', () => ({
  dlqService: {
    enqueue: vi.fn()
  }
}))

// Mock Delay service
// We need to mock schedule but also allow it to call back messageBus.publish if we want to test backoff
// But for unit testing messageBus, we can just verify schedule is called
vi.mock('../../src/services/DelayService', () => ({
  delayService: {
    schedule: vi.fn().mockResolvedValue('delayed-id')
  }
}))

describe('Advanced Messaging', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset message bus state if possible, or just use unique topics
  })

  it('should send to DLQ after max retries', async () => {
    const topic = 'test.dlq'
    const payload = { foo: 'bar' }
    const error = new Error('Processing failed')

    // Handler that always fails
    messageBus.subscribe(topic, async () => {
      throw error
    })

    await messageBus.publish(topic, payload, { maxRetries: 2 })

    // Wait for processing (it's async)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(dlqService.enqueue).toHaveBeenCalledWith(
      topic,
      payload,
      error,
      expect.objectContaining({
        attempts: 3 // Initial + 2 retries
      })
    )
  })

  it('should schedule retry with backoff', async () => {
    const topic = 'test.backoff'
    const payload = { foo: 'bar' }

    messageBus.subscribe(topic, async () => {
      throw new Error('Fail')
    })

    await messageBus.publish(topic, payload, {
      maxRetries: 2,
      backoff: { type: 'fixed', initialDelay: 1000 }
    })

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 50))

    // Should have scheduled a retry
    expect(delayService.schedule).toHaveBeenCalledWith(
      topic,
      payload,
      1000, // Delay
      expect.any(Object)
    )
  })

  it('should schedule delayed message', async () => {
    const topic = 'test.delay'
    const payload = { foo: 'bar' }

    await messageBus.publish(topic, payload, { delay: 5000 })

    expect(delayService.schedule).toHaveBeenCalledWith(
      topic,
      payload,
      5000,
      expect.any(Object)
    )
  })
})
