/**
 * P2 durable-delivery — slices S4-b + S5: the activation seam (producer facade + consumer adapters + boot).
 *
 * This is the ONE module production code touches; everything below it (enqueue, manifest, loop, claim
 * engine) stays flag-agnostic. All three entry points are no-ops / refusals while
 * `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF, so landing this is byte-for-byte behavior-neutral.
 *
 *   - `produceAutomationEvent(trx, input)` — the produce-site seam. Call it INSIDE the same transaction as
 *     the source state change (approval status write / record write / form submit / comment). Flag ON →
 *     durable enqueue (outbox + fan-out, atomic with the source change); flag OFF → no-op returning null.
 *     Cutover contract (#4203 §316-325): call sites KEEP their legacy post-commit `eventBus.emit` in both
 *     modes for now — during the window where both paths fire, double delivery is collapsed by the SINKS'
 *     idempotency (per-rule `event_fires` dedup on the forwarded ORIGINAL `eventId`, business UNIQUE keys),
 *     which is exactly the lock's migration-safety argument. The legacy emit is demoted to non-load-bearing
 *     and removed per-site only after the 8-scenario acceptance.
 *   - `buildConsumerAdapterRegistry(handlers)` — the six ratified consumers (manifest v1 universe), each a
 *     thin adapter delegating to an injected handler (S5 wiring passes the REAL service methods —
 *     `handleApprovalCompletionResume` / `...Trigger` / projection / task / record / webhook-bridge — which
 *     structurally REPLACES the anonymous bus closures and closes the manifest's un-enumerable direction).
 *     Outcome mapping: handler resolves → success; throws `PermanentDeliveryFailure` → poison; any other
 *     throw → retryable `adapter_error` (raw message never persisted). Sink idempotency is the handlers'
 *     contract (they receive the stable original `eventId`, fence-free — the outbound-idempotency seed).
 *   - `bootDurableDelivery(db, handlers, opts)` — startup: flag OFF → returns null (nothing registered, no
 *     loop, no reads); flag ON → build registry, `assertManifestCompleteness` (bidirectional, throws on
 *     boot misconfiguration BEFORE any claim), start the dispatch loop. Returns the loop handle.
 */
import type { Queryable } from './automation-durable-dispatcher'
import type { ClaimedConsumer } from './automation-durable-dispatcher'
import { enqueueOutboxEvent, type EnqueuedOutboxEvent, type OutboxEventInput } from './automation-outbox-enqueue'
import { assertManifestCompleteness, CURRENT_ROUTING_MANIFEST } from './automation-routing-manifest'
import {
  ConsumerAdapterRegistry,
  startDurableDispatchLoop,
  type AdapterOutcome,
  type DispatchLoopHandle,
  type DispatchTickOptions,
} from './automation-durable-dispatch-loop'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'

/** Throw this from a handler to mark a DETERMINISTIC permanent failure (→ dead_letter, not retried). */
export class PermanentDeliveryFailure extends Error {}

/** One handler per ratified consumer_key (manifest v1 universe). S5 wiring passes the real service methods. */
export interface DurableConsumerHandlers {
  'approval-bridge': (event: ClaimedConsumer) => Promise<void>
  'approval-trigger': (event: ClaimedConsumer) => Promise<void>
  'approval-projection': (event: ClaimedConsumer) => Promise<void>
  'approval-task-trigger': (event: ClaimedConsumer) => Promise<void>
  'automation-record-trigger': (event: ClaimedConsumer) => Promise<void>
  'webhook-event-bridge': (event: ClaimedConsumer) => Promise<void>
}

export const DURABLE_CONSUMER_KEYS = [
  'approval-bridge',
  'approval-trigger',
  'approval-projection',
  'approval-task-trigger',
  'automation-record-trigger',
  'webhook-event-bridge',
] as const satisfies readonly (keyof DurableConsumerHandlers)[]

/**
 * Produce-site seam: durable enqueue when the flag is ON, no-op when OFF. MUST be called on the SAME
 * transaction client as the source state change — atomicity is the whole point (#4203 §producer/identity).
 */
export async function produceAutomationEvent(
  trx: Queryable,
  input: OutboxEventInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueuedOutboxEvent | null> {
  if (!isDurableDeliveryEnabled(env)) return null
  return enqueueOutboxEvent(trx, input)
}

/** Build the six-adapter registry from injected handlers, with the ratified outcome mapping. */
export function buildConsumerAdapterRegistry(handlers: DurableConsumerHandlers): ConsumerAdapterRegistry {
  const registry = new ConsumerAdapterRegistry()
  for (const key of DURABLE_CONSUMER_KEYS) {
    const handler = handlers[key]
    if (typeof handler !== 'function') {
      throw new RangeError(`bootDurableDelivery: missing handler for consumer_key "${key}"`)
    }
    registry.register({
      key,
      async handle(event): Promise<AdapterOutcome> {
        try {
          await handler(event)
          return { outcome: 'success' }
        } catch (err) {
          return err instanceof PermanentDeliveryFailure
            ? { outcome: 'permanent_failure', reason: 'permanent_rejection' }
            : { outcome: 'retryable_failure', reason: 'adapter_error' }
        }
      },
    })
  }
  return registry
}

export interface BootOptions extends DispatchTickOptions {
  intervalMs?: number
  env?: NodeJS.ProcessEnv
  onTickError?: (err: unknown) => void
}

/**
 * Startup entry: flag OFF → null (byte-for-byte no-op); flag ON → registry + BIDIRECTIONAL manifest
 * completeness assertion (a boot misconfiguration fails loudly before any claim) + dispatch loop.
 */
export function bootDurableDelivery(
  db: Queryable,
  handlers: DurableConsumerHandlers,
  opts: BootOptions = {},
): DispatchLoopHandle | null {
  const env = opts.env ?? process.env
  if (!isDurableDeliveryEnabled(env)) return null
  const registry = buildConsumerAdapterRegistry(handlers)
  assertManifestCompleteness(registry, CURRENT_ROUTING_MANIFEST)
  return startDurableDispatchLoop(db, registry, { ...opts, env })
}
