import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { usePinnedServer } from '../utils/pinned-server'
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { id: 'current-owner' }
    next()
  },
}))
import { createPlmApprovalBindingsRouter } from '../../src/routes/plm-approval-bindings'
const loginJwt = jwt.sign({ userId: 'current-owner', email: 'synthetic@example.invalid', role: 'user' }, 'synthetic-route-key')
afterEach(() => vi.unstubAllEnvs())
const pinned = usePinnedServer()
function fixture() {
  vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
  vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
  const service = {
    list: vi.fn().mockResolvedValue({ connection: { id: 'fixed' }, bindings: [] }),
    bind: vi.fn().mockResolvedValue({ id: 'id' }),
    unbind: vi.fn(),
    sync: vi.fn(),
    reconcile: vi.fn(),
  }
  const app = express()
  app.use(express.json())
  app.use('/api/me/plm-approval-bindings', createPlmApprovalBindingsRouter(service as never))
  pinned.setApp(app)
  return { service }
}
describe('personal binding JWT owner route', () => {
  it.each([undefined, 'mst_token', 'yua_token', 'service-token'])(
    'rejects nonlogin credential %s before service',
    async (token) => {
      const { service } = fixture()
      let call = request(pinned.url()).get('/api/me/plm-approval-bindings')
      if (token) call = call.set('Authorization', `Bearer ${token}`)
      const res = await call
      expect(res.status).toBe(401)
      expect(service.list).not.toHaveBeenCalled()
    },
  )
  it.each([{ type: 'invite' }, { typ: 'embed' }, { aud: 'purpose-bound' }])(
    'refuses a purpose credential %j even when the legacy authenticator accepts it',
    async (purpose) => {
      const { service } = fixture()
      const token = jwt.sign({ userId: 'current-owner', ...purpose }, 'synthetic-route-key')
      const res = await request(pinned.url()).get('/api/me/plm-approval-bindings').set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(401)
      expect(service.list).not.toHaveBeenCalled()
    },
  )
  it('list uses current authenticated owner and no-store', async () => {
    const { service } = fixture()
    const res = await request(pinned.url())
      .get('/api/me/plm-approval-bindings')
      .set('Authorization', `Bearer ${loginJwt}`)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(service.list).toHaveBeenCalledWith('current-owner')
  })
  it('disabled is inert 404 and strict reconciliation rejects actor override', async () => {
    const { service } = fixture()
    const res = await request(pinned.url())
      .post('/api/me/plm-approval-bindings/00000000-0000-4000-8000-000000000001/reconcile')
      .set('Authorization', `Bearer ${loginJwt}`)
      .send({ actor: 'other' })
    expect(res.status).toBe(422)
    expect(service.reconcile).not.toHaveBeenCalled()
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'false')
    expect(
      (
        await request(pinned.url())
          .get('/api/me/plm-approval-bindings')
          .set('Authorization', `Bearer ${loginJwt}`)
      ).status,
    ).toBe(404)
  })
})
