import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminDirectoryNotificationRouter } from '../../src/routes/admin-directory-notification'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import { Logger } from '../../src/core/logger'
import type { TopicPolicyService } from '../../src/notifications/topic-policy-service'

vi.mock('../../src/routes/admin-directory', () => ({ ensurePlatformAdmin: async (req, res) => {
  if (req.user?.role !== 'admin') { res.status(403).json({ error: { code: 'FORBIDDEN' } }); return null }
  return req.user.id
} }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/routes/me-notification-wiring', () => ({ productionNotificationDbDeps: vi.fn(), productionAuditSink: vi.fn(), productionRecipientResolver: vi.fn(), productionNotificationVerificationSummary: vi.fn() }))
const service = { list: vi.fn(), put: vi.fn(), preview: vi.fn(), requireMember: vi.fn() }
const BASE = '/api/admin/directory/notification-topic-policies'
function app(tenant?: string, enabled = true, admin = true) {
  const app = express(); app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'fixture-user', role: admin ? 'admin' : 'user', tenantId: 'default' } as never
    if (tenant !== undefined) req.authenticatedTenantId = tenant
    next()
  })
  app.use('/api/admin/directory', createAdminDirectoryNotificationRouter({ service: service as TopicPolicyService, isEnabled: () => enabled }))
  return app
}
beforeEach(() => {
  vi.resetAllMocks()
  service.requireMember.mockImplementation(async actor => {
    if (!actor.authenticatedTenantId) throw new NotificationHttpError(422, 'ORG_MISSING')
    if (actor.authenticatedTenantId !== 'default') throw new NotificationHttpError(403, 'ORG_MISMATCH')
    return actor.authenticatedTenantId
  })
  service.put.mockResolvedValue({ topic: 'task_reminder', state: 'paused', defaultConnectionId: null, revision: 2 })
  service.list.mockResolvedValue({ topics: [] }); service.preview.mockResolvedValue({ counts: {} })
})
describe('notification policy HTTP boundaries', () => {
  it('checks administrator before switch and data access', async () => {
    expect((await request(app(undefined, false, false)).put(`${BASE}/task_reminder`).send({})).status).toBe(403)
    expect(service.put).not.toHaveBeenCalled(); expect(service.requireMember).not.toHaveBeenCalled()
  })
  it('keeps all three routes query-free when disabled', async () => {
    const server = app('default', false)
    expect((await request(server).get(BASE)).status).toBe(404)
    expect((await request(server).put(`${BASE}/task_reminder`).send({})).status).toBe(404)
    expect((await request(server).get(`${BASE}/task_reminder/takeover-preview`)).status).toBe(404)
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
  it.each([undefined, 'other'])('refuses tenant %s before validating a malformed nonnull default', async tenant => {
    const response = await request(app(tenant)).put(`${BASE}/task_reminder`).set('x-tenant-id', 'default')
      .send({ expectedRevision: 0, state: 'active', defaultConnectionId: 'bad' })
    expect(response.status).toBe(tenant ? 403 : 422)
    expect(response.body).toEqual({ error: { code: tenant ? 'ORG_MISMATCH' : 'ORG_MISSING' } })
    expect(service.put).not.toHaveBeenCalled()
    expect(service.requireMember.mock.calls[0][0].authenticatedTenantId).toBe(tenant)
  })
  it('uses only authenticatedTenantId rather than a body or header tenant', async () => {
    const response = await request(app()).put(`${BASE}/task_reminder`).set('x-tenant-id', 'default')
      .send({ expectedRevision: 0, state: 'active', defaultConnectionId: '11111111-1111-4111-8111-111111111111', orgId: 'default' })
    expect(response.body).toEqual({ error: { code: 'ORG_MISSING' } }); expect(service.put).not.toHaveBeenCalled()
  })
  it.each(['orgId', 'userId', 'userid', 'email', 'mobile', 'url', 'webhook', 'address'])('rejects the unknown field %s', async key => {
    expect((await request(app('default')).put(`${BASE}/task_reminder`).send({ expectedRevision: 1, state: 'paused', [key]: 'fixture' })).status).toBe(422)
    expect(service.put).not.toHaveBeenCalled()
  })
  it('passes omitted and explicit-null defaults distinctly to the service', async () => {
    const server = app()
    expect((await request(server).put(`${BASE}/task_reminder`).send({ expectedRevision: 1, state: 'paused' })).status).toBe(200)
    expect(Object.hasOwn(service.put.mock.calls[0][2], 'defaultConnectionId')).toBe(false)
    expect((await request(server).put(`${BASE}/task_reminder`).send({ expectedRevision: 1, state: 'paused', defaultConnectionId: null })).status).toBe(200)
    expect(service.put.mock.calls[1][2].defaultConnectionId).toBeNull()
    expect(service.requireMember).not.toHaveBeenCalled()
  })
  it('has no delete route', async () => {
    expect((await request(app('default')).delete(`${BASE}/task_reminder`)).status).toBe(404)
  })
})

it.each([undefined, 'other', 'default'])('null first takeover passes only trusted tenant %s to the service', async tenant => {
  service.put.mockImplementation(async actor => {
    await service.requireMember(actor)
    return { state: 'active' }
  })
  const response = await request(app(tenant)).put(`${BASE}/task_reminder`).set('x-tenant-id', 'default')
    .send({ expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true })
  expect(response.status).toBe(tenant === 'default' ? 200 : tenant ? 403 : 422)
  expect(service.put.mock.calls[0][0]).toEqual({ actorId: 'fixture-user', authenticatedTenantId: tenant })
})
it.each([
  { expectedRevision: 0, state: 'active', confirmNoDefaultConnection: true },
  { expectedRevision: 0, state: 'paused', defaultConnectionId: null, confirmNoDefaultConnection: true },
])('refuses malformed first takeover at the HTTP boundary', async body => {
  const response = await request(app('default')).put(`${BASE}/task_reminder`).send(body)
  expect(response.status).toBe(422); expect(response.body.error.code).toBe('INVALID_REQUEST')
  expect(service.put).not.toHaveBeenCalled()
})
it('logs refusal as code and a closed topic without request values', async () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  try {
    const response = await request(app()).put(`${BASE}/untrusted-topic`).send({ expectedRevision: 0, state: 'active', defaultConnectionId: 'private-value' })
    expect(response.status).toBe(422)
    expect(warn).toHaveBeenCalledWith('notification_topic_policy_rejected', { code: 'ORG_MISSING', topic: 'unknown' })
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-value|fixture-user|untrusted-topic/)
    expect(response.headers['cache-control']).toBe('no-store')
  } finally { warn.mockRestore() }
})

it.each(['', '/task_reminder/takeover-preview'])('prevents caching GET %s responses', async suffix => {
  const response = await request(app('default')).get(`${BASE}${suffix}`)
  expect(response.status).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
})
