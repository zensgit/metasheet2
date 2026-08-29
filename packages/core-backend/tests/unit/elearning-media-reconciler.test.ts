/**
 * E-learning media stale-row claim + bounded orphan blob reconciliation (mock db/store).
 */
import { describe, expect, it } from 'vitest'

import type { ElearningMediaQueryable } from '../../src/services/elearning-media-quota'
import {
  ELEARNING_MEDIA_ORPHAN_GRACE_MS,
  ELEARNING_MEDIA_RECONCILE_BATCH_SIZE,
  ELEARNING_MEDIA_RECONCILE_MAX_BATCH_SIZE,
  ELEARNING_MEDIA_STALE_MS,
  reconcileElearningMediaBlobs,
  reconcileStaleElearningMediaRows,
  type ElearningMediaBlobRef,
  type ElearningMediaBlobSource,
  type ElearningMediaReconcileCursor,
} from '../../src/services/elearning-media-reconciler'
import type { ElearningMediaStore } from '../../src/services/elearning-media-storage'

const KEY_A = 'elearning-media/2026-08/11111111-1111-4111-8111-111111111111.mp4'
const KEY_B = 'elearning-media/2026-08/22222222-2222-4222-8222-222222222222.mp4'
const KEY_C = 'elearning-media/2026-08/33333333-3333-4333-8333-333333333333.mp4'
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'
const OLD = ELEARNING_MEDIA_ORPHAN_GRACE_MS + 60_000
const YOUNG = ELEARNING_MEDIA_ORPHAN_GRACE_MS - 60_000

interface MediaRow {
  id: string
  storage_key: string
  status: string
  updated_at: string
}

function fakeStore(seed: string[] = []) {
  const blobs = new Map<string, Buffer>(seed.map((key) => [key, Buffer.from('x')]))
  const deleted: string[] = []
  const fail = new Set<string>()
  const store: ElearningMediaStore = {
    put: async (key, body) => { blobs.set(key, body) },
    get: async (key) => {
      const body = blobs.get(key)
      if (!body) throw new Error('missing')
      return body
    },
    delete: async (key) => {
      deleted.push(key)
      if (fail.has(key)) throw new Error('delete failed')
      return blobs.delete(key)
    },
  }
  return { store, blobs, deleted, fail }
}

function fakeSource(blobs: ElearningMediaBlobRef[], existingKeys?: ReadonlySet<string>) {
  const listLimits: number[] = []
  const listCursors: Array<string | undefined> = []
  const source: ElearningMediaBlobSource = {
    listPage: async (cursor, limit) => {
      listLimits.push(limit)
      listCursors.push(cursor)
      const offset = cursor === undefined ? 0 : Number(cursor)
      const page = blobs.slice(offset, offset + limit)
      const next = offset + page.length
      return {
        blobs: page,
        ...(next < blobs.length ? { nextCursor: String(next) } : {}),
      }
    },
    hasBlob: async (key) => (existingKeys ?? new Set(blobs.map((blob) => blob.key))).has(key),
  }
  return { source, listLimits, listCursors }
}

function fakeDb(seedRows: MediaRow[]) {
  const rows = seedRows.map((row) => ({ ...row }))
  const locked = new Set<string>()
  const sqls: string[] = []
  const paramsLog: unknown[][] = []
  const db: ElearningMediaQueryable = {
    query: async (sql, params = []) => {
      sqls.push(sql)
      paramsLog.push(params)
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        const cutoff = String(params[0])
        const limit = Number(params[1])
        const claimed: MediaRow[] = []
        for (const row of rows) {
          if (claimed.length >= limit) break
          if (locked.has(row.id)) continue
          if (row.status !== 'uploading' && row.status !== 'probing') continue
          if (row.updated_at > cutoff) continue
          locked.add(row.id)
          row.status = 'rejected'
          row.updated_at = String(params[2])
          claimed.push(row)
        }
        for (const row of claimed) locked.delete(row.id)
        return {
          rows: claimed.map((row) => ({ storage_key: row.storage_key })),
          rowCount: claimed.length,
        }
      }
      if (sql.includes('WHERE storage_key = ANY')) {
        const keys = new Set(params[0] as string[])
        const found = rows
          .filter((row) => keys.has(row.storage_key))
          .map((row) => ({ storage_key: row.storage_key, status: row.status }))
        return { rows: found, rowCount: found.length }
      }
      if (sql.includes('SELECT id, storage_key, status')) {
        const cursor = String(params[0] ?? '')
        const limit = Number(params[1])
        const readyOnly = sql.includes("status = 'ready'")
        const page = rows
          .filter((row) => row.id > cursor)
          .filter((row) => !readyOnly || row.status === 'ready')
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((row) => ({ id: row.id, storage_key: row.storage_key, status: row.status }))
        return { rows: page, rowCount: page.length }
      }
      throw new Error('unexpected SQL')
    },
  }
  return { db, rows, locked, sqls, paramsLog }
}

