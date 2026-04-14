/**
 * Webhook Service
 * In-memory webhook management and delivery for multitable open API.
 * V1: in-memory store and delivery queue — state is lost on restart.
 */

import { createHmac, randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import type {
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookEventType,
  WebhookUpdateInput,
} from './webhooks'
import { ALL_WEBHOOK_EVENT_TYPES } from './webhooks'

const logger = new Logger('WebhookService')

const DELIVERY_TIMEOUT_MS = 5_000
const MAX_CONSECUTIVE_FAILURES = 10
const BASE_RETRY_DELAY_MS = 1_000

function generateId(): string {
  return randomBytes(16).toString('hex')
}

export class WebhookService {
  private webhooks = new Map<string, Webhook>()
  private deliveries: WebhookDelivery[] = []
  /** Pluggable fetch for testing */
  private fetchFn: typeof fetch

  constructor(fetchFn?: typeof fetch) {
    this.fetchFn = fetchFn ?? globalThis.fetch
  }

  // ─── CRUD ────────────────────────────────────────────────────────────

  createWebhook(userId: string, input: WebhookCreateInput): Webhook {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Webhook name is required')
    }
    if (!input.url || input.url.trim().length === 0) {
      throw new Error('Webhook URL is required')
    }
    try {
      const parsed = new URL(input.url)
      if (
        process.env.NODE_ENV === 'production' &&
        parsed.protocol !== 'https:'
      ) {
        throw new Error('Webhook URL must use HTTPS in production')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTPS')) throw err
      throw new Error('Webhook URL is not a valid URL')
    }
    if (!input.events || input.events.length === 0) {
      throw new Error('At least one event type is required')
    }
    for (const evt of input.events) {
      if (!ALL_WEBHOOK_EVENT_TYPES.includes(evt)) {
        throw new Error(`Unknown event type: ${evt}`)
      }
    }

    const id = generateId()
    const now = new Date().toISOString()

    const webhook: Webhook = {
      id,
      name: input.name.trim(),
      url: input.url.trim(),
      secret: input.secret,
      events: [...input.events],
      active: true,
      createdBy: userId,
      createdAt: now,
      failureCount: 0,
      maxRetries: 3,
    }

    this.webhooks.set(id, webhook)
    logger.info(`Webhook created: ${id} by user ${userId}`)
    return webhook
  }

  listWebhooks(userId: string): Webhook[] {
    const result: Webhook[] = []
    for (const wh of this.webhooks.values()) {
      if (wh.createdBy === userId) {
        result.push(wh)
      }
    }
    return result
  }

  updateWebhook(
    webhookId: string,
    userId: string,
    input: WebhookUpdateInput,
  ): Webhook {
    const wh = this.webhooks.get(webhookId)
    if (!wh) throw new Error('Webhook not found')
    if (wh.createdBy !== userId) throw new Error('Not authorized')

    if (input.name !== undefined) wh.name = input.name.trim()
    if (input.url !== undefined) {
      try {
        new URL(input.url)
      } catch {
        throw new Error('Webhook URL is not a valid URL')
      }
      wh.url = input.url.trim()
    }
    if (input.secret !== undefined) wh.secret = input.secret
    if (input.events !== undefined) wh.events = [...input.events]
    if (input.active !== undefined) wh.active = input.active
    wh.updatedAt = new Date().toISOString()

    return wh
  }

  deleteWebhook(webhookId: string, userId: string): void {
    const wh = this.webhooks.get(webhookId)
    if (!wh) throw new Error('Webhook not found')
    if (wh.createdBy !== userId) throw new Error('Not authorized')
    this.webhooks.delete(webhookId)
    logger.info(`Webhook deleted: ${webhookId} by user ${userId}`)
  }

  getWebhookById(webhookId: string): Webhook | undefined {
    return this.webhooks.get(webhookId)
  }

  // ─── Delivery ────────────────────────────────────────────────────────

  /**
   * Queue deliveries for all active webhooks subscribed to the given event type.
   */
  async deliverEvent(
    event: WebhookEventType,
    payload: unknown,
  ): Promise<WebhookDelivery[]> {
    const matching: Webhook[] = []
    for (const wh of this.webhooks.values()) {
      if (wh.active && wh.events.includes(event)) {
        matching.push(wh)
      }
    }

    const deliveries: WebhookDelivery[] = []
    for (const wh of matching) {
      const delivery = this.createDeliveryRecord(wh.id, event, payload)
      deliveries.push(delivery)
      // Fire-and-forget — do not await per delivery to avoid blocking the caller
      this.executeDelivery(delivery).catch((err) => {
        logger.error(
          `Delivery ${delivery.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }

    return deliveries
  }

  /**
   * Execute a single webhook delivery attempt.
   */
  async executeDelivery(delivery: WebhookDelivery): Promise<void> {
    const wh = this.webhooks.get(delivery.webhookId)
    if (!wh) {
      delivery.status = 'failed'
      return
    }

    const bodyStr = JSON.stringify(delivery.payload)
    const timestamp = new Date().toISOString()

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Id': wh.id,
      'X-Webhook-Event': delivery.event,
      'X-Webhook-Timestamp': timestamp,
    }

    if (wh.secret) {
      headers['X-Webhook-Signature'] = WebhookService.signPayload(
        bodyStr,
        wh.secret,
      )
    }

    delivery.attemptCount += 1

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

      const response = await this.fetchFn(wh.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      })

      clearTimeout(timer)

      delivery.httpStatus = response.status
      try {
        delivery.responseBody = await response.text()
      } catch {
        // ignore body read errors
      }

      if (response.ok) {
        delivery.status = 'success'
        delivery.deliveredAt = new Date().toISOString()
        wh.lastDeliveredAt = delivery.deliveredAt
        wh.failureCount = 0
      } else {
        this.handleDeliveryFailure(delivery, wh)
      }
    } catch (err) {
      logger.error(
        `Webhook delivery error for ${wh.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      this.handleDeliveryFailure(delivery, wh)
    }
  }

  /**
   * Retry all failed deliveries that are due for retry.
   */
  async retryFailedDeliveries(): Promise<number> {
    const now = Date.now()
    let retried = 0

    for (const delivery of this.deliveries) {
      if (delivery.status !== 'pending') continue
      if (!delivery.nextRetryAt) continue
      if (new Date(delivery.nextRetryAt).getTime() > now) continue

      const wh = this.webhooks.get(delivery.webhookId)
      if (!wh || !wh.active) {
        delivery.status = 'failed'
        continue
      }

      if (delivery.attemptCount >= wh.maxRetries) {
        delivery.status = 'failed'
        continue
      }

      await this.executeDelivery(delivery)
      retried++
    }

    return retried
  }

  /**
   * List recent deliveries for a webhook.
   */
  listDeliveries(
    webhookId: string,
    limit = 50,
  ): WebhookDelivery[] {
    return this.deliveries
      .filter((d) => d.webhookId === webhookId)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, limit)
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private createDeliveryRecord(
    webhookId: string,
    event: WebhookEventType,
    payload: unknown,
  ): WebhookDelivery {
    const delivery: WebhookDelivery = {
      id: generateId(),
      webhookId,
      event,
      payload,
      status: 'pending',
      attemptCount: 0,
      createdAt: new Date().toISOString(),
    }
    this.deliveries.push(delivery)
    return delivery
  }

  private handleDeliveryFailure(
    delivery: WebhookDelivery,
    wh: Webhook,
  ): void {
    wh.failureCount += 1

    if (wh.failureCount >= MAX_CONSECUTIVE_FAILURES) {
      wh.active = false
      delivery.status = 'failed'
      logger.warn(
        `Webhook ${wh.id} auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
      )
      return
    }

    if (delivery.attemptCount >= wh.maxRetries) {
      delivery.status = 'failed'
      return
    }

    // Exponential backoff
    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, delivery.attemptCount - 1)
    delivery.nextRetryAt = new Date(Date.now() + delay).toISOString()
    delivery.status = 'pending'
  }

  /**
   * Compute HMAC-SHA256 signature for webhook payload.
   */
  static signPayload(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex')
  }
}

/** Singleton instance for V1 in-memory usage */
export const webhookService = new WebhookService()
