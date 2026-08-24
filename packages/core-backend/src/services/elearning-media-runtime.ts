/**
 * E-learning M1 runtime boot: flag-gated route mount + production-S3 / dev-local storage.
 * Zero routes unless ELEARNING_ENABLED and ELEARNING_MEDIA_ENABLED are exact 'true'.
 * Generic StorageService is never selected as production media storage.
 */
import type { Request, RequestHandler } from 'express'
import { Router, type Router as ExpressRouter } from 'express'
import * as path from 'node:path'

import { isElearningMediaSurfaceEnabled } from '../elearning/feature-flags'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { createElearningMediaRouter } from '../routes/elearning-media'
import {
  reconcileElearningMediaBlobs,
  reconcileStaleElearningMediaRows,
  type ElearningMediaBlobSource,
  type ElearningMediaReconcileCursor,
} from './elearning-media-reconciler'
import {
  createElearningMediaS3Provider,
  type ElearningMediaS3CommandSender,
} from './elearning-media-s3'
import {
  ELEARNING_MEDIA_STORAGE_PREFIX,
  LocalFsElearningMediaStore,
  ObjectStoreElearningMediaStore,
  probeElearningMediaStore,
  type ElearningMediaStore,
} from './elearning-media-storage'
import type { ElearningMediaDb } from './elearning-media-quota'

export const ELEARNING_MEDIA_WORKER_INTERVAL_MS = 60_000

export type ElearningMediaStorageResolution =
  | { kind: 'local-fs'; store: LocalFsElearningMediaStore; rootDir: string; source: ElearningMediaBlobSource }
  | { kind: 'object-store'; store: ObjectStoreElearningMediaStore; source: ElearningMediaBlobSource }
  | { kind: 's3-required'; store: null; source: null }

export interface ElearningMediaRuntimeLogger {
  info(message: string, counts?: Record<string, number>): void
  warn(message: string): void
  error(message: string): void
}

export interface ElearningMediaWorkerTimerHandle {
  unref?: () => void
}

/** Test seam only — production uses the process timer. */
export interface ElearningMediaWorkerTimer {
  setInterval(callback: () => void, ms: number): ElearningMediaWorkerTimerHandle
  clearInterval(handle: ElearningMediaWorkerTimerHandle): void
}

export interface ElearningMediaRuntime {
  router: ExpressRouter
  storage: ElearningMediaStorageResolution
  startWorkers(): () => Promise<void>
}

export interface ElearningMediaRuntimeOptions {
  db: ElearningMediaDb
  logger: ElearningMediaRuntimeLogger
  env?: NodeJS.ProcessEnv
  s3Sender?: ElearningMediaS3CommandSender
  writeGuard?: RequestHandler
  probe?: import('./elearning-media-probe').ProbeElearningMediaBufferDeps
  /** Test seam only. Production ticks every ELEARNING_MEDIA_WORKER_INTERVAL_MS. */
  intervalMs?: number
  /** Test seam only. Production uses setInterval/clearInterval. */
  timer?: ElearningMediaWorkerTimer
}

const defaultWorkerTimer: ElearningMediaWorkerTimer = {
  setInterval(callback, ms) {
    return setInterval(callback, ms)
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout)
  },
}

/**
 * Production = complete ELEARNING_MEDIA_S3_BUCKET+REGION only; never local disk.
 * Dev/test = dedicated contained ELEARNING_MEDIA_STORAGE_DIR (or <cwd>/storage/elearning-media).
 */
export function resolveElearningMediaStorage(
  env: NodeJS.ProcessEnv = process.env,
  s3Sender?: ElearningMediaS3CommandSender,
): ElearningMediaStorageResolution {
  if (String(env.NODE_ENV ?? '').trim() === 'production') {
    const builtInS3 = createElearningMediaS3Provider(env, s3Sender)
    if (builtInS3) {
      return {
        kind: 'object-store',
        store: new ObjectStoreElearningMediaStore(builtInS3),
        source: {
          listPage: (cursor, limit, now) => builtInS3.listMediaBlobsPage(cursor, limit, now),
          hasBlob: (storageKey) => builtInS3.hasMediaBlob(storageKey),
        },
      }
    }
    return { kind: 's3-required', store: null, source: null }
  }
  const configured = typeof env.ELEARNING_MEDIA_STORAGE_DIR === 'string'
    ? env.ELEARNING_MEDIA_STORAGE_DIR.trim()
    : ''
  const rootDir = configured || path.resolve(process.cwd(), 'storage', 'elearning-media')
  const store = new LocalFsElearningMediaStore(rootDir)
  return { kind: 'local-fs', store, rootDir, source: store }
}

function viewerId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? (req.user as { sub?: unknown } | undefined)?.sub
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : candidate != null && typeof candidate === 'number' && Number.isFinite(candidate)
      ? String(candidate)
      : null
}

