import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auditRouteMocks = vi.hoisted(() => ({
  query: vi.fn(),
  db: {
    selectFrom: vi.fn(),
    updateTable: vi.fn(),
    insertInto: vi.fn(),
    deleteFrom: vi.fn(),
    transaction: vi.fn(),
  },
}))

vi.mock('../../src/db/db', () => ({
  db: auditRouteMocks.db,
}))

vi.mock('../../src/db/pg', () => ({
  pool: {},
  query: auditRouteMocks.query,
}))

vi.mock('../../src/audit/audit', () => ({
  auditLog: vi.fn(async () => undefined),
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'dev-user',
      tenantId: 'tenant-a',
    } as never
    next()
  },
}))

vi.mock('../../src/middleware/validation', () => ({
  validate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/types/validator', () => ({
  loadValidators: () => {
    const makeChain = () => {
      const chain = ((
        _req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => next()) as express.RequestHandler & Record<string, () => express.RequestHandler>

      chain.optional = () => chain
      chain.isString = () => chain
      chain.notEmpty = () => chain
      chain.exists = () => chain
      chain.isObject = () => chain
      return chain
    }

    return {
      body: () => makeChain(),
      param: () => makeChain(),
      query: () => makeChain(),
    }
  },
}))

import plmWorkbenchRouter from '../../src/routes/plm-workbench'

describe('plm-workbench audit routes', () => {
  const app = express()
  app.use(express.json())
  app.use(plmWorkbenchRouter)

  beforeEach(() => {
    auditRouteMocks.query.mockReset()
  })

  it('lists collaborative batch audit logs with normalized metadata', async () => {
    auditRouteMocks.query
      .mockResolvedValueOnce({
        rows: [{ c: 2 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-1',
            actor_id: 'owner-1',
            actor_type: 'user',
            action: 'archive',
            resource_type: 'plm-team-preset-batch',
            resource_id: 'preset-a',
            request_id: 'req-1',
            ip: '127.0.0.1',
            user_agent: 'Vitest',
            occurred_at: '2026-03-11T02:00:00.000Z',
            meta: {
              processedKinds: ['bom'],
              processedTotal: 1,
              skippedTotal: 0,
            },
          },
        ],
      })

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs?page=1&pageSize=20&resourceType=plm-team-preset-batch&action=archive&q=bom')

    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({
      total: 2,
      page: 1,
      pageSize: 20,
      items: [
        {
          id: 'audit-1',
          action: 'archive',
          resourceType: 'plm-team-preset-batch',
          resourceId: 'preset-a',
          actorId: 'owner-1',
          meta: {
            processedKinds: ['bom'],
            processedTotal: 1,
          },
        },
      ],
    })
    expect(auditRouteMocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT COUNT(*)::int AS c'),
      expect.arrayContaining([
        expect.arrayContaining(['plm-team-preset-batch', 'plm-team-view-batch', 'plm-team-view-default']),
        'plm-team-preset-batch',
        'archive',
        '%bom%',
      ]),
    )
  })

  it('summarizes collaborative batch audit activity', async () => {
    auditRouteMocks.query
      .mockResolvedValueOnce({
        rows: [
          { action: 'archive', total: 3 },
          { action: 'restore', total: 1 },
          { action: 'set-default', total: 2 },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { resource_type: 'plm-team-view-batch', total: 2 },
          { resource_type: 'plm-team-preset-batch', total: 2 },
          { resource_type: 'plm-team-view-default', total: 1 },
        ],
      })

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs/summary?windowMinutes=120&limit=5')

    expect(response.status).toBe(200)
    expect(response.body.data).toEqual({
      windowMinutes: 120,
      actions: [
        { action: 'archive', total: 3 },
        { action: 'restore', total: 1 },
        { action: 'set-default', total: 2 },
      ],
      resourceTypes: [
        { resourceType: 'plm-team-view-batch', total: 2 },
        { resourceType: 'plm-team-preset-batch', total: 2 },
        { resourceType: 'plm-team-view-default', total: 1 },
      ],
    })
    expect(auditRouteMocks.query).toHaveBeenCalledTimes(2)
  })

  it('exports collaborative batch audit logs as csv', async () => {
    auditRouteMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-2',
          actor_id: 'owner-1',
          actor_type: 'user',
          action: 'delete',
          resource_type: 'plm-team-view-batch',
          resource_id: 'view-a',
          request_id: 'req-2',
          ip: '127.0.0.1',
          user_agent: 'Vitest',
          route: '/api/plm-workbench/views/team/batch',
          status_code: 200,
          latency_ms: 0,
          occurred_at: '2026-03-11T02:01:00.000Z',
          meta: {
            processedKinds: ['documents'],
            requestedTotal: 1,
            processedTotal: 1,
            skippedTotal: 0,
          },
        },
      ],
    })

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs/export.csv?resourceType=plm-team-view-batch&action=delete&kind=documents&limit=10')

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['content-disposition']).toContain('plm-collaborative-audit-')
    expect(response.text).toContain('occurredAt,id,actorId,actorType,action,resourceType')
    expect(response.text).toContain('plm-team-view-batch')
    expect(response.text).toContain('documents')
    expect(auditRouteMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM operation_audit_logs'),
      expect.arrayContaining([
        expect.arrayContaining(['plm-team-preset-batch', 'plm-team-view-batch', 'plm-team-view-default']),
        'plm-team-view-batch',
        'delete',
        '%documents%',
        10,
      ]),
    )
  })

  it('lists and exports default-scene audit activity', async () => {
    auditRouteMocks.query
      .mockResolvedValueOnce({
        rows: [{ c: 1 }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'audit-default-1',
            actor_id: 'owner-1',
            actor_type: 'user',
            action: 'set-default',
            resource_type: 'plm-team-view-default',
            resource_id: 'scene-1',
            request_id: 'req-1',
            ip: '127.0.0.1',
            user_agent: 'Vitest',
            occurred_at: '2026-03-13T02:00:00.000Z',
            meta: {
              kind: 'workbench',
              viewName: '采购团队场景',
              processedKinds: ['workbench'],
              processedTotal: 1,
            },
          },
        ],
      })

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs?page=1&pageSize=20&resourceType=plm-team-view-default&action=set-default&kind=workbench')

    expect(response.status).toBe(200)
    expect(response.body.data.items[0]).toMatchObject({
      action: 'set-default',
      resourceType: 'plm-team-view-default',
      meta: {
        kind: 'workbench',
        viewName: '采购团队场景',
      },
    })

    auditRouteMocks.query.mockReset()
    auditRouteMocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'audit-default-1',
          actor_id: 'owner-1',
          actor_type: 'user',
          action: 'set-default',
          resource_type: 'plm-team-view-default',
          resource_id: 'scene-1',
          request_id: 'req-1',
          ip: '127.0.0.1',
          user_agent: 'Vitest',
          route: '/api/plm-workbench/views/team/:id/default',
          status_code: 200,
          latency_ms: 0,
          occurred_at: '2026-03-13T02:00:00.000Z',
          meta: {
            kind: 'workbench',
            viewName: '采购团队场景',
            processedKinds: ['workbench'],
            processedTotal: 1,
          },
        },
      ],
    })

    const exportResponse = await request(app)
      .get('/api/plm-workbench/audit-logs/export.csv?resourceType=plm-team-view-default&action=set-default&kind=workbench&limit=10')

    expect(exportResponse.status).toBe(200)
    expect(exportResponse.text).toContain('plm-team-view-default')
    expect(exportResponse.text).toContain('采购团队场景')
  })

  it('returns direct string error envelopes for audit log failures', async () => {
    auditRouteMocks.query.mockRejectedValueOnce(new Error('boom-list'))

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs?page=1&pageSize=20')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to load PLM collaborative audit logs',
    })
  })

  it('returns direct string error envelopes for audit summary failures', async () => {
    auditRouteMocks.query.mockRejectedValueOnce(new Error('boom-summary'))

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs/summary?windowMinutes=120&limit=5')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to load PLM collaborative audit summary',
    })
  })

  it('returns direct string error envelopes for audit csv export failures', async () => {
    auditRouteMocks.query.mockRejectedValueOnce(new Error('boom-export'))

    const response = await request(app)
      .get('/api/plm-workbench/audit-logs/export.csv?limit=10')

    expect(response.status).toBe(500)
    expect(response.body).toEqual({
      success: false,
      error: 'Failed to export PLM collaborative audit logs',
    })
  })
})
