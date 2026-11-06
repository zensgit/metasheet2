import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const serviceMocks = vi.hoisted(() => ({
  issue: vi.fn(),
  readContext: vi.fn(),
}))
vi.mock('../../src/auth/security-action-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/security-action-proof')>()
  serviceMocks.readContext.mockImplementation(actual.readAuthenticatedSessionContext)
  return { ...actual, issueSecurityActionProof: serviceMocks.issue, readAuthenticatedSessionContext: serviceMocks.readContext }
})
const authMocks = vi.hoisted(() => ({ verifyToken: vi.fn(), readTokenPayload: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: { verifyToken: authMocks.verifyToken, readTokenPayload: authMocks.readTokenPayload } }))
vi.mock('../../src/metrics/metrics', () => ({ metrics: { jwtAuthFail: { inc: vi.fn() }, authFailures: { inc: vi.fn() } } }))
vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: vi.fn(), transaction: vi.fn(), getInternalPool: () => null }) },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))
const loggerSpy = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../../src/core/logger', () => ({
  Logger: class { info(m: string) { loggerSpy.lines.push(String(m)) } warn(m: string) { loggerSpy.lines.push(String(m)) } error(m: string) { loggerSpy.lines.push(String(m)) } debug(m: string) { loggerSpy.lines.push(String(m)) } },
}))

import { isGateException } from '../../src/auth/api-path-policy'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { SecurityActionProofError } from '../../src/auth/security-action-proof'
import type { SecurityActionErrorCode } from '../../src/auth/security-action-proof'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { securityActionsRouter } from '../../src/routes/security-actions'

const PATH = '/api/auth/security-actions/verify'
const USER = 'user-route'
const ORG = 'org-route'
const CONNECTION = '11111111-2222-4333-8444-555555555555'
const TARGET = '66666666-7777-4888-8999-000000000000'
const PASSWORD = 'route-secret-not-to-be-echoed'
const SESSION = { userId: USER, sessionId: 'sid-route', tokenIssuedAt: 1_700_000_000, orgId: ORG }

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { purpose: 'external_identity_unbind', connectionId: CONNECTION, targetIdentityId: TARGET, expectedBindingRevision: 1, method: 'local_password', password: PASSWORD, ...overrides }
}

function appWithStubGate(options: { user?: Record<string, unknown> | null; tenant?: string } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (options.user !== null) req.user = (options.user ?? { id: USER }) as Request['user']
    if (options.tenant !== undefined) req.authenticatedTenantId = options.tenant
    next()
  })
  const router = securityActionsRouter()
  if (!router) throw new Error('router must mount')
  app.use('/api/auth/security-actions', router)
  return app
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.SECURITY_ACTION_PROOF_ENABLED
  process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
  serviceMocks.issue.mockReset()
  serviceMocks.readContext.mockReset()
  serviceMocks.readContext.mockReturnValue(SESSION)
  loggerSpy.lines.length = 0
})
afterEach(() => {
  if (saved === undefined) delete process.env.SECURITY_ACTION_PROOF_ENABLED
  else process.env.SECURITY_ACTION_PROOF_ENABLED = saved
})

const STATUS_BY_CODE: ReadonlyArray<[SecurityActionErrorCode, number, Record<string, unknown> | undefined]> = [
  ['SECURITY_ACTION_SESSION_REQUIRED', 401, undefined],
  ['SECURITY_ACTION_PURPOSE_UNAVAILABLE', 403, undefined],
  ['SECURITY_ACTION_METHOD_UNAVAILABLE', 403, { nextStep: 'admin_assisted_local_credential' }],
  ['SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED', 403, undefined],
  ['SECURITY_ACTION_ASSURANCE_INSUFFICIENT', 403, undefined],
  ['SECURITY_ACTION_CONNECTION_NOT_PERMITTED', 403, undefined],
  ['SECURITY_ACTION_CREDENTIAL_REJECTED', 403, { nextStep: 'admin_assisted_local_credential' }],
  ['SECURITY_ACTION_ORG_CONTEXT_REQUIRED', 409, undefined],
  ['SECURITY_ACTION_TARGET_CONFLICT', 409, undefined],
  ['SECURITY_ACTION_STATE_CHANGED', 409, undefined],
  ['SECURITY_ACTION_RATE_LIMITED', 429, { retryAfter: 77, nextStep: 'admin_assisted_local_credential' }],
  ['SECURITY_ACTION_UNAVAILABLE', 503, undefined],
  ['SECURITY_ACTION_PROOF_UNAVAILABLE', 503, undefined],
]

