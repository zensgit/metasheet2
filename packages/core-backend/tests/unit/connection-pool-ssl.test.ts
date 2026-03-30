import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => {
  const configs: Array<Record<string, unknown>> = []
  const Pool = vi.fn().mockImplementation((config: Record<string, unknown>) => {
    configs.push(config)
    return {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        release: vi.fn(),
      }),
      end: vi.fn().mockResolvedValue(undefined),
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    }
  })

  return {
    Pool,
    configs,
  }
})

vi.mock('pg', () => ({
  Pool: pgMocks.Pool,
}))

vi.mock('../../src/security/SecretManager', () => ({
  secretManager: {
    get: vi.fn().mockReturnValue('postgres://test:test@localhost:5432/test'),
  },
}))

vi.mock('../../src/core/logger', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}))

vi.mock('../../src/integration/metrics/metrics', () => ({
  coreMetrics: {
    gauge: vi.fn(),
    increment: vi.fn(),
    histogram: vi.fn(),
  },
}))

describe('connection pool SSL config', () => {
  const originalEnv = { ...process.env }
  let poolManager: typeof import('../../src/integration/db/connection-pool').poolManager | undefined

  beforeEach(() => {
    vi.resetModules()
    pgMocks.configs.length = 0
    pgMocks.Pool.mockClear()
    process.env = { ...originalEnv }
    delete process.env.DB_SSL
    delete process.env.DB_SSL_CA
    delete process.env.DB_SSL_CERT
    delete process.env.DB_SSL_KEY
    delete process.env.DB_SSL_REJECT_UNAUTHORIZED
  })

  afterEach(async () => {
    if (poolManager) {
      await poolManager.close()
      poolManager = undefined
    }
    process.env = { ...originalEnv }
  })

  async function loadPoolManager() {
    const module = await import('../../src/integration/db/connection-pool')
    poolManager = module.poolManager
    return module.poolManager
  }

  it('disables SSL in production when DB_SSL=false', async () => {
    process.env.NODE_ENV = 'production'
    process.env.DB_SSL = 'false'

    await loadPoolManager()

    expect(pgMocks.configs[0]?.ssl).toBe(false)
  })

  it('enables SSL by default in production when DB_SSL is unset', async () => {
    process.env.NODE_ENV = 'production'

    await loadPoolManager()

    expect(pgMocks.configs[0]?.ssl).toMatchObject({
      rejectUnauthorized: true,
    })
  })

  it('allows explicit SSL enablement outside production', async () => {
    process.env.NODE_ENV = 'development'
    process.env.DB_SSL = 'true'
    process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false'

    await loadPoolManager()

    expect(pgMocks.configs[0]?.ssl).toMatchObject({
      rejectUnauthorized: false,
    })
  })
})
