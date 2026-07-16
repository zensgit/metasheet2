/**
 * P2 durable-delivery — slice S2-b: the dispatch loop (registry + tick).
 *
 * Drives the S2-a claim engine end-to-end: alert on unknown keys → claim a batch for the keys THIS worker
 * knows → for each row **revalidate the lease, run the adapter under a bounded timeout + heartbeat, then
 * resolve via fence-CAS** (complete / reschedule with backoff / poison). Consumer adapters themselves are S5 —
 * this module defines their contract and the loop.
 *
 * Contract (FWB-0 lock #4203 Layer 1):
 *   - **Registry asserts uniqueness at registration**: a duplicate consumer_key is a STARTUP ERROR, never a
 *     silent double-run. The registry is the single enumeration source for this worker's known keys — the
 *     claim scope, the unknown-key alert, and (S3) the manifest completeness assertion all read from it.
 *   - **Unknown keys are alerted, never claimed**: rows whose consumer_key this worker doesn't know are
 *     surfaced through `observer.onUnknownConsumerKeys` and left `pending` for a worker that knows them
 *     (#4203 §246 rolling-deploy). Observer calls are best-effort — a throwing sink never fails the tick.
 *   - **A claimed row's lease is re-validated immediately before the adapter runs, and maintained by a
 *     heartbeat while it runs** (both are fence-CAS renews that do NOT bump the fence). A worker that drifted
 *     past its lease during a serial batch — or lost the row to a concurrent reclaim mid-flight — never
 *     produces (or keeps producing) the external side effect: the pre-call renew fails → the adapter is not
 *     called; the heartbeat renew fails → the in-flight call is aborted and the row is left to its new owner.
 *     This is defense in depth over the terminal fence-CAS (which only protects persisted STATE); the
 *     irreducible residue — an adapter mid-emit at the exact instant its lease is lost — is at-least-once and
 *     absorbed by SINK idempotency, per the durable-delivery doctrine.
 *   - **The adapter runs under a bounded `adapterTimeoutMs`**: one hung Promise can never freeze the tick,
 *     later rows, or `stop()`. A timeout maps to a retryable `adapter_timeout` (rescheduled with backoff) and
 *     the loop moves on; the dangling promise is neutralized (its later settle can no longer touch the row —
 *     the reschedule bumped the fence). `Promise.race` alone is not the guarantee — it is paired with the
 *     fence-CAS + idempotency above.
 *   - **The adapter's return value is parsed against a closed verdict set at runtime** — adapters are external
 *     (S5) and may misbehave. A malformed verdict (unknown outcome, missing/invalid reason, non-object, null)
 *     is a retryable `adapter_error`, NEVER a poison: a bad verdict must not silently drop the event. Only an
 *     exact `{ outcome: 'permanent_failure', reason: 'permanent_rejection' }` dead-letters.
 *   - **Per-row isolation**: one adapter failing/throwing/timing-out never blocks the rest of the batch. (A DB
 *     error on claim/renew/resolve is NOT isolated — it means the store is unhealthy, so it propagates and the
 *     caller's loop surfaces it via `onTickError` and retries next tick.)
 *   - **Backoff is deterministic exponential with a cap** (no Math.random — reproducible in tests; jitter can
 *     be layered later without changing the persisted contract).
 *   - **Every numeric knob is a validated safe-integer within an explicit range, checked BEFORE any work** —
 *     at tick entry (before the claim) and at loop start (before the timer). `intervalMs=0` (hot loop) and a
 *     fractional/huge backoff are rejected up front, never after the adapter already ran.
 *   - **The long-running loop requires a telemetry sink**: `onUnknownConsumerKeys` + `onTickError` are
 *     mandatory (a silent stuck-row or a swallowed tick error is an operational blind spot), and every
 *     observer call is exception-safe — a broken sink can neither kill the process nor stop delivery.
 *
 * Nothing here runs while `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF: `startDurableDispatchLoop` refuses
 * to start when the flag is off, and no production code calls it yet (that wiring is S5/S4 activation).
 */
