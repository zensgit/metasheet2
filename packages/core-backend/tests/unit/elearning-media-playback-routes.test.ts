import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { describe, expect, test } from 'vitest'

import { isElearningWatchSurfaceEnabled } from '../../src/elearning/feature-flags'
import { createElearningMediaPlaybackRouter } from '../../src/routes/elearning-media-playback'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
  ELEARNING_MEDIA_PLAYBACK_TYP,
  ElearningPlaybackError,
  parseElearningMediaHttpByteRange,
  signElearningMediaPlaybackToken,
  verifyElearningMediaPlaybackToken,
  type ElearningMediaPlaybackAuthorization,
  type ElearningMediaPlaybackClaims,
  type ElearningPlaybackByteRange,
  type ElearningPlaybackErrorCode,
  type ElearningPlaybackQueryable,
} from '../../src/services/elearning-media-playback'
import {
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
  type ElearningMediaRangeReadableStore,
} from '../../src/services/elearning-media-storage'
import { usePinnedServer } from '../utils/pinned-server'

const PLAYBACK_SECRET = 'playback-signing-secret-min-32chars!'
const JWT_SECRET = 'jwt-secret-must-remain-unused-32b!!'
const ORG = 'org-playback-route-1'
const USER = 'user-playback-route-1'
const ITEM = '11111111-1111-4111-8111-111111111111'
const MEDIA = '44444444-4444-4444-8444-444444444444'
const JTI = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STORAGE_KEY = 'elearning-media/2026-08/secret-object-key.mp4'
const NOW = new Date('2026-08-25T12:00:00.000Z')
const FILE = Buffer.from('ABCDEFGHIJ')
const SIZE = FILE.length
const RANGE_ECHO = 'bytes=3-7'
const PATH = '/api/elearning/media/playback'
const SRC = join(__dirname, '../../src/routes/elearning-media-playback.ts')

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: PLAYBACK_SECRET,
  JWT_SECRET,
} as unknown as NodeJS.ProcessEnv

const FLAG_NAMES = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
  'ELEARNING_MEDIA_ENABLED',
] as const

const LOOKALIKES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ',
]

const AUTH_ERRORS: Array<[ElearningPlaybackErrorCode, number]> = [
  ['invalid_input', 400],
  ['not_found', 404],
  ['assignment_unavailable', 403],
  ['course_withdrawn', 409],
  ['unsupported_item', 400],
  ['unavailable', 503],
  ['invalid_token', 401],
  ['token_expired', 401],
  ['invalid_range', 400],
  ['unsatisfiable_range', 416],
]

const CLAIMS: ElearningMediaPlaybackClaims = {
  v: ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
  typ: ELEARNING_MEDIA_PLAYBACK_TYP,
  org: ORG,
  sub: USER,
  item: ITEM,
  media: MEDIA,
  jti: JTI,
  iat: 1787659200,
  exp: 1787659800,
}

const TOKEN = signElearningMediaPlaybackToken(CLAIMS, PLAYBACK_SECRET, JWT_SECRET)

