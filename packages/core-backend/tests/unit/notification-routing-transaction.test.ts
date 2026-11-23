import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const client = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ pool: { connect: async () => client }, query: vi.fn() }))
vi.mock('../../src/routes/admin-directory', () => ({ ensurePlatformAdmin: async () => 'fixture-admin' }))
vi.mock('../../src/services/task-org-members', () => ({ findActiveOrgMembers: async () => new Set(['fixture-admin']) }))
vi.mock('../../src/routes/me-notification-wiring', () => ({ productionNotificationDbDeps: () => ({ db: { query: vi.fn() } }),
  productionAuditSink: vi.fn(), productionRecipientResolver: vi.fn(), productionNotificationVerificationSummary: vi.fn() }))
vi.mock('../../src/notifications/topic-registry', async original => {
  const actual = await original<typeof import('../../src/notifications/topic-registry')>()
  return { ...actual, resolveNotificationTopic: topic => ({ ...actual.resolveNotificationTopic(topic), integrated: true }) }
})
import { routedCapabilityTransaction } from '../../src/services/task-routed-reminders'
import { adminDirectoryNotificationRouter } from '../../src/routes/admin-directory-notification'

// One listener per suite file: every request goes through it, and the app is swapped in just before each request.
const pinned = usePinnedServer()
const via = (app: Parameters<typeof pinned.setApp>[0]) => { pinned.setApp(app); return request(pinned.url()) }
const failure = Object.assign(new Error('Synthetic statement failure'), { code: '57014' })
beforeEach(() => {
  vi.clearAllMocks()
  client.query.mockImplementation(async sql => {
    if (sql === 'ROLLBACK') throw new Error('Synthetic rollback failure')
    if (sql.includes('to_regclass')) throw failure
    return { rows: [] }
  })
})
afterEach(() => vi.unstubAllEnvs())
it('discards a routing authority connection after failed rollback and preserves the original error', async () => {
  await expect(routedCapabilityTransaction(async () => { throw failure })).rejects.toBe(failure)
  expect(client.release).toHaveBeenCalledWith(true)
})
it('discards a management transaction connection after failed rollback', async () => {
  vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'true'); vi.stubEnv('EXTERNAL_NOTIFICATION_DELIVERY_ENABLED', 'true')
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.authenticatedTenantId = 'default'; next() })
  app.use(adminDirectoryNotificationRouter())
  const response = await via(app).put('/notification-topic-policies/task_reminder').send({
    expectedRevision: 0, state: 'active', defaultConnectionId: null, confirmNoDefaultConnection: true,
  })
  expect(response.status).toBe(503); expect(response.body.error.code).toBe('NOTIFICATION_BUSY')
  expect(client.release).toHaveBeenCalledWith(true)
})