import type { ClaimedConsumer, DeliveryFailureReason, Queryable } from './automation-durable-dispatcher'
import {
  claimDueConsumers,
  completeConsumer,
  findUnknownConsumerKeys,
  poisonConsumer,
  renewConsumerLease,
  rescheduleConsumer,
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
  /**
   * Handle one claimed event. Idempotency is the SINK's job (per-rule event_fires / business UNIQUE keys).
   * `ctx.signal` is aborted on timeout or on a mid-flight lease loss — a cooperative adapter should stop its
   * in-flight work when it fires (a non-cooperative adapter still can't freeze the loop: the timeout wins the
   * race regardless).
   */
  handle(event: ClaimedConsumer, ctx?: { signal: AbortSignal }): Promise<AdapterOutcome>
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
export const DEFAULT_LEASE_MS = 30_000
/** Default per-adapter execution ceiling. A call that outruns this is a retryable `adapter_timeout`. */
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000

// Explicit upper bounds for the loop's own knobs (the claim/resolve knobs are bounded inside S2-a).
const MAX_MS_24H = 86_400_000
const MAX_INTERVAL_MS = 3_600_000 // 1h — an interval beyond this is almost certainly a misconfiguration
// The claim engine (S2-a) accepts leaseMs >= 1, but a HEARTBEATED dispatch needs the lease long enough that
// the heartbeat (leaseMs/3) fires and a renew round-trip completes BEFORE the lease expires — otherwise a
// competitor reclaims a still-running delivery (#4334 review P1-B). 1s is a conservative floor for that margin.
const MIN_LOOP_LEASE_MS = 1_000

/** Reject fractional, non-finite, out-of-safe-range, or out-of-bounds numeric params before they do anything. */
function requireBoundedInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer in [${min}, ${max}] (got ${value})`)
  }
}

/**
 * Validate every numeric knob a tick / loop may use, BEFORE any side effect. Called at tick entry (before the
 * claim) and at loop start (before the timer) so a misconfiguration fails fast rather than after the adapter
 * already ran (#4203 review P2: "应在 claim 和 timer 启动前统一校验").
 */
function validateDispatchNumericParams(
  opts: {
    batchSize?: number
    leaseMs?: number
    maxAttempts?: number
    retryBaseMs?: number
    retryCapMs?: number
    adapterTimeoutMs?: number
    intervalMs?: number
  },
): void {
  if (opts.batchSize !== undefined) requireBoundedInt('batchSize', opts.batchSize, 1, 10_000)
  // leaseMs floor is the loop's, not the claim engine's: the heartbeat needs margin inside the lease (P1-B).
  if (opts.leaseMs !== undefined) requireBoundedInt('leaseMs', opts.leaseMs, MIN_LOOP_LEASE_MS, MAX_MS_24H)
  if (opts.maxAttempts !== undefined) requireBoundedInt('maxAttempts', opts.maxAttempts, 1, 10_000)
  if (opts.retryBaseMs !== undefined) requireBoundedInt('retryBaseMs', opts.retryBaseMs, 1, MAX_MS_24H)
  if (opts.retryCapMs !== undefined) requireBoundedInt('retryCapMs', opts.retryCapMs, 1, MAX_MS_24H)
  // Inversion check on the EFFECTIVE values (defaults synthesized), so a one-sided override — e.g. a
  // retryBaseMs above the DEFAULT cap with no explicit retryCapMs — is still rejected (#4334 review P2-D).
  const effRetryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
  const effRetryCapMs = opts.retryCapMs ?? DEFAULT_RETRY_CAP_MS
  if (effRetryCapMs < effRetryBaseMs) {
    throw new RangeError(`effective retryCapMs (${effRetryCapMs}) must be >= effective retryBaseMs (${effRetryBaseMs})`)
  }
  if (opts.adapterTimeoutMs !== undefined) requireBoundedInt('adapterTimeoutMs', opts.adapterTimeoutMs, 1, MAX_MS_24H)
  if (opts.intervalMs !== undefined) requireBoundedInt('intervalMs', opts.intervalMs, 1, MAX_INTERVAL_MS)
}

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

/** A resolve action derived from a (possibly malformed) adapter return value. */
export type NormalizedVerdict =
  | { action: 'complete' }
  | { action: 'reschedule'; reason: DeliveryFailureReason }
  | { action: 'poison'; reason: DeliveryFailureReason }

const RETRYABLE_REASONS: ReadonlySet<string> = new Set<DeliveryFailureReason>(['adapter_error', 'adapter_timeout', 'unknown'])

/**
 * Parse an adapter's return value against the closed verdict set at RUNTIME. Adapters are external (S5) and
 * may return anything; a malformed verdict must NEVER poison (that silently drops the event) and must never
 * throw. The fail-safe direction is retry:
 *   - exact `{ outcome: 'success' }`                                            → complete
 *   - `{ outcome: 'permanent_failure', reason: 'permanent_rejection' }` (exact) → poison (the only drop path)
 *   - `{ outcome: 'retryable_failure', reason: <valid> }`                       → reschedule with that reason
 *   - `{ outcome: 'retryable_failure', reason: <invalid/absent> }`              → reschedule, values-free `unknown`
 *   - anything else (unknown outcome, non-object, null, malformed permanent)    → reschedule `adapter_error`
 * A malformed permanent still terminates eventually — via the claim-time attempt ceiling — but is never
 * dropped on a single bad verdict.
 */
export function normalizeAdapterVerdict(raw: unknown): NormalizedVerdict {
  try {
    if (typeof raw === 'object' && raw !== null) {
      const outcome = (raw as { outcome?: unknown }).outcome
      if (outcome === 'success') {
        return { action: 'complete' }
      }
      if (outcome === 'permanent_failure' && (raw as { reason?: unknown }).reason === 'permanent_rejection') {
        return { action: 'poison', reason: 'permanent_rejection' }
      }
      if (outcome === 'retryable_failure') {
        const reason = (raw as { reason?: unknown }).reason
        return {
          action: 'reschedule',
          reason: typeof reason === 'string' && RETRYABLE_REASONS.has(reason) ? (reason as DeliveryFailureReason) : 'unknown',
        }
      }
    }
  } catch {
    // A hostile/throwing getter (or prototype-polluted object) on the adapter's return value must NOT throw
    // here — the doctrine is "the loop never throws for one adapter, and never drops". Treat it as malformed.
  }
  // null / non-object / unknown outcome / malformed permanent / a throwing getter → RETRY, never drop, never poison.
  return { action: 'reschedule', reason: 'adapter_error' }
}

export interface DispatchTickOptions {
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryCapMs?: number
  /** per-adapter execution ceiling (default 30s; 1..86_400_000). A call that outruns it is `adapter_timeout`. */
  adapterTimeoutMs?: number
  /** Rolling-deploy alert seam (#4203 §246). Best-effort — a throwing callback never fails the tick. */
  onUnknownConsumerKeys?: (keys: string[]) => void
  /** Heartbeat-renew DB-error seam (#4334 review P2-C). A renew that ERRORS (vs. cleanly losing the row to a
   *  competitor) is an infra signal — surfaced here, never masqueraded as a normal lost-lease. Values-free
   *  (internal ids only). Best-effort — a throwing callback never fails the tick. */
  onHeartbeatError?: (info: { outboxId: string; consumerKey: string }) => void
  /** Cooperative stop: the row loop breaks between rows when this returns true (keeps `stop()` responsive). */
  shouldStop?: () => boolean
  /** Aborted on loop `stop()` — folded into each row's adapter `ctx.signal` so a cooperative adapter cancels
   *  its in-flight work immediately (a non-cooperative one is still bounded by `adapterTimeoutMs`). */
  stopSignal?: AbortSignal
  now?: () => Date
}

export interface DispatchTickResult {
  claimed: number
  completed: number
  rescheduled: number
  poisoned: number
  /** resolves that hit 0 rows because the fence was superseded (zombie / lost lease) — informational. */
  lostLease: number
  /** rows whose HEARTBEAT renew hit a DB error mid-flight (an infra signal, distinct from a normal lost lease). */
  heartbeatErrors: number
  unknownKeys: string[]
}

interface RowRuntimeConfig {
  leaseMs: number
  adapterTimeoutMs: number
  heartbeatMs: number
  retryBaseMs?: number
  retryCapMs?: number
  stopSignal?: AbortSignal
  onHeartbeatError?: (info: { outboxId: string; consumerKey: string }) => void
  now?: () => Date
}

type RowDisposition = 'completed' | 'rescheduled' | 'poisoned' | 'lostLease' | 'heartbeatError'

/**
 * Run a bounded race between the adapter promise and a timeout. Resolves to the marker on timeout (the loop
 * proceeds even if the adapter never settles); a synchronous throw or async rejection of the adapter
 * propagates so the caller can map it to `adapter_error`.
 */
const TIMEOUT_MARKER = Symbol('adapter_timeout')

/**
 * Process one JUST-CLAIMED row (per-slot claim, so it carries a fresh lease + our fence): run the adapter
 * under a heartbeat + bounded timeout, then resolve via fence-CAS. The heartbeat maintains the lease for a
 * long call and aborts on a mid-flight reclaim; the terminal fence-CAS is the final state arbiter. Only the
 * ADAPTER's own failure is caught here (→ retryable); a DB error on renew/resolve propagates (store-unhealthy
 * is not a per-row condition). No pre-call renew is needed: per-slot claim removes the batch-drift window it
 * used to guard (the round-2 pre-call renew), and an adapter shorter than the heartbeat is already covered by
 * the fresh claim lease.
 */
async function processClaimedRow(
  db: Queryable,
  adapter: ConsumerAdapter,
  row: ClaimedConsumer,
  cfg: RowRuntimeConfig,
): Promise<RowDisposition> {
  // Guards: AbortController (cooperative cancel) + heartbeat (maintain the lease; detect a mid-flight
  // reclaim) + timeout (the loop's liveness guarantee).
  const controller = new AbortController()
  // A loop-level stop aborts in-flight adapters too, so stop() returns promptly for a cooperative adapter.
  const onStop = () => controller.abort()
  if (cfg.stopSignal) {
    if (cfg.stopSignal.aborted) controller.abort()
    else cfg.stopSignal.addEventListener('abort', onStop, { once: true })
  }
  let leaseLost = false
  let heartbeatErrored = false
  const heartbeat = setInterval(() => {
    void renewConsumerLease(db, row.outboxId, row.consumerKey, row.fence, cfg.leaseMs, cfg)
      .then((stillOwned) => {
        if (!stillOwned) {
          // Renew matched 0 rows: a competitor cleanly reclaimed the row (NORMAL concurrency) — abort.
          leaseLost = true
          controller.abort()
        }
      })
      .catch(() => {
        // A renew that ERRORS is an INFRA signal, not a normal lost lease — surface it (never masquerade it
        // as lostLease) and stop the call conservatively; the terminal fence-CAS is the final state arbiter.
        heartbeatErrored = true
        controller.abort()
        cfg.onHeartbeatError?.({ outboxId: row.outboxId, consumerKey: row.consumerKey })
      })
  }, cfg.heartbeatMs)
  heartbeat.unref?.()

  let raw: unknown
  let timedOut = false
  let threw = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const handlePromise = Promise.resolve().then(() => adapter.handle(row, { signal: controller.signal }))
    // Neutralize the dangling promise: after a timeout its later rejection must not become an unhandledRejection.
    handlePromise.catch(() => undefined)
    const timeoutPromise = new Promise<typeof TIMEOUT_MARKER>((resolve) => {
      timeoutTimer = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          /* ignore */
        }
        resolve(TIMEOUT_MARKER)
      }, cfg.adapterTimeoutMs)
      timeoutTimer.unref?.()
    })
    const outcome = await Promise.race([handlePromise, timeoutPromise])
    if (outcome === TIMEOUT_MARKER) {
      timedOut = true
    } else {
      raw = outcome
    }
  } catch {
    threw = true
  } finally {
    clearInterval(heartbeat)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    cfg.stopSignal?.removeEventListener('abort', onStop)
  }

  // 3) A heartbeat DB error leaves ownership uncertain — surface it as its own disposition (already reported
  //    via onHeartbeatError) and do NOT resolve; a mid-flight CLEAN reclaim means another worker owns the row
  //    now, so also do NOT resolve (our write would match 0 rows and could clobber the new owner's window).
  if (heartbeatErrored) {
    return 'heartbeatError'
  }
  if (leaseLost) {
    return 'lostLease'
  }

  // 4) Derive the resolve action: timeout → adapter_timeout; a throw → adapter_error; else parse the verdict.
  const verdict: NormalizedVerdict = timedOut
    ? { action: 'reschedule', reason: 'adapter_timeout' }
    : threw
      ? { action: 'reschedule', reason: 'adapter_error' }
      : normalizeAdapterVerdict(raw)

  // 5) Terminal fence-CAS resolve — false means the token was superseded between renew and resolve (lost lease).
  if (verdict.action === 'complete') {
    return (await completeConsumer(db, row.outboxId, row.consumerKey, row.fence, cfg)) ? 'completed' : 'lostLease'
  }
  if (verdict.action === 'reschedule') {
    const delay = computeRetryDelayMs(row.attempts, cfg.retryBaseMs, cfg.retryCapMs)
    return (await rescheduleConsumer(db, row.outboxId, row.consumerKey, row.fence, delay, verdict.reason, cfg))
      ? 'rescheduled'
      : 'lostLease'
  }
  return (await poisonConsumer(db, row.outboxId, row.consumerKey, row.fence, verdict.reason, cfg)) ? 'poisoned' : 'lostLease'
}

/**
 * One dispatch tick: validate knobs, alert unknown keys, claim a batch for the registry's keys, process each
 * row (revalidate → run under timeout+heartbeat → fence-CAS resolve). Never throws for a single adapter's
 * failure; a DB error on claim/renew/resolve does propagate (the caller's loop handles/schedules the next tick).
 */
export async function runDispatchTick(
  db: Queryable,
  registry: ConsumerAdapterRegistry,
  opts: DispatchTickOptions = {},
): Promise<DispatchTickResult> {
  if (registry.size === 0) {
    throw new RangeError('runDispatchTick requires a registry with at least one adapter (empty known-keys would claim nothing and hide misconfiguration)')
  }
  // Validate BEFORE any find/claim/side effect (#4203 review P2#5).
  validateDispatchNumericParams(opts)

  const knownKeys = registry.keys()
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
  const adapterTimeoutMs = opts.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS
  // Heartbeat strictly INSIDE the lease window (leaseMs/3, not a fixed floor that can exceed a short lease —
  // #4334 review P1-B). leaseMs >= MIN_LOOP_LEASE_MS is enforced above, so this is always well below the lease.
  const heartbeatMs = Math.max(1, Math.floor(leaseMs / 3))
  const cfg: RowRuntimeConfig = {
    leaseMs,
    adapterTimeoutMs,
    heartbeatMs,
    retryBaseMs: opts.retryBaseMs,
    retryCapMs: opts.retryCapMs,
    stopSignal: opts.stopSignal,
    onHeartbeatError: opts.onHeartbeatError,
    now: opts.now,
  }
  const result: DispatchTickResult = { claimed: 0, completed: 0, rescheduled: 0, poisoned: 0, lostLease: 0, heartbeatErrors: 0, unknownKeys: [] }

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

  // 2+3) PER-SLOT claim (#4334 review P1-A): the dispatcher is serial, and the claim increments `attempts`
  //   AT CLAIM (crash-safe, S2-a). A BATCH claim would burn an attempt on every claimed row even if a slow
  //   front row starves the tail — so a tail row could reach `max_attempts_exhausted` and dead-letter WITHOUT
  //   its adapter ever running. Claiming ONE row per execution slot guarantees every claimed row is actually
  //   attempted: attempts == adapter invocations. `batchSize` becomes the per-tick ceiling on how many slots
  //   to run. (Cost: one claim query per row — acceptable for a delivery loop; a batched design is a later,
  //   measured decision.)
  const maxRowsPerTick = opts.batchSize ?? 50
  for (let slot = 0; slot < maxRowsPerTick; slot++) {
    if (opts.shouldStop?.()) break // graceful stop: don't claim/start new adapter work once stopping
    const [row] = await claimDueConsumers(db, {
      consumerKeys: knownKeys,
      batchSize: 1,
      leaseMs,
      maxAttempts: opts.maxAttempts,
      now: opts.now,
    })
    if (!row) break // nothing reclaimable this tick
    result.claimed += 1
    const adapter = registry.get(row.consumerKey)
    if (!adapter) {
      // Cannot happen (claim is scoped to registry keys) unless the registry mutated mid-tick; leave the
      // row alone — its lease expires and a correctly-configured worker reclaims it.
      continue
    }
    const disposition = await processClaimedRow(db, adapter, row, cfg)
    if (disposition === 'completed') result.completed += 1
    else if (disposition === 'rescheduled') result.rescheduled += 1
    else if (disposition === 'poisoned') result.poisoned += 1
    else if (disposition === 'heartbeatError') result.heartbeatErrors += 1
    else result.lostLease += 1
  }
  return result
}

export interface DispatchLoopHandle {
  stop(): Promise<void>
}

/**
 * Mandatory telemetry sink for the long-running loop. Unknown keys and tick errors are operational signals
 * that must be observable — leaving them optional lets a stuck row or a swallowed error go unseen. Every call
 * is exception-safe inside the loop, so a broken sink can neither kill the process nor stop delivery.
 */
export interface DispatchLoopObserver {
  /** Reclaimable rows carrying a consumer_key this worker doesn't know (rolling-deploy alert). */
  onUnknownConsumerKeys(keys: string[]): void
  /** A tick that threw (a DB/claim error) — never swallowed silently. */
  onTickError(err: unknown): void
  /** A heartbeat renew hit a DB error mid-flight (an infra signal, NOT a normal lost lease). Required so a
   *  degrading store surfaces here instead of hiding inside the lostLease count (#4334 review P2-C). */
  onHeartbeatError(info: { outboxId: string; consumerKey: string }): void
  /** Optional per-tick metrics for observability (completed/rescheduled/poisoned/lostLease/heartbeatErrors). */
  onTick?(result: DispatchTickResult): void
}

/** Invoke an observer callback without ever letting its throw/rejection escape into the loop. */
function safeInvoke<A>(fn: ((arg: A) => unknown) | undefined, arg: A): void {
  if (typeof fn !== 'function') return
  try {
    const r = fn(arg)
    if (r && typeof (r as { then?: unknown }).then === 'function') {
      void (r as Promise<unknown>).catch(() => undefined)
    }
  } catch {
    // a broken telemetry sink must never kill delivery or the process
  }
}

/**
 * The long-running loop: one tick every `intervalMs`, with an overlap guard (a slow tick never runs
 * concurrently with the next). REQUIRES a telemetry sink and REFUSES to start while the master flag is OFF —
 * the flag is the only activation switch, and S1..S4 all land with it off.
 *
 * PRECONDITION (S4/S5 wiring): `db` MUST be a concurrency-capable Queryable — a pg `Pool` (or equivalent that
 * runs queries on independent connections), NOT a single checked-out client. A row's heartbeat renew runs
 * CONCURRENTLY with that row's adapter and its terminal resolve; on one serialized connection those queries
 * would block each other (or deadlock). Pass the pool, never `pool.connect()`'s client.
 *
 * `stop()` is prompt for cooperative adapters (the loop-stop signal is folded into each adapter's
 * `ctx.signal`); a non-cooperative adapter that ignores its signal still bounds `stop()` to at most one
 * `adapterTimeoutMs`.
 */
export function startDurableDispatchLoop(
  db: Queryable,
  registry: ConsumerAdapterRegistry,
  observer: DispatchLoopObserver,
  opts: DispatchTickOptions & { intervalMs?: number; env?: NodeJS.ProcessEnv } = {},
): DispatchLoopHandle {
  if (
    !observer ||
    typeof observer.onUnknownConsumerKeys !== 'function' ||
    typeof observer.onTickError !== 'function' ||
    typeof observer.onHeartbeatError !== 'function'
  ) {
    throw new TypeError('durable dispatch loop requires a telemetry sink (observer.onUnknownConsumerKeys + onTickError + onHeartbeatError)')
  }
  if (!isDurableDeliveryEnabled(opts.env ?? process.env)) {
    throw new Error('durable dispatch loop must not start while AUTOMATION_DURABLE_DELIVERY_ENABLED is off')
  }
  // Validate every knob (incl. intervalMs) BEFORE the timer exists — no hot loop, no fractional backoff (P2#5).
  validateDispatchNumericParams(opts)
  const intervalMs = opts.intervalMs ?? 1_000

  let running = false
  let stopped = false
  let inFlight: Promise<void> = Promise.resolve()
  const stopController = new AbortController()
  const timer = setInterval(() => {
    if (running || stopped) return
    running = true
    inFlight = runDispatchTick(db, registry, {
      ...opts,
      // route the alerts through the exception-safe sink; break the row loop promptly once stopping;
      // fold the loop-stop signal into each adapter's ctx.signal so stop() cancels in-flight work.
      onUnknownConsumerKeys: (keys) => safeInvoke(observer.onUnknownConsumerKeys, keys),
      onHeartbeatError: (info) => safeInvoke(observer.onHeartbeatError, info),
      shouldStop: () => stopped,
      stopSignal: stopController.signal,
    })
      .then((result) => {
        safeInvoke(observer.onTick, result)
      })
      .catch((err) => {
        safeInvoke(observer.onTickError, err)
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
      stopController.abort()
      clearInterval(timer)
      await inFlight
    },
  }
}
