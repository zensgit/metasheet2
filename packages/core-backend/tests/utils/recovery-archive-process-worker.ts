import { Pool } from 'pg'

import { executeRecoveryArchiveAsyncRestoreChunk } from '../../src/multitable/recovery-archive-async-restore'
import type {
  RecoveryArchiveObjectReadRequest,
  RecoveryArchiveObjectReadResult,
  RecoveryArchiveObjectStoreProvider,
} from '../../src/multitable/recovery-archive-object-store'
import {
  claimRecoveryArchiveRestoreJob,
  finalizeRecoveryArchiveRestoreJob,
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
  readonly phase: 'before_commit' | 'after_commit' | 'finish'
  readonly applicationName: string
  readonly keyId: string
  readonly keyMaterial: RecoveryArchiveFixtureKeyMaterial
  readonly jobId: string
  readonly priorClaim?: ArchiveProcessClaimSnapshot
}

export type ArchiveProcessWorkerMessage =
  | { kind: 'read-object'; requestId: number; request: RecoveryArchiveObjectReadRequest }
  | { kind: 'boundary'; phase: 'before_commit' | 'after_commit'; pid: number; claim: ArchiveProcessClaimSnapshot }
  | {
      kind: 'done'
      pid: number
      claim: ArchiveProcessClaimSnapshot
      results: Awaited<ReturnType<typeof executeRecoveryArchiveAsyncRestoreChunk>>[]
      terminal: Awaited<ReturnType<typeof finalizeRecoveryArchiveRestoreJob>>
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
    max: 1,
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
  try {
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
    const clock = await query("SELECT clock_timestamp() + interval '30 seconds' AS lease_until")
    const claim = await claimRecoveryArchiveRestoreJob(transaction, candidate, {
      workerOwnerId: input.applicationName,
      leaseUntil: input.phase === 'finish'
        ? new Date(Date.now() + 240_000) : (clock.rows[0] as { lease_until: Date }).lease_until,
    })
    claimSnapshot = {
      jobId: claim.jobId, sheetId: claim.sheetId, keyId: claim.keyId,
      archiveGenerationId: claim.archiveGenerationId, blockFence: claim.blockFence,
      workerOwnerId: claim.workerOwnerId, workerFence: claim.workerFence,
      leaseUntil: claim.leaseUntil, resumeDeadline: claim.resumeDeadline,
    }
    executingChunk = true
    const runtime = {
      keyCustody: createFixtureKeyCustody(input.keyId, [], input.keyMaterial),
      objectStore,
      transactionDepth: { currentTransactionDepth: () => depth },
    }
    const results: Awaited<ReturnType<typeof executeRecoveryArchiveAsyncRestoreChunk>>[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await executeRecoveryArchiveAsyncRestoreChunk({
        transaction,
        query,
        runtime,
        claim,
        // Synthetic policy only: this fixture proves process durability, not authorization.
        recheckAuthority: async () => true,
        apply: {
          preliminaryFullRead: async () => true,
          stabilizeAuthorization: async () => 'ready',
          finalLockedFullRead: async () => true,
          evaluatePlanAuthorization: async () => true,
        },
      })
      results.push(result)
      if (result.kind === 'no_pending_chunk') {
        const terminal = await finalizeRecoveryArchiveRestoreJob(transaction, claim, { replayHorizonMs: 0 })
        await send({ kind: 'done', pid: process.pid, claim: claimSnapshot, results, terminal })
        return
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
