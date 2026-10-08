/**
 * O2-P3-4 — ROUTE-half pin for the register-null contract (gate follow-up to #5018).
 *
 * #5018 landed an 8-line invariant comment in src/routes/auth.ts (the `if (!user)` branch
 * of POST /register) describing what the route answers on each register() outcome, but the
 * repo pinned only the SERVICE half (tests/unit/auth-register-null-discrimination.test.ts:
 * "which failures return null vs rethrow"). Nothing asserted what the ROUTE actually
 * writes for `register() === null`. A commented invariant that no test executes is a
 * hiding place for a future bug, so this file pins the two response halves the comment
 * names, against the real authRouter stack with authService mocked at the seam:
 *
 *   register() resolves null  → EXACT 409 { success:false, error:'User with this email already exists' }
 *   register() throws (non-duplicate, non-recovery-conflict)
 *                             → EXACT 500 { success:false, error:'Internal server error' }
 *
 * The 500 leg is the A3 behaviour change from #5018 (non-duplicate failures rethrow from
 * AuthService instead of collapsing to null): pinned here so a refactor that routes the
 * catch back through the old "email already exists" 409 reds a test.
 *
 * SCOPE NOTE — this file pins the ROUTE mapping only. It deliberately does NOT assert
 * "null means duplicate-identity ONLY"; that is the service-side claim, and the route
 * comment's enumeration of null-producing paths is not exhaustive at this head (see the
 * defensive `if (result.rows.length === 0) return null` in
 * AuthService.createUserInTransaction). Both legs below hold regardless of that.
 *
 * Rate limiting: registerRateLimiter allows maxRegisterPerIp (3) per `register:${ip}`
 * window and rateLimitStore is module-level, so each test sends its own x-forwarded-for
 * (getClientIP prefers that header) and gets its own bucket — otherwise a later test
 * would silently receive 429 and the failure would look like a broken assertion.
 */

import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authServiceMocks = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  refreshToken: vi.fn(),
  verifyToken: vi.fn(),
  createToken: vi.fn(),
  readTokenPayload: vi.fn(),
  resolveSessionTenantId: vi.fn(),
}))

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const bcryptMocks = vi.hoisted(() => ({
  hash: vi.fn(),
  compare: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: authServiceMocks,
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))

vi.mock('bcryptjs', () => bcryptMocks)

import { authRouter } from '../../src/routes/auth'

/** The exact bodies routes/auth.ts writes today — literal, not derived from src. */
const DUPLICATE_IDENTITY_409_BODY = {
  success: false,
  error: 'User with this email already exists',
}
const GENERIC_500_BODY = {
  success: false,
  error: 'Internal server error',
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      this.headersSent = true
      return this
    },
  } as Response & { statusCode: number; body: unknown; headersSent: boolean }
}

async function invokeRoute(
  method: 'get' | 'post',
  path: string,
  options: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  const layer = authRouter.stack.find(
    (entry) => entry.route?.path === path && entry.route?.methods?.[method],
  )
  if (!layer?.route?.stack) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: options.headers ?? {},
    query: {},
    params: {},
    body: options.body ?? {},
    user: undefined,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request
  const res = createMockResponse()

  for (const routeLayer of layer.route.stack) {
    await new Promise<void>((resolve, reject) => {
      try {
        const maybePromise = routeLayer.handle(req, res, (error?: unknown) => {
          if (error) reject(error)
          else resolve()
        })
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          Promise.resolve(maybePromise).then(() => resolve()).catch(reject)
        } else if (res.headersSent || routeLayer.handle.length < 3) {
          resolve()
        }
      } catch (error) {
        reject(error)
      }
    })
    if (res.headersSent) break
  }

  return res
}

/**
 * A well-formed registration payload that passes EVERY pre-service validation gate in the
 * handler (presence, email regex, validatePassword, name length), so reaching the service
 * seam is the only way the request can proceed. The mixed-case email additionally proves
 * sanitizeEmail ran.
 */
