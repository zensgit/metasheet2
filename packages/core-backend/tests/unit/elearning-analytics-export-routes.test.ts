import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createElearningAnalyticsRouter } from '../../src/routes/elearning-analytics'
import { ElearningAnalyticsExportError } from '../../src/services/elearning-analytics-export'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-export-route'
const ACTOR = 'actor-export-route'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const EXPORT = '22222222-2222-4222-8222-222222222222'
const DEPARTMENT = '33333333-3333-4333-8333-333333333333'
const START = '2026-08-01T00:00:00.000Z'
const END = '2026-09-01T00:00:00.000Z'
const FLAGS = { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'true' }
const pinned = usePinnedServer()

function exportDto(duplicate = false) {
  return {
    exportId: EXPORT,
    departmentId: DEPARTMENT,
    periodStart: START,
    periodEnd: END,
    status: 'pending' as const,
    expiresAt: '2026-09-07T00:00:00.000Z',
    completedAt: null,
    errorCode: null,
    duplicate,
  }
}

function harness(input: {
  actor?: string | null
  org?: string | null
  allow?: boolean
  error?: ElearningAnalyticsExportError
} = {}) {
  const createCalls: unknown[] = []
  const readCalls: unknown[] = []
  const downloadCalls: unknown[] = []
  let guardCalls = 0
  const db = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(run: (tx: unknown) => Promise<T>) => run(db),
  }
  const router = createElearningAnalyticsRouter({
    db,
    env: FLAGS,
    viewerId: () => input.actor === undefined ? ACTOR : input.actor,
    orgId: () => input.org === undefined ? ORG : input.org,
    isGlobalAdmin: () => true,
    statsGuard: (_req, res, next) => {
      guardCalls += 1
      if (input.allow === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    getElearningDepartmentStats: vi.fn(),
    getElearningDepartmentStatsDaily: vi.fn(),
    createElearningAnalyticsExport: async (_db, command) => {
      createCalls.push(command)
      if (input.error) throw input.error
      return exportDto(false)
    },
    getElearningAnalyticsExport: async (_db, command) => {
      readCalls.push(command)
      if (input.error) throw input.error
      return exportDto(false)
    },
    downloadElearningAnalyticsExport: async (_db, command) => {
      downloadCalls.push(command)
      if (input.error) throw input.error
      return {
        exportId: EXPORT,
        filename: `elearning-department-stats-${EXPORT}.csv`,
        contentType: 'text/csv; charset=utf-8',
        content: Buffer.from('aggregate-only', 'utf8'),
      }
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    api: request(pinned.url()),
    createCalls,
    readCalls,
    downloadCalls,
    guardCalls: () => guardCalls,
  }
}

describe('e-learning analytics export routes', () => {
  it('derives org/actor/global authority and accepts only a closed create body', async () => {
    const run = harness()
    const response = await run.api
      .post('/api/elearning/admin/analytics/exports')
      .send({
        requestId: REQUEST,
        departmentId: DEPARTMENT,
        periodStart: START,
        periodEnd: END,
      })
    expect(response.status).toBe(202)
    expect(response.body).toEqual(exportDto(false))
    expect(run.createCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      requestId: REQUEST,
      departmentId: DEPARTMENT,
      periodStart: START,
      periodEnd: END,
    }])
    const extra = await run.api
      .post('/api/elearning/admin/analytics/exports')
      .send({
        requestId: REQUEST,
        departmentId: DEPARTMENT,
        periodStart: START,
        periodEnd: END,
        orgId: 'attacker',
      })
    expect(extra.status).toBe(400)
    expect(run.createCalls).toHaveLength(1)
  })

  it('applies authentication and RBAC before export services', async () => {
    const anonymous = harness({ actor: null })
    expect((await anonymous.api.get(`/api/elearning/admin/analytics/exports/${EXPORT}`)).status)
      .toBe(401)
    expect(anonymous.guardCalls()).toBe(0)
    const denied = harness({ allow: false })
    expect((await denied.api.get(`/api/elearning/admin/analytics/exports/${EXPORT}`)).status)
      .toBe(403)
    expect(denied.readCalls).toHaveLength(0)
  })

  it('returns a closed detail and a CSV attachment without storage metadata', async () => {
    const run = harness()
    const detail = await run.api.get(`/api/elearning/admin/analytics/exports/${EXPORT}`)
    expect(detail.status).toBe(200)
    expect(detail.body).toEqual(exportDto(false))
    expect(detail.body).not.toHaveProperty('storageKey')
    expect(detail.body).not.toHaveProperty('fileSha256')
    const download = await run.api.get(
      `/api/elearning/admin/analytics/exports/${EXPORT}/download`,
    )
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toContain('text/csv')
    expect(download.headers['content-disposition']).toContain(EXPORT)
    expect(run.downloadCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      exportId: EXPORT,
    }])
  })

  it.each([
    ['conflict', 409],
    ['not_ready', 409],
    ['expired', 410],
    ['forbidden', 403],
    ['not_found', 404],
    ['unavailable', 503],
  ] as const)('maps values-free %s failures to %s', async (code, status) => {
    const response = await harness({ error: new ElearningAnalyticsExportError(code) }).api
      .get(`/api/elearning/admin/analytics/exports/${EXPORT}`)
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ error: code })
  })
})
