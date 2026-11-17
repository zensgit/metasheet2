/**
 * R-69 1b-ii — the JOB LEASE of the `run_integration_job` automation action (design baseline v2.3 §10.2.3
 * "超时、租约、停止、排空", invariants I-1..I-6; ADR adr-automation-pipeline-bridge-20261103.md §3.4 Q5).
 * R-69 is OPEN: dry-run only, default OFF (INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED), not for merge until the
 * owner rules. Nothing on main calls these primitives before the action exists.
 *
 * WHY A SECOND LEASE NEXT TO THE OUTBOUND-INTENT LEASE. The intent row (automation-outbound-intent.ts) fences
 * REPLAYS of the same identity (who may declare an attempt dead). It does not serialize two DIFFERENT rules or
 * execution roots that pull the SAME project: that is this table's job. One row per `scope_key`
 * ('stock_prep_pull:<tenantId>:<projectNo>' | 'pipeline:<pipelineId>'), rows only grow, `fence` is monotonic.
 *
 *   I-1 single holder   — at most one caller holds the CURRENT fence of a scope; a successor claims only after
 *                         the predecessor's fence-CAS release or after its lease EXPIRED ON THE DB CLOCK.
 *   I-2 old fence void  — release / renew / outcome with a stale fence are 0 rows; a stale intent token is
 *                         `confirmed:false`.
 *   I-3 timeout aborts  — a timeout only aborts the port; the lease is released only after the port SETTLED.
 *   I-4 stop hastens    — shutdown only aborts; what cannot settle is left to the TTL, never released early.
 *   I-5 refuse admission once lost — a failed renewal (0 rows, error, timeout) or a passed LOCAL DEADLINE
 *                         (last successful renewal + TTL − safety) fires `lostSignal`; before every new call
 *                         the port runs `checkpoint()` = {@link assertJobLeaseCurrent} against the DB.
 *   I-6 fenced outcome  — Tx B locks the lease row FOR UPDATE, verifies holder + fence + liveness UNDER THE
 *                         LOCK, writes the intent outcome (status='pending' AND attempt_token = mine), fence-CAS
 *                         releases, commits. Any 0 rows ⇒ the whole transaction rolls back ⇒ `confirmed:false`.
 *
 * UNIFIED LOCK ORDER (every transaction that touches BOTH a job-lease row and an intent row):
 *   1. `SELECT … FROM meta_automation_job_leases WHERE scope_key = $1 FOR UPDATE`  (lease row FIRST)
 *   2. then the intent row (`meta_automation_outbound_intent`), by token.
 * Renewal ({@link renewJobAndIntentLeases}) and finalization ({@link finalizeJobWithFencedOutcome}) both follow
 * it, so they cannot deadlock with each other. The claim UPSERT touches the lease row only; the intent-only
 * autocommit writers (`claimOutboundIntent`, its expire flip, `recordOutboundOutcome`) touch the intent row only
 * — no cycle. A FUTURE path that locks an intent row and then a lease row would create one: do not add it.
 *
 * WHY THE CLAIM IS ONE STATEMENT. `INSERT … ON CONFLICT DO UPDATE … WHERE lease_expires_at <= now()` blocks
 * behind an open `FOR UPDATE` on the row and re-evaluates its WHERE on the committed version once the lock is
 * released: a claimer waiting on a holder's Tx B observes either the released row (claims fence+1) or a still-live
 * one (0 rows ⇒ busy). The linearization point is the holder's commit — exactly I-6's "B 的认领会等到 A 提交".
 * The two-step claim of automation-event-fires-lease.ts (INSERT DO NOTHING, then UPDATE) would not block.
 *
 * `checkpoint()` ({@link assertJobLeaseCurrent}) is a plain MVCC read on the POOL — never inside a transaction
 * that holds anything, and never FOR UPDATE — so it cannot block on the heartbeat's own row lock.
 *
 * KNOWN RESIDUAL (baseline §10.2.3 "还剩的重叠"): I-5 refuses NEW admissions after loss; a read already in flight,
 * or one that passed `checkpoint()` and is about to be issued, can still overlap the successor by at most one
 * read per ex-holder. 1b-ii is dry-run only, so the overlap is one source read / one trial computation.
 *
 * VALUES-FREE: rows carry a scope key (configuration identifiers), an opaque holder id, a fence and timestamps.
 * Errors carry a closed stage code, never SQL text or row values.
 */
