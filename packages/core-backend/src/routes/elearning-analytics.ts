import {
  json,
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'

import { isElearningAnalyticsSurfaceEnabled } from '../elearning/feature-flags'
import {
  createElearningAnalyticsExport,
  downloadElearningAnalyticsExport,
  ElearningAnalyticsExportError,
  getElearningAnalyticsExport,
  type ElearningAnalyticsExportDb,
} from '../services/elearning-analytics-export'
import {
  ElearningDepartmentStatsError,
  getElearningDepartmentStats,
  type ElearningDepartmentStatsDb,
} from '../services/elearning-department-stats'
import type { ElearningDepartmentStatsProjection } from '../services/elearning-department-stats-policy'
import {
  ElearningStatsDailyReadError,
  getElearningDepartmentStatsDaily,
  type ElearningStatsDailyReadDb,
} from '../services/elearning-stats-daily-read'

const QUERY_KEYS = new Set(['periodStart', 'periodEnd'])
const EXPORT_BODY_KEYS = new Set(['requestId', 'departmentId', 'periodStart', 'periodEnd'])
const jsonParser = json({ limit: 16 * 1024 })
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ElearningAnalyticsRouteDeps {
  db: ElearningDepartmentStatsDb & ElearningStatsDailyReadDb & ElearningAnalyticsExportDb
  env?: NodeJS.ProcessEnv
  statsGuard: RequestHandler
  viewerId(req: Request): string | null
  orgId(req: Request): string | null
  isGlobalAdmin(req: Request): boolean
  getElearningDepartmentStats?: typeof getElearningDepartmentStats
  getElearningDepartmentStatsDaily?: typeof getElearningDepartmentStatsDaily
  createElearningAnalyticsExport?: typeof createElearningAnalyticsExport
  getElearningAnalyticsExport?: typeof getElearningAnalyticsExport
  downloadElearningAnalyticsExport?: typeof downloadElearningAnalyticsExport
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

function exportParam(req: Request): string | null {
  const value = (req.params as Record<string, unknown>).exportId
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

function parseJson(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (error?: unknown) => {
    if (!error) return next()
    res.status(400).json({ error: 'invalid_input' })
  })
}

function exactBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const keys = Object.keys(body)
  return keys.length === EXPORT_BODY_KEYS.size && keys.every((key) => EXPORT_BODY_KEYS.has(key))
    ? body
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
  if (
    !(error instanceof ElearningDepartmentStatsError)
    && !(error instanceof ElearningStatsDailyReadError)
    && !(error instanceof ElearningAnalyticsExportError)
  ) {
    res.status(500).json({ error: 'internal_error' })
    return
  }
  const status = error.code === 'invalid_input'
    ? 400
    : error.code === 'conflict' || error.code === 'not_ready'
      ? 409
      : error.code === 'forbidden'
        ? 403
        : error.code === 'not_found'
          ? 404
          : error.code === 'expired'
            ? 410
            : 503
  res.status(status).json({ error: error.code })
}

export function createElearningAnalyticsRouter(
  deps: ElearningAnalyticsRouteDeps,
): Router | null {
  if (!isElearningAnalyticsSurfaceEnabled(deps.env ?? process.env)) return null
  const router = Router()
  const readStats = deps.getElearningDepartmentStats ?? getElearningDepartmentStats
  const readStatsDaily = deps.getElearningDepartmentStatsDaily
    ?? getElearningDepartmentStatsDaily
  const createExport = deps.createElearningAnalyticsExport ?? createElearningAnalyticsExport
  const readExport = deps.getElearningAnalyticsExport ?? getElearningAnalyticsExport
  const downloadExport = deps.downloadElearningAnalyticsExport
    ?? downloadElearningAnalyticsExport

  const requireContext: RequestHandler = (req, res, next) => {
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

  router.post(
    '/api/elearning/admin/analytics/exports',
    requireContext,
    deps.statsGuard,
    parseJson,
    (req, res): void => {
      void (async () => {
        const body = exactBody(req.body)
        const actorId = deps.viewerId(req)
        const orgId = deps.orgId(req)
        if (!body || !actorId || !orgId) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await createExport(deps.db, {
            orgId,
            actorId,
            isGlobalAdmin: deps.isGlobalAdmin(req),
            requestId: body.requestId,
            departmentId: body.departmentId,
            periodStart: body.periodStart,
            periodEnd: body.periodEnd,
          }, deps.env ?? process.env)
          res.status(result.duplicate ? 200 : 202).json(result)
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  router.get(
    '/api/elearning/admin/analytics/exports/:exportId',
    requireContext,
    deps.statsGuard,
    (req, res): void => {
      void (async () => {
        const exportId = exportParam(req)
        const actorId = deps.viewerId(req)
        const orgId = deps.orgId(req)
        if (!exportId || !actorId || !orgId || Object.keys(req.query).length !== 0) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          res.status(200).json(await readExport(deps.db, {
            orgId,
            actorId,
            isGlobalAdmin: deps.isGlobalAdmin(req),
            exportId,
          }, deps.env ?? process.env))
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  router.get(
    '/api/elearning/admin/analytics/exports/:exportId/download',
    requireContext,
    deps.statsGuard,
    (req, res): void => {
      void (async () => {
        const exportId = exportParam(req)
        const actorId = deps.viewerId(req)
        const orgId = deps.orgId(req)
        if (!exportId || !actorId || !orgId || Object.keys(req.query).length !== 0) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await downloadExport(deps.db, {
            orgId,
            actorId,
            isGlobalAdmin: deps.isGlobalAdmin(req),
            exportId,
          }, undefined, deps.env ?? process.env)
          res.status(200)
          res.setHeader('Content-Type', result.contentType)
          res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
          res.send(result.content)
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

  router.get(
    '/api/elearning/admin/analytics/departments/:departmentId/daily/:statsDate',
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
        if (Object.keys(req.query as Record<string, unknown>).length !== 0) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        const departmentId = departmentParam(req)
        const statsDate = (req.params as Record<string, unknown>).statsDate
        const actorId = deps.viewerId(req)
        const orgId = deps.orgId(req)
        if (
          !departmentId
          || typeof statsDate !== 'string'
          || !actorId
          || !orgId
        ) {
          res.status(400).json({ error: 'invalid_input' })
          return
        }
        try {
          const result = await readStatsDaily(deps.db, {
            orgId,
            actorId,
            isGlobalAdmin: deps.isGlobalAdmin(req),
            departmentId,
            statsDate,
          })
          res.status(200).json(result)
        } catch (error) {
          sendError(res, error)
        }
      })().catch(() => {
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
      })
    },
  )

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
