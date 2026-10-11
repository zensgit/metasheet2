import { describe, expect, it, vi } from 'vitest'
import type {
  RecoveryArchiveApplicationComposition,
  RecoveryArchiveApplicationDatabaseRuntime,
} from '../../src/multitable/recovery-archive-application'
import type { RecoveryArchiveRestoreJobWorkerClaim } from '../../src/multitable/recovery-archive-restore-jobs'

const mocks = vi.hoisted(() => ({
  select: vi.fn(), claim: vi.fn(), binding: vi.fn(), execute: vi.fn(), finalize: vi.fn(),
}))
vi.mock('../../src/multitable/recovery-archive-restore-jobs', () => ({
  selectRecoveryArchiveRestoreJobCandidate: mocks.select,
  claimRecoveryArchiveRestoreJob: mocks.claim,
  readRecoveryArchiveRestoreWorkerBinding: mocks.binding,
  finalizeRecoveryArchiveRestoreJob: mocks.finalize,
  RecoveryArchiveRestoreJobError: class extends Error {
    constructor(readonly code: string) { super(code) }
  },
}))
vi.mock('../../src/multitable/recovery-archive-async-restore', () => ({
  executeRecoveryArchiveAsyncRestoreChunk: mocks.execute,
}))

import { RecoveryArchiveRestoreJobError } from '../../src/multitable/recovery-archive-restore-jobs'
import {
  qualifyManualTargetPair, type ManualTargetResult,
} from '../../scripts/verify-recovery-local-scenarios'
import { runGenuineStaleWorkerScenario } from '../../scripts/verify-recovery-local-stale-worker'

const digest = 'a'.repeat(64)
const crash: ManualTargetResult = { scenario: 'process-crash', generationId: 'generation',
  databaseOid: '11', backupDigest: digest, rollbackTableCount: 20, staleWorkerClaimQualified: false }
const stale: ManualTargetResult = { ...crash, scenario: 'stale-worker', databaseOid: '12',
  staleWorkerClaimQualified: true }
const hold = { result: 'HOLD', staleWorkerClaimQualified: false,
  holdReason: 'RECOVERY_LOCAL_BACKUP_MANUAL_SCENARIO_PAIR_UNQUALIFIED' }

describe('same-archive two-scenario qualification', () => {
  it('requires both distinct current-run targets and the same genuine generation/backup', () => {
    expect(qualifyManualTargetPair(crash, stale, 'generation', digest))
      .toEqual({ result: 'PASS', staleWorkerClaimQualified: true })
  })
  it.each([
    ['missing crash', undefined, stale], ['missing stale', crash, undefined],
    ['two crashes', crash, crash], ['two stale workers', stale, stale],
    ['wrong crash generation', { ...crash, generationId: 'other' }, stale],
    ['wrong stale generation', crash, { ...stale, generationId: 'other' }],
    ['wrong crash backup', { ...crash, backupDigest: 'b'.repeat(64) }, stale],
    ['wrong stale backup', crash, { ...stale, backupDigest: 'b'.repeat(64) }],
    ['same database', crash, { ...stale, databaseOid: crash.databaseOid }],
    ['missing database', crash, { ...stale, databaseOid: '' }],
    ['tuple only', crash, { ...stale, staleWorkerClaimQualified: false }],
    ['claim attributed to dead worker', { ...crash, staleWorkerClaimQualified: true }, stale],
    ['incomplete rollback', crash, { ...stale, rollbackTableCount: 5 }],
    ['fractional rollback', crash, { ...stale, rollbackTableCount: 6.5 }],
    ['invalid scenario', crash, { ...stale, scenario: 'unknown' }],
  ])('keeps %s on HOLD', (_name, a, b) => {
    expect(qualifyManualTargetPair(a as ManualTargetResult | undefined,
      b as ManualTargetResult | undefined, 'generation', digest)).toEqual(hold)
  })
  it('refuses an invalid expected backup digest', () => {
    expect(qualifyManualTargetPair(crash, stale, 'generation', '')).toEqual(hold)
  })
})