import {
  recordOutboundOutcomeFenced,
  renewOutboundLease,
  type OutboundIntentIdentity,
  type OutboundOutcome,
  type OutboundQueryFn,
} from './automation-outbound-intent'

/** Default TTL — short on purpose (same order as the stock-prep target-table write lock); the heartbeat renews. */
export const DEFAULT_JOB_LEASE_TTL_MS = 120_000
export const JOB_LEASE_MIN_TTL_MS = 1_000
/**
 * `timeoutMs` save cap of the action (baseline §10.2.3 "3 小时与 1 小时的对齐"): 55 min + the 30 s intent-lease
 * grace stays under the 1 h `OUTBOUND_LEASE_MAX_MS` clamp, so a live job's intent lease is never clamped and a
 * same-identity replay can never flip a running job to outcome_unknown. Default 30 min = today's OS task budget.
 */
export const RUN_INTEGRATION_JOB_TIMEOUT_MAX_MS = 55 * 60_000
export const RUN_INTEGRATION_JOB_TIMEOUT_DEFAULT_MS = 30 * 60_000

const NON_BLANK = /[!-~]/
const FENCE_SHAPE = /^[0-9]{1,19}$/

export type JobLeaseQueryFn = OutboundQueryFn
/** The executor's transaction seam shape (AutomationDeps['transaction']): BEGIN … handler … COMMIT, ROLLBACK on throw. */
export type JobLeaseTransaction = <T>(handler: (client: { query: JobLeaseQueryFn }) => Promise<T>) => Promise<T>

export type JobLeaseScope =
  | { kind: 'stock_prep_pull'; tenantId: string; projectNo: string }
  | { kind: 'pipeline'; pipelineId: string }

/** What a successful claim hands back; every later statement is fenced by these three values. */
export interface JobLeaseHandle {
  scopeKey: string
  holder: string
  /** bigint, carried as a decimal string (never a JS number). */
  fence: string
}

export type JobLeaseLostStage = 'verify' | 'renew_job' | 'renew_intent' | 'release' | 'renew_timeout' | 'renew_error' | 'deadline'

/** Thrown inside a renewal / finalization transaction so it rolls back; the stage is a closed, values-free code. */
export class JobLeaseLostError extends Error {
  readonly code = 'JOB_LEASE_LOST'
  constructor(readonly stage: JobLeaseLostStage) {
    super(`job lease lost (${stage})`)
    this.name = 'JobLeaseLostError'
  }
}

function assertNonBlank(value: unknown, name: string, fn: string): asserts value is string {
  if (typeof value !== 'string' || !NON_BLANK.test(value)) throw new RangeError(`${fn}: ${name} must be non-blank`)
}

function assertHandle(lease: JobLeaseHandle, fn: string): void {
  assertNonBlank(lease?.scopeKey, 'scopeKey', fn)
  assertNonBlank(lease?.holder, 'holder', fn)
  if (typeof lease?.fence !== 'string' || !FENCE_SHAPE.test(lease.fence)) {
    throw new RangeError(`${fn}: fence must be the decimal string the claim returned`)
  }
}

function clampTtlMs(ttlMs: number | undefined): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return DEFAULT_JOB_LEASE_TTL_MS
  return Math.max(Math.floor(ttlMs), JOB_LEASE_MIN_TTL_MS)
}

function rowCountOf(result: { rowCount?: number | null }): number {
  return Number(result.rowCount ?? 0)
}

/** ADR §3.4 scope key — configuration identifiers only (tenant id, project number, pipeline id), never a row value. */
export function jobLeaseScopeKey(scope: JobLeaseScope): string {
  if (scope.kind === 'stock_prep_pull') {
    assertNonBlank(scope.tenantId, 'tenantId', 'jobLeaseScopeKey')
    assertNonBlank(scope.projectNo, 'projectNo', 'jobLeaseScopeKey')
    return `stock_prep_pull:${scope.tenantId}:${scope.projectNo}`
  }
  if (scope.kind === 'pipeline') {
    assertNonBlank(scope.pipelineId, 'pipelineId', 'jobLeaseScopeKey')
    return `pipeline:${scope.pipelineId}`
  }
  throw new RangeError('jobLeaseScopeKey: kind must be stock_prep_pull | pipeline')
}

/**
 * CLAIM (I-1) — ONE statement. A fresh scope inserts fence 1; an existing scope is taken over ONLY when its
 * lease has expired on the DB clock (fence + 1, new holder, new expiry). A live lease ⇒ 0 rows ⇒ `null` (the
 * caller reports `skipped(busy)`). Blocks behind an open FOR UPDATE on the row (see the module header).
 */
