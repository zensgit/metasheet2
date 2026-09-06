import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, Router } from 'express'

import { isElearningEnrollmentSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningCourseEnrollmentError,
  enrollElearningCourse,
  type ElearningCourseEnrollmentDb,
} from '../services/elearning-course-enrollment'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BODY_KEYS = new Set(['requestId'])
const smallJsonParser = json({ limit: 16 * 1024 })

const STATUS = {
  invalid_input: 400,
  not_found: 404,
  not_enrollable: 403,
  already_assigned: 409,
  conflict: 409,
  unavailable: 503,
} as const

export interface ElearningEnrollmentRouteDeps {
  db: ElearningCourseEnrollmentDb
  env?: NodeJS.ProcessEnv
  readGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  enrollElearningCourse?: typeof enrollElearningCourse
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === BODY_KEYS.size && keys.every((key) => BODY_KEYS.has(key))
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  smallJsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    const parsed = error as { status?: unknown; type?: unknown }
    if (parsed.status === 413 || parsed.type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' })
      return
    }
    res.status(400).json({ error: 'invalid_input' })
  })
}

export function createElearningEnrollmentRouter(
  deps: ElearningEnrollmentRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  if (!isElearningEnrollmentSurfaceEnabled(env)) return null
  const router = Router()
  const enroll = deps.enrollElearningCourse ?? enrollElearningCourse

  const requireFlags = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningEnrollmentSurfaceEnabled(env)) {
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

  router.post(
    '/api/elearning/me/courses/:courseId/enrollments',
    requireFlags,
    requireIdentity,
    requireOrg,
    deps.readGuard,
    parseJson,
    (req, res): void => {
      void (async () => {
        if (!isElearningEnrollmentSurfaceEnabled(env)) {
          res.status(404).json({ error: 'not_found' })
          return
        }
        const userId = deps.viewerId(req)
        if (!userId) {
          res.status(401).json({ error: 'unauthenticated' })
          return
        }
        const orgId = deps.orgId(req)
        if (!orgId) {
          res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
          return
        }
        const courseId = uuid((req.params as Record<string, unknown>).courseId)
        const body = readObject(req.body)
        const requestId = body ? uuid(body.requestId) : null
        if (!courseId || !body || !hasExactKeys(body) || !requestId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await enroll(deps.db, {
            orgId,
            userId,
            requestId,
            courseId,
          })
          res.status(201).json(result)
        } catch (error) {
          if (error instanceof ElearningCourseEnrollmentError) {
            res.status(STATUS[error.code]).json({ error: error.code })
            return
          }
          res.status(500).json({ error: 'internal_error' })
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  return router
}
