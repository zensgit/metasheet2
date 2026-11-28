/**
 * API token create and rotate routes with the real issuance fence over a recording Kysely, plus the
 * bearer equivalence of the route credential and the real `authenticate` middleware.
 */
import { readFileSync } from 'node:fs'
import * as nodePath from 'node:path'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import * as jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordedStatement, StatementResponder } from '../helpers/recording-kysely'

const fake = vi.hoisted(() => ({
  responder: null as null | ((statement: { sql: string; params: readonly unknown[] }) => Record<string, unknown>[]),
  log: [] as Array<{ sql: string; params: readonly unknown[] }>,
}))

const authGate = vi.hoisted(() => ({ authenticate: vi.fn() }))

vi.mock('../../src/db/db', async () => {
  const { createRecordingKysely } = await import('../helpers/recording-kysely')
  const recording = createRecordingKysely((statement) => {
    fake.log.push(statement)
    if (!fake.responder) throw new Error('no responder installed')
    return fake.responder(statement)
  })
  return { db: recording.db }
})

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: vi.fn(async () => { throw new Error('pool is not available in this test') }),
      transaction: vi.fn(async () => { throw new Error('pool is not available in this test') }),
      getInternalPool: () => ({}),
    }),
  },
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => { throw new Error('pool is not available in this test') }),
  transaction: vi.fn(),
  pool: null,
}))

vi.mock('../../src/auth/session-revocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/session-revocation')>()
  return { ...actual, isUserSessionRevoked: vi.fn(async () => false) }
})

vi.mock('../../src/auth/session-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/session-registry')>()
  return { ...actual, isUserSessionActive: vi.fn(async () => true) }
})

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
  authMiddleware: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
  default: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
}))

import { authService } from '../../src/auth/AuthService'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { apiTokenBearer } from '../../src/auth/strict-credential-chain'
import { ApiTokenIssuanceError, issuanceCredentialFromSessionClaims } from '../../src/multitable/api-token-issuance'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { apiTokensRouter } from '../../src/routes/api-tokens'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import { issuanceResponder, issuanceStatementKind } from '../helpers/recording-kysely'
import { usePinnedServer } from '../utils/pinned-server'

const GENERATION = 2
const USER_A = 'user-issuance-a'
const SID_A = 'sess.issuance-a'
const SID_B = 'sess.issuance-b'
const sessionSecret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
const OLD_TOKEN_ROW = {
  id: 'route-old-token',
  name: 'old',
  token_hash: 'b'.repeat(64),
  token_prefix: 'mst_bbbb',
  scopes: JSON.stringify(['records:read']),
  created_by: USER_A,
  created_at: '2026-11-01T00:00:00.000Z',
  revoked: false,
}
const CREATE_PATH = '/api/multitable/api-tokens'
const ROTATE_PATH = '/api/multitable/api-tokens/route-old-token/rotate'

function sessionUser(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    role: 'member',
    permissions: [] as string[],
    created_at: new Date(0),
    updated_at: new Date(0),
  }
}

/** Ordinary session token of `userId` with a fixed sid and iat. */
function sessionToken(userId: string, sid: string | undefined, iat: number): string {
  return jwt.sign({ userId, email: `${userId}@example.test`, role: 'member', ...(sid ? { sid } : {}), iat }, sessionSecret, { expiresIn: '1h' })
}

function strictToken(): string {
  return authService.createToken(sessionUser(USER_A), { sid: 'xs.issuance-strict', externalAuth: true })
}

const NOW_S = Math.floor(Date.now() / 1000)
const IAT_A = NOW_S - 30
const IAT_B = NOW_S - 600
const TOKEN_A = sessionToken(USER_A, SID_A, IAT_A)
const TOKEN_B = sessionToken(USER_A, SID_B, IAT_B)

function install(responder: StatementResponder): void {
  fake.log.length = 0
  fake.responder = responder as typeof fake.responder
}