export async function claimJobLease(
  query: JobLeaseQueryFn,
  scopeKey: string,
  holder: string,
  ttlMs: number = DEFAULT_JOB_LEASE_TTL_MS,
): Promise<JobLeaseHandle | null> {
  assertNonBlank(scopeKey, 'scopeKey', 'claimJobLease')
  assertNonBlank(holder, 'holder', 'claimJobLease')
  const ttl = clampTtlMs(ttlMs)
  const claimed = await query(
    `INSERT INTO meta_automation_job_leases (scope_key, holder, fence, lease_expires_at, updated_at)
     VALUES ($1, $2, 1, now() + ($3::int * interval '1 millisecond'), now())
     ON CONFLICT (scope_key) DO UPDATE
        SET fence = meta_automation_job_leases.fence + 1,
            holder = EXCLUDED.holder,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = now()
      WHERE meta_automation_job_leases.lease_expires_at <= now()
     RETURNING fence::text AS fence`,
    [scopeKey, holder, ttl],
  )
  const row = claimed.rows[0] as { fence?: unknown } | undefined
  if (!row || typeof row.fence !== 'string') return null
  return { scopeKey, holder, fence: row.fence }
}

/**
 * CHECKPOINT (I-5) — `fence = mine AND lease_expires_at > now()`, a plain pool read. The port calls this before
 * every project, every page and every remote request; `false` means: do not admit this call.
 */
export async function assertJobLeaseCurrent(query: JobLeaseQueryFn, lease: Pick<JobLeaseHandle, 'scopeKey' | 'fence'>): Promise<boolean> {
  const current = await query(
    `SELECT 1 AS ok FROM meta_automation_job_leases
      WHERE scope_key = $1 AND fence = $2::bigint AND lease_expires_at > now()`,
    [lease.scopeKey, lease.fence],
  )
  return current.rows.length === 1
}

/**
 * I-6 step 1 — lock the lease row FOR UPDATE on the CALLER'S TRANSACTION and verify holder, fence and liveness
 * under the lock. Throws {@link JobLeaseLostError}('verify') so the enclosing transaction rolls back. A plain
 * read here would reopen "check passes → successor takes over → stale commit"; the lock makes the successor's
 * claim wait for this transaction's end (its commit or rollback is the linearization point).
 */
export async function lockJobLeaseForUpdate(txQuery: JobLeaseQueryFn, lease: JobLeaseHandle): Promise<void> {
  assertHandle(lease, 'lockJobLeaseForUpdate')
  const locked = await txQuery(
    `SELECT holder, fence::text AS fence, (lease_expires_at > now()) AS live
       FROM meta_automation_job_leases
      WHERE scope_key = $1
        FOR UPDATE`,
    [lease.scopeKey],
  )
  const row = locked.rows[0] as { holder?: unknown; fence?: unknown; live?: unknown } | undefined
  if (!row || row.holder !== lease.holder || row.fence !== lease.fence || row.live !== true) {
    throw new JobLeaseLostError('verify')
  }
}

/** RENEW the job lease (fence + holder + still-live guarded). 0 rows = already reclaimed ⇒ the holder is lost. */
export async function renewJobLease(txQuery: JobLeaseQueryFn, lease: JobLeaseHandle, ttlMs: number = DEFAULT_JOB_LEASE_TTL_MS): Promise<boolean> {
  assertHandle(lease, 'renewJobLease')
  const renewed = await txQuery(
    `UPDATE meta_automation_job_leases
        SET lease_expires_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
      WHERE scope_key = $1 AND fence = $2::bigint AND holder = $3 AND lease_expires_at > now()`,
    [lease.scopeKey, lease.fence, lease.holder, clampTtlMs(ttlMs)],
  )
  return rowCountOf(renewed) === 1
}

/**
 * RELEASE (I-2) — fence-CAS: `lease_expires_at = now()`, `holder = NULL` WHERE scope_key AND fence = mine.
 * NEVER a DELETE: the row and its fence history stay, so a stale fence is 0 rows forever and a successor's
 * lease is untouchable by a zombie. Returns whether THIS fence released the row.
 */
