import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { createElearningMediaPlaybackRouter } from '../../src/routes/elearning-media-playback'
import {
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  parseElearningMediaHttpByteRange,
} from '../../src/services/elearning-media-playback'
import {
  bootElearningMediaRuntime,
  getBootedElearningMediaRangeStore,
} from '../../src/services/elearning-media-runtime'
import type { ElearningMediaDb } from '../../src/services/elearning-media-quota'
import { usePinnedServer } from '../utils/pinned-server'

const INDEX_SRC = join(__dirname, '../../src/index.ts')
const PLAYBACK_SECRET = 'playback-signing-secret-min-32chars!'
const JWT_SECRET = 'jwt-secret-must-remain-unused-32b!!'
const PATH = '/api/elearning/media/playback'
const FILE = Buffer.from('ABCDEFGHIJ')

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: PLAYBACK_SECRET,
  JWT_SECRET,
} as unknown as NodeJS.ProcessEnv

const BOOT_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  NODE_ENV: 'production',
  ELEARNING_MEDIA_S3_BUCKET: 'bucket',
  ELEARNING_MEDIA_S3_REGION: 'us-east-1',
} as NodeJS.ProcessEnv

const logger = { info: () => {}, warn: () => {}, error: () => {} }

function stripTsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

function fakeDb(query: ElearningMediaDb['query'] = async () => ({ rows: [], rowCount: 0 })): ElearningMediaDb {
  return {
    query,
    transaction: async (handler) => handler({ query }),
  }
}

function refusingSender() {
  return {
    send: async () => {
      throw new Error('storage I/O must not run')
    },
  }
}

const noopProbe = async (): Promise<void> => {}

async function bootPublishedStore() {
  return bootElearningMediaRuntime({
    db: fakeDb(),
    logger,
    env: BOOT_ON,
    s3Sender: refusingSender(),
    probeStore: noopProbe,
    probeSource: noopProbe,
  })
}

async function clearBootedStore(): Promise<void> {
  await bootElearningMediaRuntime({
    db: fakeDb(),
    logger,
    env: {} as NodeJS.ProcessEnv,
  })
}

