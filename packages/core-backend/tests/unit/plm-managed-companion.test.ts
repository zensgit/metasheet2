import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import {
  createDataSourcePluginFacade,
  createDataSourceSealedSnapshotConnectionFacade,
  createDataSourceWritePluginFacade,
} from '../../src/data-adapters/data-source-plugin-facade'
import { authService } from '../../src/auth/AuthService'
import { persistedManagedContinuity } from '../../src/auth/plm-managed-session'
import { isGateException } from '../../src/auth/api-path-policy'
import { resolveRuntimeJwtSecret } from '../../src/security/auth-runtime-config'
import { secretManager } from '../../src/security/SecretManager'
import {
  MANAGED_COMPANION_PURPOSE,
  ManagedCompanionRefusal,
  assertLegacySharedTransportAllowed,
  bindingFingerprintMatches,
  buildManagedLoginNavigation,
  classifyManagedSource,
  cookieSecureFor,
  enterLegacySharedTransport,
  isPlmManagedCompanionEnabled,
  managedClientRegistry,
  noteSharedTransportCall,
  pkceS256,
  readSharedTransportAudit,
  registrationFor,
  resetSharedTransportAudit,
  sealCredential,
  setManagedBindingReaderForTests,
  sourceFingerprint,
  type ManagedBindingRow,
  type ManagedClientRegistration,
} from '../../src/services/plm-managed-companion'
import { setManagedFixtureClockForTests, setManagedFlowHooksForTests } from '../../src/services/plm-managed-companion-flow'
import { setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import * as managedFlow from '../../src/services/plm-managed-companion-flow'

const origin = 'https://native.example.test'
const ownerId = 'meta-owner'
const rootPartId = 'part'
const fingerprint = sourceFingerprint({
  type: 'plm',
  origin,
  ownerId,
  rootPartId,
  tenantId: null,
  workspaceId: null,
  scopeKind: null,
})

const registration: ManagedClientRegistration = {
  issuer: 'https://native.example.test/installation',
  clientId: 'managed-fixture',
  clientSecret: 'synthetic-client-secret-configured-control',
  callback: 'https://metasheet.example.test/api/plm/managed-login/callback',
  origin,
  nativeTenantId: 'default',
  nativeOrgId: 'fixture-org',
  nativeBaseUrl: 'https://native.example.test',
}

function bindingRow(overrides: Partial<ManagedBindingRow> = {}): ManagedBindingRow {
  return {
    data_source_id: 'src-managed',
    link_id: 'link-1',
    generation: 1,
    binding_status: 'active',
    source_fingerprint: fingerprint,
    frozen_origin: origin,
    frozen_root_part_id: rootPartId,
    link_status: 'active',
    link_generation: 1,
    meta_user_id: ownerId,
    meta_tenant_id: 'meta-tenant',
    meta_org_id: 'meta-org',
    native_auth_user_id: '42',
    native_tenant_id: 'default',
    native_org_id: 'fixture-org',
    installation_issuer: registration.issuer,
    client_origin: origin,
    root_part_id: rootPartId,
    owner_user_id: ownerId,
    source_type: 'plm',
    owner_id: ownerId,
    config: { connection: { url: `${origin}/plm` }, credentials: { token: 'yur_must-not-be-authority' } },
    is_active: true,
    deleted_at: null,
    tenant_id: null,
    workspace_id: null,
    scope_kind: null,
    ...overrides,
  }
}

function secret(): string {
  return resolveRuntimeJwtSecret(secretManager.get('JWT_SECRET', { required: false }))
}

afterEach(() => {
  setManagedBindingReaderForTests(null)
  setManagedNativeFetchForTests(null)
  setManagedFlowHooksForTests(null)
  resetSharedTransportAudit()
  delete process.env.PLM_MANAGED_COMPANION_ENABLED
  delete process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON
  delete process.env.PLM_MANAGED_COMPANION_TEST_HOOKS
  delete process.env.RBAC_TOKEN_TRUST
})

describe('managed companion registration and navigation', () => {
  it('requires the exact true flag and an exact client registration', () => {
    expect(isPlmManagedCompanionEnabled()).toBe(false)
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'TRUE'
    expect(isPlmManagedCompanionEnabled()).toBe(false)
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    expect(isPlmManagedCompanionEnabled()).toBe(true)
    expect(() => managedClientRegistry()).not.toThrow()
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ ...registration, extra: 'no' }])
    expect(() => managedClientRegistry()).toThrow(ManagedCompanionRefusal)
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([registration])
    expect(registrationFor({
      issuer: registration.issuer,
      nativeTenantId: registration.nativeTenantId,
      nativeOrgId: registration.nativeOrgId,
    }).clientId).toBe('managed-fixture')
    expect(() => registrationFor({
      issuer: registration.issuer,
      nativeTenantId: 'other',
      nativeOrgId: registration.nativeOrgId,
    })).toThrow(ManagedCompanionRefusal)
  })

  it('navigates with the ten public fields once and refuses secrets in the query', () => {
    const verifier = 'a'.repeat(43)
    const url = new URL(buildManagedLoginNavigation(registration, {
      rootPartId,
      state: 'synthetic-browser-state',
      codeChallenge: pkceS256(verifier),
    }))
    expect(url.origin + url.pathname).toBe('https://native.example.test/managed-login')
    expect([...url.searchParams.keys()].sort()).toEqual([
      'callback', 'client_id', 'code_challenge', 'code_challenge_method', 'issuer', 'org_id', 'origin', 'root_part_id', 'state', 'tenant_id',
    ])
    for (const key of url.searchParams.keys()) expect(url.searchParams.getAll(key)).toHaveLength(1)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.search).not.toMatch(/clientSecret|code_verifier|yur_/)
    expect(url.searchParams.get('client_id')).toBe('managed-fixture')
    expect(cookieSecureFor(registration.callback)).toBe(true)
    expect(cookieSecureFor('http://127.0.0.1:9/api/plm/managed-login/callback')).toBe(false)
  })

  it('preserves public root identifiers without adding credential query fields', () => {
    const url = new URL(buildManagedLoginNavigation(registration, {
      rootPartId: 'yur_public-part',
      state: 'synthetic-browser-state',
      codeChallenge: pkceS256('a'.repeat(43)),
    }))
    expect(url.searchParams.get('root_part_id')).toBe('yur_public-part')
    expect(url.searchParams.has('clientSecret')).toBe(false)
    expect(url.searchParams.has('code_verifier')).toBe(false)
    expect([...url.searchParams.keys()]).toHaveLength(10)
  })

  it('appends continuity_hint=hour beside the ten public fields and nowhere else', () => {
    const ordinary = new URL(buildManagedLoginNavigation(registration, {
      rootPartId,
      state: 'synthetic-browser-state',
      codeChallenge: pkceS256('a'.repeat(43)),
    }))
    const hour = new URL(buildManagedLoginNavigation(registration, {
      rootPartId,
      state: 'synthetic-browser-state',
      codeChallenge: pkceS256('a'.repeat(43)),
      continuityHint: 'hour',
    }))
    expect([...ordinary.searchParams.keys()]).toHaveLength(10)
    expect(ordinary.searchParams.has('continuity_hint')).toBe(false)
    expect([...hour.searchParams.keys()]).toEqual([...ordinary.searchParams.keys(), 'continuity_hint'])
    expect(hour.searchParams.getAll('continuity_hint')).toEqual(['hour'])
    expect(hour.search).not.toMatch(/clientSecret|code_verifier|continuityMode/)
  })

  it('keeps start, unlink, and revoke-retry behind the session gate', () => {
    expect(isGateException('/api/plm/managed-login/callback')).toBe(true)
    expect(isGateException('/api/plm/managed-login/browser-start')).toBe(true)
    expect(isGateException('/api/plm/managed-login/complete')).toBe(true)
    expect(isGateException('/api/plm/managed-login/current')).toBe(true)
    expect(isGateException('/api/plm/managed-login/logout')).toBe(true)
    expect(isGateException('/api/plm/managed-login/callback/extra')).toBe(false)
    expect(isGateException('/api/plm/managed-login/browser-start/extra')).toBe(false)
    expect(isGateException('/api/plm/managed-login/start')).toBe(false)
    expect(isGateException('/api/plm/managed-login/unlink')).toBe(false)
    expect(isGateException('/api/plm/managed-login/revoke-retry')).toBe(false)
  })
})

