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
 *     Cutover contract — RESOLVED to REPLACE (P1#2, per FWB0 lock §Layer-1 L318-324: flag ON ⇒ the old bus
 *     is "降级为非承重" and "稳态下双跑……都不允许存活"): every wired producer family enqueues same-txn via
 *     `automation-producer-emit.ts` and SUPPRESSES its legacy post-commit emit when the flag is ON (flag
 *     OFF ⇒ legacy emit, byte-identical). REPLACE is necessary, not stylistic — the webhook sink has no
 *     event-id dedup, so keep-both would double-deliver every webhook. An earlier draft of this header
 *     described a transitional keep-both window; that described only the pre-P1#2 state and is superseded.
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
  type DispatchLoopObserver,
  type DispatchTickOptions,
} from './automation-durable-dispatch-loop'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import type { TransactionalQueryable } from './pg-transaction-guard'

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
 * transaction client as the source state change — atomicity is the whole point (#4203 §producer/identity),
 * and it is MACHINE-ENFORCED downstream: `enqueueOutboxEvent` probes the database's own transaction state
 * (pg-transaction-guard), so a pool / autocommit client / forged marker is rejected before any write.
 */
export async function produceAutomationEvent(
  trx: TransactionalQueryable,
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
}

/**
 * Startup entry: flag OFF → null (byte-for-byte no-op); flag ON → registry + BIDIRECTIONAL manifest
 * completeness assertion (a boot misconfiguration fails loudly before any claim) + dispatch loop.
 *
 * `observer` is REQUIRED (the loop's telemetry doctrine): unknown consumer keys, tick errors, heartbeat DB
 * errors, and claim-time poisons must all be observable — the boot site wires them to real logging/metrics.
 * `db` MUST be a pg Pool (or equivalent running queries on independent connections), never a single
 * checked-out client — the loop's heartbeat renews run concurrently with adapters and resolves.
 */
export function bootDurableDelivery(
  db: Queryable,
  handlers: DurableConsumerHandlers,
  observer: DispatchLoopObserver,
  opts: BootOptions = {},
): DispatchLoopHandle | null {
  const env = opts.env ?? process.env
  if (!isDurableDeliveryEnabled(env)) return null
  const registry = buildConsumerAdapterRegistry(handlers)
  assertManifestCompleteness(registry, CURRENT_ROUTING_MANIFEST)
  return startDurableDispatchLoop(db, registry, observer, { ...opts, env })
}
