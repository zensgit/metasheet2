import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import * as jwt from 'jsonwebtoken'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiTokenBearer } from '../../src/auth/strict-credential-chain'
import { classifyVerifiedSessionPayload } from '../../src/auth/strict-dingtalk-entry'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import { usePinnedServer } from '../utils/pinned-server'

const tokenService = vi.hoisted(() => ({
  createToken: vi.fn(),
  rotateToken: vi.fn(),
  listTokens: vi.fn(),
  revokeToken: vi.fn(),
}))

const authGate = vi.hoisted(() => ({
  authenticate: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: vi.fn(),
      transaction: vi.fn(),
      getInternalPool: () => ({}),
    }),
  },
}))

vi.mock('../../src/db/db', () => ({ db: {} }))

vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(),
  transaction: vi.fn(),
  pool: null,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
  authMiddleware: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
  default: (req: Request, res: Response, next: NextFunction) => authGate.authenticate(req, res, next),
}))

vi.mock('../../src/multitable/api-token-service', () => ({
  ApiTokenService: vi.fn(function MockApiTokenService() {
    return tokenService
  }),
}))

import { authService } from '../../src/auth/AuthService'
import { apiTokensRouter } from '../../src/routes/api-tokens'

const ACCESS_GENERATION = 4
const CREATE_BODY = { name: 'bounded', scopes: ['records:read'] }
const DENIED = {
  ok: false,
  error: {
    code: 'API_TOKEN_STRICT_SESSION_DENIED',
    message: 'Strict sessions cannot create or rotate API tokens',
  },
}
const UNVERIFIED = { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }
const CREATED = { id: 'created-token', revoked: false }
const ROTATED = { id: 'rotated-token', revoked: false }
const CREATE_PATHS = ['/api/multitable/api-tokens', '/api/multitable/tokens'] as const
const ROTATE_PATHS = [
  '/api/multitable/api-tokens/route-token-1/rotate',
  '/api/multitable/tokens/route-token-1/rotate',
] as const

const sessionSecret = resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
const trace: string[] = []

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

function signConflict(claims: Record<string, unknown>): string {
  return jwt.sign(claims, sessionSecret, { expiresIn: '1h' })
}

function strictToken(): string {
  return authService.createToken(sessionUser('user-strict'), {
    sid: 'xs.route-fence',
    externalAuth: true,
  })
}

function ordinaryToken(): string {
  return authService.createToken(sessionUser('user-ordinary'), {
    sid: 'sess.route-fence',
    externalAuth: false,
  })
}

function conflictTokens(): Record<'xs-only' | 'xa-only' | 'xa-false', string> {
  return {
    'xs-only': signConflict({
      userId: 'user-conflict-xs',
      email: 'user-conflict-xs@example.test',
      role: 'member',
      sid: 'xs.conflict-only',
    }),
    'xa-only': signConflict({
      userId: 'user-conflict-xa',
      email: 'user-conflict-xa@example.test',
      role: 'member',
      sid: 'sess.conflict-xa',
      xa: true,
    }),
    'xa-false': signConflict({
      userId: 'user-conflict-false',
      email: 'user-conflict-false@example.test',
      role: 'member',
      sid: 'xs.conflict-false',
      xa: false,
    }),
  }
}

