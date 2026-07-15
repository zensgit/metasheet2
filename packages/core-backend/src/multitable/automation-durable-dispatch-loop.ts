/**
 * P2 durable-delivery — slice S2-b: the dispatch loop (registry + tick).
 *
 * Drives the S2-a claim engine end-to-end: alert on unknown keys → claim a batch for the keys THIS worker
 * knows → `await` each row's consumer adapter directly → resolve via fence-CAS (complete / reschedule with
 * backoff / poison). Consumer adapters themselves are S5 — this module defines their contract and the loop.
 *
 * Contract (FWB-0 lock #4203 Layer 1):
 *   - **Registry asserts uniqueness at registration**: a duplicate consumer_key is a STARTUP ERROR, never a
 *     silent double-run. The registry is the single enumeration source for this worker's known keys — the
 *     claim scope, the unknown-key alert, and (S3) the manifest completeness assertion all read from it.
 *   - **Unknown keys are alerted, never claimed**: rows whose consumer_key this worker doesn't know are
 *     surfaced through `onUnknownConsumerKeys` and left `pending` for a worker that knows them (#4203 §246
 *     rolling-deploy). The alert callback must never throw the tick over (best-effort).
 *   - **The dispatcher directly `await`s the adapter** (no eventemitter3 in the durable path). An adapter
 *     THROW is a transient `adapter_error` (rescheduled with backoff); only an explicit
 *     `permanent_failure` verdict poisons. Attempt-exhaustion poison is claim-driven (S2-a) — the loop
 *     never has to be alive for the ceiling to hold.
 *   - **Per-row isolation**: one adapter failing/throwing never blocks the rest of the batch.
 *   - **Backoff is deterministic exponential with a cap** (no Math.random — reproducible in tests; jitter
 *     can be layered later without changing the persisted contract).
 *
 * Nothing here runs while `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF: `startDurableDispatchLoop` refuses
 * to start when the flag is off, and no production code calls it yet (that wiring is S5/S4 activation).
 */
import type { ClaimedConsumer, DeliveryFailureReason, Queryable } from './automation-durable-dispatcher'
import {
  claimDueConsumers,
  completeConsumer,
  DEFAULT_MAX_DELIVERY_ATTEMPTS,
  findUnknownConsumerKeys,
  poisonConsumer,
  rescheduleConsumer,
  resolveDisposition,
} from './automation-durable-dispatcher'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'

/** The verdict an adapter returns for one delivered event. A THROW is treated as retryable `adapter_error`. */
export type AdapterOutcome =
  | { outcome: 'success' }
  | { outcome: 'retryable_failure'; reason: Extract<DeliveryFailureReason, 'adapter_error' | 'adapter_timeout' | 'unknown'> }
  | { outcome: 'permanent_failure'; reason: Extract<DeliveryFailureReason, 'permanent_rejection'> }

/** A named consumer adapter — the durable path's delivery target (implementations land in S5). */
export interface ConsumerAdapter {
  /** The consumer_key this adapter serves (must be unique across the registry). */
  readonly key: string
  /** Handle one claimed event. Idempotency is the SINK's job (per-rule event_fires / business UNIQUE keys). */
  handle(event: ClaimedConsumer): Promise<AdapterOutcome>
}

/**
 * Startup-time adapter registry. Registration asserts key uniqueness — a duplicate is a configuration bug
 * that would double-run deliveries, so it throws instead of silently overwriting (#4203 §manifest).
 */
export class ConsumerAdapterRegistry {
  private readonly adapters = new Map<string, ConsumerAdapter>()

  register(adapter: ConsumerAdapter): void {
    const key = adapter?.key
    if (typeof key !== 'string' || key.trim() === '') {
      throw new RangeError('ConsumerAdapter.key must be a non-empty string')
    }
    if (this.adapters.has(key)) {
      throw new Error(`duplicate consumer adapter registration for key "${key}" — this would double-run deliveries`)
    }
    this.adapters.set(key, adapter)
  }

  get(key: string): ConsumerAdapter | undefined {
    return this.adapters.get(key)
  }

  /** The single enumeration source for this worker's known consumer_keys. */
  keys(): string[] {
    return [...this.adapters.keys()]
  }

  get size(): number {
    return this.adapters.size
  }
}

// Deterministic exponential backoff: base·2^(attempts-1), capped. attempts is the POST-claim count (>=1).
export const DEFAULT_RETRY_BASE_MS = 5_000
export const DEFAULT_RETRY_CAP_MS = 15 * 60_000 // 15 min

export function computeRetryDelayMs(
  attempts: number,
  baseMs: number = DEFAULT_RETRY_BASE_MS,
  capMs: number = DEFAULT_RETRY_CAP_MS,
): number {
  const n = Number.isSafeInteger(attempts) && attempts >= 1 ? attempts : 1
  // 2^(n-1) can overflow quickly — clamp the exponent so the multiply stays in safe-integer range.
  const exp = Math.min(n - 1, 30)
  return Math.min(baseMs * 2 ** exp, capMs)
}

