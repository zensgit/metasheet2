import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate } from '../../src/middleware/auth'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import { createMeNotificationTestSendRouter } from '../../src/routes/me-notification-test-send'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    const id = req.header('x-test-user')
    if (id) (req as unknown as { user: unknown }).user = { id, sub: 'forged-sub' }
    const tenant = req.header('x-test-tenant')
    if (tenant) req.authenticatedTenantId = tenant
    next()
  },
}))
vi.mock('../../src/services/notification-adapter-bootstrap', () => ({}))
vi.mock('../../src/metrics/metrics', () => ({ metrics: { notificationTestSendsTotal: { inc: vi.fn() } } }))

const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const SEND_ID = '55555555-5555-4555-8555-555555555555'
const PATH = `/api/me/notification-endpoints/${ENDPOINT}/test`
const AS = { 'x-test-user': 'user-1', 'x-test-tenant': 'org-1' }
const BODY = { confirm: true, idempotencyKey: 'test_key-123' }
const RECIPIENT_KEYS = ['userid', 'userId', 'unionId', 'openId', 'receiveId', 'email', 'mobile', 'url', 'webhook', 'chatId', 'orgId', 'org_id', 'user_id', 'address', 'recipient', 'recipientUserId']

describe('notification test-send HTTP contract', () => {
  const pinned = usePinnedServer()
  const send = vi.fn()
  const audit = vi.fn()
  let enabled = true
  let delivery = true
  let router: Router

  beforeEach(() => {
    enabled = true
    delivery = true
    send.mockReset().mockResolvedValue({ outcome: 'accepted', code: 'accepted', testSendId: SEND_ID })
    audit.mockReset().mockResolvedValue(undefined)
    router = createMeNotificationTestSendRouter({ isEnabled: () => enabled, isDeliveryEnabled: () => delivery, service: { send }, audit })
    const app = express()
    app.use(express.json())
    app.use(router)
    pinned.setApp(app)
  })

  it('mounts only authenticate before the handler', () => {
    const routes = (router as unknown as { stack: Array<{ route: { path: string; stack: Array<{ handle: unknown }> } }> }).stack
    expect(routes).toHaveLength(1)
    expect(routes[0].route.path).toBe('/api/me/notification-endpoints/:id/test')
    expect(routes[0].route.stack).toHaveLength(2)
    expect(routes[0].route.stack[0].handle).toBe(authenticate)
  })

  it('has identical pre-authentication responses for switches on and off', async () => {
    const answers = []
    for (const on of [true, false]) {
      enabled = on
      delivery = on
      const result = await request(pinned.url()).post(PATH).send(BODY)
      answers.push([result.status, result.body, result.headers['content-type'], result.headers['content-length']])
    }
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0].slice(0, 2)).toEqual([401, { error: { code: 'UNAUTHORIZED' } }])
    expect(send).not.toHaveBeenCalled()
  })

  it('checks preferences, organization, body, delivery and endpoint shape in order', async () => {
    enabled = false
    expect((await request(pinned.url()).post(PATH).set({ 'x-test-user': 'user-1' }).send({})).body).toEqual({ error: { code: 'NOT_FOUND' } })
    enabled = true
    delivery = false
    expect((await request(pinned.url()).post(PATH).set({ 'x-test-user': 'user-1' }).send({})).body).toEqual({ error: { code: 'ORG_MISSING' } })
    expect((await request(pinned.url()).post(PATH).set(AS).send({})).body).toEqual({ error: { code: 'CONFIRM_REQUIRED' } })
    const off = await request(pinned.url()).post('/api/me/notification-endpoints/not-uuid/test').set(AS).send(BODY)
    expect([off.status, off.body]).toEqual([409, { error: { code: 'NOTIFICATION_DELIVERY_DISABLED' } }])
    delivery = true
    expect((await request(pinned.url()).post('/api/me/notification-endpoints/not-uuid/test').set(AS).send(BODY)).status).toBe(404)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([undefined, false, 'true', 1, null])('requires literal confirmation: %s', async (confirm) => {
    const response = await request(pinned.url()).post(PATH).set(AS).send({ ...BODY, confirm })
    expect([response.status, response.body]).toEqual([422, { error: { code: 'CONFIRM_REQUIRED' } }])
    expect(send).not.toHaveBeenCalled()
  })

  it.each(RECIPIENT_KEYS)('rejects recipient field %s without echoing its value', async (key) => {
    const response = await request(pinned.url()).post(PATH).set(AS).send({ ...BODY, [key]: 'secret-address-value' })
    expect([response.status, response.body]).toEqual([422, { error: { code: 'INVALID_REQUEST', fields: [key] } }])
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['short', 'a'.repeat(65), 'white space', '含有中文12345', 'abcde/fg', 'abc12345\n', 'abc12345\r', 12345678, null])('rejects an invalid idempotency key %s', async (idempotencyKey) => {
    const response = await request(pinned.url()).post(PATH).set(AS).send({ ...BODY, idempotencyKey })
    expect([response.status, response.body]).toEqual([422, { error: { code: 'INVALID_REQUEST', fields: ['idempotencyKey'] } }])
    expect(send).not.toHaveBeenCalled()
  })

  it('requires JSON and an object body', async () => {
    for (const response of [
      await request(pinned.url()).post(PATH).set(AS).type('text').send(JSON.stringify(BODY)),
      await request(pinned.url()).post(PATH).set(AS).send([BODY]),
    ]) expect([response.status, response.body]).toEqual([422, { error: { code: 'INVALID_REQUEST', fields: ['body'] } }])
  })

  it('uses the authenticated tenant and id, and keeps the client key on replay', async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await request(pinned.url()).post(`${PATH}?orgId=other&userId=other`).set(AS).send(BODY)
      expect([response.status, response.body]).toEqual([200, { outcome: 'accepted', code: 'accepted', testSendId: SEND_ID }])
    }
    expect(send).toHaveBeenNthCalledWith(1, { orgId: 'org-1', userId: 'user-1', endpointId: ENDPOINT, idempotencyKey: BODY.idempotencyKey })
    expect(send).toHaveBeenNthCalledWith(2, send.mock.calls[0][0])
    expect(audit.mock.calls[0][0]).toEqual({
      actorType: 'user', actorId: 'user-1', action: 'notification.test_send', resourceType: 'notification_test_send', resourceId: SEND_ID,
      meta: { organizationId: 'org-1', endpointId: ENDPOINT, outcome: 'accepted', code: 'accepted' },
    })
  })

  it.each(['accepted', 'failed', 'outcome_unknown', 'refused'])('preserves the three public outcomes for %s', async (outcome) => {
    send.mockResolvedValue({ outcome, code: 'routed_cancelled', testSendId: SEND_ID, address: 'never-expose' })
    const response = await request(pinned.url()).post(PATH).set(AS).send(BODY)
    expect([response.status, response.body]).toEqual([200, { outcome: outcome === 'refused' ? 'failed' : outcome, code: 'routed_cancelled', testSendId: SEND_ID }])
  })

  it('gives absent and foreign endpoints the same 404', async () => {
    send.mockRejectedValue(new NotificationHttpError(404, 'NOT_FOUND'))
    const answers = []
    for (const id of [ENDPOINT, OTHER]) {
      const response = await request(pinned.url()).post(`/api/me/notification-endpoints/${id}/test`).set(AS).send(BODY)
      answers.push([response.status, response.text])
    }
    expect(answers[0]).toEqual(answers[1])
    expect(answers[0][0]).toBe(404)
  })

  it.each(['ENDPOINT_NOT_USABLE', 'CONNECTION_NOT_READY', 'TEST_SEND_IN_PROGRESS'])('preserves fixed conflict %s', async (code) => {
    send.mockRejectedValue(new NotificationHttpError(409, code))
    const response = await request(pinned.url()).post(PATH).set(AS).send(BODY)
    expect([response.status, response.body]).toEqual([409, { error: { code } }])
    expect(audit).not.toHaveBeenCalled()
  })

  it('returns the rate-limit retry interval in Retry-After for the UI client', async () => {
    send.mockRejectedValue(new NotificationHttpError(429, 'TEST_SEND_RATE_LIMITED', { retryAfter: 60 }))
    const response = await request(pinned.url()).post(PATH).set(AS).send(BODY)
    expect([response.status, response.headers['retry-after'], response.body]).toEqual([429, '60', { error: { code: 'TEST_SEND_RATE_LIMITED', retryAfter: 60 } }])
  })

  it.each(['55P03', '40P01', '40001', '57014'])('maps database contention %s to the fixed busy error', async (code) => {
    send.mockRejectedValue(Object.assign(new Error('secret-address-value'), { code }))
    const response = await request(pinned.url()).post(PATH).set(AS).send(BODY)
    expect([response.status, response.body]).toEqual([503, { error: { code: 'NOTIFICATION_BUSY' } }])
  })
})
