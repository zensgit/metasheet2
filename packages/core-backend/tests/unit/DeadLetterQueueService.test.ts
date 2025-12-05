import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeadLetterQueueService } from '../../src/services/DeadLetterQueueService'
import { messageBus } from '../../src/integration/messaging/message-bus'

// Mock dependencies
vi.mock('../../src/db/db', () => ({
  db: {
    insertInto: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returningAll: vi.fn().mockReturnThis(),
    executeTakeFirstOrThrow: vi.fn(),
    executeTakeFirst: vi.fn(),
    execute: vi.fn(),
    selectFrom: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    selectAll: vi.fn().mockReturnThis(),
    updateTable: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    deleteFrom: vi.fn().mockReturnThis(),
    fn: {
      count: vi.fn().mockReturnThis(),
      as: vi.fn().mockReturnThis()
    }
  }
}))

vi.mock('../../src/integration/messaging/message-bus', () => ({
  messageBus: {
    publish: vi.fn()
  }
}))

describe('DeadLetterQueueService', () => {
  let service: DeadLetterQueueService
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbMock: any

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new DeadLetterQueueService()
    const { db } = await import('../../src/db/db')
    dbMock = db
  })

  it('should enqueue a message', async () => {
    dbMock.executeTakeFirstOrThrow.mockResolvedValue({
      id: 'dlq-1',
      topic: 'test.topic',
      payload: JSON.stringify({ foo: 'bar' }),
      status: 'pending',
      retry_count: 0
    })

    const result = await service.enqueue(
      'test.topic',
      { foo: 'bar' },
      new Error('Test error')
    )

    expect(result.id).toBe('dlq-1')
    expect(dbMock.insertInto).toHaveBeenCalledWith('dead_letter_queue')
  })

  it('should retry a message', async () => {
    // Mock get()
    dbMock.executeTakeFirst.mockResolvedValueOnce({
      id: 'dlq-1',
      topic: 'test.topic',
      payload: JSON.stringify({ foo: 'bar' }),
      status: 'pending',
      retry_count: 0
    })

    const result = await service.retry('dlq-1')

    expect(result).toBe(true)
    expect(dbMock.updateTable).toHaveBeenCalledWith('dead_letter_queue')
    expect(messageBus.publish).toHaveBeenCalledWith(
      'test.topic',
      { foo: 'bar' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-dlq-retry-id': 'dlq-1'
        })
      })
    )
  })

  it('should resolve a message', async () => {
    await service.resolve('dlq-1')
    expect(dbMock.updateTable).toHaveBeenCalledWith('dead_letter_queue')
    expect(dbMock.set).toHaveBeenCalledWith({ status: 'resolved' })
  })

  it('should list messages', async () => {
    dbMock.executeTakeFirst.mockResolvedValueOnce({ count: 10 }) // Total count
    dbMock.execute.mockResolvedValueOnce([
      { id: 'dlq-1', payload: '{}' },
      { id: 'dlq-2', payload: '{}' }
    ]) // Items

    const result = await service.list({ status: 'pending' })

    expect(result.total).toBe(10)
    expect(result.items).toHaveLength(2)
    expect(dbMock.where).toHaveBeenCalledWith('status', '=', 'pending')
  })
})
