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
  createElearningMediaS3Provider,
  type ElearningMediaS3CommandSender,
} from './elearning-media-s3'
import {
  LocalFsElearningMediaStore,
  ObjectStoreElearningMediaStore,
  probeElearningMediaStore,
  type ElearningMediaStore,
} from './elearning-media-storage'
import type { ElearningMediaDb } from './elearning-media-quota'

export type ElearningMediaStorageResolution =
  | { kind: 'local-fs'; store: LocalFsElearningMediaStore; rootDir: string }
  | { kind: 'object-store'; store: ObjectStoreElearningMediaStore }
  | { kind: 's3-required'; store: null }

export interface ElearningMediaRuntimeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: Error): void
}

export interface ElearningMediaRuntime {
  router: ExpressRouter
  storage: ElearningMediaStorageResolution
}

export interface ElearningMediaRuntimeOptions {
  db: ElearningMediaDb
  logger: ElearningMediaRuntimeLogger
  env?: NodeJS.ProcessEnv
  s3Sender?: ElearningMediaS3CommandSender
  writeGuard?: RequestHandler
  probe?: import('./elearning-media-probe').ProbeElearningMediaBufferDeps
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
      return { kind: 'object-store', store: new ObjectStoreElearningMediaStore(builtInS3) }
    }
    return { kind: 's3-required', store: null }
  }
  const configured = typeof env.ELEARNING_MEDIA_STORAGE_DIR === 'string'
    ? env.ELEARNING_MEDIA_STORAGE_DIR.trim()
    : ''
  const rootDir = configured || path.resolve(process.cwd(), 'storage', 'elearning-media')
  return { kind: 'local-fs', store: new LocalFsElearningMediaStore(rootDir), rootDir }
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

export async function bootElearningMediaRuntime(
  opts: ElearningMediaRuntimeOptions,
): Promise<ElearningMediaRuntime | null> {
  const env = opts.env ?? process.env
  if (!isElearningMediaSurfaceEnabled(env)) return null

  const storage = resolveElearningMediaStorage(env, opts.s3Sender)
  if (storage.kind === 'local-fs') {
    await probeElearningMediaStore(storage.store)
    opts.logger.info('E-learning media storage: local-fs (dev/test only — production requires S3; probe ok)')
  } else if (storage.kind === 'object-store') {
    await probeElearningMediaStore(storage.store)
    opts.logger.info('E-learning media storage: built-in S3 object-store provider (probe ok)')
  } else {
    opts.logger.warn(
      'E-learning media storage: incomplete S3 configuration in production — uploads fail closed (503)',
    )
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

  const router = Router()
  router.use('/api/elearning/media', authenticate)
  router.use(inner)
  return { router, storage }
}
