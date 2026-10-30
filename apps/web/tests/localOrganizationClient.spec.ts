import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localOrganizationClient as client, LocalOrganizationError, localOrganizationMessage } from '../src/services/localOrganizationClient'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), admin: true, session: 'session-a' }))
vi.mock('../src/utils/api', () => ({ apiFetch: (...args: unknown[]) => mocks.fetch(...args) }))
vi.mock('../src/composables/useAuth', () => ({ useAuth: () => ({ hasAdminAccess: () => mocks.admin }) }))
vi.mock('../src/composables/authPrincipal', () => ({ readAuthSessionSignature: () => mocks.session }))
const integrationId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const departmentId = '33333333-3333-4333-8333-333333333333'
const membershipId = accountId + ':' + departmentId
const query = { integrationId, page: 2, pageSize: 25, q: ' search ' }
const department = { id: departmentId, name: '研发', parentDepartmentId: null, parentMissing: false, orderIndex: 0, isActive: true }
const member = { id: accountId, name: '成员', title: null, isActive: true,
  localUser: { id: 'user', name: null, username: 'employee' }, isEligible: true,
  memberships: [{ id: membershipId, departmentId, departmentName: '研发', departmentActive: true, isPrimary: false, isManager: false }] }
const envelope = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) })
const page = (items: unknown[], extra = {}) => ({ integrationId, page: 2, pageSize: 25, total: 30, items, ...extra })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => { mocks.fetch.mockReset(); mocks.admin = true; mocks.session = 'session-a' })

