import { randomUUID } from 'node:crypto'

import {
  executeRecoveryArchiveAsyncRestoreChunk,
  type RecoveryArchiveAsyncRestoreChunkInput,
} from './recovery-archive-async-restore'
import { isMultitableRecoveryArchiveEnabled } from './recovery-archive-contract'
import {
  abandonRecoveryArchiveRestoreJob,
  claimRecoveryArchiveRestoreJob,
  finalizeRecoveryArchiveRestoreJob,
  pauseRecoveryArchiveRestoreJob,
  RecoveryArchiveRestoreJobError,
  renewRecoveryArchiveRestoreJobLease,
  selectRecoveryArchiveRestoreJobCandidate,
  sweepExpiredRecoveryArchiveRestoreJobs,
  type RecoveryArchiveRestoreChunkResult,
  type RecoveryArchiveRestoreJobCandidate,
  type RecoveryArchiveRestoreJobWorkerClaim,
} from './recovery-archive-restore-jobs'

export type RecoveryArchiveRestoreWorkerRunKind =
  | 'idle'
  | 'completed'
  | 'paused_retryable'
  | 'abandoned'
  | 'claim_contended'
  | 'lease_lost'
  | 'yielded'
  | 'stopped'
  | 'sweep_failed'
  | 'selection_failed'
  | 'terminalization_failed'
  | 'tick_failed'

export interface RecoveryArchiveRestoreWorkerRunResult {
  readonly kind: RecoveryArchiveRestoreWorkerRunKind
  readonly swept: number
  readonly chunks: number
}

export interface RecoveryArchiveRestoreWorkerOperations {
  sweepExpired(): Promise<number>
  select(): Promise<RecoveryArchiveRestoreJobCandidate | null>
  claim(
    candidate: RecoveryArchiveRestoreJobCandidate,
    leaseUntil: string,
  ): Promise<RecoveryArchiveRestoreJobWorkerClaim>
  renew(
    claim: RecoveryArchiveRestoreJobWorkerClaim,
    leaseUntil: string,
  ): Promise<RecoveryArchiveRestoreJobWorkerClaim>
  executeChunk(
    claim: RecoveryArchiveRestoreJobWorkerClaim,
  ): Promise<RecoveryArchiveRestoreChunkResult>
  finalize(claim: RecoveryArchiveRestoreJobWorkerClaim): Promise<unknown>
  pause(claim: RecoveryArchiveRestoreJobWorkerClaim): Promise<unknown>
  abandon(claim: RecoveryArchiveRestoreJobWorkerClaim): Promise<unknown>
}

export interface RecoveryArchiveRestoreWorker {
  runOnce(shouldStop?: () => boolean): Promise<RecoveryArchiveRestoreWorkerRunResult>
}

export interface RecoveryArchiveRestoreWorkerConfig {
  readonly leaseMs: number
  readonly replayHorizonMs: number
  readonly sweepLimit?: number
  readonly maxChunksPerRun?: number
  readonly workerOwnerId?: string
  readonly now?: () => Date
}

export interface CreateRecoveryArchiveRestoreWorkerInput
  extends Omit<RecoveryArchiveAsyncRestoreChunkInput, 'claim'>,
    RecoveryArchiveRestoreWorkerConfig {}

const STALE_ERROR_CODES = new Set([
  'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_FOUND',
  'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_CLAIMABLE',
  'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST',
  'RECOVERY_ARCHIVE_RESTORE_JOB_BLOCK_LOST',
])

const PERMANENT_ERROR_CODES = new Set([
  'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT',
  'RECOVERY_ARCHIVE_RESTORE_JOB_IDENTITY_INVALID',
  'RECOVERY_ARCHIVE_RESTORE_JOB_AUTHORITY_DENIED',
  'RECOVERY_ARCHIVE_RESTORE_JOB_ARCHIVE_DRIFT',
  'RECOVERY_ARCHIVE_RESTORE_JOB_TOKEN_REPLAYED',
  'RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_INVALID',
  'RECOVERY_ARCHIVE_RESTORE_JOB_CHUNK_APPLY_INVALID',
  'RECOVERY_ARCHIVE_RESTORE_JOB_NOT_COMPLETE',
  'RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID',
  'RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN',
  'RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION',
  'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_REQUEST',
  'RECOVERY_ARCHIVE_OBJECT_STORE_INVALID_RESULT',
  'RECOVERY_ARCHIVE_OBJECT_STORE_IMMUTABLE_BINDING_MISMATCH',
  'RECOVERY_ARCHIVE_OBJECT_STORE_LOCAL_ENVIRONMENT_REFUSED',
  'RECOVERY_ARCHIVE_OBJECT_STORE_PATH_REFUSED',
  // D1 §2.2.4 makes lock conflicts terminal for a durable job; L8 request-level retry does not override it.
  '40P01',
  '40001',
  '55P03',
])

