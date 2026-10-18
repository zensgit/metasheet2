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

  it('keeps the callback as the only exact session-gate exception', () => {
    expect(isGateException('/api/plm/managed-login/callback')).toBe(true)
    expect(isGateException('/api/plm/managed-login/callback/extra')).toBe(false)
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
    const manifest = await adapter.getIntegrationCapabilities()
    expect(manifest.manifest?.features.bom_multitable?.supported).toBe(true)
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