describe('managed session purpose precedes the trusted-user shortcut', () => {
  it('does not accept admin claims on a managed token and still accepts a normal token', async () => {
    process.env.RBAC_TOKEN_TRUST = 'true'
    const claims = {
      userId: 'meta-other',
      email: 'other@example.test',
      role: 'admin',
      roles: ['admin'],
      perms: ['*:*'],
      tenantId: 'meta-tenant',
    }
    const normal = jwt.sign(claims, secret(), { expiresIn: '5m' })
    const managed = jwt.sign({ ...claims, purpose: MANAGED_COMPANION_PURPOSE }, secret(), { expiresIn: '5m' })
    const trusted = await authService.verifyToken(normal)
    expect(trusted?.id).toBe('meta-other')
    expect(trusted?.role).toBe('admin')
    expect(await authService.verifyToken(managed)).toBeNull()
    const getUser = vi.spyOn(authService as unknown as { getUserById: (id: string) => Promise<unknown> }, 'getUserById')
    expect(await authService.refreshToken(managed)).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
    getUser.mockRestore()
  })

  it('refuses test hooks unless the explicit test gate is on and the process is not production', () => {
    expect(() => setManagedFlowHooksForTests({ loseExchangeResponse: true })).toThrow(ManagedCompanionRefusal)
    expect(() => setManagedFixtureClockForTests(new Date('2026-10-18T00:00:00.000Z'))).toThrow(ManagedCompanionRefusal)
    process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
    setManagedFlowHooksForTests({ loseExchangeResponse: true })
    setManagedFixtureClockForTests(new Date('2026-10-18T00:00:00.000Z'))
    setManagedFlowHooksForTests(null)
    const prior = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    expect(() => setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))).toThrow(ManagedCompanionRefusal)
    expect(() => setManagedFixtureClockForTests(new Date('2026-10-18T00:00:00.000Z'))).toThrow(ManagedCompanionRefusal)
    expect(() => setManagedFlowHooksForTests({ loseExchangeResponse: true })).toThrow(ManagedCompanionRefusal)
    process.env.NODE_ENV = prior
  })
})