/**
 * Build the production worker around the fenced D5 state machine and the authenticated D4 facade.
 * Runtime/provider construction remains caller-owned so flag-OFF boot can return before any KMS or object I/O.
 */
export function createRecoveryArchiveRestoreWorker(
  input: CreateRecoveryArchiveRestoreWorkerInput,
): RecoveryArchiveRestoreWorker {
  const workerOwnerId = input.workerOwnerId ?? randomUUID()
  const replayHorizonMs = nonnegativeInteger(input.replayHorizonMs)
  const sweepLimit = positiveInteger(input.sweepLimit ?? 100)
  const operations: RecoveryArchiveRestoreWorkerOperations = {
    sweepExpired: () => sweepExpiredRecoveryArchiveRestoreJobs(input.transaction, {
      replayHorizonMs,
      limit: sweepLimit,
    }),
    select: () => selectRecoveryArchiveRestoreJobCandidate(input.transaction),
    claim: (candidate, leaseUntil) => claimRecoveryArchiveRestoreJob(
      input.transaction,
      candidate,
      { workerOwnerId, leaseUntil },
    ),
    renew: (claim, leaseUntil) => renewRecoveryArchiveRestoreJobLease(
      input.transaction,
      claim,
      { leaseUntil },
    ),
    executeChunk: (claim) => executeRecoveryArchiveAsyncRestoreChunk({
      transaction: input.transaction,
      query: input.query,
      runtime: input.runtime,
      claim,
      recheckAuthority: input.recheckAuthority,
      apply: input.apply,
    }),
    finalize: (claim) => finalizeRecoveryArchiveRestoreJob(
      input.transaction,
      claim,
      { replayHorizonMs },
    ),
    pause: (claim) => pauseRecoveryArchiveRestoreJob(input.transaction, claim),
    abandon: (claim) => abandonRecoveryArchiveRestoreJob(
      input.transaction,
      claim,
      { replayHorizonMs },
    ),
  }
  return createRecoveryArchiveRestoreWorkerFromOperations(operations, input)
}

export function createRecoveryArchiveRestoreWorkerFromOperations(
  operations: RecoveryArchiveRestoreWorkerOperations,
  config: Pick<RecoveryArchiveRestoreWorkerConfig, 'leaseMs' | 'maxChunksPerRun' | 'now'>,
): RecoveryArchiveRestoreWorker {
  const leaseMs = positiveInteger(config.leaseMs)
  const maxChunksPerRun = positiveInteger(config.maxChunksPerRun ?? 1000)
  const now = config.now ?? (() => new Date())

  return {
    async runOnce(shouldStop = () => false) {
      let swept = 0
      try {
        swept = await operations.sweepExpired()
      } catch {
        return result('sweep_failed', 0, 0)
      }
      if (shouldStop()) return result('stopped', swept, 0)

      let candidate: RecoveryArchiveRestoreJobCandidate | null
      try {
        candidate = await operations.select()
      } catch {
        return result('selection_failed', swept, 0)
      }
      if (!candidate) return result('idle', swept, 0)

      const firstLeaseUntil = nextLeaseUntil(now(), candidate.resumeDeadline, leaseMs)
      if (!firstLeaseUntil) return result('claim_contended', swept, 0)

      let claim: RecoveryArchiveRestoreJobWorkerClaim
      try {
        claim = await operations.claim(candidate, firstLeaseUntil)
      } catch (error) {
        return result(isStaleError(error) ? 'claim_contended' : 'selection_failed', swept, 0)
      }

      let chunks = 0
      for (let iteration = 0; iteration < maxChunksPerRun; iteration += 1) {
        if (shouldStop()) return result('stopped', swept, chunks)
        let chunk: RecoveryArchiveRestoreChunkResult
        try {
          chunk = await operations.executeChunk(claim)
        } catch (error) {
          return terminalizeFailure(operations, claim, error, swept, chunks)
        }

        if (chunk.kind === 'no_pending_chunk') {
          try {
            await operations.finalize(claim)
            return result('completed', swept, chunks)
          } catch (error) {
            return terminalizeFailure(operations, claim, error, swept, chunks)
          }
        }

        chunks += 1
        if (shouldStop()) return result('stopped', swept, chunks)
        const renewedLeaseUntil = nextLeaseUntil(now(), claim.resumeDeadline, leaseMs)
        if (!renewedLeaseUntil) return result('lease_lost', swept, chunks)
        try {
          claim = await operations.renew(claim, renewedLeaseUntil)
        } catch (error) {
          return result(isStaleError(error) ? 'lease_lost' : 'terminalization_failed', swept, chunks)
        }
      }
      return result('yielded', swept, chunks)
    },
  }
}

