/**
 * P2 durable-delivery — flag + shared types (slice S1, foundational).
 *
 * The automation completion→delivery chain is moving from the crash-lossy `commit-then-emit` +
 * terminal-claim design onto a transactional outbox (`meta_automation_outbox`) drained by a durable
 * dispatcher that directly `await`s named consumer adapters, per FWB-0 lock #4203 Layer 1 and the
 * approval-line plan #4239.
 *
 * This module is the **flag gate + row shapes** only. The dispatcher (S2), the versioned routing manifest
 * (S3), the producer-side atomic enqueue (S4), and the consumer adapters (S5) are separate slices. Nothing
 * here has any side effect; while `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF (the default) the outbox
 * tables are never read or written, so behavior is byte-for-byte unchanged from today.
 */

/**
 * Master gate for the whole P2 durable-delivery runtime. **Default OFF.** Enabled only when the env var is
 * exactly the string `true` after trim + lowercase — matching the repo's other default-OFF runtime flags
 * (e.g. `MULTITABLE_ENABLE_PIT_RESET`). No slice of the durable path may run while this is OFF.
 */
export function isDurableDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.AUTOMATION_DURABLE_DELIVERY_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/**
 * Thrown by a durable sink when ANOTHER worker holds a LIVE lease on the work this delivery names (the
 * outbox-lease-vs-sink-lease composed-timing hole, sink-recoverability audit 2026-07-17): the delivery must
 * NOT resolve `done` (that would permanently drop the crashed holder's work) and must NOT run (that would
 * double-run a live holder). The consumer adapter maps any handler throw to a retryable `adapter_error`, so
 * the dispatch loop redelivers with backoff — by which time the sink lease has expired (reclaim) or been
 * resolved (`done`). Values-free by construction: carries key identities only.
 */
export class DurableSinkBusyError extends Error {
  constructor(sink: string, key: string) {
    super(`durable sink busy (live lease held elsewhere): ${sink} ${key}`)
    this.name = 'DurableSinkBusyError'
  }
}

/**
 * States of a `meta_automation_outbox_consumer` row (the per-consumer lease). There is deliberately NO
 * persistent `failed` state: a transient failure only bumps `attempts` and leaves the row reclaimable (its
 * lease expires and the next claimer reclaims it); bounded-attempts-exhausted goes straight to the terminal
 * `dead_letter`. So every non-terminal state (`pending`, `in_progress`) is reclaimable and every terminal
 * state is resolve-permitting — a row can never get stuck.
 */
export type OutboxConsumerStatus = 'pending' | 'in_progress' | 'done' | 'dead_letter'

/** The two terminal statuses that let a consumer's adapter resolve (event terminally handled for it). */
export const RESOLVE_PERMITTING_STATUSES: ReadonlySet<OutboxConsumerStatus> = new Set([
  'done',
  'dead_letter',
])

/**
 * A producer event row (`meta_automation_outbox`), co-committed with its source state change.
 *
 * `eventId` is **non-nullable** (`string`): it is the stable ORIGINAL-event identity (#4203 §producer/identity)
 * the dispatcher forwards downstream as the per-rule `event_fires` dedup key and the seed for outbound
 * idempotency keys — a NULL identity would break cutover-window dedup and outbound idempotency. It is NOT
 * unique (the outbox tolerates the cutover's transient double-emit; dedup happens at the sink, not here).
 */
export interface OutboxRow {
  id: string
  eventType: string
  payload: unknown
  automationDepth: number
  manifestVersion: number
  eventId: string
  createdAt: Date
}

/**
 * A per-(outbox_id, consumer_key) delivery-state row (`meta_automation_outbox_consumer`).
 *
 * `fence` is a **`string`, not a `number`**: the column is `bigint`, and node-postgres returns bigint as a
 * string to avoid the JS-number 2^53 precision cliff (the S1 real-DB golden asserts `fence: '0'`). S2's
 * increment/CAS must treat it as a decimal string (`fence = fence + 1` server-side; compare with the claimed
 * string), never coerce it through a JS `number`.
 */
export interface OutboxConsumerRow {
  outboxId: string
  consumerKey: string
  status: OutboxConsumerStatus
  leaseExpiresAt: Date | null
  fence: string
  attempts: number
  lastError: string | null
  updatedAt: Date
}
