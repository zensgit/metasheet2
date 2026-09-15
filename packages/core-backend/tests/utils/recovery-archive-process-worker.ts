import { Pool } from 'pg'
import { createRecoveryArchiveDerivedProcessor, createRecoveryArchiveWorkerAuthorization } from '../../src/routes/univer-meta'
import type { RecoveryArchiveRestoreWorkerRunResult } from '../../src/multitable/recovery-archive-restore-worker'
import { createRecoveryArchiveApplication } from '../../src/multitable/recovery-archive-application'
import type { RecoveryArchiveWorkerLifecycle } from '../../src/multitable/recovery-archive-observability'
import type { RecoveryArchiveDerivedWork } from '../../src/multitable/recovery-archive-derived-effects'

import { executeRecoveryArchiveAsyncRestoreChunk } from '../../src/multitable/recovery-archive-async-restore'
import type {
  RecoveryArchiveObjectReadRequest,
  RecoveryArchiveObjectReadResult,
  RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import {
  claimRecoveryArchiveRestoreJob,
  readRecoveryArchiveRestoreWorkerBinding,
  selectRecoveryArchiveRestoreJobCandidate,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
  type RecoveryArchiveRestoreJobWorkerClaim,
} from '../../src/multitable/recovery-archive-restore-jobs'
import { createFixtureKeyCustody, type RecoveryArchiveFixtureKeyMaterial } from './recovery-archive-durable-fixture'

export type ArchiveProcessClaimSnapshot = Pick<RecoveryArchiveRestoreJobWorkerClaim,
  'jobId' | 'sheetId' | 'keyId' | 'archiveGenerationId' | 'blockFence' | 'workerOwnerId'
  | 'workerFence' | 'leaseUntil' | 'resumeDeadline'>

export interface ArchiveProcessWorkerInput {
  readonly phase: 'before_commit' | 'after_commit' | 'finish' | 'drain'
  readonly drainTicks?: number
  readonly applicationName: string
  readonly keyId: string
  readonly keyMaterial: RecoveryArchiveFixtureKeyMaterial
  readonly jobId: string
  readonly priorClaim?: ArchiveProcessClaimSnapshot
}

export type ArchiveProcessWorkerMessage =
  | { kind: 'read-object'; requestId: number; request: RecoveryArchiveObjectReadRequest }
  | { kind: 'drained'; pid: number; attempts: number; completed: number; batches: number[]; ticks: RecoveryArchiveRestoreWorkerRunResult[]; lifecycle: RecoveryArchiveWorkerLifecycle[] }
  | { kind: 'boundary'; phase: 'before_commit' | 'after_commit'; pid: number; claim: ArchiveProcessClaimSnapshot }
  | {
      kind: 'done'
      pid: number
      claim: Pick<ArchiveProcessClaimSnapshot, 'blockFence' | 'workerFence'>
      outcome: RecoveryArchiveRestoreWorkerRunResult
      lifecycle: RecoveryArchiveWorkerLifecycle[]
      terminal: { state: string; completedCount: string }
    }
  | { kind: 'error'; code: string }

function send(message: ArchiveProcessWorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('archive_process_ipc_missing'))
    process.send(message, undefined, undefined, (error) => error ? reject(error) : resolve())
  })
}

let requestSequence = 0
const objectStore: RecoveryArchiveObjectStoreProvider = {
  get(request) {
    const requestId = ++requestSequence
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: RecoveryArchiveObjectReadResult) => {
        clearTimeout(timer)
        process.off('message', receive)
        if (error) reject(error)
        else resolve(result!)
      }
      const receive = (reply: { kind?: string; requestId?: number; result?: RecoveryArchiveObjectReadResult }) => {
        if (reply.kind !== 'object-result' || reply.requestId !== requestId) return
        finish(reply.result ? undefined : new Error('archive_process_object_read_failed'), reply.result)
      }
      const timer = setTimeout(() => finish(new Error('archive_process_object_read_timeout')), 10_000)
      process.on('message', receive)
      void send({ kind: 'read-object', requestId, request }).catch(() => finish(new Error('archive_process_object_send_failed')))
    })
  },
  async put() { throw new Error('archive_process_unexpected_object_write') },
  async head() { throw new Error('archive_process_unexpected_object_head') },
  async pin() { throw new Error('archive_process_unexpected_object_pin') },
  async deleteExpired() { throw new Error('archive_process_unexpected_object_delete') },
}

