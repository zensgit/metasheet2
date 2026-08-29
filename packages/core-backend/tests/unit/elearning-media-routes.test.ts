import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { isElearningMediaSurfaceEnabled } from '../../src/elearning/feature-flags'
import { createElearningMediaRouter } from '../../src/routes/elearning-media'
import type { ElearningMediaDb, ElearningMediaQueryable } from '../../src/services/elearning-media-quota'
import type { ElearningMediaStore } from '../../src/services/elearning-media-storage'
import { usePinnedServer } from '../utils/pinned-server'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  ELEARNING_MEDIA_MAX_OBJECT_BYTES: '1048576',
  ELEARNING_MEDIA_ORG_QUOTA_BYTES: '10485760',
} as unknown as NodeJS.ProcessEnv

const LOOKALIKES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ',
]

function isoBmffFtypBuffer(extraBytes = 64): Buffer {
  const buf = Buffer.alloc(8 + extraBytes)
  buf.writeUInt32BE(buf.length, 0)
  buf.write('ftyp', 4)
  buf.write('isom', 8)
  return buf
}

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function makeApp(over: {
  viewer?: string | null
  org?: string | null
  hasWrite?: boolean
  storageAvailable?: boolean
  env?: NodeJS.ProcessEnv
  used?: number
  failPut?: boolean
  failInsert?: boolean
  probeStdout?: string
  probeFail?: boolean
} = {}) {
  const blobs = new Map<string, Buffer>()
  const deleted: string[] = []
  const queries: Array<{ sql: string; params: unknown[] }> = []
  let putCalls = 0
  let used = over.used ?? 0
  const store: ElearningMediaStore = {
    put: async (k, b) => {
      putCalls += 1
      if (over.failPut) throw new Error('store fail')
      blobs.set(k, b)
    },
    get: async (k) => {
      const b = blobs.get(k)
      if (!b) throw new Error('missing')
      return b
    },
    delete: async (k) => {
      deleted.push(k)
      return blobs.delete(k)
    },
  }
  const txQuery = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params: params ?? [] })
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    if (sql.includes('SUM(size_bytes)')) return { rows: [{ used: String(used) }], rowCount: 1 }
    if (sql.includes('INSERT INTO elearning_media')) {
      if (over.failInsert) throw new Error('insert fail')
      used += Number(params?.[5] ?? 0)
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  const db: ElearningMediaDb = {
    query: async (sql, params) => {
      queries.push({ sql, params: params ?? [] })
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
    transaction: async <T>(handler: (tx: ElearningMediaQueryable) => Promise<T>) => handler({ query: txQuery }),
  }
  const writeGuard: express.RequestHandler = (_req, res, next) => {
    if (over.hasWrite === false) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
  const probeStdout = over.probeStdout ?? JSON.stringify({
    streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }],
    format: { duration: '3.5' },
  })
  const router = createElearningMediaRouter({
    db,
    store,
    viewerId: () => (over.viewer === undefined ? 'u1' : over.viewer),
    orgId: () => (over.org === undefined ? 'org1' : over.org),
    writeGuard,
    storageAvailable: over.storageAvailable,
    env: over.env ?? FLAG_ON,
    probe: {
      runner: async () => {
        if (over.probeFail) throw new Error('probe failed')
        return { stdout: probeStdout }
      },
    },
  })
  const app = express()
  if (router) app.use(router)
  return {
    app,
    router,
    blobs,
    deleted,
    queries,
    get putCalls() { return putCalls },
    get used() { return used },
  }
}

