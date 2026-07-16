/**
 * P2 durable-delivery — slice S2-a: the claim engine (fence-CAS).
 *
 * The durable dispatcher drains `meta_automation_outbox_consumer` rows by CLAIMING each reclaimable row,
 * invoking its consumer adapter (S5), then resolving it. This module is those primitives only; the
 * poll+dispatch loop and the adapters are S2-b / S5.
 *
 * Correctness contract (mirrors the proven AttendanceNotificationDeliveryWorker + FWB-0 lock #4203 Layer 1):
 *   - A worker claims ONLY the consumer_keys it knows — `consumerKeys` is REQUIRED and non-empty (a
 *     registry-managed allow-list). A key it doesn't recognize is never claimed, so it stays `pending`
 *     for a worker that does know it. This is the rolling-deploy contract (#4203 §246): an N-1 worker must
 *     NEVER mark an unknown-key row `done`/`dead_letter` (that silently drops an event a newer worker owns),
 *     and this "unknown → pending + alert" behavior MUST exist in the FIRST dispatcher version — a current
 *     worker won't hit unknown keys itself, but at the next version bump it becomes N-1. `findUnknownConsumerKeys`
 *     is the alert seam.
 *   - CLAIM is a single atomic `FOR UPDATE SKIP LOCKED` CTE that also enforces the poison ceiling: a
 *     reclaimable row (pending, or in_progress past a stale lease) with `attempts >= maxAttempts` is
 *     poisoned to `dead_letter` right there — driven only by the persisted `attempts`, so the ceiling is
 *     **crash-safe** (a worker that always crashes after claiming never resolves, yet the row still
 *     terminates). Otherwise it flips to `in_progress`, stamps a lease, bumps `fence` (the claim token) and
 *     `attempts` (AT CLAIM). SKIP LOCKED hands concurrent workers disjoint rows.
 *   - Every resolve is a **fence-CAS** (`WHERE ... AND fence = <claimed> AND status = 'in_progress'`): a
 *     zombie holding a superseded fence writes 0 rows. **`reschedule` and `poison`/`complete` all consume
 *     the token** — reschedule ATOMICALLY BUMPS the fence, so a late worker holding the original token can
 *     no longer complete/poison/reschedule the row. `fence` is a bigint carried as a `string` (never a JS
 *     number — 2^53).
 *   - A retryable failure keeps the row `in_progress` with the lease pushed out by a backoff (re-claimed
 *     only after expiry), never an immediately-reclaimable state (#4203 §"租约过期后被 reclaim").
 *   - Failure detail is never persisted verbatim: resolves take a typed, values-free `DeliveryFailureReason`.
 *   - Every numeric bound is a validated SAFE INTEGER within an explicit range (no fractional/huge value
 *     reaches Postgres as a runtime cast error).
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

// Explicit upper bounds so a caller bug can't push an out-of-range value into an int/interval cast.
const MAX_BATCH_SIZE = 10_000
const MAX_LEASE_MS = 86_400_000 // 24h
const MAX_DELAY_MS = 86_400_000 // 24h
const MAX_ATTEMPTS_CEILING = 10_000

/**
 * The ONLY strings that may land in `last_error` — a closed, values-free vocabulary so a raw adapter error
 * (which can embed a secret-shaped URL/token) is never persisted verbatim.
 */
export type DeliveryFailureReason =
  | 'adapter_error'
  | 'adapter_timeout'
  | 'permanent_rejection'
  | 'max_attempts_exhausted'
  | 'unknown'

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

