import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, test, vi } from 'vitest'

import { isElearningMediaSurfaceEnabled } from '../../src/elearning/feature-flags'
import {
  bootElearningMediaRuntime,
  ELEARNING_MEDIA_WORKER_INTERVAL_MS,
  resolveElearningMediaStorage,
  type ElearningMediaWorkerTimer,
} from '../../src/services/elearning-media-runtime'
import type { ElearningMediaDb } from '../../src/services/elearning-media-quota'
import { ELEARNING_MEDIA_RECONCILE_BATCH_SIZE } from '../../src/services/elearning-media-reconciler'
import type { ElearningMediaS3CommandSender } from '../../src/services/elearning-media-s3'
import { ELEARNING_MEDIA_STORAGE_PREFIX } from '../../src/services/elearning-media-storage'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

const LOOKALIKES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ',
]

const NIL_UUID = '00000000-0000-0000-0000-000000000000'

const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
} as NodeJS.ProcessEnv

const PROD_S3 = {
  ...FLAG_ON,
  NODE_ENV: 'production',
  ELEARNING_MEDIA_S3_BUCKET: 'secret-bucket-xyz',
  ELEARNING_MEDIA_S3_REGION: 'us-east-1',
} as NodeJS.ProcessEnv

function fakeDb(query: ElearningMediaDb['query'] = async () => ({ rows: [], rowCount: 0 })): ElearningMediaDb {
  return {
    query,
    transaction: async (handler) => handler({ query }),
  }
}

function capturingLogger() {
  const capturedLogs: unknown[] = []
  return {
    info: (...args: unknown[]) => { capturedLogs.push(args) },
    warn: (...args: unknown[]) => { capturedLogs.push(args) },
    error: (...args: unknown[]) => { capturedLogs.push(args) },
    capturedLogs,
  }
}

