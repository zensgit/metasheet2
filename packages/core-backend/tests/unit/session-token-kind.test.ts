/**
 * Session verification accepts only session tokens.
 *
 * Real `jsonwebtoken` signatures throughout. The database, the role lookup and the session registry are
 * stand-ins; the real-database counterpart is tests/integration/session-token-invite-lifecycle.db.test.ts.
 */
import express from 'express'
import type { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  SECRET: 'unit-test-session-secret-abcdefghijklmnopqrstuvwxyz0123',
}))

const poolMocks = vi.hoisted(() => {
  const query = vi.fn()
  const transaction = vi.fn(async (handler: (client: { query: typeof query }) => Promise<unknown>) =>
    handler({ query }),
  )
  return {
    query,
    transaction,
    poolManager: { get: () => ({ query, transaction, getInternalPool: () => ({ query }) }) },
  }
})

const rbacMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  invalidateUserPerms: vi.fn(),
}))

const sessionMocks = vi.hoisted(() => ({
  isUserSessionRevoked: vi.fn(),
  createUserSession: vi.fn(),
  isUserSessionActive: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({ poolManager: poolMocks.poolManager }))
vi.mock('../../src/rbac/service', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isAdmin: rbacMocks.isAdmin,
  listUserPermissions: rbacMocks.listUserPermissions,
  invalidateUserPerms: rbacMocks.invalidateUserPerms,
}))
vi.mock('../../src/auth/session-revocation', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  isUserSessionRevoked: sessionMocks.isUserSessionRevoked,
}))
vi.mock('../../src/auth/session-registry', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createUserSession: sessionMocks.createUserSession,
  isUserSessionActive: sessionMocks.isUserSessionActive,
}))
vi.mock('../../src/security/SecretManager', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  // The suite signs and verifies with this one secret.
  secretManager: { get: (key: string) => (key === 'JWT_SECRET' ? fixtures.SECRET : undefined) },
}))

import { authService } from '../../src/auth/AuthService'
import { issueInviteToken } from '../../src/auth/invite-tokens'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { isSessionTokenPayload } from '../../src/auth/session-token-kind'
import { authRouter } from '../../src/routes/auth'
import { usePinnedServer } from '../utils/pinned-server'

const USER_ID = 'session-kind-user'
const EMAIL = 'session-kind@example.test'
const FAR_FUTURE = 9_999_999_999

// Set before the token tables below are built: the tables are evaluated while the suite is collected.
vi.stubEnv('JWT_SECRET', fixtures.SECRET)
vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('RBAC_TOKEN_TRUST', 'false')

const pinned = usePinnedServer()

function buildApp() {
  const app = express()
  app.use(express.json())
  app.get('/gated', jwtAuthMiddleware, (req: Request, res: Response) => {
    res.json({ ok: true, userId: (req.user as { id?: string } | undefined)?.id ?? null })
  })
  app.use('/api/auth', authRouter)
  return app
}

function sign(payload: Record<string, unknown>): string {
  return jwt.sign(payload, fixtures.SECRET, { algorithm: 'HS256' })
}

function claimsOf(token: string): Record<string, unknown> {
  return jwt.verify(token, fixtures.SECRET, { ignoreExpiration: true }) as Record<string, unknown>
}

function serviceUser() {
  return {
    id: USER_ID,
    email: EMAIL,
    name: 'Session Kind',
    role: 'user',
    permissions: [],
    created_at: new Date(0),
    updated_at: new Date(0),
  }
}

/** Every claim set a session token is issued with or has been issued with. None carries `type`. */
function sessionTokens(): Array<[string, string]> {
  return [
    ['issued at sign-in, with a session id', authService.createToken({ ...serviceUser(), tenantId: 'org-1' }, { sid: 'sid-1' })],
    ['issued without a session id', authService.createToken(serviceUser())],
    ['id, roles, perms and a session id', sign({ id: USER_ID, roles: ['user'], perms: ['spreadsheet:read'], sid: 'sid-1', exp: FAR_FUTURE })],
    ['id, roles and perms with explicit iat and exp', sign({ id: USER_ID, roles: ['user'], perms: ['spreadsheet:read'], iat: 1_700_000_000, exp: FAR_FUTURE })],
    ['sub, name, roles and permissions', sign({ sub: USER_ID, name: 'Session Kind', roles: ['user'], permissions: ['spreadsheet:read'], exp: FAR_FUTURE })],
    ['id, email and role', sign({ id: USER_ID, email: EMAIL, role: 'user', exp: FAR_FUTURE })],
    ['id and roles', sign({ id: USER_ID, roles: ['user'], exp: FAR_FUTURE })],
  ]
}

