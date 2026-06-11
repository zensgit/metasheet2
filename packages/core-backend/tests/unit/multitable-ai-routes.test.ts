/**
 * A1 readiness route — HTTP-level tests (A1-T7/T8 + the route leg of A1-T6
 * from docs/development/multitable-ai-provider-readiness-a1-design-20260610.md).
 *
 * Mounts the internal router on a fresh Express app (precedent:
 * tests/unit/automation-routes-wiring.test.ts) with `rbac/service` and `db/pg`
 * mocked so `requireAdminRole()` is exercised without a database:
 *   - admin            → 200 flat report (no envelope)
 *   - no user / non-admin → 403 (401 belongs to upstream jwtAuthMiddleware)
 *   - RBAC service failure → 503 fail-closed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

import { createMultitableAiRoutes } from '../../src/routes/multitable-ai'

const AI_ENV_KEYS = [
  'MULTITABLE_AI_ENABLED',
  'MULTITABLE_AI_PROVIDER',
  'MULTITABLE_AI_API_KEY',
  'MULTITABLE_AI_BASE_URL',
  'MULTITABLE_AI_MODEL',
  'MULTITABLE_AI_REQUEST_TIMEOUT_MS',
  'MULTITABLE_AI_MAX_OUTPUT_TOKENS',
  'MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP',
  'MULTITABLE_AI_TENANT_BURST_RPM',
  'MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP',
  'MULTITABLE_AI_CONFIRM_LIVE_REQUESTS',
] as const

const SK_SENTINEL = `sk-${'route789'.repeat(4)}`
const URL_PASSWORD_SENTINEL = 'RouteS3cretPw'

function buildApp(user?: { id: string }) {
  const app = express()
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use('/api/multitable', createMultitableAiRoutes())
  return app
}

describe('GET /api/multitable/ai/readiness (internal, admin-only)', () => {
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    vi.mocked(isAdmin).mockReset()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  afterEach(() => {
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('A1-T7: admin gets a 200 flat readiness report (no envelope)', async () => {
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = 'test-key-placeholder'
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'

    const res = await request(buildApp({ id: 'admin-1' }))
      .get('/api/multitable/ai/readiness')
      .expect(200)

    // Flat report — match the single-object precedent (automation /stats).
    expect(res.body.status).toBe('ready')
    expect(res.body.ok).toBe(true)
    expect(res.body.provider).toBe('anthropic')
    expect(res.body.model).toBe('claude-sonnet-4-6')
    expect(Array.isArray(res.body.messages)).toBe(true)
    expect(Array.isArray(res.body.requiredEnv)).toBe(true)
    expect(res.body.data).toBeUndefined()
    expect(res.body.report).toBeUndefined()
  })

  it('A1-T7: default deployment reports disabled (still 200 for admin)', async () => {
    const res = await request(buildApp({ id: 'admin-1' }))
      .get('/api/multitable/ai/readiness')
      .expect(200)

    expect(res.body.status).toBe('disabled')
    expect(res.body.ok).toBe(false)
  })

  it('A1-T8: request without user is rejected 403 by requireAdminRole', async () => {
    await request(buildApp())
      .get('/api/multitable/ai/readiness')
      .expect(403)
  })

  it('A1-T8: authenticated non-admin is rejected 403', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)

    const res = await request(buildApp({ id: 'user-1' }))
      .get('/api/multitable/ai/readiness')
      .expect(403)

    expect(res.body.code).toBe('ADMIN_REQUIRED')
  })

  it('A1-T8: RBAC service failure fails closed with 503', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac down'))

    const res = await request(buildApp({ id: 'user-1' }))
      .get('/api/multitable/ai/readiness')
      .expect(503)

    expect(res.body.code).toBe('RBAC_CHECK_FAILED')
  })

  it('A1-T6 (route leg): sentinel-shaped env values never appear in the HTTP response', async () => {
    process.env.MULTITABLE_AI_ENABLED = '1'
    process.env.MULTITABLE_AI_PROVIDER = 'anthropic'
    process.env.MULTITABLE_AI_API_KEY = SK_SENTINEL
    process.env.MULTITABLE_AI_BASE_URL = `https://ops:${URL_PASSWORD_SENTINEL}@proxy.example.com/v1`
    process.env.MULTITABLE_AI_MODEL = 'claude-sonnet-4-6'

    const res = await request(buildApp({ id: 'admin-1' }))
      .get('/api/multitable/ai/readiness')
      .expect(200)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(SK_SENTINEL)
    expect(serialized).not.toContain(URL_PASSWORD_SENTINEL)
  })
})
