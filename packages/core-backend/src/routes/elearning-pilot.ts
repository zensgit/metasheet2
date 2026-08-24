/**
 * E-learning V0.1 named-pilot HTTP surface: direct assignment + watch start/heartbeat.
 *
 * Unmounted factory. Registers nothing unless master+CONTENT+ASSIGNMENT+MEDIA are exact 'true'.
 * Playback is a later slice. Identity, authoritative org, then RBAC run before JSON/service.
 * Learner/actor/org are injected — never taken from the client. Errors are values-free.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { json, Router } from 'express'

import { isElearningWatchSurfaceEnabled } from '../elearning/feature-flags'
import {
  assignElearningDirect,
  ElearningDirectAssignmentError,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentErrorCode,
} from '../services/elearning-direct-assignment'
import {
  ElearningWatchError,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchErrorCode,
} from '../services/elearning-watch-progress'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ASSIGN_KEYS = new Set(['targetUserId', 'courseVersionId', 'sourceKey', 'deadline'])
const HEARTBEAT_KEYS = new Set(['sequence', 'positionMs', 'playing'])

const ASSIGNMENT_STATUS: Record<ElearningDirectAssignmentErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  target_unavailable: 409,
  course_unavailable: 409,
  conflict: 409,
  unavailable: 503,
}

const WATCH_STATUS: Record<ElearningWatchErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  assignment_unavailable: 403,
  course_withdrawn: 409,
  unsupported_item: 400,
  unsupported_policy: 400,
  conflict: 409,
  sequence_gap: 409,
  session_inactive: 409,
  unavailable: 503,
}

const jsonParser = json({ limit: 16 * 1024 })

export interface ElearningPilotRouteDeps {
  db: ElearningDirectAssignmentDb & ElearningWatchDb
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  /** Production wiring: rbacGuard('elearning','admin'). Injected in tests. */
  adminGuard: RequestHandler
  /** Production wiring: rbacGuard('elearning','read'). Injected in tests. */
  readGuard: RequestHandler
  env?: NodeJS.ProcessEnv
  assignElearningDirect?: typeof assignElearningDirect
  startElearningWatch?: typeof startElearningWatch
  recordElearningHeartbeat?: typeof recordElearningHeartbeat
}

function envOf(deps: ElearningPilotRouteDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function readObject(body: unknown): Record<string, unknown> | null {
  if (body === undefined) return {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return body as Record<string, unknown>
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).some((key) => !allowed.has(key))
}

function readRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.trim() === '') return null
  return value
}

function readUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return null
  return value
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return readUuid(value)
}

function invalid(res: Response): void {
  res.status(400).json({ error: 'invalid_input' })
}

export function createElearningPilotRouter(deps: ElearningPilotRouteDeps): Router | null {
  if (!isElearningWatchSurfaceEnabled(envOf(deps))) return null

  const assignDirect = deps.assignElearningDirect ?? assignElearningDirect
  const startWatch = deps.startElearningWatch ?? startElearningWatch
  const heartbeat = deps.recordElearningHeartbeat ?? recordElearningHeartbeat
  const router = Router()

  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response): void => {
      void fn(req, res).catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    }

  const requireFlags = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningWatchSurfaceEnabled(envOf(deps))) {
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

  const gate = (guard: RequestHandler): RequestHandler[] => [
    requireFlags,
    requireIdentity,
    requireOrg,
    guard,
    parseJson,
  ]

  const recheck = (req: Request, res: Response): { actorId: string; orgId: string } | null => {
    if (!isElearningWatchSurfaceEnabled(envOf(deps))) {
      res.status(404).json({ error: 'not_found' })
      return null
    }
    const actorId = deps.viewerId(req)
    if (!actorId) {
      res.status(401).json({ error: 'unauthenticated' })
      return null
    }
    const orgId = deps.orgId(req)
    if (!orgId) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return null
    }
    return { actorId, orgId }
  }

  router.post(
    '/api/elearning/assignments/direct',
    ...gate(deps.adminGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const body = readObject(req.body)
      if (!body || rejectUnknownKeys(body, ASSIGN_KEYS)) {
        invalid(res)
        return
      }
      const targetUserId = readRequiredString(body.targetUserId)
      const courseVersionId = readUuid(body.courseVersionId)
      const sourceKey = readRequiredString(body.sourceKey)
      if (!targetUserId || !courseVersionId || !sourceKey) {
        invalid(res)
        return
      }
      let deadline: string | null | undefined
      if (Object.prototype.hasOwnProperty.call(body, 'deadline')) {
        const rawDeadline = body.deadline
        if (typeof rawDeadline === 'string') {
          deadline = rawDeadline
        } else if (rawDeadline === null) {
          deadline = null
        } else {
          invalid(res)
          return
        }
      }
      try {
        const result = await assignDirect(deps.db, {
          orgId: ctx.orgId,
          actorId: ctx.actorId,
          targetUserId,
          courseVersionId,
          sourceKey,
          deadline,
        })
        res.status(201).json(result)
      } catch (error) {
        if (error instanceof ElearningDirectAssignmentError) {
          res.status(ASSIGNMENT_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/watch/items/:itemId/start',
    ...gate(deps.readGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const itemId = uuidParam(req, 'itemId')
      const body = readObject(req.body)
      if (!itemId || !body || rejectUnknownKeys(body, new Set())) {
        invalid(res)
        return
      }
      try {
        const result = await startWatch(deps.db, {
          orgId: ctx.orgId,
          userId: ctx.actorId,
          itemId,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningWatchError) {
          res.status(WATCH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  router.post(
    '/api/elearning/watch/sessions/:sessionId/heartbeat',
    ...gate(deps.readGuard),
    asyncHandler(async (req: Request, res: Response) => {
      const ctx = recheck(req, res)
      if (!ctx) return
      const sessionId = uuidParam(req, 'sessionId')
      const body = readObject(req.body)
      if (!sessionId || !body || rejectUnknownKeys(body, HEARTBEAT_KEYS)) {
        invalid(res)
        return
      }
      const sequence = body.sequence
      const positionMs = body.positionMs
      const playing = body.playing
      if (
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        typeof positionMs !== 'number' ||
        !Number.isSafeInteger(positionMs) ||
        positionMs < 0 ||
        (playing !== true && playing !== false)
      ) {
        invalid(res)
        return
      }
      try {
        const result = await heartbeat(deps.db, {
          sessionId,
          orgId: ctx.orgId,
          userId: ctx.actorId,
          sequence,
          positionMs,
          playing,
        })
        res.status(200).json(result)
      } catch (error) {
        if (error instanceof ElearningWatchError) {
          res.status(WATCH_STATUS[error.code]).json({ error: error.code })
          return
        }
        res.status(500).json({ error: 'internal_error' })
      }
    }),
  )

  return router
}