/** Correctly signed claim sets that state a purpose in a payload `type` claim. None is a session token. */
function typedTokens(): Array<[string, string]> {
  return [
    ['a purpose token issued by this service', issueInviteToken({ userId: USER_ID, email: EMAIL })],
    ['a string type with userId', sign({ type: 'invite', userId: USER_ID, email: EMAIL, exp: FAR_FUTURE })],
    ['a string type with userId, past its expiry', sign({ type: 'invite', userId: USER_ID, email: EMAIL, iat: 1_700_000_000, exp: 1_700_000_600 })],
    ['another string type with id', sign({ type: 'restore-preview', id: USER_ID, exp: FAR_FUTURE })],
    ['a type naming a session, with a session id', sign({ type: 'session', userId: USER_ID, sid: 'sid-1', exp: FAR_FUTURE })],
    ['a numeric type', sign({ type: 7, sub: USER_ID, exp: FAR_FUTURE })],
    ['a null type', sign({ type: null, userId: USER_ID, exp: FAR_FUTURE })],
    ['a typed claim set that also carries roles and perms', sign({ type: 'invite', id: USER_ID, roles: ['admin'], perms: ['admin:all'], exp: FAR_FUTURE })],
  ]
}

async function gated(token: string) {
  const response = await request(pinned.url()).get('/gated').set('Authorization', `Bearer ${token}`)
  return { status: response.status, body: response.body as unknown }
}

async function refresh(token: string) {
  const response = await request(pinned.url()).post('/api/auth/refresh-token').send({ token })
  return { status: response.status, body: response.body as unknown }
}

