import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn(), classify: vi.fn(), context: vi.fn(), status: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: {} }))
vi.mock('../../src/services/plm-managed-native-http', () => ({
  nativeExchange: vi.fn(), nativeRevoke: vi.fn(), nativeStatus: mocks.status, nativeManagedContext: mocks.context,
}))
vi.mock('../../src/services/plm-managed-companion', async (original) => ({
  ...await original<typeof import('../../src/services/plm-managed-companion')>(),
  classifyManagedSource: mocks.classify,
  isPlmManagedCompanionEnabled: () => true,
  bindingFingerprintMatches: () => true,
  registrationFor: () => ({ clientId: 'client' }),
  openCredential: () => 'synthetic-personal-read',
}))
import { relayManagedBomContext, relayManagedBomSnapshot } from '../../src/services/plm-managed-companion-flow'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { parseManagedSnapshot, parseShareSnapshot, snapshotHash } from '../../src/multitable/plm-bom-review-wire'
import { MANAGED_COMPANION_SCOPE } from '../../src/services/plm-managed-companion'
import { shareSnapshot } from '../plm-bom-review/fixture'

const authority = { part_id: 'P', tenant_id: 'native-tenant', org_id: 'native-org', auth_user_id: '42' }
function payload() {
  return { ...shareSnapshot(), projection_contract: 'bom_review_managed.v1', source: { ...authority } }
}
function read() {
  return managedRequestContext.run({ userId: 'meta-person-900', sessionId: 'session', conflict: false },
    () => relayManagedBomContext({ userId: 'meta-person-900', dataSourceId: 'source', partId: 'P' }))
}
beforeEach(() => {
  mocks.classify.mockResolvedValue({ kind: 'managed', row: {
    meta_user_id: 'meta-person-900', frozen_root_part_id: 'P', client_origin: 'https://meta.invalid', generation: 3,
  } })
  mocks.query.mockResolvedValue({ rows: [{
    root_part_id: 'P', client_origin: 'https://meta.invalid', native_subject: '42',
    native_tenant_id: 'native-tenant', native_org_id: 'native-org', client_id: 'client',
    installation_issuer: 'fixture', delegation_id: 'delegation', credential_ciphertext: 'opaque',
  }] })
  mocks.status.mockResolvedValue({ root_part_id: 'P', client_origin: 'https://meta.invalid', subject: '42', scope: MANAGED_COMPANION_SCOPE })
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
