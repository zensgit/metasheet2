/**
 * Yjs cleanup job tests — orphan cleanup + compaction threshold.
 */
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'

describe('YjsPersistenceAdapter cleanup', () => {
  it('getRecordsNeedingCompaction returns records exceeding threshold', async () => {
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      having: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([
        { record_id: 'rec-hot-1' },
        { record_id: 'rec-hot-2' },
      ]),
    }
    const mockDb = {
      selectFrom: vi.fn(() => mockChain),
      fn: { count: vi.fn().mockReturnValue('count(id)') },
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const result = await adapter.getRecordsNeedingCompaction(500)

    expect(result).toEqual(['rec-hot-1', 'rec-hot-2'])
    expect(mockChain.having).toHaveBeenCalledWith('count(id)', '>', 500)
  })

  it('getRecordsNeedingCompaction returns empty when no hot records', async () => {
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    const mockChain = {
      select: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      having: vi.fn().mockReturnThis(),
      execute: vi.fn().mockResolvedValue([]),
    }
    const mockDb = {
      selectFrom: vi.fn(() => mockChain),
      fn: { count: vi.fn().mockReturnValue('count(id)') },
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const result = await adapter.getRecordsNeedingCompaction()

    expect(result).toEqual([])
  })

  it('cleanupOrphanStates removes orphan rows', async () => {
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    const mockSubquery = { select: vi.fn().mockReturnThis() }
    const mockDeleteChain = {
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows: BigInt(3) }),
    }
    const mockDb = {
      deleteFrom: vi.fn(() => mockDeleteChain),
      selectFrom: vi.fn(() => mockSubquery),
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const count = await adapter.cleanupOrphanStates()

    expect(count).toBe(6) // 3 states + 3 updates
    expect(mockDb.deleteFrom).toHaveBeenCalledTimes(2)
  })

  it('cleanupOrphanStates returns 0 when no orphans', async () => {
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    const mockSubquery = { select: vi.fn().mockReturnThis() }
    const mockDeleteChain = {
      where: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue({ numDeletedRows: BigInt(0) }),
    }
    const mockDb = {
      deleteFrom: vi.fn(() => mockDeleteChain),
      selectFrom: vi.fn(() => mockSubquery),
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const count = await adapter.cleanupOrphanStates()

    expect(count).toBe(0)
  })

  it('compactDoc writes snapshot and clears updates in transaction', async () => {
    const { YjsPersistenceAdapter } = await import('../../src/collab/yjs-persistence-adapter')

    const insertCalled = vi.fn()
    const deleteCalled = vi.fn()

    const mockTrxChain = {
      values: vi.fn().mockReturnThis(),
      onConflict: vi.fn().mockReturnThis(),
      column: vi.fn().mockReturnThis(),
      doUpdateSet: vi.fn().mockReturnThis(),
      execute: vi.fn().mockImplementation(() => { insertCalled(); return Promise.resolve([]) }),
      where: vi.fn().mockReturnThis(),
    }
    // Override execute for delete to track separately
    const mockTrxDeleteChain = {
      where: vi.fn().mockReturnThis(),
      execute: vi.fn().mockImplementation(() => { deleteCalled(); return Promise.resolve([]) }),
    }

    let callCount = 0
    const mockTrx = {
      insertInto: vi.fn(() => mockTrxChain),
      deleteFrom: vi.fn(() => mockTrxDeleteChain),
    }

    const mockDb = {
      transaction: vi.fn().mockReturnValue({
        execute: vi.fn().mockImplementation(async (fn: (trx: any) => Promise<void>) => fn(mockTrx)),
      }),
    }

    const adapter = new YjsPersistenceAdapter(mockDb as any)
    const doc = new Y.Doc()
    doc.getText('test').insert(0, 'hello')

    await adapter.compactDoc('rec-1', doc)

    expect(mockTrx.insertInto).toHaveBeenCalled()
    expect(mockTrx.deleteFrom).toHaveBeenCalled()

    doc.destroy()
  })
})
