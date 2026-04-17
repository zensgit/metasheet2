/**
 * Webhook Service
 * PostgreSQL-backed webhook management and delivery for multitable open API.
 * V2: persistent store via Kysely — state survives restarts.
 */

import { createHmac, randomBytes } from 'crypto'
import type { Kysely } from 'kysely'
import { Logger } from '../core/logger'
import type { Database } from '../db/types'
import { nowTimestamp } from '../db/type-helpers'
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

/** Map a DB row to the domain Webhook. */
function rowToWebhook(row: {
  id: string
  name: string
  url: string
  secret: string | null
  events: string | string[]
  active: boolean
  created_by: string
  created_at: string | Date
  updated_at?: string | Date | null
  last_delivered_at?: string | Date | null
  failure_count: number
  max_retries: number
}): Webhook {
  const events =
    typeof row.events === 'string'
      ? (JSON.parse(row.events) as WebhookEventType[])
      : (row.events as WebhookEventType[])
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret ?? undefined,
    events,
    active: row.active,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
      : undefined,
    lastDeliveredAt: row.last_delivered_at
      ? row.last_delivered_at instanceof Date
        ? row.last_delivered_at.toISOString()
        : row.last_delivered_at
      : undefined,
    failureCount: row.failure_count,
    maxRetries: row.max_retries,
  }
}

/** Map a DB row to the domain WebhookDelivery. */
function rowToDelivery(row: {
  id: string
  webhook_id: string
  event: string
  payload: unknown
  status: string
  http_status: number | null
  response_body: string | null
  attempt_count: number
  created_at: string | Date
  delivered_at?: string | Date | null
  next_retry_at?: string | Date | null
}): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    event: row.event as WebhookEventType,
    payload: row.payload,
    status: row.status as WebhookDelivery['status'],
    httpStatus: row.http_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    attemptCount: row.attempt_count,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    deliveredAt: row.delivered_at
      ? row.delivered_at instanceof Date
        ? row.delivered_at.toISOString()
        : row.delivered_at
      : undefined,
    nextRetryAt: row.next_retry_at
      ? row.next_retry_at instanceof Date
        ? row.next_retry_at.toISOString()
        : row.next_retry_at
      : undefined,
  }
}

export class WebhookService {
  private db: Kysely<Database>
  /** Pluggable fetch for testing */
  private fetchFn: typeof fetch

  constructor(db: Kysely<Database>, fetchFn?: typeof fetch) {
    this.db = db
    this.fetchFn = fetchFn ?? globalThis.fetch
  }

  // ─── CRUD ────────────────────────────────────────────────────────────

  async createWebhook(
    userId: string,
    input: WebhookCreateInput,
  ): Promise<Webhook> {
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

    await this.db
      .insertInto('multitable_webhooks')
      .values({
        id,
        name: input.name.trim(),
        url: input.url.trim(),
        secret: input.secret ?? null,
        events: JSON.stringify([...input.events]),
        active: true,
        created_by: userId,
        created_at: now,
        failure_count: 0,
        max_retries: 3,
      })
      .execute()

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

    logger.info(`Webhook created: ${id} by user ${userId}`)
    return webhook
  }

  async listWebhooks(userId: string): Promise<Webhook[]> {
    const rows = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('created_by', '=', userId)
      .execute()

    return rows.map((r) => rowToWebhook(r as Parameters<typeof rowToWebhook>[0]))
  }

