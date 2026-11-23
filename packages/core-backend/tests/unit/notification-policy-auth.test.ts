/** Signed ordinary sessions use the real AuthService and JWT middleware; strict principals are injected only at the continuation boundary. */
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  secret: 'synthetic-notification-policy-session-secret-0123456789',
  query: vi.fn(), strict: vi.fn(), revoked: vi.fn(),
}))
vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: { get: () => ({
  query: fixture.query, transaction: async fn => fn({ query: fixture.query }), getInternalPool: () => ({ query: fixture.query }),
}) } }))
vi.mock('../../src/db/pg', () => ({ pool: { query: fixture.query }, query: fixture.query, transaction: vi.fn() }))
vi.mock('../../src/rbac/service', () => ({ isAdmin: async () => false, listUserPermissions: async () => ['*:*'], invalidateUserPerms: vi.fn() }))
vi.mock('../../src/auth/session-revocation', () => ({ isUserSessionRevoked: fixture.revoked }))
vi.mock('../../src/auth/session-registry', () => ({ isUserSessionActive: async () => true, createUserSession: vi.fn() }))
vi.mock('../../src/security/SecretManager', () => ({ secretManager: { get: key => key === 'JWT_SECRET' ? fixture.secret : undefined } }))
vi.mock('../../src/auth/strict-dingtalk-entry', async original => ({
  ...await original<typeof import('../../src/auth/strict-dingtalk-entry')>(), verifyPersistedStrictSession: fixture.strict,
}))
vi.mock('../../src/routes/me-notification-wiring', () => ({ productionNotificationDbDeps: vi.fn(), productionAuditSink: vi.fn(), productionRecipientResolver: vi.fn(), productionNotificationVerificationSummary: vi.fn() }))
vi.mock('../../src/integrations/integration-capability-resolve', () => ({ resolveEffectiveIntegrationCapability: vi.fn() }))
vi.mock('../../src/notifications/topic-registry', async original => {
  const actual = await original<typeof import('../../src/notifications/topic-registry')>()
  return { ...actual, resolveNotificationTopic: topic => {
    const descriptor = actual.resolveNotificationTopic(topic)
    return descriptor ? { ...descriptor, integrated: true } : null
  } }
})
vi.mock('../../src/notifications/adapters/notification-adapter', () => ({ resolveNotificationAdapter: () => ({ transport: 'work_notification' }) }))

import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { createAdminDirectoryNotificationRouter } from '../../src/routes/admin-directory-notification'
import { createTopicPolicyService } from '../../src/notifications/topic-policy-service'
import { resolveEffectiveIntegrationCapability } from '../../src/integrations/integration-capability-resolve'
import type { RecipientResolver } from '../../src/notifications/recipient-resolver'

// One listener per suite file: every request goes through it, and the app is swapped in just before each request.
const pinned = usePinnedServer()
const via = (app: Parameters<typeof pinned.setApp>[0]) => { pinned.setApp(app); return request(pinned.url()) }

const ID = 'synthetic-policy-admin'
const CONNECTION = '11111111-1111-4111-8111-111111111111'
const PATH = '/api/admin/directory/notification-topic-policies/task_reminder'
let member = true, active = true
const user = () => ({ id: ID, role: 'admin', permissions: ['*:*'], email: 'fixture@example.invalid', name: 'Synthetic',
  is_active: active, activation_status: 'activated', must_change_password: false, created_at: new Date(0), updated_at: new Date(0) })
function setup(enabled = true) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('to_regclass')) return { rows: [{ present: true }] }
    if (sql.startsWith('INSERT')) return { rows: [{ topic: 'task_reminder', state: 'active', default_connection_id: params![3], revision: 1 }] }
    return { rows: [] }
  })
  const members = vi.fn(async (_db, _org, ids: string[]) => new Set(member ? ids : []))
  const service = createTopicPolicyService({ db: { query }, transaction: fn => fn({ query }),
    isActiveOrgMembers: members, resolver: {} as RecipientResolver, deliveryEnabled: () => true,
    audit: async () => {}, verification: async () => ({ ok: true, verification: { level: 'token', verifiedUntil: null, valid: true } }),
  })
  const app = express(); app.use(express.json()); app.use(jwtAuthMiddleware)
  app.use('/api/admin/directory', createAdminDirectoryNotificationRouter({ service, isEnabled: () => enabled }))
  return { app, query, members }
}
function token(tenantId?: string, strict = false) {
  return jwt.sign({ userId: ID, roles: ['admin'], perms: ['*:*'], tenantId,
    ...(strict ? { sid: 'xs.fixture', xa: true } : {}) }, fixture.secret, { expiresIn: '1h' })
}
const body = (connection: string | null = CONNECTION) => ({ expectedRevision: 0, state: 'active', defaultConnectionId: connection,
  ...(connection === null ? { confirmNoDefaultConnection: true } : {}) })
