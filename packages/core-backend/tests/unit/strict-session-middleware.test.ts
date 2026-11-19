import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const authMocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  readTokenPayload: vi.fn(),
}))

vi.mock('../../src/auth/AuthService', () => ({
  authService: {
    verifyToken: authMocks.verifyToken,
    readTokenPayload: authMocks.readTokenPayload,
  },
}))

import { APIGateway } from '../../src/gateway/APIGateway'
import { jwtAuthMiddleware, optionalJwtAuthMiddleware } from '../../src/auth/jwt-middleware'

function ordinaryUser(extra: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'user',
    permissions: [],
    created_at: new Date('2026-11-18T00:00:00.000Z'),
    updated_at: new Date('2026-11-18T00:00:00.000Z'),
    ...extra,
  }
}

const pinned = usePinnedServer()

function send(app: express.Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

function appWith(middleware: (req: Request, res: Response, next: NextFunction) => unknown) {
  const app = express()
  app.use(express.json())
  app.use(middleware)
  app.post('/api/multitable/views/view-1/submit', (req, res) => {
    res.json({ reached: true, tenantId: req.user?.tenantId ?? null })
  })
  app.get('/protected', (req, res) => {
    res.json({ reached: true, tenantId: req.user?.tenantId ?? null })
  })
  return app
}

describe('strict selector fence', () => {
  beforeEach(() => {
    authMocks.verifyToken.mockReset()
    authMocks.readTokenPayload.mockReset()
  })

  it('does not let a strict selector mismatch fall through optional public-form auth', async () => {
    authMocks.verifyToken.mockResolvedValue(ordinaryUser({ strictSessionOrgId: 'org-1', tenantId: 'org-1' }))
    const response = await send(appWith(optionalJwtAuthMiddleware))
      .post('/api/multitable/views/view-1/submit')
      .set('Authorization', 'Bearer t')
      .send({ publicToken: 'public', orgId: 'org-2' })
    expect(response.status).toBe(403)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'SESSION_ORG_NOT_MEMBER', message: 'Not a member of the requested organization' },
    })
  })

  it('still bypasses an invalid token on the optional public-form path', async () => {
    authMocks.verifyToken.mockResolvedValue(null)
    const response = await send(appWith(optionalJwtAuthMiddleware))
      .post('/api/multitable/views/view-1/submit?publicToken=public')
      .set('Authorization', 'Bearer stale')
    expect(response.status).toBe(200)
    expect(response.body.reached).toBe(true)
  })

  it('refuses a non-string strict selector on the required middleware', async () => {
    authMocks.verifyToken.mockResolvedValue(ordinaryUser({ strictSessionOrgId: 'org-1', tenantId: 'org-1' }))
    const response = await send(appWith(jwtAuthMiddleware))
      .post('/protected')
      .set('Authorization', 'Bearer t')
      .send({ workspace_id: 1 })
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('SESSION_ORG_NOT_MEMBER')
  })

  it('does not copy a header tenant onto a strict identity', async () => {
    authMocks.verifyToken.mockResolvedValue(ordinaryUser({ strictSessionOrgId: 'org-1' }))
    const response = await send(appWith(jwtAuthMiddleware))
      .get('/protected')
      .set('Authorization', 'Bearer t')
      .set('x-tenant-id', 'org-1')
    expect(response.status).toBe(200)
    expect(response.body.tenantId).toBeNull()
  })

  it('keeps the ordinary header-tenant fallback', async () => {
    authMocks.verifyToken.mockResolvedValue(ordinaryUser())
    const response = await send(appWith(jwtAuthMiddleware))
      .get('/protected')
      .set('Authorization', 'Bearer t')
      .set('x-tenant-id', 'org-9')
    expect(response.status).toBe(200)
    expect(response.body.tenantId).toBe('org-9')
  })
})

describe('APIGateway strict refusal', () => {
  const gateways: APIGateway[] = []

  beforeEach(() => {
    authMocks.verifyToken.mockReset()
    authMocks.readTokenPayload.mockReset()
  })

  afterEach(() => {
    for (const gateway of gateways) gateway.destroy()
    gateways.length = 0
  })

  function gatewayApp() {
    const app = express()
    const gateway = new APIGateway(app, {
      basePath: '/gw',
      enableCors: false,
      enableLogging: false,
      enableMetrics: false,
      enableCircuitBreaker: false,
    })
    gateways.push(gateway)
    gateway.registerEndpoint({
      path: '/resource',
      method: 'GET',
      authentication: 'jwt',
      handler: (_req, res) => { res.json({ ok: true }) },
    })
    return app
  }

  it('refuses an agreed strict payload before verifyToken', async () => {
    authMocks.readTokenPayload.mockReturnValue({ sid: 'xs.1', xa: true, userId: 'user-1' })
    const response = await send(gatewayApp()).get('/gw/resource').set('Authorization', 'Bearer t')
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'STRICT_SESSION_NOT_PERMITTED' })
    expect(authMocks.verifyToken).not.toHaveBeenCalled()
  })

  it('refuses disagreeing markers before verifyToken', async () => {
    authMocks.readTokenPayload.mockReturnValue({ sid: 'xs.1', userId: 'user-1' })
    const response = await send(gatewayApp()).get('/gw/resource').set('Authorization', 'Bearer t')
    expect(response.status).toBe(403)
    expect(authMocks.verifyToken).not.toHaveBeenCalled()
  })

  it('continues an ordinary payload into verifyToken', async () => {
    authMocks.readTokenPayload.mockReturnValue({ sid: 'sid-1', userId: 'user-1' })
    authMocks.verifyToken.mockResolvedValue(ordinaryUser())
    const response = await send(gatewayApp()).get('/gw/resource').set('Authorization', 'Bearer t')
    expect(response.status).toBe(200)
    expect(authMocks.verifyToken).toHaveBeenCalledWith('t')
  })
})
