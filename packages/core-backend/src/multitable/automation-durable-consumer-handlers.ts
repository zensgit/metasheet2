/**
 * P2 durable-delivery — slice S5: the REAL consumer handlers (production wiring).
 *
 * `automation-durable-activation.ts` defines the six-key `DurableConsumerHandlers` shape and the adapter
 * outcome mapping; this module builds the CONCRETE handlers that delegate to the exact same production
 * methods the legacy `eventBus.subscribe(...)` closures call. It is the structural close of the manifest's
 * un-enumerable direction (#4203 §293-300): every anonymous bus closure gets a named consumer_key adapter
 * whose body IS the closure's body.
 *
 * The mapping (durable consumer_key → the legacy bus subscriber it replaces):
 *   - approval-bridge          → AutomationService.handleApprovalCompletionEvent   (automation-service.ts:935)
 *   - approval-trigger         → AutomationService.handleApprovalCompletionTrigger (automation-service.ts:940)
 *   - approval-projection      → ApprovalRecordProjectionService.reconcile         (approval-record-projection-service.ts:174)
 *   - approval-task-trigger    → AutomationService.handleApprovalTaskCreatedTrigger (automation-service.ts:954)
 *   - automation-record-trigger→ AutomationService.handleEvent                     (automation-service.ts:923)
 *   - webhook-event-bridge     → WebhookService.deliverEvent (via WEBHOOK_BRIDGE_EVENT_MAP) (webhook-event-bridge.ts:78)
 *
 * A handler throwing is mapped by the activation registry to a retryable `adapter_error` (the dispatcher
 * reschedules with backoff, bounded → dead_letter) — EXCEPT a `PermanentDeliveryFailure`, which dead-letters.
 * This is intentional and matches the legacy `.catch(log)` fire-and-forget only in that both survive a bad
 * event; the durable path additionally RETRIES, so a transient failure is no longer lost. Idempotency on the
 * re-delivery is the sink's own contract (per-rule `event_fires` lease / business UNIQUE keys / idempotent
 * upsert) — the same contract the legacy path already relied on.
 *
 * Payload reconstruction: the outbox row stores the ORIGINAL event payload as jsonb, so each adapter casts
 * `event.payload` to the typed event the handler expects — the SAME object the bus delivered. For the record
 * trigger we overlay the durable row's authoritative `_eventId` / `_automationDepth` (the outbox identity is
 * the dedup + depth source of truth), so a durable re-delivery dedups on the stable original id.
 *
 * This module has NO side effects at import and touches NO flag: it is a pure builder over injected service
 * references. `bootDurableDelivery` (flag-gated) is the only thing that constructs and runs these handlers.
 */
import type { ClaimedConsumer } from './automation-durable-dispatcher'
import type { DurableConsumerHandlers } from './automation-durable-activation'
import type { AutomationEventPayload } from './automation-service'
import type { ApprovalCompletionEventV1 } from '../services/ApprovalCompletionEvent'
import type { ApprovalTaskCreatedEventV1 } from '../services/ApprovalTaskCreatedEvent'
import type { WebhookEventType } from './webhooks'
import { WEBHOOK_BRIDGE_EVENT_MAP } from './webhook-event-bridge'

/**
 * The production service surface the durable handlers delegate to — a STRUCTURAL interface (not the concrete
 * classes) so this module stays unit-testable with spies and free of the services' heavy constructor graphs.
 * The boot site (`index.ts`) passes the live singletons.
 */
export interface DurableDeliveryServices {
  automationService: {
    handleApprovalCompletionEvent(event: ApprovalCompletionEventV1): Promise<void>
    handleApprovalCompletionTrigger(event: ApprovalCompletionEventV1): Promise<void>
    handleApprovalTaskCreatedTrigger(event: ApprovalTaskCreatedEventV1): Promise<void>
    handleEvent(eventType: string, payload: AutomationEventPayload): Promise<void>
  }
  projectionService: {
    reconcile(instanceId: string): Promise<unknown>
  }
  webhookService: {
    // The durable leg passes the outbox `eventId` (3rd arg) so redelivery is idempotent per (webhook, event);
    // the legacy bus bridge omits it. Optional so a spy/legacy caller need not supply it.
    deliverEvent(event: WebhookEventType, payload: unknown, eventId?: string): Promise<unknown>
  }
}

/** Reconstruct the record-trigger payload, overlaying the durable row's authoritative identity + depth. */
function recordTriggerPayload(event: ClaimedConsumer): AutomationEventPayload {
  const base = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as AutomationEventPayload
  return { ...base, _eventId: event.eventId, _automationDepth: event.automationDepth }
}

/**
 * Build the six concrete durable consumer handlers over the live services. The result is handed to
 * `buildConsumerAdapterRegistry` / `bootDurableDelivery`, which wrap each in the ratified outcome mapping.
 */
export function buildDurableConsumerHandlers(services: DurableDeliveryServices): DurableConsumerHandlers {
  const { automationService, projectionService, webhookService } = services
  return {
    'approval-bridge': async (event: ClaimedConsumer) => {
      await automationService.handleApprovalCompletionEvent(event.payload as ApprovalCompletionEventV1)
    },
    'approval-trigger': async (event: ClaimedConsumer) => {
      await automationService.handleApprovalCompletionTrigger(event.payload as ApprovalCompletionEventV1)
    },
    'approval-projection': async (event: ClaimedConsumer) => {
      const instanceId = (event.payload as ApprovalCompletionEventV1)?.approval?.instanceId
      if (typeof instanceId !== 'string' || instanceId.length === 0) {
        // A durable approval.* row with no instanceId is a malformed producer payload — nothing to project.
        // Return (success): the projection is an idempotent upsert keyed by instanceId; there is no work to do
        // and retrying would never find one. (The legacy subscriber `return`s on the same guard.)
        return
      }
      await projectionService.reconcile(instanceId)
    },
    'approval-task-trigger': async (event: ClaimedConsumer) => {
      await automationService.handleApprovalTaskCreatedTrigger(event.payload as ApprovalTaskCreatedEventV1)
    },
    'automation-record-trigger': async (event: ClaimedConsumer) => {
      await automationService.handleEvent(event.eventType, recordTriggerPayload(event))
    },
    'webhook-event-bridge': async (event: ClaimedConsumer) => {
      const webhookEvent: WebhookEventType | undefined = WEBHOOK_BRIDGE_EVENT_MAP[event.eventType]
      if (!webhookEvent) {
        // The manifest only routes webhook-event-bridge for the four mapped families, so an unmapped type here
        // means a producer enqueued a row the manifest shouldn't have. Throw → retryable adapter_error (never a
        // silent drop): an operator sees it via the dead-letter ceiling rather than losing the delivery.
        throw new Error(`webhook-event-bridge: no webhook mapping for event type "${event.eventType}"`)
      }
      // Thread the outbox row's authoritative `eventId` so a redelivery of THIS durable row is idempotent per
      // (webhook, event) — no duplicate delivery row, no duplicate send. (The legacy bus bridge omits it.)
      await webhookService.deliverEvent(webhookEvent, event.payload, event.eventId)
    },
  }
}
