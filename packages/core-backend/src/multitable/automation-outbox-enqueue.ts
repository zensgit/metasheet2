/**
 * P2 durable-delivery — slice S4-a: producer-side atomic enqueue.
 *
 * `enqueueOutboxEvent(trx, event)` writes ONE `meta_automation_outbox` row plus one
 * `meta_automation_outbox_consumer` row per manifest-expanded consumer_key — **inside the caller's
 * transaction**. That is the whole at-least-once foundation (#4203 §producer/identity): the outbox rows
 * commit or roll back WITH the source state change (approval status write / record write / form submit), so
 * a crash before commit loses nothing (the write never happened) and a crash after commit loses nothing
 * (the rows are durable and the dispatcher drains them). REJECT/ROLLBACK paths therefore enqueue nothing by
 * construction. This applies to EVERY manifest event family, not only approval-completion (§328-333).
 *
 * Hard rules:
 *   - `trx` MUST be the transaction the source change is being written in. Passing a pool here would break
 *     atomicity silently, so the call sites (S4-b wiring) pass the same client/trx they use for the source
 *     write. (Not machine-enforceable at this seam; the crash-injection V-series (S7) proves it per site.)
 *   - An event type the manifest does not route is a HARD ERROR — silently enqueueing zero rows would be a
 *     silent miss, exactly what the lock forbids.
 *   - `eventId` is the stable ORIGINAL-event identity (dedup basis + outbound-idempotency seed). Validated
 *     non-blank (printable ASCII) here so the failure is a clear producer bug at the boundary, not a DB
 *     constraint unwind.
 *   - `automationDepth` carries the produce-side automation depth; downstream consumers inherit +1.
 *
 * Flag note: this helper has NO callers until S4-b wires the produce sites (dual-path behind
 * `AUTOMATION_DURABLE_DELIVERY_ENABLED`). Landing it is behavior-neutral.
 */
import { randomUUID } from 'node:crypto'

import type { Queryable } from './automation-durable-dispatcher'
import { CURRENT_ROUTING_MANIFEST, expandConsumerKeysForEvent, type RoutingManifest } from './automation-routing-manifest'

export interface OutboxEventInput {
  /** Manifest event family, e.g. 'approval.approved' | 'multitable.record.created' | 'form.submitted'. */
  eventType: string
  /** Stable original-event identity (#4203): forwarded downstream as the per-rule dedup key. Non-blank ASCII. */
  eventId: string
  /** JSON-serializable event payload (stored as jsonb). */
  payload: unknown
  /** Producer-side automation depth (>= 0); consumers inherit +1. */
  automationDepth?: number
}

export interface EnqueuedOutboxEvent {
  outboxId: string
  eventType: string
  eventId: string
  manifestVersion: number
  consumerKeys: readonly string[]
}

const NON_BLANK_ASCII = /[!-~]/

/**
 * Atomically enqueue one producer event: the outbox row + a pending consumer row per manifest key, in the
 * caller's transaction. Returns the ids so the caller can log/correlate. Throws (aborting the caller's
 * transaction) on an unrouted event type or an invalid identity — a producer bug must fail the source write
 * loudly, never half-enqueue.
 */
export async function enqueueOutboxEvent(
  trx: Queryable,
  event: OutboxEventInput,
  manifest: RoutingManifest = CURRENT_ROUTING_MANIFEST,
): Promise<EnqueuedOutboxEvent> {
  const { eventType, eventId } = event
  if (typeof eventType !== 'string' || eventType.trim() === '') {
    throw new RangeError('enqueueOutboxEvent: eventType must be a non-empty string')
  }
  if (typeof eventId !== 'string' || !NON_BLANK_ASCII.test(eventId)) {
    throw new RangeError('enqueueOutboxEvent: eventId must be a stable non-blank identity (printable ASCII) — a blank id is un-dedupable downstream')
  }
  const depth = event.automationDepth ?? 0
  if (!Number.isSafeInteger(depth) || depth < 0) {
    throw new RangeError(`enqueueOutboxEvent: automationDepth must be a non-negative safe integer (got ${depth})`)
  }
  const consumerKeys = expandConsumerKeysForEvent(eventType, manifest)
  if (!consumerKeys || consumerKeys.length === 0) {
    throw new Error(
      `enqueueOutboxEvent: event type "${eventType}" is not routed by manifest v${manifest.version} — refusing a zero-row enqueue (silent miss)`,
    )
  }
  const outboxId = `obx_${randomUUID()}`
  await trx.query(
    `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
    [outboxId, eventType, JSON.stringify(event.payload ?? null), depth, manifest.version, eventId],
  )
  // one pending delivery row per consumer, same transaction — UNNEST keeps it a single statement.
  await trx.query(
    `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key)
     SELECT $1, k FROM unnest($2::text[]) AS k`,
    [outboxId, [...consumerKeys]],
  )
  return { outboxId, eventType, eventId, manifestVersion: manifest.version, consumerKeys }
}