function completedReconcileCount(capturedLogs: unknown[]): number {
  return capturedLogs.filter((args) => Array.isArray(args) && args[0] === 'elearning_media_reconcile').length
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function createInjectedTimer(): {
  timer: ElearningMediaWorkerTimer
  unref: ReturnType<typeof vi.fn>
  intervals: number[]
  get cleared(): number
  fire: () => void
} {
  const unref = vi.fn()
  const intervals: number[] = []
  let callback: (() => void) | undefined
  let cleared = 0
  return {
    unref,
    intervals,
    get cleared() { return cleared },
    fire() {
      if (!callback) throw new Error('timer has no callback')
      callback()
    },
    timer: {
      setInterval(cb, ms) {
        callback = cb
        intervals.push(ms)
        return { unref }
      },
      clearInterval() {
        cleared += 1
        callback = undefined
      },
    },
  }
}

function fakeS3(opts: {
  failList?: boolean
  failHead?: boolean
  headMiss?: boolean
  workerPages?: Array<{ keys: string[]; nextCursor?: string }>
} = {}): { sender: ElearningMediaS3CommandSender; blobs: Map<string, Buffer>; commands: unknown[]; workerListCursors: Array<string | undefined> } {
  const blobs = new Map<string, Buffer>()
  const commands: unknown[] = []
  const workerListCursors: Array<string | undefined> = []
  let workerPage = 0
  return {
    blobs,
    commands,
    workerListCursors,
    sender: {
      send: async (command: unknown) => {
        commands.push(command)
        if (command instanceof PutObjectCommand) {
          blobs.set(String(command.input.Key), Buffer.from(command.input.Body as Uint8Array))
          return {}
        }
        if (command instanceof GetObjectCommand) {
          const bytes = blobs.get(String(command.input.Key))
          if (!bytes) throw new Error('NoSuchKey')
          return { Body: { transformToByteArray: async () => bytes } }
        }
        if (command instanceof DeleteObjectCommand) {
          blobs.delete(String(command.input.Key))
          return {}
        }
        if (command instanceof HeadObjectCommand) {
          if (opts.failHead) {
            throw new Error('AccessDenied bucket=secret-bucket-xyz creds=AKIASECRET')
          }
          if (opts.headMiss || !blobs.has(String(command.input.Key))) {
            throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
          }
          return {}
        }
        if (command instanceof ListObjectsV2Command) {
          if (opts.failList) {
            throw new Error('AccessDenied bucket=secret-bucket-xyz creds=AKIASECRET')
          }
          const maxKeys = Number(command.input.MaxKeys)
          if (maxKeys === 1 || !opts.workerPages) {
            return {
              IsTruncated: false,
              Contents: [...blobs.keys()].slice(0, maxKeys).map((Key) => ({ Key, LastModified: new Date() })),
            }
          }
          workerListCursors.push(command.input.ContinuationToken)
          const page = opts.workerPages[Math.min(workerPage, opts.workerPages.length - 1)]
            ?? { keys: [] }
          workerPage += 1
          return {
            Contents: page.keys.map((Key) => ({ Key, LastModified: new Date(0) })),
            IsTruncated: page.nextCursor !== undefined,
            ...(page.nextCursor ? { NextContinuationToken: page.nextCursor } : {}),
          }
        }
        throw new Error('unexpected command')
      },
    },
  }
}

describe('elearning media runtime boot', () => {
  test('master+MEDIA must both be exact true; lookalikes register nothing', async () => {
    expect(isElearningMediaSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    for (const value of LOOKALIKES) {
      expect(isElearningMediaSurfaceEnabled({
        ELEARNING_ENABLED: value,
        ELEARNING_MEDIA_ENABLED: 'true',
      } as NodeJS.ProcessEnv)).toBe(false)
      expect(isElearningMediaSurfaceEnabled({
        ELEARNING_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(false)
    }
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: { ELEARNING_ENABLED: 'true' } as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: { ELEARNING_MEDIA_ENABLED: 'true' } as NodeJS.ProcessEnv,
    })).toBeNull()
  })

  test('flag OFF returns no runtime', async () => {
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {} as NodeJS.ProcessEnv,
    })).toBeNull()
  })

  test('production without complete S3 config is s3-required and never local-fs', () => {
    const prod = resolveElearningMediaStorage({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    expect(prod.kind).toBe('s3-required')
    expect(prod.store).toBeNull()
    expect(prod.source).toBeNull()
    const withDir = resolveElearningMediaStorage({
      NODE_ENV: 'production',
      ELEARNING_MEDIA_STORAGE_DIR: '/tmp/should-not-be-used',
    } as NodeJS.ProcessEnv)
    expect(withDir.kind).toBe('s3-required')
    expect(withDir.source).toBeNull()
  })

  test('dev uses dedicated ELEARNING_MEDIA_STORAGE_DIR and the store as the blob source', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const local = resolveElearningMediaStorage({ ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv)
    expect(local.kind).toBe('local-fs')
    expect(local.kind === 'local-fs' && local.rootDir).toBe(dir)
    expect(local.kind === 'local-fs' && local.source).toBe(local.store)
  })

  test('production with complete S3 config resolves object-store with a list/head adapter source', () => {
    const sender = { send: async () => ({ Body: { transformToByteArray: async () => new Uint8Array() } }) }
    const resolved = resolveElearningMediaStorage({
      NODE_ENV: 'production',
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv, sender)
    expect(resolved.kind).toBe('object-store')
    expect(resolved.source).toBeTruthy()
    expect(resolved.store).toBeTruthy()
  })

  test('flag ON + unusable local root → boot THROWS (fail-closed)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const fileNotDir = path.join(dir, 'a-regular-file')
    writeFileSync(fileNotDir, 'not a directory')
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {
        ...FLAG_ON,
        ELEARNING_MEDIA_STORAGE_DIR: path.join(fileNotDir, 'nested'),
      } as NodeJS.ProcessEnv,
    })).rejects.toThrow()
  })

  test('flag ON production incomplete S3 mounts with s3-required fail-close', async () => {
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {
        ...FLAG_ON,
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv,
    })
    expect(runtime).not.toBeNull()
    expect(runtime!.storage.kind).toBe('s3-required')
    expect(runtime!.storage.source).toBeNull()
    expect(runtime!.router).toBeTruthy()
  })

  test('boot list failure throws values-free', async () => {
    const { sender } = fakeS3({ failList: true })
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: PROD_S3,
      s3Sender: sender,
    })).rejects.toThrow('E-learning media storage probe failed')
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: PROD_S3,
      s3Sender: sender,
    })).rejects.not.toThrow(/secret-bucket-xyz|AKIASECRET/)
  })

  test('boot head failure throws values-free', async () => {
    const { sender } = fakeS3({ failHead: true })
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: PROD_S3,
      s3Sender: sender,
    })).rejects.toThrow('E-learning media storage probe failed')
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: PROD_S3,
      s3Sender: sender,
    })).rejects.not.toThrow(/secret-bucket-xyz|AKIASECRET/)
  })

  test('boot head miss throws values-free', async () => {
    const { sender } = fakeS3({ headMiss: true })
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: PROD_S3,
      s3Sender: sender,
    })).rejects.toThrow('E-learning media storage probe failed')
  })
})