function recorded(kind: string): RecordedStatement[] {
  return fake.log.filter((statement) => issuanceStatementKind(statement.sql) === kind)
}

function expectNoTokenWrite(): void {
  expect(recorded('token-insert')).toEqual([])
  expect(recorded('token-update')).toEqual([])
}

authGate.authenticate.mockImplementation((req: Request, res: Response, next: NextFunction) => {
  const payload = authService.readTokenPayload(apiTokenBearer(req.headers.authorization))
  if (!payload?.userId) {
    res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
    return
  }
  const override = req.headers['x-test-authenticated-user']
  req.user = { id: typeof override === 'string' ? override : payload.userId, access_generation: GENERATION } as Express.Request['user']
  next()
})

describe('issuance routes over the real fence', () => {
  const pinned = usePinnedServer()

  beforeAll(() => {
    const app = express()
    app.use(express.json())
    app.use(apiTokensRouter())
    pinned.setApp(app)
  })

  beforeEach(() => {
    install(issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION } }))
  })

  function post(path: string, authorization: string) {
    return request(pinned.url()).post(path).set('Authorization', authorization).send({ name: 'route', scopes: ['records:read'] })
  }

  it('create and rotate succeed for a live ordinary session', async () => {
    const created = await post(CREATE_PATH, `Bearer ${TOKEN_A}`)
    expect(created.status).toBe(201)
    expect(recorded('token-insert')).toHaveLength(1)
    install(issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION } }))
    const rotated = await post(ROTATE_PATH, `Bearer ${TOKEN_A}`)
    expect(rotated.status).toBe(200)
    expect(recorded('token-update')).toHaveLength(1)
    expect(recorded('token-insert')).toHaveLength(1)
  })

  describe('U19 the credential comes from the authenticating bearer token only', () => {
    const others = [
      { label: 'cookie with another session', apply: (r: request.Test) => r.set('Cookie', `token=${TOKEN_B}; session=${SID_B}`) },
      { label: 'another header with another session', apply: (r: request.Test) => r.set('X-Access-Token', TOKEN_B).set('X-Session-Id', SID_B) },
      { label: 'cookie with a strict token', apply: (r: request.Test) => r.set('Cookie', `token=${strictToken()}`) },
      { label: 'another header with a strict token', apply: (r: request.Test) => r.set('X-Access-Token', strictToken()) },
    ]

    it.each(others.flatMap((other) => [CREATE_PATH, ROTATE_PATH].map((path) => ({ ...other, path }))))(
      '$label on $path: the re-reads use the sid and iat of the Authorization token',
      async ({ apply, path }) => {
        const response = await apply(
          request(pinned.url()).post(path).set('Authorization', `Bearer ${TOKEN_A}`),
        ).send({ name: 'route', scopes: ['records:read'], token: TOKEN_B, sessionId: SID_B, sid: SID_B, iat: IAT_B, issuedAt: IAT_B })
        expect([200, 201]).toContain(response.status)
        expect(recorded('session-read').map((statement) => statement.params)).toEqual([[SID_A, USER_A]])
        expect(recorded('watermark-read').map((statement) => statement.params)).toEqual([[USER_A, IAT_A]])
      },
    )

    it('a token without a sid skips the session read even when another field carries one', async () => {
      const noSid = sessionToken(USER_A, undefined, IAT_A)
      const response = await request(pinned.url())
        .post(CREATE_PATH)
        .set('Authorization', `Bearer ${noSid}`)
        .set('Cookie', `token=${TOKEN_B}`)
        .send({ name: 'route', scopes: ['records:read'], sessionId: SID_B })
      expect(response.status).toBe(201)
      expect(recorded('session-read')).toEqual([])
      expect(recorded('watermark-read').map((statement) => statement.params)).toEqual([[USER_A, IAT_A]])
    })

    it('a bearer subject other than the authenticated user refuses with 409 before any SQL', async () => {
      const response = await request(pinned.url())
        .post(CREATE_PATH)
        .set('Authorization', `Bearer ${TOKEN_A}`)
        .set('X-Test-Authenticated-User', 'someone-else')
        .send({ name: 'route', scopes: ['records:read'] })
      expect(response.status).toBe(409)
      expect(response.body.error.code).toBe('AUTHENTICATION_CHANGED')
      expect(fake.log).toEqual([])
    })
  })

  describe('route answers for fence refusals', () => {
    it.each([CREATE_PATH, ROTATE_PATH])('a revoked session row on %s is 409 AUTHENTICATION_CHANGED without a token write', async (path) => {
      install(issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION }, sessionRows: [] }))
      const response = await post(path, `Bearer ${TOKEN_A}`)
      expect(response.status).toBe(409)
      expect(response.body).toEqual({ ok: false, error: { code: 'AUTHENTICATION_CHANGED', message: 'Authentication changed; please sign in again' } })
      expectNoTokenWrite()
    })

    it.each([CREATE_PATH, ROTATE_PATH])('U16 a busy user lock on %s is a retryable 409 with Retry-After, not 500', async (path) => {
      const base = issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION } })
      install((statement) => {
        if (issuanceStatementKind(statement.sql) === 'users-for-share') throw Object.assign(new Error('lock timeout'), { code: '55P03' })
        return base(statement)
      })
      const response = await post(path, `Bearer ${TOKEN_A}`)
      expect(response.status).toBe(409)
      expect(response.headers['retry-after']).toBe('1')
      expect(response.body.error.code).toBe('API_TOKEN_ISSUANCE_BUSY')
      expectNoTokenWrite()
    })

    it.each([CREATE_PATH, ROTATE_PATH])('an isolation level other than READ COMMITTED on %s is 503 API_TOKEN_ISSUANCE_UNAVAILABLE', async (path) => {
      install(issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION }, isolation: 'repeatable read' }))
      const response = await post(path, `Bearer ${TOKEN_A}`)
      expect(response.status).toBe(503)
      expect(response.headers['retry-after']).toBeUndefined()
      expect(response.body.error.code).toBe('API_TOKEN_ISSUANCE_UNAVAILABLE')
      expect(recorded('advisory-shared')).toEqual([])
      expectNoTokenWrite()
    })

    it('a session read error on create is a 500 without a token write', async () => {
      const base = issuanceResponder({ tokenRow: OLD_TOKEN_ROW, account: { access_generation: GENERATION } })
      install((statement) => {
        if (issuanceStatementKind(statement.sql) === 'session-read') throw Object.assign(new Error('relation "user_sessions" does not exist'), { code: '42P01' })
        return base(statement)
      })
      const response = await post(CREATE_PATH, `Bearer ${TOKEN_A}`)
      expect(response.status).toBe(500)
      expectNoTokenWrite()
    })
  })

  describe('C18 the authenticating token expires between authenticate and the fence', () => {
    // Signed with the session secret, issued two hours ago with a one-hour lifetime: it verifies by
    // signature, but a read that checks expiry answers null.
    const EXPIRED_IAT = NOW_S - 7200
    const EXPIRED = sessionToken(USER_A, SID_A, EXPIRED_IAT)

    /** authenticate ran while the token was still valid: req.user is set from its claims. */
    function authenticatedBeforeExpiry(): void {
      authGate.authenticate.mockImplementationOnce((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: USER_A, access_generation: GENERATION } as Express.Request['user']
        next()
      })
    }

    it('the fixture token is expired for the claims read and still carries a sid and iat', () => {
      expect(authService.readTokenPayload(EXPIRED)).toBeNull()
      expect(authService.readTokenPayload(EXPIRED, { ignoreExpiration: true })).toMatchObject({ userId: USER_A, sid: SID_A, iat: EXPIRED_IAT })
    })

    it.each([CREATE_PATH, ROTATE_PATH])('%s refuses with 409 AUTHENTICATION_CHANGED and sends no SQL', async (path) => {
      authenticatedBeforeExpiry()
      const response = await post(path, `Bearer ${EXPIRED}`)
      expect(response.status).toBe(409)
      expect(response.body).toEqual({ ok: false, error: { code: 'AUTHENTICATION_CHANGED', message: 'Authentication changed; please sign in again' } })
      expect(fake.log).toEqual([])
    })

    it('claims that read as null are refused, not turned into an undated credential without a sid', () => {
      let thrown: unknown
      try {
        issuanceCredentialFromSessionClaims(null, USER_A, GENERATION)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ApiTokenIssuanceError)
      expect((thrown as ApiTokenIssuanceError).code).toBe('AUTHENTICATION_CHANGED')
      expect((thrown as ApiTokenIssuanceError).statusCode).toBe(409)
    })
  })

  describe('U7 an API token cannot reach the token management routes', () => {
    const management = [
      ['GET', '/api/multitable/api-tokens'], ['POST', '/api/multitable/api-tokens'],
      ['GET', '/api/multitable/tokens'], ['POST', '/api/multitable/tokens'],
      ['DELETE', '/api/multitable/api-tokens/route-old-token'], ['DELETE', '/api/multitable/tokens/route-old-token'],
      ['POST', '/api/multitable/api-tokens/route-old-token/rotate'], ['POST', '/api/multitable/tokens/route-old-token/rotate'],
    ] as const

    it.each(management)('%s %s is not on the API token allowlist, so the global gate answers 401', (method, path) => {
      expect(isOapiAllowlistRequest(method, path, `Bearer mst_${'c'.repeat(32)}`)).toBe(false)
    })

    it.each([CREATE_PATH, ROTATE_PATH])('an API token bearer on %s is refused by authentication and reaches no SQL', async (path) => {
      const response = await post(path, `Bearer mst_${'c'.repeat(32)}`)
      expect(response.status).toBe(401)
      expect(fake.log).toEqual([])
    })
  })

  describe('U7 strict sessions stay refused before authentication', () => {
    it.each([CREATE_PATH, ROTATE_PATH])('a strict session on %s is 403 and reaches no SQL', async (path) => {
      authGate.authenticate.mockClear()
      const response = await post(path, `Bearer ${strictToken()}`)
      expect(response.status).toBe(403)
      expect(response.body.error.code).toBe('API_TOKEN_STRICT_SESSION_DENIED')
      expect(authGate.authenticate).not.toHaveBeenCalled()
      expect(fake.log).toEqual([])
    })
  })
})

