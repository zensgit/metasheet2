import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nativePrepareSnapshotShare, nativeExportSnapshotShare, nativeCancelSnapshotShare, setManagedNativeFetchForTests } from '../../src/services/plm-managed-native-http'
import type { ManagedClientRegistration } from '../../src/services/plm-managed-companion'
import type { SnapshotShareTarget } from '../../src/services/plm-managed-snapshot-share-wire'

const registration: ManagedClientRegistration = { issuer: 'https://meta.example/installation', clientId: 'meta', clientSecret: 'synthetic-client-secret',
  callback: 'https://meta.example/callback', origin: 'https://meta.example', nativeTenantId: 'native-tenant', nativeOrgId: 'native-org', nativeBaseUrl: 'https://native.example' }
const target: SnapshotShareTarget = { tenant_id: 'meta-tenant', org_id: 'meta-org', user_id: 'meta-person', base_id: 'base', sheet_id: 'sheet',
  source_id: 'source', binding_id: 'binding', binding_generation: 2, session_id: 'session', audience: 'Design team' }
const operationId = '11111111-1111-4111-8111-111111111111'
const intentId = '22222222-2222-4222-8222-222222222222'
const input = { operationId, nativeUserId: 42, rootPartId: 'P', target, state: 'state', codeChallenge: 'a'.repeat(43) }

describe('separate-purpose native snapshot transport', () => {
  const mock = vi.fn<typeof fetch>()
  beforeEach(() => {
    process.env.PLM_MANAGED_COMPANION_TEST_HOOKS = 'true'
    mock.mockReset()
    setManagedNativeFetchForTests(mock)
  })
  afterEach(() => { setManagedNativeFetchForTests(null); delete process.env.PLM_MANAGED_COMPANION_TEST_HOOKS })
  it('uses the confidential client and independent target, never read/approval credentials', async () => {
    mock.mockResolvedValue(new Response(JSON.stringify({ intent_id: intentId, operation_id: operationId,
      policy: 'authorized_snapshot_target_acl.v1', confirmation_path: '/bom-snapshot-share?intent=' + intentId })))
    await expect(nativePrepareSnapshotShare(registration, input)).resolves.toMatchObject({ intentId,
      navigationUrl: 'https://native.example/bom-snapshot-share?intent=' + intentId })
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, options] = mock.mock.calls[0]
    expect(url).toBe('https://native.example/api/v1/auth/bom-snapshot-share/prepare')
    const sent = JSON.parse(String(options?.body))
    expect(sent.native_user_id).toBe(42)
    expect(sent.target.user_id).toBe('meta-person')
    expect(sent.target.tenant_id).toBe('meta-tenant')
    expect(options?.headers).toEqual({ 'content-type': 'application/json', 'x-tenant-id': 'native-tenant', 'x-org-id': 'native-org' })
    expect(sent.credential).toBeUndefined()
    expect(sent.grant_id).toBeUndefined()
    expect(options?.redirect).toBe('error')
  })
  it.each(['meta-person', '42', 0, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid native identity %s before transport', async value => {
    await expect(nativePrepareSnapshotShare(registration, { ...input, nativeUserId: value as number })).rejects.toMatchObject({ status: 403 })
    expect(mock).not.toHaveBeenCalled()
  })
  it.each(['yur_fake', 'yua_fake', 'yuw_fake', 'normal-jwt'])('refuses borrowed credential %s before export', async code => {
    await expect(nativeExportSnapshotShare(registration, { code, codeVerifier: 'a'.repeat(43) }, {
      intentId, operationId, target, source: { tenant_id: 'native-tenant', org_id: 'native-org', auth_user_id: '42', part_id: 'P' },
    })).rejects.toMatchObject({ status: 403, code: 'PLM_SNAPSHOT_SHARE_PURPOSE_REFUSED' })
    expect(mock).not.toHaveBeenCalled()
  })
  it('refuses a native response navigation outside its exact consent path', async () => {
    mock.mockResolvedValue(new Response(JSON.stringify({ intent_id: intentId, operation_id: operationId,
      policy: 'authorized_snapshot_target_acl.v1', confirmation_path: 'https://other.example/' })))
    await expect(nativePrepareSnapshotShare(registration, input)).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_PREPARE_REFUSED' })
  })
  it('cancels the exact operation without native cookies, personal grants or issuance flags', async () => {
    mock.mockResolvedValue(new Response(JSON.stringify({ revoked: true })))
    await expect(nativeCancelSnapshotShare(registration, { intentId, operationId })).resolves.toBeUndefined()
    const [url, options] = mock.mock.calls[0]
    expect(url).toBe('https://native.example/api/v1/auth/bom-snapshot-share/cancel')
    expect(JSON.parse(String(options?.body))).toEqual({ client_id: registration.clientId, client_secret: registration.clientSecret,
      callback: registration.callback, intent_id: intentId, operation_id: operationId })
    expect(options?.headers).toEqual({ 'content-type': 'application/json', 'x-tenant-id': 'native-tenant', 'x-org-id': 'native-org' })
    expect(options?.redirect).toBe('error')
  })
  it.each([false, 'true', null])('does not acknowledge an unconfirmed cancellation %s', async revoked => {
    mock.mockResolvedValue(new Response(JSON.stringify({ revoked })))
    await expect(nativeCancelSnapshotShare(registration, { intentId, operationId })).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_CANCEL_REFUSED' })
  })
  it('does not acknowledge a refused native cancellation', async () => {
    mock.mockResolvedValue(new Response(JSON.stringify({ detail: 'Permission denied' }), { status: 403 }))
    await expect(nativeCancelSnapshotShare(registration, { intentId, operationId })).rejects.toMatchObject({ code: 'PLM_SNAPSHOT_SHARE_CANCEL_REFUSED' })
  })
})