const pinned = usePinnedServer()
function serve(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function dummyDb(): ElearningPlaybackQueryable {
  return { query: async () => ({ rows: [], rowCount: 0 }) }
}

function sliceStore(file: Buffer = FILE): ElearningMediaRangeReadableStore & { reads: Array<{ key: string; start: number; end: number }> } {
  const reads: Array<{ key: string; start: number; end: number }> = []
  return {
    reads,
    async getRange(key, start, end) {
      reads.push({ key, start, end })
      return file.subarray(start, end + 1)
    },
  }
}

function playbackAuth(over: Partial<ElearningMediaPlaybackAuthorization> = {}): ElearningMediaPlaybackAuthorization {
  return {
    storageKey: STORAGE_KEY,
    mimeType: 'video/mp4',
    sizeBytes: SIZE,
    range: parseElearningMediaHttpByteRange(undefined, SIZE),
    ...over,
  }
}

function assertValuesFree(body: unknown, rangeValue?: string): void {
  const blob = typeof body === 'string' ? body : Buffer.isBuffer(body)
    ? body.toString('utf8')
    : JSON.stringify(body)
  expect(blob).not.toContain(TOKEN)
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(USER)
  expect(blob).not.toContain(STORAGE_KEY)
  expect(blob).not.toContain(PLAYBACK_SECRET)
  expect(blob).not.toContain(JWT_SECRET)
  expect(blob).not.toMatch(/storage_key|storageKey/)
  expect(blob).not.toMatch(/elearning-media\//)
  if (rangeValue) expect(blob).not.toContain(rangeValue)
}

function expectPlaybackHeaders(
  res: request.Response,
  status: 200 | 206,
  length: number,
  contentRange: string | null,
): void {
  expect(res.status).toBe(status)
  expect(res.headers['accept-ranges']).toBe('bytes')
  expect(res.headers['content-type']).toBe('video/mp4')
  expect(res.headers['content-length']).toBe(String(length))
  expect(res.headers['cache-control']).toBe('private, no-store')
  expect(res.headers['x-content-type-options']).toBe('nosniff')
  expect(res.headers['referrer-policy']).toBe('no-referrer')
  if (status === 206) {
    expect(res.headers['content-range']).toBe(contentRange)
  } else {
    expect(res.headers['content-range']).toBeUndefined()
  }
}

function binary(req: request.Test): request.Test {
  return req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
    res.on('end', () => { cb(null, Buffer.concat(chunks)) })
  })
}

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  db?: ElearningPlaybackQueryable
  store?: ElearningMediaRangeReadableStore | null
  getStore?: () => ElearningMediaRangeReadableStore | null
  getStoreThrow?: unknown
  now?: () => Date
  verify?: typeof verifyElearningMediaPlaybackToken
  authorize?: typeof import('../../src/services/elearning-media-playback').authorizeElearningMediaPlayback
  parseRange?: typeof parseElearningMediaHttpByteRange
  readSecret?: typeof import('../../src/services/elearning-media-playback').readElearningMediaPlaybackSigningSecret
  watchEnabled?: typeof isElearningWatchSurfaceEnabled
  order?: string[]
} = {}) {
  const order = over.order ?? []
  const store = over.store === undefined ? sliceStore() : over.store
  const getStore = over.getStore ?? (() => {
    if (over.getStoreThrow) throw over.getStoreThrow
    order.push('getStore')
    return store
  })
  const router = createElearningMediaPlaybackRouter({
    db: over.db ?? dummyDb(),
    env: over.env ?? FLAG_ON,
    now: over.now ?? (() => NOW),
    getStore,
    isElearningWatchSurfaceEnabled: over.watchEnabled,
    readElearningMediaPlaybackSigningSecret: over.readSecret,
    verifyElearningMediaPlaybackToken: over.verify ?? ((token, secret, jwtSecret, now) => {
      order.push('verify')
      return verifyElearningMediaPlaybackToken(token, secret, jwtSecret, now)
    }),
    authorizeElearningMediaPlayback: over.authorize ?? (async (...args) => {
      order.push('authorize')
      const impl = await import('../../src/services/elearning-media-playback')
      return impl.authorizeElearningMediaPlayback(...args)
    }),
    parseElearningMediaHttpByteRange: over.parseRange ?? ((header, size) => {
      order.push('parse')
      return parseElearningMediaHttpByteRange(header, size)
    }),
  })
  const app = express()
  if (router) app.use(router)
  return { app, router, store, getStore, order }
}

function stubbed(over: {
  env?: NodeJS.ProcessEnv
  range?: ElearningPlaybackByteRange
  auth?: ElearningMediaPlaybackAuthorization
  store?: ElearningMediaRangeReadableStore | null
  getStore?: () => ElearningMediaRangeReadableStore | null
  getStoreThrow?: unknown
  authorizeError?: unknown
  verifyError?: unknown
  parseError?: unknown
  parseRange?: typeof parseElearningMediaHttpByteRange
  order?: string[]
} = {}) {
  const order = over.order ?? []
  const store = over.store === undefined ? sliceStore() : over.store
  return makeApp({
    env: over.env,
    store,
    getStore: over.getStore,
    getStoreThrow: over.getStoreThrow,
    order,
    verify: (token, secret, jwtSecret, now) => {
      order.push('verify')
      if (over.verifyError) throw over.verifyError
      return verifyElearningMediaPlaybackToken(token, secret, jwtSecret, now)
    },
    authorize: async (db, input) => {
      order.push('authorize')
      expect(input.orgId).toBe(ORG)
      expect(input.userId).toBe(USER)
      expect(input.token).toBe(TOKEN)
      expect(db).toBeDefined()
      if (over.authorizeError) throw over.authorizeError
      return over.auth ?? playbackAuth()
    },
    parseRange: over.parseRange ?? ((header, size) => {
      order.push('parse')
      if (over.parseError) throw over.parseError
      if (over.range) return over.range
      return parseElearningMediaHttpByteRange(header, size)
    }),
  })
}

