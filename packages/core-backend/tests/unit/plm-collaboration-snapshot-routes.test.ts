import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { usePinnedServer } from '../utils/pinned-server'

const pinned = usePinnedServer()
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: { user?: { id: string }; apiTokenId?: string }, _res: unknown, next: () => void) => {
    req.user = { id: 'owner' }
    next()
  },
}))

import { createPlmCollaborationSnapshotsRouter } from '../../src/routes/plm-collaboration-snapshots'
import {
  EcoCollaborationSnapshotError,
  EcoCollaborationSnapshotService,
} from '../../src/multitable/plm-collaboration-snapshot-service'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function app(before?: express.RequestHandler) {
  const server = express()
  server.use(express.json())
  if (before) server.use(before)
  server.use('/api/plm-collaboration-snapshots', createPlmCollaborationSnapshotsRouter({
    pool: { transaction: vi.fn() },
    dataSourceManager: {} as never,
  }))
  pinned.setApp(server)
}

const token = jwt.sign({ userId: 'owner' }, 'synthetic')

describe('ECO collaboration snapshot routes', () => {
  it.each([
    undefined,
    'mst_token',
    jwt.sign({ userId: 'owner', type: 'invite' }, 'synthetic'),
    jwt.sign({ userId: 'owner', aud: 'embed' }, 'synthetic'),
    jwt.sign({ userId: 'owner', typ: 'access' }, 'synthetic'),
  ])('rejects a non-login bearer before the service (%s)', async (bearer) => {
    app()
    const spy = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview')
    let req = request(pinned.url()).post('/api/plm-collaboration-snapshots/preview')
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`)
    const response = await req.send({ sourceKind: 'eco' })
    expect(response.status).toBe(401)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'UNAUTHORIZED' } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('rejects an api token before the service', async () => {
    app((req, _res, next) => {
      ;(req as express.Request & { apiTokenId?: string }).apiTokenId = 'mst_1'
      next()
    })
    const spy = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'get')
    const response = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('UNAUTHORIZED')
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses the authenticated actor for preview and confirm and returns no-store', async () => {
    app()
    const preview = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview').mockResolvedValue({ previewId: 'p' } as never)
    const confirm = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'confirm').mockResolvedValue({ bindingId: 'b' } as never)
    const body = { sourceKind: 'eco', dataSourceId: 'ds' }
    const created = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
    expect(created.status).toBe(200)
    expect(created.headers['cache-control']).toBe('no-store')
    expect(created.body).toEqual({ ok: true, data: { previewId: 'p' } })
    expect(preview).toHaveBeenCalledWith('owner', body)
    const confirmed = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ previewId: 'p' })
    expect(confirmed.body).toEqual({ ok: true, data: { bindingId: 'b' } })
    expect(confirm).toHaveBeenCalledWith('owner', { previewId: 'p' })
  })

  it('routes retained read, refresh, and disable without a review flag', async () => {
    const route = readFileSync(new URL('../../src/routes/plm-collaboration-snapshots.ts', import.meta.url), 'utf8')
    const mount = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    expect(route).not.toContain('requireBomReview')
    expect(route).not.toContain('PLM_BOM_REVIEW_ENABLED')
    expect(mount).toContain("this.app.use('/api/plm-collaboration-snapshots', createPlmCollaborationSnapshotsRouter({")
    const mounted = mount.slice(mount.indexOf('const plmEnabled'), mount.indexOf('PLM workbench is disabled'))
    expect(mounted.indexOf('/api/plm-collaboration-snapshots')).toBeLessThan(mounted.indexOf('PLM_BOM_REVIEW_ENABLED'))
    app()
    const id = crypto.randomUUID()
    const read = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'get').mockResolvedValue({ id } as never)
    const refresh = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'refresh').mockResolvedValue({ id } as never)
    const disable = vi.spyOn(EcoCollaborationSnapshotService.prototype, 'disable').mockResolvedValue({ id, status: 'disabled' } as never)
    const got = await request(pinned.url())
      .get(`/api/plm-collaboration-snapshots/${id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(got.status).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    expect(read).toHaveBeenCalledWith('owner', id)
    await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${id}/refresh`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 1, rowKey: ['a', 'b', 'c', 'd'] })
      .expect(200)
    expect(refresh).toHaveBeenCalledWith('owner', id, { expectedVersion: 1, rowKey: ['a', 'b', 'c', 'd'] })
    const stopped = await request(pinned.url())
      .post(`/api/plm-collaboration-snapshots/${id}/disable`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expectedVersion: 2 })
    expect(stopped.body.data).toEqual({ id, status: 'disabled' })
    expect(disable).toHaveBeenCalledWith('owner', id, { expectedVersion: 2 })
  })

  it('returns only the service code and no-store on failure', async () => {
    app()
    vi.spyOn(EcoCollaborationSnapshotService.prototype, 'preview').mockRejectedValue(
      new EcoCollaborationSnapshotError(403, 'ECO_SOURCE_MANAGED'),
    )
    const response = await request(pinned.url())
      .post('/api/plm-collaboration-snapshots/preview')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(response.status).toBe(403)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ ok: false, error: { code: 'ECO_SOURCE_MANAGED' } })
    expect(JSON.stringify(response.body)).not.toContain('stack')
  })
})
