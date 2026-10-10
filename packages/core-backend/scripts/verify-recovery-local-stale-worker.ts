/** Test-only native scenario; original claim objects never leave this process. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  RecoveryArchiveApplicationComposition,
  RecoveryArchiveApplicationDatabaseRuntime,
} from '../src/multitable/recovery-archive-application'
import { executeRecoveryArchiveAsyncRestoreChunk } from '../src/multitable/recovery-archive-async-restore'
import {
  claimRecoveryArchiveRestoreJob,
  finalizeRecoveryArchiveRestoreJob,
  readRecoveryArchiveRestoreWorkerBinding,
  RecoveryArchiveRestoreJobError,
  selectRecoveryArchiveRestoreJobCandidate,
  type RecoveryArchiveRestoreJobQuery,
} from '../src/multitable/recovery-archive-restore-jobs'

import type { ManualChunkWitness } from './verify-recovery-local-scenarios'

async function snapshot(query: RecoveryArchiveRestoreJobQuery) {
  const tables = await query(`SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname='public' ORDER BY tablename`)
  const names = tables.rows.map(row => (row as { tablename: string }).tablename)
  for (const required of ['meta_sheets', 'meta_records', 'meta_record_revisions',
    'meta_recovery_archive_jobs', 'meta_recovery_archive_job_chunks',
    'meta_recovery_archive_nonce_reservations', 'meta_recovery_archive_derived_effects']) {
    assert.ok(names.includes(required), 'RECOVERY_LOCAL_STALE_WORKER_SNAPSHOT_TABLE_MISSING')
  }
  const state: Array<{ table: string; count: number; digest: string }> = []
  for (const table of names) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/, 'RECOVERY_LOCAL_STALE_WORKER_SNAPSHOT_TABLE_REFUSED')
    const rows = await query(`SELECT to_jsonb(entry) AS value FROM public."${table}" entry
      ORDER BY to_jsonb(entry)::text`)
    state.push({ table, count: rows.rows.length,
      digest: createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex') })
  }
  const sequence = await query('SELECT last_value::text, is_called FROM public.meta_record_chain_seq')
  assert.equal(sequence.rows.length, 1)
  return { state, sequence: sequence.rows }
}

/** Pause is ordinary awaited test code outside transactions; no DB lease/clock edits. */
export async function runGenuineStaleWorkerScenario(input: {
  readonly database: RecoveryArchiveApplicationDatabaseRuntime
  readonly composition: RecoveryArchiveApplicationComposition
  readonly jobId: string
  readonly generationId: string
  readonly signal: AbortSignal
}): Promise<{ firstChunks: ManualChunkWitness[]; blockFence: string }> {
  const { database, composition, jobId, generationId, signal } = input
  const query: RecoveryArchiveRestoreJobQuery = (text, values) => {
    signal.throwIfAborted()
    return database.query(text, values)
  }
  const outside = () => {
    signal.throwIfAborted()
    assert.equal(database.transactionDepthProbe.currentTransactionDepth(), 0,
      'RECOVERY_LOCAL_STALE_WORKER_TRANSACTION_RETAINED')
  }
  const claim = async (owner: string) => {
    outside()
    const candidate = await selectRecoveryArchiveRestoreJobCandidate(database.transaction)
    assert.equal(candidate?.jobId, jobId, 'RECOVERY_LOCAL_STALE_WORKER_CANDIDATE_MISMATCH')
    assert.equal(candidate?.archiveGenerationId, generationId,
      'RECOVERY_LOCAL_STALE_WORKER_GENERATION_MISMATCH')
    const clock = await query(`SELECT LEAST($1::timestamptz,
      clock_timestamp()+interval '60 seconds')::text AS lease_until`, [candidate!.resumeDeadline])
    return claimRecoveryArchiveRestoreJob(database.transaction, candidate!, {
      workerOwnerId: owner,
      leaseUntil: (clock.rows[0] as { lease_until: string }).lease_until,
    })
  }
  const firstClaim = await claim(`tm-stale-a-${randomUUID()}`)
  assert.equal(Object.isFrozen(firstClaim), true)
  // Positive control: the exact original claim is accepted before the takeover.
  await readRecoveryArchiveRestoreWorkerBinding(query, firstClaim)
  const execute = (workerClaim: typeof firstClaim) => executeRecoveryArchiveAsyncRestoreChunk({
    transaction: database.transaction,
    query,
    runtime: { keyCustody: composition.keyCustody, objectStore: composition.objectStore,
      transactionDepth: database.transactionDepthProbe,
      ...(composition.attachmentStorage ? { attachmentStorage: composition.attachmentStorage } : {}) },
    claim: workerClaim,
    recheckAuthority: composition.worker.recheckAuthority,
    apply: composition.worker.apply,
  })
  assert.deepEqual(await execute(firstClaim), { kind: 'committed', chunkIndex: 0, completedCount: '5000' })
  outside()
  const firstChunks = (await query(`SELECT chunk_index,state,committed_count::text,operation_id::text
    FROM public.meta_recovery_archive_job_chunks WHERE job_id=$1::uuid ORDER BY chunk_index`, [jobId])).rows as ManualChunkWitness[]
  assert.deepEqual(firstChunks.map(row => [row.chunk_index, row.state, row.committed_count]),
    [[0, 'committed', '5000'], [1, 'pending', null]])
  const deadline = Date.now() + 90_000
  while (true) {
    outside()
    const lease = await query(`SELECT lease_until<=clock_timestamp() AS expired
      FROM public.meta_recovery_archive_jobs WHERE id=$1::uuid`, [jobId])
    assert.equal(lease.rows.length, 1)
    if ((lease.rows[0] as { expired: boolean }).expired === true) break
    assert.ok(Date.now() < deadline, 'RECOVERY_LOCAL_STALE_WORKER_LEASE_TIMEOUT')
    await delay(25, undefined, { signal })
  }
  const nextClaim = await claim(`tm-stale-b-${randomUUID()}`)
  assert.equal(nextClaim.blockFence, firstClaim.blockFence)
  assert.equal(nextClaim.workerFence, (BigInt(firstClaim.workerFence) + 1n).toString())
  assert.notEqual(nextClaim.workerOwnerId, firstClaim.workerOwnerId)
  outside()
  const before = await snapshot(query)
  const leaseLost = (error: unknown) => error instanceof RecoveryArchiveRestoreJobError
    && error.code === 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST'
  await assert.rejects(() => readRecoveryArchiveRestoreWorkerBinding(query, firstClaim), leaseLost,
    'RECOVERY_LOCAL_STALE_WORKER_BINDING_NOT_REFUSED')
  outside()
  assert.deepEqual(await snapshot(query), before, 'RECOVERY_LOCAL_STALE_WORKER_BINDING_CHANGED_STATE')
  await assert.rejects(() => execute(firstClaim), leaseLost, 'RECOVERY_LOCAL_STALE_WORKER_CHUNK_NOT_REFUSED')
  outside()
  assert.deepEqual(await snapshot(query), before, 'RECOVERY_LOCAL_STALE_WORKER_CHUNK_CHANGED_STATE')
  // The new real claim must still be usable after both old-claim refusals.
  assert.deepEqual(await execute(nextClaim), { kind: 'committed', chunkIndex: 1, completedCount: '5001' })
  assert.deepEqual(await execute(nextClaim), { kind: 'no_pending_chunk' })
  await finalizeRecoveryArchiveRestoreJob(database.transaction, nextClaim, {
    replayHorizonMs: composition.worker.replayHorizonMs,
  })
  outside()
  return { firstChunks, blockFence: firstClaim.blockFence }
}
