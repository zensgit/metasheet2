import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

// PLM-COLLAB P3-D2 (slice A): getEffectiveTenantId() must return the tenant the adapter ACTUALLY
// serves -- the `x-tenant-id` on connection.headers after connect(), read case-insensitively, since
// HTTPAdapter sends connection.headers verbatim. The precedence
//   configService('plm.tenantId')  ->  PLM_TENANT_ID (env)  ->  config.options.tenantId
// populates that header, but a HAND-SET connection x-tenant-id is NOT overwritten and wins. The
// embed relay cross-checks the embed token against this, so returning anything other than the actual
// served header would be FALSE CLOSURE (validate a tenant-A token while the adapter serves tenant-B).
//
// We exercise the real connect(): with no URL the adapter enters MOCK mode and connect() resolves the
// tenant, sets the header, and early-returns BEFORE any network call -- so this is a pure unit test.
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

function makeAdapter(opts: {
  globalTenant?: string
  globalOrg?: string
  optionsTenant?: string
  optionsOrg?: string
  connectionHeaders?: Record<string, string>
}): PLMAdapter {
  const get = vi.fn(async (key: string) => {
    if (key === 'plm.tenantId') return opts.globalTenant
    if (key === 'plm.orgId') return opts.globalOrg
    return undefined
  })
  const configService = { get }
  const config = {
    id: 'plm-embed',
    name: 'PLM',
    type: 'plm',
    // no URL -> mock mode -> connect() resolves the tenant + sets the x-tenant-id header then early-returns
    connection: { url: '', ...(opts.connectionHeaders ? { headers: opts.connectionHeaders } : {}) },
    options: {
      ...(opts.optionsTenant ? { tenantId: opts.optionsTenant } : {}),
      ...(opts.optionsOrg ? { orgId: opts.optionsOrg } : {}),
    },
  }
  return new PLMAdapter(configService as never, logger as never, config as never)
}

describe('PLMAdapter.getEffectiveTenantId (served tenant, full precedence)', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ['PLM_TENANT_ID', 'PLM_BASE_URL', 'PLM_URL', 'PLM_USERNAME', 'PLM_PASSWORD']) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is undefined before connect()', () => {
    const adapter = makeAdapter({ optionsTenant: 'tenant-a' })
    expect(adapter.getEffectiveTenantId()).toBeUndefined()
  })

  it('global configService plm.tenantId WINS over per-source options (the served tenant) — false-closure guard', async () => {
    const adapter = makeAdapter({ globalTenant: 'tenant-b', optionsTenant: 'tenant-a' })
    await adapter.connect()
    // the adapter sends x-tenant-id: tenant-b; validating against options (tenant-a) would be false closure
    expect(adapter.getEffectiveTenantId()).toBe('tenant-b')
  })

  it('PLM_TENANT_ID env beats per-source options when no global config', async () => {
    process.env.PLM_TENANT_ID = 'tenant-env'
    const adapter = makeAdapter({ optionsTenant: 'tenant-a' })
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBe('tenant-env')
  })

  it('falls back to per-source options.tenantId when neither global config nor env is set', async () => {
    const adapter = makeAdapter({ optionsTenant: 'tenant-a' })
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
  })

  it('falls back to per-source options.tenantId/orgId and sends both PLM scope headers', async () => {
    const adapter = makeAdapter({ optionsTenant: 'tenant-a', optionsOrg: 'org-a' })
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
    expect(((adapter as unknown as { config: { connection: { headers?: Record<string, string> } } }).config.connection.headers)).toMatchObject({
      'x-tenant-id': 'tenant-a',
      'x-org-id': 'org-a',
    })
  })

  it('is undefined when no tenant is configured anywhere (the relay then fails closed)', async () => {
    const adapter = makeAdapter({})
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBeUndefined()
  })

  it('a hand-set connection x-tenant-id IS the served tenant; a higher-precedence config does NOT override it', async () => {
    // applyTenantOrgHeaders does not overwrite a pre-set header, and HTTPAdapter sends it verbatim,
    // so the data request serves tenant-a even though global config says tenant-b. getEffectiveTenantId
    // must return tenant-a (the served value) -- returning tenant-b would be false closure.
    const adapter = makeAdapter({ globalTenant: 'tenant-b', connectionHeaders: { 'x-tenant-id': 'tenant-a' } })
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
  })

  it('disagreeing x-tenant-id header casings -> undefined (ambiguous served tenant; the relay fails closed)', async () => {
    // hand-set 'X-Tenant-Id'=tenant-a; applyTenantOrgHeaders adds lowercase 'x-tenant-id'=tenant-b ->
    // two casings disagree -> the served tenant is ambiguous -> undefined.
    const adapter = makeAdapter({ globalTenant: 'tenant-b', connectionHeaders: { 'X-Tenant-Id': 'tenant-a' } })
    await adapter.connect()
    expect(adapter.getEffectiveTenantId()).toBeUndefined()
  })
})
