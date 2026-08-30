import { Router, type Request, type RequestHandler, type Response } from 'express'

import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'
import {
  ElearningDepartmentStatsError,
  getElearningDepartmentStats,
  type ElearningDepartmentStatsDb,
} from '../services/elearning-department-stats'
import type { ElearningDepartmentStatsProjection } from '../services/elearning-department-stats-policy'

const QUERY_KEYS = new Set(['periodStart', 'periodEnd'])
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ElearningAnalyticsRouteDeps {
  db: ElearningDepartmentStatsDb
  env?: NodeJS.ProcessEnv
  statsGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  getElearningDepartmentStats?: typeof getElearningDepartmentStats
}

function queryText(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 64 ? value : null
}

function departmentParam(req: Request): string | null {
  const value = (req.params as Record<string, unknown>).departmentId
  return typeof value === 'string' && UUID_RE.test(value)
    ? value.toLowerCase()
    : null
}

function dto(result: ElearningDepartmentStatsProjection) {
  const common = {
    departmentId: result.departmentId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    sourceVersion: result.sourceVersion,
    suppressed: result.suppressed,
  }
  if (!('metrics' in result)) return common
  const metrics = result.metrics
  return {
    ...common,
    metrics: {
      assignedCount: metrics.assignedCount,
      completedCount: metrics.completedCount,
      completionRate: metrics.completionRate,
      creditAverage: metrics.creditAverage,
      creditTotal: metrics.creditTotal,
      examParticipantCount: metrics.examParticipantCount,
      learnerCount: metrics.learnerCount,
      learningSeconds: metrics.learningSeconds,
      memberCount: metrics.memberCount,
      overdueCount: metrics.overdueCount,
    },
  }
}

function sendError(res: Response, error: unknown): void {
  if (!(error instanceof ElearningDepartmentStatsError)) {
    res.status(500).json({ error: 'internal_error' })
    return
  }
  const status = error.code === 'invalid_input'
    ? 400
    : error.code === 'forbidden'
      ? 403
      : error.code === 'not_found'
        ? 404
        : 503
  res.status(status).json({ error: error.code })
}

export function createElearningAnalyticsRouter(
  deps: ElearningAnalyticsRouteDeps,
): Router | null {
  if (!isElearningAnalyticsSurfaceEnabled(deps.env ?? process.env)) return null
  const router = Router()
  const readStats = deps.getElearningDepartmentStats ?? getElearningDepartmentStats

  router.get(
    '/api/elearning/admin/analytics/departments/:departmentId',
    (req, res, next) => {
      if (!deps.viewerId(req)) {
        res.status(401).json({ error: 'unauthenticated' })
        return
      }
      if (!deps.orgId(req)) {
        res.status(403).json({ error: 'ORG_CONTEXT_REQUIRED' })
        return
      }
      next()
    },
    deps.statsGuard,
    (req, res): void => {
      void (async () => {
        const query = req.query as Record<string, unknown>
        if (
          Object.keys(query).some((key) => !QUERY_KEYS.has(key))
          || !Object.prototype.hasOwnProperty.call(query, 'periodStart')
          || !Object.prototype.hasOwnProperty.call(query, 'periodEnd')
        ) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        const departmentId = departmentParam(req)
        const periodStart = queryText(query.periodStart)
        const periodEnd = queryText(query.periodEnd)
        const actorId = deps.viewerId(req)
        const orgId = deps.orgId(req)
        if (!departmentId || !periodStart || !periodEnd || !actorId || !orgId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await readStats(deps.db, {
            orgId,
            actorId,
            isGlobalAdmin: deps.isGlobalAdmin(req),
            departmentId,
            periodStart,
            periodEnd,
          })
          res.status(200).json(dto(result))
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  return router
}
