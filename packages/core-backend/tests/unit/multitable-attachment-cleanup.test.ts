import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  cleanupOrphanMultitableAttachments,
  sweepMultitableAttachmentBlobPurge,
} from '../../src/multitable/attachment-orphan-retention'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('cleanupOrphanMultitableAttachments', () => {
  it('marks orphan attachments deleted after storage cleanup succeeds', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { id: 'att-1', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' },
          { id: 'att-2', storage_file_id: 'file-2', storage_path: 'sheet-a/unassigned/file-2.bin' },
        ],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 })
    const storage = {
      delete: vi.fn().mockResolvedValue(undefined),
    }

    const result = await cleanupOrphanMultitableAttachments({
      retentionHours: 24,
      batchSize: 10,
      queryFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })

    expect(result).toEqual({ inspected: 2, deleted: 2, skipped: 0 })
    expect(storage.delete).toHaveBeenCalledTimes(2)
    expect(storage.delete).toHaveBeenNthCalledWith(1, 'file-1', 'sheet-a/unassigned/file-1.bin')
    expect(storage.delete).toHaveBeenNthCalledWith(2, 'file-2', 'sheet-a/unassigned/file-2.bin')
    expect(queryFn).toHaveBeenCalledTimes(3)
    expect(queryFn.mock.calls[1]?.[1]).toEqual(['att-1'])
    expect(queryFn.mock.calls[2]?.[1]).toEqual(['att-2'])
  })

  it('keeps db row when storage deletion fails with a real error', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'att-1', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
      })
    const storage = {
      delete: vi.fn().mockRejectedValue(new Error('permission denied')),
    }

    const result = await cleanupOrphanMultitableAttachments({
      queryFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })

    expect(result).toEqual({ inspected: 1, deleted: 0, skipped: 1 })
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('treats missing storage files as deletable and still tombstones db rows', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'att-1', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
      })
      .mockResolvedValue({ rows: [], rowCount: 1 })
    const storage = {
      delete: vi.fn().mockRejectedValue(new Error('File not found')),
    }

    const result = await cleanupOrphanMultitableAttachments({
      queryFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })

    expect(result).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
    expect(queryFn).toHaveBeenCalledTimes(2)
    expect(queryFn.mock.calls[1]?.[1]).toEqual(['att-1'])
  })

  it.each([
    ['archive disabled', 'false', 'true'],
    ['writer fence disabled', 'true', 'false'],
  ])('preserves the legacy orphan query and storage order when %s', async (_, archiveFlag, writerFenceFlag) => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', archiveFlag)
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', writerFenceFlag)
    const events: string[] = []
    const queryFn = vi.fn()
      .mockImplementationOnce(async () => ({
        rows: [{ id: 'att-1', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
      }))
      .mockImplementationOnce(async () => {
        events.push('legacy-update')
        return { rows: [], rowCount: 1 }
      })
    const storage = {
      delete: vi.fn(async () => {
        events.push('storage')
      }),
    }
    const transactionFn = vi.fn()

    await expect(cleanupOrphanMultitableAttachments({
      queryFn,
      transactionFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })).resolves.toEqual({ inspected: 1, deleted: 1, skipped: 0 })

    expect(queryFn.mock.calls[0]?.[0]).toBe(`SELECT id, storage_file_id, storage_path
         FROM multitable_attachments
        WHERE record_id IS NULL
          AND deleted_at IS NULL
          AND created_at < now() - make_interval(hours => $1)
        ORDER BY created_at ASC
        LIMIT $2`)
    expect(events).toEqual(['storage', 'legacy-update'])
    expect(transactionFn).not.toHaveBeenCalled()
  })

  it('does not call orphan storage when the guarded transaction finds an active source pin', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_file_id')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }] }
      if (text.startsWith('UPDATE multitable_attachments')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      throw new Error('unexpected_transaction_query')
    })
    const transactionFn = vi.fn(async (work) => work({ query: transactionQuery }))
    const storage = { delete: vi.fn() }

    await expect(cleanupOrphanMultitableAttachments({
      queryFn,
      transactionFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })).resolves.toEqual({ inspected: 1, deleted: 0, skipped: 1 })

    expect(transactionQuery.mock.calls[0]?.[0]).toMatch(/^SELECT pg_advisory_xact_lock/)
    expect(transactionQuery.mock.calls.some(([text]) => String(text).includes('meta_recovery_archive_attachment_refs'))).toBe(true)
    expect(storage.delete).not.toHaveBeenCalled()
  })

  it('commits the orphan tombstone before calling storage when both flags are enabled', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    let committed = false
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_file_id')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      if (text.startsWith('UPDATE multitable_attachments')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      throw new Error('unexpected_transaction_query')
    })
    const transactionFn = async (work: (client: { query: typeof transactionQuery }) => Promise<unknown>) => {
      const result = await work({ query: transactionQuery })
      committed = true
      return result
    }
    const storage = {
      delete: vi.fn(async () => {
        expect(committed).toBe(true)
      }),
    }

    await expect(cleanupOrphanMultitableAttachments({
      queryFn,
      transactionFn,
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })).resolves.toEqual({ inspected: 1, deleted: 1, skipped: 0 })

    expect(queryFn).toHaveBeenLastCalledWith(
      'UPDATE multitable_attachments SET blob_purged_at = now() WHERE id = $1 AND blob_purged_at IS NULL',
      ['att-1'],
    )
  })

  it('keeps guarded orphan storage failures values-free', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const sentinel = 'tenant/sheet-sensitive/private.bin'
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: sentinel }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_file_id')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: sentinel }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      if (text.startsWith('UPDATE multitable_attachments')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: sentinel }] }
      }
      throw new Error('unexpected_transaction_query')
    })
    const logger = new Logger('AttachmentCleanupTest')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await expect(cleanupOrphanMultitableAttachments({
      queryFn,
      transactionFn: async (work) => work({ query: transactionQuery }),
      storage: { delete: vi.fn().mockRejectedValue(new Error(`provider denied ${sentinel}`)) },
      logger,
    })).resolves.toEqual({ inspected: 1, deleted: 0, skipped: 1 })

    expect(warn).toHaveBeenCalledWith('MULTITABLE_ATTACHMENT_STORAGE_DELETE_FAILED')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel)
  })

  it('fails closed when the locked orphan row no longer belongs to the fenced sheet', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_file_id')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-b', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      if (text.startsWith('UPDATE multitable_attachments')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-b', storage_file_id: 'file-1', storage_path: 'sheet-a/unassigned/file-1.bin' }] }
      }
      throw new Error('unexpected_transaction_query')
    })
    const storage = { delete: vi.fn() }

    await expect(cleanupOrphanMultitableAttachments({
      queryFn,
      transactionFn: async (work) => work({ query: transactionQuery }),
      storage,
      logger: new Logger('AttachmentCleanupTest'),
    })).resolves.toEqual({ inspected: 1, deleted: 0, skipped: 1 })

    expect(storage.delete).not.toHaveBeenCalled()
    expect(transactionQuery.mock.calls.some(([text]) => String(text).startsWith('SELECT 1'))).toBe(false)
  })
})

