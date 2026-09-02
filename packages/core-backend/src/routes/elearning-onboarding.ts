import {
  json,
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'

import {
  isElearningAnalyticsSurfaceEnabled,
  isElearningAssignmentSurfaceEnabled,
} from '../elearning/feature-flags'
import {
  createElearningOnboardingPolicy,
  ElearningOnboardingPolicyError,
  retireElearningOnboardingPolicy,
  type ElearningOnboardingPolicyDb,
} from '../services/elearning-onboarding-policy'
import {
  ElearningOnboardingWeeklyReportError,
  getElearningOnboardingWeeklyReport,
  type ElearningOnboardingWeeklyReportQueryable,
} from '../services/elearning-onboarding-weekly-report'

const CREATE_KEYS = new Set([
  'requestId',
  'trainingPlanId',
  'matchRules',
  'hireWindowDays',
  'deadlineDays',
  'weeklyReportEnabled',
])
const jsonParser = json({ limit: 16 * 1024 })

export interface ElearningOnboardingRouteDeps {
  db: ElearningOnboardingPolicyDb & ElearningOnboardingWeeklyReportQueryable
  env?: NodeJS.ProcessEnv
  adminGuard: RequestHandler
  statsGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  createPolicy?: typeof createElearningOnboardingPolicy
  retirePolicy?: typeof retireElearningOnboardingPolicy
  getWeeklyReport?: typeof getElearningOnboardingWeeklyReport
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function exactCreateBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const keys = Object.keys(body)
  return keys.length === CREATE_KEYS.size && keys.every((key) => CREATE_KEYS.has(key))
    ? body
    : null
}

function requireContext(
  deps: ElearningOnboardingRouteDeps,
): RequestHandler {
  return (req, res, next) => {
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
}

function sendError(res: Response, error: unknown): void {
  if (
    !(error instanceof ElearningOnboardingPolicyError)
    && !(error instanceof ElearningOnboardingWeeklyReportError)
  ) {
    res.status(500).json({ error: 'internal_error' })
    return
  }
  const status = error.code === 'invalid_input'
    ? 400
    : error.code === 'forbidden'
      ? 403
      : error.code === 'not_found'
        ? 404
        : error.code === 'conflict'
          ? 409
          : 503
  res.status(status).json({ error: error.code })
}

export function createElearningOnboardingRouter(
  deps: ElearningOnboardingRouteDeps,
): Router | null {
  const env = deps.env ?? process.env
  const assignmentEnabled = isElearningAssignmentSurfaceEnabled(env)
  const analyticsEnabled = isElearningAnalyticsSurfaceEnabled(env)
  if (!assignmentEnabled && !analyticsEnabled) return null

  const router = Router()
  const contextGuard = requireContext(deps)
  const createPolicy = deps.createPolicy ?? createElearningOnboardingPolicy
  const retirePolicy = deps.retirePolicy ?? retireElearningOnboardingPolicy
  const getWeeklyReport = deps.getWeeklyReport ?? getElearningOnboardingWeeklyReport

  router.post(
    '/api/elearning/admin/onboarding/policies',
    contextGuard,
    deps.adminGuard,
    parseJson,
    (req, res): void => {
      void (async () => {
        if (!isElearningAssignmentSurfaceEnabled(env)) {
          res.status(404).json({ error: 'feature_disabled' })
          return
        }
        const body = exactCreateBody(req.body)
        const orgId = deps.orgId(req)
        const actorId = deps.viewerId(req)
        if (!body || !orgId || !actorId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await createPolicy(deps.db, {
            orgId,
            actorId,
            requestId: body.requestId,
            trainingPlanId: body.trainingPlanId,
            matchRules: body.matchRules,
            hireWindowDays: body.hireWindowDays,
            deadlineDays: body.deadlineDays,
            weeklyReportEnabled: body.weeklyReportEnabled,
          })
          res.status(result.duplicate ? 200 : 201).json(result)
        } catch (error) {
          sendError(res, error)
        }
      })()
    },
  )

  router.post(
    '/api/elearning/admin/onboarding/policies/:policyId/retire',
    contextGuard,
    deps.adminGuard,
    (req, res): void => {
      void (async () => {
        if (!isElearningAssignmentSurfaceEnabled(env)) {
          res.status(404).json({ error: 'feature_disabled' })
          return
        }
        const orgId = deps.orgId(req)
        const actorId = deps.viewerId(req)
        if (!orgId || !actorId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          res.json(await retirePolicy(deps.db, {
            orgId,
            actorId,
            policyId: req.params.policyId,
          }))
        } catch (error) {
          sendError(res, error)
        }
      })()
    },
  )

  router.get(
    '/api/elearning/admin/onboarding/policies/:policyId/reports/:weekStart',
    contextGuard,
    deps.statsGuard,
    (req, res): void => {
      void (async () => {
        if (!isElearningAnalyticsSurfaceEnabled(env)) {
          res.status(404).json({ error: 'feature_disabled' })
          return
        }
        const orgId = deps.orgId(req)
        if (!orgId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          res.json(await getWeeklyReport(deps.db, {
            orgId,
            policyId: req.params.policyId,
            weekStart: req.params.weekStart,
          }))
        } catch (error) {
          sendError(res, error)
        }
      })()
    },
  )

  return router
}
