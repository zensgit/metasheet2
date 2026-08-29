/**
 * E-learning M1 ingest pipeline (mock store/probe/db — no local ffprobe, no live Postgres).
 */
import { describe, expect, it } from 'vitest'

import { ingestElearningMediaUpload } from '../../src/services/elearning-media-ingest'
import type { ElearningMediaDb, ElearningMediaQueryable } from '../../src/services/elearning-media-quota'
import {
  ELEARNING_MEDIA_ORPHAN_GRACE_MS,
  reconcileElearningMediaBlobs,
  reconcileStaleElearningMediaRows,
  type ElearningMediaBlobSource,
} from '../../src/services/elearning-media-reconciler'
import type { ElearningMediaStore } from '../../src/services/elearning-media-storage'

function isoBmffFtypBuffer(extraBytes = 64): Buffer {
  const buf = Buffer.alloc(8 + extraBytes)
  buf.writeUInt32BE(buf.length, 0)
  buf.write('ftyp', 4)
  buf.write('isom', 8)
  return buf
}

function makeHarness(over: {
  failReady?: boolean
  failRejected?: boolean
  failPut?: boolean
  failDelete?: boolean
} = {}) {
  const blobs = new Map<string, Buffer>()
  const deleted: string[] = []
  const statuses: string[] = []
  let used = 0
  const store: ElearningMediaStore = {
    put: async (k, b) => {
      if (over.failPut) throw new Error('put failed')
      blobs.set(k, b)
    },
    get: async (k) => {
      const b = blobs.get(k)
      if (!b) throw new Error('missing')
      return b
    },
    delete: async (k) => {
      deleted.push(k)
      if (over.failDelete) throw new Error('delete failed')
      return blobs.delete(k)
    },
  }
  const db: ElearningMediaDb = {
    query: async (sql, params) => {
      if (sql.startsWith('UPDATE')) {
        const toStatus = String(params?.[0] ?? '')
        if (over.failReady && toStatus === 'ready') return { rows: [], rowCount: 0 }
        if (over.failRejected && toStatus === 'rejected') return { rows: [], rowCount: 0 }
        statuses.push(toStatus)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
    transaction: async <T>(handler: (tx: ElearningMediaQueryable) => Promise<T>) => handler({
      query: async (sql, params) => {
        if (sql.includes('SUM(size_bytes)')) return { rows: [{ used: String(used) }], rowCount: 1 }
        if (sql.includes('INSERT INTO elearning_media')) {
          used += Number(params?.[5] ?? 0)
          statuses.push('uploading')
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 1 }
      },
    }),
  }
  return { db, store, blobs, deleted, statuses }
}

const probeOk = {
  runner: async () => ({
    stdout: JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
      format: { duration: '2' },
    }),
  }),
}

const probeBad = {
  runner: async () => ({
    stdout: JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'hevc' }],
      format: { duration: '2' },
    }),
  }),
}

const ingestArgs = (h: ReturnType<typeof makeHarness>, over: { probe?: typeof probeOk } = {}) => ({
  db: h.db,
  store: h.store,
  orgId: 'org1',
  createdBy: 'u1',
  fileName: 'lesson.mp4',
  mimeType: 'video/mp4',
  sizeBytes: isoBmffFtypBuffer().length,
  content: isoBmffFtypBuffer(),
  maxObjectBytes: 1_000_000,
  orgQuotaBytes: 10_000_000,
  probe: over.probe ?? probeOk,
})