export async function releaseJobLease(query: JobLeaseQueryFn, lease: Pick<JobLeaseHandle, 'scopeKey' | 'fence'>): Promise<boolean> {
  assertNonBlank(lease?.scopeKey, 'scopeKey', 'releaseJobLease')
  if (typeof lease?.fence !== 'string' || !FENCE_SHAPE.test(lease.fence)) {
    throw new RangeError('releaseJobLease: fence must be the decimal string the claim returned')
  }
  const released = await query(
    `UPDATE meta_automation_job_leases
        SET lease_expires_at = now(), holder = NULL, updated_at = now()
      WHERE scope_key = $1 AND fence = $2::bigint`,
    [lease.scopeKey, lease.fence],
  )
  return rowCountOf(released) === 1
}

export interface JobIntentLease {
  id: OutboundIntentIdentity
  attemptToken: string
  /** Intent lease length per renewal (clamped by renewOutboundLease to the 1 h cap, which 55 min + grace never hits). */
  leaseMs: number
}

/**
 * HEARTBEAT TICK (baseline §10.2.3 step 3) — ONE transaction in the unified lock order: lock the lease row FOR
 * UPDATE and verify the fence, renew the job lease, then renew the INTENT lease by token. Any 0 rows ⇒ throw ⇒
 * the transaction rolls back ⇒ the caller's heartbeat fires `lostSignal`. After the job lease is lost the intent
 * lease is never renewed (the renewal is conditioned on the job fence), so the same-identity replay path can
 * declare the dead attempt once the intent lease expires.
 */
export async function renewJobAndIntentLeases(
  transaction: JobLeaseTransaction,
  lease: JobLeaseHandle,
  intent: JobIntentLease,
  ttlMs: number = DEFAULT_JOB_LEASE_TTL_MS,
): Promise<void> {
  assertHandle(lease, 'renewJobAndIntentLeases')
  await transaction(async ({ query }) => {
    await lockJobLeaseForUpdate(query, lease)
    if (!(await renewJobLease(query, lease, ttlMs))) throw new JobLeaseLostError('renew_job')
    const { renewed } = await renewOutboundLease(query, intent.id, intent.attemptToken, intent.leaseMs)
    if (!renewed) throw new JobLeaseLostError('renew_intent')
  })
}

export type JobFinalizationFailure = 'lease_lost' | 'outcome_unconfirmed' | 'transaction_failed'

export type JobFinalization =
  | { confirmed: true }
  | { confirmed: false; reason: JobFinalizationFailure; stage?: JobLeaseLostStage }

/**
 * Tx B (I-6) — after the port SETTLED and the heartbeat was stopped (its in-flight tick awaited): in ONE
 * transaction, lock the lease row FOR UPDATE and verify holder/fence/liveness, record the intent outcome fenced by
 * the attempt token, fence-CAS release the lease, commit. The row lock is held to the commit. Any verification
 * failure or any 0-row CAS throws inside the transaction ⇒ ROLLBACK ⇒ `confirmed:false` (the caller reports the
 * step as not confirmed and never as success). A database failure is `transaction_failed` — also not confirmed.
 */