describe('elearning media stale-row claim', () => {
  it('exports conservative 1h stale/grace defaults and batch 250/max 1000', () => {
    expect(ELEARNING_MEDIA_STALE_MS).toBe(60 * 60 * 1000)
    expect(ELEARNING_MEDIA_ORPHAN_GRACE_MS).toBe(60 * 60 * 1000)
    expect(ELEARNING_MEDIA_RECONCILE_BATCH_SIZE).toBe(250)
    expect(ELEARNING_MEDIA_RECONCILE_MAX_BATCH_SIZE).toBe(1000)
  })

  it('claims stale uploading/probing rows with one CTE UPDATE FOR UPDATE SKIP LOCKED statement', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const { db, sqls, paramsLog, rows } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'probing', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_B, storage_key: KEY_B, status: 'uploading', updated_at: '2026-08-24T10:30:00.000Z' },
      { id: ID_C, storage_key: KEY_C, status: 'ready', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { store, deleted } = fakeStore([KEY_A, KEY_B, KEY_C])
    const result = await reconcileStaleElearningMediaRows(db, store, {
      now: () => now,
      staleMs: ELEARNING_MEDIA_STALE_MS,
      batchSize: 250,
    })
    expect(sqls).toHaveLength(1)
    expect(sqls[0]).toMatch(/WITH\s+stale AS MATERIALIZED/i)
    expect(sqls[0]).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(sqls[0]).toMatch(/UPDATE elearning_media/)
    expect(sqls[0]).toMatch(/status = 'rejected'/)
    expect(sqls[0]).toMatch(/status IN \('uploading', 'probing'\)/)
    expect(sqls[0]).toMatch(/LIMIT \$2::int/)
    expect(sqls[0]).toMatch(/RETURNING stale\.storage_key/)
    expect(paramsLog[0]).toEqual(['2026-08-24T11:00:00.000Z', 250, '2026-08-24T12:00:00.000Z'])
    expect(result).toEqual({ claimed: 2, deleted: 2, deleteFailed: 0 })
    expect(result).not.toHaveProperty('keys')
    expect(deleted.sort()).toEqual([KEY_A, KEY_B].sort())
    expect(rows.find((row) => row.id === ID_C)?.status).toBe('ready')
  })

  it('does not claim young uploading/probing rows', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const { db, rows } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'probing', updated_at: '2026-08-24T11:30:00.000Z' },
    ])
    const { store, deleted } = fakeStore([KEY_A])
    const result = await reconcileStaleElearningMediaRows(db, store, { now: () => now })
    expect(result).toEqual({ claimed: 0, deleted: 0, deleteFailed: 0 })
    expect(deleted).toEqual([])
    expect(rows[0]?.status).toBe('probing')
  })

  it('counts delete failures without dropping the rejected claim', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    const { db, rows } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'uploading', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { store, fail } = fakeStore([KEY_A])
    fail.add(KEY_A)
    const result = await reconcileStaleElearningMediaRows(db, store, { now: () => now, staleMs: 0 })
    expect(result).toEqual({ claimed: 1, deleted: 0, deleteFailed: 1 })
    expect(rows[0]?.status).toBe('rejected')
  })

  it('treats an idempotent missing-blob delete as success', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'probing', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { store, blobs } = fakeStore()
    const result = await reconcileStaleElearningMediaRows(db, store, {
      now: () => new Date('2026-08-24T12:00:00.000Z'),
      staleMs: 0,
    })
    expect(result).toEqual({ claimed: 1, deleted: 1, deleteFailed: 0 })
    expect(blobs.size).toBe(0)
  })

  it('concurrent claims cannot return the same row', async () => {
    const row: MediaRow = {
      id: ID_A,
      storage_key: KEY_A,
      status: 'probing',
      updated_at: '2026-08-24T10:00:00.000Z',
    }
    const locked = new Set<string>()
    let entered = 0
    let releaseFirst!: () => void
    const firstHold = new Promise<void>((resolve) => { releaseFirst = resolve })
    let sawFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => { sawFirst = resolve })
    const db: ElearningMediaQueryable = {
      query: async (sql) => {
        expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
        entered += 1
        const call = entered
        if (locked.has(row.id) || row.status === 'rejected') {
          return { rows: [], rowCount: 0 }
        }
        locked.add(row.id)
        if (call === 1) {
          sawFirst()
          await firstHold
        }
        row.status = 'rejected'
        return { rows: [{ storage_key: row.storage_key }], rowCount: 1 }
      },
    }
    const { store, deleted } = fakeStore([KEY_A])
    const first = reconcileStaleElearningMediaRows(db, store, { staleMs: 0, batchSize: 1 })
    await firstEntered
    const second = reconcileStaleElearningMediaRows(db, store, { staleMs: 0, batchSize: 1 })
    releaseFirst()
    const [a, b] = await Promise.all([first, second])
    expect(a.claimed + b.claimed).toBe(1)
    expect(a.deleteFailed + b.deleteFailed).toBe(0)
    expect(deleted).toEqual([KEY_A])
  })

  it('validates stale claim bounds', async () => {
    const { db } = fakeDb([])
    const { store } = fakeStore()
    await expect(reconcileStaleElearningMediaRows(db, store, { staleMs: -1 })).rejects.toThrow(/staleMs/)
    await expect(reconcileStaleElearningMediaRows(db, store, { batchSize: 0 })).rejects.toThrow(/batchSize/)
    await expect(reconcileStaleElearningMediaRows(db, store, { batchSize: 1001 })).rejects.toThrow(/batchSize/)
    await expect(reconcileStaleElearningMediaRows(db, store, { now: () => new Date(Number.NaN) }))
      .rejects.toThrow(/now/)
  })
})