describe('legacy shared transport sentinel', () => {
  it('refuses a managed binding before any shared call, including cache and plugin facades', async () => {
    const row = bindingRow()
    expect(bindingFingerprintMatches(row)).toBe(true)
    expect(bindingFingerprintMatches({ ...row, client_origin: 'https://metasheet.example.test' })).toBe(true)
    expect(bindingFingerprintMatches({ ...row, config: { connection: { url: 'https://changed.example.test/plm' } } })).toBe(false)
    expect(bindingFingerprintMatches({ ...row, tenant_id: 'moved-tenant' })).toBe(false)
    expect(bindingFingerprintMatches({ ...row, workspace_id: 'moved-workspace' })).toBe(false)
    expect(bindingFingerprintMatches({ ...row, scope_kind: 'workspace' })).toBe(false)
    setManagedBindingReaderForTests(async (id) => {
      if (id === 'src-unbound') return { kind: 'unbound' }
      if (id === 'src-schema') return { kind: 'schema-missing' }
      return { kind: 'bound', row: { ...row, data_source_id: id } }
    })
    await expect(assertLegacySharedTransportAllowed('src-managed')).rejects.toMatchObject({
      code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED',
    })
    await expect(assertLegacySharedTransportAllowed('src-schema')).rejects.toMatchObject({
      code: 'PLM_MANAGED_SCHEMA_MISSING',
    })
    expect(readSharedTransportAudit().calls).toBe(0)
    await enterLegacySharedTransport('src-unbound', 'positive.unbound', async () => 'ok')
    expect(readSharedTransportAudit().calls).toBe(1)

    resetSharedTransportAudit()
    const adapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { id: 'src-managed', name: 'managed', type: 'plm', connection: { url: `${origin}/plm` } },
    )
    ;(adapter as unknown as { mockMode: boolean }).mockMode = true
    await expect(adapter.connect()).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(adapter.query('SELECT 1')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(adapter.getProductBOM('part')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(adapter.getBomMultitableContext('part')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(adapter.listVisualPreviewFiles('embed')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(adapter.getVisualPreviewImage('embed', 'file', 'ver', origin)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([registration])
    process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
    setManagedNativeFetchForTests(async () => new Response(JSON.stringify({
      provider: 'yuantus-plm', advisory: true, schema_version: 'v1',
      features: { bom_multitable: { supported: true } },
    })))
    const manifest = await adapter.getIntegrationCapabilities()
    expect(manifest).toEqual({ available: false, reason: 'unavailable' })
    expect(manifest.manifest?.features.bom_eco_revision).toBeUndefined()
    expect(manifest.manifest?.features.bom_multitable_writeback).toBeUndefined()
    expect(readSharedTransportAudit().calls).toBe(0)

    resetSharedTransportAudit()
    setManagedBindingReaderForTests(async () => ({ kind: 'bound', row: bindingRow({ source_fingerprint: 'f'.repeat(64) }) }))
    await expect(adapter.getIntegrationCapabilities()).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    expect(readSharedTransportAudit().calls).toBe(0)

    resetSharedTransportAudit()
    const cacheAdapter = new PLMAdapter(
      { get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { id: 'src-unbound', name: 'legacy', type: 'plm', connection: { url: `${origin}/plm` } },
    )
    ;(cacheAdapter as unknown as { mockMode: boolean }).mockMode = true
    setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
    await cacheAdapter.getIntegrationCapabilities()
    const afterFirst = readSharedTransportAudit().calls
    await cacheAdapter.getIntegrationCapabilities()
    expect(readSharedTransportAudit().calls).toBeGreaterThan(afterFirst)

    resetSharedTransportAudit()
    setManagedBindingReaderForTests(async () => ({ kind: 'bound', row }))
    const manager = new DataSourceManager()
    const config = {
      id: 'src-managed',
      name: 'managed',
      type: 'postgres',
      connection: { host: '127.0.0.1', port: 1, database: 'none' },
      options: { autoConnect: false },
    }
    const other = { ...config, id: 'src-other' }
    await manager.addDataSource(config, { persist: false, ownerId })
    await manager.addDataSource(other, { persist: false, ownerId })
    await expect(manager.connectDataSource('src-managed')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.testConnection('src-managed')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.query('src-managed', 'SELECT 1')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.select('src-managed', 'parts')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.insert('src-managed', 'parts', { id: 'x' })).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.update('src-managed', 'parts', { id: 'x' }, { id: 'x' })).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.delete('src-managed', 'parts', { id: 'x' })).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(manager.copyData('src-managed', 'parts', 'src-other', 'parts')).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    expect(readSharedTransportAudit().calls).toBe(0)

    resetSharedTransportAudit()
    setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
    await expect(manager.insert('src-managed', 'parts', { id: 'x' })).rejects.toThrow(/read-only/)
    expect(readSharedTransportAudit().paths).toContain('DataSourceManager.insert')

    resetSharedTransportAudit()
    setManagedBindingReaderForTests(async () => ({ kind: 'bound', row }))
    const touched = vi.fn()
    const facade = createDataSourcePluginFacade(() => {
      touched()
      return manager
    })
    const sealed = createDataSourceSealedSnapshotConnectionFacade(() => {
      touched()
      return manager
    })
    const writer = createDataSourceWritePluginFacade(() => {
      touched()
      return manager
    })
    await expect(facade.describe('src-managed', ownerId)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(facade.assertReferenceable('src-managed', ownerId)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(facade.resolveConnectionRegistration('src-managed', {
      principal: ownerId,
      tenantId: 'meta-org',
      runAs: 'user',
    })).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(sealed.resolveSqlServerConnection('src-managed', {
      principal: ownerId,
      tenantId: 'meta-org',
      runAs: 'user',
    })).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    await expect(writer.test('src-managed', ownerId)).rejects.toBeInstanceOf(ManagedCompanionRefusal)
    expect(touched).not.toHaveBeenCalled()
    expect(readSharedTransportAudit().calls).toBe(0)

    resetSharedTransportAudit()
    setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
    const described = await facade.describe('src-managed', ownerId)
    expect(described.id).toBe('src-managed')
    expect(readSharedTransportAudit().paths).toContain('plugin-facade.read.describe')
    noteSharedTransportCall('data-sources.schema')
    expect(readSharedTransportAudit().paths).toContain('data-sources.schema')
  })

  it('seals only a yur_ credential', () => {
    expect(sealCredential('yur_synthetic').startsWith('enc:')).toBe(true)
    expect(() => sealCredential('manual-token')).toThrow(ManagedCompanionRefusal)
  })

  it('does not open a pool or allow shared transport when no explicit database URL is configured', async () => {
    expect(process.env.DATABASE_URL ?? '').toBe('')
    delete process.env.PLM_MANAGED_COMPANION_ENABLED
    await expect(classifyManagedSource('src-managed')).resolves.toEqual({ kind: 'unavailable' })
    await expect(enterLegacySharedTransport('src-managed', 'missing-url', async () => 'shared')).rejects.toMatchObject({
      status: 403,
      code: 'PLM_MANAGED_BINDING_UNAVAILABLE',
    })
    expect(readSharedTransportAudit().calls).toBe(0)
  })
})

describe('managed capability discovery', () => {
  const payload = (entitled: boolean) => ({ provider: 'yuantus-plm', advisory: true, schema_version: 'v1',
    features: { bom_multitable: { supported: true, entitled },
      bom_eco_revision: { supported: true, entitled, actions: ['eco_revision_intent'] } } })

  function configured(fetcher: typeof fetch, reader = async () => ({ kind: 'bound' as const, row: bindingRow() })) {
    process.env.PLM_MANAGED_COMPANION_ENABLED = 'true'
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([registration])
    process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
    setManagedBindingReaderForTests(reader)
    vi.spyOn(managedFlow, 'relayManagedBomSnapshot').mockImplementation(async () => {
      if (!managedRequestContext.getStore()?.sessionId) {
        return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' }
      }
      // Adapter admission and pre/post source checks; transport is tested separately.
      const response = await fetcher('fixture-managed-read')
      if (!response.ok) return { kind: 'refusal', status: 502, code: 'PLM_MANAGED_READ_REFUSED' }
      return { kind: 'ok', entitled: true, snapshot: {} as never,
        advisoryCapabilities: await response.json() }
    })
    const a = new PLMAdapter({ get: async () => undefined } as never,
      { info() {}, warn() {}, error() {}, debug() {} } as never,
      { id: 'src-managed', name: 'managed', type: 'plm', connection: { url: origin },
        credentials: { token: 'shared-secret-must-never-be-used' } } as never)
    ;(a as unknown as { mockMode: boolean }).mockMode = true
    return a
  }

  function readCapabilities(a: PLMAdapter) {
    const read = () => a.getIntegrationCapabilities()
    return managedRequestContext.getStore() ? read() : managedRequestContext.run({
      userId: ownerId, sessionId: 'managed-session', conflict: false, metaTenantId: 'meta-tenant',
    }, read)
  }

  it('uses the authenticated read relay and does not cache advisory entitlement', async () => {
    let entitled = true
    const fetched = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(payload(entitled))))
    const a = configured(fetched)
    const enabled = await readCapabilities(a)
    expect(enabled.available).toBe(true)
    if (!enabled.available) throw new Error('real advisory missing')
    expect(enabled.manifest.features.bom_eco_revision?.entitled).toBe(true)
    expect(enabled.manifest.features.bom_eco_revision?.actions).toEqual(['eco_revision_intent'])
    entitled = false
    expect((await readCapabilities(a)).manifest?.features.bom_eco_revision?.entitled).toBe(false)
    expect(fetched).toHaveBeenCalledTimes(2)
    expect(managedFlow.relayManagedBomSnapshot).toHaveBeenCalledWith({
      userId: ownerId, dataSourceId: 'src-managed', partId: rootPartId,
    })
    expect(JSON.stringify(vi.mocked(managedFlow.relayManagedBomSnapshot).mock.calls)).not.toContain(registration.clientSecret)
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it.each(['unset', 'false', 'TRUE', '0', ''])('never uses a shared fallback for flag %s', async (flag) => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
    const a = configured(fetched)
    if (flag === 'unset') delete process.env.PLM_MANAGED_COMPANION_ENABLED
    else process.env.PLM_MANAGED_COMPANION_ENABLED = flag
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).not.toHaveBeenCalled()
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it.each(['nativeBaseUrl', 'origin'] as const)('rejects a changed registration %s before any request', async field => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
    const a = configured(fetched)
    process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ ...registration, [field]: 'https://another.example.test' }])
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).not.toHaveBeenCalled()
  })

  it('discards an advisory response when the durable generation changes during fetch', async () => {
    let generation = 1
    const fetched = vi.fn(async () => { generation = 2; return new Response(JSON.stringify(payload(true))) })
    const a = configured(fetched, async () => ({ kind: 'bound', row: bindingRow({ generation, link_generation: generation }) }))
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).toHaveBeenCalledOnce()
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it.each(['native_auth_user_id', 'native_org_id', 'meta_tenant_id', 'installation_issuer'] as const)(
    'rejects a changed %s during fetch', async (field) => {
      let row = bindingRow()
      const fetched = vi.fn(async () => { row = { ...row, [field]: 'changed' }; return new Response(JSON.stringify(payload(true))) })
      const a = configured(fetched, async () => ({ kind: 'bound', row }))
      expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
      expect(fetched).toHaveBeenCalledOnce()
      expect(readSharedTransportAudit().calls).toBe(0)
    })

  it.each([302, 404, 503])('does not fall back after native HTTP %s', async (status) => {
    const fetched = vi.fn(async () => new Response('{}', { status }))
    const a = configured(fetched)
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it('does not return a stale cached manifest after unlink', async () => {
    let row = bindingRow()
    const a = configured(async () => new Response(JSON.stringify(payload(true))), async () => ({ kind: 'bound', row }))
    expect((await readCapabilities(a)).available).toBe(true)
    row = { ...row, binding_status: 'revoked' }
    await expect(a.getIntegrationCapabilities()).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it('does not use a mock or shared client when the authenticated read relay aborts', async () => {
    const fetched = vi.fn(async () => { throw new Error('owned abort') })
    const a = configured(fetched)
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).toHaveBeenCalledOnce()
    expect(readSharedTransportAudit().calls).toBe(0)
  })

  it('refuses a registration changed during the authenticated read', async () => {
    const fetched = vi.fn(async () => {
      process.env.PLM_MANAGED_COMPANION_CLIENTS_JSON = JSON.stringify([{ ...registration, nativeBaseUrl: 'https://another.example.test' }])
      return new Response(JSON.stringify(payload(true)))
    })
    const a = configured(fetched)
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).toHaveBeenCalledOnce()
  })

  it.each([{ userId: 'previous-owner', conflict: false }, { userId: ownerId, conflict: true }])(
    'refuses a stale owner or conflicting authenticated request %s', async actor => {
      const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
      const a = configured(fetched)
      await managedRequestContext.run({ ...actor, sessionId: 'managed-session' }, async () => {
        expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
      })
      expect(fetched).not.toHaveBeenCalled()
      expect(readSharedTransportAudit().calls).toBe(0)
    })

  it.each([undefined, null, registration.nativeTenantId])('does not substitute native or missing scope for Meta tenant %s', async metaTenantId => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
    const a = configured(fetched)
    await managedRequestContext.run({ userId: ownerId, sessionId: 'managed-session', conflict: false, metaTenantId }, async () => {
      expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    })
    expect(fetched).not.toHaveBeenCalled()
  })

  it('keeps the authenticated Meta tenant separate from the native tenant headers', async () => {
    const fetched = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(JSON.stringify(payload(true))))
    const a = configured(fetched)
    await managedRequestContext.run({ userId: ownerId, sessionId: 'managed-session', conflict: false, metaTenantId: 'meta-tenant' }, async () => {
      expect((await readCapabilities(a)).available).toBe(true)
    })
    expect(managedFlow.relayManagedBomSnapshot).toHaveBeenCalledWith({ userId: ownerId, dataSourceId: 'src-managed', partId: rootPartId })
  })

  it('refuses a source tenant different from the persisted Meta binding even with a matching fingerprint', async () => {
    const row = bindingRow({ tenant_id: 'other-meta', source_fingerprint: sourceFingerprint({
      type: 'plm', origin, ownerId, rootPartId, tenantId: 'other-meta', workspaceId: null, scopeKind: null,
    }) })
    expect(bindingFingerprintMatches(row)).toBe(true)
    const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
    const a = configured(fetched, async () => ({ kind: 'bound', row }))
    expect(await readCapabilities(a)).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).not.toHaveBeenCalled()
  })

  it('does not fetch advisory metadata without a current managed read session', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify(payload(true))))
    const a = configured(fetched)
    expect(await a.getIntegrationCapabilities()).toEqual({ available: false, reason: 'unavailable' })
    expect(fetched).not.toHaveBeenCalled()
    expect(readSharedTransportAudit().calls).toBe(0)
  })
})

