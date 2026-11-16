import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'

const serviceMocks = vi.hoisted(() => ({
  issue: vi.fn(),
  readContext: vi.fn(),
  actualReadContext: null as null | ((req: Request) => unknown),
}))
vi.mock('../../src/auth/security-action-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/security-action-proof')>()
  serviceMocks.actualReadContext = actual.readAuthenticatedSessionContext
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

import { isApiPath, isGateException } from '../../src/auth/api-path-policy'
import { isWhitelisted, jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { correlationErrorHandler, correlationIdMiddleware } from '../../src/middleware/correlation'
import { SecurityActionProofError } from '../../src/auth/security-action-proof'
import type { SecurityActionErrorCode } from '../../src/auth/security-action-proof'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { securityActionParseErrorHandler, securityActionsRouter } from '../../src/routes/security-actions'

const pinned = usePinnedServer()

/** Sends through this suite's pinned server, with `app` installed for the request. */
function via(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

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

/** Collects the response body as the exact bytes sent, whatever its content type. */
function rawBody(res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = []
  res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
  res.on('end', () => done(null, Buffer.concat(chunks)))
}

type Observed = { status: number; bytes: Buffer; headers: Record<string, unknown> }

/**
 * Everything a client can observe of a response: the status, the body bytes (as collected by
 * `rawBody`, or the raw text otherwise) and every header except `date`, which only reflects the
 * second the response was written.
 */
function observed(response: request.Response): Observed {
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => name !== 'date'))
  const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.text ?? '', 'utf8')
  return { status: response.status, bytes, headers }
}

/** The response headers an answer of this route would add; an answer it does not give carries none of them. */
const ROUTE_HEADERS = ['cache-control', 'pragma', 'retry-after'] as const

