import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authState = vi.hoisted(() => ({
  user: {
    sub: 'user-1',
    userId: 'user-1',
    tenantId: 'tenant-a',
    name: 'Owner One',
  } as Record<string, unknown> | null,
}))

const pgState = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
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

import { approvalsRouter } from '../../src/routes/approvals'

describe('approvals routes', () => {
  const app = express()
  app.use(express.json())
  app.use(approvalsRouter())

  beforeEach(() => {
    authState.user = {
      sub: 'user-1',
      userId: 'user-1',
      tenantId: 'tenant-a',
      name: 'Owner One',
    }
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  it('requires version for approval actions', async () => {
    const response = await request(app)
      .post('/api/approvals/apr-1/approve')
      .send({ comment: 'looks good' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_VERSION_REQUIRED',
        message: 'Approval version is required',
      },
    })
    expect(pgState.pool.connect).not.toHaveBeenCalled()
  })

  it('returns a structured 401 when the token omits the approval actor id', async () => {
    authState.user = {
      tenantId: 'tenant-a',
      name: 'Owner One',
    }

    const response = await request(app)
      .post('/api/approvals/apr-1/approve')
      .send({ version: 0 })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_USER_REQUIRED',
        message: 'User ID not found in token',
      },
    })
  })

  it('returns a 409 conflict for stale approve versions', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'apr-1',
            status: 'pending',
            version: 3,
            created_at: new Date('2026-03-26T10:00:00.000Z'),
            updated_at: new Date('2026-03-26T10:05:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-1/approve')
      .send({ version: 2, comment: 'looks good' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_VERSION_CONFLICT',
        message: 'Approval instance version mismatch',
        currentVersion: 3,
      },
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('returns a structured 404 when the approval instance does not exist', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [],
      })
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-missing/approve')
      .send({ version: 0 })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_NOT_FOUND',
        message: 'Approval instance not found',
      },
    })
  })

  it('returns a structured validation error when approve hits a non-pending instance', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'apr-1',
            status: 'approved',
            version: 1,
            created_at: new Date('2026-03-26T10:00:00.000Z'),
            updated_at: new Date('2026-03-26T10:05:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-1/approve')
      .send({ version: 1 })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_STATUS_INVALID',
        message: 'Cannot approve: current status is approved',
      },
    })
  })

  it('returns the optimistic-lock success envelope for approve', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'apr-1',
            status: 'pending',
            version: 0,
            created_at: new Date('2026-03-26T10:00:00.000Z'),
            updated_at: new Date('2026-03-26T10:05:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-1/approve')
      .send({ version: 0, comment: 'looks good' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: {
        id: 'apr-1',
        status: 'approved',
        version: 1,
        prevVersion: 0,
      },
    })
    expect(pgState.client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("SET status = 'approved'"),
      [1, 'apr-1'],
    )
  })

  it('returns a 409 conflict for stale reject versions', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'apr-1',
            status: 'pending',
            version: 5,
            created_at: new Date('2026-03-26T10:00:00.000Z'),
            updated_at: new Date('2026-03-26T10:05:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-1/reject')
      .send({ version: 4, reason: 'missing evidence' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_VERSION_CONFLICT',
        message: 'Approval instance version mismatch',
        currentVersion: 5,
      },
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('accepts comment as the reject reason fallback and returns the success envelope', async () => {
    pgState.client.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'apr-1',
            status: 'pending',
            version: 4,
            created_at: new Date('2026-03-26T10:00:00.000Z'),
            updated_at: new Date('2026-03-26T10:05:00.000Z'),
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    const response = await request(app)
      .post('/api/approvals/apr-1/reject')
      .send({ version: 4, comment: 'needs changes' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: {
        id: 'apr-1',
        status: 'rejected',
        version: 5,
        prevVersion: 4,
      },
    })
    expect(pgState.client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("VALUES ($1, 'reject'"),
      [
        'apr-1',
        'user-1',
        'Owner One',
        'needs changes',
        'needs changes',
        'pending',
        4,
        5,
        '{}',
        expect.stringContaining('127.0.0.1'),
        null,
      ],
    )
  })

  it('returns a structured validation error when reject omits the reason', async () => {
    const response = await request(app)
      .post('/api/approvals/apr-1/reject')
      .send({ version: 4, comment: '   ' })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_REJECTION_REASON_REQUIRED',
        message: 'Rejection reason is required',
      },
    })
  })
})
