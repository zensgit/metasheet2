/**
 * P2 durable-delivery — slice S2-a: the claim engine (fence-CAS).
 *
 * The durable dispatcher drains `meta_automation_outbox_consumer` rows by CLAIMING each reclaimable row,
 * invoking its consumer adapter (S5), then resolving it. This module is those primitives only; the
 * poll+dispatch loop and the adapters are S2-b / S5.
 *
 * Correctness contract (mirrors the proven AttendanceNotificationDeliveryWorker + FWB-0 lock #4203 Layer 1):
 *   - CLAIM is a single atomic `FOR UPDATE SKIP LOCKED` CTE that also enforces the poison ceiling. For a
 *     reclaimable row (pending, or in_progress past a stale lease):
 *       · attempts < maxAttempts → flip to `in_progress`, stamp a fresh lease, bump `fence` (the monotonic
 *         claim token) and `attempts` (AT CLAIM), and hand it out for dispatch;
 *       · attempts ≥ maxAttempts → **poison it to `dead_letter` right here** and DON'T dispatch it.
 *     Poisoning at claim time (driven only by the persisted `attempts`) is what makes the ceiling
 *     **crash-safe**: a worker that always crashes AFTER claiming never runs a resolve path, yet the row
 *     still terminates — the next reclaim finds `attempts ≥ maxAttempts` and dead-letters it. "非无限
 *     reclaim" (#4203 §poison-terminal). SKIP LOCKED hands concurrent workers disjoint rows.
 *   - Every resolve is a **fence-CAS** (`WHERE ... AND fence = <claimed> AND status = 'in_progress'`): a
 *     "zombie" whose lease was reclaimed holds a stale fence, so its write matches 0 rows (silent no-op)
 *     while the reclaimer (new fence) owns the row. `fence` is a bigint carried as a `string` (never a JS
 *     number — 2^53).
 *   - A retryable failure does NOT flip the row back to an immediately-reclaimable state — that would spin
 *     retries with no backoff and burn the ceiling in a tight loop. Instead `reschedule` keeps the row
 *     `in_progress` and pushes its lease out by a backoff, so it is re-claimed only AFTER the lease expires
 *     (#4203 §"租约过期后被 reclaim"). Terminal/lease writes preserve the `lease ⟺ in_progress` biconditional.
 *   - Failure detail is NEVER persisted verbatim (a raw adapter error can carry a secret-shaped URL/token).
 *     Resolves take a typed, values-free `DeliveryFailureReason` code, and only the code reaches the DB.
 *
 * Nothing here runs while `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF — pure primitives with no caller
 * until the S2-b loop is wired behind the flag.
 */
import type { OutboxConsumerStatus } from './automation-durable-delivery'

/** Minimal query surface — a pg Pool wrapper or a checked-out client both satisfy it (keeps the engine testable). */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

/** Default attempt ceiling before a consumer row is poisoned to `dead_letter`. */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 8

/**
 * The ONLY strings that may land in `last_error` — a closed, values-free vocabulary so a raw adapter error
 * (which can embed a secret-shaped URL/token) is never persisted verbatim. The dispatch loop maps an
 * adapter outcome to one of these codes; the real detail belongs in redacted structured logs, not this row.
 */
export type DeliveryFailureReason =
  | 'adapter_error'
  | 'adapter_timeout'
  | 'permanent_rejection'
  | 'max_attempts_exhausted'
  | 'unknown'

/** The closed set of legal reason codes — enforced at RUNTIME so even an untyped caller can't persist a raw
 *  (possibly secret-bearing) string. Values-free by construction, not just by the TS type. */
const ALLOWED_FAILURE_REASONS: ReadonlySet<string> = new Set<DeliveryFailureReason>([
  'adapter_error',
  'adapter_timeout',
  'permanent_rejection',
  'max_attempts_exhausted',
  'unknown',
])

function assertReason(reason: DeliveryFailureReason): void {
  if (!ALLOWED_FAILURE_REASONS.has(reason)) {
    throw new RangeError('last_error must be a values-free DeliveryFailureReason code, not a raw message')
  }
}

/** A row claimed for dispatch — carries the claim `fence` (the CAS token) and the joined outbox event. */
export interface ClaimedConsumer {
  outboxId: string
  consumerKey: string
  /** post-increment claim token (bigint as string — never a JS number). */
  fence: string
  /** post-increment attempt count for THIS claim (1..maxAttempts). */
  attempts: number
  eventType: string
  eventId: string
  payload: unknown
  automationDepth: number
  manifestVersion: number
}

export interface ClaimOptions {
  /** max rows to claim in one batch (default 50). must be > 0. */
  batchSize?: number
  /** lease duration in ms (default 30_000). must be > 0 — a non-positive lease would be born already
   *  expired, making the row instantly reclaimable and spinning claims with no backoff. */
  leaseMs?: number
  /** attempt ceiling; a row that has already been attempted this many times is poisoned at claim (default 8). must be >= 1. */
  maxAttempts?: number
  /** restrict the claim to specific consumer_keys (default: all). */
  consumerKeys?: string[]
  /** injectable clock for tests. */
  now?: () => Date
}

const nowIso = (opts: { now?: () => Date }): string => (opts.now?.() ?? new Date()).toISOString()

function requirePositive(name: string, value: number, min = 1): void {
  if (!Number.isFinite(value) || value < min) {
    throw new RangeError(`${name} must be a finite number >= ${min} (got ${value})`)
  }
}

/**
 * Atomically claim reclaimable consumer rows and poison any that have hit the attempt ceiling. Returns the
 * rows actually handed out for dispatch (in_progress) with their claim token + joined outbox event; poisoned
 * rows are terminated in the same statement and NOT returned. `FOR UPDATE SKIP LOCKED` gives concurrent
 * workers disjoint rows.
 */