function send(app: express.Express, path: string, payload: { malformed?: string; json?: Record<string, unknown> }, headers: Record<string, string> = {}) {
  let call = via(app).post(path).set('X-Correlation-ID', 'fixed-correlation-id')
  for (const [name, value] of Object.entries(headers)) call = call.set(name, value)
  call = call.buffer(true).parse(rawBody as never)
  return payload.malformed !== undefined ? call.set('Content-Type', 'application/json').send(payload.malformed) : call.send(payload.json ?? {})
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
  authMocks.verifyToken.mockReset()
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
    const response = await via(appWithStubGate()).post(PATH).send(body())
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
    const response = await via(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, data: issued })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(serviceMocks.issue).toHaveBeenCalledWith(SESSION, expect.objectContaining({ purpose: 'external_identity_unbind', connectionId: CONNECTION, password: PASSWORD }))
  })

  it('refuses with 401 before parsing the body when no session context can be built', async () => {
    serviceMocks.readContext.mockReturnValue(null)
    const response = await via(appWithStubGate()).post(PATH).send({ not: 'parsed' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_SESSION_REQUIRED', message: 'Security action refused' } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })

  it('refuses with 422 naming schema fields only, never the value or the unknown key', async () => {
    const response = await via(appWithStubGate()).post(PATH).send(body({ password: '', secretKeyName: 'secret-value-xyz' }))
    expect(response.status).toBe(422)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_INVALID_REQUEST', message: 'Security action refused', details: { fields: ['_unknown', 'password'] } } })
    expect(JSON.stringify(response.body)).not.toContain('secretKeyName')
    expect(JSON.stringify(response.body)).not.toContain('secret-value-xyz')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })

  it('never echoes or logs the password on any outcome', async () => {
    serviceMocks.issue.mockRejectedValueOnce(new SecurityActionProofError('SECURITY_ACTION_CREDENTIAL_REJECTED', { nextStep: 'admin_assisted_local_credential' }))
    const rejected = await via(appWithStubGate()).post(PATH).send(body())
    serviceMocks.issue.mockRejectedValueOnce(new Error(`unexpected ${PASSWORD}`))
    const failed = await via(appWithStubGate()).post(PATH).send(body())
    for (const response of [rejected, failed]) expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(PASSWORD)
    expect(loggerSpy.lines.join('\n')).not.toContain(PASSWORD)
  })

  it('maps an unexpected failure to 503 with a fixed message and logs only the code', async () => {
    serviceMocks.issue.mockRejectedValueOnce(new Error('driver detail that must stay private'))
    const response = await via(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_UNAVAILABLE', message: 'Security action refused' } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(loggerSpy.lines).toEqual(['security action verification unavailable (code=SECURITY_ACTION_UNAVAILABLE)'])
  })

  it('answers with 503 and no-store when the handler fails before it could answer, without logging', async () => {
    serviceMocks.readContext.mockImplementation(() => { throw new Error(`context failure ${PASSWORD}`) })
    const response = await via(appWithStubGate()).post(PATH).send(body())
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_UNAVAILABLE', message: 'Security action refused' } })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(PASSWORD)
    expect(loggerSpy.lines).toEqual([])
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })

  describe('error handler mounted after the router', () => {
    const MALFORMED = `{"password":"${PASSWORD}"`

    /**
     * The parser, then the router and the handler (only while the switch is on; with `mounted: false`
     * the factory must return null and nothing is mounted), then a final handler that stands in for
     * the application's own error handling: it records what reached it and answers with a marker.
     * Whether the request has a session context is decided by `readAuthenticatedSessionContext`,
     * which the tests stub, so no gate is part of these apps.
     */
    function appWithParser(options: { limit?: string; before?: (req: Request, res: Response, next: NextFunction) => void; mounted?: boolean } = {}) {
      const app = express()
      const reached: unknown[] = []
      if (options.before) app.use(options.before)
      app.use(express.json(options.limit ? { limit: options.limit } : {}))
      const router = securityActionsRouter()
      if (options.mounted === false) {
        if (router) throw new Error('router must not mount')
      } else {
        if (!router) throw new Error('router must mount')
        app.use('/api/auth/security-actions', router)
        app.use('/api/auth/security-actions', securityActionParseErrorHandler)
      }
      app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        reached.push(error)
        res.status(400).json({ answeredBy: 'application' })
      })
      return { app, reached }
    }

    it('answers a body that cannot be parsed, for a request with a session context, with 422 and the fixed field name, no-store, no echo, nothing logged', async () => {
      const { app, reached } = appWithParser()
      const response = await via(app).post(PATH).set('Content-Type', 'application/json').send(MALFORMED)
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_INVALID_REQUEST', message: 'Security action refused', details: { fields: ['_unknown'] } } })
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['pragma']).toBe('no-cache')
      expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(PASSWORD)
      expect(loggerSpy.lines).toEqual([])
      expect(serviceMocks.issue).not.toHaveBeenCalled()
      expect(reached).toEqual([])
    })

    it('answers a body outside the accepted size, for a request with a session context, with 422 and the fixed field name', async () => {
      const { app, reached } = appWithParser({ limit: '1kb' })
      const response = await via(app).post(PATH).send(body({ password: 'p'.repeat(2048) }))
      expect(response.status).toBe(422)
      expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_INVALID_REQUEST', message: 'Security action refused', details: { fields: ['_unknown'] } } })
      expect(response.headers['cache-control']).toBe('no-store')
      expect(serviceMocks.issue).not.toHaveBeenCalled()
      expect(reached).toEqual([])
    })

    it('answers any other failure raised before the handler, for a request with a session context, with 503, a fixed message and no-store', async () => {
      const { app, reached } = appWithParser({ before: () => { throw new Error(`upstream detail ${PASSWORD}`) } })
      const response = await via(app).post(PATH).send(body())
      expect(response.status).toBe(503)
      expect(response.body).toEqual({ ok: false, error: { code: 'SECURITY_ACTION_UNAVAILABLE', message: 'Security action refused' } })
      expect(response.headers['cache-control']).toBe('no-store')
      expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(PASSWORD)
      expect(loggerSpy.lines).toEqual([])
      expect(reached).toEqual([])
    })

    const noContext: ReadonlyArray<[string, () => void]> = [
      ['no session context can be built', () => serviceMocks.readContext.mockReturnValue(null)],
      ['building the session context fails', () => serviceMocks.readContext.mockImplementation(() => { throw new Error(`context failure ${PASSWORD}`) })],
    ]

    it.each(noContext)('passes a failure raised before the handler on untouched when %s: the application answers, the same with the switch on as with it off', async (_label, arrange) => {
      arrange()
      const on = appWithParser()
      const onParse = await via(on.app).post(PATH).set('Content-Type', 'application/json').send(MALFORMED)
      const onUpstream = await via(appWithParser({ before: () => { throw new Error('upstream') } }).app).post(PATH).send(body())
      process.env.SECURITY_ACTION_PROOF_ENABLED = 'false'
      const off = appWithParser({ mounted: false })
      const offParse = await via(off.app).post(PATH).set('Content-Type', 'application/json').send(MALFORMED)
      const offUpstream = await via(appWithParser({ before: () => { throw new Error('upstream') }, mounted: false }).app).post(PATH).send(body())
      for (const [mounted, unmounted] of [[onParse, offParse], [onUpstream, offUpstream]]) {
        expect(mounted.status).toBe(400)
        expect(mounted.body).toEqual({ answeredBy: 'application' })
        // Status, body bytes and every header but the date are the same with and without the route.
        expect(observed(mounted)).toEqual(observed(unmounted))
        for (const name of ROUTE_HEADERS) expect(mounted.headers[name]).toBeUndefined()
      }
      // The same error object the parser raised reaches the application's handler, with and without the route.
      expect(on.reached).toHaveLength(1)
      expect(off.reached).toHaveLength(1)
      expect((on.reached[0] as { type?: unknown }).type).toBe('entity.parse.failed')
      expect((on.reached[0] as Error).message).toBe((off.reached[0] as Error).message)
      expect(serviceMocks.issue).not.toHaveBeenCalled()
      expect(loggerSpy.lines).toEqual([])
    })

    /**
     * The production order of the pieces that can answer a request on this prefix before or instead of
     * the route: correlation id, the global body parsers with their production options, the session
     * gate (gate exceptions pass, API paths go through the real `jwtAuthMiddleware`), a route on the
     * auth prefix that is a gate exception, a gated route on the auth prefix and one outside it, the
     * security action route and its error handler only while the switch is on, and the application's
     * own error handler last. The source order and the parser options are pinned against index.ts by
     * the inert wiring test.
     */
    function productionShapedApp(mounted: boolean) {
      const app = express()
      const logged: string[] = []
      app.use(correlationIdMiddleware)
      app.use(express.json({ limit: '10mb' }))
      app.use(express.urlencoded({ extended: true }))
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (isWhitelisted(req.path)) return next()
        if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)
        return next()
      })
      const echo = (req: Request, res: Response) => { res.status(200).json({ keys: Object.keys(req.body ?? {}).sort() }) }
      app.post('/api/auth/login', echo)
      app.post('/api/auth/sibling', echo)
      app.post('/api/elsewhere', echo)
      const router = securityActionsRouter()
      if (mounted) {
        if (!router) throw new Error('router must mount')
        app.use('/api/auth/security-actions', router)
        app.use('/api/auth/security-actions', securityActionParseErrorHandler)
      } else if (router) {
        throw new Error('router must not mount')
      }
      app.use(correlationErrorHandler({ error: (message: string) => { logged.push(message) } }, 'production'))
      return { app, logged }
    }

    async function onAndOff(path: string, payload: { malformed?: string; json?: Record<string, unknown> }, headers: Record<string, string> = {}) {
      process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
      const on = productionShapedApp(true)
      const onResponse = await send(on.app, path, payload, headers)
      process.env.SECURITY_ACTION_PROOF_ENABLED = 'false'
      const off = productionShapedApp(false)
      const offResponse = await send(off.app, path, payload, headers)
      process.env.SECURITY_ACTION_PROOF_ENABLED = 'true'
      return { on: observed(onResponse), off: observed(offResponse), onLogged: on.logged, offLogged: off.logged }
    }

    const PRE_AUTH: ReadonlyArray<[string, { malformed?: string; json?: Record<string, unknown> }, number]> = [
      ['a body that cannot be parsed', { malformed: MALFORMED }, 400],
      ['a well-formed body', { json: body() }, 401],
      ['an empty body', { json: {} }, 401],
    ]

    it.each(PRE_AUTH)('gives an unauthenticated request with %s the same status, body bytes and headers with the switch on as with it off, behind the real session gate', async (_label, payload, status) => {
      serviceMocks.readContext.mockImplementation(serviceMocks.actualReadContext!)
      const { on, off, onLogged, offLogged } = await onAndOff(PATH, payload)
      expect(on.status).toBe(status)
      expect(on).toEqual(off)
      expect(on.bytes.equals(off.bytes)).toBe(true)
      // The comparison covers the headers that describe the body and the stack, so it is not vacuous.
      for (const name of ['content-type', 'content-length', 'etag', 'x-powered-by', 'x-correlation-id']) expect(on.headers[name], name).toBeDefined()
      for (const name of [...ROUTE_HEADERS, 'vary', 'set-cookie']) {
        expect(on.headers[name], name).toBeUndefined()
        expect(off.headers[name], name).toBeUndefined()
      }
      expect(onLogged).toEqual(offLogged)
      expect(serviceMocks.issue).not.toHaveBeenCalled()
      expect(loggerSpy.lines).toEqual([])
    })

    const OTHER_ROUTES: ReadonlyArray<[string, string]> = [
      ['a gate exception on the auth prefix', '/api/auth/login'],
      ['a gated route on the auth prefix', '/api/auth/sibling'],
      ['a gated route outside the auth prefix', '/api/elsewhere'],
    ]

    it.each(OTHER_ROUTES)('leaves %s answering exactly as without the route: a body that cannot be parsed, a well-formed body anonymously and with a session', async (_label, path) => {
      serviceMocks.readContext.mockImplementation(serviceMocks.actualReadContext!)
      authMocks.verifyToken.mockResolvedValue({ id: USER, role: 'user' })
      const anonymous = { malformed: MALFORMED }
      for (const [payload, headers] of [
        [anonymous, {}],
        [anonymous, { Authorization: 'Bearer t' }],
        [{ json: body() }, {}],
        [{ json: body() }, { Authorization: 'Bearer t' }],
      ] as const) {
        const { on, off, onLogged, offLogged } = await onAndOff(path, payload, headers)
        expect(on).toEqual(off)
        expect(on.bytes.equals(off.bytes)).toBe(true)
        expect(onLogged).toEqual(offLogged)
        for (const name of ROUTE_HEADERS) expect(on.headers[name], name).toBeUndefined()
      }
      // The well-formed body still reaches a route that accepts it, parsed by the global parser.
      const reached = await onAndOff(path, { json: body() }, { Authorization: 'Bearer t' })
      expect(reached.on.status).toBe(200)
      expect(JSON.parse(reached.on.bytes.toString('utf8'))).toEqual({ keys: Object.keys(body()).sort() })
      expect(serviceMocks.issue).not.toHaveBeenCalled()
    })

    it('writes nothing to a response whose headers were already sent, and closes one that is still open', () => {
      const fakeResponse = (state: { writableEnded: boolean; destroyed: boolean }) => ({
        headersSent: true, ...state, setHeader: vi.fn(), status: vi.fn(), json: vi.fn(), destroy: vi.fn(),
      })
      const ended = fakeResponse({ writableEnded: true, destroyed: false })
      securityActionParseErrorHandler(new Error('late'), {} as Request, ended as unknown as Response, vi.fn() as unknown as NextFunction)
      expect(ended.setHeader).not.toHaveBeenCalled()
      expect(ended.status).not.toHaveBeenCalled()
      expect(ended.destroy).not.toHaveBeenCalled()
      const open = fakeResponse({ writableEnded: false, destroyed: false })
      securityActionParseErrorHandler(new Error('late'), {} as Request, open as unknown as Response, vi.fn() as unknown as NextFunction)
      expect(open.setHeader).not.toHaveBeenCalled()
      expect(open.status).not.toHaveBeenCalled()
      expect(open.destroy).toHaveBeenCalledTimes(1)
    })
  })

  it('hands the service the organization the gate authenticated, never a header', async () => {
    serviceMocks.readContext.mockImplementation((req: Request) => ({ userId: USER, sessionId: 'sid', tokenIssuedAt: 1, orgId: req.authenticatedTenantId ?? null }))
    serviceMocks.issue.mockResolvedValue({})
    await via(appWithStubGate({ tenant: ORG })).post(PATH).set('x-tenant-id', 'header-org').send(body())
    expect(serviceMocks.issue.mock.calls[0][0].orgId).toBe(ORG)
    await via(appWithStubGate({ user: { id: USER, tenantId: 'user-org' } })).post(PATH).set('x-tenant-id', 'header-org').send(body())
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
    const changeRequired = await via(app).post(PATH).set('Authorization', 'Bearer t').send(body())
    expect(changeRequired.status).toBe(403)
    expect(changeRequired.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(serviceMocks.issue).not.toHaveBeenCalled()
    const anonymous = await via(app).post(PATH).send(body())
    expect(anonymous.status).toBe(401)
    expect(serviceMocks.issue).not.toHaveBeenCalled()
  })
})
