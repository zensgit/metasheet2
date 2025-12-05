import { randomUUID } from 'crypto'
import { coreMetrics } from '../metrics/metrics'
import { delayService } from '../../services/DelayService'
import { dlqService } from '../../services/DeadLetterQueueService'
import { BackoffStrategy } from '../../utils/BackoffStrategy'
import type { BackoffOptions } from '../../utils/BackoffStrategy'
import { Logger } from '../../core/logger'

const logger = new Logger('MessageBus')

export type MessagePriority = 'low' | 'normal' | 'high'

interface PublishOptions {
  priority?: MessagePriority
  correlationId?: string
  replyTo?: string
  maxRetries?: number
  timeoutMs?: number // for request/reply
  expiryMs?: number // relative milliseconds until expiry
  expiresAt?: number // absolute epoch ms; overrides expiryMs
  delay?: number // delay in ms
  backoff?: BackoffOptions
  headers?: Record<string, unknown>
}

interface InternalMessage<T = unknown> {
  id: string
  topic: string
  payload: T
  priority: MessagePriority
  attempts: number
  maxRetries: number
  correlationId?: string
  replyTo?: string
  source?: string
  createdAt: number
  expiresAt?: number
  backoff?: BackoffOptions
  headers?: Record<string, unknown>
}

type Handler<T = unknown, R = unknown> = (msg: InternalMessage<T>) => Promise<R> | R

interface Subscription {
  id: string
  topic: string
  handler: Handler<unknown, unknown>
  plugin?: string
}

interface PendingRpc<T = unknown> {
  resolve: (value: T) => void
  reject: (reason?: Error) => void
  timeout: NodeJS.Timeout
}

class MessageBus {
  private subs: Map<string, Subscription[]> = new Map()
  private patternSubs: { id: string; pattern: string; regex: RegExp; handler: Handler<unknown, unknown>; plugin?: string }[] = []
  private queue: InternalMessage[] = []
  private processing = false
  private pendingRpc: Map<string, PendingRpc> = new Map()
  private defaultRetries = 2

  subscribe<T = unknown, R = unknown>(topic: string, handler: Handler<T, R>, plugin?: string): string {
    const sub: Subscription = { id: `sub_${randomUUID()}`, topic, handler: handler as Handler<unknown, unknown>, plugin }
    if (!this.subs.has(topic)) this.subs.set(topic, [])
    this.subs.get(topic)!.push(sub)
    return sub.id
  }

