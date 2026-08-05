import { createRequire } from 'node:module'

import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')

// #4709 FSER-4 prerequisite (contract amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §2,
// RATIFIED `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)) — P2-1
// gate fix from the exact-head independent review of PR #4772
// (`pr4772-gate-20260805-opus5-mutationlane.md`): the identity resolver in
// `attendance-fixed-schedule-self-route-identity.cjs` has 17 pure-function
// unit tests, but NOTHING previously proved the route
// (`GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me` in
// `plugins/plugin-attendance/index.cjs`) actually calls it and obeys its
// verdict. A route that dropped the `if (!identity.ok)` check, or swapped the
// resolver for the loose same-family `getUserId`/`getOrgId` helpers (which DO
// fall back to attacker-controlled `x-user-id` header / body / query), passed
// every existing test file untouched. These probes invoke the REAL route
// handler through the plugin's own route table (not the pure resolver
// directly — "verify follow the delegation", not a second unit test of the
// function already covered) and assert BOTH the HTTP outcome AND that no SQL
// was reached on every rejection leg, mirroring the harness pattern in
// `attendance-uuid-validation-routes.test.ts`.

type RouteHandler = (req: any, res: any, next: any) => Promise<void>

const originalRbacBypass = process.env.RBAC_BYPASS

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
  }
}

async function createHarness() {
  process.env.RBAC_BYPASS = 'true'

  const routes = new Map<string, RouteHandler>()
  const db = {
    query: vi.fn(async () => {
      throw new Error('db disabled in unit harness')
    }),
    transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(db)),
  }
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  await attendancePlugin.activate({
    api: {
      database: db,
      events: { emit: vi.fn() },
      http: {
        addRoute(method: string, path: string, handler: RouteHandler) {
          routes.set(`${method.toUpperCase()} ${path}`, handler)
        },
      },
    },
    services: {
      attendanceW4SegmentCalculation: {
        resolveOrgSegmentCalculationPosture: async () => ({
          effectiveState: 'legacy',
          referenceSegments: false,
        }),
        createRequestOperationBoundary: ({ adapters }: { adapters: Record<string, any> }) => ({
          execute: async (input: Record<string, any>) => db.transaction(async (trx: any) => {
            const operation = {
              operationId: input.operationId ?? null,
              correlationId: input.correlationId,
              acceptedWritePosture: 'legacy_projection_only',
              routeVariant: input.routeVariant ?? null,
            }
            const adapter = adapters[input.kind]
            const prepared = await adapter.prepare(trx, input.routeInput, operation)
            const result = await adapter.execute(trx, prepared, operation)
            return { kind: 'legacy', response: result.response }
          }),
        }),
      },
    },
    logger,
  })

  db.query.mockClear()
  db.transaction.mockClear()

  return { db, routes }
}

async function invokeRoute(
  routes: Map<string, RouteHandler>,
  key: string,
  options: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown>; headers?: Record<string, unknown>; user?: Record<string, unknown> | null } = {},
) {
  const handler = routes.get(key)
  expect(handler, key).toBeTypeOf('function')
  const res = createResponse()
  await handler?.(
    {
      params: options.params ?? {},
      body: options.body ?? {},
      query: options.query ?? {},
      headers: options.headers ?? {},
      user: 'user' in options ? options.user : { id: 'self-route-user-1', orgId: 'self-route-org' },
      ip: '127.0.0.1',
      get: vi.fn(() => undefined),
    },
    res,
    vi.fn(),
  )
  return res
}

afterEach(async () => {
  if (originalRbacBypass === undefined) delete process.env.RBAC_BYPASS
  else process.env.RBAC_BYPASS = originalRbacBypass
  await attendancePlugin.deactivate()
  vi.restoreAllMocks()
})

const routeKey = 'GET /api/attendance/groups/:groupId/fixed-schedule/effectiveness/me'
const groupId = '00000000-0000-4000-8000-000000000701'

describe('attendance fixed-schedule self route — identity guard wiring (#4709 FSER-4 prerequisite, §2, P2-1)', () => {
  it('rejects a body.userId selector with 400 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, body: { userId: 'attacker' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a query.orgId selector with 400 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, query: { orgId: 'other-org' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a mismatched x-user-id header with 403 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, headers: { 'x-user-id': 'victim' } })
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a mismatched x-org-id header with 403 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, headers: { 'x-org-id': 'other-org' } })
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects an authenticated principal with no organization — values-free 403 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, user: { id: 'self-route-user-1' } })
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(JSON.stringify(res.body)).not.toContain('self-route-user-1')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a request with no authenticated user — 401 before any SQL', async () => {
    const { db, routes } = await createHarness()
    const res = await invokeRoute(routes, routeKey, { params: { groupId }, user: null })
    expect(res.statusCode).toBe(401)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('positive control: a fully legitimate self request (no selectors, no header) reaches the proof SQL and succeeds', async () => {
    const { db, routes } = await createHarness()
    db.query
      .mockResolvedValueOnce([{ present: 1 }]) // proof query
      .mockResolvedValueOnce([]) // desired config
      .mockResolvedValueOnce([]) // target member ids
      .mockResolvedValueOnce([]) // managed assignment rows

    const res = await invokeRoute(routes, routeKey, { params: { groupId } })

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true,
      data: { groupId, applicability: 'not_configured', state: 'not_configured' },
    })
    // Proves the route reached the SERVICE's proof SQL with the AUTHENTICATED
    // principal's identity — not a header/body/query-derived one. If the
    // route stopped calling the identity resolver, or called the loose
    // getUserId/getOrgId helpers instead, this exact call shape would not
    // occur for a request that supplies no user object override.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM users u'),
      ['self-route-org', groupId, 'self-route-user-1'],
    )
  })
})