const VALID_BODY = {
  email: 'Taken@Example.com',
  password: 'Str0ng!Passw0rd',
  name: 'Taken',
} as const
const SANITIZED_ARGS = ['taken@example.com', 'Str0ng!Passw0rd', 'Taken'] as const

beforeEach(() => {
  vi.unstubAllEnvs()
  for (const mock of Object.values(authServiceMocks)) mock.mockReset()
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  bcryptMocks.hash.mockReset()
  bcryptMocks.compare.mockReset()
})

describe('POST /register — the route half of the register-null invariant (O2-P3-4)', () => {
  it('register() resolves null → EXACT 409 duplicate-identity body', async () => {
    authServiceMocks.register.mockResolvedValue(null)

    const res = await invokeRoute('post', '/register', {
      body: { ...VALID_BODY },
      headers: { 'x-forwarded-for': '203.0.113.11' },
    })

    // POSITIVE CONTROL: the handler body really ran — it got past presence/email/password/
    // name validation and called the service seam with the sanitized arguments. Without
    // this, a 400 (validation), a 429 (rate limiter) or a never-invoked handler could not
    // be told apart from a genuine pass on a status-only assertion.
    expect(authServiceMocks.register).toHaveBeenCalledTimes(1)
    expect(authServiceMocks.register).toHaveBeenCalledWith(...SANITIZED_ARGS)

    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual(DUPLICATE_IDENTITY_409_BODY)
    // The null branch answers directly: no token is minted for a rejected identity.
    // POSITIVE CONTROL for these two "did not happen" assertions: the 201 leg below
    // drives the SAME mocks in the same file and asserts they ARE called — so neither is
    // vacuous through a mis-wired seam.
    expect(authServiceMocks.createToken).not.toHaveBeenCalled()
    expect(authServiceMocks.resolveSessionTenantId).not.toHaveBeenCalled()
  })

  it('register() throws a non-duplicate, non-recovery-conflict error → EXACT generic 500 body, never the "already exists" 409 (A3)', async () => {
    // The #5018 A3 case: AuthService now rethrows infrastructure failures instead of
    // swallowing them to null. The route must answer its real 500 — collapsing this back
    // into the null branch's 409 is exactly the lie A3 removed.
    authServiceMocks.register.mockRejectedValue(
      Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }),
    )

    const res = await invokeRoute('post', '/register', {
      body: { ...VALID_BODY },
      headers: { 'x-forwarded-for': '203.0.113.12' },
    })

    // POSITIVE CONTROL: same reachability proof as above.
    expect(authServiceMocks.register).toHaveBeenCalledTimes(1)
    expect(authServiceMocks.register).toHaveBeenCalledWith(...SANITIZED_ARGS)

    expect(res.statusCode).toBe(500)
    // Exact equality (not a "is not the 409 text" check): the whole body is pinned, so
    // ANY drift — including a collapse back to the duplicate-identity 409 text — reds.
    expect(res.body).toEqual(GENERIC_500_BODY)
  })

  it('POSITIVE CONTROL: register() resolving a user still yields the untouched 201 success shape', async () => {
    const user = {
      id: 'user-new-1',
      email: 'taken@example.com',
      name: 'Taken',
      role: 'user',
      permissions: [] as string[],
    }
    authServiceMocks.register.mockResolvedValue(user)
    authServiceMocks.resolveSessionTenantId.mockResolvedValue(undefined)
    authServiceMocks.createToken.mockReturnValue('signed-token')

    const res = await invokeRoute('post', '/register', {
      body: { ...VALID_BODY },
      headers: { 'x-forwarded-for': '203.0.113.13' },
    })

    expect(authServiceMocks.register).toHaveBeenCalledTimes(1)
    expect(authServiceMocks.register).toHaveBeenCalledWith(...SANITIZED_ARGS)
    expect(authServiceMocks.createToken).toHaveBeenCalledWith(user)
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({
      success: true,
      data: { user, token: 'signed-token' },
    })
  })
})
