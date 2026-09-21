import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authState = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    tenantId: 'tenant-a',
    name: 'Owner One',
    permissions: ['*:*'],
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

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  rbacGuardAny: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

const pinned = usePinnedServer()

describe('approvals routes', () => {
  let app: Express

  beforeEach(async () => {
    vi.resetModules()
    authState.user = {
      id: 'user-1',
      tenantId: 'tenant-a',
      name: 'Owner One',
      permissions: ['*:*'],
    }
    pgState.pool.query.mockReset()
    pgState.pool.connect.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    pgState.pool.connect.mockResolvedValue(pgState.client)

    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
  })

  it('requires version for approval actions', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url())
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
      permissions: ['*:*'],
    }

    pinned.setApp(app)
    const response = await request(pinned.url())
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

  it('returns a structured 401 when pending approvals cannot resolve the actor id', async () => {
    authState.user = {
      tenantId: 'tenant-a',
      name: 'Owner One',
      permissions: ['*:*'],
    }

    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals/pending')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_USER_REQUIRED',
        message: 'User ID not found in token',
      },
    })
  })

  it('accepts req.user.id when loading pending approvals', async () => {
    authState.user = {
      id: 'user-1',
      tenantId: 'tenant-a',
      name: 'Owner One',
      permissions: ['*:*'],
    }
    // P0-A (A9): the pending list now resolves the caller's DB-derived roles before it builds its
    // SQL, so `viewerRoles`'s TWO lookups (`users`, then `user_roles LEFT JOIN roles`) are the
    // first two `pool.query` calls this handler makes. These `mockResolvedValueOnce`s are ordered,
    // so without these two the page/count fixtures below would be consumed by the role lookups and
    // the page query would fall through to the empty default. Both answer EMPTY, which is the
    // honest shape here: this file's mocked identity has no `users` row and no `user_roles` rows.
    pgState.pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
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
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
      })

    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals/pending')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      data: [
        expect.objectContaining({
          id: 'apr-1',
          status: 'pending',
          version: 0,
        }),
      ],
      total: 1,
      limit: 50,
      offset: 0,
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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

  it('returns a structured 404 when fetching a missing approval instance', async () => {
    pgState.pool.query.mockResolvedValueOnce({
      rows: [],
    })

    pinned.setApp(app)
    const response = await request(pinned.url()).get('/api/approvals/apr-missing')

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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

    pinned.setApp(app)
    const response = await request(pinned.url())
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

  /**
   * H-5 P2-2 — THE OPTIMISTIC-LOCK PRECONDITION, on the half of the route that hands its lock back.
   *
   * A seat-gated (template-runtime) instance is settled by `ApprovalProductService.dispatchAction`,
   * which re-locks the instance row on a SECOND connection. This route must therefore ROLLBACK and
   * release its own `FOR UPDATE` lock BEFORE calling it (holding it is a deterministic
   * self-deadlock), which leaves a window in which another decision can land. Without the
   * `expectedVersion` rider the caller's `version` would be advisory — validated against a snapshot
   * that is no longer the one the write lands on.
   *
   * This case CONSTRUCTS that window deterministically instead of racing for it: the mocked client
   * answers the route's own `SELECT ... FOR UPDATE` with version 4 (so every precondition this
   * route checks passes) and the settlement transaction's `SELECT ... FOR UPDATE` — a separate
   * statement, on the connection `dispatchAction` takes for itself — with version 5. That is
   * exactly the state a concurrent decision leaves behind, with none of the timing.
   *
   * Two claims are pinned here, and they are different claims:
   *   1. the settlement REFUSES rather than applying this caller's decision to a state they never
   *      read (drop the `expectedVersion` check and this call becomes a settlement attempt);
   *   2. the refusal is rendered in the SAME 409 envelope this endpoint has always published for a
   *      version conflict — `error.currentVersion`, no `error.details` — so the endpoint does not
   *      acquire two shapes for one code depending on which of the two checks fired.
   */
  it('re-checks the caller version INSIDE the shared settlement path and answers in the one published 409 envelope', async () => {
    let instanceReads = 0
    pgState.client.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql).replace(/\s+/g, ' ').trim()
      if (statement === 'BEGIN' || statement === 'ROLLBACK' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances')) {
        instanceReads += 1
        return {
          rows: [
            {
              id: 'apr-seat-1',
              status: 'pending',
              // THE WINDOW: read 1 is this route's own pre-check (its lock is then handed back);
              // read 2 is the settlement transaction's own locked read.
              version: instanceReads === 1 ? 4 : 5,
              source_system: 'platform',
              published_definition_id: 'pubdef-1',
              current_node_key: 'approval_a',
              metadata: null,
              created_at: new Date('2026-03-26T10:00:00.000Z'),
              updated_at: new Date('2026-03-26T10:05:00.000Z'),
            },
          ],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT node_key, is_active, assignment_type, assignee_id')) {
        return {
          rows: [
            { node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: 'user-1' },
          ],
          rowCount: 1,
        }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/apr-seat-1/approve')
      .send({ version: 4, comment: 'looks good' })

    // Both locked reads happened: the route's own, and the settlement's. Without the second there
    // would be nothing to re-check against.
    expect(instanceReads).toBe(2)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_VERSION_CONFLICT',
        message: 'Approval instance version mismatch',
        currentVersion: 5,
      },
    })
    // The refusal happened BEFORE any write: no UPDATE and no audit INSERT was ever issued on
    // either connection. (`.not.` alone would pass on a route that never ran, so it sits next to
    // the `instanceReads === 2` assertion above, which proves it did.)
    const statements = pgState.client.query.mock.calls.map(([sql]: [unknown]) => String(sql))
    expect(statements.some((statement) => statement.includes('UPDATE approval_instances'))).toBe(false)
    expect(statements.some((statement) => statement.includes('INSERT INTO approval_records'))).toBe(false)
  })

  /**
   * POSITIVE CONTROL for the case above: the SAME fixture with the settlement's locked read
   * agreeing with the caller is NOT refused — it proceeds past the precondition into the runtime
   * lookup (which this mock deliberately does not serve, so the call ends as a 500 rather than a
   * 409). The discriminator is the CODE, not the bare status: `APPROVAL_VERSION_CONFLICT` must be
   * gone. Without this control, a route that refused every seat-gated call for some unrelated
   * reason would pass the case above.
   */
  it('does NOT raise a version conflict inside the settlement path when the caller version is current', async () => {
    pgState.client.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql).replace(/\s+/g, ' ').trim()
      if (statement === 'BEGIN' || statement === 'ROLLBACK' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances')) {
        return {
          rows: [
            {
              id: 'apr-seat-1',
              status: 'pending',
              version: 4,
              source_system: 'platform',
              published_definition_id: 'pubdef-1',
              current_node_key: 'approval_a',
              metadata: null,
              created_at: new Date('2026-03-26T10:00:00.000Z'),
              updated_at: new Date('2026-03-26T10:05:00.000Z'),
            },
          ],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT node_key, is_active, assignment_type, assignee_id')) {
        return {
          rows: [
            { node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: 'user-1' },
          ],
          rowCount: 1,
        }
      }
      // The published definition the settlement needs next. Absent ⇒ the settlement raises its own
      // 404 `APPROVAL_PUBLISHED_DEFINITION_NOT_FOUND`, which is the point: the version gate let it
      // through and something LATER refused.
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/apr-seat-1/approve')
      .send({ version: 4, comment: 'looks good' })

    expect(response.body?.error?.code).not.toBe('APPROVAL_VERSION_CONFLICT')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_PUBLISHED_DEFINITION_NOT_FOUND',
        message: 'Published definition not found',
      },
    })
  })

  /**
   * H-5 P3-C — THE SAME PRECONDITION, on the SIBLING DOOR.
   *
   * `expectedVersion` is passed down twice, once per legacy decision endpoint: `/approve` forwards
   * it at `settleLegacyDecisionThroughSharedPath(..., { expectedVersion: requestedVersion, reason:
   * null })` and `/reject` at `{ expectedVersion: requestedVersion, reason }`. Every leg above is
   * an `/approve` leg, so before this case the `/reject` literal could be deleted outright and no
   * test in the repository went red — the guard was installed on both doors and asserted on one.
   * (`feedback_generation_guard_must_be_applied_to_every_sibling_surface`.)
   *
   * The fixture is the `/approve` case's, deliberately unchanged apart from the path and the body:
   * read 1 (this route's own `SELECT ... FOR UPDATE`) answers version 4, so every precondition this
   * route evaluates passes; read 2 (the settlement transaction's own locked read, on the
   * connection `dispatchAction` takes for itself) answers version 5, which is the state a
   * concurrent decision leaves behind — with none of the timing.
   *
   * `currentVersion: 5` is the load-bearing digit, not `409` alone. 5 can ONLY have come from the
   * service's `details.currentVersion` (the version read under the settlement's lock); 4 is what
   * `legacyDecisionErrorResponse`'s `fallbackCurrentVersion` would have reported (this route's own
   * pre-check read). So this body also pins that the detail crossed the mapper. And `toEqual`
   * pins the SHAPE: `error.currentVersion`, never `error.details` — one 409 envelope per endpoint,
   * whichever of the two version checks fired.
   */
  it('re-checks the caller version INSIDE the shared settlement path on /reject and answers in the one published 409 envelope', async () => {
    let instanceReads = 0
    pgState.client.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql).replace(/\s+/g, ' ').trim()
      if (statement === 'BEGIN' || statement === 'ROLLBACK' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances')) {
        instanceReads += 1
        return {
          rows: [
            {
              id: 'apr-seat-1',
              status: 'pending',
              // THE WINDOW: read 1 is this route's own pre-check (its lock is then handed back);
              // read 2 is the settlement transaction's own locked read.
              version: instanceReads === 1 ? 4 : 5,
              source_system: 'platform',
              published_definition_id: 'pubdef-1',
              current_node_key: 'approval_a',
              metadata: null,
              created_at: new Date('2026-03-26T10:00:00.000Z'),
              updated_at: new Date('2026-03-26T10:05:00.000Z'),
            },
          ],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT node_key, is_active, assignment_type, assignee_id')) {
        return {
          rows: [
            { node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: 'user-1' },
          ],
          rowCount: 1,
        }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/apr-seat-1/reject')
      .send({ version: 4, reason: 'no' })

    // Both locked reads happened: the route's own, and the settlement's. Without the second there
    // would be nothing to re-check against.
    expect(instanceReads).toBe(2)
    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_VERSION_CONFLICT',
        message: 'Approval instance version mismatch',
        currentVersion: 5,
      },
    })
    // The refusal happened BEFORE any write: no UPDATE and no audit INSERT was ever issued on
    // either connection. (`.not.` alone would pass on a route that never ran, so it sits next to
    // the `instanceReads === 2` assertion above, which proves it did.)
    const statements = pgState.client.query.mock.calls.map(([sql]: [unknown]) => String(sql))
    expect(statements.some((statement) => statement.includes('UPDATE approval_instances'))).toBe(false)
    expect(statements.some((statement) => statement.includes('INSERT INTO approval_records'))).toBe(false)
  })

  /**
   * POSITIVE CONTROL for the case above, the `/reject` twin of the `/approve` one: the SAME fixture
   * with the settlement's locked read AGREEING with the caller is not refused — it proceeds past
   * the precondition into the runtime lookup (which this mock deliberately does not serve, so the
   * call ends as a 404 rather than a 409). The discriminator is the CODE, not the bare status:
   * `APPROVAL_VERSION_CONFLICT` must be gone. Without this control, a `/reject` that refused every
   * seat-gated call for some unrelated reason would pass the case above.
   */
  it('does NOT raise a version conflict inside the settlement path on /reject when the caller version is current', async () => {
    pgState.client.query.mockImplementation(async (sql: unknown) => {
      const statement = String(sql).replace(/\s+/g, ' ').trim()
      if (statement === 'BEGIN' || statement === 'ROLLBACK' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances')) {
        return {
          rows: [
            {
              id: 'apr-seat-1',
              status: 'pending',
              version: 4,
              source_system: 'platform',
              published_definition_id: 'pubdef-1',
              current_node_key: 'approval_a',
              metadata: null,
              created_at: new Date('2026-03-26T10:00:00.000Z'),
              updated_at: new Date('2026-03-26T10:05:00.000Z'),
            },
          ],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT node_key, is_active, assignment_type, assignee_id')) {
        return {
          rows: [
            { node_key: 'approval_a', is_active: true, assignment_type: 'user', assignee_id: 'user-1' },
          ],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    pinned.setApp(app)
    const response = await request(pinned.url())
      .post('/api/approvals/apr-seat-1/reject')
      .send({ version: 4, reason: 'no' })

    expect(response.body?.error?.code).not.toBe('APPROVAL_VERSION_CONFLICT')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: 'APPROVAL_PUBLISHED_DEFINITION_NOT_FOUND',
        message: 'Published definition not found',
      },
    })
  })

  it('returns a structured validation error when reject omits the reason', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url())
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