describe('elearning media playback runtime integration', () => {
  afterEach(async () => {
    await clearBootedStore()
  })

  test('index.ts mounts playback before the authenticated pilot, parsers, metrics/logger, and JWT; factory-null is a no-op; storage boot is not duplicated', () => {
    const raw = readFileSync(INDEX_SRC, 'utf8')
    const src = stripTsComments(raw)
    expect(src).toMatch(
      /createElearningMediaPlaybackRouter\(\s*\{\s*db:\s*poolManager\.get\(\)\s*,\s*getStore:\s*getBootedElearningMediaRangeStore\s*,?\s*\}\s*\)/,
    )
    expect(src).toMatch(/this\.app\.use\(\s*elearningMediaPlaybackRouter\s*\)/)
    expect(src).toMatch(/if\s*\(\s*elearningMediaPlaybackRouter\s*\)/)
    expect(src).toMatch(/getStore:\s*getBootedElearningMediaRangeStore/)
    expect(src).toMatch(/createElearningPilotRuntime\(\s*\{\s*db:\s*poolManager\.get\(\)\s*\}\s*\)/)

    const setupAt = raw.search(/private\s+setupMiddleware\s*\(\s*\)\s*:\s*void\s*\{/)
    const setupEndAt = raw.search(/private\s+installGlobalErrorHandler\s*\(\s*\)\s*:\s*void\s*\{/)
    const startAt = raw.search(/async\s+start\s*\(\s*\)\s*:\s*Promise\s*<\s*void\s*>\s*\{/)
    expect(setupAt).toBeGreaterThanOrEqual(0)
    expect(setupEndAt).toBeGreaterThan(setupAt)
    expect(startAt).toBeGreaterThan(setupEndAt)

    const setupSrc = raw.slice(setupAt, setupEndAt)
    const startSrc = raw.slice(startAt)
    const playbackCreateAt = setupSrc.search(/createElearningMediaPlaybackRouter/)
    const playbackMountAt = setupSrc.search(/this\.app\.use\(\s*elearningMediaPlaybackRouter\s*\)/)
    const pilotCreateAt = setupSrc.search(/createElearningPilotRuntime/)
    const jsonAt = setupSrc.search(/this\.app\.use\(\s*express\.json\(\s*\{\s*limit:\s*['"]10mb['"]\s*\}\s*\)\s*\)/)
    const metricsAt = setupSrc.search(/requestMetricsMiddleware/)
    const loggerAt = setupSrc.search(/this\.logger\.info\(\s*`\$\{req\.method\} \$\{req\.path\}`\s*\)/)
    const jwtAt = setupSrc.search(/return\s+jwtAuthMiddleware\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)/)
    expect(playbackCreateAt).toBeGreaterThanOrEqual(0)
    expect(playbackMountAt).toBeGreaterThan(playbackCreateAt)
    expect(pilotCreateAt).toBeGreaterThan(playbackMountAt)
    expect(jsonAt).toBeGreaterThan(pilotCreateAt)
    expect(metricsAt).toBeGreaterThan(jsonAt)
    expect(loggerAt).toBeGreaterThan(metricsAt)
    expect(jwtAt).toBeGreaterThan(loggerAt)
    expect(setupSrc).toMatch(/if\s*\(\s*elearningMediaPlaybackRouter\s*\)/)
    expect(setupSrc.includes('bootElearningMediaRuntime')).toBe(false)
    expect(startSrc.includes('createElearningMediaPlaybackRouter')).toBe(false)
    expect(startSrc.includes('elearningMediaPlaybackRouter')).toBe(false)
    expect(startSrc).toMatch(/bootElearningMediaRuntime/)
  })

  test('flag-off factory is null with no DB query and no route; valid secret mounts exactly one public GET', () => {
    let used = 0
    const db = fakeDb(async () => {
      used += 1
      return { rows: [], rowCount: 0 }
    })
    expect(createElearningMediaPlaybackRouter({
      db,
      getStore: getBootedElearningMediaRangeStore,
      env: {} as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(used).toBe(0)
    expect(getBootedElearningMediaRangeStore()).toBeNull()

    const router = createElearningMediaPlaybackRouter({
      db,
      getStore: getBootedElearningMediaRangeStore,
      env: FLAG_ON,
    })
    expect(router).not.toBeNull()
    expect(used).toBe(0)
    const routes = (router as express.Router).stack.filter((layer) => layer.route)
    expect(routes).toHaveLength(1)
    expect(routes[0]?.route?.path).toBe(PATH)
    expect(routes[0]?.route?.methods).toEqual({ get: true })
  })

  test('injected probes run store then source; getter publishes only the successful store and stays lazy', async () => {
    const order: string[] = []
    let getStoreCalls = 0
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: BOOT_ON,
      s3Sender: refusingSender(),
      probeStore: async () => {
        order.push('store')
        expect(getBootedElearningMediaRangeStore()).toBeNull()
      },
      probeSource: async () => {
        order.push('source')
        expect(getBootedElearningMediaRangeStore()).toBeNull()
      },
    })
    expect(runtime).not.toBeNull()
    expect(order).toEqual(['store', 'source'])
    const published = getBootedElearningMediaRangeStore()
    expect(published).not.toBeNull()
    expect(published).toBe(runtime!.storage.store)

    const getStore = () => {
      getStoreCalls += 1
      return getBootedElearningMediaRangeStore()
    }
    const router = createElearningMediaPlaybackRouter({
      db: fakeDb(),
      getStore,
      env: FLAG_ON,
    })
    expect(router).not.toBeNull()
    expect(getStoreCalls).toBe(0)
    expect(getBootedElearningMediaRangeStore()).toBe(published)
  })

  test('failed second boot after a successful first leaves the getter null; flag-off also clears', async () => {
    const first = await bootPublishedStore()
    expect(first).not.toBeNull()
    const published = getBootedElearningMediaRangeStore()
    expect(published).toBe(first!.storage.store)

    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: BOOT_ON,
      s3Sender: refusingSender(),
      probeStore: async () => {
        throw new Error('injected store probe failed')
      },
      probeSource: async () => {
        throw new Error('source must not run')
      },
    })).rejects.toThrow('injected store probe failed')
    expect(getBootedElearningMediaRangeStore()).toBeNull()

    const second = await bootPublishedStore()
    expect(getBootedElearningMediaRangeStore()).toBe(second!.storage.store)
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {} as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(getBootedElearningMediaRangeStore()).toBeNull()
  })
})

describe('elearning media playback lazy same-store stream', () => {
  const pinned = usePinnedServer()

  afterEach(async () => {
    await clearBootedStore()
  })

  test('request uses the exact booted store via the lazy getter; unavailable store is 503', async () => {
    const runtime = await bootPublishedStore()
    expect(runtime).not.toBeNull()
    const store = getBootedElearningMediaRangeStore()
    expect(store).toBe(runtime!.storage.store)
    expect(store).not.toBeNull()
    const spy = vi.spyOn(store!, 'getRange').mockResolvedValue(FILE)

    const router = createElearningMediaPlaybackRouter({
      db: fakeDb(),
      getStore: getBootedElearningMediaRangeStore,
      env: FLAG_ON,
      verifyElearningMediaPlaybackToken: () => ({
        v: 1,
        typ: 'elearning.media.playback',
        org: 'org',
        sub: 'user',
        item: '11111111-1111-4111-8111-111111111111',
        media: '44444444-4444-4444-8444-444444444444',
        jti: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        iat: 1,
        exp: 2,
      }),
      authorizeElearningMediaPlayback: async () => ({
        storageKey: 'elearning-media/2026-08/obj.mp4',
        mimeType: 'video/mp4',
        sizeBytes: FILE.length,
        range: parseElearningMediaHttpByteRange(undefined, FILE.length),
      }),
    })
    expect(router).not.toBeNull()
    expect(spy).not.toHaveBeenCalled()

    const app = express()
    app.use(router!)
    pinned.setApp(app)
    const res = await request(pinned.url()).get(`${PATH}?token=unused`)
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.instances[0]).toBe(store)

    spy.mockRestore()
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: BOOT_ON,
      s3Sender: refusingSender(),
      probeStore: async () => {
        throw new Error('reboot probe failed')
      },
    })).rejects.toThrow('reboot probe failed')
    expect(getBootedElearningMediaRangeStore()).toBeNull()

    const after = await request(pinned.url()).get(`${PATH}?token=unused`)
    expect(after.status).toBe(503)
    expect(after.body).toEqual({ error: 'unavailable' })
  })
})
