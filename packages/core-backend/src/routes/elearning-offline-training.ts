import { json, Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

import { isElearningOfflineTrainingSurfaceEnabled } from '../elearning/feature-flags'
import { ElearningOfflineError } from '../services/elearning-offline-training'
import {
  issueElearningOfflineQr,
  listMyElearningOfflineTrainings,
  publishElearningOfflineTraining,
  recordElearningOfflineAttendance,
  setElearningOfflineTrainingStatus,
  type ElearningOfflineDb,
} from '../services/elearning-offline-training-postgres'

const jsonParser = json({ limit: 64 * 1024 })
const publishJsonParser = json({ limit: 512 * 1024 })
const QR_BODY_KEYS = new Set(['action', 'requestId'])
const STATUS_BODY_KEYS = new Set(['reason', 'requestId', 'status'])

const STATUS: Record<ElearningOfflineError['code'], number> = {
  check_in_required: 409,
  conflict: 409,
  disabled: 404,
  expired: 409,
  forbidden: 403,
  invalid_input: 400,
  invalid_token: 400,
  not_found: 404,
  unavailable: 503,
  window_closed: 409,
  window_not_open: 409,
}

export interface ElearningOfflineTrainingRouteDeps {
  db: ElearningOfflineDb
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  readGuard: RequestHandler
  orgId(req: Request): string | null
  viewerId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  publishElearningOfflineTraining?: typeof publishElearningOfflineTraining
  issueElearningOfflineQr?: typeof issueElearningOfflineQr
  setElearningOfflineTrainingStatus?: typeof setElearningOfflineTrainingStatus
  recordElearningOfflineAttendance?: typeof recordElearningOfflineAttendance
  listMyElearningOfflineTrainings?: typeof listMyElearningOfflineTrainings
}

function parseJsonWith(parser: RequestHandler): RequestHandler {
  return (req, res, next): void => parser(req, res, (error?: unknown) => {
    if (!error) return next()
    if (!req.readableEnded) req.resume()
    res.status(400).json({ error: 'invalid_input' })
  })
}

const parseJson = parseJsonWith(jsonParser)
const parsePublishJson = parseJsonWith(publishJsonParser)

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.size && keys.every((key) => (
    typeof key === 'string'
    && expected.has(key)
    && Object.prototype.propertyIsEnumerable.call(value, key)
  ))
}

function uuidParam(req: Request, name: string): string | null {
  const value = (req.params as Record<string, unknown>)[name]
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ElearningOfflineError) {
    res.status(STATUS[error.code]).json({ error: error.code })
    return
  }
  res.status(500).json({ error: 'internal_error' })
}

export function createElearningOfflineTrainingRouter(
  deps: ElearningOfflineTrainingRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  if (!isElearningOfflineTrainingSurfaceEnabled(env)) return null
  const router = Router()
  const publish = deps.publishElearningOfflineTraining ?? publishElearningOfflineTraining
  const issueQr = deps.issueElearningOfflineQr ?? issueElearningOfflineQr
  const setStatus = deps.setElearningOfflineTrainingStatus ?? setElearningOfflineTrainingStatus
  const record = deps.recordElearningOfflineAttendance ?? recordElearningOfflineAttendance
  const listMine = deps.listMyElearningOfflineTrainings ?? listMyElearningOfflineTrainings

  const requireFlag = (_req: Request, res: Response, next: NextFunction): void => {
    if (!isElearningOfflineTrainingSurfaceEnabled(env)) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  }
  const requireContext = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.viewerId(req)) {
      res.status(401).json({ error: 'unauthenticated' })
      return
    }
    if (!deps.orgId(req)) {
      res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
      return
    }
    next()
  }
  const requireGlobalAdmin = (req: Request, res: Response, next: NextFunction): void => {
    if (!deps.isGlobalAdmin(req)) {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
  const run = (
    handler: (req: Request, res: Response, ctx: { orgId: string; actorId: string }) => Promise<void>,
  ): RequestHandler => (req, res): void => {
    const orgId = deps.orgId(req)
    const actorId = deps.viewerId(req)
    if (!orgId || !actorId) {
      res.status(500).json({ error: 'internal_error' })
      return
    }
    void handler(req, res, { orgId, actorId }).catch((error) => sendError(res, error))
  }

  router.post(
    '/api/elearning/admin/offline-trainings',
    requireFlag,
    requireContext,
    deps.adminGuard,
    requireGlobalAdmin,
    parsePublishJson,
    run(async (req, res, ctx) => {
      const result = await publish(deps.db, {
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        command: req.body,
      })
      res.status(result.duplicate ? 200 : 201).json(result)
    }),
  )

  router.post(
    '/api/elearning/admin/offline-trainings/:trainingId/status',
    requireFlag,
    requireContext,
    deps.adminGuard,
    requireGlobalAdmin,
    parseJson,
    run(async (req, res, ctx) => {
      const trainingId = uuidParam(req, 'trainingId')
      const body = readObject(req.body)
      if (!trainingId || !body || !exactKeys(body, STATUS_BODY_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await setStatus(deps.db, {
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        trainingId,
        command: body,
      })
      res.status(200).json(result)
    }),
  )

  router.post(
    '/api/elearning/admin/offline-trainings/:trainingId/targets/:targetId/qr',
    requireFlag,
    requireContext,
    deps.adminGuard,
    requireGlobalAdmin,
    parseJson,
    run(async (req, res, ctx) => {
      const trainingId = uuidParam(req, 'trainingId')
      const targetId = uuidParam(req, 'targetId')
      const body = readObject(req.body)
      if (!trainingId || !targetId || !body || !exactKeys(body, QR_BODY_KEYS)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      const result = await issueQr(deps.db, {
        orgId: ctx.orgId,
        actorId: ctx.actorId,
        command: { ...body, trainingId, targetId },
      }, env)
      res.status(result.duplicate ? 200 : 201).json(result)
    }),
  )

  router.post(
    '/api/elearning/me/offline-attendance',
    requireFlag,
    requireContext,
    deps.readGuard,
    parseJson,
    run(async (req, res, ctx) => {
      res.status(200).json(await record(deps.db, {
        orgId: ctx.orgId,
        userId: ctx.actorId,
        command: req.body,
      }, env))
    }),
  )

  router.get(
    '/api/elearning/me/offline-trainings',
    requireFlag,
    requireContext,
    deps.readGuard,
    run(async (_req, res, ctx) => {
      res.status(200).json({
        trainings: await listMine(deps.db, { orgId: ctx.orgId, userId: ctx.actorId }),
      })
    }),
  )

  return router
}
