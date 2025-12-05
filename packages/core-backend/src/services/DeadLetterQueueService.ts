import { db } from '../db/db'
import { toDateValue } from '../db/type-helpers'
import { metrics } from '../metrics/metrics'
import { messageBus } from '../integration/messaging/message-bus'
import { Logger } from '../core/logger'

export interface DLQEntry {
  id: string
  topic: string
  payload: unknown
  error_message: string | null
  retry_count: number
  last_retry_at: Date | null
  status: 'pending' | 'retrying' | 'resolved' | 'ignored'
  metadata: Record<string, unknown>
  created_at: Date
}

export interface DLQListOptions {
  status?: 'pending' | 'retrying' | 'resolved' | 'ignored'
  topic?: string
  limit?: number
  offset?: number
}

export class DeadLetterQueueService {
  private logger: Logger

  constructor() {
    this.logger = new Logger('DeadLetterQueueService')
  }

  /**
   * Enqueue a failed message to DLQ
   */
  async enqueue(
    topic: string,
    payload: unknown,
    error: Error,
    metadata: Record<string, unknown> = {}
  ): Promise<DLQEntry> {
    try {
      const entry = await db
        .insertInto('dead_letter_queue')
        .values({
          topic,
          payload: JSON.stringify(payload),
          error_message: error.message,
          status: 'pending',
          metadata: JSON.stringify(metadata),
          retry_count: 0
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      this.logger.warn(`Message enqueued to DLQ: ${entry.id}`, { topic, error: error.message })
      
      // Metrics
      metrics.dlqMessagesTotal.labels(topic).inc()

      return this.mapEntry(entry)
    } catch (err) {
      this.logger.error('Failed to enqueue message to DLQ', err as Error)
      throw err
    }
  }

  /**
   * Retry a message from DLQ
   */
  async retry(id: string): Promise<boolean> {
    const entry = await this.get(id)
    if (!entry) throw new Error('DLQ entry not found')

    if (entry.status === 'resolved' || entry.status === 'ignored') {
      throw new Error(`Cannot retry message with status: ${entry.status}`)
    }

    try {
      // Update status to retrying
      await db
        .updateTable('dead_letter_queue')
        .set({
          status: 'retrying',
          last_retry_at: toDateValue(new Date()),
          retry_count: entry.retry_count + 1
        })
        .where('id', '=', id)
        .execute()

      // Republish to message bus
      messageBus.publish(entry.topic, entry.payload, {
        // Add metadata to track it's a retry from DLQ
        headers: {
          ...entry.metadata,
          'x-dlq-retry-id': id,
          'x-dlq-retry-count': entry.retry_count + 1
        }
      })

      this.logger.info(`Message retried from DLQ: ${id}`)
      return true
    } catch (err) {
      this.logger.error(`Failed to retry DLQ message: ${id}`, err as Error)
      return false
    }
  }

  /**
   * Mark a message as resolved (manually handled)
   */
  async resolve(id: string): Promise<void> {
    await db
      .updateTable('dead_letter_queue')
      .set({ status: 'resolved' })
      .where('id', '=', id)
      .execute()
    
    this.logger.info(`DLQ message resolved: ${id}`)
  }

  /**
   * Mark a message as ignored (won't be retried)
   */
  async ignore(id: string): Promise<void> {
    await db
      .updateTable('dead_letter_queue')
      .set({ status: 'ignored' })
      .where('id', '=', id)
      .execute()

    this.logger.info(`DLQ message ignored: ${id}`)
  }

  /**
   * Get a single entry
   */
  async get(id: string): Promise<DLQEntry | null> {
    const entry = await db
      .selectFrom('dead_letter_queue')
      .where('id', '=', id)
      .selectAll()
      .executeTakeFirst()

    return entry ? this.mapEntry(entry) : null
  }

  /**
   * List entries
   */
  async list(options: DLQListOptions = {}): Promise<{ items: DLQEntry[]; total: number }> {
    let query = db.selectFrom('dead_letter_queue').selectAll()
    let countQuery = db.selectFrom('dead_letter_queue').select(db.fn.count('id').as('count'))

    if (options.status) {
      query = query.where('status', '=', options.status)
      countQuery = countQuery.where('status', '=', options.status)
    }

    if (options.topic) {
      query = query.where('topic', '=', options.topic)
      countQuery = countQuery.where('topic', '=', options.topic)
    }

    const totalResult = await countQuery.executeTakeFirst()
    const total = Number(totalResult?.count || 0)

    const items = await query
      .orderBy('created_at', 'desc')
      .limit(options.limit || 50)
      .offset(options.offset || 0)
      .execute()

    return {
      items: items.map(this.mapEntry),
      total
    }
  }

  /**
   * Cleanup old resolved/ignored messages
   */
  async cleanup(days: number = 30): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)

    const result = await db
      .deleteFrom('dead_letter_queue')
      .where('created_at', '<', cutoff)
      .where('status', 'in', ['resolved', 'ignored'])
      .executeTakeFirst()

    const count = Number(result.numDeletedRows)
    this.logger.info(`Cleaned up ${count} old DLQ messages`)
    return count
  }

  private mapEntry(row: Record<string, unknown>): DLQEntry {
    return {
      id: row.id as string,
      topic: row.topic as string,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload as string) : row.payload,
      error_message: row.error_message as string | null,
      retry_count: row.retry_count as number,
      last_retry_at: row.last_retry_at as Date | null,
      status: row.status as DLQEntry['status'],
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata as string) : row.metadata as Record<string, unknown>,
      created_at: row.created_at as Date
    }
  }
}

export const dlqService = new DeadLetterQueueService()
