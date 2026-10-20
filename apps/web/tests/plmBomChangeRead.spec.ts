import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindChangeRead, changeReadManagement, changeReadState, changeReadTargets, startChangeRead, unbindChangeRead } from '../src/services/plm/plmBomChangeRead'
const source = { dataSourceId: 'source', partId: 'P' }
const target = { id: '11111111-1111-4111-8111-111111111111', name: '协作表', version: 1, baseId: 'base', sheetId: 'sheet' }
const secret = 'yue_' + 'a'.repeat(32) + '_' + 'b'.repeat(43)
const bound = { bound: true, purpose: 'bom_change_read', grantId: 'a'.repeat(32), expiresAt: '2026-12-01T00:00:00Z', status: 'stopped', revision: '22222222-2222-4222-8222-222222222222' }
const scope = { connection_id: 'native', root_part_id: 'P', review_binding_id: target.id, review_binding_version: 1,
  target: { tenant_id: 'meta-tenant', org_id: 'meta-org', user_id: 'person', base_id: 'base', sheet_id: 'sheet', source_id: 'source', binding_id: 'link', binding_generation: 1, session_id: 'session', audience: '目标空间成员，包括后续授权成员' } }
const url = (value: unknown = scope) => 'https://native.example/personal-approval-grants#bom-change-read?request=' + encodeURIComponent(JSON.stringify(value))
const fetchMock = vi.fn()
function reply(data: unknown) { fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data }) }) }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, run: () => unknown) => run() } }) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })
it('discovers actual target metadata with cookies and no authority bearer', async () => {
  reply({ items: [target] }); expect(await changeReadTargets(source)).toEqual([target])
  const [path, init] = fetchMock.mock.calls[0]
  expect(path.pathname).toBe('/api/plm-bom-reviews/managed-change-read/targets'); expect(init.credentials).toBe('include'); expect(init.cache).toBe('no-store'); expect(init.referrerPolicy).toBe('no-referrer'); expect(init.headers).toEqual({})
})
it('accepts only the frozen independent Native consent target and version', async () => {
  reply({ url: url(), expectedVersion: 1 }); expect(await changeReadManagement(source, target)).toBe(url())
})
it.each([
  { ...scope, root_part_id: 'foreign' }, { ...scope, review_binding_id: '33333333-3333-4333-8333-333333333333' },
  { ...scope, review_binding_version: 2 }, { ...scope, grant: secret },
  { ...scope, target: { ...scope.target, sheet_id: 'foreign' } },
  { ...scope, target: { ...scope.target, source_id: 'foreign' } },
])('refuses a substituted or credential-bearing consent fragment %#', async value => {
  reply({ url: url(value), expectedVersion: 1 }); await expect(changeReadManagement(source, target)).rejects.toThrow()
})
it.each(['https://native.example/personal-approval-grants#bom-write', url() + '&request=%7B%7D', url().replace('/personal-approval-grants#', '/personal-approval-grants?callback=foreign#')])('refuses another purpose or ambiguous navigation %s', async value => {
  reply({ url: value, expectedVersion: 1 }); await expect(changeReadManagement(source, target)).rejects.toThrow()
})
it('binds only yue, uses the frozen review version, and never stores the secret', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem')
  reply(bound); expect(await bindChangeRead(target, secret)).toMatchObject({ bound: true, purpose: 'bom_change_read' })
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', 'x-plm-change-read': 'bind' }, body: JSON.stringify({ grant: secret, expectedVersion: 1 }) })
  expect(store.mock.calls.some(call => String(call[1]).includes(secret))).toBe(false)
  fetchMock.mockClear()
  for (const prefix of ['yua', 'yuw', 'yur']) await expect(bindChangeRead(target, secret.replace('yue_', prefix + '_'))).rejects.toThrow()
  expect(fetchMock).not.toHaveBeenCalled()
})
it('refuses shared stored login credentials before a request', async () => {
  localStorage.setItem('auth_token', 'shared-token'); await expect(changeReadState(target.id)).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled()
})
it('requires browser identity coordination rather than falling back', async () => {
  vi.stubGlobal('navigator', {}); await expect(changeReadTargets(source)).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled()
})
it('starts only explicitly with the start action and current version', async () => {
  reply({ status: 'active', generation: '22222222-2222-4222-8222-222222222222', cursor: 5, bindingVersion: 1 })
  await startChangeRead(target); expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'x-plm-change-read': 'start' }, body: JSON.stringify({ expectedVersion: 1 }) })
  reply({ pending: 1, rejected: 0 }); expect(await unbindChangeRead(target.id)).toEqual({ pending: 1, rejected: 0 }); expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE', headers: { 'x-plm-change-read': 'unbind' } })
})
it('does not retry a bind with unknown outcome or expose provider response bodies', async () => {
  fetchMock.mockRejectedValueOnce(new Error('lost response')); await expect(bindChangeRead(target, secret)).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(1)
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ token: secret }) }); await expect(changeReadState(target.id)).rejects.toThrow('操作未完成')
})
it.each([{ ...bound, token: secret }, { ...bound, purpose: 'bom_write' }, { ...bound, grantId: secret }, { ...bound, pending: -1 }])('rejects secret or inconsistent metadata %#', async value => {
  reply(value); await expect(changeReadState(target.id)).rejects.toThrow()
})
it('preserves Native code point identifier limits for discovery', async () => {
  reply({ items: [] }); await changeReadTargets({ ...source, partId: '😀'.repeat(128) }); expect(fetchMock.mock.calls[0][0].searchParams.get('partId')).toBe('😀'.repeat(128))
  fetchMock.mockClear(); await expect(changeReadTargets({ ...source, partId: '😀'.repeat(129) })).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled()
})