/** Authoritative org: JWT-bound req.authenticatedTenantId only. */
function orgId(req: Request): string | null {
  const tenant = req.authenticatedTenantId
  return typeof tenant === 'string' && tenant.trim() ? tenant.trim() : null
}

/**
 * After the existing put/get/delete probe, prove list permission and HEAD/existence
 * against a just-written object. Values-free on failure.
 */
async function probeElearningMediaSource(
  store: ElearningMediaStore,
  source: ElearningMediaBlobSource,
): Promise<void> {
  const payload = Buffer.from('elearning-media source probe')
  const probeKey = `${ELEARNING_MEDIA_STORAGE_PREFIX}boot-source-probe-${Date.now()}-${Math.floor(Math.random() * 1e9)}.mp4`
  try {
    await store.put(probeKey, payload, 'video/mp4')
    await source.listPage(undefined, 1)
    if (!(await source.hasBlob(probeKey))) {
      throw new Error('probe head miss')
    }
    await store.delete(probeKey)
  } catch {
    await store.delete(probeKey).catch(() => false)
    throw new Error('E-learning media storage probe failed')
  }
}

export async function bootElearningMediaRuntime(
  opts: ElearningMediaRuntimeOptions,
): Promise<ElearningMediaRuntime | null> {
  const env = opts.env ?? process.env
  if (!isElearningMediaSurfaceEnabled(env)) return null

  const storage = resolveElearningMediaStorage(env, opts.s3Sender)
  if (storage.kind === 'local-fs') {
    await probeElearningMediaStore(storage.store)
    await probeElearningMediaSource(storage.store, storage.source)
    opts.logger.info('elearning_media_storage_local_fs')
  } else if (storage.kind === 'object-store') {
    await probeElearningMediaStore(storage.store)
    await probeElearningMediaSource(storage.store, storage.source)
    opts.logger.info('elearning_media_storage_object_store')
  } else {
    opts.logger.warn('elearning_media_storage_s3_required')
  }

  const unavailableStore: ElearningMediaStore = {
    put: async () => {
      throw new Error('elearning media store unavailable')
    },
    get: async () => {
      throw new Error('elearning media store unavailable')
    },
    delete: async () => {
      throw new Error('elearning media store unavailable')
    },
  }

  const inner = createElearningMediaRouter({
    db: opts.db,
    store: storage.store ?? unavailableStore,
    storageAvailable: storage.store != null,
    viewerId,
    orgId,
    writeGuard: opts.writeGuard ?? rbacGuard('elearning', 'write'),
    env,
    probe: opts.probe,
  })
  if (!inner) return null

  const startWorkers = (): (() => Promise<void>) => {
    if (storage.kind === 's3-required' || storage.store == null || storage.source == null) {
      return async () => {}
    }
    const store = storage.store
    const source = storage.source
    const intervalMs = opts.intervalMs ?? ELEARNING_MEDIA_WORKER_INTERVAL_MS
    const timer = opts.timer ?? defaultWorkerTimer
    let stopped = false
    let running = false
    let cursor: ElearningMediaReconcileCursor | undefined
    const activeTicks = new Set<Promise<unknown>>()
    let stopPromise: Promise<void> | undefined

    const tick = async (): Promise<void> => {
      if (stopped || running) return
      running = true
      try {
        const stale = await reconcileStaleElearningMediaRows(opts.db, store)
        const blobs = await reconcileElearningMediaBlobs(opts.db, source, store, { cursor })
        cursor = blobs.nextCursor
        opts.logger.info('elearning_media_reconcile', {
          claimed: stale.claimed,
          deleted: stale.deleted,
          deleteFailed: stale.deleteFailed,
          scannedBlobs: blobs.scannedBlobs,
          deletedBlobs: blobs.deletedBlobs,
          blobDeleteFailed: blobs.deleteFailed,
          scannedRows: blobs.scannedRows,
          missingReadyBlobs: blobs.missingReadyBlobs,
        })
      } catch {
        opts.logger.warn('elearning_media_reconcile_tick_failed')
      } finally {
        running = false
      }
    }

    const fire = (): void => {
      if (stopped) return
      const pending = tick().finally(() => {
        activeTicks.delete(pending)
      })
      activeTicks.add(pending)
      void pending.catch(() => undefined)
    }

    const handle = timer.setInterval(fire, intervalMs)
    handle.unref?.()

    return async () => {
      if (stopPromise) return stopPromise
      stopped = true
      timer.clearInterval(handle)
      stopPromise = Promise.allSettled([...activeTicks]).then(() => undefined)
      await stopPromise
    }
  }

  const router = Router()
  router.use('/api/elearning/media', authenticate)
  router.use(inner)
  return { router, storage, startWorkers }
}