describe('U18 the route bearer is the token authenticate verified', () => {
  const trust = process.env.RBAC_TOKEN_TRUST
  const verified: string[] = []
  const realVerify = authService.verifyToken.bind(authService)

  beforeAll(() => {
    process.env.RBAC_TOKEN_TRUST = 'false'
    vi.spyOn(authService, 'verifyToken').mockImplementation(async (token, options) => {
      verified.push(token)
      return realVerify(token, options)
    })
    vi.spyOn(authService as unknown as { getUserById: (id: string) => Promise<unknown> }, 'getUserById').mockImplementation(async (id: string) => ({
      ...sessionUser(id),
      role: 'user',
      is_active: true,
      must_change_password: false,
      activation_status: 'activated',
      local_password_set: true,
      password_hash: 'unused',
      access_generation: GENERATION,
      deleted_at: null,
      purged_at: null,
    }))
  })

  afterAll(() => {
    if (trust === undefined) delete process.env.RBAC_TOKEN_TRUST
    else process.env.RBAC_TOKEN_TRUST = trust
    vi.restoreAllMocks()
  })

  async function authenticateWith(header: unknown, hasHeader = true): Promise<boolean> {
    const req = {
      headers: hasHeader ? { authorization: header } : {},
      path: CREATE_PATH,
      originalUrl: CREATE_PATH,
      method: 'POST',
      query: {},
      body: {},
    } as unknown as Request
    let passed = false
    const res = {
      status() { return res },
      json() { return res },
    } as unknown as Response
    try {
      await jwtAuthMiddleware(req, res, () => { passed = true })
    } catch {
      return false
    }
    return passed
  }

  const T = TOKEN_A
  const headers: Array<{ label: string; value: unknown; present?: boolean }> = [
    { label: 'standard', value: `Bearer ${T}` },
    { label: 'lower-case scheme', value: `bearer ${T}` },
    { label: 'upper-case scheme', value: `BEARER ${T}` },
    { label: 'two spaces', value: `Bearer  ${T}` },
    { label: 'tab separator', value: `Bearer\t${T}` },
    { label: 'trailing space', value: `Bearer ${T} ` },
    { label: 'trailing tab', value: `Bearer ${T}\t` },
    { label: 'trailing newline', value: `Bearer ${T}\n` },
    { label: 'trailing content', value: `Bearer ${T} extra` },
    { label: 'two tokens', value: `Bearer ${T} ${T}` },
    { label: 'appended byte', value: `Bearer ${T}x` },
    { label: 'leading space', value: ` Bearer ${T}` },
    { label: 'empty value', value: '' },
    { label: 'scheme with nothing after', value: 'Bearer ' },
    { label: 'scheme only', value: 'Bearer' },
    { label: 'array header', value: [`Bearer ${T}`] },
    { label: 'absent header', value: undefined, present: false },
  ]

  const accepted: string[] = []

  it.each(headers)('$label: when authenticate accepts it, apiTokenBearer returns the verified token byte for byte', async ({ label, value, present }) => {
    verified.length = 0
    const passed = await authenticateWith(value, present !== false)
    if (!passed) return
    accepted.push(label)
    expect(verified).toHaveLength(1)
    expect(Buffer.from(apiTokenBearer(value)).equals(Buffer.from(verified[0]))).toBe(true)
  })

  it('the headers authenticate accepts are the ones this table expects', () => {
    expect(accepted).toEqual(['standard'])
  })

  it('the accepted set is not empty: the standard header authenticates and maps to the same token', async () => {
    verified.length = 0
    expect(await authenticateWith(`Bearer ${T}`)).toBe(true)
    expect(verified).toEqual([T])
    expect(apiTokenBearer(`Bearer ${T}`)).toBe(T)
  })
})

