/**
 * A3 usage-summary route — backend leg of A3-T7
 * (docs/development/multitable-ai-shortcut-frontend-a3-design-20260611.md §2.4 / §3).
 *
 * GET /api/multitable/ai/usage-summary (internal, requireAdminRole, NOT under
 * the AI burst limiter): returns the caller's own token windows + the
 * instance-wide daily USD + the boot-time caps —
 * `{ callerDayTokens, callerWeekTokens, instanceDayUsd, caps }`.
 *
 * Mount pattern: fresh Express app + `rbac/service` and `db/pg` mocked
 * (precedent: tests/unit/multitable-ai-routes.test.ts), poolManager.get()
 * spied to a mock pool that serves the shared SUM SQL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

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

let sumQueryCalls: Array<{ sql: string; params: unknown[] }>
let sumRow: Record<string, unknown> | null
let sumQueryError: Error | null

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM multitable_ai_usage_ledger')) {
      sumQueryCalls.push({ sql, params: params ?? [] })
      if (sumQueryError) throw sumQueryError
      return { rows: sumRow ? [sumRow] : [] }
    }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function buildApp(user?: { id: string }): Promise<Express> {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as never)

  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  app.use('/api/multitable', createMultitableAiRoutes())
  return app
}

const SUMMARY_URL = '/api/multitable/ai/usage-summary'
const savedEnv = new Map<string, string | undefined>()

describe('GET /api/multitable/ai/usage-summary (internal, admin-only, limiter-free)', () => {
  beforeEach(() => {
    for (const key of AI_ENV_KEYS) {
      savedEnv.set(key, process.env[key])
      delete process.env[key]
    }
    // Cap envs are integer-only (resolveCap falls back to defaults otherwise — A1 semantics).
    process.env.MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP = '111000'
    process.env.MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP = '555000'
    process.env.MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP = '12'

    sumQueryCalls = []
    sumRow = { user_daily_tokens: '123', user_weekly_tokens: '456', instance_daily_usd: '7.89' }
    sumQueryError = null
    vi.mocked(isAdmin).mockReset()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  afterEach(() => {
    for (const key of AI_ENV_KEYS) {
      const value = savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
  })

  it('A3-T7: admin gets a 200 flat summary {callerDayTokens, callerWeekTokens, instanceDayUsd, caps}', async () => {
    const app = await buildApp({ id: 'admin-1' })
    const res = await request(app).get(SUMMARY_URL).expect(200)

    expect(res.body).toEqual({
      callerDayTokens: 123,
      callerWeekTokens: 456,
      instanceDayUsd: 7.89,
      caps: {
        tenantDailyTokenCap: 111000,
        tenantWeeklyTokenCap: 555000,
        accountDailyUsdCap: 12,
      },
    })

    // Subject semantics (§2.4 locked): the caller's OWN authenticated user id
    // is the token subject — never a header-backfilled tenant.
    expect(sumQueryCalls).toHaveLength(1)
    expect(sumQueryCalls[0].params).toEqual(['admin-1'])
  })

  it('A3-T7: the summary read shares the quota SUM SQL (no status filter, same windows)', async () => {
    const app = await buildApp({ id: 'admin-1' })
    await request(app).get(SUMMARY_URL).expect(200)

    const sql = sumQueryCalls[0].sql
    expect(sql).toContain('user_daily_tokens')
    expect(sql).toContain('user_weekly_tokens')
    expect(sql).toContain('instance_daily_usd')
    expect(sql.toLowerCase()).not.toContain('status')
  })

  it('A3-T7: non-admin → 403; unauthenticated → 403 (ADMIN_REQUIRED — 401 belongs upstream)', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const nonAdminApp = await buildApp({ id: 'user-1' })
    const nonAdmin = await request(nonAdminApp).get(SUMMARY_URL).expect(403)
    expect(nonAdmin.body.code).toBe('ADMIN_REQUIRED')
    expect(sumQueryCalls).toHaveLength(0)

    vi.restoreAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
    const anonApp = await buildApp()
    await request(anonApp).get(SUMMARY_URL).expect(403)
    expect(sumQueryCalls).toHaveLength(0)
  })

  it('A3-T7: NOT under the AI burst limiter — burst rpm 1 still serves repeated reads', async () => {
    process.env.MULTITABLE_AI_TENANT_BURST_RPM = '1'
    const app = await buildApp({ id: 'admin-1' })

    // The shortcut limiter at rpm=1 would 429 the second request; the summary
    // route must never consume (or be blocked by) that budget.
    await request(app).get(SUMMARY_URL).expect(200)
    await request(app).get(SUMMARY_URL).expect(200)
    await request(app).get(SUMMARY_URL).expect(200)
    expect(sumQueryCalls).toHaveLength(3)
  })

  it('A3-T7: ledger read failure → 500 INTERNAL_ERROR (read-only route, no fail-open numbers)', async () => {
    sumQueryError = new Error('ledger down')
    const app = await buildApp({ id: 'admin-1' })
    const res = await request(app).get(SUMMARY_URL).expect(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
  })
})
