import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), classify: vi.fn(), context: vi.fn(), status: vi.fn() }))
vi.mock('../../src/db/pg', () => ({
  query: mocks.query,
  transaction: (fn: (client: { query: typeof mocks.query }) => Promise<unknown>) => fn({ query: mocks.query }),
}))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))
vi.mock('../../src/services/plm-managed-native-http', () => ({
  nativeExchange: vi.fn(), nativeRevoke: vi.fn(), nativeStatus: mocks.status, nativeManagedContext: mocks.context,
}))
vi.mock('../../src/services/plm-managed-companion', async (original) => ({
  ...await original<typeof import('../../src/services/plm-managed-companion')>(),
  classifyManagedSource: mocks.classify,
  isPlmManagedCompanionEnabled: () => true,
  bindingFingerprintMatches: () => true,
  registrationFor: () => ({
    issuer: 'fixture',
    clientId: 'client',
    clientSecret: 'secret',
    callback: 'https://meta.invalid/callback',
    origin: 'https://meta.invalid',
    nativeTenantId: 'native-tenant',
    nativeOrgId: 'native-org',
    nativeBaseUrl: 'https://native.invalid',
  }),
  openCredential: () => 'synthetic-personal-read',
}))
import { relayManagedBomContext, relayManagedBomSnapshot } from '../../src/services/plm-managed-companion-flow'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { parseManagedSnapshot, parseShareSnapshot, snapshotHash } from '../../src/multitable/plm-bom-review-wire'
import { MANAGED_COMPANION_SCOPE, sourceFingerprint } from '../../src/services/plm-managed-companion'
import { shareSnapshot } from '../plm-bom-review/fixture'

const nativeOrigin = 'https://native.invalid'
const sourceFingerprintValue = sourceFingerprint({
  type: 'plm', origin: nativeOrigin, ownerId: 'meta-person-900', rootPartId: 'P',
  tenantId: null, workspaceId: null, scopeKind: null,
})
const sessionRow = {
  id: 'session', link_id: 'link-1', data_source_id: 'source', delegation_id: 'delegation', generation: 3,
  credential_ciphertext: 'opaque', native_subject: '42', native_tenant_id: 'native-tenant', native_org_id: 'native-org',
  root_part_id: 'P', client_origin: 'https://meta.invalid', installation_issuer: 'fixture', client_id: 'client',
  revoked_at: null, meta_user_id: 'meta-person-900', meta_tenant_id: 'meta-tenant', meta_org_id: 'meta-org',
  scope: MANAGED_COMPANION_SCOPE, expires_at: new Date('2099-01-01T00:00:00Z'),
}
const linkRow = {
  id: 'link-1', status: 'active', generation: 3, source_fingerprint: sourceFingerprintValue,
  meta_user_id: 'meta-person-900', owner_user_id: 'meta-person-900', native_auth_user_id: '42',
  native_tenant_id: 'native-tenant', native_org_id: 'native-org', root_part_id: 'P',
  client_origin: 'https://meta.invalid', client_id: 'client', installation_issuer: 'fixture',
  callback: 'https://meta.invalid/callback', meta_tenant_id: 'meta-tenant', meta_org_id: 'meta-org',
}
const bindingRow = {
  status: 'active', link_id: 'link-1', data_source_id: 'source', generation: 3,
  source_fingerprint: sourceFingerprintValue, frozen_origin: nativeOrigin, frozen_root_part_id: 'P',
}
const sourceRow = {
  id: 'source', type: 'plm', owner_id: 'meta-person-900', is_active: true, deleted_at: null,
  config: { connection: { url: `${nativeOrigin}/plm` } }, tenant_id: null, workspace_id: null, scope_kind: null,
}
const userRow = { id: 'meta-person-900', is_active: true, role: 'user', activation_status: 'activated' }

function selectedRows(sql: string | undefined, params?: unknown[]): Record<string, unknown>[] {
  const statement = String(sql ?? '')
  if (!statement) return [sessionRow]
  if (statement.includes('plm_managed_renewal_operations')) return []
  if (statement.includes('user_orgs')) return [{ org_id: params?.[1] }]
  if (statement.includes('FROM users')) return [userRow]
  if (statement.includes('plm_managed_identity_links')) return [linkRow]
  if (statement.includes('plm_managed_source_bindings')) return [bindingRow]
  if (statement.includes('plm_managed_sessions')) return [sessionRow]
  if (statement.includes('data_sources')) return [sourceRow]
  if (statement.includes('pg_advisory_xact_lock')) return [{}]
  throw new Error(`projection fixture has no row for: ${statement}`)
}

