/**
 * Webhook Event Bridge
 * Wires internal EventBus events to the WebhookService delivery pipeline.
 *
 * This module subscribes to multitable EventBus topics and forwards them
 * as webhook deliveries, keeping the publish sites untouched.
 */

import { eventBus } from '../core/EventBusService'
import { Logger } from '../core/logger'
import { WebhookService } from './webhook-service'
import { db } from '../db/db'
import type { WebhookEventType } from './webhooks'

const logger = new Logger('WebhookEventBridge')

/**
 * Map internal event names (as published on the EventBus) to webhook event types.
 */
const EVENT_MAP: Record<string, WebhookEventType> = {
  'multitable.record.created': 'record.created',
  'multitable.record.updated': 'record.updated',
  'multitable.record.deleted': 'record.deleted',
  'multitable.comment.created': 'comment.created',
}

let initialized = false
const webhookService = new WebhookService(db)

/**
 * Call once at application startup to bridge EventBus -> WebhookService.
 */
export function initWebhookEventBridge(): void {
  if (initialized) return
  initialized = true

  for (const [busEvent, webhookEvent] of Object.entries(EVENT_MAP)) {
    eventBus.on(busEvent, (payload: unknown) => {
      webhookService.deliverEvent(webhookEvent, payload).catch((err) => {
        logger.error(
          `Failed to deliver webhook for ${webhookEvent}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    })
    logger.info(`Bridged EventBus "${busEvent}" -> Webhook "${webhookEvent}"`)
  }
}