describe('elearning media playback routes (token-auth range GET)', () => {
  test('factory returns null unless watch surface and signing-secret reader both accept env', () => {
    expect(isElearningWatchSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    for (const name of FLAG_NAMES) {
      for (const value of LOOKALIKES) {
        const env = { ...FLAG_ON, [name]: value } as unknown as NodeJS.ProcessEnv
        expect(createElearningMediaPlaybackRouter({
          db: dummyDb(),
          getStore: () => sliceStore(),
          env,
        })).toBeNull()
      }
    }
    expect(createElearningMediaPlaybackRouter({
      db: dummyDb(),
      getStore: () => sliceStore(),
      env: {
        ...FLAG_ON,
        [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: undefined,
      } as unknown as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(createElearningMediaPlaybackRouter({
      db: dummyDb(),
      getStore: () => sliceStore(),
      env: { ...FLAG_ON, [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: 'short' } as unknown as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(createElearningMediaPlaybackRouter({
      db: dummyDb(),
      getStore: () => sliceStore(),
      env: { ...FLAG_ON, [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: 'dev-secret-key' } as unknown as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(createElearningMediaPlaybackRouter({
      db: dummyDb(),
      getStore: () => sliceStore(),
      env: { ...FLAG_ON, [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: JWT_SECRET } as unknown as NodeJS.ProcessEnv,
    })).toBeNull()
    const router = createElearningMediaPlaybackRouter({
      db: dummyDb(),
      getStore: () => sliceStore(),
      env: FLAG_ON,
    })
    expect(router).not.toBeNull()
  })

  test('binds exactly GET /api/elearning/media/playback with no session or JWT middleware', () => {
    const { router } = makeApp({
      authorize: async () => playbackAuth(),
    })
    expect(router).not.toBeNull()
    const routes = (router as express.Router).stack.filter((layer) => layer.route)
    expect(routes).toHaveLength(1)
    expect(routes[0]?.route?.path).toBe(PATH)
    expect(routes[0]?.route?.methods).toEqual({ get: true })
    const src = readFileSync(SRC, 'utf8')
    expect(src).not.toMatch(/\bauthenticate\b|\brbacGuard\b|req\.user/)
    expect(src).toContain("'/api/elearning/media/playback'")
  })

  test('absent / start-end / open / suffix Range return exact bytes and headers', async () => {
    const cases: Array<{ range?: string; status: 200 | 206; start: number; end: number; contentRange: string | null }> = [
      { status: 200, start: 0, end: 9, contentRange: null },
      { range: 'bytes=2-5', status: 206, start: 2, end: 5, contentRange: 'bytes 2-5/10' },
      { range: 'bytes=8-', status: 206, start: 8, end: 9, contentRange: 'bytes 8-9/10' },
      { range: 'bytes=-4', status: 206, start: 6, end: 9, contentRange: 'bytes 6-9/10' },
    ]
    for (const row of cases) {
      const app = stubbed()
      const store = app.store as ReturnType<typeof sliceStore>
      store.reads.length = 0
      let req = binary(serve(app.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`))
      if (row.range) req = req.set('Range', row.range)
      const res = await req
      const expected = FILE.subarray(row.start, row.end + 1)
      expectPlaybackHeaders(res, row.status, expected.length, row.contentRange)
      expect(Buffer.from(res.body)).toEqual(expected)
      expect(Buffer.from(res.body).length).toBe(Number(res.headers['content-length']))
      expect(store.reads).toEqual([{ key: STORAGE_KEY, start: row.start, end: row.end }])
      expect(app.order.filter((step) => step === 'verify' || step === 'authorize' || step === 'parse' || step === 'getStore'))
        .toEqual(['verify', 'authorize', 'parse', 'getStore'])
    }
  })

  test('hard-caps an 8 MiB window and refuses a declared span above the cap', async () => {
    const size = ELEARNING_MEDIA_RANGE_MAX_BYTES + 4096
    const storeReads: Array<{ key: string; start: number; end: number }> = []
    const capped = stubbed({
      auth: playbackAuth({ sizeBytes: size }),
      store: {
        async getRange(key, start, end) {
          storeReads.push({ key, start, end })
          expect(end - start + 1).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES)
          return Buffer.from('x')
        },
      },
    })
    const capRes = await serve(capped.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(capRes.status).toBe(500)
    expect(capRes.body).toEqual({ error: 'internal_error' })
    expect(storeReads).toEqual([{
      key: STORAGE_KEY,
      start: 0,
      end: ELEARNING_MEDIA_RANGE_MAX_BYTES - 1,
    }])

    let oversizeGet = 0
    const oversize = stubbed({
      range: {
        start: 0,
        end: ELEARNING_MEDIA_RANGE_MAX_BYTES,
        size,
        length: ELEARNING_MEDIA_RANGE_MAX_BYTES + 1,
        complete: false,
        absent: true,
        httpStatus: 206,
        contentRange: `bytes 0-${ELEARNING_MEDIA_RANGE_MAX_BYTES}/${size}`,
      },
      store: {
        async getRange() {
          oversizeGet += 1
          return Buffer.alloc(0)
        },
      },
    })
    const overRes = await serve(oversize.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(overRes.status).toBe(500)
    expect(overRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(overRes.body)
    expect(oversizeGet).toBe(0)
  })

  test('rejects missing and multiple token query values before verify', async () => {
    const app = stubbed()
    const missing = await serve(app.app).get(PATH)
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({ error: 'invalid_input' })
    assertValuesFree(missing.body)
    expect(app.order).toEqual([])

    const empty = await serve(app.app).get(`${PATH}?token=`)
    expect(empty.status).toBe(400)
    expect(empty.body).toEqual({ error: 'invalid_input' })
    assertValuesFree(empty.body, TOKEN)

    const multi = await serve(app.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}&token=other`)
    expect(multi.status).toBe(400)
    expect(multi.body).toEqual({ error: 'invalid_input' })
    assertValuesFree(multi.body, TOKEN)
    expect(app.order).toEqual([])
  })

  test('rejects malformed, expired, and bad-signature tokens with values-free 401', async () => {
    const app = stubbed()
    const malformed = await serve(app.app).get(`${PATH}?token=not-a-token`)
    expect(malformed.status).toBe(401)
    expect(malformed.body).toEqual({ error: 'invalid_token' })
    assertValuesFree(malformed.body, 'not-a-token')
    expect(app.order).toEqual(['verify'])

    const [payloadB64] = TOKEN.split('.')
    const badSig = `${payloadB64}.${'A'.repeat(43)}`
    const bad = await serve(app.app).get(`${PATH}?token=${encodeURIComponent(badSig)}`)
    expect(bad.status).toBe(401)
    expect(bad.body).toEqual({ error: 'invalid_token' })
    assertValuesFree(bad.body, badSig)

    const expired = makeApp({
      now: () => new Date(NOW.getTime() + 601_000),
      authorize: async () => playbackAuth(),
    })
    const expiredRes = await serve(expired.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(expiredRes.status).toBe(401)
    expect(expiredRes.body).toEqual({ error: 'token_expired' })
    assertValuesFree(expiredRes.body, TOKEN)
  })

  test('rejects invalid and unsatisfiable Range without echoing the header', async () => {
    const invalid = stubbed()
    const invalidRes = await serve(invalid.app)
      .get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
      .set('Range', 'bytes=0-1,2-3')
    expect(invalidRes.status).toBe(400)
    expect(invalidRes.body).toEqual({ error: 'invalid_range' })
    assertValuesFree(invalidRes.body, 'bytes=0-1,2-3')
    expect(invalid.order.includes('getStore')).toBe(false)

    const unsat = stubbed()
    const unsatRes = await serve(unsat.app)
      .get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
      .set('Range', 'bytes=100-200')
    expect(unsatRes.status).toBe(416)
    expect(unsatRes.body).toEqual({ error: 'unsatisfiable_range' })
    assertValuesFree(unsatRes.body, 'bytes=100-200')
    expect(unsat.order.includes('getStore')).toBe(false)
  })

  test('maps authorization failures and never echoes token, org, user, key, secret, or Range', async () => {
    for (const [code, status] of AUTH_ERRORS) {
      const app = stubbed({ authorizeError: new ElearningPlaybackError(code) })
      const res = await serve(app.app)
        .get(`${PATH}?token=${encodeURIComponent(TOKEN)}&orgId=evil-org&userId=evil-user`)
        .set('Range', RANGE_ECHO)
      expect(res.status).toBe(status)
      expect(res.body).toEqual({ error: code })
      assertValuesFree(res.body, RANGE_ECHO)
      expect(app.order.filter((step) => step === 'verify' || step === 'authorize' || step === 'getStore'))
        .toEqual(['verify', 'authorize'])
    }
  })

  test('missing store, store throw, and byte-length mismatch are values-free 5xx and send no extra bytes', async () => {
    const missing = stubbed({ store: null })
    const missingRes = await serve(missing.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(missingRes.status).toBe(503)
    expect(missingRes.body).toEqual({ error: 'unavailable' })
    assertValuesFree(missingRes.body)

    const boom = stubbed({
      store: {
        async getRange() {
          throw new Error(`store fail ${STORAGE_KEY} ${PLAYBACK_SECRET} ${RANGE_ECHO}`)
        },
      },
    })
    const boomRes = await serve(boom.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(boomRes.status).toBe(500)
    expect(boomRes.body).toEqual({ error: 'internal_error' })
    assertValuesFree(boomRes.body, RANGE_ECHO)
    expect(JSON.stringify(boomRes.body)).not.toContain('store fail')

    const short = stubbed({
      store: {
        async getRange() {
          return Buffer.from('AB')
        },
      },
    })
    const shortRes = await binary(serve(short.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`))
    expect(shortRes.status).toBe(500)
    expect(JSON.parse(Buffer.from(shortRes.body).toString('utf8'))).toEqual({ error: 'internal_error' })
    expect(Buffer.from(shortRes.body).length).not.toBe(SIZE)
    assertValuesFree(JSON.parse(Buffer.from(shortRes.body).toString('utf8')))

    const long = stubbed({
      store: {
        async getRange() {
          return Buffer.concat([FILE, Buffer.from('NOPE')])
        },
      },
    })
    const longRes = await binary(serve(long.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`))
    expect(longRes.status).toBe(500)
    const longBody = JSON.parse(Buffer.from(longRes.body).toString('utf8'))
    expect(longBody).toEqual({ error: 'internal_error' })
    expect(Buffer.from(longRes.body).toString('utf8')).not.toContain('NOPE')
    assertValuesFree(longBody)
  })

  test('handler rechecks watch flags and signing secret after registration', async () => {
    const env = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const flagged = stubbed({ env })
    env.ELEARNING_MEDIA_ENABLED = 'false'
    const off = await serve(flagged.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(off.status).toBe(404)
    expect(off.body).toEqual({ error: 'not_found' })
    expect(flagged.order).toEqual([])

    const secretEnv = { ...FLAG_ON } as unknown as NodeJS.ProcessEnv
    const secreting = stubbed({ env: secretEnv })
    delete secretEnv[ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]
    const unavailable = await serve(secreting.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}`)
    expect(unavailable.status).toBe(503)
    expect(unavailable.body).toEqual({ error: 'unavailable' })
    assertValuesFree(unavailable.body, TOKEN)
    expect(secreting.order).toEqual([])
  })

  test('injected now and getStore are used; authorize runs with claims, not query identity', async () => {
    const seen: Date[] = []
    const store = sliceStore()
    const order: string[] = []
    const clocked = makeApp({
      order,
      now: () => {
        seen.push(NOW)
        return NOW
      },
      verify: (token, secret, jwtSecret, now) => {
        order.push('verify')
        expect(now).toBe(NOW)
        return verifyElearningMediaPlaybackToken(token, secret, jwtSecret, now)
      },
      authorize: async (_db, input) => {
        order.push('authorize')
        expect(input.orgId).toBe(ORG)
        expect(input.userId).toBe(USER)
        expect(input.now).toBe(NOW)
        expect(input.token).toBe(TOKEN)
        return playbackAuth()
      },
      getStore: () => {
        order.push('getStore')
        return store
      },
    })
    const res = await binary(
      serve(clocked.app).get(`${PATH}?token=${encodeURIComponent(TOKEN)}&orgId=evil&userId=evil`),
    )
    expectPlaybackHeaders(res, 200, SIZE, null)
    expect(Buffer.from(res.body)).toEqual(FILE)
    expect(seen).toEqual([NOW])
    expect(store.reads).toEqual([{ key: STORAGE_KEY, start: 0, end: SIZE - 1 }])
    expect(order.filter((step) => step === 'verify' || step === 'authorize' || step === 'parse' || step === 'getStore'))
      .toEqual(['verify', 'authorize', 'parse', 'getStore'])
  })
})