  async updateWebhook(
    webhookId: string,
    userId: string,
    input: WebhookUpdateInput,
  ): Promise<Webhook> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) throw new Error('Webhook not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    const updates: Record<string, unknown> = {
      updated_at: nowTimestamp(),
    }

    if (input.name !== undefined) updates.name = input.name.trim()
    if (input.url !== undefined) {
      try {
        new URL(input.url)
      } catch {
        throw new Error('Webhook URL is not a valid URL')
      }
      updates.url = input.url.trim()
    }
    if (input.secret !== undefined) updates.secret = input.secret
    if (input.events !== undefined) updates.events = JSON.stringify([...input.events])
    if (input.active !== undefined) updates.active = input.active

    await this.db
      .updateTable('multitable_webhooks')
      .set(updates as never)
      .where('id', '=', webhookId)
      .execute()

    // Re-read the updated row
    const updated = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirstOrThrow()

    return rowToWebhook(updated as Parameters<typeof rowToWebhook>[0])
  }

  async deleteWebhook(webhookId: string, userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) throw new Error('Webhook not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    await this.db
      .deleteFrom('multitable_webhooks')
      .where('id', '=', webhookId)
      .execute()

    logger.info(`Webhook deleted: ${webhookId} by user ${userId}`)
  }

  async getWebhookById(webhookId: string): Promise<Webhook | undefined> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) return undefined
    return rowToWebhook(row as Parameters<typeof rowToWebhook>[0])
  }

  // ─── Delivery ────────────────────────────────────────────────────────

  /**
   * Queue deliveries for all active webhooks subscribed to the given event type.
   */
  async deliverEvent(
    event: WebhookEventType,
    payload: unknown,
  ): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('active', '=', true)
      .execute()

    const matching = rows
      .map((r) => rowToWebhook(r as Parameters<typeof rowToWebhook>[0]))
      .filter((wh) => wh.events.includes(event))

    const deliveries: WebhookDelivery[] = []
    for (const wh of matching) {
      const delivery = await this.createDeliveryRecord(wh.id, event, payload)
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
    const wh = await this.getWebhookById(delivery.webhookId)
    if (!wh) {
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({ status: 'failed' })
        .where('id', '=', delivery.id)
        .execute()
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

        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({
            status: 'success',
            http_status: response.status,
            response_body: delivery.responseBody ?? null,
            attempt_count: delivery.attemptCount,
            delivered_at: nowTimestamp(),
          })
          .where('id', '=', delivery.id)
          .execute()

        await this.db
          .updateTable('multitable_webhooks')
          .set({ last_delivered_at: nowTimestamp(), failure_count: 0 })
          .where('id', '=', wh.id)
          .execute()
      } else {
        await this.handleDeliveryFailure(delivery, wh)
      }
    } catch (err) {
      logger.error(
        `Webhook delivery error for ${wh.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      await this.handleDeliveryFailure(delivery, wh)
    }
  }

  /**
   * Retry all failed deliveries that are due for retry.
   */
  async retryFailedDeliveries(): Promise<number> {
    const rows = await this.db
      .selectFrom('multitable_webhook_deliveries')
      .selectAll()
      .where('status', '=', 'pending')
      .execute()

    const now = Date.now()
    let retried = 0

    for (const row of rows) {
      const delivery = rowToDelivery(row as Parameters<typeof rowToDelivery>[0])

      if (!delivery.nextRetryAt) continue
      if (new Date(delivery.nextRetryAt).getTime() > now) continue

      const wh = await this.getWebhookById(delivery.webhookId)
      if (!wh || !wh.active) {
        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({ status: 'failed' })
          .where('id', '=', delivery.id)
          .execute()
        continue
      }

      if (delivery.attemptCount >= wh.maxRetries) {
        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({ status: 'failed' })
          .where('id', '=', delivery.id)
          .execute()
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
  async listDeliveries(
    webhookId: string,
    limit = 50,
  ): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .selectFrom('multitable_webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', webhookId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()

    return rows.map((r) =>
      rowToDelivery(r as Parameters<typeof rowToDelivery>[0]),
    )
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async createDeliveryRecord(
    webhookId: string,
    event: WebhookEventType,
    payload: unknown,
  ): Promise<WebhookDelivery> {
    const id = generateId()
    const now = new Date().toISOString()

    await this.db
      .insertInto('multitable_webhook_deliveries')
      .values({
        id,
        webhook_id: webhookId,
        event,
        payload: JSON.stringify(payload),
        status: 'pending',
        attempt_count: 0,
        created_at: now,
      })
      .execute()

    return {
      id,
      webhookId,
      event: event as WebhookEventType,
      payload,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    }
  }

  private async handleDeliveryFailure(
    delivery: WebhookDelivery,
    wh: Webhook,
  ): Promise<void> {
    const newFailureCount = wh.failureCount + 1

    if (newFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      await this.db
        .updateTable('multitable_webhooks')
        .set({ active: false, failure_count: newFailureCount })
        .where('id', '=', wh.id)
        .execute()

      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({
          status: 'failed',
          attempt_count: delivery.attemptCount,
          http_status: delivery.httpStatus ?? null,
          response_body: delivery.responseBody ?? null,
        })
        .where('id', '=', delivery.id)
        .execute()

      delivery.status = 'failed'
      logger.warn(
        `Webhook ${wh.id} auto-disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
      )
      return
    }

    await this.db
      .updateTable('multitable_webhooks')
      .set({ failure_count: newFailureCount })
      .where('id', '=', wh.id)
      .execute()

    if (delivery.attemptCount >= wh.maxRetries) {
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({
          status: 'failed',
          attempt_count: delivery.attemptCount,
          http_status: delivery.httpStatus ?? null,
          response_body: delivery.responseBody ?? null,
        })
        .where('id', '=', delivery.id)
        .execute()

      delivery.status = 'failed'
      return
    }

    // Exponential backoff
    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, delivery.attemptCount - 1)
    const nextRetry = new Date(Date.now() + delay).toISOString()
    delivery.nextRetryAt = nextRetry
    delivery.status = 'pending'

    await this.db
      .updateTable('multitable_webhook_deliveries')
      .set({
        status: 'pending',
        attempt_count: delivery.attemptCount,
        next_retry_at: nextRetry,
        http_status: delivery.httpStatus ?? null,
        response_body: delivery.responseBody ?? null,
      })
      .where('id', '=', delivery.id)
      .execute()
  }

  /**
   * Compute HMAC-SHA256 signature for webhook payload.
   */
  static signPayload(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex')
  }
}
