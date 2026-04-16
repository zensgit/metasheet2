import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsPersistenceAdapter } from '../../src/collab/yjs-persistence-adapter'
import { YjsSyncService } from '../../src/collab/yjs-sync-service'

function createMockPersistenceWithCompaction() {
  return {
    loadDoc: vi.fn().mockResolvedValue(null),
    storeUpdate: vi.fn().mockResolvedValue(undefined),
    storeSnapshot: vi.fn().mockResolvedValue(undefined),
    compactDoc: vi.fn().mockResolvedValue(undefined),
  }
}

function createTransactionalMockDb() {
  const snapshotChain = {
    values: vi.fn().mockReturnThis(),
    onConflict: vi.fn().mockImplementation((fn: any) => {
      fn({
        column: vi.fn().mockReturnValue({
          doUpdateSet: vi.fn().mockReturnValue(snapshotChain),
        }),
      })
      return snapshotChain
    }),
    execute: vi.fn().mockResolvedValue([]),
  }

  const deleteChain = {
    where: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue([]),
  }

  const trx = {
    insertInto: vi.fn((table: string) => {
      expect(table).toBe('meta_record_yjs_states')
      return snapshotChain
    }),
    deleteFrom: vi.fn((table: string) => {
      expect(table).toBe('meta_record_yjs_updates')
      return deleteChain
    }),
  }

  return {
    transaction: vi.fn(() => ({
      execute: vi.fn(async (callback: (trx: typeof trx) => Promise<void>) => callback(trx)),
    })),
    _trx: trx,
    _snapshotChain: snapshotChain,
    _deleteChain: deleteChain,
  }
}

describe('Yjs persistence hardening', () => {
  describe('YjsSyncService compaction path', () => {
    let persistence: ReturnType<typeof createMockPersistenceWithCompaction>
    let service: YjsSyncService

    beforeEach(() => {
      persistence = createMockPersistenceWithCompaction()
      service = new YjsSyncService(persistence as any)
    })

    afterEach(async () => {
      await service.destroy()
    })

    it('releaseDoc prefers compactDoc over storeSnapshot', async () => {
      await service.getOrCreateDoc('rec_compact_release')

      await service.releaseDoc('rec_compact_release')

      expect(persistence.compactDoc).toHaveBeenCalledWith('rec_compact_release', expect.any(Y.Doc))
      expect(persistence.storeSnapshot).not.toHaveBeenCalled()
    })

    it('cleanupIdleDocs compacts idle docs before eviction', async () => {
      await service.getOrCreateDoc('rec_compact_idle')

      const originalNow = Date.now
      Date.now = () => originalNow() + 120_000
      try {
        await service.cleanupIdleDocs(60_000)
      } finally {
        Date.now = originalNow
      }

      expect(persistence.compactDoc).toHaveBeenCalledWith('rec_compact_idle', expect.any(Y.Doc))
      expect(service.size).toBe(0)
    })
  })

  describe('YjsPersistenceAdapter compaction + recovery', () => {
    it('compactDoc upserts snapshot and clears incremental updates in one transaction', async () => {
      const mockDb = createTransactionalMockDb()
      const adapter = new YjsPersistenceAdapter(mockDb as any)
      const doc = new Y.Doc()
      doc.getText('body').insert(0, 'hello world')

      await adapter.compactDoc('rec_compact_tx', doc)

      expect(mockDb.transaction).toHaveBeenCalledTimes(1)
      expect(mockDb._trx.insertInto).toHaveBeenCalledWith('meta_record_yjs_states')
      expect(mockDb._trx.deleteFrom).toHaveBeenCalledWith('meta_record_yjs_updates')
      expect(mockDb._deleteChain.where).toHaveBeenCalledWith('record_id', '=', 'rec_compact_tx')
      doc.destroy()
    })

    it('loadDoc recovers from updates-only persistence when snapshot is missing', async () => {
      const baseDoc = new Y.Doc()
      baseDoc.getText('body').insert(0, 'recovered-from-updates')
      const updatesOnly = Y.encodeStateAsUpdate(baseDoc)
      baseDoc.destroy()

      const selectChain = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn().mockResolvedValue(null),
        execute: vi.fn().mockResolvedValue([
          { update_data: Buffer.from(updatesOnly) },
        ]),
      }

      const mockDb = {
        selectFrom: vi.fn(() => selectChain),
      }

      const adapter = new YjsPersistenceAdapter(mockDb as any)
      const result = await adapter.loadDoc('rec_updates_only')

      expect(result).not.toBeNull()
      const recovered = new Y.Doc()
      Y.applyUpdate(recovered, result!)
      expect(recovered.getText('body').toString()).toBe('recovered-from-updates')
      recovered.destroy()
    })
  })
})