export interface DispatchTickOptions {
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryCapMs?: number
  /** Rolling-deploy alert seam (#4203 §246). Best-effort — a throwing callback never fails the tick. */
  onUnknownConsumerKeys?: (keys: string[]) => void
  now?: () => Date
}

export interface DispatchTickResult {
  claimed: number
  completed: number
  rescheduled: number
  poisoned: number
  /** resolves that hit 0 rows because the fence was superseded mid-flight (zombie writes) — informational. */
  lostLease: number
  unknownKeys: string[]
}

/**
 * One dispatch tick: alert unknown keys, claim a batch for the registry's keys, await each adapter, resolve
 * each row via fence-CAS. Never throws for a single adapter's failure; a DB error on claim does propagate
 * (the caller's loop handles/schedules the next tick).
 */
export async function runDispatchTick(
  db: Queryable,
  registry: ConsumerAdapterRegistry,
  opts: DispatchTickOptions = {},
): Promise<DispatchTickResult> {
  if (registry.size === 0) {
    throw new RangeError('runDispatchTick requires a registry with at least one adapter (empty known-keys would claim nothing and hide misconfiguration)')
  }
  const knownKeys = registry.keys()
  const result: DispatchTickResult = { claimed: 0, completed: 0, rescheduled: 0, poisoned: 0, lostLease: 0, unknownKeys: [] }

  // 1) rolling-deploy alert: reclaimable rows this worker cannot serve. Never claimed, never terminated.
  try {
    result.unknownKeys = await findUnknownConsumerKeys(db, knownKeys, opts)
    if (result.unknownKeys.length > 0) {
      opts.onUnknownConsumerKeys?.(result.unknownKeys)
    }
  } catch {
    // best-effort alert probe; the delivery tick itself must not die on it. (If the DB is down, the claim
    // below will fail loudly anyway.)
  }

  // 2) claim a batch scoped to the keys this worker knows (ceiling-poison happens inside the claim).
  const claimed = await claimDueConsumers(db, {
    consumerKeys: knownKeys,
    batchSize: opts.batchSize,
    leaseMs: opts.leaseMs,
    maxAttempts: opts.maxAttempts,
    now: opts.now,
  })
  result.claimed = claimed.length

  // 3) await each adapter and resolve — per-row isolation, sequential (adapters may share downstream
  //    resources; concurrency tuning is a later, measured decision, not a default).
  for (const row of claimed) {
    const adapter = registry.get(row.consumerKey)
    if (!adapter) {
      // Cannot happen (claim is scoped to registry keys) unless the registry mutated mid-tick; leave the
      // row alone — its lease expires and a correctly-configured worker reclaims it.
      continue
    }
    let verdict: AdapterOutcome
    try {
      verdict = await adapter.handle(row)
    } catch {
      verdict = { outcome: 'retryable_failure', reason: 'adapter_error' }
    }
    const action = resolveDisposition(verdict.outcome)
    let applied = false
    if (action === 'complete') {
      applied = await completeConsumer(db, row.outboxId, row.consumerKey, row.fence, opts)
      if (applied) result.completed += 1
    } else if (action === 'reschedule') {
      const reason = verdict.outcome === 'retryable_failure' ? verdict.reason : 'unknown'
      const delay = computeRetryDelayMs(row.attempts, opts.retryBaseMs, opts.retryCapMs)
      applied = await rescheduleConsumer(db, row.outboxId, row.consumerKey, row.fence, delay, reason, opts)
      if (applied) result.rescheduled += 1
    } else {
      const reason = verdict.outcome === 'permanent_failure' ? verdict.reason : 'permanent_rejection'
      applied = await poisonConsumer(db, row.outboxId, row.consumerKey, row.fence, reason, opts)
      if (applied) result.poisoned += 1
    }
    if (!applied) result.lostLease += 1
  }
  return result
}

export interface DispatchLoopHandle {
  stop(): Promise<void>
}

/**
 * The long-running loop: one tick every `intervalMs`, with an overlap guard (a slow tick never runs
 * concurrently with the next). REFUSES to start while the master flag is OFF — the flag is the only
 * activation switch, and S1..S4 all land with it off.
 */
export function startDurableDispatchLoop(
  db: Queryable,
  registry: ConsumerAdapterRegistry,
  opts: DispatchTickOptions & { intervalMs?: number; env?: NodeJS.ProcessEnv; onTickError?: (err: unknown) => void } = {},
): DispatchLoopHandle {
  if (!isDurableDeliveryEnabled(opts.env ?? process.env)) {
    throw new Error('durable dispatch loop must not start while AUTOMATION_DURABLE_DELIVERY_ENABLED is off')
  }
  const intervalMs = opts.intervalMs ?? 1_000
  let running = false
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    inFlight = runDispatchTick(db, registry, opts)
      .then(() => undefined)
      .catch((err) => {
        opts.onTickError?.(err)
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  // do not keep the process alive just for the loop
  timer.unref?.()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await inFlight
    },
  }
}