describe('C18 the bearer subject is read in the order AuthService resolves the user id', () => {
  // Credential subject precedence matches AuthService resolution.
  // Both orders are checked together.
  it.each([
    [{ userId: 'a', id: 'b', sub: 'c' }, 'a'],
    [{ userId: 'a', sub: 'c' }, 'a'],
    [{ id: 'b', sub: 'c' }, 'b'],
    [{ userId: '', id: 'b', sub: 'c' }, 'b'],
    [{ sub: 'c' }, 'c'],
  ])('claims %j authenticate subject %s and no other', (subjectClaims, subject) => {
    const claims = { ...subjectClaims, sid: SID_A, iat: IAT_A }
    expect(issuanceCredentialFromSessionClaims(claims, subject, GENERATION)).toEqual({
      expectedAccessGeneration: GENERATION,
      sessionId: SID_A,
      issuedAt: IAT_A,
    })
    for (const other of ['a', 'b', 'c'].filter((candidate) => candidate !== subject)) {
      expect(() => issuanceCredentialFromSessionClaims(claims, other, GENERATION), other).toThrow(ApiTokenIssuanceError)
    }
  })

  it('AuthService.resolveTokenUserId reads userId, then id, then sub', () => {
    const source = readFileSync(nodePath.join(__dirname, '../../src/auth/AuthService.ts'), 'utf8')
    const at = source.indexOf('private resolveTokenUserId(payload: SessionTokenClaims): string | null {')
    expect(at).toBeGreaterThan(0)
    expect(source.slice(at, source.indexOf('\n  }\n', at))).toContain('const value = payload.userId || payload.id || payload.sub\n')
  })
})
