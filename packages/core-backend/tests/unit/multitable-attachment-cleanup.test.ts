import { describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import { cleanupOrphanMultitableAttachments } from '../../src/multitable/attachment-orphan-retention'

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
})