describe('local organization client contract', () => {
  it('reads minimal jsonOk workspace, candidates and expected-anchor pagination', async () => {
    const workspace = { integration: { id: integrationId, name: '组织', isActive: true }, departments: [department] }
    mocks.fetch.mockResolvedValueOnce(envelope(workspace))
    expect(await client.workspace()).toEqual(workspace)
    mocks.fetch.mockResolvedValueOnce(envelope(page([member])))
    expect(await client.members(query)).toEqual(page([member]))
    expect(mocks.fetch.mock.calls[1]).toEqual([
      '/api/admin/directory/local/members?integrationId=' + integrationId + '&page=2&pageSize=25&q=search',
      { method: 'GET', suppressUnauthorizedRedirect: true },
    ])
    const candidates = [{ id: 'u', name: null, username: 'employee' }]
    mocks.fetch.mockResolvedValueOnce(envelope(page(candidates)))
    expect((await client.candidates(query)).items).toEqual(candidates)
    expect(mocks.fetch.mock.calls[2][0]).toContain('/member-candidates?integrationId=')
    mocks.fetch.mockResolvedValueOnce(envelope(page([], { total: 7 })))
    expect((await client.members(query)).total).toBe(7)
  })
  it.each([
    { integration: null, departments: [department] },
    { integration: { id: integrationId, name: '组织', isActive: 'true' }, departments: [] },
    { integration: null, departments: [], config: { secret: 'hidden' } },
    { integration: null },
  ])('rejects malformed or expanded workspace data', async data => {
    mocks.fetch.mockResolvedValue(envelope(data))
    await expect(client.workspace()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each([
    { integrationId: accountId }, { page: 1 }, { pageSize: 100 }, { total: -1 },
    { items: [{ ...member, memberships: [{ ...member.memberships[0], id: 'wrong' }] }] },
    { items: [{ ...member, isEligible: 'true' }] }, { items: [{ ...member, config: {} }] },
  ])('rejects mismatched page context and invalid member shapes', async extra => {
    mocks.fetch.mockResolvedValue(envelope(page([member], extra)))
    await expect(client.members(query)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each([{ page: 0 }, { pageSize: 101 }, { integrationId: '' }, { q: 'x'.repeat(201) }])('rejects invalid queries before HTTP', async extra => {
    await expect(client.members({ ...query, ...extra })).rejects.toMatchObject({ status: 400 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('validates the exact approved projection body and nested result', async () => {
    mocks.fetch.mockResolvedValue(envelope({ projection: { accountId, created: false } }))
    expect(await client.project(integrationId, 'user')).toEqual({ accountId, created: false })
    expect(mocks.fetch).toHaveBeenCalledWith('/api/admin/directory/local/member-projections', {
      method: 'POST', suppressUnauthorizedRedirect: true, body: JSON.stringify({ integrationId, localUserId: 'user' }),
    })
    mocks.fetch.mockResolvedValue(envelope({ accountId, created: true }))
    await expect(client.project(integrationId, 'user')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    mocks.fetch.mockResolvedValue(envelope({ projection: { accountId, created: 'false' } }))
    await expect(client.project(integrationId, 'user')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('issues real CRUD verbs and exact finite bodies', async () => {
    const input = { name: '新部门', parentDepartmentId: departmentId, orderIndex: 4 }
    mocks.fetch.mockResolvedValue(envelope({ department: {}, account: {}, membership: {} }))
    await client.createDepartment(input)
    await client.updateDepartment(departmentId, { ...input, parentDepartmentId: null, orderIndex: -2 })
    await client.archiveDepartment(departmentId)
    await client.updateMember(accountId, { name: '新姓名' })
    await client.archiveMember(accountId)
    await client.addMembership(accountId, departmentId)
    await client.primary(membershipId)
    await client.manager(membershipId, false)
    expect(mocks.fetch.mock.calls.map(([url, init]) => [url.replace('/api/admin/directory/local', ''), init.method, JSON.parse(init.body)])).toEqual([
      ['/departments', 'POST', input],
      ['/departments/' + departmentId, 'PATCH', { ...input, parentDepartmentId: null, orderIndex: -2 }],
      ['/departments/' + departmentId + '/archive', 'POST', {}],
      ['/accounts/' + accountId, 'PATCH', { name: '新姓名' }],
      ['/accounts/' + accountId + '/archive', 'POST', {}],
      ['/memberships', 'POST', { accountId, departmentId }],
      ['/memberships/' + encodeURIComponent(membershipId), 'PATCH', { isPrimary: true }],
      ['/memberships/' + encodeURIComponent(membershipId), 'PATCH', { isManager: false }],
    ])
  })
  it.each(['旧目录职务', null])('keeps name saves title-free even with a stale caller title=%s', async title => {
    mocks.fetch.mockResolvedValue(envelope({ account: {} }))
    const staleInput = { name: '  新姓名  ', title }
    await client.updateMember(accountId, staleInput)
    expect(mocks.fetch.mock.calls).toEqual([['/api/admin/directory/local/accounts/' + accountId, {
      method: 'PATCH', suppressUnauthorizedRedirect: true, body: JSON.stringify({ name: '新姓名' }),
    }]])
  })
  it('validates selected head context without converting unknown into false', async () => {
    const membership = { id: membershipId, accountId, departmentId, isDepartmentHead: false, readOnly: true }
    mocks.fetch.mockResolvedValueOnce(envelope({ membership }))
    expect(await client.head(membershipId)).toEqual(membership)
    mocks.fetch.mockResolvedValueOnce(envelope({ membership: { ...membership, isDepartmentHead: undefined } }))
    await expect(client.head(membershipId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    mocks.fetch.mockResolvedValueOnce(envelope({ membership: { ...membership, accountId: departmentId } }))
    await expect(client.head(membershipId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    mocks.fetch.mockResolvedValueOnce(envelope({ membership: { id: membershipId, accountId, departmentId, isDepartmentHead: true } }))
    await client.setHead(membershipId, true)
    expect(mocks.fetch.mock.calls[3]).toEqual(['/api/admin/directory/local/memberships/' + encodeURIComponent(membershipId) + '/department-head', {
      method: 'PATCH', suppressUnauthorizedRedirect: true, body: JSON.stringify({ isDepartmentHead: true }),
    }])
  })
  it.each([400, 403, 409])('returns fixed errors for status %s and never replays', async status => {
    mocks.fetch.mockResolvedValue({ ok: false, status, json: async () => ({ ok: false, error: { code: status === 409 ? 'DIRECTORY_LOCAL_CONFLICT' : 'SECRET_VALUE', message: 'private-server-detail' } }) })
    const error = await client.workspace().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LocalOrganizationError)
    expect(error).toMatchObject({ status })
    expect(localOrganizationMessage(error)).not.toContain('private-server-detail')
    expect((error as Error).message).not.toContain('SECRET_VALUE')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses non-admin before HTTP and 403 before a delayed error body', async () => {
    mocks.admin = false
    await expect(client.workspace()).rejects.toMatchObject({ status: 403 })
    expect(mocks.fetch).not.toHaveBeenCalled()
    mocks.admin = true
    const json = vi.fn(() => new Promise(() => {}))
    mocks.fetch.mockResolvedValue({ status: 403, ok: false, json })
    await expect(client.workspace()).rejects.toMatchObject({ status: 403 })
    expect(json).not.toHaveBeenCalled()
  })
  it('rejects late headers, JSON and exceptions after session switches', async () => {
    const headers = deferred<ReturnType<typeof envelope>>()
    mocks.fetch.mockReturnValueOnce(headers.promise)
    const first = expect(client.workspace()).rejects.toMatchObject({ code: 'LOCAL_ORG_CONTEXT_CHANGED' })
    mocks.session = 'session-b'; headers.resolve(envelope({ integration: null, departments: [] }))
    await first
    const json = deferred<unknown>()
    mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => json.promise })
    const second = expect(client.workspace()).rejects.toMatchObject({ code: 'LOCAL_ORG_CONTEXT_CHANGED' })
    await Promise.resolve()
    mocks.session = 'session-c'; json.resolve({ ok: true, data: { integration: null, departments: [] } })
    await second
    const rejected = deferred<ReturnType<typeof envelope>>()
    mocks.fetch.mockReturnValueOnce(rejected.promise)
    const third = expect(client.workspace()).rejects.toMatchObject({ code: 'LOCAL_ORG_CONTEXT_CHANGED' })
    mocks.session = 'session-d'; rejected.reject(new Error('private-exception'))
    await third
  })
  it('does not replay a failed write or reflect raw exceptions', async () => {
    mocks.fetch.mockRejectedValue(new TypeError('private-url'))
    const error = await client.archiveMember(accountId).catch((e: unknown) => e)
    expect(error).toMatchObject({ status: 0, code: 'REQUEST_FAILED' })
    expect((error as Error).message).not.toContain('private-url')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])('accepts strict projection created=%s results', async created => {
    mocks.fetch.mockResolvedValue(envelope({ projection: { accountId, created } }))
    expect(await client.project(integrationId, 'user')).toEqual({ accountId, created })
  })
  it.each([400, 403, 409])('keeps projection refusal %s fixed, without fallback account creation or retries', async status => {
    mocks.fetch.mockResolvedValue({ ok: false, status, json: async () => ({ ok: false, error: {
      code: status === 409 ? 'DIRECTORY_LOCAL_ORG_MEMBERSHIP_HISTORY' : 'DIRECTORY_LOCAL_INVALID_INPUT',
      message: 'private-projection-detail',
    } }) })
    const error = await client.project(integrationId, 'user').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ status })
    expect(localOrganizationMessage(error)).not.toContain('private-projection-detail')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/admin/directory/local/member-projections')
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ integrationId, localUserId: 'user' })
  })
  it.each(['', ' '.repeat(3), 'u'.repeat(201)])('rejects invalid projection user input before HTTP', async localUserId => {
    await expect(client.project(integrationId, localUserId)).rejects.toMatchObject({ status: 400 })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { id: 'u', name: null, username: 'employee', config: {} },
    { id: 'u', name: 1, username: 'employee' },
    { id: '', name: '名字', username: null },
  ])('rejects expanded or malformed candidate DTOs', async item => {
    mocks.fetch.mockResolvedValue(envelope(page([item])))
    await expect(client.candidates(query)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
