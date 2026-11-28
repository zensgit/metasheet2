import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { databaseConnectionConfig } from '../../src/integration/db/connection-config'

const fixtureUrl = 'postgres://127.0.0.1:1/none'
afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })

describe('database connection configuration', () => {
  it.each([
    { NODE_ENV: 'production', DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'true', DB_POOL_MAX: '32' },
    { NODE_ENV: 'production', DB_SSL: ' OFF ', DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_POOL_MAX: '15' },
    { NODE_ENV: 'development', DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false', DB_POOL_MAX: '20' },
  ])('passes the shared configuration to the main pool: %j', async env => {
    vi.resetModules()
    vi.useFakeTimers()
    for (const [key, value] of Object.entries({ ...env, DB_SSL_CA: 'fixture-ca', DB_SSL_CERT: 'fixture-cert', DB_SSL_KEY: 'fixture-key', DATABASE_URL: '' })) vi.stubEnv(key, value)
    const secrets = { get: vi.fn(() => fixtureUrl) }
    const shared = vi.fn(databaseConnectionConfig)
    const configs: Record<string, unknown>[] = []
    vi.doMock('../../src/security/SecretManager', () => ({ secretManager: secrets }))
    vi.doMock('../../src/integration/db/connection-config', () => ({ databaseConnectionConfig: shared }))
    vi.doMock('pg', () => ({ Pool: class {
      constructor(config: Record<string, unknown>) { configs.push(config) }
      connect() { throw new Error('unexpected connection') }
      async end() {}
    } }))
    try {
      const { poolManager } = await import('../../src/integration/db/connection-pool')
      try {
        expect(shared).toHaveBeenCalledOnce()
        expect(shared).toHaveBeenCalledWith(secrets)
        expect(configs).toHaveLength(1)
        const { connectionString, ssl, max } = configs[0]
        expect({ connectionString, ssl, max }).toStrictEqual(databaseConnectionConfig(secrets, process.env))
      } finally { await poolManager.close() }
    } finally {
      vi.doUnmock('../../src/security/SecretManager')
      vi.doUnmock('../../src/integration/db/connection-config')
      vi.doUnmock('pg')
      vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    }
  })
  it('keeps shared connection settings in the configuration module', () => {
    const source = readFileSync(new URL('../../src/integration/db/connection-pool.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\b(?:DB_SSL\w*|DB_POOL_MAX)\b|['"]DATABASE_URL['"]|\.DATABASE_URL\b/)
  })
  it('resolves the URL through the supplied provider with production TLS defaults', () => {
    const secrets = { get: vi.fn(() => fixtureUrl) }
    expect(databaseConnectionConfig(secrets, { NODE_ENV: 'production', DB_SSL_CA: 'fixture-ca', DB_SSL_CERT: 'fixture-cert', DB_SSL_KEY: 'fixture-key', DB_POOL_MAX: '32' }))
      .toEqual({ connectionString: fixtureUrl, ssl: { rejectUnauthorized: true, ca: 'fixture-ca', cert: 'fixture-cert', key: 'fixture-key' }, max: 32 })
    expect(secrets.get).toHaveBeenCalledOnce()
    expect(secrets.get).toHaveBeenCalledWith('DATABASE_URL', { required: true })
  })
  it.each(['false', '0', 'off', 'no', ' OFF '])('honors the explicit TLS disable value %s', DB_SSL => {
    expect(databaseConnectionConfig({ get: () => fixtureUrl }, { NODE_ENV: 'production', DB_SSL }).ssl).toBe(false)
  })
  it('retains the explicit certificate policy and development defaults', () => {
    expect(databaseConnectionConfig({ get: () => fixtureUrl }, { NODE_ENV: 'production', DB_SSL_REJECT_UNAUTHORIZED: 'false' }).ssl)
      .toMatchObject({ rejectUnauthorized: false })
    const secrets = { get: vi.fn(() => undefined) }
    expect(databaseConnectionConfig(secrets, {})).toEqual({ connectionString: undefined, ssl: false, max: 20 })
    expect(secrets.get).toHaveBeenCalledWith('DATABASE_URL', { required: false })
  })
  it('preserves provider failure without falling back to an environment URL', () => {
    const failure = new Error('fixture')
    expect(() => databaseConnectionConfig({ get: () => { throw failure } }, { DATABASE_URL: fixtureUrl })).toThrow(failure)
  })
  it('loads without instantiating providers or database clients', async () => {
    vi.resetModules()
    const provider = vi.fn(() => { throw new Error('unexpected provider load') })
    const driver = vi.fn(() => { throw new Error('unexpected driver load') })
    vi.doMock('../../src/security/SecretManager', provider)
    vi.doMock('pg', driver)
    try {
      await import('../../src/integration/db/connection-config')
      expect(provider).not.toHaveBeenCalled()
      expect(driver).not.toHaveBeenCalled()
    } finally { vi.doUnmock('../../src/security/SecretManager'); vi.doUnmock('pg') }
  })
})