describe('elearning media runtime workers', () => {
  test('s3-required starts no worker timer and runs no reconcile queries', async () => {
    const queries: string[] = []
    const injected = createInjectedTimer()
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(async (sql) => {
        queries.push(sql)
        return { rows: [], rowCount: 0 }
      }),
      logger,
      env: { ...FLAG_ON, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      timer: injected.timer,
      intervalMs: 5,
    })
    expect(runtime).not.toBeNull()
    const stop = runtime!.startWorkers()
    expect(injected.intervals).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(queries).toEqual([])
    await stop()
    await stop()
    expect(injected.cleared).toBe(0)
  })

  test('timer unref is called and the default interval is 60s', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      timer: injected.timer,
    })
    const stop = runtime!.startWorkers()
    expect(injected.unref).toHaveBeenCalledTimes(1)
    expect(injected.intervals).toEqual([ELEARNING_MEDIA_WORKER_INTERVAL_MS])
    expect(ELEARNING_MEDIA_WORKER_INTERVAL_MS).toBe(60_000)
    await stop()
    expect(injected.cleared).toBe(1)
  })

  test('ticks do not overlap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = 0
    let active = 0
    let maxActive = 0
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(async () => {
        started += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
        return { rows: [], rowCount: 0 }
      }),
      logger,
      env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      timer: injected.timer,
      intervalMs: 10,
    })
    const stop = runtime!.startWorkers()
    injected.fire()
    await waitUntil(() => started === 1, 'first tick start')
    injected.fire()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(started).toBe(1)
    expect(maxActive).toBe(1)
    release()
    await stop()
  })

  test('blob cursor is carried across ticks and reset after a full pass', async () => {
    const injected = createInjectedTimer()
    const captured = capturingLogger()
    const pageOneKey = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/11111111-1111-4111-8111-111111111111.mp4`
    const { sender, workerListCursors } = fakeS3({
      workerPages: [
        { keys: [pageOneKey], nextCursor: 'page-2' },
        { keys: [] },
        { keys: [pageOneKey], nextCursor: 'page-2' },
      ],
    })
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(),
      logger: captured,
      env: PROD_S3,
      s3Sender: sender,
      timer: injected.timer,
      intervalMs: 10,
    })
    const stop = runtime!.startWorkers()
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 1, 'first reconcile completion')
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 2, 'second reconcile completion')
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 3, 'third reconcile completion')
    expect(workerListCursors).toEqual([undefined, 'page-2', undefined])
    await stop()
  })

  test('row cursor is carried across ticks and reset after a full pass', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    const captured = capturingLogger()
    const rowCursors: string[] = []
    const rows = Array.from({ length: ELEARNING_MEDIA_RECONCILE_BATCH_SIZE }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      return {
        id,
        storage_key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/${id}.mp4`,
        status: 'ready',
      }
    })
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(async (sql, params = []) => {
        if (sql.includes('SELECT id, storage_key, status')) {
          rowCursors.push(String(params[0]))
          const cursor = String(params[0] ?? '')
          const limit = Number(params[1])
          const page = rows.filter((row) => row.id > cursor).slice(0, limit)
          return { rows: page, rowCount: page.length }
        }
        return { rows: [], rowCount: 0 }
      }),
      logger: captured,
      env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      timer: injected.timer,
      intervalMs: 10,
    })
    const stop = runtime!.startWorkers()
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 1, 'first reconcile completion')
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 2, 'second reconcile completion')
    injected.fire()
    await waitUntil(() => completedReconcileCount(captured.capturedLogs) === 3, 'third reconcile completion')
    expect(rowCursors[0]).toBe(NIL_UUID)
    expect(rowCursors[1]).toBe(rows[rows.length - 1]!.id)
    expect(rowCursors[2]).toBe(NIL_UUID)
    await stop()
  })

  test('success logs are counts-only; failures are values-free', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    const captured = capturingLogger()
    let fail = false
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(async () => {
        if (fail) throw new Error('SENTINEL_SECRET')
        return { rows: [], rowCount: 0 }
      }),
      logger: captured,
      env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      timer: injected.timer,
      intervalMs: 10,
    })
    const stop = runtime!.startWorkers()
    injected.fire()
    await waitUntil(
      () => JSON.stringify(captured.capturedLogs).includes('elearning_media_reconcile'),
      'counts log',
    )
    fail = true
    injected.fire()
    await waitUntil(
      () => JSON.stringify(captured.capturedLogs).includes('elearning_media_reconcile_tick_failed'),
      'failure log',
    )
    expect(JSON.stringify(captured.capturedLogs)).not.toContain('SENTINEL_SECRET')
    await stop()
  })

  test('fire does not unhandled-reject when info and warn both throw', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    const captured = capturingLogger()
    let unhandledCount = 0
    const onUnhandled = () => { unhandledCount += 1 }
    process.on('unhandledRejection', onUnhandled)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = false
    let stop: (() => Promise<void>) | undefined
    try {
      const runtime = await bootElearningMediaRuntime({
        db: fakeDb(async () => {
          started = true
          await gate
          return { rows: [], rowCount: 0 }
        }),
        logger: {
          info: (...args: unknown[]) => {
            captured.info(...args)
            if (args[0] === 'elearning_media_reconcile') throw new Error('SENTINEL_SECRET')
          },
          warn: (...args: unknown[]) => {
            captured.warn(...args)
            if (args[0] === 'elearning_media_reconcile_tick_failed') throw new Error('SENTINEL_SECRET')
          },
          error: (...args: unknown[]) => { captured.error(...args) },
        },
        env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
        timer: injected.timer,
        intervalMs: 10,
      })
      stop = runtime!.startWorkers()
      injected.fire()
      await waitUntil(() => started, 'in-flight tick before logger throw')
      release()
      await waitUntil(
        () => completedReconcileCount(captured.capturedLogs) === 1,
        'reconcile completion after logger throw',
      )
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(unhandledCount).toBe(0)
      expect(JSON.stringify(captured.capturedLogs)).not.toContain('SENTINEL_SECRET')
      expect(completedReconcileCount(captured.capturedLogs)).toBe(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await stop?.()
    }
  })

  test('stop awaits in-flight work, is idempotent, and clears the timer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const injected = createInjectedTimer()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = false
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(async () => {
        started = true
        await gate
        return { rows: [], rowCount: 0 }
      }),
      logger,
      env: { ...FLAG_ON, ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv,
      timer: injected.timer,
      intervalMs: 10,
    })
    const stop = runtime!.startWorkers()
    injected.fire()
    await waitUntil(() => started, 'in-flight tick')
    const stopPromise = stop()
    let stopDone = false
    void stopPromise.then(() => { stopDone = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopDone).toBe(false)
    expect(injected.cleared).toBe(1)
    release()
    await stopPromise
    expect(stopDone).toBe(true)
    await stop()
    expect(injected.cleared).toBe(1)
  })
})