// Mocked orchestration only: no listener, subprocess, database, filesystem provider or native claim.
function fixture(mode: 'normal' | 'binding-writes' | 'chunk-writes' | 'invalid-claim'
  | 'binding-allows' | 'chunk-allows' | 'aborted' | 'transaction' | 'waiting' = 'normal') {
  vi.clearAllMocks()
  const controller = new AbortController()
  const claimed: RecoveryArchiveRestoreJobWorkerClaim[] = []
  let recordValue = 1
  let sequenceValue = '10'
  let firstApplied = false
  let expiryReads = 0
  const firstChunks = [
    { chunk_index: 0, state: 'committed', committed_count: '5000', operation_id: 'first' },
    { chunk_index: 1, state: 'pending', committed_count: null, operation_id: null },
  ]
  const tables = ['meta_sheets', 'meta_records', 'meta_record_revisions', 'meta_recovery_archive_jobs',
    'meta_recovery_archive_job_chunks', 'meta_recovery_archive_nonce_reservations',
    'meta_recovery_archive_derived_effects']
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_tables')) return { rows: tables.map(tablename => ({ tablename })), rowCount: tables.length }
    if (sql.includes('AS lease_until')) return { rows: [{ lease_until: '2099-01-01T00:00:00Z' }], rowCount: 1 }
    if (sql.includes('AS expired')) {
      expiryReads++
      return { rows: [{ expired: mode !== 'waiting' || expiryReads > 1 }], rowCount: 1 }
    }
    if (sql.includes('SELECT chunk_index')) return { rows: firstChunks, rowCount: 2 }
    if (sql.includes('meta_record_chain_seq')) return { rows: [{ last_value: sequenceValue, is_called: true }], rowCount: 1 }
    return { rows: [{ value: { stable: sql.includes('"meta_records"') ? recordValue : 1 } }], rowCount: 1 }
  })
  const transaction = vi.fn()
  const probe = { currentTransactionDepth: () => mode === 'transaction' ? 1 : 0 }
  const database = { query, transaction, transactionDepthProbe: probe } as unknown as RecoveryArchiveApplicationDatabaseRuntime
  const composition = { keyCustody: {}, objectStore: {}, worker: {
    recheckAuthority: vi.fn(), apply: {}, replayHorizonMs: 60_000,
  } } as unknown as RecoveryArchiveApplicationComposition
  mocks.select.mockResolvedValue({ jobId: 'job', archiveGenerationId: 'generation', resumeDeadline: '2099-01-01T00:00:00Z' })
  mocks.claim.mockImplementation(async (_transaction, candidate, input) => {
    const value = Object.freeze({ ...candidate, blockFence: '7', workerFence: String(claimed.length + 1),
      workerOwnerId: input.workerOwnerId, leaseUntil: input.leaseUntil }) as RecoveryArchiveRestoreJobWorkerClaim
    claimed.push(value)
    return value
  })
  mocks.binding.mockImplementation(async (_query, value) => {
    if (value !== claimed[0]) throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT')
    if (claimed.length === 1) {
      if (mode === 'aborted') controller.abort()
      return {}
    }
    if (mode === 'binding-allows') return {}
    if (mode === 'binding-writes') recordValue++
    throw new RecoveryArchiveRestoreJobError(mode === 'invalid-claim'
      ? 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' : 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
  })
  mocks.execute.mockImplementation(async ({ claim }) => {
    if (claim === claimed[0] && claimed.length === 1) {
      firstApplied = true
      return { kind: 'committed', chunkIndex: 0, completedCount: '5000' }
    }
    if (claim === claimed[0]) {
      if (mode === 'chunk-allows') return { kind: 'committed', chunkIndex: 1, completedCount: '5001' }
      if (mode === 'chunk-writes') sequenceValue = '11'
      throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST')
    }
    if (claim !== claimed[1]) throw new RecoveryArchiveRestoreJobError('RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT')
    const result = firstApplied ? { kind: 'committed', chunkIndex: 1, completedCount: '5001' }
      : { kind: 'no_pending_chunk' }
    firstApplied = false
    return result
  })
  mocks.finalize.mockResolvedValue({ state: 'done' })
  return { input: { database, composition, jobId: 'job', generationId: 'generation', signal: controller.signal },
    claimed, query, firstChunks, transaction }
}