describe('elearning media bounded blob reconciler', () => {
  it('deletes old blobs only when the row is absent or rejected', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'rejected', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_B, storage_key: KEY_B, status: 'ready', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_C, storage_key: KEY_C, status: 'probing', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const orphan = 'elearning-media/2026-08/44444444-4444-4444-8444-444444444444.mp4'
    const { source } = fakeSource([
      { key: KEY_A, ageMs: OLD },
      { key: KEY_B, ageMs: OLD },
      { key: KEY_C, ageMs: OLD },
      { key: orphan, ageMs: OLD },
    ])
    const { store, deleted, blobs } = fakeStore([KEY_A, KEY_B, KEY_C, orphan])
    const result = await reconcileElearningMediaBlobs(db, source, store, { graceMs: ELEARNING_MEDIA_ORPHAN_GRACE_MS })
    expect(deleted.sort()).toEqual([KEY_A, orphan].sort())
    expect(blobs.has(KEY_B)).toBe(true)
    expect(blobs.has(KEY_C)).toBe(true)
    expect(result.deletedBlobs).toBe(2)
    expect(result.deleteFailed).toBe(0)
  })

  it('keeps young blobs even when the row is absent or rejected', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'rejected', updated_at: '2026-08-24T12:00:00.000Z' },
    ])
    const orphan = 'elearning-media/2026-08/44444444-4444-4444-8444-444444444444.mp4'
    const { source } = fakeSource([
      { key: KEY_A, ageMs: YOUNG },
      { key: orphan, ageMs: YOUNG },
    ])
    const { store, deleted } = fakeStore([KEY_A, orphan])
    const result = await reconcileElearningMediaBlobs(db, source, store)
    expect(deleted).toEqual([])
    expect(result.deletedBlobs).toBe(0)
  })

  it('preserves a storage key that has both rejected and ready rows', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'rejected', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_B, storage_key: KEY_A, status: 'ready', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { source } = fakeSource([{ key: KEY_A, ageMs: OLD }])
    const { store, deleted } = fakeStore([KEY_A])
    const result = await reconcileElearningMediaBlobs(db, source, store, { graceMs: 0 })
    expect(deleted).toEqual([])
    expect(result.deletedBlobs).toBe(0)
    expect(result.deleteFailed).toBe(0)
  })

  it('preserves a storage key with an unknown status', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'archived', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { source } = fakeSource([{ key: KEY_A, ageMs: OLD }])
    const { store, deleted } = fakeStore([KEY_A])
    const result = await reconcileElearningMediaBlobs(db, source, store, { graceMs: 0 })
    expect(deleted).toEqual([])
    expect(result.deletedBlobs).toBe(0)
    expect(result.deleteFailed).toBe(0)
  })

  it('keeps ready, uploading, and probing blobs regardless of age', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'ready', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_B, storage_key: KEY_B, status: 'uploading', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_C, storage_key: KEY_C, status: 'probing', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { source } = fakeSource([
      { key: KEY_A, ageMs: OLD },
      { key: KEY_B, ageMs: OLD },
      { key: KEY_C, ageMs: OLD },
    ])
    const { store, deleted } = fakeStore([KEY_A, KEY_B, KEY_C])
    const result = await reconcileElearningMediaBlobs(db, source, store, { graceMs: 0 })
    expect(deleted).toEqual([])
    expect(result.deletedBlobs).toBe(0)
  })

  it('counts missing ready blobs without returning or embedding keys', async () => {
    const { db } = fakeDb([
      { id: ID_A, storage_key: KEY_A, status: 'ready', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_B, storage_key: KEY_B, status: 'probing', updated_at: '2026-08-24T10:00:00.000Z' },
      { id: ID_C, storage_key: KEY_C, status: 'rejected', updated_at: '2026-08-24T10:00:00.000Z' },
    ])
    const { source } = fakeSource([], new Set())
    const { store } = fakeStore()
    const result = await reconcileElearningMediaBlobs(db, source, store)
    expect(result.scannedRows).toBe(1)
    expect(result.missingReadyBlobs).toBe(1)
    expect(result).not.toHaveProperty('missingKeys')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(KEY_A)
    expect(serialized).not.toContain(KEY_B)
    expect(serialized).not.toContain(KEY_C)
  })

  it('advances a bounded cursor without listing the whole source', async () => {
    const blobs: ElearningMediaBlobRef[] = [
      { key: KEY_A, ageMs: OLD },
      { key: KEY_B, ageMs: OLD },
      { key: KEY_C, ageMs: OLD },
    ]
    const { db } = fakeDb([])
    const { source, listLimits, listCursors } = fakeSource(blobs)
    const { store, deleted } = fakeStore([KEY_A, KEY_B, KEY_C])
    let cursor: ElearningMediaReconcileCursor | undefined
    let passes = 0
    do {
      const result = await reconcileElearningMediaBlobs(db, source, store, {
        cursor,
        maxBlobsPerPass: 2,
        maxRowsPerPass: 2,
        graceMs: 0,
      })
      expect(result.scannedBlobs).toBeLessThanOrEqual(2)
      expect(result.scannedRows).toBeLessThanOrEqual(2)
      cursor = result.nextCursor
      passes += 1
    } while (cursor)
    expect(passes).toBe(2)
    expect(listLimits).toEqual([2, 2])
    expect(listCursors).toEqual([undefined, '2'])
    expect(deleted.sort()).toEqual([KEY_A, KEY_B, KEY_C].sort())
  })

  it('counts a delete failure as recoverable and does not return keys', async () => {
    const { db } = fakeDb([])
    const { source } = fakeSource([{ key: KEY_A, ageMs: OLD }])
    const { store, fail } = fakeStore([KEY_A])
    fail.add(KEY_A)
    const result = await reconcileElearningMediaBlobs(db, source, store, { graceMs: 0 })
    expect(result).toMatchObject({ deletedBlobs: 0, deleteFailed: 1 })
    expect(JSON.stringify(result)).not.toContain(KEY_A)
  })

  it('resolves now once and passes that Date to source.listPage', async () => {
    const now = new Date('2026-08-24T12:00:00.000Z')
    let nowCalls = 0
    const seen: Date[] = []
    const { db } = fakeDb([])
    const { store } = fakeStore()
    const source: ElearningMediaBlobSource = {
      listPage: async (_cursor, _limit, listNow) => {
        if (listNow) seen.push(listNow)
        return { blobs: [] }
      },
      hasBlob: async () => false,
    }
    await reconcileElearningMediaBlobs(db, source, store, {
      now: () => {
        nowCalls += 1
        return now
      },
    })
    expect(nowCalls).toBe(1)
    expect(seen).toEqual([now])
    expect(seen[0]).toBe(now)
  })

  it('rejects over-bound source pages and invalid bounds', async () => {
    const { db } = fakeDb([])
    const { store } = fakeStore()
    const { source } = fakeSource([])
    await expect(reconcileElearningMediaBlobs(db, source, store, { maxBlobsPerPass: 0 }))
      .rejects.toThrow(/maxBlobsPerPass/)
    await expect(reconcileElearningMediaBlobs(db, source, store, { maxRowsPerPass: 1_001 }))
      .rejects.toThrow(/maxRowsPerPass/)
    await expect(reconcileElearningMediaBlobs(db, source, store, { graceMs: -1 }))
      .rejects.toThrow(/graceMs/)
    await expect(reconcileElearningMediaBlobs(db, source, store, { now: () => new Date(Number.NaN) }))
      .rejects.toThrow(/now/)
    await expect(reconcileElearningMediaBlobs(db, {
      listPage: async () => ({
        blobs: [
          { key: KEY_A, ageMs: OLD },
          { key: KEY_B, ageMs: OLD },
        ],
      }),
      hasBlob: async () => false,
    }, store, { maxBlobsPerPass: 1 })).rejects.toThrow(/exceeded the requested page bound/)
  })
})