describe('persisted managed continuity', () => {
  const row = {
    generation: 4,
    linkGeneration: 4,
    continuityMode: 'continuous' as const,
    credentialGeneration: 2,
    intentId: null,
  }

  it('keeps the Meta link revision distinct from the native credential generation', () => {
    expect(persistedManagedContinuity(row)).toEqual({
      revision: 4,
      continuityMode: 'continuous',
      credentialGeneration: 2,
    })
    expect(persistedManagedContinuity({
      ...row,
      generation: '4',
      linkGeneration: '4',
      credentialGeneration: '0',
      intentId: 'intent-1',
    })).toEqual({ revision: 4, continuityMode: 'continuous', credentialGeneration: 0 })
    expect(persistedManagedContinuity({
      generation: 1,
      linkGeneration: 1,
      continuityMode: 'ordinary',
      credentialGeneration: null,
      intentId: 'intent-ordinary',
    })).toEqual({ revision: 1, continuityMode: 'ordinary', credentialGeneration: null })
  })

  it('fails closed on inconsistent persisted continuity', () => {
    expect(persistedManagedContinuity({ ...row, continuityMode: 'ordinary', credentialGeneration: 0, intentId: 'intent-1' })).toBeNull()
    expect(persistedManagedContinuity({ ...row, credentialGeneration: null, intentId: 'intent-1' })).toBeNull()
    expect(persistedManagedContinuity({ ...row, credentialGeneration: 0, intentId: null })).toBeNull()
    expect(persistedManagedContinuity({ ...row, credentialGeneration: 2, intentId: 'intent-1' })).toBeNull()
    expect(persistedManagedContinuity({ ...row, linkGeneration: 5 })).toBeNull()
    expect(persistedManagedContinuity({ ...row, credentialGeneration: 8 })).toBeNull()
    expect(persistedManagedContinuity({ ...row, continuityMode: 'snapshot' })).toBeNull()
    expect(persistedManagedContinuity({ ...row, generation: 0 })).toBeNull()
    expect(persistedManagedContinuity({
      generation: 1,
      linkGeneration: 1,
      continuityMode: 'ordinary',
      credentialGeneration: null,
      intentId: null,
    })).toBeNull()
  })
})