function tamperSignature(token: string): string {
  const parts = token.split('.')
  const signature = parts[2]
  if (parts.length !== 3 || !signature) throw new Error('not a compact session token')
  const flipped = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`
  return `${parts[0]}.${parts[1]}.${flipped}`
}

authGate.authenticate.mockImplementation((req: Request, res: Response, next: NextFunction) => {
  trace.push('authenticate')
  const payload = authService.readTokenPayload(apiTokenBearer(req.headers.authorization))
  if (!payload?.userId) {
    res.status(401).json(UNVERIFIED)
    return
  }
  req.user = { id: payload.userId, access_generation: ACCESS_GENERATION }
  next()
})

tokenService.createToken.mockImplementation(async () => {
  trace.push('create')
  return { token: CREATED, plainTextToken: 'mst_created' }
})

tokenService.rotateToken.mockImplementation(async () => {
  trace.push('rotate')
  return { token: ROTATED, plainTextToken: 'mst_rotated' }
})

function expectNoCredentialWrite(): void {
  expect(tokenService.createToken).not.toHaveBeenCalled()
  expect(tokenService.rotateToken).not.toHaveBeenCalled()
  expect(tokenService.listTokens).not.toHaveBeenCalled()
  expect(tokenService.revokeToken).not.toHaveBeenCalled()
}

describe('api token strict session route fence', () => {
  const pinned = usePinnedServer()
  const conflicts = conflictTokens()
  const tampered = tamperSignature(strictToken())

  beforeAll(() => {
    const app = express()
    app.use(express.json())
    app.use(apiTokensRouter())
    pinned.setApp(app)
  })

  beforeEach(() => {
    trace.length = 0
    authGate.authenticate.mockClear()
    tokenService.createToken.mockClear()
    tokenService.rotateToken.mockClear()
    tokenService.listTokens.mockClear()
    tokenService.revokeToken.mockClear()
  })

  it('precondition: signed markers classify before the route sees them', () => {
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(strictToken()))).toBe('strict')
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(ordinaryToken()))).toBe('standard')
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(conflicts['xs-only']))).toBe('conflict')
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(conflicts['xa-only']))).toBe('conflict')
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(conflicts['xa-false']))).toBe('conflict')
    expect(authService.readTokenPayload(tampered)).toBeNull()
    expect(classifyVerifiedSessionPayload(authService.readTokenPayload(tampered))).toBe('none')
  })

  it.each([
    ...CREATE_PATHS.map((path) => ({ kind: 'strict', token: strictToken, path })),
    ...ROTATE_PATHS.map((path) => ({ kind: 'strict', token: strictToken, path })),
    ...CREATE_PATHS.map((path) => ({ kind: 'conflict-xs-only', token: () => conflicts['xs-only'], path })),
    ...ROTATE_PATHS.map((path) => ({ kind: 'conflict-xs-only', token: () => conflicts['xs-only'], path })),
    ...CREATE_PATHS.map((path) => ({ kind: 'conflict-xa-only', token: () => conflicts['xa-only'], path })),
    ...ROTATE_PATHS.map((path) => ({ kind: 'conflict-xa-only', token: () => conflicts['xa-only'], path })),
    ...CREATE_PATHS.map((path) => ({ kind: 'conflict-xa-false', token: () => conflicts['xa-false'], path })),
    ...ROTATE_PATHS.map((path) => ({ kind: 'conflict-xa-false', token: () => conflicts['xa-false'], path })),
  ])('denies $kind before authentication on POST $path', async ({ token, path }) => {
    const bearer = token()
    const response = await request(pinned.url())
      .post(path)
      .set('Authorization', `Bearer ${bearer}`)
      .send(CREATE_BODY)

    expect(response.status).toBe(403)
    expect(response.body).toEqual(DENIED)
    expect(authGate.authenticate).not.toHaveBeenCalled()
    expect(trace).toEqual([])
    expectNoCredentialWrite()
  })

  it.each([
    ...CREATE_PATHS.map((path) => ({ path, action: 'create' as const })),
    ...ROTATE_PATHS.map((path) => ({ path, action: 'rotate' as const })),
  ])('ordinary signed session passes POST $path to the $action stub', async ({ path, action }) => {
    const response = await request(pinned.url())
      .post(path)
      .set('Authorization', `Bearer ${ordinaryToken()}`)
      .send(CREATE_BODY)

    expect(authGate.authenticate).toHaveBeenCalledTimes(1)
    expect(tokenService.listTokens).not.toHaveBeenCalled()
    expect(tokenService.revokeToken).not.toHaveBeenCalled()
    if (action === 'create') {
      expect(trace).toEqual(['authenticate', 'create'])
      expect(tokenService.rotateToken).not.toHaveBeenCalled()
      expect(tokenService.createToken).toHaveBeenCalledTimes(1)
      expect(tokenService.createToken).toHaveBeenCalledWith(
        'user-ordinary',
        { name: 'bounded', scopes: ['records:read'], expiresAt: undefined, baseIds: undefined, sheetIds: undefined },
        ACCESS_GENERATION,
      )
      expect(response.status).toBe(201)
      expect(response.body).toEqual({
        ok: true,
        data: { token: CREATED, plaintext: 'mst_created' },
      })
      return
    }
    expect(trace).toEqual(['authenticate', 'rotate'])
    expect(tokenService.createToken).not.toHaveBeenCalled()
    expect(tokenService.rotateToken).toHaveBeenCalledTimes(1)
    expect(tokenService.rotateToken).toHaveBeenCalledWith('route-token-1', 'user-ordinary', ACCESS_GENERATION)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      data: { token: ROTATED, plaintext: 'mst_rotated' },
    })
  })

  it.each([
    ...CREATE_PATHS,
    ...ROTATE_PATHS,
  ])('tampered strict signature reaches authentication and does not write on POST %s', async (path) => {
    const response = await request(pinned.url())
      .post(path)
      .set('Authorization', `Bearer ${tampered}`)
      .send(CREATE_BODY)

    expect(response.status).toBe(401)
    expect(response.body).toEqual(UNVERIFIED)
    expect(response.body.error.code).not.toBe('API_TOKEN_STRICT_SESSION_DENIED')
    expect(authGate.authenticate).toHaveBeenCalledTimes(1)
    expect(trace).toEqual(['authenticate'])
    expectNoCredentialWrite()
  })
})
