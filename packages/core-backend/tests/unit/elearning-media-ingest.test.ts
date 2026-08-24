/**
 * E-learning M1 ingest pipeline (mock store/probe/db — no local ffprobe, no live Postgres).
 */
import { describe, expect, it } from 'vitest'

import { ingestElearningMediaUpload } from '../../src/services/elearning-media-ingest'
import type { ElearningMediaDb, ElearningMediaQueryable } from '../../src/services/elearning-media-quota'
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

  it('ready CAS miss leaves probing/non-ready and cannot return ready', async () => {
    const h = makeHarness({ failReady: true })
    await expect(ingestElearningMediaUpload(ingestArgs(h)))
      .rejects.toMatchObject({ httpStatus: 500, body: { error: 'internal_error' } })
    expect(h.statuses).toContain('probing')
    expect(h.statuses).not.toContain('ready')
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
