import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { clearManagedDescriptor, installManagedDescriptor } from '../src/composables/authPrincipal'
import { startSnapshotShare, completeSnapshotShare } from '../src/services/plm/plmSnapshotShare'

const input = { dataSourceId: 'source', partId: 'P', baseId: 'base', name: 'BOM' }
const operation = '11111111-1111-4111-8111-111111111111'
const native = 'https://native.example/bom-snapshot-share?intent=22222222-2222-4222-8222-222222222222'
const identity = { mode: 'managed-cookie', userId: 'meta-person', tenantId: 'meta-tenant', sessionId: 'session', revision: 1, expiresAt: new Date(Date.now() + 300_000).toISOString() }
const fetchMock = vi.fn(), assign = vi.fn()
const response = (value: unknown) => ({ ok: true, json: async () => value })
const current = () => response({ success: true, data: { managedSession: identity } })

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); clearManagedDescriptor()
  installManagedDescriptor(identity)
  fetchMock.mockReset(); assign.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('window', { location: { origin: 'http://localhost', pathname: '/plm/bom-review', search: '', assign } })
  vi.stubGlobal('crypto', { randomUUID: () => operation })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearManagedDescriptor() })

async function started() {
  fetchMock.mockResolvedValueOnce(response({ ok: true, navigationUrl: native }))
  await startSnapshotShare(input)
  fetchMock.mockClear()
}
describe('native snapshot consent client', () => {
  it('starts a separate consent using cookies and a frozen operation, without personal read/approval tokens', async () => {
    await started()
    expect(assign).toHaveBeenCalledWith(native)
    const saved = JSON.parse(sessionStorage.getItem('metasheet_plm_snapshot_share')!)
    expect(saved.operationId).toBe(operation)
    expect(saved.sessionId).toBe('session')
  })
  it('retries the exact operation after a lost response instead of minting another intent', async () => {
    fetchMock.mockRejectedValueOnce(new Error('lost response'))
    await expect(startSnapshotShare(input)).rejects.toThrow('lost response')
    fetchMock.mockResolvedValueOnce(response({ ok: true, navigationUrl: native }))
    await startSnapshotShare(input)
    const first = fetchMock.mock.calls[0][1], second = fetchMock.mock.calls[1][1]
    expect(first.body).toBe(second.body)
    expect(first.credentials).toBe('include')
    expect(first.headers.authorization).toBeUndefined()
    expect(first.headers['x-plm-snapshot-share']).toBe('start')
  })
  it('refuses target changes while an operation is pending', async () => {
    await started()
    await expect(startSnapshotShare({ ...input, baseId: 'different' })).rejects.toThrow('分享未完成')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('refuses another Meta identity rather than adopting the pending operation', async () => {
    await started()
    installManagedDescriptor({ ...identity, userId: 'other' })
    await expect(startSnapshotShare(input)).rejects.toThrow('分享未完成')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('refuses ordinary stored credentials without a network fallback', async () => {
    localStorage.setItem('auth_token', 'ordinary-token')
    await expect(startSnapshotShare(input)).rejects.toThrow('分享未完成')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('checks current cookie identity before sending the consent code', async () => {
    await started()
    fetchMock.mockResolvedValueOnce(response({ success: true, data: { managedSession: { ...identity, sessionId: 'other' } } }))
    await expect(completeSnapshotShare('?operationId=' + operation + '&code=yus_code&state=state')).rejects.toThrow('分享未完成')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('can recover an already published operation after reloading a scrubbed return URL', async () => {
    await started()
    clearManagedDescriptor()
    fetchMock.mockResolvedValueOnce(current()).mockResolvedValueOnce(response({ ok: true, data: { navigationPath: '/multitable/sheet/view' } }))
    await expect(completeSnapshotShare('')).resolves.toBe('/multitable/sheet/view')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ operationId: operation })
    expect(sessionStorage.getItem('metasheet_plm_snapshot_share')).toBeNull()
  })
  it.each(['?code=a&code=b&operationId=x&state=s', '?code=a&operationId=x&state=s&callback=https://other.example'])('rejects ambiguous return parameters %s', async value => {
    await expect(completeSnapshotShare(value)).rejects.toThrow('分享未完成')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('fails closed without browser identity coordination', async () => {
    vi.stubGlobal('navigator', {})
    await expect(startSnapshotShare(input)).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('does not post if the frozen operation cannot be persisted', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => { throw new Error('storage unavailable') } })
    await expect(startSnapshotShare(input)).rejects.toThrow('storage unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
