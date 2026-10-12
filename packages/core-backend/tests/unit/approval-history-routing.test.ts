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
            // Test report 2026-10-08 T4cd: camelCase copies of the five DTO fields, beside the
            // unchanged snake_case columns above.
            actorId: 'user-2',
            actorName: 'Reviewer Two',
            occurredAt: '2026-03-26T10:00:00.000Z',
            fromStatus: 'pending',
            toStatus: 'approved',
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

  // Test report 2026-10-08 T4cd. The approval-centre detail page reads `occurredAt` / `actorName` /
  // `actorId` / `fromStatus` / `toStatus`; the platform branch used to send only the snake_case
  // columns, so every row rendered no time and 「系统」 as its actor. The real driver hands
  // `occurred_at` over as a Date — this pins the ISO conversion, the null handling, and that no
  // snake_case field moves.
  it('T4cd: platform rows carry camelCase copies (ISO occurredAt from a driver Date) beside the unchanged snake_case fields', async () => {
    pgState.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ c: 3 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'rec-created',
            occurred_at: new Date('2026-10-08T01:02:03.456Z'),
            actor_id: 'user-requester',
            actor_name: 'Requester Name',
            action: 'created',
            comment: null,
            from_status: null,
            to_status: 'pending',
            version: 1,
            from_version: null,
            to_version: 1,
          },
          {
            id: 'rec-cc',
            occurred_at: new Date('2026-10-08T01:02:03.456Z'),
            actor_id: 'system',
            actor_name: 'System',
            action: 'cc',
            comment: null,
            from_status: 'pending',
            to_status: 'pending',
            version: 1,
            from_version: 1,
            to_version: 1,
          },
          {
            id: 'rec-odd',
            occurred_at: 'not-a-timestamp',
            actor_id: null,
            actor_name: null,
            action: 'comment',
            comment: 'x',
            from_status: null,
            to_status: null,
            version: 1,
            from_version: null,
            to_version: null,
          },
        ],
      })

    const response = await request(pinned.url()).get('/api/approvals/inst-1/history')

    expect(response.status).toBe(200)
    const [created, cc, odd] = response.body.data.items as Array<Record<string, unknown>>
    expect(created).toMatchObject({
      occurred_at: '2026-10-08T01:02:03.456Z',
      actor_id: 'user-requester',
      actor_name: 'Requester Name',
      from_status: null,
      to_status: 'pending',
      occurredAt: '2026-10-08T01:02:03.456Z',
      actorId: 'user-requester',
      actorName: 'Requester Name',
      fromStatus: null,
      toStatus: 'pending',
    })
    // The engine's own actor arrives as stored; turning it into 「系统」 is the client's job.
    expect(cc).toMatchObject({ actorId: 'system', actorName: 'System', fromStatus: 'pending', toStatus: 'pending' })
    // A value that is not a valid timestamp is null, never "Invalid Date"; null columns stay null.
    expect(odd).toMatchObject({ occurredAt: null, actorId: null, actorName: null, fromStatus: null, toStatus: null })
    expect(odd.occurred_at).toBe('not-a-timestamp')
    // No metadata key appears for rows that carry none of the whitelisted values.
    for (const item of [created, cc, odd]) {
      expect(Object.prototype.hasOwnProperty.call(item, 'metadata')).toBe(false)
    }
  })

  // Test report 2026-10-08 T4cd (node half) — `nodeKey` and `autoApproved` join the metadata whitelist
  // as single-key projections (owner ruling 2026-09-20: whitelist business fields, never the whole
  // metadata). The SELECT reads only those two key paths, and the map rebuilds each value: a
  // non-empty string node key, and `autoApproved` only when it is the boolean true.
  it('T4cd: projects nodeKey (non-empty string only) and autoApproved (boolean true only) as single metadata keys, never the raw aliases', async () => {
    pgState.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ c: 5 }] })
      .mockResolvedValueOnce({
        rows: [
          { id: 'r-human', action: 'approve', actor_id: 'u1', history_node_key_raw: 'approval_1', history_auto_approved_raw: null },
          { id: 'r-auto', action: 'approve', actor_id: 'system:auto-approval', history_node_key_raw: ' approval_2 ', history_auto_approved_raw: true },
          { id: 'r-odd-auto', action: 'approve', actor_id: 'u2', history_node_key_raw: 'approval_3', history_auto_approved_raw: 'true' },
          { id: 'r-odd-key', action: 'comment', actor_id: 'u3', history_node_key_raw: 42, history_auto_approved_raw: false },
          { id: 'r-blank-key', action: 'comment', actor_id: 'u4', history_node_key_raw: '   ', history_auto_approved_raw: 1 },
        ],
      })

    const response = await request(pinned.url()).get('/api/approvals/inst-1/history')

    expect(response.status).toBe(200)
    const items = response.body.data.items as Array<Record<string, unknown>>
    const byId = new Map(items.map((item) => [item.id, item]))
    expect(byId.get('r-human')?.metadata).toEqual({ nodeKey: 'approval_1' })
    expect(byId.get('r-auto')?.metadata).toEqual({ nodeKey: 'approval_2', autoApproved: true })
    // Only the boolean true crosses; a string 'true' or a number is dropped.
    expect(byId.get('r-odd-auto')?.metadata).toEqual({ nodeKey: 'approval_3' })
    // A non-string or blank node key is dropped; with nothing left, no metadata key at all.
    expect(Object.prototype.hasOwnProperty.call(byId.get('r-odd-key'), 'metadata')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(byId.get('r-blank-key'), 'metadata')).toBe(false)
    // The internal aliases never reach the wire.
    for (const item of items) {
      expect(Object.keys(item).filter((key) => key.endsWith('_raw'))).toEqual([])
    }
    // The page query reads exactly the two new key paths, never the whole metadata column.
    const pageSql = String(pgState.pool.query.mock.calls[4][0])
    expect(pageSql).toContain("metadata->'nodeKey' AS history_node_key_raw")
    expect(pageSql).toContain("metadata->'autoApproved' AS history_auto_approved_raw")
    expect(pageSql).not.toMatch(/,\s*metadata\s*,/)
    expect(pageSql).not.toMatch(/\bmetadata\s+FROM\b/)
  })

  it('requires authentication for approval history', async () => {
    authState.user = null

    const response = await request(pinned.url()).get('/api/approvals/inst-1/history')

    expect(response.status).toBe(401)
    expect(pgState.pool.query).not.toHaveBeenCalled()
  })
})
