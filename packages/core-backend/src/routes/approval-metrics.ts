/**
 * Wave 2 WP5 slice 1 — approval metrics / SLA routes.
 *
 * Summary and breach endpoints are admin-only; per-instance metrics gate on Lock-10 (S1)'s unified
 * `canReadApprovalInstance` predicate (replaces the C-2 inline ACL — see the route handler for the
 * exact widen/narrow deltas). The metrics row is keyed by instance_id and inherits the instance's
 * own admission decision, not a separate ACL.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { Logger } from '../core/logger'
import { pool } from '../db/pg'
import { canReadApprovalInstance } from '../services/approval-instance-readability'
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

// RETIRED (Lock-10 S1, §5.3): `isAdminActor` was a JWT-claims admin check
// (`req.user.role === 'admin'`, `roles` claim, or the `*:*` permission claim) with exactly one
// call site, immediately below. `canReadApprovalInstance`'s admin arm (OD-S1-8) replaces it with a
// DB-backed check (`users.is_active AND (is_admin OR role='admin')`) — a JWT-only admin claim with
// no matching `users` row no longer bypasses the per-instance check (OD-S1-17(a): "roles derived
// from the DB, never from token claims", generalized here to the admin arm the lock itself names
// as the same trust-model question).

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

function parseLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '10'), 10)
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 10, 50))
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

  r.get('/api/approvals/metrics/report',
    authenticate,
    rbacGuard('approvals:admin'),
    async (req: Request, res: Response) => {
      try {
        const report = await metricsService.getMetricsReport({
          tenantId: resolveTenantId(req),
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
          limit: parseLimit(req.query.limit),
        })
        return res.json({ ok: true, data: report })
      } catch (error) {
        logger.error(`metrics report failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_REPORT_FAILED', message: 'Failed to load approval metrics report' } })
      }
    },
  )

  // T2-3 person/team analytics — read-only. Aggregates the same metrics rows by the requester
  // (people) / the requester's frozen department (teams). PERSON-level analytics is a who-is-slowest
  // performance ranking, so it is gated behind a SEPARATE `approvals:analytics` permission (Q4 review)
  // — an HR/ops-analytics lens, NOT default approval-administration. Team aggregation (/teams below)
  // stays on `approvals:admin` (lower sensitivity).
  r.get('/api/approvals/metrics/people',
    authenticate,
    rbacGuard('approvals:analytics'),
    async (req: Request, res: Response) => {
      try {
        const data = await metricsService.getMetricsByRequester({
          tenantId: resolveTenantId(req),
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
          limit: parseLimit(req.query.limit),
        })
        return res.json({ ok: true, data })
      } catch (error) {
        logger.error(`metrics people failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_PEOPLE_FAILED', message: 'Failed to load approval metrics by person' } })
      }
    },
  )

  r.get('/api/approvals/metrics/teams',
    authenticate,
    rbacGuard('approvals:admin'),
    async (req: Request, res: Response) => {
      try {
        const data = await metricsService.getMetricsByDepartment({
          tenantId: resolveTenantId(req),
          since: parseDate(req.query.since),
          until: parseDate(req.query.until),
          limit: parseLimit(req.query.limit),
        })
        return res.json({ ok: true, data })
      } catch (error) {
        logger.error(`metrics teams failed: ${error instanceof Error ? error.message : String(error)}`)
        return res.status(500).json({ ok: false, error: { code: 'METRICS_TEAMS_FAILED', message: 'Failed to load approval metrics by team' } })
      }
    },
  )

  r.get('/api/approvals/metrics/breaches',
    authenticate,
    rbacGuard('approvals:admin'),
    async (req: Request, res: Response) => {
      try {
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
        // Lock-10 (S1) OD-S1-7/OD-S1-1 — canReadApprovalInstance replaces the inline ACL (C-2,
        // §5.3). WIDENS vs. the deleted inline SQL by admitting CC targets (OD-S1-7, CONFIRMED
        // §5.1.1 — absent from the old query). NARROWS three ways: the admin arm is DB-backed
        // (OD-S1-8, not the deleted `isAdminActor` JWT claim), roles are DB-backed (OD-S1-17(a) —
        // a JWT-only role claim with no `user_roles`/`users.role` row no longer matches a
        // role-typed seat), and the org pin is now part of the predicate (currently dormant by
        // default — see the predicate module's docblock). The 403 CODE/SHAPE is UNCHANGED
        // (OD-S1-11: metrics keeps 403 FORBIDDEN; only detail/history switch to 404).
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
        const readable = await canReadApprovalInstance(pool, actorId, instanceId)
        if (!readable) {
          return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not a participant of this approval' } })
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