describe('session verification accepts only session tokens', () => {
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  beforeEach(() => {
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    pinned.setApp(buildApp())
    poolMocks.query.mockReset()
    poolMocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM users')) {
        return {
          rows: [{
            id: USER_ID,
            email: EMAIL,
            name: 'Session Kind',
            role: 'user',
            permissions: [],
            password_hash: 'hash',
            access_generation: 0,
            is_active: true,
            must_change_password: false,
            activation_status: 'activated',
            local_password_set: true,
            created_at: new Date(0),
            updated_at: new Date(0),
          }],
        }
      }
      return { rows: [] }
    })
    rbacMocks.isAdmin.mockReset()
    rbacMocks.isAdmin.mockResolvedValue(false)
    rbacMocks.listUserPermissions.mockReset()
    rbacMocks.listUserPermissions.mockResolvedValue(['attendance:read', 'attendance:write'])
    rbacMocks.invalidateUserPerms.mockReset()
    sessionMocks.isUserSessionRevoked.mockReset()
    sessionMocks.isUserSessionRevoked.mockResolvedValue(false)
    sessionMocks.isUserSessionActive.mockReset()
    sessionMocks.isUserSessionActive.mockResolvedValue(true)
    sessionMocks.createUserSession.mockReset()
    sessionMocks.createUserSession.mockImplementation(async (_userId: string, options: { sessionId: string }) => ({
      id: options.sessionId,
    }))
  })

  describe('the claim rule', () => {
    it('a claim set without a type claim is a session claim set', () => {
      expect(isSessionTokenPayload({})).toBe(true)
      expect(isSessionTokenPayload({ userId: 'u', sid: 's', iat: 1, exp: 2 })).toBe(true)
    })

    it.each([
      ['a string', { type: 'invite' }],
      ['an empty string', { type: '' }],
      ['a number', { type: 0 }],
      ['a boolean', { type: false }],
      ['null', { type: null }],
      ['undefined', { type: undefined }],
      ['an object', { type: {} }],
    ])('a claim set whose type claim is %s is not a session claim set', (_label, payload) => {
      expect(isSessionTokenPayload(payload)).toBe(false)
    })

    it('a type claim reached through the prototype chain still counts', () => {
      expect(isSessionTokenPayload(Object.create({ type: 'invite' }))).toBe(false)
    })

    it.each([
      ['a string', 'payload'],
      ['null', null],
      ['undefined', undefined],
      ['an array', [{ userId: 'u' }]],
      ['a number', 1],
    ])('%s is not a session claim set', (_label, payload) => {
      expect(isSessionTokenPayload(payload)).toBe(false)
    })
  })

  describe('session tokens keep verifying', () => {
    it('no session token carries a payload type claim, and each has the standard JOSE header', () => {
      for (const [, token] of sessionTokens()) {
        expect(claimsOf(token)).not.toHaveProperty('type')
        // The header names the token format. It is not the claim the rule reads.
        expect(jwt.decode(token, { complete: true })?.header).toMatchObject({ typ: 'JWT' })
      }
    })

    it.each(sessionTokens())('verifyToken accepts a session token (%s)', async (_label, token) => {
      const user = await authService.verifyToken(token)

      expect(user?.id).toBe(USER_ID)
      expect(await gated(token)).toEqual({ status: 200, body: { ok: true, userId: USER_ID } })
    })

    it.each(sessionTokens())('refreshToken renews a session token and records its session (%s)', async (_label, token) => {
      const response = await refresh(token)

      expect(response.status).toBe(200)
      const renewed = String((response.body as { data: { token: string } }).data.token)
      const claims = claimsOf(renewed)
      expect(claims).not.toHaveProperty('type')
      expect(claims.userId).toBe(USER_ID)
      expect(typeof claims.sid).toBe('string')
      expect(sessionMocks.createUserSession).toHaveBeenCalledTimes(1)
      expect(sessionMocks.createUserSession.mock.calls[0]?.[0]).toBe(USER_ID)
      // The renewed token is itself a session token.
      expect((await authService.verifyToken(renewed))?.id).toBe(USER_ID)
    })

    it.each(sessionTokens())('readTokenPayload returns the claims of a session token (%s)', (_label, token) => {
      expect(authService.readTokenPayload(token)).toEqual(claimsOf(token))
    })
  })

  describe('a token that carries a payload type claim is not a session token', () => {
    it('every typed token here is correctly signed for the verifier and carries a type claim', () => {
      for (const [, token] of typedTokens()) {
        expect(claimsOf(token)).toHaveProperty('type')
        expect(jwt.decode(token, { complete: true })?.header).toMatchObject({ typ: 'JWT' })
      }
    })

    it.each(typedTokens())('verifyToken returns null (%s)', async (_label, token) => {
      expect(await authService.verifyToken(token)).toBeNull()
      expect(poolMocks.query).not.toHaveBeenCalled()
      expect(sessionMocks.isUserSessionRevoked).not.toHaveBeenCalled()
      expect(sessionMocks.isUserSessionActive).not.toHaveBeenCalled()
    })

    it.each(typedTokens())('verifyToken returns null when token claims are trusted (%s)', async (_label, token) => {
      vi.stubEnv('RBAC_TOKEN_TRUST', 'true')

      expect(await authService.verifyToken(token)).toBeNull()
      expect(poolMocks.query).not.toHaveBeenCalled()
    })

    it.each(typedTokens())('refreshToken returns null and records no session (%s)', async (_label, token) => {
      expect(await authService.refreshToken(token)).toBeNull()
      expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
      expect(poolMocks.query).not.toHaveBeenCalled()
    })

    it.each(typedTokens())('readTokenPayload returns null (%s)', (_label, token) => {
      expect(authService.readTokenPayload(token)).toBeNull()
      expect(authService.readTokenPayload(token, { ignoreExpiration: true })).toBeNull()
    })

    it.each(typedTokens())('a gated request answers exactly as it does for any invalid token (%s)', async (_label, token) => {
      const invalid = await gated('not-a-token')
      const wrongKey = await gated(jwt.sign({ userId: USER_ID, exp: FAR_FUTURE }, `${fixtures.SECRET}-other`))

      expect(invalid.status).toBe(401)
      expect(wrongKey).toEqual(invalid)
      expect(await gated(token)).toEqual(invalid)
      expect(poolMocks.query).not.toHaveBeenCalled()
    })

    it.each(typedTokens())('a refresh request answers exactly as it does for any invalid token and records no session (%s)', async (_label, token) => {
      const invalid = await refresh('not-a-token')
      const wrongKey = await refresh(jwt.sign({ userId: USER_ID, exp: FAR_FUTURE }, `${fixtures.SECRET}-other`))

      expect(invalid.status).toBe(401)
      expect(wrongKey).toEqual(invalid)
      expect(await refresh(token)).toEqual(invalid)
      expect(sessionMocks.createUserSession).not.toHaveBeenCalled()
      expect(poolMocks.query).not.toHaveBeenCalled()
    })
  })
})
