/**
 * Webhook Event Bridge
 * Wires internal EventBus events to the WebhookService delivery pipeline.
 *
 * This module subscribes to multitable EventBus topics and forwards them as
 * webhook deliveries, keeping the publish sites untouched.
 *
 * IMPORTANT — bus identity: the multitable record write path
 * (record-write-service.ts / record-service.ts) and the AutomationService both
 * emit/subscribe on the `integration/events/event-bus` singleton (the `EventBus`
 * class with `.subscribe()`), NOT the `core/EventBusService` instance. The bridge
 * MUST subscribe to that SAME bus or it never fires. We therefore default to the
 * integration eventBus and mirror AutomationService.init()'s subscription shape.
 *
 * Posture (at-least-once, fire-and-forget): `deliverEvent` persists a durable
 * delivery row BEFORE the HTTP attempt and only then fires the request without
 * awaiting it, so a crash mid-flight leaves a `pending` row the retry tick picks
 * up. The bridge subscription itself is fire-and-forget (errors are logged, never
 * propagated back to the emitting write). A full transactional outbox (emit inside
 * the write transaction) is out of scope — see the rank-5 wiring deliverable.
 */

import { eventBus as integrationEventBus } from '../integration/events/event-bus'
import type { EventBus } from '../integration/events/event-bus'
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

export interface WebhookEventBridgeOptions {
  /**
   * The bus to subscribe on. Defaults to the integration eventBus — the SAME
   * singleton the record write path emits on. Tests inject their own instance.
   */
  eventBus?: EventBus
  /**
   * The delivery service. Defaults to a WebhookService bound to the shared
   * runtime `db` (same pool the rest of the app uses). Tests inject one with a
   * mock fetch + scoped db.
   */
  webhookService?: WebhookService
  logger?: Logger
}

let initialized = false
const subscriptionIds: string[] = []

/**
 * Call once at application startup to bridge EventBus -> WebhookService.
 * Idempotent: a second call is a no-op until {@link resetWebhookEventBridgeForTests}.
 */
export function initWebhookEventBridge(options: WebhookEventBridgeOptions = {}): void {
  if (initialized) return
  initialized = true

  const bus = options.eventBus ?? integrationEventBus
  // Construct the service lazily at init time (not module load) so the bridge
  // binds to the shared runtime db rather than a stray import-time instance.
  const webhookService = options.webhookService ?? new WebhookService(db)
  const log = options.logger ?? logger

  for (const [busEvent, webhookEvent] of Object.entries(EVENT_MAP)) {
    const id = bus.subscribe(busEvent, (payload: unknown) => {
      // Fire-and-forget: deliverEvent persists a durable row before the HTTP
      // attempt, so an error here never blocks or fails the emitting write.
      webhookService.deliverEvent(webhookEvent, payload).catch((err) => {
        log.error(
          `Failed to deliver webhook for ${webhookEvent}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    })
    subscriptionIds.push(id)
    log.info(`Bridged EventBus "${busEvent}" -> Webhook "${webhookEvent}"`)
  }
}

/** Test-only: tear down subscriptions and clear the idempotency guard. */
export function resetWebhookEventBridgeForTests(bus: EventBus = integrationEventBus): void {
  for (const id of subscriptionIds) {
    try {
      bus.unsubscribe(id)
    } catch {
      // best-effort
    }
  }
  subscriptionIds.length = 0
  initialized = false
}