describe('POST /api/auth/security-actions/verify', () => {
  it.each(STATUS_BY_CODE)('maps %s to %i with its closed-set details', async (code, status, details) => {
    serviceMocks.issue.mockRejectedValueOnce(new SecurityActionProofError(code, details as never))
    const response = await request(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(status)
    expect(response.body).toEqual({ ok: false, error: { code, message: 'Security action refused', ...(details ? { details } : {}) } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['pragma']).toBe('no-cache')
    if (code === 'SECURITY_ACTION_RATE_LIMITED') expect(response.headers['retry-after']).toBe('77')
    else expect(response.headers['retry-after']).toBeUndefined()
  })

  it('returns the issued proof with 200 and no-store', async () => {
    const issued = { proof: 'sap1.x.y', purpose: 'external_identity_unbind', connectionId: CONNECTION, method: 'local_password', assurance: 'local_password', expiresAt: '2026-01-01T00:05:00.000Z', ttlSeconds: 300 }
    serviceMocks.issue.mockResolvedValueOnce(issued)
    const response = await request(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, data: issued })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(serviceMocks.issue).toHaveBeenCalledWith(SESSION, expect.objectContaining({ purpose: 'external_identity_unbind', connectionId: CONNECTION, password: PASSWORD }))
  })

  it('refuses with 401 before parsing the body when no session context can be built', async () => {
    serviceMocks.readContext.mockReturnValue(null)
    const response = await request(appWithStubGate()).post(PATH).send({ not: 'parsed' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_SESSION_REQUIRED', message: 'Security action refused' } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })

  it('refuses with 422 naming schema fields only, never the value or the unknown key', async () => {
    const response = await request(appWithStubGate()).post(PATH).send(body({ password: '', secretKeyName: 'secret-value-xyz' }))
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_INVALID_REQUEST', message: 'Security action refused', details: { fields: ['_unknown', 'password'] } } })
    expect(JSON.stringify(response.body)).not.toContain('secretKeyName')
    expect(JSON.stringify(response.body)).not.toContain('secret-value-xyz')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })

  it('never echoes or logs the password on any outcome', async () => {
    serviceMocks.issue.mockRejectedValueOnce(new SecurityActionProofError('SECURITY_ACTION_CREDENTIAL_REJECTED', { nextStep: 'admin_assisted_local_credential' }))
    const rejected = await request(appWithStubGate()).post(PATH).send(body())
    serviceMocks.issue.mockRejectedValueOnce(new Error(`unexpected ${PASSWORD}`))
    const failed = await request(appWithStubGate()).post(PATH).send(body())
    for (const response of [rejected, failed]) expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(PASSWORD)
    expect(loggerSpy.lines.join('\n')).not.toContain(PASSWORD)
  })

  it('maps an unexpected failure to 503 with a fixed message and logs only the code', async () => {
    serviceMocks.issue.mockRejectedValueOnce(new Error('driver detail that must stay private'))
    const response = await request(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_UNAVAILABLE', message: 'Security action refused' } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(loggerSpy.lines).toEqual(['security action verification unavailable (code=SECURITY_ACTION_UNAVAILABLE)'])
  })

  it('hands the service the organization the gate authenticated, never a header', async () => {
    serviceMocks.readContext.mockImplementation((req: Request) => ({ userId: USER, sessionId: 'sid', tokenIssuedAt: 1, orgId: req.authenticatedTenantId ?? null }))
    serviceMocks.issue.mockResolvedValue({})
    await request(appWithStubGate({ tenant: ORG })).post(PATH).set('x-tenant-id', 'header-org').send(body())
    expect(serviceMocks.issue.mock.calls[0][0].orgId).toBe(ORG)
    await request(appWithStubGate({ user: { id: USER, tenantId: 'user-org' } })).post(PATH).set('x-tenant-id', 'header-org').send(body())
    expect(serviceMocks.issue.mock.calls[1][0].orgId).toBeNull()
  })

  it('stays behind the global session gate and the password-change gate, and outside the OAPI allowlist', async () => {
    expect(isGateException(PATH)).toBe(false)
    expect(isOapiAllowlistRequest('POST', PATH, 'Bearer mst_x')).toBe(false)
    const app = express()
    app.use(express.json())
    app.use('/api', jwtAuthMiddleware)
    const router = securityActionsRouter()
    app.use('/api/auth/security-actions', router!)
    authMocks.verifyToken.mockResolvedValueOnce({ id: USER, must_change_password: true, role: 'user' })
    const changeRequired = await request(app).post(PATH).set('Authorization', 'Bearer t').send(body())
    expect(changeRequired.status).toBe(403)
    expect(changeRequired.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
    const anonymous = await request(app).post(PATH).send(body())
    expect(anonymous.status).toBe(401)
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })
})