const authority = { part_id: 'P', tenant_id: 'native-tenant', org_id: 'native-org', auth_user_id: '42' }
function payload() {
  return { ...shareSnapshot(), projection_contract: 'bom_review_managed.v1', source: { ...authority } }
}
function read() {
  return managedRequestContext.run({ userId: 'meta-person-900', sessionId: 'session', conflict: false },
    () => relayManagedBomContext({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
}
beforeEach(() => {
  mocks.classify.mockResolvedValue({ kind: 'bound', row: {
    link_id: 'link-1', meta_user_id: 'meta-person-900', frozen_root_part_id: 'P', client_origin: 'https://meta.invalid', generation: 3,
    native_auth_user_id: '42', native_tenant_id: 'native-tenant', native_org_id: 'native-org', installation_issuer: 'fixture',
  } })
  mocks.query.mockImplementation(async (sql?: string, params?: unknown[]) => ({ rows: selectedRows(sql, params) }))
  mocks.status.mockResolvedValue({ root_part_id: 'P', client_origin: 'https://meta.invalid', subject: '42', scope: MANAGED_COMPANION_SCOPE, tenant_id: 'native-tenant', org_id: 'native-org', issuer: 'fixture', client_id: 'client', delegation_id: 'delegation' })
  mocks.context.mockResolvedValue(payload())
})
afterEach(() => vi.resetAllMocks())

describe('managed personal projection envelope', () => {
  it('rejects a root mismatch inside a source-correct context', async () => {
    const raw = payload()
    raw.context.part.part_id = 'OTHER'
    mocks.context.mockResolvedValue(raw)
    await expect(read()).resolves.toMatchObject({ kind: 'refusal', status: 403 })
  })
  it('keeps the complete internal envelope and existing public context shape', async () => {
    const raw = payload()
    Object.assign(raw.context.lines[0], { write_etag: 'personal-cas' })
    mocks.context.mockResolvedValue(raw)
    const result = await managedRequestContext.run({ userId: 'meta-person-900', sessionId: 'session', conflict: false },
      () => relayManagedBomSnapshot({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
    expect(result).toEqual({ kind: 'ok', entitled: true, snapshot: raw })
    await expect(read()).resolves.toEqual({ kind: 'ok', entitled: true, context: raw.context })
  })
  it.each(['tenant_id', 'org_id', 'auth_user_id', 'part_id'] as const)('refuses mismatched native %s', async (key) => {
    const raw = payload()
    raw.source[key] = key === 'auth_user_id' ? '43' : 'different'
    mocks.context.mockResolvedValue(raw)
    await expect(read()).resolves.toMatchObject({ kind: 'refusal', status: 403 })
  })
  it.each([undefined, 'invalid', '2026-10-01'])('refuses incomplete snapshot timestamps %s', async (value) => {
    mocks.context.mockResolvedValue({ ...payload(), snapshot_at: value })
    await expect(read()).resolves.toMatchObject({ kind: 'refusal', status: 502 })
  })
  it('does not rebrand personal-read projection as persistent-share authority', () => {
    const parsed = parseManagedSnapshot(payload(), authority)
    expect(parsed.projection_contract).toBe('bom_review_managed.v1')
    expect(() => parseShareSnapshot(parsed, 'P')).toThrow()
    expect(() => parseManagedSnapshot(shareSnapshot(), authority)).toThrow()
  })
  it('keeps source/context hash stable across fetch timestamps and sensitive to authority', () => {
    const first = parseManagedSnapshot(payload(), authority)
    const second = parseManagedSnapshot({ ...payload(), snapshot_at: '2026-10-02T00:00:00Z' }, authority)
    // Both snapshots use the same source/context representation as the existing hash.
    expect(snapshotHash(first)).toBe(snapshotHash(second))
    expect(snapshotHash(first)).not.toBe(snapshotHash({ ...first, source: { ...first.source, auth_user_id: '43' } }))
  })
  it('does not call native transport without the current personal request', async () => {
    await expect(relayManagedBomSnapshot({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
      .resolves.toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' })
    expect(mocks.context).not.toHaveBeenCalled()
  })
  it('keeps a positively classified unbound source on its existing route', async () => {
    mocks.classify.mockResolvedValue({ kind: 'unbound' })
    await expect(read()).resolves.toEqual({ kind: 'legacy' })
    expect(mocks.context).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
})


describe('live advisory on the authenticated read envelope', () => {
  it('carries optional metadata outside the unchanged canonical snapshot', async () => {
    const raw = payload()
    const advisory = { provider: 'yuantus-plm', advisory: true, schema_version: 'v1', features: {} }
    mocks.context.mockResolvedValue({ ...raw, integration_capabilities: advisory })
    const result = await managedRequestContext.run({ userId: 'meta-person-900', sessionId: 'session', conflict: false },
      () => relayManagedBomSnapshot({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
    expect(result).toEqual({ kind: 'ok', entitled: true, snapshot: raw, advisoryCapabilities: advisory })
    if (result.kind !== 'ok') throw Error('authenticated read missing')
    expect(result.snapshot).not.toHaveProperty('integration_capabilities')
    expect(result.snapshot.context).toEqual(raw.context)
    await expect(read()).resolves.toEqual({ kind: 'ok', entitled: true, context: raw.context })
  })

  it.each(['native_subject', 'native_tenant_id', 'native_org_id', 'installation_issuer'])(
    'refuses changed session %s before any native transport', async field => {
      const current = (await mocks.query()).rows[0]
      mocks.query.mockResolvedValue({ rows: [{ ...current, [field]: 'foreign' }] })
      await expect(read()).resolves.toMatchObject({ kind: 'refusal', status: 403 })
      expect(mocks.status).not.toHaveBeenCalled()
      expect(mocks.context).not.toHaveBeenCalled()
    })

  it.each(['tenant_id', 'org_id', 'issuer', 'client_id', 'delegation_id'])(
    'refuses mismatched native status %s before reading a projection', async field => {
      const current = await mocks.status()
      mocks.status.mockClear()
      mocks.status.mockResolvedValue({ ...current, [field]: 'foreign' })
      await expect(read()).resolves.toMatchObject({ kind: 'refusal', status: 403, code: 'PLM_MANAGED_NATIVE_STATUS_REFUSED' })
      expect(mocks.context).not.toHaveBeenCalled()
    })

  it('does not return advisory data from a projection with foreign native authority', async () => {
    const raw = payload()
    raw.source.tenant_id = 'foreign'
    mocks.context.mockResolvedValue({ ...raw, integration_capabilities: { features: { secret: {} } } })
    const result = await managedRequestContext.run({ userId: 'meta-person-900', sessionId: 'session', conflict: false },
      () => relayManagedBomSnapshot({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
    expect(result).toMatchObject({ kind: 'refusal', status: 403 })
    expect(result).not.toHaveProperty('advisoryCapabilities')
  })
})