beforeEach(() => {
  vi.clearAllMocks(); member = true; active = true
  vi.stubEnv('RBAC_TOKEN_TRUST', 'false'); vi.stubEnv('NODE_ENV', 'test')
  fixture.revoked.mockResolvedValue(false)
  fixture.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM users WHERE id')) return { rows: [user()] }
    if (sql.includes('FROM user_orgs')) return { rows: member ? [{ org_id: params[1] }] : [] }
    return { rows: [] }
  })
  vi.mocked(resolveEffectiveIntegrationCapability).mockResolvedValue({ effective: true, orgId: 'default', provider: 'dingtalk', revision: 1, witness: 'a'.repeat(64) } as never)
})
afterEach(() => vi.unstubAllEnvs())

it.each([CONNECTION, null])('A-U07/A-U08 signed default member succeeds for default %s', async connection => {
  const s = setup()
  expect((await via(s.app).put(PATH).set('Authorization', `Bearer ${token('default')}`).send(body(connection))).status).toBe(200)
  expect(s.members).toHaveBeenCalledWith(expect.anything(), 'default', [ID])
  if (connection) expect(resolveEffectiveIntegrationCapability).toHaveBeenCalledWith(expect.anything(), { integrationId: connection, expectedOrgId: 'default', capability: 'notification' })
  else expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
})
it.each([CONNECTION, null])('A-U07-c/A-U08 header cannot create a trusted tenant for %s', async connection => {
  const s = setup()
  const r = await via(s.app).put(PATH).set('Authorization', `Bearer ${token()}`).set('x-tenant-id', 'default').send(body(connection))
  expect(r.status).toBe(422); expect(r.body.error.code).toBe('ORG_MISSING')
  expect(s.query).not.toHaveBeenCalled(); expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
})
it('A-U07-i normal verification removes a revoked membership tenant; trusted claims still cannot bypass the service member gate', async () => {
  member = false
  const s = setup()
  let r = await via(s.app).put(PATH).set('Authorization', `Bearer ${token('default')}`).send(body())
  expect(r.status).toBe(422); expect(r.body.error.code).toBe('ORG_MISSING')
  vi.stubEnv('RBAC_TOKEN_TRUST', 'true')
  r = await via(s.app).put(PATH).set('Authorization', `Bearer ${token('default')}`).send(body())
  expect(r.status).toBe(403); expect(r.body.error.code).toBe('ORG_MISMATCH')
  expect(s.query).not.toHaveBeenCalled(); expect(resolveEffectiveIntegrationCapability).not.toHaveBeenCalled()
})
it.each(['inactive', 'revoked'])('ordinary %s sessions fail before policy access', async mode => {
  if (mode === 'inactive') active = false
  else fixture.revoked.mockResolvedValue(true)
  const s = setup()
  expect((await via(s.app).put(PATH).set('Authorization', `Bearer ${token('default')}`).send(body())).status).toBe(401)
  expect(s.members).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled()
})
it.each([
  ['other', undefined, 403, 'ORG_MISMATCH'],
  ['other', 'default', 403, 'SESSION_ORG_NOT_MEMBER'],
  ['default', undefined, 200, undefined],
] as const)('A-U07-e/f/g middleware continuation tenant=%s header=%s', async (tenant, header, status, code) => {
  // Boundary fixture: eligibility of a persisted strict principal is separately tested by strict-dingtalk-entry.
  fixture.strict.mockResolvedValue({ ...user(), tenantId: tenant, strictSessionOrgId: tenant })
  const s = setup()
  let r = via(s.app).put(PATH).set('Authorization', `Bearer ${token(tenant, true)}`)
  if (header) r = r.set('x-tenant-id', header)
  const response = await r.send(body())
  expect(response.status).toBe(status)
  if (code) { expect(response.body.error.code).toBe(code); expect(s.query).not.toHaveBeenCalled() }
  if (header) expect(s.members).not.toHaveBeenCalled()
})
it('A-U07-g a refused strict continuation never enters the management route', async () => {
  fixture.strict.mockResolvedValue(null)
  const s = setup()
  expect((await via(s.app).put(PATH).set('Authorization', `Bearer ${token('default', true)}`).send(body())).status).toBe(401)
  expect(s.members).not.toHaveBeenCalled(); expect(s.query).not.toHaveBeenCalled()
})