describe('sweepMultitableAttachmentBlobPurge', () => {
  it.each([
    ['archive disabled', 'false', 'true'],
    ['writer fence disabled', 'true', 'false'],
  ])('preserves the legacy blob-purge query and storage order when %s', async (_, archiveFlag, writerFenceFlag) => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', archiveFlag)
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', writerFenceFlag)
    const events: string[] = []
    const queryFn = vi.fn()
      .mockImplementationOnce(async () => ({ rows: [{ id: 'att-1', storage_path: 'sheet-a/deleted/file-1.bin' }] }))
      .mockImplementationOnce(async () => {
        events.push('legacy-stamp')
        return { rows: [], rowCount: 1 }
      })
    const storage = { deleteByKey: vi.fn(async () => events.push('storage')) }
    const transactionFn = vi.fn()

    await expect(sweepMultitableAttachmentBlobPurge({
      queryFn,
      transactionFn,
      storage,
      logger: new Logger('AttachmentPurgeTest'),
    })).resolves.toEqual({ inspected: 1, purged: 1, skipped: 0 })

    expect(queryFn.mock.calls[0]?.[0]).toBe(`SELECT id, storage_path
         FROM multitable_attachments
        WHERE deleted_at IS NOT NULL
          AND blob_purged_at IS NULL
          AND deleted_at < now() - make_interval(hours => $1)
        ORDER BY deleted_at ASC
        LIMIT $2`)
    expect(events).toEqual(['storage', 'legacy-stamp'])
    expect(transactionFn).not.toHaveBeenCalled()
  })

  it('does not call blob-purge storage when the guarded transaction finds an active source pin', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: 'sheet-a/deleted/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_path')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: 'sheet-a/deleted/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }] }
      throw new Error('unexpected_transaction_query')
    })
    const transactionFn = vi.fn(async (work) => work({ query: transactionQuery }))
    const storage = { deleteByKey: vi.fn() }

    await expect(sweepMultitableAttachmentBlobPurge({
      queryFn,
      transactionFn,
      storage,
      logger: new Logger('AttachmentPurgeTest'),
    })).resolves.toEqual({ inspected: 1, purged: 0, skipped: 1 })

    expect(transactionQuery.mock.calls[0]?.[0]).toMatch(/^SELECT pg_advisory_xact_lock/)
    expect(transactionQuery.mock.calls.some(([text]) => String(text).includes('meta_recovery_archive_attachment_refs'))).toBe(true)
    expect(storage.deleteByKey).not.toHaveBeenCalled()
  })

  it('commits the blob-purge row lock before calling storage when both flags are enabled', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    let committed = false
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: 'sheet-a/deleted/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_path')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: 'sheet-a/deleted/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      throw new Error('unexpected_transaction_query')
    })
    const transactionFn = async (work: (client: { query: typeof transactionQuery }) => Promise<unknown>) => {
      const result = await work({ query: transactionQuery })
      committed = true
      return result
    }
    const storage = {
      deleteByKey: vi.fn(async () => {
        expect(committed).toBe(true)
      }),
    }

    await expect(sweepMultitableAttachmentBlobPurge({
      queryFn,
      transactionFn,
      storage,
      graceHours: 24,
      logger: new Logger('AttachmentPurgeTest'),
    })).resolves.toEqual({ inspected: 1, purged: 1, skipped: 0 })

    const lockedRead = transactionQuery.mock.calls.find(([text]) => String(text).startsWith('SELECT id, sheet_id, storage_path'))
    expect(lockedRead?.[1]).toEqual(['att-1', 24])
  })

  it('keeps guarded blob-purge storage failures values-free', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const sentinel = 'tenant/sheet-sensitive/private.bin'
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: sentinel }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_path')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: sentinel }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      throw new Error('unexpected_transaction_query')
    })
    const logger = new Logger('AttachmentPurgeTest')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

    await expect(sweepMultitableAttachmentBlobPurge({
      queryFn,
      transactionFn: async (work) => work({ query: transactionQuery }),
      storage: { deleteByKey: vi.fn().mockRejectedValue(new Error(`provider denied ${sentinel}`)) },
      graceHours: 24,
      logger,
    })).resolves.toEqual({ inspected: 1, purged: 0, skipped: 1 })

    expect(warn).toHaveBeenCalledWith('MULTITABLE_ATTACHMENT_BLOB_PURGE_STORAGE_DELETE_FAILED')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel)
  })

  it('fails closed when the locked blob row no longer belongs to the fenced sheet', async () => {
    vi.stubEnv('MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    const queryFn = vi.fn().mockResolvedValue({
      rows: [{ id: 'att-1', sheet_id: 'sheet-a', storage_path: 'sheet-a/deleted/file-1.bin' }],
    })
    const transactionQuery = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (text.includes('information_schema.columns')) return { rows: [{ present: true }] }
      if (text.startsWith('SELECT recovery_writer_state')) return { rows: [{ recovery_writer_state: null }] }
      if (text.startsWith('SELECT id, sheet_id, storage_path')) {
        return { rows: [{ id: 'att-1', sheet_id: 'sheet-b', storage_path: 'sheet-a/deleted/file-1.bin' }] }
      }
      if (text.startsWith('SELECT 1')) return { rows: [] }
      throw new Error('unexpected_transaction_query')
    })
    const storage = { deleteByKey: vi.fn() }

    await expect(sweepMultitableAttachmentBlobPurge({
      queryFn,
      transactionFn: async (work) => work({ query: transactionQuery }),
      storage,
      graceHours: 24,
      logger: new Logger('AttachmentPurgeTest'),
    })).resolves.toEqual({ inspected: 1, purged: 0, skipped: 1 })

    expect(storage.deleteByKey).not.toHaveBeenCalled()
    expect(transactionQuery.mock.calls.some(([text]) => String(text).startsWith('SELECT 1'))).toBe(false)
  })
})
