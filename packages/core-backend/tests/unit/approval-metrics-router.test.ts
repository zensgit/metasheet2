import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApprovalMetricsService as ApprovalMetricsServiceType } from '../../src/services/ApprovalMetricsService'

const authState = vi.hoisted(() => ({
  user: {
    id: 'admin-1',
    tenantId: 'tenant-a',
    permissions: ['*:*'],
  } as Record<string, unknown> | null,
  allowRbac: true,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: Request, res: Response, next: NextFunction) => {
    if (!authState.allowRbac) {
      res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } })
      return
    }
    next()
  },
}))

function buildService() {
  return {
    getMetricsReport: vi.fn().mockResolvedValue({
      summary: {
        total: 1,
        approved: 1,
        rejected: 0,
        revoked: 0,
        returned: 0,
        running: 0,
        avgDurationSeconds: 120,
        p50DurationSeconds: 120,
        p95DurationSeconds: 120,
        slaBreachCount: 1,
        slaCandidateCount: 1,
        slaBreachRate: 1,
        byTemplate: [],
      },
      slowestInstances: [],
      breachedTemplates: [],
    }),
  }
}

describe('approval metrics report route', () => {
  let service: ReturnType<typeof buildService>
  let app: express.Express

  beforeEach(async () => {
    vi.resetModules()
    authState.user = {
      id: 'admin-1',
      tenantId: 'tenant-a',
      permissions: ['*:*'],
    }
    authState.allowRbac = true
    service = buildService()
    const { approvalMetricsRouter } = await import('../../src/routes/approval-metrics')
    app = express()
    app.use(express.json())
    app.use(approvalMetricsRouter({ metricsService: service as unknown as ApprovalMetricsServiceType }))
  })

  it('returns a TopN report and clamps limit/date query parameters', async () => {
    const response = await request(app)
      .get('/api/approvals/metrics/report')
      .query({
        since: '2026-04-01T00:00:00Z',
        until: '2026-04-25T23:59:59Z',
        limit: '999',
      })

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(service.getMetricsReport).toHaveBeenCalledTimes(1)
    expect(service.getMetricsReport).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      since: new Date('2026-04-01T00:00:00Z'),
      until: new Date('2026-04-25T23:59:59Z'),
      limit: 50,
    })
  })

  it('falls back to default tenant and default limit for invalid query values', async () => {
    authState.user = { id: 'admin-1', permissions: ['*:*'] }

    await request(app)
      .get('/api/approvals/metrics/report')
      .query({ since: 'not-a-date', until: '', limit: 'not-a-number' })
      .expect(200)

    expect(service.getMetricsReport).toHaveBeenCalledWith({
      tenantId: 'default',
      since: undefined,
      until: undefined,
      limit: 10,
    })
  })

  it('preserves auth and RBAC gates', async () => {
    authState.user = null
    await request(app).get('/api/approvals/metrics/report').expect(401)

    authState.user = { id: 'viewer-1', tenantId: 'tenant-a' }
    authState.allowRbac = false
    await request(app).get('/api/approvals/metrics/report').expect(403)

    expect(service.getMetricsReport).not.toHaveBeenCalled()
  })

  it('returns a stable 500 error payload when the service fails', async () => {
    service.getMetricsReport.mockRejectedValueOnce(new Error('db down'))

    const response = await request(app).get('/api/approvals/metrics/report')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'METRICS_REPORT_FAILED',
        message: 'Failed to load approval metrics report',
      },
    })
  })
})
