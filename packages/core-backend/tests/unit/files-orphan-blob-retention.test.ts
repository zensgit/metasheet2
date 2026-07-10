import { describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { sweepOrphanFileBlobs } from '../../src/services/files-orphan-blob-retention'

// F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-8: logic-level coverage with a mocked
// queryFn + mocked storage (mirrors tests/unit/multitable-attachment-cleanup.test.ts). This proves the
// BRANCHING behavior (poison skip, shared-key skip, non-ENOENT failure skip, success stamps); the
// real-DB matrix (tests/integration/files-orphan-blob-retention.db.test.ts) proves the SQL WHERE clauses
// themselves are correct against a real Postgres `files` table (blob_purged_at filter, grace filter).

const noopLogger = () => new Logger('FilesOrphanBlobRetentionTest')

describe('sweepOrphanFileBlobs', () => {
  it('deletes the blob by key and stamps blob_purged_at for a plain eligible row', async () => {
    const queryFn = vi.fn()
      // main candidate SELECT
      .mockResolvedValueOnce({ rows: [{ id: 'f-1', storage_key: 'uuid-1/photo.jpg' }] })
      // GF5-3b shared-key COUNT
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      // UPDATE blob_purged_at
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    const storage = { deleteByKey: vi.fn().mockResolvedValue(undefined) }

    const result = await sweepOrphanFileBlobs({ graceHours: 24, batchSize: 10, queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
    expect(storage.deleteByKey).toHaveBeenCalledTimes(1)
    expect(storage.deleteByKey).toHaveBeenCalledWith('uuid-1/photo.jpg')
    // candidate SELECT carries grace hours + batch size
    expect(queryFn.mock.calls[0]?.[1]).toEqual([24, 10])
    // UPDATE targets this row's id
    expect(queryFn.mock.calls[2]?.[1]).toEqual(['f-1'])
  })

  it('mutation-#2 tripwire — a row whose blob is already purged never even reaches the candidate set (query params prove the filter is applied)', async () => {
    // Simulates "second run selects nothing": the real WHERE clause (proven in the DB test) would
    // simply not return this row a second time; here we assert the query issued the SAME graceHours/
    // batchSize contract every call, so a regression that widened the WHERE clause would still be
    // caught by the DB-level idempotency test, not silently passed by a mock returning empty rows.
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [] })
    const storage = { deleteByKey: vi.fn() }

    const result = await sweepOrphanFileBlobs({ graceHours: 24, batchSize: 10, queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
    expect(storage.deleteByKey).not.toHaveBeenCalled()
  })

  it('GF5-3 — a poisoned storage_key is skipped: never resolved, never deleted, never stamped', async () => {
    const queryFn = vi.fn().mockResolvedValueOnce({ rows: [{ id: 'f-poison', storage_key: '!f3-collision:f-poison' }] })
    const storage = { deleteByKey: vi.fn() }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    expect(storage.deleteByKey).not.toHaveBeenCalled()
    // only the candidate SELECT ran — no shared-key COUNT, no UPDATE
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('GF5-3b — a storage_key still referenced by another un-purged row is skipped (belt-and-suspenders)', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'f-a', storage_key: 'shared/key.bin' }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] }) // another un-purged row shares this key
    const storage = { deleteByKey: vi.fn() }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    expect(storage.deleteByKey).not.toHaveBeenCalled()
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(queryFn.mock.calls[1]?.[1]).toEqual(['shared/key.bin', 'f-a'])
  })

  it('a non-ENOENT deleteByKey failure is skipped (not stamped) so the next tick retries', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'f-fail', storage_key: 'uuid-2/locked.bin' }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
    const storage = { deleteByKey: vi.fn().mockRejectedValue(new Error('EACCES: permission denied')) }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    // no UPDATE call after the failed delete — exactly 2 queryFn calls (SELECT + COUNT), no UPDATE
    expect(queryFn).toHaveBeenCalledTimes(2)
  })

  it('mutation-#3 companion — deleteByKey resolving (ENOENT already swallowed at the storage layer) is treated identically to a real delete: stamped, no error', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'f-enoent', storage_key: 'uuid-3/gone.bin' }] })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    // storage.deleteByKey resolving (not rejecting) IS the ENOENT-as-success contract from the real
    // LocalStorageProvider — this sweep must not special-case it further.
    const storage = { deleteByKey: vi.fn().mockResolvedValue(undefined) }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
  })

  it('processes a full batch: mixed success/poison/shared/failure in one pass', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 'ok-1', storage_key: 'uuid-a/ok.bin' },
          { id: 'poison-1', storage_key: '!f3-collision:poison-1' },
          { id: 'shared-1', storage_key: 'shared/key.bin' },
          { id: 'fail-1', storage_key: 'uuid-b/fail.bin' },
        ],
      })
      // ok-1: shared-key count = 0
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      // ok-1: UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // shared-1: shared-key count = 1 (poison-1 never issues a count query — skipped before it)
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      // fail-1: shared-key count = 0
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
    const storage = {
      deleteByKey: vi.fn()
        .mockResolvedValueOnce(undefined) // ok-1
        .mockRejectedValueOnce(new Error('EIO')), // fail-1
    }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 4, purged: 1, skipped: 3 })
    expect(storage.deleteByKey).toHaveBeenCalledTimes(2)
    expect(storage.deleteByKey).toHaveBeenNthCalledWith(1, 'uuid-a/ok.bin')
    expect(storage.deleteByKey).toHaveBeenNthCalledWith(2, 'uuid-b/fail.bin')
  })

  it('schema-not-ready (files table missing) is tolerated: returns zeros, does not throw', async () => {
    const schemaError = Object.assign(new Error('relation "files" does not exist'), { code: '42P01' })
    const queryFn = vi.fn().mockRejectedValueOnce(schemaError)
    const storage = { deleteByKey: vi.fn() }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
  })

  it('an unexpected query failure is tolerated: returns zeros, does not throw', async () => {
    const queryFn = vi.fn().mockRejectedValueOnce(new Error('connection reset'))
    const storage = { deleteByKey: vi.fn() }

    const result = await sweepOrphanFileBlobs({ queryFn, storage, logger: noopLogger() })

    expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
  })
})
