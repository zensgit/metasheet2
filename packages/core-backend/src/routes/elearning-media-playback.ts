/**
 * V0.1 token-auth media playback: GET /api/elearning/media/playback?token=...
 *
 * Unmounted factory. Registers nothing unless the watch surface is live and the
 * dedicated playback signing-secret reader accepts env. The token is the only
 * credential — no cookie or JWT middleware. Every request re-verifies the
 * ticket, rechecks DB authorization, then lazily reads a capped byte range.
 * Error bodies are values-free.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'

import { isElearningWatchSurfaceEnabled } from '../elearning/feature-flags'
import {
  authorizeElearningMediaPlayback,
  ElearningPlaybackError,
  parseElearningMediaHttpByteRange,
  readElearningMediaPlaybackSigningSecret,
  verifyElearningMediaPlaybackToken,
  type ElearningPlaybackErrorCode,
  type ElearningPlaybackQueryable,
} from '../services/elearning-media-playback'
import {
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
  type ElearningMediaRangeReadableStore,
} from '../services/elearning-media-storage'

const PLAYBACK_STATUS: Record<ElearningPlaybackErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  assignment_unavailable: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  unavailable: 503,
  invalid_token: 401,
  token_expired: 401,
  invalid_range: 400,
  unsatisfiable_range: 416,
}

export interface ElearningMediaPlaybackRouteDeps {
  db: ElearningPlaybackQueryable
  getStore: () => ElearningMediaRangeReadableStore | null
  env?: NodeJS.ProcessEnv
  now?: () => Date
  isElearningWatchSurfaceEnabled?: typeof isElearningWatchSurfaceEnabled
  readElearningMediaPlaybackSigningSecret?: typeof readElearningMediaPlaybackSigningSecret
  verifyElearningMediaPlaybackToken?: typeof verifyElearningMediaPlaybackToken
  authorizeElearningMediaPlayback?: typeof authorizeElearningMediaPlayback
  parseElearningMediaHttpByteRange?: typeof parseElearningMediaHttpByteRange
}

function envOf(deps: ElearningMediaPlaybackRouteDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function failClosed(res: Response, error: unknown): void {
  if (error instanceof ElearningPlaybackError) {
    res.status(PLAYBACK_STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

function readExactToken(req: Request): { ok: true; token: string } | { ok: false; reason: 'missing' | 'multiple' } {
  const raw = req.query.token
  if (raw === undefined) return { ok: false, reason: 'missing' }
  if (Array.isArray(raw)) return { ok: false, reason: 'multiple' }
  if (typeof raw !== 'string') return { ok: false, reason: 'multiple' }
  if (raw === '') return { ok: false, reason: 'missing' }
  return { ok: true, token: raw }
}

function rangeWithinCap(start: number, end: number, length: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(length)) return false
  if (start < 0 || end < start || length < 1) return false
  const span = end - start + 1
  return span === length && length <= ELEARNING_MEDIA_RANGE_MAX_BYTES
}

export function createElearningMediaPlaybackRouter(
  deps: ElearningMediaPlaybackRouteDeps,
): Router | null {
  const env = envOf(deps)
  const watchEnabled = deps.isElearningWatchSurfaceEnabled ?? isElearningWatchSurfaceEnabled
  if (!watchEnabled(env)) return null
  const readSecret = deps.readElearningMediaPlaybackSigningSecret ?? readElearningMediaPlaybackSigningSecret
  try {
    readSecret(env)
  } catch {
    return null
  }

  const verifyToken = deps.verifyElearningMediaPlaybackToken ?? verifyElearningMediaPlaybackToken
  const authorize = deps.authorizeElearningMediaPlayback ?? authorizeElearningMediaPlayback
  const parseRange = deps.parseElearningMediaHttpByteRange ?? parseElearningMediaHttpByteRange
  const router = Router()

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch((error: unknown) => {
        if (!res.headersSent) failClosed(res, error)
      })
    }

  router.get(
    '/api/elearning/media/playback',
    asyncHandler(async (req: Request, res: Response) => {
      const requestEnv = envOf(deps)
      if (!watchEnabled(requestEnv)) {
        res.status(404).json({ error: 'not_found' })
        return
      }

      let secret: string
      try {
        secret = readSecret(requestEnv)
      } catch (error) {
        failClosed(res, error)
        return
      }

      const token = readExactToken(req)
      if (!token.ok) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }

      const now = deps.now ? deps.now() : new Date()
      const claims = verifyToken(token.token, secret, requestEnv.JWT_SECRET, now)
      const auth = await authorize(deps.db, {
        token: token.token,
        orgId: claims.org,
        userId: claims.sub,
        rangeHeader: req.headers.range,
        playbackSigningSecret: secret,
        jwtSecret: requestEnv.JWT_SECRET,
        now,
      })
      const range = parseRange(req.headers.range, auth.sizeBytes)
      if (!rangeWithinCap(range.start, range.end, range.length)) {
        res.status(500).json({ error: 'internal_error' })
        return
      }

      let store: ElearningMediaRangeReadableStore | null
      try {
        store = deps.getStore()
      } catch (error) {
        failClosed(res, error)
        return
      }
      if (!store) {
        res.status(503).json({ error: 'unavailable' })
        return
      }

      let bytes: Buffer
      try {
        bytes = await store.getRange(auth.storageKey, range.start, range.end)
      } catch (error) {
        failClosed(res, error)
        return
      }
      if (
        !Buffer.isBuffer(bytes)
        || bytes.length !== range.length
        || bytes.length > ELEARNING_MEDIA_RANGE_MAX_BYTES
      ) {
        res.status(500).json({ error: 'internal_error' })
        return
      }

      const status = range.httpStatus
      res.status(status)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', String(bytes.length))
      if (status === 206 && range.contentRange) {
        res.setHeader('Content-Range', range.contentRange)
      }
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.end(bytes)
    }),
  )

  return router
}
