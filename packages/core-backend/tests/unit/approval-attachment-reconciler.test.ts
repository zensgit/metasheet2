/**
 * Attachment bucket reconciler boundedness + grace-window goldens (G15, §7).
 */
import { describe, expect, test } from 'vitest'

import {
  reconcileBucket,
  RECONCILER_ORPHAN_GRACE_MS,
  type ReconcileCursor,
  type ReconcilerBlob,
  type ReconcilerBlobSource,
} from '../../src/services/approval-attachment-reconciler'

interface AttachmentRow {
  id: string
  storage_key: string
  status: string
}

function fakeDb(seedRows: AttachmentRow[]) {
  const rows = [...seedRows].sort((a, b) => a.id.localeCompare(b.id))
  const enqueued: string[] = []
  const rowPageLimits: number[] = []
  const db = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('WHERE storage_key = ANY')) {
        const keys = new Set(params?.[0] as string[])
        const found = rows.filter((row) => keys.has(row.storage_key)).map(({ storage_key }) => ({ storage_key }))
        return { rows: found, rowCount: found.length }
      }
      if (sql.startsWith('SELECT id, storage_key, status')) {
        const cursor = String(params?.[0] ?? '')
        const limit = Number(params?.[1])
        rowPageLimits.push(limit)
        const page = rows.filter((row) => row.id > cursor).slice(0, limit)
        return { rows: page, rowCount: page.length }
      }
      if (sql.includes('INSERT INTO approval_attachment_purge_intents')) {
        const key = String(params?.[0])
        if (enqueued.includes(key)) return { rows: [], rowCount: 0 }
        enqueued.push(key)
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
  return { db, enqueued, rowPageLimits }
}

function fakeSource(blobs: ReconcilerBlob[], existingKeys: ReadonlySet<string> = new Set()) {
  const listLimits: number[] = []
  const listCursors: Array<string | undefined> = []
  const headKeys: string[] = []
  const source: ReconcilerBlobSource = {
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
    hasBlob: async (key) => {
      headKeys.push(key)
      return existingKeys.has(key)
    },
  }
  return { source, listLimits, listCursors, headKeys }
}

const OLD = RECONCILER_ORPHAN_GRACE_MS + 60_000
const YOUNG = RECONCILER_ORPHAN_GRACE_MS - 60_000

describe('approval attachment reconciler bounded passes', () => {
  test('MUTATION CONTROL: advances multiple bucket/DB pages without an all-at-once list or table snapshot', async () => {
    const blobs = Array.from({ length: 5 }, (_, i) => ({
      key: `approval-attachments/2026-07/orphan-${i}`,
      ageMs: OLD,
    }))
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i}`,
      storage_key: `approval-attachments/2026-07/live-${i}`,
      status: 'bound',
    }))
    const { db, enqueued, rowPageLimits } = fakeDb(rows)
    const { source, listLimits, listCursors, headKeys } = fakeSource(
      blobs,
      new Set(rows.map((row) => row.storage_key)),
    )

    let cursor: ReconcileCursor | undefined
    let passes = 0
    do {
      const result = await reconcileBucket(db, source, {
        cursor,
        maxBlobsPerPass: 2,
        maxRowsPerPass: 2,
      })
      expect(result.scannedBlobs).toBeLessThanOrEqual(2)
      expect(result.scannedRows).toBeLessThanOrEqual(2)
      cursor = result.nextCursor
      passes += 1
    } while (cursor)

    expect(passes).toBe(3)
    expect(listLimits).toEqual([2, 2, 2])
    expect(listCursors).toEqual([undefined, '2', '4'])
    expect(rowPageLimits).toEqual([2, 2, 2])
    expect(headKeys).toEqual(rows.map((row) => row.storage_key))
    expect(enqueued).toEqual(blobs.map((blob) => blob.key))
  })

  test('a completed scan side waits while the other cursor advances', async () => {
    const { db, rowPageLimits } = fakeDb([])
    const { source, listCursors } = fakeSource([
      { key: 'approval-attachments/2026-07/a', ageMs: OLD },
      { key: 'approval-attachments/2026-07/b', ageMs: OLD },
      { key: 'approval-attachments/2026-07/c', ageMs: OLD },
    ])
    const first = await reconcileBucket(db, source, { maxBlobsPerPass: 2, maxRowsPerPass: 2 })
    expect(first.nextCursor).toMatchObject({ blobCursor: '2', rowComplete: true })
    const second = await reconcileBucket(db, source, {
      cursor: first.nextCursor,
      maxBlobsPerPass: 2,
      maxRowsPerPass: 2,
    })
    expect(second.nextCursor).toBeUndefined()
    expect(listCursors).toEqual([undefined, '2'])
    expect(rowPageLimits).toEqual([2])
  })

  test('POSITIVE CONTROL: a young in-flight blob and an old live blob are never queued', async () => {
    const liveKey = 'approval-attachments/2026-07/live'
    const youngKey = 'approval-attachments/2026-07/inflight'
    const { db, enqueued } = fakeDb([{ id: 'att-live', storage_key: liveKey, status: 'unbound' }])
    const { source } = fakeSource([
      { key: liveKey, ageMs: OLD },
      { key: youngKey, ageMs: YOUNG },
    ], new Set([liveKey, youngKey]))
    const result = await reconcileBucket(db, source)
    expect(result.orphanBlobsQueued).toBe(0)
    expect(enqueued).toEqual([])
  })

  test('POSITIVE CONTROL: a missing live blob is surfaced but never queued for deletion', async () => {
    const missingKey = 'approval-attachments/2026-07/missing'
    const { db, enqueued } = fakeDb([{ id: 'att-missing', storage_key: missingKey, status: 'bound' }])
    const { source, headKeys } = fakeSource([])
    const result = await reconcileBucket(db, source)
    expect(result.missingBlobs).toEqual([missingKey])
    expect(headKeys).toEqual([missingKey])
    expect(enqueued).toEqual([])
  })

  test('rejects invalid pass bounds and a source that violates the requested page ceiling', async () => {
    const { db } = fakeDb([])
    const { source } = fakeSource([])
    await expect(reconcileBucket(db, source, { maxBlobsPerPass: 0 })).rejects.toThrow(/maxBlobsPerPass/)
    await expect(reconcileBucket(db, source, { maxRowsPerPass: 1_001 })).rejects.toThrow(/maxRowsPerPass/)
    await expect(reconcileBucket(db, source, { graceMs: -1 })).rejects.toThrow(/non-negative/)

    await expect(reconcileBucket(db, {
      listPage: async () => ({
        blobs: [
          { key: 'approval-attachments/a', ageMs: OLD },
          { key: 'approval-attachments/b', ageMs: OLD },
        ],
      }),
      hasBlob: async () => true,
    }, { maxBlobsPerPass: 1 })).rejects.toThrow(/exceeded the requested page bound/)
  })
})