  /**
   * Pattern subscription (Variant 2):
   * Supported forms:
   *   - Exact topic: e.g. "order.created"
   *   - Prefix form: "prefix.*" meaning any topic beginning with `prefix.` and at least one more segment/char
   * Constraints:
   *   - Only single trailing "prefix.*" allowed
   *   - Reject multiple '*' or middle '*' usages (e.g. order.*.created)
   *   - Reject lone '*' (ambiguous / too broad)
   */
  subscribePattern<T = unknown, R = unknown>(pattern: string, handler: Handler<T, R>, plugin?: string): string {
    const stars = (pattern.match(/\*/g) || []).length
    if (pattern === '*' || pattern === '.*') {
      throw new Error('Wildcard "*" alone not supported; use specific prefix like "order.*"')
    }
    if (stars > 1 || (stars === 1 && !pattern.endsWith('.*'))) {
      throw new Error('Only single trailing prefix.* supported (e.g. "order.*")')
    }

    let regex: RegExp
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2)
      const escaped = prefix.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
      // Require at least one char after the dot
      regex = new RegExp('^' + escaped + '\\..+')
    } else {
      const escapedExact = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
      regex = new RegExp('^' + escapedExact + '$')
    }
    const id = `psub_${randomUUID()}`
    this.patternSubs.push({ id, pattern, regex, handler: handler as Handler<unknown, unknown>, plugin })
    return id
  }

  unsubscribe(subId: string): boolean {
    // exact subs
    for (const [topic, arr] of this.subs.entries()) {
      const idx = arr.findIndex(s => s.id === subId)
      if (idx >= 0) {
        arr.splice(idx, 1)
        if (arr.length === 0) this.subs.delete(topic)
        return true
      }
    }
    // pattern subs
    const pIdx = this.patternSubs.findIndex(p => p.id === subId)
    if (pIdx >= 0) { this.patternSubs.splice(pIdx, 1); return true }
    return false
  }

  unsubscribeByPlugin(plugin: string): number {
    let count = 0
    for (const arr of this.subs.values()) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].plugin === plugin) {
          arr.splice(i, 1)
          count++
        }
      }
    }
    for (let i = this.patternSubs.length - 1; i >= 0; i--) {
      if (this.patternSubs[i].plugin === plugin) { this.patternSubs.splice(i, 1); count++ }
    }
    return count
  }

  /** Track subscriptions by plugin name for lifecycle cleanup */
  subscribeWithPlugin<T = unknown, R = unknown>(topic: string, handler: Handler<T, R>, plugin: string): string {
    return this.subscribe(topic, handler, plugin)
  }

  async publish<T = unknown>(topic: string, payload: T, opts: PublishOptions = {}): Promise<string> {
    // Handle delay
    if (opts.delay && opts.delay > 0) {
      return delayService.schedule(topic, payload, opts.delay, {
        priority: opts.priority,
        headers: opts.headers
      })
    }

    const msg: InternalMessage<T> = {
      id: `msg_${randomUUID()}`,
      topic,
      payload,
      priority: opts.priority || 'normal',
      attempts: 0,
      maxRetries: opts.maxRetries ?? this.defaultRetries,
      correlationId: opts.correlationId,
      replyTo: opts.replyTo,
      createdAt: Date.now(),
      expiresAt: opts.expiresAt ?? (opts.expiryMs ? Date.now() + opts.expiryMs : undefined),
      backoff: opts.backoff,
      headers: opts.headers
    }
    // Immediate expiry short-circuit (avoid enqueuing stale messages)
    if (msg.expiresAt && msg.expiresAt <= Date.now()) {
      coreMetrics.inc('messagesExpired')
      return msg.id
    }
    this.enqueue(msg)
    this.processQueue()
    return msg.id
  }

  private enqueue(msg: InternalMessage) {
    // Insert based on priority (simple approach: unshift high, push low)
    if (msg.priority === 'high') {
      this.queue.unshift(msg)
    } else if (msg.priority === 'low') {
      this.queue.push(msg)
    } else {
      // normal -> middle: push then slight bubble behind high items
      const hiCount = this.queue.findIndex(m => m.priority !== 'high')
      if (hiCount === -1) this.queue.push(msg)
      else this.queue.splice(hiCount, 0, msg)
    }
  }

  private async processQueue() {
    if (this.processing) return
    this.processing = true
    while (this.queue.length) {
      const msg = this.queue.shift()!
      // expiry check
      if (msg.expiresAt && Date.now() >= msg.expiresAt) {
        coreMetrics.inc('messagesExpired')
        continue
      }
      const subs = this.subs.get(msg.topic)
      const matchedPatternSubs = this.patternSubs.filter(p => p.regex.test(msg.topic))
      const allSubs = [ ...(subs || []), ...matchedPatternSubs.map(p => ({ id: p.id, topic: p.pattern, handler: p.handler, plugin: p.plugin }))]
      if (allSubs.length === 0) {
        // No subscriber -> if RPC request and expecting reply -> reject
        if (msg.replyTo && msg.correlationId) {
          const pending = this.pendingRpc.get(msg.correlationId)
          pending?.reject(new Error('No subscriber for RPC target'))
          this.pendingRpc.delete(msg.correlationId)
        }
        continue
      }
      for (const sub of allSubs) {
        try {
          await sub.handler(msg)
          coreMetrics.inc('messagesProcessed')
        } catch (e) {
          msg.attempts += 1
          coreMetrics.inc('messagesRetried')
          if (msg.attempts <= msg.maxRetries) {
            // Handle backoff
            const delay = msg.backoff ? BackoffStrategy.calculate(msg.attempts, msg.backoff) : 0
            if (delay > 0) {
              delayService.schedule(msg.topic, msg.payload, delay, {
                priority: msg.priority,
                headers: { ...msg.headers, 'x-retry-attempt': msg.attempts }
              })
            } else {
              this.enqueue(msg)
            }
          } else {
            // Send to DLQ
            try {
              await dlqService.enqueue(msg.topic, msg.payload, e instanceof Error ? e : new Error(String(e)), {
                ...msg.headers,
                originalMessageId: msg.id,
                correlationId: msg.correlationId,
                attempts: msg.attempts
              })
            } catch (dlqError) {
              logger.error('Failed to enqueue to DLQ', dlqError instanceof Error ? dlqError : undefined)
            }

            if (msg.correlationId && this.pendingRpc.has(msg.correlationId)) {
              const pending = this.pendingRpc.get(msg.correlationId)!
              pending.reject(e instanceof Error ? e : new Error(String(e)))
              this.pendingRpc.delete(msg.correlationId)
            }
          }
        }
      }
    }
    this.processing = false
  }

  // RPC request
  async request<TRequest = unknown, TResponse = unknown>(topic: string, payload: TRequest, timeoutMs = 3000): Promise<TResponse> {
    const correlationId = randomUUID()
    const replyTopic = `__rpc.reply.${correlationId}`
    return new Promise<TResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(correlationId)
        coreMetrics.inc('rpcTimeouts')
        reject(new Error('RPC timeout'))
      }, timeoutMs)

      this.pendingRpc.set(correlationId, { resolve: resolve as (value: unknown) => void, reject, timeout })

      // subscribe once for reply & capture id for cleanup
      const replySubId = this.subscribe<TResponse>(replyTopic, (msg) => {
        if (msg.correlationId !== correlationId) return
        const pending = this.pendingRpc.get(correlationId)
        pending?.resolve(msg.payload as TResponse)
        if (pending) clearTimeout(pending.timeout)
        this.pendingRpc.delete(correlationId)
        this.unsubscribe(replySubId)
      })

      this.publish(topic, payload, { correlationId, replyTo: replyTopic })
    })
  }

  // Handler utility for RPC responders
  createRpcHandler<TRequest = unknown, TResponse = unknown>(
    topic: string,
    handler: (payload: TRequest) => Promise<TResponse> | TResponse,
    plugin?: string
  ): string {
    return this.subscribe<TRequest>(topic, async (msg) => {
      if (!msg.replyTo || !msg.correlationId) return
      try {
        const result = await handler(msg.payload)
        await this.publish(msg.replyTo, result, { correlationId: msg.correlationId })
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'RPC_ERROR'
        await this.publish(msg.replyTo, { error: errorMessage }, { correlationId: msg.correlationId })
      }
    }, plugin)
  }
}

export const messageBus = new MessageBus()
