/**
 * GHSA-q7hj — change-management router: platform-admin gate + identity hardening + force rejection.
 *
 * Owner ruling (5 required proofs):
 *   (a) non-admin -> 403;
 *   (b) service methods called ZERO times on denial;
 *   (c) RBAC-check failure -> ZERO side effects (fail-closed 503, no service call);
 *   (d) platform-admin normal path no regression;
 *   (e) force=true rejected.
 * Plus: unauthenticated -> 403; truthy non-boolean force rejected (bypass prevention);
 * identity comes ONLY from req.user.id (x-user-id header ignored).
 *
 * Mount pattern mirrors tests/unit/multitable-ai-usage-summary-route.test.ts:
 * rbac/service + db/pg mocked; the two change-management services mocked to spy call counts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

// pool=null makes requireAdminRole's best-effort logSafetyOperation a no-op (no throw on denial),
// so denials return a clean 403/503 rather than being swallowed into the catch.
vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

vi.mock('../../src/services/ChangeManagementService', () => ({
  changeManagementService: {
    createChangeRequest: vi.fn().mockResolvedValue({ id: 'cr-created' }),
    approveChangeRequest: vi.fn().mockResolvedValue({ approved: true }),
    deployChange: vi.fn().mockResolvedValue({ deployed: true }),
    rollbackChange: vi.fn().mockResolvedValue({ rolledBack: true }),
  },
}))

vi.mock('../../src/services/SchemaSnapshotService', () => ({
  schemaSnapshotService: {
    createSchemaSnapshot: vi.fn().mockResolvedValue({ id: 'snap-created' }),
    diffSchemas: vi.fn().mockResolvedValue({ diff: [] }),
  },
}))

import changeManagementRouter from '../../src/routes/change-management'
import { changeManagementService } from '../../src/services/ChangeManagementService'
import { schemaSnapshotService } from '../../src/services/SchemaSnapshotService'

function buildApp(user?: { id: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use('/api', changeManagementRouter)
  return app
}

function expectNoServiceCalls(): void {
  expect(changeManagementService.createChangeRequest).toHaveBeenCalledTimes(0)
  expect(changeManagementService.approveChangeRequest).toHaveBeenCalledTimes(0)
  expect(changeManagementService.deployChange).toHaveBeenCalledTimes(0)
  expect(changeManagementService.rollbackChange).toHaveBeenCalledTimes(0)
  expect(schemaSnapshotService.createSchemaSnapshot).toHaveBeenCalledTimes(0)
  expect(schemaSnapshotService.diffSchemas).toHaveBeenCalledTimes(0)
}

describe('change-management router — platform-admin gate + identity + force rejection (GHSA-q7hj)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('(a)+(b) non-admin principal -> 403 on every route, and NO service method is called', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-nonadmin' })

    await request(app).post('/api/changes').send({ title: 'x' }).expect(403)
    await request(app).post('/api/changes/cr1/approve').send({}).expect(403)
    await request(app).post('/api/changes/cr1/deploy').send({}).expect(403)
    await request(app).post('/api/changes/cr1/rollback').send({}).expect(403)
    await request(app).post('/api/schemas/v1/snapshot').send({}).expect(403)
    await request(app).get('/api/schemas/diff?schema1=a&schema2=b').expect(403)

    expectNoServiceCalls()
  })

  it('unauthenticated (no req.user) -> 403, no service call', async () => {
    const app = buildApp(undefined)
    await request(app).post('/api/changes/cr1/deploy').send({}).expect(403)
    expectNoServiceCalls()
  })

  it('(c) RBAC check failure (isAdmin throws) -> 503 fail-closed, NO service call (zero side effects)', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac db down'))
    const app = buildApp({ id: 'u-someone' })
    await request(app).post('/api/changes/cr1/deploy').send({}).expect(503)
    await request(app).post('/api/schemas/v1/snapshot').send({}).expect(503)
    expectNoServiceCalls()
  })

  it('(d) platform-admin normal path: create/approve/rollback/snapshot/diff succeed (no regression)', async () => {
    const app = buildApp({ id: 'u-admin' })

    await request(app).post('/api/changes').send({ title: 'x' }).expect(201)
    expect(changeManagementService.createChangeRequest).toHaveBeenCalledTimes(1)

    await request(app).post('/api/changes/cr1/approve').send({ comment: 'ok' }).expect(200)
    expect(changeManagementService.approveChangeRequest).toHaveBeenCalledTimes(1)

    await request(app).post('/api/changes/cr1/rollback').send({ reason: 'r' }).expect(200)
    expect(changeManagementService.rollbackChange).toHaveBeenCalledTimes(1)

    await request(app).post('/api/schemas/v1/snapshot').send({}).expect(201)
    expect(schemaSnapshotService.createSchemaSnapshot).toHaveBeenCalledTimes(1)

    await request(app).get('/api/schemas/diff?schema1=a&schema2=b').expect(200)
    expect(schemaSnapshotService.diffSchemas).toHaveBeenCalledTimes(1)
  })

  it('(d) platform-admin non-force deploy: succeeds and forwards force:false to the service', async () => {
    const app = buildApp({ id: 'u-admin' })
    await request(app).post('/api/changes/cr1/deploy').send({ dry_run: false }).expect(200)
    expect(changeManagementService.deployChange).toHaveBeenCalledTimes(1)
    expect(changeManagementService.deployChange).toHaveBeenCalledWith('cr1', 'u-admin', {
      dryRun: false,
      force: false,
    })
  })

  it('(e) platform-admin deploy with force=true -> 400, deployChange NOT called', async () => {
    const app = buildApp({ id: 'u-admin' })
    await request(app).post('/api/changes/cr1/deploy').send({ force: true }).expect(400)
    expect(changeManagementService.deployChange).toHaveBeenCalledTimes(0)
  })

  it('(e) truthy non-boolean force ("true", 1) is also rejected -> 400, deployChange NOT called (bypass prevention)', async () => {
    const app = buildApp({ id: 'u-admin' })
    await request(app).post('/api/changes/cr1/deploy').send({ force: 'true' }).expect(400)
    await request(app).post('/api/changes/cr1/deploy').send({ force: 1 }).expect(400)
    expect(changeManagementService.deployChange).toHaveBeenCalledTimes(0)
  })

  it('identity comes ONLY from req.user.id — a spoofed x-user-id header is ignored', async () => {
    const app = buildApp({ id: 'u-realadmin' })
    await request(app)
      .post('/api/changes')
      .set('x-user-id', 'u-spoofed')
      .send({ title: 'x' })
      .expect(201)
    expect(changeManagementService.createChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'u-realadmin' }),
    )
    expect(changeManagementService.createChangeRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: 'u-spoofed' }),
    )
  })

  // REGRESSION (GHSA-q7hj): this router is mounted at app.use('/api', changeManagementRouter), so a
  // PATH-LESS router.use(requireAdminRole()) executes for EVERY /api/* request that reaches it and
  // 403s unrelated endpoints mounted AFTER it (e.g. /api/admin/*) for any non-admin — which would
  // brick the app for non-admins. The guard must be bound to this router's own namespaces only.
  // Mounting the router in isolation (as the tests above do) cannot see this; we must reproduce the
  // real wiring: the router at '/api' with a sibling /api route registered after it.
  it('the admin gate does NOT leak to sibling /api routes mounted after this router', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = { id: 'u-nonadmin' }
      next()
    })
    app.use('/api', changeManagementRouter)
    // A sibling router/route mounted AFTER the change-management router, exactly like /api/admin/* is.
    app.get('/api/admin/safety/rules', (_req, res) => {
      res.status(200).json({ ok: true })
    })

    // change-management surface stays gated for a non-admin...
    await request(app).post('/api/changes/cr1/deploy').send({}).expect(403)
    await request(app).get('/api/schemas/diff?schema1=a&schema2=b').expect(403)
    // ...but an unrelated /api endpoint mounted after it MUST remain reachable.
    await request(app).get('/api/admin/safety/rules').expect(200)
    expectNoServiceCalls()
  })
})