async function terminalizeFailure(
  operations: RecoveryArchiveRestoreWorkerOperations,
  claim: RecoveryArchiveRestoreJobWorkerClaim,
  error: unknown,
  swept: number,
  chunks: number,
): Promise<RecoveryArchiveRestoreWorkerRunResult> {
  if (isStaleError(error)) return result('lease_lost', swept, chunks)
  const permanent = isPermanentError(error)
  try {
    if (permanent) {
      await operations.abandon(claim)
      return result('abandoned', swept, chunks)
    }
    await operations.pause(claim)
    return result('paused_retryable', swept, chunks)
  } catch {
    return result('terminalization_failed', swept, chunks)
  }
}

function isStaleError(error: unknown): boolean {
  const code = readErrorCode(error)
  return code !== null && STALE_ERROR_CODES.has(code)
}

function isPermanentError(error: unknown): boolean {
  const code = readErrorCode(error)
  return code !== null && PERMANENT_ERROR_CODES.has(code)
}

function readErrorCode(error: unknown): string | null {
  if (error instanceof RecoveryArchiveRestoreJobError) return error.code
  if (!error || typeof error !== 'object') return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function nextLeaseUntil(now: Date, resumeDeadline: string, leaseMs: number): string | null {
  const nowMs = now.getTime()
  const deadlineMs = Date.parse(resumeDeadline)
  if (!Number.isFinite(nowMs) || !Number.isFinite(deadlineMs)) return null
  const leaseUntilMs = Math.min(nowMs + leaseMs, deadlineMs)
  return leaseUntilMs > nowMs ? new Date(leaseUntilMs).toISOString() : null
}

function result(
  kind: RecoveryArchiveRestoreWorkerRunKind,
  swept: number,
  chunks: number,
): RecoveryArchiveRestoreWorkerRunResult {
  return Object.freeze({ kind, swept, chunks })
}

function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('RECOVERY_ARCHIVE_RESTORE_WORKER_INVALID_CONFIG')
  return Number(value)
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('RECOVERY_ARCHIVE_RESTORE_WORKER_INVALID_CONFIG')
  return Number(value)
}

export function isRecoveryArchiveRestoreWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isMultitableRecoveryArchiveEnabled(env) && env.MULTITABLE_ENABLE_WRITER_FENCE === 'true'
}

export interface RecoveryArchiveRestoreWorkerLoop {
  tick(): Promise<RecoveryArchiveRestoreWorkerRunResult | null>
  stop(): Promise<void>
}

export interface BootRecoveryArchiveRestoreWorkerInput {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly intervalMs: number
  readonly createWorker: () => RecoveryArchiveRestoreWorker
  readonly onResult?: (result: RecoveryArchiveRestoreWorkerRunResult) => void
  readonly schedule?: (tick: () => void, intervalMs: number) => unknown
  readonly cancel?: (timer: unknown) => void
}

/** Flag-OFF returns before the runtime factory, timer, database, object store, or KMS can be touched. */
export function bootRecoveryArchiveRestoreWorker(
  input: BootRecoveryArchiveRestoreWorkerInput,
): RecoveryArchiveRestoreWorkerLoop | null {
  if (!isRecoveryArchiveRestoreWorkerEnabled(input.env ?? process.env)) return null
  const intervalMs = positiveInteger(input.intervalMs)
  const worker = input.createWorker()
  const schedule = input.schedule ?? ((tick, everyMs) => setInterval(tick, everyMs))
  const cancel = input.cancel ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>))
  let stopped = false
  let inFlight: Promise<RecoveryArchiveRestoreWorkerRunResult> | null = null

  const tick = async (): Promise<RecoveryArchiveRestoreWorkerRunResult | null> => {
    if (stopped || inFlight) return null
    inFlight = worker.runOnce(() => stopped).catch(() => result('tick_failed', 0, 0))
    try {
      const outcome = await inFlight
      try {
        input.onResult?.(outcome)
      } catch {
        // Observability cannot change worker state.
      }
      return outcome
    } finally {
      inFlight = null
    }
  }

  const timer = schedule(() => {
    void tick()
  }, intervalMs)
  void tick()

  return {
    tick,
    async stop() {
      if (!stopped) {
        stopped = true
        cancel(timer)
      }
      await inFlight
    },
  }
}
