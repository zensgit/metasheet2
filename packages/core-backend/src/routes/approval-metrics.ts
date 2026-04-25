/**
 * Wave 2 WP5 slice 1 — approval metrics / SLA routes.
 *
 * Summary and breach endpoints are admin-only; per-instance metrics are
 * visible to any authenticated caller that the main approval detail
 * endpoint would show (no extra scoping here — the metrics row is keyed
 * by instance_id and inherits the instance's own ACL).
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import {
  ApprovalMetricsService,
  getApprovalMetricsService,
  type ApprovalMetricsService as ApprovalMetricsServiceType,
} from '../services/ApprovalMetricsService'

const logger = new Logger('ApprovalMetricsRouter')

function resolveTenantId(req: Request): string {
  const candidate = req.user?.tenantId
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim()
  }
  return 'default'
}

function isAdminActor(req: Request): boolean {
  if (req.user?.role === 'admin') return true
  const roles = Array.isArray(req.user?.roles)
    ? req.user!.roles.filter((r): r is string => typeof r === 'string')
    : []
  if (roles.includes('admin')) return true
  const permissions = Array.isArray(req.user?.permissions)
    ? req.user!.permissions.filter((p): p is string => typeof p === 'string')
    : []
  return permissions.includes('*:*')
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

export interface ApprovalMetricsRouterOptions {
  metricsService?: ApprovalMetricsServiceType
}

export function approvalMetricsRouter(options?: ApprovalMetricsRouterOptions): Router {
  const r = Router()
  const metricsService = options?.metricsService ?? getApprovalMetricsService()

  r.get('/api/approvals/metrics/summary',
    authenticate,
    rbacGuard('approvals:admin'),
    async (req: Request, res: Response) => {
      try {
        if (!isAdminActor(req)) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } })
        }
        const summary = await metricsService.getMetricsSummary({
          tenantId: resolveTenantId(req),
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
        })
        return res.json({ ok: true, data: summary })
      } catch (error) {
        logger.error(`metrics summary failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_SUMMARY_FAILED', message: 'Failed to load approval metrics summary' } })
      }
    },
  )

  r.get('/api/approvals/metrics/breaches',
    authenticate,
    rbacGuard('approvals:admin'),
    async (req: Request, res: Response) => {
      try {
        if (!isAdminActor(req)) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } })
        }
        const limit = Number.parseInt(String(req.query.limit ?? '50'), 10)
        const breaches = await metricsService.listActiveBreaches({
          tenantId: resolveTenantId(req),
          limit: Number.isFinite(limit) ? limit : 50,
        })
        return res.json({ ok: true, data: breaches })
      } catch (error) {
        logger.error(`metrics breaches failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_BREACHES_FAILED', message: 'Failed to load SLA breaches' } })
      }
    },
  )

  r.get('/api/approvals/metrics/instances/:instanceId',
    authenticate,
    rbacGuard('approvals:read'),
    async (req: Request, res: Response) => {
      try {
        const instanceId = String(req.params.instanceId || '').trim()
        if (!instanceId) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'instanceId is required' } })
        }
        // Wave 2 WP5 slice 1 — participant-or-admin ACL. Admins see every
        // instance's metrics. Non-admin callers must already be a requester,
        // an active/historical assignee, or a recorded actor on the instance.
        // We check both approval_assignments (role + user) and approval_records
        // so transferred / returned participants are covered.
        const isAdmin = isAdminActor(req)
        if (!isAdmin) {
          const actorId = typeof req.user?.id === 'string' ? req.user.id
            : typeof req.user?.userId === 'string' ? req.user.userId
            : typeof req.user?.sub === 'string' ? req.user.sub
            : null
          if (!actorId) {
            return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Actor required' } })
          }
          if (!pool) {
            return res.status(503).json({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'Database not available' } })
          }
          const actorRoles = Array.isArray(req.user?.roles)
            ? req.user!.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
            : []
          if (typeof req.user?.role === 'string' && req.user.role.trim().length > 0) {
            actorRoles.push(req.user.role.trim())
          }
          const participantCheck = await pool.query<{ exists: boolean }>(
            `SELECT EXISTS(
              SELECT 1 FROM approval_instances i
              WHERE i.id = $1 AND (
                COALESCE(i.requester_snapshot->>'id', '') = $2
                OR EXISTS(
                  SELECT 1 FROM approval_assignments a
                  WHERE a.instance_id = i.id
                    AND (
                      (a.assignment_type = 'user' AND a.assignee_id = $2)
                      OR (a.assignment_type = 'role' AND a.assignee_id = ANY($3::text[]))
                    )
                )
                OR EXISTS(
                  SELECT 1 FROM approval_records r
                  WHERE r.instance_id = i.id AND r.actor_id = $2
                )
              )
            ) AS exists`,
            [instanceId, actorId, actorRoles.length > 0 ? actorRoles : ['__none__']],
          )
          if (!participantCheck.rows[0]?.exists) {
            return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not a participant of this approval' } })
          }
        }

        const metrics = await metricsService.getInstanceMetrics(instanceId)
        if (!metrics) {
          return res.status(404).json({ ok: false, error: { code: 'METRICS_NOT_FOUND', message: 'Metrics not found for instance' } })
        }
        return res.json({ ok: true, data: metrics })
      } catch (error) {
        logger.error(`metrics instance failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_INSTANCE_FAILED', message: 'Failed to load approval metrics' } })
      }
    },
  )

  return r
}

export { ApprovalMetricsService }
export function __getPoolForTesting() {
  return pool
}
