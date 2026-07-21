/**
 * GHSA-h8mf (F2) — the SECOND snapshot mutation surface: snapshot-labels router, mounted under
 * /api/admin/snapshots. Its tags/protection/release-channel mutations were unguarded and used a
 * spoofable `x-user-id`/`system` identity. They are now platform-admin + identity from req.user.id.
 *
 * Mirrors snapshots-authz.test.ts (GHSA-h8mf) and change-management-authz.test.ts (GHSA-q7hj).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

vi.mock('../../src/services/SnapshotService', () => ({
  snapshotService: {
    addTags: vi.fn().mockResolvedValue(true),
    removeTags: vi.fn().mockResolvedValue(true),
    setProtectionLevel: vi.fn().mockResolvedValue(true),
    setReleaseChannel: vi.fn().mockResolvedValue(true),
    getSnapshot: vi.fn().mockResolvedValue({ id: 's1' }),
    getByTags: vi.fn().mockResolvedValue([]),
    getByProtectionLevel: vi.fn().mockResolvedValue([]),
    getByReleaseChannel: vi.fn().mockResolvedValue([]),
  },
}))

import snapshotLabelsRouter from '../../src/routes/snapshot-labels'
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
  // Same mount base as admin-routes.ts (router.use('/snapshots', ...) under /api/admin).
  app.use('/api/admin/snapshots', snapshotLabelsRouter)
  return app
}

function mutationServiceCalls(): number {
  const s = snapshotService as unknown as Record<string, { mock?: { calls: unknown[] } }>
  return (
    (s.addTags?.mock?.calls.length ?? 0) +
    (s.removeTags?.mock?.calls.length ?? 0) +
    (s.setProtectionLevel?.mock?.calls.length ?? 0) +
    (s.setReleaseChannel?.mock?.calls.length ?? 0)
  )
}

const pinned = usePinnedServer()

describe('snapshot-labels router — platform-admin gate + identity (GHSA-h8mf F2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('non-admin -> 403 on tags/protection/release-channel, NO service mutation called', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-nonadmin' })
    pinned.setApp(app)
    await request(pinned.url()).put('/api/admin/snapshots/s1/tags').send({ add: ['x'] }).expect(403)
    await request(pinned.url()).patch('/api/admin/snapshots/s1/protection').send({ level: 'critical' }).expect(403)
    await request(pinned.url()).patch('/api/admin/snapshots/s1/release-channel').send({ channel: 'stable' }).expect(403)
    expect(mutationServiceCalls()).toBe(0)
  })

  it('unauthenticated (no req.user) -> 403, no service mutation', async () => {
    const app = buildApp(undefined)
    pinned.setApp(app)
    await request(pinned.url()).patch('/api/admin/snapshots/s1/protection').send({ level: 'critical' }).expect(403)
    expect(mutationServiceCalls()).toBe(0)
  })

  it('RBAC check failure (isAdmin throws) -> 503 fail-closed, no service mutation', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac db down'))
    const app = buildApp({ id: 'u-x' })
    pinned.setApp(app)
    await request(pinned.url()).patch('/api/admin/snapshots/s1/protection').send({ level: 'critical' }).expect(503)
    expect(mutationServiceCalls()).toBe(0)
  })

  it('platform-admin -> protection mutation succeeds and reaches the service', async () => {
    const app = buildApp({ id: 'u-admin' })
    pinned.setApp(app)
    await request(pinned.url()).patch('/api/admin/snapshots/s1/protection').send({ level: 'critical' }).expect(200)
    expect(snapshotService.setProtectionLevel).toHaveBeenCalledTimes(1)
  })

  it('identity comes ONLY from req.user.id — a spoofed x-user-id header is ignored', async () => {
    const app = buildApp({ id: 'u-realadmin' })
    pinned.setApp(app)
    await request(pinned.url())
      .patch('/api/admin/snapshots/s1/protection')
      .set('x-user-id', 'u-spoofed')
      .send({ level: 'critical' })
      .expect(200)
    expect(snapshotService.setProtectionLevel).toHaveBeenCalledWith('s1', 'critical', 'u-realadmin')
    expect(snapshotService.setProtectionLevel).not.toHaveBeenCalledWith('s1', 'critical', 'u-spoofed')
    expect(snapshotService.setProtectionLevel).not.toHaveBeenCalledWith('s1', 'critical', 'system')
  })
})
