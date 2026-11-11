/**
 * `/api/me/notification-endpoints`: handling order, the middleware chain, where the user and the
 * organization come from, the closed request body, and the answers. The service is replaced by a stub;
 * authentication by a header-driven stand-in that sets the fields the real one sets.
 */
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate } from '../../src/middleware/auth'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import type { EndpointItem, EndpointsService } from '../../src/notifications/endpoints-service'
import { createMeNotificationEndpointsRouter } from '../../src/routes/me-notification-endpoints'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    const user = req.header('x-test-user')
    if (user) (req as unknown as { user: unknown }).user = { id: user, sub: req.header('x-test-sub') ?? 'forged-sub' }
    const tenant = req.header('x-test-tenant')
    if (tenant) (req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = tenant
    next()
  }
  return { authenticate, default: authenticate }
})

const CONNECTION = '11111111-1111-4111-8111-111111111111'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const AS = { 'x-test-user': 'user-1', 'x-test-tenant': 'org-1' }

const item: EndpointItem = {
  id: ENDPOINT,
  connection: { id: CONNECTION, provider: 'dingtalk', label: '钉钉 · HQ' },
  addressKind: 'dingtalk_userid',
  proofKind: 'directory_link',
  status: 'active',
  revision: 1,
  usable: true,
  unusableReason: null,
  capability: { effective: false, reason: 'switch_off' },
  verified: false,
  lastVerifiedAt: '2026-11-06T08:00:00.000Z',
}

const RECIPIENT_FIELD_NAMES = ['userid', 'userId', 'unionId', 'openId', 'receiveId', 'email', 'mobile', 'url', 'webhook', 'chatId', 'orgId', 'org_id', 'user_id', 'address', 'recipient']

