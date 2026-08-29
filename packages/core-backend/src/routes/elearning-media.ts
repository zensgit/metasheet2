/**
 * E-learning M1 — authenticated one-shot multipart MP4 upload.
 *
 * Registers nothing unless ELEARNING_ENABLED and ELEARNING_MEDIA_ENABLED are exact 'true'.
 * Identity, authoritative org, RBAC, storage, and explicit quotas are checked BEFORE multipart
 * body ingestion. Handler rechecks both flags. Multer admits exactly one `file` part
 * (`fileSize`, `files=1`, `fields=0`, `parts=2` — Busboy counts the closing boundary,
 * so parts=2 is one actual file part); there is no client metadata channel.
 * Duration is never read from the client.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { Router } from 'express'
import multer from 'multer'

import { isElearningMediaSurfaceEnabled } from '../elearning/feature-flags'
import { ingestElearningMediaUpload, ElearningMediaIngestError } from '../services/elearning-media-ingest'
import type { ProbeElearningMediaBufferDeps } from '../services/elearning-media-probe'
import type { ElearningMediaDb } from '../services/elearning-media-quota'
import type { ElearningMediaStore } from '../services/elearning-media-storage'
import {
  httpStatusForElearningMediaRejects,
  readElearningMediaQuotaConfig,
} from '../services/elearning-media-validation'

export interface ElearningMediaRouteDeps {
  db: ElearningMediaDb
  store: ElearningMediaStore
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  /** Production wiring: rbacGuard('elearning','write'). Injected in tests. */
  writeGuard: RequestHandler
  storageAvailable?: boolean
  env?: NodeJS.ProcessEnv
  probe?: ProbeElearningMediaBufferDeps
}

type UploadedFile = {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
  fieldname: string
}

function envOf(deps: ElearningMediaRouteDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function mediaConfigReady(deps: ElearningMediaRouteDeps): boolean {
  if (deps.storageAvailable === false) return false
  return readElearningMediaQuotaConfig(envOf(deps)) !== null
}

export function createElearningMediaRouter(deps: ElearningMediaRouteDeps): Router | null {
  if (!isElearningMediaSurfaceEnabled(envOf(deps))) return null
  const router = Router()

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  const requireFlags = (req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningMediaSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }

  const requireIdentity = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    next()
  }

  const requireOrg = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }

  const requireConfig = (_req: Request, res: Response, next: NextFunction): void => {
    if (!mediaConfigReady(deps)) {
      res.status(503).json({ error: 'media_unavailable' })
      return
    }
    next()
  }

  const runUpload = (req: Request, res: Response, next: NextFunction): void => {
    const quotas = readElearningMediaQuotaConfig(envOf(deps))
    if (!quotas) {
      res.status(503).json({ error: 'media_unavailable' })
      return
    }
    const upload = multer({
      storage: multer.memoryStorage(),
      // busboy increments `parts` on the closing boundary, so parts: 1 emits
      // LIMIT_PART_COUNT after a legal one-file body. parts: 2 admits exactly
      // one form part; files: 1 and fields: 0 still refuse extras.
      limits: { fileSize: quotas.maxObjectBytes, files: 1, fields: 0, parts: 2 },
    })
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      const mErr = err as { name?: unknown; code?: unknown }
      if (mErr.name === 'MulterError') {
        const code =
          mErr.code === 'LIMIT_FILE_SIZE'
            ? 'file_too_large'
            : mErr.code === 'LIMIT_FILE_COUNT'
              || mErr.code === 'LIMIT_UNEXPECTED_FILE'
              || mErr.code === 'LIMIT_FIELD_COUNT'
              || mErr.code === 'LIMIT_PART_COUNT'
              ? 'too_many_files'
              : 'upload_rejected'
        const rejected = [{ code }]
        res.status(httpStatusForElearningMediaRejects(rejected)).json({ error: 'rejected', rejected })
        return
      }
      res.status(400).json({ error: 'upload_failed' })
    })
  }

  router.post(
    '/api/elearning/media',
    requireFlags,
    requireIdentity,
    requireOrg,
    deps.writeGuard,
    requireConfig,
    runUpload,
    asyncHandler(async (req: Request, res: Response) => {
      if (!isElearningMediaSurfaceEnabled(envOf(deps))) {
        res.status(404).json({ error: 'not_found' })
        return
      }
      const createdBy = deps.viewerId(req)
      const orgId = deps.orgId(req)
      if (!createdBy) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      if (!orgId) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      const quotas = readElearningMediaQuotaConfig(envOf(deps))
      if (deps.storageAvailable === false || !quotas) {
        res.status(503).json({ error: 'media_unavailable' })
        return
      }
      const f = (req as Request & { file?: UploadedFile }).file
      if (!f) {
        res.status(400).json({ error: 'file_required' })
        return
      }
      try {
        const result = await ingestElearningMediaUpload({
          db: deps.db,
          store: deps.store,
          orgId,
          createdBy,
          fileName: f.originalname,
          mimeType: f.mimetype,
          sizeBytes: f.size,
          content: f.buffer,
          maxObjectBytes: quotas.maxObjectBytes,
          orgQuotaBytes: quotas.orgQuotaBytes,
          probe: deps.probe,
        })
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningMediaIngestError) {
          res.status(error.httpStatus).json(error.body)
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  return router
}
