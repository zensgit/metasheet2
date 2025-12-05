import { messageBus } from '../integration/messaging/message-bus'
import { Logger } from '../core/logger'
import { v4 as uuidv4 } from 'uuid'
import { metrics } from '../metrics/metrics'

export interface DelayOptions {
  headers?: Record<string, unknown>
  priority?: 'low' | 'normal' | 'high'
}

export interface DelayedMessage {
  id: string
  topic: string
  payload: unknown
  dueAt: number
  options?: DelayOptions
  timeoutId?: NodeJS.Timeout
}

export interface IDelayService {
  schedule(topic: string, payload: unknown, delayMs: number, options?: DelayOptions): Promise<string>
  cancel(id: string): Promise<boolean>
}

export class InMemoryDelayService implements IDelayService {
  private messages = new Map<string, DelayedMessage>()
  private logger: Logger

  constructor() {
    this.logger = new Logger('InMemoryDelayService')
  }

  async schedule(
    topic: string,
    payload: unknown,
    delayMs: number,
    options?: DelayOptions
  ): Promise<string> {
    const id = uuidv4()
    const dueAt = Date.now() + delayMs

    const message: DelayedMessage = {
      id,
      topic,
      payload,
      dueAt,
      options
    }

    // Schedule delivery
    const timeoutId = setTimeout(() => {
      this.deliver(id)
    }, delayMs)

    message.timeoutId = timeoutId
    this.messages.set(id, message)

    this.logger.debug(`Scheduled message ${id} for topic ${topic} in ${delayMs}ms`)
    metrics.delayedMessagesTotal.labels(topic).inc()
    return id
  }

  async cancel(id: string): Promise<boolean> {
    const message = this.messages.get(id)
    if (!message) return false

    if (message.timeoutId) {
      clearTimeout(message.timeoutId)
    }

    this.messages.delete(id)
    this.logger.debug(`Cancelled delayed message ${id}`)
    return true
  }

  private deliver(id: string) {
    const message = this.messages.get(id)
    if (!message) return

    this.messages.delete(id)

    try {
      messageBus.publish(message.topic, message.payload, {
        priority: message.options?.priority,
        headers: {
          ...message.options?.headers,
          'x-delayed-id': id,
          'x-scheduled-for': message.dueAt
        }
      })
      this.logger.debug(`Delivered delayed message ${id} to topic ${message.topic}`)
    } catch (err) {
      this.logger.error(`Failed to deliver delayed message ${id}`, err as Error)
    }
  }
}

export const delayService = new InMemoryDelayService()
