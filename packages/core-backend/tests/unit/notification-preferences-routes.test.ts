/**
 * `/api/me/notification-preferences`: handling order, the middleware chain, the closed request body,
 * and the answers. The routes are exercised over the real preference service on a scripted database for
 * the endpoint-reference answers, and over a stub service for the rest.
 */
import express from 'express'
import type { NextFunction, Request, Response, Router } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticate } from '../../src/middleware/auth'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import { createPreferencesService, type PreferencesService } from '../../src/notifications/preferences-service'
import type { NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { Db, RecipientResolver } from '../../src/notifications/recipient-resolver'
import { createMeNotificationPreferencesRouter } from '../../src/routes/me-notification-preferences'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    const user = req.header('x-test-user')
    if (user) (req as unknown as { user: unknown }).user = { id: user, sub: 'forged-sub' }
    const tenant = req.header('x-test-tenant')
    if (tenant) (req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = tenant
    next()
  }
  return { authenticate, default: authenticate }
})

const AS = { 'x-test-user': 'user-1', 'x-test-tenant': 'org-1' }
const ENDPOINT_A = '33333333-3333-4333-8333-333333333333'
const ENDPOINT_B = '44444444-4444-4444-8444-444444444444'
const PATH = '/api/me/notification-preferences'

const view = { topic: 'task_reminder', integrated: false, applies: { now: false, reason: 'topic_not_integrated' }, preference: null, effective: { source: 'none', connection: null, usable: false, fallback: null } }

describe('/api/me/notification-preferences', () => {
  const pinned = usePinnedServer()
  const service = { list: vi.fn(), patch: vi.fn() }
  let enabled = true
  let router: Router

  beforeEach(() => {
    service.list.mockReset().mockResolvedValue({ topics: [view] })
    service.patch.mockReset().mockResolvedValue(view)
    enabled = true
    router = createMeNotificationPreferencesRouter({ isEnabled: () => enabled, service: service as unknown as PreferencesService })
    const app = express()
    app.use(express.json())
    app.use(router)
    pinned.setApp(app)
  })

  const patch = (body: unknown, headers: Record<string, string> = AS) => request(pinned.url()).patch(PATH).set(headers).send(body as object)
  const valid = { topic: 'task_reminder', expectedRevision: 0 }

  it('has exactly the authentication middleware plus the handler on each route', () => {
    const routes = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route!)
    expect(routes.map((route) => `${Object.keys(route.methods).join(',')} ${route.path}`).sort()).toEqual([`get ${PATH}`, `patch ${PATH}`])
    for (const route of routes) {
      expect(route.stack).toHaveLength(2)
      expect(route.stack[0].handle).toBe(authenticate)
    }
  })

  it('answers 401 without a user, 404 with a fixed body when the switch is off (nothing else is looked at), and the organization rules', async () => {
    expect((await request(pinned.url()).get(PATH)).status).toBe(401)
    enabled = false
    for (const response of [await request(pinned.url()).get(PATH).set(AS), await patch({ junk: 1 }), await patch(valid, { 'x-test-user': 'user-1' })]) {
      expect([response.status, response.body]).toEqual([404, { error: { code: 'NOT_FOUND' } }])
    }
    expect(service.list).not.toHaveBeenCalled()
    expect(service.patch).not.toHaveBeenCalled()
    enabled = true
    expect((await request(pinned.url()).get(PATH).set({ 'x-test-user': 'user-1' })).status).toBe(404)
    const write = await patch(valid, { 'x-test-user': 'user-1' })
    expect([write.status, write.body]).toEqual([422, { error: { code: 'ORG_MISSING' } }])
  })

  it('takes the user from req.user.id and the organization from the token, and nothing from the query string on a read', async () => {
    await request(pinned.url()).get(`${PATH}?userId=x&orgId=y`).set(AS)
    expect(service.list).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1' })
    await patch({ ...valid, enabled: false })
    expect(service.patch).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'user-1', patch: { topic: 'task_reminder', expectedRevision: 0, enabled: false } })
  })

  it('refuses every recipient-identifier field name and every unknown key', async () => {
    for (const name of ['userid', 'userId', 'unionId', 'openId', 'receiveId', 'email', 'mobile', 'url', 'webhook', 'chatId', 'orgId', 'address']) {
      const response = await patch({ ...valid, [name]: 'x' })
      expect([name, response.status, response.body]).toEqual([name, 422, { error: { code: 'INVALID_REQUEST', fields: [name] } }])
    }
    expect(service.patch).not.toHaveBeenCalled()
  })

  it('refuses a topic outside the closed set and a malformed revision, flag, endpoint id or quiet-hours value', async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ topic: 'task_event', expectedRevision: 0 }, ['topic']],
      [{ expectedRevision: 0 }, ['topic']],
      [{ topic: 'task_reminder' }, ['expectedRevision']],
      [{ topic: 'task_reminder', expectedRevision: -1 }, ['expectedRevision']],
      [{ topic: 'task_reminder', expectedRevision: 1.5 }, ['expectedRevision']],
      [{ topic: 'task_reminder', expectedRevision: '1' }, ['expectedRevision']],
      [{ ...valid, enabled: 'yes' }, ['enabled']],
      [{ ...valid, primaryEndpointId: 'nope' }, ['primaryEndpointId']],
      [{ ...valid, fallbackEndpointId: 7 }, ['fallbackEndpointId']],
      [{ ...valid, quietHours: 'night' }, ['quietHours']],
      [{ ...valid, quietHours: { start: '22:00', end: '22:00', timeZone: 'Asia/Shanghai' } }, ['quietHours']],
      [{ ...valid, quietHours: { start: '25:00', end: '08:00', timeZone: 'Asia/Shanghai' } }, ['quietHours.start']],
      [{ ...valid, quietHours: { start: '22:00', end: '08:00', timeZone: 'Nowhere/Land' } }, ['quietHours.timeZone']],
      [{ ...valid, quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai', offset: 1 } }, ['quietHours.offset']],
    ]
    for (const [body, fields] of cases) {
      const response = await patch(body)
      expect([JSON.stringify(body), response.status, response.body]).toEqual([JSON.stringify(body), 422, { error: { code: 'INVALID_REQUEST', fields } }])
    }
    expect((await request(pinned.url()).patch(PATH).set(AS).set('content-type', 'text/plain').send('topic=x')).body.error.fields).toEqual(['body'])
    expect(service.patch).not.toHaveBeenCalled()
  })

  it('passes only the keys that were present, with null kept as a clear', async () => {
    await patch({ ...valid, expectedRevision: 3, primaryEndpointId: null, quietHours: null })
    expect(service.patch.mock.calls[0][0].patch).toEqual({ topic: 'task_reminder', expectedRevision: 3, primaryEndpointId: null, quietHours: null })
    await patch({ ...valid, expectedRevision: 3, primaryEndpointId: ENDPOINT_A, fallbackEndpointId: ENDPOINT_B, quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' } })
    expect(service.patch.mock.calls[1][0].patch).toEqual({
      topic: 'task_reminder',
      expectedRevision: 3,
      primaryEndpointId: ENDPOINT_A,
      fallbackEndpointId: ENDPOINT_B,
      quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' },
    })
  })

  it('sends service errors as their status, fixed code and values-free details; others as 500 INTERNAL', async () => {
    service.patch.mockRejectedValue(new NotificationHttpError(409, 'PREFERENCE_STALE', { currentRevision: 4 }))
    expect((await patch(valid)).body).toEqual({ error: { code: 'PREFERENCE_STALE', currentRevision: 4 } })
    service.patch.mockRejectedValue(new Error('boom with dt-secret'))
    const failed = await patch(valid)
    expect([failed.status, failed.body]).toEqual([500, { error: { code: 'INTERNAL' } }])
  })

  it('answers the list as the service gives it', async () => {
    const response = await request(pinned.url()).get(PATH).set(AS)
    expect([response.status, response.body]).toEqual([200, { topics: [view] }])
  })
})