async function run(input: ArchiveProcessWorkerInput): Promise<void> {
  if (process.env.METASHEET_REAL_DB_TEST_STEP !== '1' || !process.env.DATABASE_URL) {
    throw new Error('archive_process_realdb_harness_missing')
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: input.applicationName,
    max: input.phase === 'drain' || input.phase === 'finish' ? 2 : 1,
  })
  let depth = 0
  let executingChunk = false
  let claimSnapshot: ArchiveProcessClaimSnapshot
  const query: RecoveryArchiveRestoreJobQuery = async (text, values) => pool.query(text, values)
  const park = async (phase: 'before_commit' | 'after_commit') => {
    await send({ kind: 'boundary', phase, pid: process.pid, claim: claimSnapshot })
    // Only the parent may end this barrier, by observing and killing this actual process.
    await new Promise<never>(() => {})
  }
  const transaction: RecoveryArchiveRestoreJobTransaction = async (work) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      depth += 1
      const result = await work(async (text, values) => client.query(text, values))
      const chunkResult = result as { kind?: unknown; chunkIndex?: unknown } | null
      const isFirstChunk = executingChunk && chunkResult?.kind === 'committed' && chunkResult.chunkIndex === 0
      if (isFirstChunk && input.phase === 'before_commit') await park('before_commit')
      await client.query('COMMIT')
      if (isFirstChunk && input.phase === 'after_commit') await park('after_commit')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      depth -= 1
      client.release()
    }
  }
  const runtime = {
    keyCustody: createFixtureKeyCustody(input.keyId, [], input.keyMaterial),
    objectStore,
    transactionDepth: { currentTransactionDepth: () => depth },
  }
  const authorization = createRecoveryArchiveWorkerAuthorization()
  const runApplication = async (
    tickCount: number,
    processDerivedWork: (work: RecoveryArchiveDerivedWork) => Promise<boolean>,
    onTick: (result: RecoveryArchiveRestoreWorkerRunResult) => void,
  ) => {
    const lifecycle: RecoveryArchiveWorkerLifecycle[] = []
    let ticks = 0
    let done!: () => void
    const completed = new Promise<void>((resolve) => { done = resolve })
    const application = createRecoveryArchiveApplication(() => ({
      keyCustody: runtime.keyCustody, objectStore: runtime.objectStore,
      auditedReplayHorizonMs: 0, asyncResumeHorizonMs: 300_000, workerIntervalMs: 5,
      worker: {
        leaseMs: 240_000, replayHorizonMs: 0, workerOwnerId: input.applicationName,
        recheckAuthority: authorization.recheckAuthority, apply: authorization.apply, processDerivedWork,
      },
    }), () => ({ query, transaction, transactionDepthProbe: runtime.transactionDepth }), {
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true', MULTITABLE_ENABLE_WRITER_FENCE: 'true',
    }, {
      recordLifecycle: event => { lifecycle.push(event) },
      recordRun: result => {
        onTick(result)
        ticks += 1
        if (ticks >= tickCount) done()
      },
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      application.startWorker()
      await Promise.race([completed, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('archive_process_application_timer_timeout')), 150_000)
      })])
    } finally {
      clearTimeout(timeout)
      await application.stopWorker()
    }
    const stoppedTicks = ticks
    await new Promise(resolve => setTimeout(resolve, 25))
    if (ticks !== stoppedTicks || ticks !== tickCount || lifecycle.join(',') !== 'started,drained') {
      throw new Error('archive_process_application_lifecycle_invalid')
    }
    return lifecycle
  }
  try {
    if (input.phase === 'drain') {
      const tickCount = input.drainTicks ?? 0
      if (!Number.isSafeInteger(tickCount) || tickCount < 1 || tickCount > 158) {
        throw new Error('archive_process_drain_bound_invalid')
      }
      const processDerived = createRecoveryArchiveDerivedProcessor({ query, transaction })
      let attempts = 0
      let completed = 0
      const ticks: RecoveryArchiveRestoreWorkerRunResult[] = []
      const batches: number[] = []
      let previousCompleted = 0
      const lifecycle = await runApplication(tickCount, async work => {
        attempts += 1
        if (work.identity.jobId !== input.jobId) throw new Error('archive_process_derived_job_mismatch')
        const result = await processDerived(work)
        if (result) completed += 1
        return result
      }, result => {
        ticks.push(result)
        batches.push(completed - previousCompleted)
        previousCompleted = completed
      })
      await send({ kind: 'drained', pid: process.pid, attempts, completed, batches, ticks, lifecycle })
      return
    }
    if (input.priorClaim) {
      let code: unknown
      try {
        await readRecoveryArchiveRestoreWorkerBinding(query, input.priorClaim as RecoveryArchiveRestoreJobWorkerClaim)
      } catch (error: unknown) {
        code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      }
      if (code !== 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT') {
        throw new Error('archive_process_serialized_claim_accepted')
      }
    }
    const candidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
    if (candidate?.jobId !== input.jobId) throw new Error('archive_process_candidate_mismatch')
    if (input.phase === 'finish') {
      let outcome!: RecoveryArchiveRestoreWorkerRunResult
      const lifecycle = await runApplication(1, createRecoveryArchiveDerivedProcessor({ query, transaction }), result => { outcome = result })
      const terminal = await query(`SELECT state, completed_count::text AS completed_count,
        block_fence::text AS block_fence, worker_fence::text AS worker_fence
        FROM meta_recovery_archive_jobs WHERE id=$1::uuid`, [input.jobId])
      const row = terminal.rows[0] as { state: string; completed_count: string; block_fence: string; worker_fence: string } | undefined
      if (!row) throw new Error('archive_process_terminal_missing')
      await send({ kind: 'done', pid: process.pid, outcome, lifecycle,
        claim: { blockFence: row.block_fence, workerFence: row.worker_fence },
        terminal: { state: row.state, completedCount: row.completed_count },
      })
      return
    }
    const clock = await query("SELECT clock_timestamp() + interval '30 seconds' AS lease_until")
    const claim = await claimRecoveryArchiveRestoreJob(transaction, candidate, {
      workerOwnerId: input.applicationName,
      leaseUntil: (clock.rows[0] as { lease_until: Date }).lease_until,
    })
    claimSnapshot = {
      jobId: claim.jobId, sheetId: claim.sheetId, keyId: claim.keyId,
      archiveGenerationId: claim.archiveGenerationId, blockFence: claim.blockFence,
      workerOwnerId: claim.workerOwnerId, workerFence: claim.workerFence,
      leaseUntil: claim.leaseUntil, resumeDeadline: claim.resumeDeadline,
    }
    executingChunk = true
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await executeRecoveryArchiveAsyncRestoreChunk({
        transaction,
        query,
        runtime,
        claim,
        recheckAuthority: authorization.recheckAuthority,
        apply: authorization.apply,
      })
      if (result.kind === 'no_pending_chunk') {
        throw new Error('archive_process_crash_boundary_missing')
      }
    }
    throw new Error('archive_process_chunk_bound_exceeded')
  } finally {
    await pool.end()
  }
}

if (process.env.METASHEET_ARCHIVE_PROCESS_FIXTURE === '1' && process.send) {
  process.once('message', (input: ArchiveProcessWorkerInput) => {
    void run(input).catch(async (error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' && /^RECOVERY_ARCHIVE_[A-Z_]+$/.test(error.code)
        ? error.code : 'archive_process_worker_failed'
      await send({ kind: 'error', code })
      process.exitCode = 1
    }).finally(() => {
      if (process.connected) process.disconnect()
    })
  })
}
