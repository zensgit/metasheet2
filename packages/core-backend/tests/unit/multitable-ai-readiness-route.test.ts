import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMultitableAiRouter } from '../../src/routes/multitable-ai'
import { requireAdminRole } from '../../src/guards/audit-integration'

vi.mock('../../src/guards/audit-integration', () => ({
  requireAdminRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}))

function buildApp(resolveReadiness = () => ({
  ok: true,
  status: 'ready' as const,
  provider: 'openai' as const,
  model: 'gpt-4o-mini',
  caps: {
    requestTimeoutMs: 15000,
    maxOutputTokens: 1024,
    tenantDailyTokenCap: 100000,
    tenantWeeklyTokenCap: 500000,
    tenantBurstRpm: 30,
    accountDailyUsdCap: 10,
  },
  messages: ['declarative readiness only'],
  requiredEnv: ['MULTITABLE_AI_ENABLED'],
  optionalEnv: ['MULTITABLE_AI_BASE_URL'],
})) {
  const app = express()
  app.use(express.json())
  app.use('/api/multitable', createMultitableAiRouter({ resolveReadiness }))
  return app
}

describe('multitable AI readiness route', () => {
  it('is gated by requireAdminRole and returns a flat readiness report', async () => {
    vi.mocked(requireAdminRole).mockClear()
    const res = await request(buildApp())
      .get('/api/multitable/ai/readiness')
      .expect(200)

    expect(requireAdminRole).toHaveBeenCalledTimes(1)
    expect(res.body).toMatchObject({
      ok: true,
      status: 'ready',
      provider: 'openai',
      model: 'gpt-4o-mini',
    })
    expect(res.body).toHaveProperty('caps')
    expect(res.body).not.toHaveProperty('data')
  })

  it('defensively redacts secret-shaped values before responding', async () => {
    const response = await request(buildApp(() => ({
      ok: false,
      status: 'blocked' as const,
      caps: {
        requestTimeoutMs: 15000,
        maxOutputTokens: 1024,
        tenantDailyTokenCap: 100000,
        tenantWeeklyTokenCap: 500000,
        tenantBurstRpm: 30,
        accountDailyUsdCap: 10,
      },
      messages: ['bad key sk-live-secret-abcdefghijklmnopqrstuvwxyz'],
      requiredEnv: ['MULTITABLE_AI_API_KEY'],
      optionalEnv: [],
      apiKey: 'sk-route-secret-abcdefghijklmnopqrstuvwxyz',
    } as any)))
      .get('/api/multitable/ai/readiness')
      .expect(200)

    const text = JSON.stringify(response.body)
    expect(text).not.toContain('sk-live-secret-abcdefghijklmnopqrstuvwxyz')
    expect(text).not.toContain('sk-route-secret-abcdefghijklmnopqrstuvwxyz')
    expect(text).toContain('sk-<redacted>')
  })

  it('propagates the admin guard denial response', async () => {
    const deny = (_req: unknown, res: any) => res.status(403).json({
      error: 'AccessDenied',
      code: 'ADMIN_REQUIRED',
      message: 'This operation requires admin privileges',
    })
    const app = express()
    app.use('/api/multitable', createMultitableAiRouter({ adminGuard: deny as any }))

    const res = await request(app)
      .get('/api/multitable/ai/readiness')
      .expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
  })
})