describe('/api/me/notification-endpoints', () => {
  const pinned = usePinnedServer()
  const service = {
    list: vi.fn(),
    establish: vi.fn(),
    revoke: vi.fn(),
  }
  let enabled = true
  let router: Router

  beforeEach(() => {
    for (const fn of Object.values(service)) fn.mockReset()
    service.list.mockResolvedValue({ delivery: { enabled: false, testSendAvailable: false, reason: 'delivery_disabled' }, endpoints: [item], candidates: [] })
    service.establish.mockResolvedValue({ created: true, endpoint: item })
    service.revoke.mockResolvedValue({ id: ENDPOINT, status: 'revoked', revision: 2 })
    enabled = true
    router = createMeNotificationEndpointsRouter({ isEnabled: () => enabled, service: service as unknown as EndpointsService })
    const app = express()
    app.use(express.json())
    app.use(router)
    pinned.setApp(app)
  })

  const calls = () => Object.values(service).reduce((total, fn) => total + fn.mock.calls.length, 0)

  describe('middleware chain', () => {
    it('is exactly the authentication middleware plus the handler, on each route', () => {
      const layers = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack
        .filter((layer) => layer.route)
        .map((layer) => layer.route!)
      expect(layers.map((route) => `${Object.keys(route.methods).join(',')} ${route.path}`).sort()).toEqual([
        'delete /api/me/notification-endpoints/:id',
        'get /api/me/notification-endpoints',
        'post /api/me/notification-endpoints',
      ])
      for (const route of layers) {
        expect(route.stack).toHaveLength(2)
        expect(route.stack[0].handle).toBe(authenticate)
      }
    })
  })

  describe('handling order', () => {
    it('answers 401 without a user', async () => {
      const response = await request(pinned.url()).get('/api/me/notification-endpoints')
      expect([response.status, response.body]).toEqual([401, { error: { code: 'UNAUTHORIZED' } }])
      expect(calls()).toBe(0)
    })

    it('answers 404 with a fixed body when the switch is off, before looking at the organization or the body, and never calls the service', async () => {
      enabled = false
      const answers = await Promise.all([
        request(pinned.url()).get('/api/me/notification-endpoints').set(AS),
        request(pinned.url()).post('/api/me/notification-endpoints').set(AS).send({ junk: true }),
        request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}`).set(AS),
        request(pinned.url()).get('/api/me/notification-endpoints').set({ 'x-test-user': 'user-1' }),
      ])
      for (const response of answers) expect([response.status, response.body]).toEqual([404, { error: { code: 'NOT_FOUND' } }])
      expect(calls()).toBe(0)
    })

    it('without an organization: 404 for a read, 422 ORG_MISSING for a write', async () => {
      const noOrg = { 'x-test-user': 'user-1' }
      expect((await request(pinned.url()).get('/api/me/notification-endpoints').set(noOrg)).status).toBe(404)
      const post = await request(pinned.url()).post('/api/me/notification-endpoints').set(noOrg).send({ connectionId: CONNECTION, proofKind: 'directory_link' })
      expect([post.status, post.body]).toEqual([422, { error: { code: 'ORG_MISSING' } }])
      const del = await request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}`).set(noOrg)
      expect([del.status, del.body]).toEqual([422, { error: { code: 'ORG_MISSING' } }])
      expect(calls()).toBe(0)
    })
  })

  describe('identity of the caller', () => {
    it('takes the user from req.user.id even when the request carries a different sub, and the organization from the token', async () => {
      await request(pinned.url()).get('/api/me/notification-endpoints').set({ ...AS, 'x-test-sub': 'someone-else' })
      expect(service.list).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1' })
      await request(pinned.url()).post('/api/me/notification-endpoints').set({ ...AS, 'x-test-sub': 'someone-else' }).send({ connectionId: CONNECTION, proofKind: 'directory_link' })
      expect(service.establish).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', connectionId: CONNECTION, proofKind: 'directory_link' })
      await request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}`).set({ ...AS, 'x-test-sub': 'someone-else' })
      expect(service.revoke).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', endpointId: ENDPOINT })
    })

    it('passes nothing from the query string or the body of a read or a delete to the service', async () => {
      await request(pinned.url()).get('/api/me/notification-endpoints?userid=x&orgId=other&email=a@b.c').set(AS).send({ userid: 'x' })
      expect(service.list).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1' })
      await request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}?userid=x&orgId=other`).set(AS).send({ userid: 'x', orgId: 'other' })
      expect(service.revoke).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', endpointId: ENDPOINT })
    })
  })

  describe('POST body', () => {
    const post = (body: unknown, type = 'application/json') =>
      request(pinned.url()).post('/api/me/notification-endpoints').set(AS).set('content-type', type).send(typeof body === 'string' ? body : JSON.stringify(body))
    const valid = { connectionId: CONNECTION, proofKind: 'directory_link' }

    it('accepts the closed body and answers 201 for a new endpoint and 200 for an existing one', async () => {
      const created = await post(valid)
      expect([created.status, created.body]).toEqual([201, { endpoint: item }])
      service.establish.mockResolvedValue({ created: false, endpoint: item })
      expect((await post({ ...valid, proofKind: 'external_identity' })).status).toBe(200)
    })

    it('refuses every recipient-identifier field name and every other unknown key, naming only the field', async () => {
      for (const name of RECIPIENT_FIELD_NAMES) {
        const response = await post({ ...valid, [name]: 'x' })
        expect([name, response.status, response.body]).toEqual([name, 422, { error: { code: 'INVALID_REQUEST', fields: [name] } }])
      }
      expect(service.establish).not.toHaveBeenCalled()
    })

    it('refuses a missing or malformed field, a body that is not an object, and a body that is not JSON', async () => {
      const cases: Array<[unknown, string[]]> = [
        [{}, ['connectionId', 'proofKind']],
        [{ connectionId: 'nope', proofKind: 'directory_link' }, ['connectionId']],
        [{ connectionId: CONNECTION, proofKind: 'email' }, ['proofKind']],
        [{ connectionId: 5, proofKind: 'directory_link' }, ['connectionId']],
        [[valid], ['body']],
      ]
      for (const [body, fields] of cases) {
        const response = await post(body)
        expect([JSON.stringify(body), response.status, response.body.error.fields]).toEqual([JSON.stringify(body), 422, fields])
      }
      const plain = await post('connectionId=1', 'text/plain')
      expect([plain.status, plain.body.error.fields]).toEqual([422, ['body']])
      expect(service.establish).not.toHaveBeenCalled()
    })

    it('names an odd key as a placeholder', async () => {
      const response = await post({ ...valid, 'a b<script>': 1 })
      expect(response.body).toEqual({ error: { code: 'INVALID_REQUEST', fields: ['_'] } })
    })
  })

  describe('DELETE', () => {
    it('answers 404 without calling the service for an id that is not a UUID', async () => {
      const response = await request(pinned.url()).delete('/api/me/notification-endpoints/not-a-uuid').set(AS)
      expect([response.status, response.body]).toEqual([404, { error: { code: 'NOT_FOUND' } }])
      expect(service.revoke).not.toHaveBeenCalled()
    })

    it('answers an endpoint that is not the caller own as the same 404 as one that does not exist', async () => {
      service.revoke.mockRejectedValue(new NotificationHttpError(404, 'NOT_FOUND'))
      const response = await request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}`).set(AS)
      expect([response.status, response.body]).toEqual([404, { error: { code: 'NOT_FOUND' } }])
    })

    it('answers 200 with the revoked endpoint', async () => {
      const response = await request(pinned.url()).delete(`/api/me/notification-endpoints/${ENDPOINT}`).set(AS)
      expect([response.status, response.body]).toEqual([200, { endpoint: { id: ENDPOINT, status: 'revoked', revision: 2 } }])
    })
  })

  describe('errors', () => {
    it('sends a service error as its status and fixed code, with details only when the service gave values-free ones', async () => {
      service.establish.mockRejectedValue(new NotificationHttpError(409, 'ADDRESS_ALREADY_BOUND'))
      const refused = await request(pinned.url()).post('/api/me/notification-endpoints').set(AS).send({ connectionId: CONNECTION, proofKind: 'directory_link' })
      expect([refused.status, refused.body]).toEqual([409, { error: { code: 'ADDRESS_ALREADY_BOUND' } }])
      service.establish.mockRejectedValue(new NotificationHttpError(503, 'NOTIFICATION_BUSY'))
      const busy = await request(pinned.url()).post('/api/me/notification-endpoints').set(AS).send({ connectionId: CONNECTION, proofKind: 'directory_link' })
      expect([busy.status, busy.body]).toEqual([503, { error: { code: 'NOTIFICATION_BUSY' } }])
    })

    it('answers any other failure as 500 INTERNAL without its message or its code', async () => {
      service.list.mockRejectedValue(Object.assign(new Error('relation "user_notification_endpoints" does not exist for dt-secret'), { code: '42P01' }))
      const response = await request(pinned.url()).get('/api/me/notification-endpoints').set(AS)
      expect([response.status, response.body]).toEqual([500, { error: { code: 'INTERNAL' } }])
      expect(JSON.stringify(response.body)).not.toMatch(/42P01|dt-secret|relation/)
    })
  })
})
