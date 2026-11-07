import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Non-default pull settings reach every provider call: the configured base url on each of the
 * fifteen forwarding sites (department pull, member pull, diagnostic sample, connection test),
 * the configured root department id, and the page size of each member read.
 *
 * Harness rules: closed provider-client factory, no database, identifiers carry the `a0g-` prefix.
 */
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/integrations/dingtalk/client', () => ({ ...clientMocks }))

import {
  fetchAllDepartments,
  fetchAllUsers,
  sampleRootDepartmentDiagnostics,
  testDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { createDirectorySyncApiCallCounters } from '../../src/directory/directory-sync-api-telemetry'

const BASE_URL = 'https://a0g.example.test'
const ROOT = 'a0g-root'
const MEMBER = 'a0g-ku1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = {
  appKey: 'a0g-appkey-k',
  appSecret: 'a0g-secret',
  rootDepartmentId: ROOT,
  pageSize: 7,
  baseUrl: BASE_URL,
}

function arm(): void {
  for (const fn of Object.values(clientMocks)) fn.mockReset()
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  clientMocks.listDingTalkDepartments.mockResolvedValue([])
  clientMocks.listDingTalkDepartmentUsers.mockResolvedValue({
    users: [{ userId: MEMBER, name: MEMBER, departmentIds: [ROOT], source: {} }],
    hasMore: false,
    nextCursor: null,
  })
  clientMocks.getDingTalkUserDetail.mockResolvedValue({ userId: MEMBER, name: MEMBER, departmentIds: [ROOT], source: {} })
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
}

function clear(): void {
  for (const fn of Object.values(clientMocks)) fn.mockClear()
}

/** The options object of a provider call: the token call takes it first, every other call last. */
function optionsOf(call: unknown[]): { baseUrl?: string; containAccessLimit?: boolean } {
  const options = typeof call[0] === 'object' && call[0] !== null ? call[0] : call[call.length - 1]
  return options as { baseUrl?: string; containAccessLimit?: boolean }
}

function allCalls() {
  return Object.values(clientMocks).flatMap((fn) => fn.mock.calls as unknown[][])
}

describe('non-default pull settings reach every provider call', () => {
  beforeEach(() => {
    arm()
  })

  it('the department pull forwards the base url and uses the configured root', async () => {
    clear()
    await fetchAllDepartments(config, 'a0g-int-k', createDirectorySyncApiCallCounters())

    expect(clientMocks.fetchDingTalkAppAccessToken).toHaveBeenCalledTimes(1)
    expect(optionsOf(clientMocks.fetchDingTalkAppAccessToken.mock.calls[0]).baseUrl).toBe(BASE_URL)
    expect(clientMocks.listDingTalkDepartments.mock.calls).toEqual([['token', ROOT, { baseUrl: BASE_URL }]])
    // the root department is enriched through the detail call
    expect(clientMocks.getDingTalkDepartmentDetail.mock.calls).toEqual([['token', ROOT, { baseUrl: BASE_URL }]])
  })

  it('the member pull forwards the base url, the root id and the page size', async () => {
    const departments = await fetchAllDepartments(config, 'a0g-int-k')
    clear()
    await fetchAllUsers(config, departments, createDirectorySyncApiCallCounters())

    expect(optionsOf(clientMocks.fetchDingTalkAppAccessToken.mock.calls[0]).baseUrl).toBe(BASE_URL)
    expect(clientMocks.listDingTalkDepartmentUsers.mock.calls).toEqual([['token', ROOT, 0, 7, { baseUrl: BASE_URL }]])
    expect(clientMocks.getDingTalkUserDetail.mock.calls).toEqual([['token', MEMBER, { baseUrl: BASE_URL }]])
  })

  it('the diagnostic sample forwards the base url, the root id and the page size', async () => {
    clear()
    await sampleRootDepartmentDiagnostics(config)

    expect(optionsOf(clientMocks.fetchDingTalkAppAccessToken.mock.calls[0]).baseUrl).toBe(BASE_URL)
    expect(clientMocks.listDingTalkDepartments.mock.calls).toEqual([['token', ROOT, { baseUrl: BASE_URL }]])
    expect(clientMocks.listDingTalkDepartmentUsers.mock.calls).toEqual([
      ['token', ROOT, 0, 7, { baseUrl: BASE_URL }],
      ['token', ROOT, 0, 7, { baseUrl: BASE_URL, containAccessLimit: true }],
    ])
  })

  it('the connection test forwards the base url, the root id and the page sizes', async () => {
    clear()
    await testDirectoryIntegration({
      name: 'a0g-int-k',
      corpId: 'a0g-corp-k',
      appKey: 'a0g-appkey-k',
      appSecret: 'a0g-secret',
      rootDepartmentId: ROOT,
      pageSize: 7,
      baseUrl: BASE_URL,
    })

    expect(optionsOf(clientMocks.fetchDingTalkAppAccessToken.mock.calls[0]).baseUrl).toBe(BASE_URL)
    expect(clientMocks.listDingTalkDepartments.mock.calls).toEqual([['token', ROOT, { baseUrl: BASE_URL }]])
    // first-department sample (at most 5), then the root reads (configured size), the second with access-limited members
    expect(clientMocks.listDingTalkDepartmentUsers.mock.calls).toEqual([
      ['token', ROOT, 0, 5, { baseUrl: BASE_URL }],
      ['token', ROOT, 0, 7, { baseUrl: BASE_URL }],
      ['token', ROOT, 0, 7, { baseUrl: BASE_URL, containAccessLimit: true }],
    ])
  })

  it('every provider call of the four entry points carries the base url', async () => {
    clear()
    const departments = await fetchAllDepartments(config, 'a0g-int-k')
    await fetchAllUsers(config, departments)
    await sampleRootDepartmentDiagnostics(config)
    await testDirectoryIntegration({
      name: 'a0g-int-k',
      corpId: 'a0g-corp-k',
      appKey: 'a0g-appkey-k',
      appSecret: 'a0g-secret',
      rootDepartmentId: ROOT,
      pageSize: 7,
      baseUrl: BASE_URL,
    })

    const calls = allCalls()
    // 3 department pull + 3 member pull + 4 sample + 5 connection test
    expect(calls).toHaveLength(15)
    for (const call of calls) expect(optionsOf(call).baseUrl).toBe(BASE_URL)
  })
})