/** Reject fractional, non-finite, out-of-safe-range, or out-of-bounds numeric params before they hit SQL. */
function requireBoundedInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer in [${min}, ${max}] (got ${value})`)
  }
}

function requireKnownKeys(consumerKeys: string[] | undefined): string[] {
  if (!Array.isArray(consumerKeys) || consumerKeys.length === 0) {
    throw new RangeError('consumerKeys is required and must be a non-empty allow-list of keys this worker knows')
  }
  return consumerKeys
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
  /** REQUIRED non-empty allow-list — the consumer_keys THIS worker knows. Unknown keys are never claimed. */
  consumerKeys: string[]
  /** max rows to claim in one batch (default 50; 1..10000). */
  batchSize?: number
  /** lease duration in ms (default 30_000; 1..86_400_000). */
  leaseMs?: number
  /** attempt ceiling; a row already attempted this many times is poisoned at claim (default 8; 1..10000). */
  maxAttempts?: number
  /**
   * Called for each row that was POISONED at claim (attempts already >= ceiling → dead_letter). Such rows are
   * NOT returned in the dispatchable list, so without this the caller cannot tell "no reclaimable candidate"
   * from "the candidate(s) were terminated" — the latter must NOT stop a per-slot poll loop (healthy rows may
   * be behind them) and the terminal transition must reach telemetry (#4334 review: claim-time poison
   * head-of-line block). Best-effort — a throwing callback never fails the claim.
   */
  onClaimTimePoison?: (info: { outboxId: string; consumerKey: string; attempts: number }) => void
  /** injectable clock for tests. */
  now?: () => Date
}

const nowIso = (opts: { now?: () => Date }): string => (opts.now?.() ?? new Date()).toISOString()

/**
 * Atomically claim reclaimable rows FOR THE GIVEN known keys, and poison any that have hit the attempt
 * ceiling. Rows whose key is not in `consumerKeys` are left untouched (they stay `pending`). Returns the
 * rows handed out for dispatch (in_progress) with their claim token + joined outbox event; rows poisoned at
 * claim (dead_letter) are NOT returned but are reported via `opts.onClaimTimePoison` so a caller can scan
 * past them (they must not stop a poll loop) and record the terminal transition.
 */
export async function claimDueConsumers(db: Queryable, opts: ClaimOptions): Promise<ClaimedConsumer[]> {
  const keys = requireKnownKeys(opts?.consumerKeys)
  const asOf = nowIso(opts)
  const batchSize = opts.batchSize ?? 50
  const leaseMs = opts.leaseMs ?? 30_000
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS
  requireBoundedInt('batchSize', batchSize, 1, MAX_BATCH_SIZE)
  requireBoundedInt('leaseMs', leaseMs, 1, MAX_LEASE_MS)
  requireBoundedInt('maxAttempts', maxAttempts, 1, MAX_ATTEMPTS_CEILING)
  const { rows } = await db.query(
    `WITH claim AS (
       SELECT c.outbox_id, c.consumer_key
         FROM meta_automation_outbox_consumer c
        WHERE (
                c.status = 'pending'
             OR (c.status = 'in_progress' AND c.lease_expires_at <= $1::timestamptz)
              )
          AND c.consumer_key = ANY($4::text[])   -- worker's known keys only; unknown keys stay pending
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
            r.status          AS status,
            o.event_type      AS event_type,
            o.event_id        AS event_id,
            o.payload         AS payload,
            o.automation_depth AS automation_depth,
            o.manifest_version AS manifest_version
       FROM resolved r
       JOIN meta_automation_outbox o ON o.id = r.outbox_id
      WHERE r.status IN ('in_progress', 'dead_letter')   -- dead_letter = poisoned at claim, reported not dispatched
      ORDER BY o.created_at ASC`,
    [asOf, batchSize, leaseMs, keys, maxAttempts],
  )
  const claimed: ClaimedConsumer[] = []
  for (const r of rows) {
    if (String(r.status) === 'dead_letter') {
      // Poisoned at claim (attempts already >= ceiling). Not dispatchable — report it so the caller keeps
      // scanning past it and the terminal transition is observable. Best-effort: never let it fail the claim.
      try {
        opts.onClaimTimePoison?.({ outboxId: String(r.outbox_id), consumerKey: String(r.consumer_key), attempts: Number(r.attempts) })
      } catch {
        /* best-effort telemetry */
      }
      continue
    }
    claimed.push({
      outboxId: String(r.outbox_id),
      consumerKey: String(r.consumer_key),
      fence: String(r.fence),
      attempts: Number(r.attempts),
      eventType: String(r.event_type),
      eventId: String(r.event_id),
      payload: r.payload,
      automationDepth: Number(r.automation_depth),
      manifestVersion: Number(r.manifest_version),
    })
  }
  return claimed
}

/**
 * Rolling-deploy alert seam: the consumer_keys of reclaimable rows that this worker does NOT know. The
 * dispatch loop alerts on these (they are stuck until a worker that knows them runs) but must NEVER claim or
 * terminate them (#4203 §246). Reclaimable-only — terminal rows are not "stuck".
 */
export async function findUnknownConsumerKeys(
  db: Queryable,
  knownKeys: string[],
  opts: { now?: () => Date } = {},
): Promise<string[]> {
  const keys = requireKnownKeys(knownKeys)
  const { rows } = await db.query(
    `SELECT DISTINCT c.consumer_key
       FROM meta_automation_outbox_consumer c
      WHERE (
              c.status = 'pending'
           OR (c.status = 'in_progress' AND c.lease_expires_at <= $1::timestamptz)
            )
        AND NOT (c.consumer_key = ANY($2::text[]))`,
    [nowIso(opts), keys],
  )
  return rows.map((r) => String(r.consumer_key))
}

/**
 * Terminal success: → `done`, lease cleared. Returns false if the caller lost the lease (a zombie or a stale
 * token superseded by a reclaim/reschedule) — its write matched 0 rows and did nothing.
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
 * poison is handled at claim, not here.) Returns false on a lost/stale token. `reason` is a values-free code.
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
 * Non-terminal retry after a TRANSIENT failure: the row STAYS `in_progress`, its lease is pushed out by
 * `retryDelayMs` (a backoff, re-claimed only after expiry), and **the fence is ATOMICALLY BUMPED** so the
 * token the caller just used is dead — a late worker holding it can no longer complete/poison/reschedule.
 * `attempts` was already bumped at claim; this does not touch it. Returns false on a lost/stale token.
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
  requireBoundedInt('retryDelayMs', retryDelayMs, 1, MAX_DELAY_MS)
  assertReason(reason)
  const asOf = nowIso(opts)
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET fence = fence + 1,
            lease_expires_at = $4::timestamptz + ($5::int * interval '1 millisecond'),
            last_error = $6,
            updated_at = $4::timestamptz
      WHERE outbox_id = $1 AND consumer_key = $2 AND fence = $3::bigint AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, asOf, retryDelayMs, reason],
  )
  return Number(res.rowCount ?? 0) === 1
}

/**
 * Renew the lease on a claimed row (the S2-b heartbeat). A **fence-CAS that does NOT bump the fence**: it
 * pushes `lease_expires_at` out by `leaseMs` only while THIS worker still holds the claim token and the row is
 * still `in_progress`. Returns false the instant the worker has lost the row — a concurrent reclaim bumped the
 * fence, or the row already reached a terminal status. The S2-b loop calls this PERIODICALLY while a long
 * adapter runs (a heartbeat), so a still-running delivery keeps its hold and a mid-flight reclaim aborts the
 * in-flight work. Unlike `rescheduleConsumer`, renewing keeps the same fence: the worker is extending its own
 * hold, not handing the row off.
 */
export async function renewConsumerLease(
  db: Queryable,
  outboxId: string,
  consumerKey: string,
  fence: string,
  leaseMs: number,
  opts: { now?: () => Date } = {},
): Promise<boolean> {
  requireBoundedInt('leaseMs', leaseMs, 1, MAX_LEASE_MS)
  const asOf = nowIso(opts)
  const res = await db.query(
    `UPDATE meta_automation_outbox_consumer
        SET lease_expires_at = $4::timestamptz + ($5::int * interval '1 millisecond'),
            updated_at = $4::timestamptz
      WHERE outbox_id = $1 AND consumer_key = $2 AND fence = $3::bigint AND status = 'in_progress'`,
    [outboxId, consumerKey, fence, asOf, leaseMs],
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

export type { OutboxConsumerStatus }