export async function finalizeJobWithFencedOutcome(
  transaction: JobLeaseTransaction,
  lease: JobLeaseHandle,
  intent: Pick<JobIntentLease, 'id' | 'attemptToken'>,
  outcome: OutboundOutcome,
  lastError: string | null,
): Promise<JobFinalization> {
  assertHandle(lease, 'finalizeJobWithFencedOutcome')
  try {
    await transaction(async ({ query }) => {
      await lockJobLeaseForUpdate(query, lease)
      await recordOutboundOutcomeFenced(query, intent.id, outcome, lastError, intent.attemptToken)
      if (!(await releaseJobLease(query, lease))) throw new JobLeaseLostError('release')
    })
    return { confirmed: true }
  } catch (error) {
    if (error instanceof JobLeaseLostError) return { confirmed: false, reason: 'lease_lost', stage: error.stage }
    if ((error as { code?: unknown })?.code === 'OUTBOUND_OUTCOME_UNCONFIRMED') return { confirmed: false, reason: 'outcome_unconfirmed' }
    return { confirmed: false, reason: 'transaction_failed' }
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────────────────────────────────────

export interface JobLeaseHeartbeatOptions {
  /** One renewal (normally {@link renewJobAndIntentLeases} bound to the lease); a throw or a 0-row CAS = lost. */
  renew: () => Promise<void>
  ttlMs: number
  /** Default max(1 s, ⌊ttl/3⌋) — two consecutive misses before the DB lease can expire (scheduler precedent). */
  intervalMs?: number
  /** Local-deadline safety margin (I-5): lost at lastRenewOk + ttl − safety even without a failed renewal. Default = interval. */
  safetyMs?: number
  /** A renewal that has not answered by this time counts as failed (the DB may still be alive). Default = interval. */
  renewTimeoutMs?: number
  /** Clock seam (fake timers in tests). */
  now?: () => number
}

export interface JobLeaseHeartbeat {
  /** Aborts (reason: {@link JobLeaseLostError}) the moment the holder must consider itself lost. */
  readonly lostSignal: AbortSignal
  readonly lost: boolean
  /** Stop renewing and WAIT for the in-flight tick (if any). Never fires `lostSignal` after stop. Idempotent. */
  stop(): Promise<void>
}

/**
 * The heartbeat (baseline §10.2.3 step 3, I-5). Ticks are CHAINED (never overlapping): a tick runs `renew`, and
 * only a successful tick schedules the next one and pushes the LOCAL DEADLINE to now + ttl − safety. A renewal
 * that throws, returns 0 rows (the renew fn throws) or does not answer within `renewTimeoutMs` fires `lostSignal`
 * at once. The local deadline is a separate timer: if the clock passes it while a renewal is still unanswered
 * (DB paused, network stalled), `lostSignal` fires without waiting for the DB — the holder must not keep admitting
 * calls on a lease it cannot prove it still holds.
 *
 * `stop()` must be called BEFORE Tx B and awaited: a tick landing after the fence-CAS release sees 0 rows and
 * would fire a spurious `lostSignal` into a job that has already finished.
 */
export function startJobLeaseHeartbeat(options: JobLeaseHeartbeatOptions): JobLeaseHeartbeat {
  const ttlMs = clampTtlMs(options.ttlMs)
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? ttlMs / 3))
  const safetyMs = Math.max(0, Math.floor(options.safetyMs ?? intervalMs))
  const renewTimeoutMs = Math.max(1, Math.floor(options.renewTimeoutMs ?? intervalMs))
  const now = options.now ?? (() => Date.now())
  const controller = new AbortController()

  let stopped = false
  let lost = false
  let lastRenewOkMs = now()
  let tickTimer: ReturnType<typeof setTimeout> | null = null
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const clearTimers = (): void => {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
  }
  const markLost = (stage: JobLeaseLostStage): void => {
    if (stopped || lost) return
    lost = true
    clearTimers()
    controller.abort(new JobLeaseLostError(stage))
  }
  const scheduleDeadline = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    const deadlineAt = lastRenewOkMs + ttlMs - safetyMs
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null
      if (stopped || lost) return
      if (now() >= lastRenewOkMs + ttlMs - safetyMs) markLost('deadline')
      else scheduleDeadline()
    }, Math.max(0, deadlineAt - now()))
  }
  const renewOnce = async (): Promise<'ok' | JobLeaseLostStage> => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        options.renew().then(() => 'ok' as const, () => 'renew_error' as const),
        new Promise<'renew_timeout'>((resolve) => { timeout = setTimeout(() => resolve('renew_timeout'), renewTimeoutMs) }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  const tick = (): void => {
    tickTimer = null
    if (stopped || lost) return
    inFlight = (async () => {
      const result = await renewOnce()
      if (stopped || lost) return
      if (result !== 'ok') { markLost(result); return }
      lastRenewOkMs = now()
      scheduleDeadline()
      tickTimer = setTimeout(tick, intervalMs)
    })().finally(() => { inFlight = null })
  }

  scheduleDeadline()
  tickTimer = setTimeout(tick, intervalMs)

  return {
    lostSignal: controller.signal,
    get lost() { return lost },
    async stop() {
      stopped = true
      clearTimers()
      // A live heartbeat's in-flight tick is bounded by renewTimeoutMs; wait for it so Tx B never races a
      // renewal transaction that still holds the row lock. A LOST heartbeat has nothing left to protect (the
      // holder is not finalizing), and its hung renewal may never answer — do not wait on it.
      if (inFlight && !lost) await inFlight.catch(() => undefined)
    },
  }
}

/**
 * The union of abort signals the port receives (timeout | shutdown | lostSignal): aborts with the FIRST reason.
 * Hand-rolled instead of `AbortSignal.any` so the behaviour does not depend on the Node minor / @types/node.
 */
export function anyAbortSignal(signals: ReadonlyArray<AbortSignal>): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }, { once: true })
  }
  return controller.signal
}
