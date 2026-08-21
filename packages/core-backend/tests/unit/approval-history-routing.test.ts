import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authState = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    sub: 'user-1',
    userId: 'user-1',
    tenantId: 'tenant-a',
    // Guard alignment: the route now sits behind rbacGuard('approvals', 'read')
    // (matching GET /api/approvals/:id), so the fixture needs a principal that
    // satisfies it — the admin-role short-circuit needs no RBAC table rows.
    roles: ['admin'],
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
  const pinned = usePinnedServer()

  beforeEach(() => {
    pinned.setApp(app)
    authState.user = {
      id: 'user-1',
      sub: 'user-1',
      userId: 'user-1',
      tenantId: 'tenant-a',
      roles: ['admin'],
    }
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
  })

  it('uses the canonical paginated approval history handler at the mounted route', async () => {
    pgState.pool.query
      // Lock-10 (S1): canReadApprovalInstance runs BEFORE the history query, and its own
      // implementation issues three queries when the org pin is off (default) — two inside
      // viewerRoles (users.role, then user_roles ⋈ roles), then the admission SELECT itself.
      // The first two contents are irrelevant here; the third must return a matching row so the
      // fixture's admin-role principal is admitted (matches the pre-S1 200 this test asserts).
      .mockResolvedValueOnce({ rows: [] }) // viewerRoles: users.role
      .mockResolvedValueOnce({ rows: [] }) // viewerRoles: user_roles ⋈ roles
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // canReadApprovalInstance admission SELECT
      .mockResolvedValueOnce({ rows: [{ c: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'rec-1',
            occurred_at: '2026-03-26T10:00:00.000Z',
            actor_id: 'user-2',
            actor_name: 'Reviewer Two',
            action: 'approve',
            comment: 'lgtm',
            from_status: 'pending',
            to_status: 'approved',
            version: 2,
            from_version: 1,
            to_version: 2,
          },
        ],
      })

    const response = await request(pinned.url()).get('/api/approvals/inst-1/history?page=2&pageSize=1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: 'rec-1',
            occurred_at: '2026-03-26T10:00:00.000Z',
            actor_id: 'user-2',
            actor_name: 'Reviewer Two',
            action: 'approve',
            comment: 'lgtm',
            from_status: 'pending',
            to_status: 'approved',
            version: 2,
            from_version: 1,
            to_version: 2,
          },
        ],
        page: 2,
        pageSize: 1,
        total: 2,
      },
    })
    // Lock-5 gate D-3 (approval-lock5-node-operation-policy-20260817.md §1.4 fact 2): BOTH the
    // count and the page query now exclude the `action:'policy_denied'` audit row a refused member
    // operation writes. They must exclude it with the SAME predicate — a count that still counts
    // denials would silently shift `total` and the page boundaries — so both parameter lists are
    // pinned here, and the real-DB suite proves the behavioural half end to end.
    // Lock-10 (S1): canReadApprovalInstance's three admission-phase queries (mocked above) are
    // Nth 1-3, so the pre-existing count/page queries this block pins shift from Nth 1/2 to Nth 4/5.
    // Lock-10 (S2) HISTORY-TIMELINE arm (i) — both the count and page query add the
    // `metadata->>'commentId' IS NULL` conjunct, binding NO parameter, so the parameter arrays
    // pinned below stay unchanged from S1.
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      4,
      "SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1 AND action <> $2 AND metadata->>'commentId' IS NULL",
      ['inst-1', 'policy_denied'],
    )
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('COALESCE(to_version, version) AS version'),
      ['inst-1', 1, 1, 'policy_denied'],
    )
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('AND action <> $4'),
      ['inst-1', 1, 1, 'policy_denied'],
    )
    // Lock-10 (S2) static pin — a future removal of the exclusion from either query reds here,
    // even though the `stringContaining` checks above would still pass against the SAME literal.
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("metadata->>'commentId' IS NULL"),
      ['inst-1', 'policy_denied'],
    )
    expect(pgState.pool.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("metadata->>'commentId' IS NULL"),
      ['inst-1', 1, 1, 'policy_denied'],
    )
  })

  it('requires authentication for approval history', async () => {
    authState.user = null

    const response = await request(pinned.url()).get('/api/approvals/inst-1/history')

    expect(response.status).toBe(401)
    expect(pgState.pool.query).not.toHaveBeenCalled()
  })
})
