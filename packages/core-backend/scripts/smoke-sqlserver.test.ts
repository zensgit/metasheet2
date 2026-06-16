import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildConfig, loadMSSQLAdapter, MSSQL_ADAPTER_CANDIDATES } from './smoke-sqlserver'

// Verifies the smoke harness EXPOSES the B3 legacy-TLS lever via env — i.e. MSSQL_LEGACY_TLS /
// MSSQL_TLS_MIN_VERSION / MSSQL_TLS_CIPHERS actually reach connection.{legacyTls,tlsMinVersion,tlsCiphers},
// the exact seam MSSQLAdapter.buildLegacyTlsOptions reads (the adapter's own tests own the rest of the
// chain → cryptoCredentialsDetails). Without this, "expose the env" could be a silent no-op.

const MANAGED_KEYS = [
  'MSSQL_DATABASE', 'MSSQL_USERNAME', 'MSSQL_PASSWORD', 'MSSQL_HOST', 'MSSQL_ENCRYPT',
  'MSSQL_LEGACY_TLS', 'MSSQL_TLS_MIN_VERSION', 'MSSQL_TLS_CIPHERS',
]
const saved: Record<string, string | undefined> = {}

function setRequired(): void {
  process.env.MSSQL_DATABASE = 'ERP'
  process.env.MSSQL_USERNAME = 'readonly_user'
  process.env.MSSQL_PASSWORD = 'pw'
}

describe('smoke-sqlserver buildConfig — B3 legacy-TLS env exposure', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) { saved[key] = process.env[key]; delete process.env[key] }
  })
  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('maps the B3 TLS knobs (legacyTls / tlsMinVersion / tlsCiphers) onto the connection', () => {
    setRequired()
    process.env.MSSQL_LEGACY_TLS = 'true'
    process.env.MSSQL_TLS_MIN_VERSION = 'TLSv1'
    process.env.MSSQL_TLS_CIPHERS = 'DEFAULT@SECLEVEL=0'
    const cfg = buildConfig()
    expect(cfg.connection.legacyTls).toBe(true)
    expect(cfg.connection.tlsMinVersion).toBe('TLSv1')
    expect(cfg.connection.tlsCiphers).toBe('DEFAULT@SECLEVEL=0')
    expect(cfg.type).toBe('sqlserver')
    expect((cfg.options as Record<string, unknown>).readOnly).toBe(true) // smoke stays read-only
  })

  it('omits the TLS knobs when their env is unset (no silent defaults)', () => {
    setRequired()
    const cfg = buildConfig()
    expect('legacyTls' in cfg.connection).toBe(false)
    expect('tlsMinVersion' in cfg.connection).toBe(false)
    expect('tlsCiphers' in cfg.connection).toBe(false)
  })

  it('treats empty / whitespace TLS env as unset (never passes an empty cipher string)', () => {
    setRequired()
    process.env.MSSQL_TLS_CIPHERS = '   '
    const cfg = buildConfig()
    expect('tlsCiphers' in cfg.connection).toBe(false)
  })

  it('rejects a non-boolean MSSQL_LEGACY_TLS (no silent coercion)', () => {
    setRequired()
    process.env.MSSQL_LEGACY_TLS = 'maybe'
    expect(() => buildConfig()).toThrow(/boolean-like/)
  })

  it('loads the deployable compiled adapter path before the local source fallback', () => {
    expect(MSSQL_ADAPTER_CANDIDATES[0]).toBe('../dist/src/data-adapters/MSSQLAdapter.js')
    expect(MSSQL_ADAPTER_CANDIDATES).toContain('../src/data-adapters/MSSQLAdapter.ts')
  })

  it('loads an MSSQLAdapter constructor without opening a connection', async () => {
    expect(typeof (await loadMSSQLAdapter())).toBe('function')
  })
})
