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

/** Terminal + transient states of a `meta_automation_outbox_consumer` row (the per-consumer lease). */
export type OutboxConsumerStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'dead_letter'

/** The set of statuses that let a consumer's adapter resolve (event terminally handled for that consumer). */
export const RESOLVE_PERMITTING_STATUSES: ReadonlySet<OutboxConsumerStatus> = new Set([
  'done',
  'dead_letter',
])

/** A producer event row (`meta_automation_outbox`), co-committed with its source state change. */
export interface OutboxRow {
  id: string
  eventType: string
  payload: unknown
  automationDepth: number
  manifestVersion: number
  eventId: string | null
  createdAt: Date
}

/** A per-(outbox_id, consumer_key) delivery-state row (`meta_automation_outbox_consumer`). */
export interface OutboxConsumerRow {
  outboxId: string
  consumerKey: string
  status: OutboxConsumerStatus
  leaseExpiresAt: Date | null
  fence: number
  attempts: number
  lastError: string | null
  updatedAt: Date
}
