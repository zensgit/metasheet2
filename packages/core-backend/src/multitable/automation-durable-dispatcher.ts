/**
 * P2 durable-delivery — slice S2-a: the claim engine (fence-CAS).
 *
 * The durable dispatcher drains `meta_automation_outbox_consumer` rows by CLAIMING each reclaimable row
 * (pending, or in_progress past a stale lease), invoking its consumer adapter (S5), then resolving the row
 * — `complete` (→ done), `poison` (→ dead_letter, bounded attempts exhausted), or `release` (→ pending,
 * a transient failure that stays reclaimable). This module is those four primitives only; the poll+dispatch
 * loop and the adapter wiring are S2-b / S5.
 *
 * Concurrency contract (mirrors the proven AttendanceNotificationDeliveryWorker):
 *   - CLAIM is a single atomic `FOR UPDATE SKIP LOCKED` CTE: it flips the row to `in_progress`, stamps a
 *     fresh lease, **increments `fence` (the monotonic claim token)** and **increments `attempts` AT CLAIM**
 *     (so a worker that always crashes after claiming still drives the row toward `dead_letter`). Two workers
 *     never claim the same row — SKIP LOCKED hands each a disjoint set.
 *   - Every resolve is a **fence-CAS**: `WHERE ... AND fence = <claimed fence> AND status = 'in_progress'`.
 *     A "zombie" (a live worker whose lease expired and was reclaimed by another) still holds the OLD fence,
 *     so its write matches 0 rows and is a silent no-op — the reclaimer (new fence) owns the row. This is why
 *     `fence` is a bigint carried as a `string`: never coerce it through a JS number (2^53).
 *   - Terminal/reclaim writes clear the lease in the SAME UPDATE that changes status, upholding the
 *     `lease ⟺ in_progress` biconditional CHECK at every commit boundary.
 *
 * Nothing here runs while `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF — these are pure primitives with no
 * caller until the S2-b loop is wired behind the flag.
 */
import type { OutboxConsumerStatus } from './automation-durable-delivery'

/** Minimal query surface — a pg Pool or a checked-out client both satisfy it (keeps the engine testable). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/** Default attempt ceiling before a consumer row is poisoned to `dead_letter`. */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 8

/** A row claimed for dispatch — carries the claim `fence` (the CAS token) and the joined outbox event. */
export interface ClaimedConsumer {
  outboxId: string
  consumerKey: string
  /** post-increment claim token (bigint as string — never a JS number). */
  fence: string
  /** post-increment attempt count for THIS claim (>= 1). */
  attempts: number
  eventType: string
  eventId: string
  payload: unknown
  automationDepth: number
  manifestVersion: number
}

export interface ClaimOptions {
  /** max rows to claim in one batch (default 50). */
  batchSize?: number
  /** lease duration in ms (default 30_000). */
  leaseMs?: number
  /** restrict the claim to specific consumer_keys (default: all). */
  consumerKeys?: string[]
  /** injectable clock for tests. */
  now?: () => Date
}

const nowIso = (opts: { now?: () => Date }): string => (opts.now?.() ?? new Date()).toISOString()

/**
 * Atomically claim reclaimable consumer rows: `pending`, or `in_progress` whose lease has expired. Flips each
 * to `in_progress` with a fresh lease, bumps `fence` and `attempts`, and returns the claim token + the joined
 * outbox event. `FOR UPDATE SKIP LOCKED` guarantees disjoint claims across concurrent workers.
 */