describe('elearning media ingest pipeline', () => {
  it('store failure leaves a non-ready row, deletes the blob, and never reports ready', async () => {
    const h = makeHarness({ failPut: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h)))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.blobs.size).toBe(0)
    expect(h.deleted.length).toBeGreaterThan(0)
    expect(h.statuses).toContain('rejected')
    expect(h.statuses).not.toContain('ready')
  })

  it('ready CAS miss after put deletes the blob then best-effort CAS probing to rejected before 500', async () => {
    const h = makeHarness({ failReady: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h)))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.statuses).toEqual(['uploading', 'probing', 'rejected'])
    expect(h.deleted.length).toBe(1)
    expect(h.blobs.size).toBe(0)
  })

  it('ready CAS miss still returns 500 when delete fails and does not reject a possibly-present blob', async () => {
    const h = makeHarness({ failReady: true, failDelete: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h)))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.statuses).toEqual(['uploading', 'probing'])
    expect(h.deleted.length).toBeGreaterThan(0)
    expect(h.blobs.size).toBe(1)
  })

  it('rejected CAS miss after invalid probe returns 500 and does not store', async () => {
    const h = makeHarness({ failRejected: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h, { probe: probeBad })))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.blobs.size).toBe(0)
    expect(h.deleted).toEqual([])
    expect(h.statuses).toContain('probing')
    expect(h.statuses).not.toContain('rejected')
    expect(h.statuses).not.toContain('ready')
  })

  it('store delete throw leaves probing and does not reject a possibly-present object', async () => {
    const h = makeHarness({ failPut: true, failDelete: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h)))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.deleted.length).toBeGreaterThan(0)
    expect(h.statuses).toContain('probing')
    expect(h.statuses).not.toContain('rejected')
    expect(h.statuses).not.toContain('ready')
  })

  it('invalid probe returns rejected without storing', async () => {
    const h = makeHarness()
    const result = await ingestElearningMediaUpload(ingestArgs(h, { probe: probeBad }))
    expect(result).toMatchObject({ status: 'rejected', durationMs: null })
    expect(h.blobs.size).toBe(0)
    expect(h.deleted).toEqual([])
    expect(h.statuses).toEqual(['uploading', 'probing', 'rejected'])
  })

  it('delayed put versus stale claim cannot return ready; leftover blob is recoverable', async () => {
    type Row = { id: string; storageKey: string; status: string }
    const rows: Row[] = []
    const blobs = new Map<string, Buffer>()
    const deleted: string[] = []
    const statuses: string[] = []
    const locked = new Set<string>()
    let used = 0
    let failPresentDeleteOnce = true
    let releasePut!: () => void
    const putHold = new Promise<void>((resolve) => { releasePut = resolve })
    let signalPut!: () => void
    const putStarted = new Promise<void>((resolve) => { signalPut = resolve })

    const runQuery = async (sql: string, params?: unknown[]) => {
      if (sql.includes('SUM(size_bytes)')) return { rows: [{ used: String(used) }], rowCount: 1 }
      if (sql.includes('INSERT INTO elearning_media')) {
        used += Number(params?.[5] ?? 0)
        rows.push({
          id: String(params?.[0]),
          storageKey: String(params?.[2]),
          status: 'uploading',
        })
        statuses.push('uploading')
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FOR UPDATE SKIP LOCKED')) {
        const limit = Number(params?.[1] ?? 250)
        const claimed: Row[] = []
        for (const row of rows) {
          if (claimed.length >= limit) break
          if (locked.has(row.id)) continue
          if (row.status !== 'uploading' && row.status !== 'probing') continue
          locked.add(row.id)
          row.status = 'rejected'
          statuses.push('rejected')
          claimed.push(row)
        }
        for (const row of claimed) locked.delete(row.id)
        return {
          rows: claimed.map((row) => ({ storage_key: row.storageKey })),
          rowCount: claimed.length,
        }
      }
      if (sql.includes('WHERE storage_key = ANY')) {
        const keys = new Set(params?.[0] as string[])
        const found = rows
          .filter((row) => keys.has(row.storageKey))
          .map((row) => ({ storage_key: row.storageKey, status: row.status }))
        return { rows: found, rowCount: found.length }
      }
      if (sql.includes('SELECT id, storage_key, status')) {
        const cursor = String(params?.[0] ?? '')
        const limit = Number(params?.[1])
        const page = [...rows]
          .filter((row) => row.id > cursor)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((row) => ({ id: row.id, storage_key: row.storageKey, status: row.status }))
        return { rows: page, rowCount: page.length }
      }
      if (sql.trimStart().startsWith('UPDATE')) {
        const toStatus = String(params?.[0] ?? '')
        const id = String(params?.[3] ?? '')
        const fromStatus = String(params?.[4] ?? '')
        const row = rows.find((entry) => entry.id === id)
        if (!row || row.status !== fromStatus) return { rows: [], rowCount: 0 }
        row.status = toStatus
        statuses.push(toStatus)
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    const db: ElearningMediaDb = {
      query: runQuery,
      transaction: async <T>(handler: (tx: ElearningMediaQueryable) => Promise<T>) => handler({ query: runQuery }),
    }
    const store: ElearningMediaStore = {
      put: async (key, body) => {
        signalPut()
        await putHold
        blobs.set(key, body)
      },
      get: async (key) => {
        const body = blobs.get(key)
        if (!body) throw new Error('missing')
        return body
      },
      delete: async (key) => {
        deleted.push(key)
        if (failPresentDeleteOnce && blobs.has(key)) {
          failPresentDeleteOnce = false
          throw new Error('delete failed')
        }
        return blobs.delete(key)
      },
    }

    const ingestP = ingestElearningMediaUpload({
      db,
      store,
      orgId: 'org1',
      createdBy: 'u1',
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      sizeBytes: isoBmffFtypBuffer().length,
      content: isoBmffFtypBuffer(),
      maxObjectBytes: 1_000_000,
      orgQuotaBytes: 10_000_000,
      probe: probeOk,
    })
    await putStarted
    const stale = await reconcileStaleElearningMediaRows(db, store, { staleMs: 0, batchSize: 1 })
    expect(stale.claimed).toBe(1)
    releasePut()
    await expect(ingestP).rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(statuses).toContain('rejected')
    expect(statuses).not.toContain('ready')
    expect(blobs.size).toBe(1)
    const leftoverKey = [...blobs.keys()][0] as string
    const source: ElearningMediaBlobSource = {
      listPage: async () => ({
        blobs: [...blobs.keys()].map((key) => ({ key, ageMs: ELEARNING_MEDIA_ORPHAN_GRACE_MS + 1 })),
      }),
      hasBlob: async (key) => blobs.has(key),
    }
    const recovered = await reconcileElearningMediaBlobs(db, source, store, { graceMs: 0 })
    expect(recovered.deletedBlobs).toBe(1)
    expect(recovered.deleteFailed).toBe(0)
    expect(blobs.size).toBe(0)
    expect(JSON.stringify(recovered)).not.toContain(leftoverKey)
    expect(deleted.length).toBeGreaterThanOrEqual(2)
  })

  it('successful probe is the only path that can return ready with server duration', async () => {
    const h = makeHarness()
    const content = isoBmffFtypBuffer()
    const result = await ingestElearningMediaUpload({
      db: h.db,
      store: h.store,
      orgId: 'org1',
      createdBy: 'u1',
      fileName: '../../user-supplied.mp4',
      mimeType: 'video/mp4',
      sizeBytes: content.length,
      content,
      maxObjectBytes: 1_000_000,
      orgQuotaBytes: 10_000_000,
      probe: probeOk,
    })
    expect(result).toMatchObject({ status: 'ready', durationMs: 2000, sizeBytes: content.length })
    expect(result).not.toHaveProperty('storageKey')
    expect([...h.blobs.keys()][0]).toMatch(/^elearning-media\//)
    expect([...h.blobs.keys()][0]).not.toContain('user-supplied')
  })
})
