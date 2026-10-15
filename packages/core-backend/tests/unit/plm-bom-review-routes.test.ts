import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: 'owner' }
    next()
  },
}))
import { createPlmBomReviewsRouter } from '../../src/routes/plm-bom-reviews'
import { PlmBomReviewService } from '../../src/multitable/plm-bom-review-service'
import { BomReviewError } from '../../src/multitable/plm-bom-review-wire'
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
function fixture() {
  vi.stubEnv('PLM_BOM_REVIEW_ENABLED', 'true')
  const app = express()
  app.use(express.json())
  const query = vi.fn()
  app.use(
    '/api/plm-bom-reviews',
    createPlmBomReviewsRouter({
      pool: { query, transaction: vi.fn() },
      dataSourceManager: {} as never,
    }),
  )
  return app
}
const token = jwt.sign({ userId: 'owner' }, 'synthetic')
describe('BOM share login route', () => {
  it.each(['notifications','completion-webhooks','change-listener'])('an empty %s POST is invalid rather than a read request', async (action) => {
    const res = await request(fixture())
      .post(`/api/plm-bom-reviews/${crypto.randomUUID()}/${action}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_REQUEST')
  })
  it.each([
    undefined,
    'mst_token',
    jwt.sign({ userId: 'owner', type: 'invite' }, 'synthetic'),
    jwt.sign({ userId: 'owner', aud: 'embed' }, 'synthetic'),
  ])('rejects nonlogin bearer before service %s', async (bearer) => {
    const app = fixture(),
      spy = vi.spyOn(PlmBomReviewService.prototype, 'bases')
    let req = request(app).get('/api/plm-bom-reviews/bases')
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`)
    expect((await req).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })
  it('routes explicit listener activation with the authenticated owner and returns no-store status', async () => {
    const app=fixture(),id=crypto.randomUUID()
    const spy=vi.spyOn(PlmBomReviewService.prototype,'changeListener').mockResolvedValue({ status: 'active' })
    const response=await request(app).post(`/api/plm-bom-reviews/${id}/change-listener`)
      .set('Authorization',`Bearer ${token}`).send({ expectedVersion: 1 })
    expect(response.status).toBe(200); expect(response.headers['cache-control']).toBe('no-store')
    expect(spy).toHaveBeenCalledWith('owner',id,{ expectedVersion: 1 })
    await request(app).get(`/api/plm-bom-reviews/${id}/change-listener`).set('Authorization',`Bearer ${token}`).expect(200)
    expect(spy).toHaveBeenLastCalledWith('owner',id)
  })
  it('uses authenticated actor, strict source query and no-store', async () => {
    const app = fixture(),
      spy = vi
        .spyOn(PlmBomReviewService.prototype, 'list')
        .mockResolvedValue({ items: [] })
    const res = await request(app)
      .get('/api/plm-bom-reviews?dataSourceId=ds&partId=P')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(spy).toHaveBeenCalledWith('owner', 'ds', 'P')
    expect(
      (
        await request(app)
          .get('/api/plm-bom-reviews?dataSourceId=ds&partId=P&actor=other')
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(400)
  })
  it('preserves values-free failure and disabled fails before authentication', async () => {
    const app = fixture()
    vi.spyOn(PlmBomReviewService.prototype, 'preview').mockRejectedValue(
      new BomReviewError(409, 'SOURCE_CHANGED'),
    )
    expect(
      (
        await request(app)
          .post('/api/plm-bom-reviews/preview')
          .set('Authorization', `Bearer ${token}`)
          .send({})
      ).body,
    ).toEqual({ ok: false, error: { code: 'SOURCE_CHANGED' } })
    vi.stubEnv('PLM_BOM_REVIEW_ENABLED', 'false')
    expect((await request(app).get('/api/plm-bom-reviews/bases')).status).toBe(
      503,
    )
  })
})