export async function claimDueConsumers(db: Queryable, opts: ClaimOptions = {}): Promise<ClaimedConsumer[]> {
  const asOf = nowIso(opts)
  const batchSize = opts.batchSize ?? 50
  const leaseMs = opts.leaseMs ?? 30_000
  const keys = opts.consumerKeys ?? null
  const { rows } = await db.query(
    `WITH claim AS (
       SELECT c.outbox_id, c.consumer_key
         FROM meta_automation_outbox_consumer c
        WHERE (
                c.status = 'pending'
             OR (c.status = 'in_progress' AND c.lease_expires_at <= $1::timestamptz)
              )
          AND ($4::text[] IS NULL OR c.consumer_key = ANY($4::text[]))
        ORDER BY c.updated_at ASC
        LIMIT $2::int
        FOR UPDATE SKIP LOCKED
     ),
     claimed AS (
       UPDATE meta_automation_outbox_consumer c
          SET status = 'in_progress',
              lease_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
              fence = c.fence + 1,
              attempts = c.attempts + 1,
              updated_at = $1::timestamptz
         FROM claim
        WHERE c.outbox_id = claim.outbox_id AND c.consumer_key = claim.consumer_key
       RETURNING c.outbox_id, c.consumer_key, c.fence::text AS fence, c.attempts
     )
     SELECT cl.outbox_id       AS outbox_id,
            cl.consumer_key    AS consumer_key,
            cl.fence           AS fence,
            cl.attempts        AS attempts,
            o.event_type       AS event_type,
            o.event_id         AS event_id,
            o.payload          AS payload,
            o.automation_depth AS automation_depth,
            o.manifest_version AS manifest_version
       FROM claimed cl
       JOIN meta_automation_outbox o ON o.id = cl.outbox_id
      ORDER BY o.created_at ASC`,
    [asOf, batchSize, leaseMs, keys],
  )
  return rows.map((r) => ({
    outboxId: String(r.outbox_id),
    consumerKey: String(r.consumer_key),
    fence: String(r.fence), // bigint text — keep as string
    attempts: Number(r.attempts), // int — safe as number
    eventType: String(r.event_type),
    eventId: String(r.event_id),
    payload: r.payload,
    automationDepth: Number(r.automation_depth),
    manifestVersion: Number(r.manifest_version),
  }))
}

/** fence-CAS UPDATE shared by every resolve: writes only if the caller still holds the claim (fence match). */
async function casResolve(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  status: Extract<OutboxConsumerStatus, 'done' | 'dead_letter' | 'pending'>,
  lastError: string | null,
  asOf: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET status = $4,
            lease_expires_at = NULL,
            last_error = $5,
            updated_at = $6::timestamptz
      WHERE outbox_id = $1
        AND consumer_key = $2
        AND fence = $3::bigint
        AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, status, lastError, asOf],
  )
  return Number(res.rowCount ?? 0) === 1
}

/**
 * Terminal success: → `done`, lease cleared. Returns false if the caller lost the lease (a zombie whose
 * fence was superseded by a reclaimer) — its write matched 0 rows and did nothing.
 */
export function completeConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  return casResolve(db, outboxId, consumerKey, fence, 'done', null, nowIso(opts))
}

/**
 * Terminal poison: → `dead_letter`, lease cleared (attempts exhausted). Returns false on a lost lease.
 */
export function poisonConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  error: string,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  return casResolve(db, outboxId, consumerKey, fence, 'dead_letter', error.slice(0, 1000), nowIso(opts))
}

/**
 * Non-terminal release after a transient failure: → `pending`, lease cleared, so the row is immediately
 * reclaimable by the next batch. `attempts` was already bumped at claim, so this does NOT re-increment it —
 * the row still marches toward the poison ceiling. Returns false on a lost lease.
 */
export function releaseConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  error: string,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  return casResolve(db, outboxId, consumerKey, fence, 'pending', error.slice(0, 1000), nowIso(opts))
}

/**
 * Decide how a claimed row resolves after its adapter runs, given the post-claim `attempts` and the ceiling.
 * Success → complete. Failure with attempts remaining → release (retry). Failure at/over the ceiling →
 * poison. Kept pure so the S2-b loop's branching is unit-testable without a DB.
 */
export function resolveDisposition(
  outcome: 'success' | 'failure',
  attempts: number,
  maxAttempts: number = DEFAULT_MAX_DELIVERY_ATTEMPTS,
): 'complete' | 'release' | 'poison' {
  if (outcome === 'success') return 'complete'
  return attempts >= maxAttempts ? 'poison' : 'release'
}
