import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { YjsPersistenceAdapter } from '../../src/collab/yjs-persistence-adapter'
import { bindYjsRecord, getYjsRecordOwner, YjsRecordRetiredError } from '../../src/collab/yjs-record-incarnation'
import { YjsRecordBridge } from '../../src/collab/yjs-record-bridge'
import type { RecordPatchInput } from '../../src/multitable/record-write-service'
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
  it.each([false, true])('a failed purge keeps its original row identity across retries (cached=%s)', async (cached) => {
    const recordId = 'same-id'
    let live = { recordId, incarnation: 'before' }
    const source = new Y.Doc()
    let state: Uint8Array | null = null
    const purge = vi.fn(async (_ids: string[], owners: { incarnation: string }[]) => {
      if (owners.some(owner => owner.incarnation === live.incarnation)) state = null
    })
    const persistence = {
      ...createMockPersistenceWithCompaction(),
      getRecordIncarnation: vi.fn(async () => live),
      getRecordIncarnations: vi.fn(async () => [live]),
      loadDoc: vi.fn(async () => state),
      purgeRecords: purge,
    }
    const service = new YjsSyncService(persistence as unknown as YjsPersistenceAdapter)
    try {
      if (cached) await service.getOrCreateDoc(recordId)
      purge.mockRejectedValueOnce(new Error('synthetic outage'))
      await expect(service.invalidateDocs([recordId])).rejects.toThrow('synthetic outage')
      live = { recordId, incarnation: 'after' }
      source.getText('field').insert(0, 'replacement')
      state = Y.encodeStateAsUpdate(source)
      const doc = await service.getOrCreateDoc(recordId)
      expect(doc.getText('field').toString()).toBe('replacement')
      expect(purge.mock.calls).toEqual([
        [[recordId], [{ recordId, incarnation: 'before' }]],
        [[recordId], [{ recordId, incarnation: 'before' }]],
      ])
      expect(persistence.getRecordIncarnations).toHaveBeenCalledTimes(cached ? 0 : 1)
    } finally {
      await service.destroy()
      source.destroy()
    }
  })

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

  it('evicts only the retired worker copy and reopens a reused id from the new record', async () => {
    const recordId = 'test-record'
    let live: { recordId: string; incarnation: string | null } | null = { recordId, incarnation: null }
    const persistence = {
      ...createMockPersistenceWithCompaction(),
      getRecordIncarnation: vi.fn(async () => live),
      purgeRecords: vi.fn(),
    }
    const service = new YjsSyncService(persistence as unknown as YjsPersistenceAdapter)
    const retired = vi.fn()
    service.setRetiredListener(retired)
    try {
      const first = await service.getOrCreateDoc(recordId)
      const owner = getYjsRecordOwner(first)
      expect(owner).toEqual({ recordId, incarnation: null })
      first.getText('field').insert(0, 'old')
      expect(persistence.storeUpdate).toHaveBeenCalledWith(recordId, expect.any(Uint8Array), owner)
      live = null
      await expect(service.getOrCreateDoc(recordId)).rejects.toThrow('Record document is not available')
      expect(retired).toHaveBeenCalledTimes(1)
      expect(retired).toHaveBeenCalledWith(recordId)
      expect(service.getDoc(recordId)).toBeUndefined()
      expect(persistence.purgeRecords).not.toHaveBeenCalled()
      live = { recordId, incarnation: 'new-row' }
      const replacement = await service.getOrCreateDoc(recordId)
      expect(replacement.getText('field').toString()).toBe('')
      expect(getYjsRecordOwner(replacement)).toEqual(live)
      expect(await service.isCurrentDocument(recordId, first)).toBe(false)
      expect(service.getDoc(recordId)).toBe(replacement)
      // A disconnected, stale worker learns about deletion from its final snapshot transaction.
      persistence.compactDoc.mockRejectedValueOnce(new YjsRecordRetiredError())
      await service.releaseDoc(recordId)
      expect(retired).toHaveBeenCalledTimes(2)
      expect(persistence.purgeRecords).not.toHaveBeenCalled()
    } finally {
      await service.destroy()
    }
  })

  it('binds a queued record patch to the observed document inside the business write transaction', async () => {
    const doc = new Y.Doc()
    const recordId = 'record-with-reused-id'
    const owner = { recordId, incarnation: 'run-1' }
    bindYjsRecord(doc, owner)
    const captured: RecordPatchInput[] = []
    const writer = { patchRecords: async (input: RecordPatchInput) => {
      captured.push(input)
      return { updated: [] }
    } }
    const originalGuard = vi.fn(async () => undefined)
    const bridge = new YjsRecordBridge({} as never, writer as never,
      async () => ({ preWriteGuard: originalGuard }) as unknown as RecordPatchInput,
      { mergeWindowMs: 1, maxDelayMs: 10 })
    try {
      bridge.observe(recordId, doc)
      doc.getMap('fields').set('field', 'queued')
      await vi.waitFor(() => expect(captured).toHaveLength(1))
      const check = captured[0].preWriteGuard!
      const gone = vi.fn(async () => ({ rows: [] }))
      await expect(check(gone)).rejects.toBeInstanceOf(YjsRecordRetiredError)
      expect(gone).toHaveBeenCalledWith(expect.stringContaining('FOR KEY SHARE'), [recordId, owner.incarnation])
      await expect(check(async () => ({ rows: [{}] }))).resolves.toBeUndefined()
      expect(originalGuard).toHaveBeenCalledTimes(2)
    } finally {
      bridge.destroy()
      doc.destroy()
    }
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

    it('rejects an owner for a different record before writing or removing any state', async () => {
      const mockDb = createTransactionalMockDb()
      const selectFrom = vi.fn()
      Object.assign(mockDb._trx, { selectFrom })
      const adapter = new YjsPersistenceAdapter(mockDb as never)
      const owner = { recordId: 'control', incarnation: null }
      const doc = new Y.Doc()
      bindYjsRecord(doc, owner)
      try {
        await expect(adapter.storeUpdate('target', new Uint8Array(), owner)).rejects.toBeInstanceOf(YjsRecordRetiredError)
        await expect(adapter.storeSnapshot('target', doc)).rejects.toBeInstanceOf(YjsRecordRetiredError)
        await expect(adapter.compactDoc('target', doc)).rejects.toBeInstanceOf(YjsRecordRetiredError)
        expect(selectFrom).not.toHaveBeenCalled()
        expect(mockDb._trx.insertInto).not.toHaveBeenCalled()
        expect(mockDb._trx.deleteFrom).not.toHaveBeenCalled()
      } finally {
        doc.destroy()
      }
    })

    it('refuses late updates and compaction before touching the new incarnation’s rows', async () => {
      const mockDb = createTransactionalMockDb()
      const lookup = {
        select: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        forKeyShare: vi.fn().mockReturnThis(),
        executeTakeFirst: vi.fn(async () => undefined),
      }
      Object.assign(mockDb._trx, { selectFrom: vi.fn(() => lookup) })
      const owner = { recordId: 'reused-record', incarnation: null }
      const adapter = new YjsPersistenceAdapter(mockDb as never)
      const doc = new Y.Doc()
      bindYjsRecord(doc, owner)
      try {
        await expect(adapter.storeUpdate(owner.recordId, new Uint8Array(), owner)).rejects.toBeInstanceOf(YjsRecordRetiredError)
        await expect(adapter.compactDoc(owner.recordId, doc)).rejects.toBeInstanceOf(YjsRecordRetiredError)
        expect(lookup.forKeyShare).toHaveBeenCalledTimes(2)
        expect(mockDb._trx.insertInto).not.toHaveBeenCalled()
        expect(mockDb._trx.deleteFrom).not.toHaveBeenCalled()
      } finally {
        doc.destroy()
      }
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