describe('endpoint references in a preference write', () => {
  const pinned = usePinnedServer()
  /** A scripted database over which the real service runs: every endpoint read finds nothing. */
  const statements: string[] = []
  const db: Db = { query: async (sql) => { statements.push(sql); return { rows: [] } } }
  const deps: NotificationDbDeps = { db, transaction: async (fn) => fn(db) }
  const resolver = { verifyEndpoints: async () => [] } as unknown as RecipientResolver

  beforeEach(() => {
    statements.length = 0
    const app = express()
    app.use(express.json())
    app.use(createMeNotificationPreferencesRouter({ isEnabled: () => true, service: createPreferencesService({ ...deps, resolver, audit: async () => undefined }) }))
    pinned.setApp(app)
  })

  it("answers another user's endpoint, another organization's endpoint and an unknown id with the same bytes, as ENDPOINT_NOT_USABLE", async () => {
    const bodies: string[] = []
    for (const id of ['55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777']) {
      const response = await request(pinned.url()).patch(PATH).set(AS).send({ topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: id })
      expect(response.status).toBe(409)
      bodies.push(response.text)
    }
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0])).toEqual({ error: { code: 'ENDPOINT_NOT_USABLE', reason: 'endpoint_not_found' } })
  })

  it('reads the endpoints by organization and user, and answers before any write statement', async () => {
    await request(pinned.url()).patch(PATH).set(AS).send({ topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: ENDPOINT_A })
    const read = statements.find((sql) => sql.includes('FROM user_notification_endpoints'))!
    expect(read).toMatch(/org_id = \$2 AND user_id = \$3/)
    expect(statements.some((sql) => /^\s*(INSERT|UPDATE)/.test(sql))).toBe(false)
  })
})
