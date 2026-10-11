import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimRecoveryArchiveRestoreJob,
  renewRecoveryArchiveRestoreJobLease,
  selectRecoveryArchiveRestoreJobCandidate,
  type RecoveryArchiveRestoreJobQuery,
  type RecoveryArchiveRestoreJobTransaction,
  type RecoveryArchiveRestoreJobWorkerClaim,
} from '../../src/multitable/recovery-archive-restore-jobs'
import {
  ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
  ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS,
  ARCHIVE_WRITER_BLOCK_PREPARED_STATE_SQL,
  ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL,
} from '../../src/multitable/recovery-archive-writer-block'

const LEASE = '2030-01-01T00:01:00.000Z'
const RENEWED_LEASE = '2030-01-01T00:02:00.000Z'

function fixture() {
  let now = Date.parse('2030-01-01T00:00:00.000Z')
  let expireAfterLock = false
  const row = {
    id: '11111111-1111-4111-8111-111111111111', sheet_id: 'renewal-sheet', key_id: 'renewal-key',
    archive_generation_id: '22222222-2222-4222-8222-222222222222', block_fence: '7',
    resume_deadline: '2030-01-01T00:10:00.000Z', state: 'planned', row_version: '1',
    worker_owner_id: null as string | null, worker_fence: '0', lease_until: null as string | null,
  }
  const query = vi.fn<RecoveryArchiveRestoreJobQuery>(async (sql, params) => {
    if (sql === ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL) return { rows: [{ xid: '42', isolation: 'read committed' }] }
    if (sql === ARCHIVE_WRITER_BLOCK_PREPARED_STATE_SQL) return { rows: [{ xid: '42', fence_held: true }] }
    if (sql.includes('attribute.attname AS column_name')) return { rows: ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS.map(value => ({ ...value })) }
    if (sql.includes('constraint_row.conname AS constraint_name')) return { rows: ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map(value => ({ ...value })) }
    if (sql.includes('FROM public.meta_recovery_archive_keys')) return { rows: [{ key_id: row.key_id }] }
    if (sql.includes('FROM public.meta_recovery_archives')) return { rows: [{ generation_id: row.archive_generation_id }] }
    if (sql.includes('FROM public.meta_sheets')) return { rows: [{ id: row.sheet_id }] }
    if (sql.includes('FROM public.meta_recovery_archive_jobs') && sql.includes('FOR UPDATE')) {
      const observed = { ...row, lease_live: row.lease_until !== null && Date.parse(row.lease_until) > now,
        lease_expired: row.lease_until !== null && Date.parse(row.lease_until) <= now,
        resume_live: Date.parse(row.resume_deadline) > now }
      if (expireAfterLock) now = Date.parse(LEASE)
      return { rows: [observed] }
    }
    if (sql.includes("SET state = 'applying'")) {
      row.state = 'applying'
      row.worker_owner_id = params![1] as string
      row.worker_fence = (BigInt(row.worker_fence) + 1n).toString()
      row.lease_until = params![2] as string
      row.row_version = (BigInt(row.row_version) + 1n).toString()
      return { rows: [{ worker_fence: row.worker_fence, lease_until: row.lease_until }], rowCount: 1 }
    }
    if (sql.includes('SET lease_until = $2::timestamptz')) {
      // Model the old-lease predicate at statement time, independently of the earlier SELECT result.
      const requiresLiveOldLease = /\bAND\s+lease_until\s*>\s*clock_timestamp\(\)/.test(sql)
      if (requiresLiveOldLease && Date.parse(row.lease_until!) <= now) return { rows: [], rowCount: 0 }
      row.lease_until = params![1] as string
      row.row_version = (BigInt(row.row_version) + 1n).toString()
      return { rows: [{ lease_until: row.lease_until }], rowCount: 1 }
    }
    throw new Error('UNEXPECTED_RENEWAL_QUERY')
  })
  const transaction: RecoveryArchiveRestoreJobTransaction = async work => work(query)
  return {
    row, query, transaction,
    expireAfterLock: () => { expireAfterLock = true },
    expireBeforeLock: () => { now = Date.parse(LEASE) },
    claim: async () => {
      const candidate = await selectRecoveryArchiveRestoreJobCandidate(transaction)
      expect(candidate).not.toBeNull()
      return claimRecoveryArchiveRestoreJob(transaction, candidate!, { workerOwnerId: 'renewal-worker-a', leaseUntil: LEASE })
    },
    renew: (claim: RecoveryArchiveRestoreJobWorkerClaim) => renewRecoveryArchiveRestoreJobLease(transaction, claim, { leaseUntil: RENEWED_LEASE }),
  }
}

describe('recovery archive worker lease renewal', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('renews a live branded claim and invalidates the prior authority', async () => {
    const f = fixture()
    const claim = await f.claim()
    const renewed = await f.renew(claim)
    expect(renewed).toEqual({ ...claim, leaseUntil: RENEWED_LEASE })
    expect(renewed).not.toBe(claim)
    expect(Object.isFrozen(renewed)).toBe(true)
    expect(f.row.row_version).toBe('3')
    const calls = f.query.mock.calls.length
    await expect(f.renew(claim)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    expect(f.query).toHaveBeenCalledTimes(calls)
  })

  it('writes zero when the old lease expires between its locked SELECT and renewal UPDATE', async () => {
    const f = fixture()
    const claim = await f.claim()
    const before = { ...f.row }
    f.expireAfterLock()
    await expect(f.renew(claim)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST' })
    expect(f.row).toEqual(before)
    const updates = f.query.mock.calls.filter(([sql]) => sql.includes('SET lease_until = $2::timestamptz'))
    expect(updates).toHaveLength(1)
    expect(updates[0]![1]).toEqual([claim.jobId, RENEWED_LEASE, '2', claim.workerOwnerId, claim.workerFence, claim.leaseUntil])
  })

  it('refuses an already expired claim before issuing a renewal UPDATE', async () => {
    const f = fixture()
    const claim = await f.claim()
    f.expireBeforeLock()
    await expect(f.renew(claim)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST' })
    expect(f.query.mock.calls.filter(([sql]) => sql.includes('SET lease_until = $2::timestamptz'))).toEqual([])
  })

  it('refuses a genuine old claim after a different owner takes a higher worker fence', async () => {
    const f = fixture()
    const claim = await f.claim()
    f.row.worker_owner_id = 'renewal-worker-b'
    f.row.worker_fence = '2'
    const before = { ...f.row }
    await expect(f.renew(claim)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_LEASE_LOST' })
    expect(f.row).toEqual(before)
    expect(f.query.mock.calls.filter(([sql]) => sql.includes('SET lease_until = $2::timestamptz'))).toEqual([])
  })

  it('refuses a serialized tuple before entering a transaction', async () => {
    const f = fixture()
    const claim = await f.claim()
    const copied = JSON.parse(JSON.stringify(claim)) as RecoveryArchiveRestoreJobWorkerClaim
    const calls = f.query.mock.calls.length
    await expect(f.renew(copied)).rejects.toMatchObject({ code: 'RECOVERY_ARCHIVE_RESTORE_JOB_INVALID_INPUT' })
    expect(f.query).toHaveBeenCalledTimes(calls)
  })
})
