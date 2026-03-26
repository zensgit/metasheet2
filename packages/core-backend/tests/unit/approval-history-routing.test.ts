import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({
  user: {
    sub: 'user-1',
    userId: 'user-1',
    tenantId: 'tenant-a',
  } as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    req.user = authState.user as never
    next()
  },
}))

import { approvalHistoryRouter } from '../../src/routes/approval-history'
import { approvalsRouter } from '../../src/routes/approvals'

describe('approval history routing', () => {
  const app = express()
  app.use(express.json())
  app.use(approvalsRouter())
  app.use(approvalHistoryRouter())

  beforeEach(() => {
    authState.user = {
      sub: 'user-1',
      userId: 'user-1',
      tenantId: 'tenant-a',
    }
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
  })

  it('uses the canonical paginated approval history handler at the mounted route', async () => {
    pgState.pool.query
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            occurred_at: '2026-03-26T10:00:00.000Z',
            actor_id: 'user-2',
            action: 'approve',
            comment: 'lgtm',
            from_status: 'pending',
            to_status: 'approved',
            version: 2,
          },
        ],
      })

    const response = await request(app).get('/api/approvals/inst-1/history?page=2&pageSize=1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: {
        items: [
          {
            occurred_at: '2026-03-26T10:00:00.000Z',
            actor_id: 'user-2',
            action: 'approve',
            comment: 'lgtm',
            from_status: 'pending',
            to_status: 'approved',
            version: 2,
          },
        ],
        page: 2,
        pageSize: 1,
        total: 2,
      },
    })
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      1,
      'SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1',
      ['inst-1'],
    )
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('LIMIT $2 OFFSET $3'),
      ['inst-1', 1, 1],
    )
  })

  it('requires authentication for approval history', async () => {
    authState.user = null

    const response = await request(app).get('/api/approvals/inst-1/history')

    expect(response.status).toBe(401)
    expect(pgState.pool.query).not.toHaveBeenCalled()
  })
})
