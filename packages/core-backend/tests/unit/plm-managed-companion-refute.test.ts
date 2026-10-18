import { afterEach, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: db.query }))
import { enterLegacySharedTransport, setManagedBindingReaderForTests } from '../../src/services/plm-managed-companion'
afterEach(() => { vi.unstubAllEnvs(); db.query.mockReset(); setManagedBindingReaderForTests(null) })
it.each([
  ['42P01', 'false', 'PLM_MANAGED_SCHEMA_MISSING'],
  ['ECONNREFUSED', 'false', 'PLM_MANAGED_BINDING_UNAVAILABLE'],
  ['42P01', 'removed', 'PLM_MANAGED_SCHEMA_MISSING'],
  ['ECONNREFUSED', 'removed', 'PLM_MANAGED_BINDING_UNAVAILABLE'],
] as const)('never falls back to shared transport on %s with flag %s', async (code, flag, refusal) => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic@localhost/unused')
  if (flag === 'removed') delete process.env.PLM_MANAGED_COMPANION_ENABLED
  else vi.stubEnv('PLM_MANAGED_COMPANION_ENABLED', 'false')
  db.query.mockRejectedValue(Object.assign(new Error('synthetic database refusal'), { code }))
  const shared = vi.fn(async () => 'shared credential used')
  await expect(enterLegacySharedTransport('persisted-managed-source', 'refute', shared)).rejects.toMatchObject({
    status: 403,
    code: refusal,
  })
  expect(shared).not.toHaveBeenCalled()
  expect(db.query).toHaveBeenCalledOnce()
})
it('does not treat a missing database URL as an unbound legacy source', async () => {
  const savedUrl = process.env.DATABASE_URL
  const savedFlag = process.env.PLM_MANAGED_COMPANION_ENABLED
  delete process.env.DATABASE_URL
  delete process.env.PLM_MANAGED_COMPANION_ENABLED
  try {
    db.query.mockRejectedValue(Object.assign(new Error('must not query'), { code: '42P01' }))
    const shared = vi.fn(async () => 'shared credential used')
    await expect(enterLegacySharedTransport('persisted-managed-source', 'missing-url', shared)).rejects.toMatchObject({
      status: 403,
      code: 'PLM_MANAGED_BINDING_UNAVAILABLE',
    })
    expect(shared).not.toHaveBeenCalled()
    expect(db.query).not.toHaveBeenCalled()
  } finally {
    if (savedUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = savedUrl
    if (savedFlag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
    else process.env.PLM_MANAGED_COMPANION_ENABLED = savedFlag
  }
})
it('keeps an explicitly queried unbound legacy source usable', async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic@localhost/unused')
  vi.stubEnv('PLM_MANAGED_COMPANION_ENABLED', 'false')
  db.query.mockResolvedValue({ rows: [] })
  const shared = vi.fn(async () => 'legacy positive')
  await expect(enterLegacySharedTransport('unbound-source', 'positive', shared)).resolves.toBe('legacy positive')
  expect(shared).toHaveBeenCalledOnce()
  expect(db.query).toHaveBeenCalledOnce()
})