describe('elearning media routes (flag-gated one-shot upload)', () => {
  test('flag OFF / lookalikes → factory returns null (nothing registered)', () => {
    expect(isElearningMediaSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    for (const value of LOOKALIKES) {
      const env = { ...FLAG_ON, ELEARNING_ENABLED: value } as unknown as NodeJS.ProcessEnv
      expect(createElearningMediaRouter({
        db: { query: async () => ({ rows: [], rowCount: 0 }), transaction: async (h) => h({ query: async () => ({ rows: [], rowCount: 0 }) }) },
        store: { put: async () => {}, get: async () => Buffer.alloc(0), delete: async () => false },
        viewerId: () => 'u1',
        orgId: () => 'org1',
        writeGuard: (_req, _res, next) => next(),
        env,
      })).toBeNull()
    }
  })

  test('identity, org, RBAC, and missing config all refuse BEFORE multipart ingestion', async () => {
    const file = isoBmffFtypBuffer()
    const anon = makeApp({ viewer: null })
    const anonRes = await serve(anon.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(anonRes.status).toBe(401)
    expect(anonRes.body).toEqual({ error: 'unauthenticated' })
    expect(anon.putCalls).toBe(0)
    expect(anon.queries).toHaveLength(0)

    const noOrg = makeApp({ org: null })
    const orgRes = await serve(noOrg.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(orgRes.status).toBe(403)
    expect(orgRes.body).toEqual({ error: 'ORG_CONTEXT_REQUIRED' })
    expect(noOrg.putCalls).toBe(0)
    expect(noOrg.queries).toHaveLength(0)

    const denied = makeApp({ hasWrite: false })
    const rbacRes = await serve(denied.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(rbacRes.status).toBe(403)
    expect(denied.putCalls).toBe(0)
    expect(denied.queries).toHaveLength(0)

    const noQuota = makeApp({
      env: { ELEARNING_ENABLED: 'true', ELEARNING_MEDIA_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv,
    })
    const cfg = await serve(noQuota.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
      .attach('extra', file, { filename: 'other.mp4', contentType: 'video/mp4' })
    expect(cfg.status).toBe(503)
    expect(cfg.body).toEqual({ error: 'media_unavailable' })
    expect(noQuota.putCalls).toBe(0)
    expect(noQuota.queries).toHaveLength(0)

    const noStore = makeApp({ storageAvailable: false })
    const storeRes = await serve(noStore.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
      .attach('extra', file, { filename: 'other.mp4', contentType: 'video/mp4' })
    expect(storeRes.status).toBe(503)
    expect(storeRes.body).toEqual({ error: 'media_unavailable' })
    expect(noStore.putCalls).toBe(0)
  })

  test('handler rechecks flags after registration and refuses ready', async () => {
    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const app = makeApp({ env })
    env.ELEARNING_MEDIA_ENABLED = 'false'
    const r = await serve(app.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'not_found' })
    expect(app.putCalls).toBe(0)
    expect(app.queries).toHaveLength(0)
  })

  test('happy path returns only values-free metadata; storage key is server-derived', async () => {
    const { app, blobs, queries } = makeApp()
    const body = isoBmffFtypBuffer()
    // One-shot contract: only `file` is sent. There is no accepted metadata channel,
    // so durationMs cannot come from the client — only from the server probe (3.5s → 3500).
    const r = await serve(app)
      .post('/api/elearning/media')
      .attach('file', body, { filename: '../../evil.mp4', contentType: 'video/mp4' })
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('ready')
    expect(r.body.durationMs).toBe(3500)
    expect(r.body.sizeBytes).toBe(body.length)
    expect(r.body.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.body).not.toHaveProperty('storageKey')
    expect(r.body).not.toHaveProperty('storage_key')
    expect(r.body).not.toHaveProperty('orgId')
    expect(JSON.stringify(r.body)).not.toContain('evil')
    const keys = [...blobs.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^elearning-media\/\d{4}-\d{2}\/[0-9a-f-]{36}\.mp4$/)
    expect(keys[0]).not.toContain('evil')
    expect(queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(true)
  })

  test('extra text field, extra file, or unexpected file field is rejected before ingest', async () => {
    const file = isoBmffFtypBuffer()
    const extraField = makeApp()
    const extraFieldRes = await serve(extraField.app)
      .post('/api/elearning/media')
      .field('durationMs', '999999')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(extraFieldRes.status).toBe(413)
    expect(extraFieldRes.body).toEqual({ error: 'rejected', rejected: [{ code: 'too_many_files' }] })
    expect(JSON.stringify(extraFieldRes.body)).not.toMatch(/durationMs|999999|lesson|Too many|host|secret/i)
    expect(extraField.putCalls).toBe(0)
    expect(extraField.queries).toHaveLength(0)

    const extraFieldAfter = makeApp()
    const extraFieldAfterRes = await serve(extraFieldAfter.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
      .field('durationMs', '999999')
    expect(extraFieldAfterRes.status).toBe(413)
    expect(extraFieldAfterRes.body).toEqual({ error: 'rejected', rejected: [{ code: 'too_many_files' }] })
    expect(JSON.stringify(extraFieldAfterRes.body)).not.toMatch(/durationMs|999999|lesson|Too many|host|secret/i)
    expect(extraFieldAfter.putCalls).toBe(0)
    expect(extraFieldAfter.queries).toHaveLength(0)

    const extraFile = makeApp()
    const extraFileRes = await serve(extraFile.app)
      .post('/api/elearning/media')
      .attach('file', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
      .attach('extra', file, { filename: 'other.mp4', contentType: 'video/mp4' })
    expect(extraFileRes.status).toBe(413)
    expect(extraFileRes.body).toEqual({ error: 'rejected', rejected: [{ code: 'too_many_files' }] })
    expect(JSON.stringify(extraFileRes.body)).not.toMatch(/extra|other|lesson|Too many|host|secret/i)
    expect(extraFile.putCalls).toBe(0)
    expect(extraFile.queries).toHaveLength(0)

    const unexpected = makeApp()
    const unexpectedRes = await serve(unexpected.app)
      .post('/api/elearning/media')
      .attach('video', file, { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(unexpectedRes.status).toBe(413)
    expect(unexpectedRes.body).toEqual({ error: 'rejected', rejected: [{ code: 'too_many_files' }] })
    expect(JSON.stringify(unexpectedRes.body)).not.toMatch(/video|lesson|Unexpected|host|secret/i)
    expect(unexpected.putCalls).toBe(0)
    expect(unexpected.queries).toHaveLength(0)
  })

  test('MIME/ext/magic rejects never persist; probe/codec failure returns rejected not ready', async () => {
    const mime = makeApp()
    const badMime = await serve(mime.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/quicktime' })
    expect(badMime.status).toBe(415)
    expect(mime.putCalls).toBe(0)

    const magic = makeApp()
    const badMagic = await serve(magic.app)
      .post('/api/elearning/media')
      .attach('file', Buffer.from('XXXXXXXX-not-iso-bmff'), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(badMagic.status).toBe(415)
    expect(magic.putCalls).toBe(0)

    const hevc = makeApp({
      probeStdout: JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'hevc' }],
        format: { duration: '2' },
      }),
    })
    const hevcRes = await serve(hevc.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(hevcRes.status).toBe(201)
    expect(hevcRes.body.status).toBe('rejected')
    expect(hevcRes.body.durationMs).toBeNull()
    expect(hevcRes.body.status).not.toBe('ready')

    const boom = makeApp({ probeFail: true })
    const boomRes = await serve(boom.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(boomRes.status).toBe(201)
    expect(boomRes.body.status).toBe('rejected')
  })

  test('store failure cleans the blob and never returns ready', async () => {
    const app = makeApp({ failPut: true })
    const r = await serve(app.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal_error' })
    expect(app.blobs.size).toBe(0)
    expect(app.deleted.length).toBeGreaterThan(0)
    expect(JSON.stringify(r.body)).not.toMatch(/store fail|host|secret/i)
  })

  test('org quota exceeded is 413 and does not write a blob', async () => {
    const app = makeApp({ used: 10_485_760 })
    const r = await serve(app.app)
      .post('/api/elearning/media')
      .attach('file', isoBmffFtypBuffer(), { filename: 'lesson.mp4', contentType: 'video/mp4' })
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('rejected')
    expect(r.body.rejected[0].code).toBe('org_quota_exceeded')
    expect(app.putCalls).toBe(0)
  })
})