export async function claimDueConsumers(db: Queryable, opts: ClaimOptions = {}): Promise<ClaimedConsumer[]> {
  const asOf = nowIso(opts)
  const batchSize = opts.batchSize ?? 50
  const leaseMs = opts.leaseMs ?? 30_000
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS
  requirePositive('batchSize', batchSize)
  requirePositive('leaseMs', leaseMs)
  requirePositive('maxAttempts', maxAttempts)
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
     resolved AS (
       UPDATE meta_automation_outbox_consumer c
          -- attempts >= ceiling → poison to dead_letter (crash-safe, no worker needed); else claim.
          SET status = CASE WHEN c.attempts >= $5::int THEN 'dead_letter' ELSE 'in_progress' END,
              lease_expires_at = CASE WHEN c.attempts >= $5::int THEN NULL
                                      ELSE $1::timestamptz + ($3::int * interval '1 millisecond') END,
              fence = CASE WHEN c.attempts >= $5::int THEN c.fence ELSE c.fence + 1 END,
              attempts = CASE WHEN c.attempts >= $5::int THEN c.attempts ELSE c.attempts + 1 END,
              last_error = CASE WHEN c.attempts >= $5::int THEN 'max_attempts_exhausted' ELSE c.last_error END,
              updated_at = $1::timestamptz
         FROM claim
        WHERE c.outbox_id = claim.outbox_id AND c.consumer_key = claim.consumer_key
       RETURNING c.outbox_id, c.consumer_key, c.fence::text AS fence, c.attempts, c.status
     )
     SELECT r.outbox_id       AS outbox_id,
            r.consumer_key    AS consumer_key,
            r.fence           AS fence,
            r.attempts        AS attempts,
            o.event_type      AS event_type,
            o.event_id        AS event_id,
            o.payload         AS payload,
            o.automation_depth AS automation_depth,
            o.manifest_version AS manifest_version
       FROM resolved r
       JOIN meta_automation_outbox o ON o.id = r.outbox_id
      WHERE r.status = 'in_progress'   -- poisoned rows are terminated, not dispatched
      ORDER BY o.created_at ASC`,
    [asOf, batchSize, leaseMs, keys, maxAttempts],
  )
  return rows.map((r) => ({
    outboxId: String(r.outbox_id),
    consumerKey: String(r.consumer_key),
    fence: String(r.fence),
    attempts: Number(r.attempts),
    eventType: String(r.event_type),
    eventId: String(r.event_id),
    payload: r.payload,
    automationDepth: Number(r.automation_depth),
    manifestVersion: Number(r.manifest_version),
  }))
}

/**
 * Terminal success: → `done`, lease cleared. Returns false if the caller lost the lease (a zombie whose
 * fence was superseded by a reclaimer) — its write matched 0 rows and did nothing.
 */
export async function completeConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET status = 'done', lease_expires_at = NULL, last_error = NULL, updated_at = $4::timestamptz
      WHERE outbox_id = $1 AND consumer_key = $2 AND fence = $3::bigint AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, nowIso(opts)],
  )
  return Number(res.rowCount ?? 0) === 1
}

/**
 * Terminal poison for a DETERMINISTIC permanent failure: → `dead_letter`, lease cleared. (Attempt-exhaustion
 * poison is handled at claim, not here.) Returns false on a lost lease. `reason` is a values-free code.
 */
export async function poisonConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  reason: DeliveryFailureReason,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  assertReason(reason)
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET status = 'dead_letter', lease_expires_at = NULL, last_error = $4, updated_at = $5::timestamptz
      WHERE outbox_id = $1 AND consumer_key = $2 AND fence = $3::bigint AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, reason, nowIso(opts)],
  )
  return Number(res.rowCount ?? 0) === 1
}

/**
 * Non-terminal retry after a TRANSIENT failure: the row STAYS `in_progress` and its lease is pushed out by
 * `retryDelayMs` (a backoff), so it is re-claimed only after the lease expires — never immediately. `attempts`
 * was already bumped at claim (so the row still marches toward the ceiling); this does not touch it. Returns
 * false on a lost lease. `reason` is a values-free code.
 */
export async function rescheduleConsumer(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  retryDelayMs: number,
  reason: DeliveryFailureReason,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  requirePositive('retryDelayMs', retryDelayMs)
  assertReason(reason)
  const asOf = nowIso(opts)
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET lease_expires_at = $4::timestamptz + ($5::int * interval '1 millisecond'),
            last_error = $6,
            updated_at = $4::timestamptz
      WHERE outbox_id = $1 AND consumer_key = $2 AND fence = $3::bigint AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, asOf, retryDelayMs, reason],
  )
  return Number(res.rowCount ?? 0) === 1
}

/**
 * Map an adapter outcome to a resolve action. Attempt-exhaustion is NOT an outcome here — it is enforced at
 * claim (crash-safe), so a plain `retryable_failure` at the ceiling is still `reschedule` and the next claim
 * poisons it. Kept pure so the S2-b loop's branching is unit-testable without a DB.
 */
export function resolveDisposition(
  outcome: 'success' | 'retryable_failure' | 'permanent_failure',
): 'complete' | 'reschedule' | 'poison' {
  switch (outcome) {
    case 'success':
      return 'complete'
    case 'retryable_failure':
      return 'reschedule'
    case 'permanent_failure':
      return 'poison'
  }
}

// Re-exported for callers that narrow on the shared status union.
export type { OutboxConsumerStatus }