describe('genuine stale-worker scenario orchestration', () => {
  it('uses the original object for both refusals, then completes with the genuine new claim', async () => {
    const f = fixture()
    expect(await runGenuineStaleWorkerScenario(f.input)).toEqual({ firstChunks: f.firstChunks, blockFence: '7' })
    expect(mocks.binding.mock.calls.map(call => call[1])).toEqual([f.claimed[0], f.claimed[0]])
    expect(mocks.binding.mock.calls[1][1]).toBe(f.claimed[0])
    expect(mocks.execute.mock.calls[1][0].claim).toBe(f.claimed[0])
    expect(mocks.execute.mock.calls[2][0].claim).toBe(f.claimed[1])
    expect(mocks.execute.mock.calls[1][0].apply).toBe(f.input.composition.worker.apply)
    expect(mocks.finalize).toHaveBeenCalledWith(f.transaction, f.claimed[1], { replayHorizonMs: 60_000 })
    expect(f.query.mock.calls.some(([sql]) => /UPDATE|INSERT|DELETE|setval|nextval/i.test(sql))).toBe(false)
    expect(f.query.mock.calls.filter(([sql]) => sql.includes('meta_record_chain_seq'))).toHaveLength(3)
  })
  it.each([
    ['binding-writes', 'RECOVERY_LOCAL_STALE_WORKER_BINDING_CHANGED_STATE'],
    ['chunk-writes', 'RECOVERY_LOCAL_STALE_WORKER_CHUNK_CHANGED_STATE'],
    ['invalid-claim', 'RECOVERY_LOCAL_STALE_WORKER_BINDING_NOT_REFUSED'],
    ['binding-allows', 'RECOVERY_LOCAL_STALE_WORKER_BINDING_NOT_REFUSED'],
    ['chunk-allows', 'RECOVERY_LOCAL_STALE_WORKER_CHUNK_NOT_REFUSED'],
    ['transaction', 'RECOVERY_LOCAL_STALE_WORKER_TRANSACTION_RETAINED'],
  ] as const)('refuses %s', async (mode, code) => {
    const f = fixture(mode)
    await expect(runGenuineStaleWorkerScenario(f.input)).rejects.toThrow(code)
    expect(mocks.finalize).not.toHaveBeenCalled()
  })
  it('honors parent cancellation before takeover', async () => {
    const f = fixture('aborted')
    await expect(runGenuineStaleWorkerScenario(f.input)).rejects.toThrow()
    expect(mocks.claim).toHaveBeenCalledTimes(1)
    expect(mocks.finalize).not.toHaveBeenCalled()
  })
  it('does not claim worker B until SQL observes natural expiry', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture('waiting')
      const run = runGenuineStaleWorkerScenario(f.input)
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.claim).toHaveBeenCalledTimes(1)
      expect(f.query.mock.calls.filter(([sql]) => sql.includes('AS expired'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(25)
      await expect(run).resolves.toEqual({ firstChunks: f.firstChunks, blockFence: '7' })
      expect(mocks.claim).toHaveBeenCalledTimes(2)
      expect(f.query.mock.calls.filter(([sql]) => sql.includes('AS expired'))).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  it.each(['jobId', 'archiveGenerationId'] as const)('refuses a different candidate %s', async key => {
    const f = fixture()
    mocks.select.mockResolvedValue({ jobId: 'job', archiveGenerationId: 'generation',
      resumeDeadline: '2099-01-01T00:00:00Z', [key]: 'other' })
    await expect(runGenuineStaleWorkerScenario(f.input)).rejects.toThrow('RECOVERY_LOCAL_STALE_WORKER_')
    expect(mocks.claim).not.toHaveBeenCalled()
  })
})
