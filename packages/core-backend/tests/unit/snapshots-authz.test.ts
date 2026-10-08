/**
 * GHSA-h8mf — snapshots router: platform-admin gate on ALL mutations + identity hardening +
 * restore-scope validation (full must be confirmed & unscoped; partial/selective need a non-empty
 * allowlisted item_types). Reads stay at permissions:read (scope NOT widened).
 *
 * Owner temporary boundary (2026-07-11):
 *   - every snapshot mutation -> platform-admin via the existing admin safety guard (requireAdminRole);
 *   - RBAC/safety-check exception -> fail closed (503);
 *   - identity ONLY from req.user.id (x-user-id ignored);
 *   - full explicit + confirmed; partial/selective require non-empty allowlisted item_types.
 *
 * Mount pattern mirrors tests/unit/change-management-authz.test.ts (GHSA-q7hj).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

// pool=null makes requireAdminRole's best-effort logSafetyOperation a no-op (no throw on denial).
vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

// rbacGuard is used by the READ routes only; pass-through so we can prove reads are NOT admin-gated.
vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

// The destructive endpoints (restore/delete/cleanup) now also sit behind the SafetyGuard confirmation
// (requireSafetyCheck), which 403s until a safety token is presented. That layer is proven engaged, and
// proven load-bearing, in tests/unit/snapshots-safety-guard.test.ts. Here we pass it through so THIS file
// can isolate the two layers it is about: the platform-admin gate and the restore-scope validation.
// requireAdminRole / protectAdminOperation stay REAL — the admin gate is what this file tests.
vi.mock('../../src/guards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/guards')>()
  return {
    ...actual,
    requireSafetyCheck: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
  }
})

// Mock the service AND re-export the item-type allowlist the router imports at module load.
vi.mock('../../src/services/SnapshotService', () => ({
  RESTORABLE_ITEM_TYPES: ['view', 'view_state', 'table_row'],
  snapshotService: {
    restoreSnapshot: vi.fn().mockResolvedValue({ success: true, itemsRestored: 3, duration: 0.1 }),
    deleteSnapshot: vi.fn().mockResolvedValue(true),
    setSnapshotLock: vi.fn().mockResolvedValue(true),
    setProtectionLevel: vi.fn().mockResolvedValue(true),
    setReleaseChannel: vi.fn().mockResolvedValue(true),
    addTags: vi.fn().mockResolvedValue(true),
    removeTags: vi.fn().mockResolvedValue(true),
    createSnapshot: vi.fn().mockResolvedValue({ id: 'snap1' }),
    cleanupExpired: vi.fn().mockResolvedValue({ deleted: 0, freed: 0, skipped: 0 }),
    getSnapshot: vi.fn().mockResolvedValue({ id: 'snap1' }),
    listSnapshots: vi.fn().mockResolvedValue([]),
  },
}))

import { snapshotsRouter } from '../../src/routes/snapshots'
import { snapshotService } from '../../src/services/SnapshotService'

function buildApp(user?: { id: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use(snapshotsRouter())
  return app
}

// Every mutation route + a minimal valid body (admin path).
const MUTATIONS: Array<{ name: string; method: 'post' | 'put' | 'patch' | 'delete'; path: string; body?: unknown }> = [
  { name: 'create', method: 'post', path: '/api/snapshots', body: { view_id: 'v1', name: 'n' } },
  { name: 'restore', method: 'post', path: '/api/snapshots/s1/restore', body: { restore_type: 'full', confirm_full: true } },
  { name: 'delete', method: 'delete', path: '/api/snapshots/s1' },
  { name: 'lock', method: 'patch', path: '/api/snapshots/s1/lock', body: { locked: true } },
  { name: 'protection', method: 'patch', path: '/api/snapshots/s1/protection', body: { level: 'critical' } },
  { name: 'release-channel', method: 'patch', path: '/api/snapshots/s1/release-channel', body: { channel: 'stable' } },
  { name: 'tags', method: 'put', path: '/api/snapshots/s1/tags', body: { add: ['x'] } },
  { name: 'cleanup', method: 'post', path: '/api/snapshots/cleanup', body: {} },
]

function serviceCallCount(): number {
  const s = snapshotService as unknown as Record<string, { mock?: { calls: unknown[] } }>
  return Object.values(s).reduce((n, fn) => n + (fn?.mock?.calls.length ?? 0), 0)
}

const pinned = usePinnedServer()

describe('snapshots router — platform-admin gate on all mutations (GHSA-h8mf)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('non-admin principal -> 403 on EVERY mutation route, and NO service method is called', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-nonadmin' })
    pinned.setApp(app)
    for (const m of MUTATIONS) {
      const req = request(pinned.url())[m.method](m.path)
      await (m.body !== undefined ? req.send(m.body as object) : req).expect(403)
    }
    expect(serviceCallCount()).toBe(0)
  })

  it('unauthenticated (no req.user) -> 403 on a mutation, no service call', async () => {
    const app = buildApp(undefined)
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'full', confirm_full: true }).expect(403)
    expect(serviceCallCount()).toBe(0)
  })

  it('RBAC check failure (isAdmin throws) -> 503 fail-closed on a mutation, NO service call', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac db down'))
    const app = buildApp({ id: 'u-someone' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'full', confirm_full: true }).expect(503)
    await request(pinned.url()).delete('/api/snapshots/s1').expect(503)
    expect(serviceCallCount()).toBe(0)
  })

  it('platform-admin normal path: each mutation reaches its service method', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots').send({ view_id: 'v1', name: 'n' }).expect(201)
    expect(snapshotService.createSnapshot).toHaveBeenCalledTimes(1)
    await request(pinned.url()).delete('/api/snapshots/s1').expect(200)
    expect(snapshotService.deleteSnapshot).toHaveBeenCalledTimes(1)
    await request(pinned.url()).patch('/api/snapshots/s1/lock').send({ locked: false }).expect(200)
    expect(snapshotService.setSnapshotLock).toHaveBeenCalledTimes(1)
    await request(pinned.url()).patch('/api/snapshots/s1/protection').send({ level: 'critical' }).expect(200)
    expect(snapshotService.setProtectionLevel).toHaveBeenCalledTimes(1)
  })

  it('reads are NOT elevated: a non-admin can still list/get/diff (permissions:read, scope unchanged)', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-reader' })
    pinned.setApp(app)
    await request(pinned.url()).get('/api/snapshots?view_id=v1').expect(200)
    await request(pinned.url()).get('/api/snapshots/s1').expect(200)
  })
})

describe('snapshots restore route — scope validation (GHSA-h8mf)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('missing restore_type -> 400, restoreSnapshot NOT called', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({}).expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it('invalid restore_type -> 400, restoreSnapshot NOT called', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'everything' }).expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it("full WITHOUT confirm_full -> 400 (must be explicitly confirmed), restoreSnapshot NOT called", async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'full' }).expect(400)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'full', confirm_full: 'yes' }).expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it("full WITH item_types -> 400 (a full restore must not narrow), restoreSnapshot NOT called", async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/snapshots/s1/restore')
      .send({ restore_type: 'full', confirm_full: true, item_types: ['view'] })
      .expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it('full confirmed + no item_types -> 200, restoreSnapshot called with itemTypes undefined', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'full', confirm_full: true }).expect(200)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 's1', restoreType: 'full', itemTypes: undefined }),
    )
  })

  it('partial WITHOUT item_types (and empty array) -> 400, restoreSnapshot NOT called', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'partial' }).expect(400)
    await request(pinned.url()).post('/api/snapshots/s1/restore').send({ restore_type: 'partial', item_types: [] }).expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it('partial with an out-of-allowlist item_type -> 400, restoreSnapshot NOT called', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/snapshots/s1/restore')
      .send({ restore_type: 'selective', item_types: ['view', 'secrets'] })
      .expect(400)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledTimes(0)
  })

  it('partial with allowlisted item_types -> 200, forwarded to the service', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/snapshots/s1/restore')
      .send({ restore_type: 'partial', item_types: ['view', 'table_row'] })
      .expect(200)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ restoreType: 'partial', itemTypes: ['view', 'table_row'] }),
    )
  })

  it('identity comes ONLY from req.user.id — a spoofed x-user-id header is ignored', async () => {
    const app = buildApp({ id: 'u-realadmin' })
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/snapshots/s1/restore')
      .set('x-user-id', 'u-spoofed')
      .send({ restore_type: 'full', confirm_full: true })
      .expect(200)
    expect(snapshotService.restoreSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ restoredBy: 'u-realadmin' }),
    )
    expect(snapshotService.restoreSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ restoredBy: 'u-spoofed' }),
    )
  })
})
