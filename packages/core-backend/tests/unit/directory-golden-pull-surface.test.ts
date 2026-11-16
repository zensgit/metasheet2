import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The synthetic tenant drives the real department and member pulls (no database): the provider
 * client call sequence and the pulled maps equal the committed goldens' `calls`.
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
import { DirectoryUserPaginationError } from '../../src/directory/directory-user-pagination'
import { armGoldenClient, serializeCalls } from '../fixtures/directory/dingtalk-golden-tenant'

const sources = () => Object.entries(clientMocks).map(([name, fn]) => ({ name, fn }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config: any = { appKey: 'a0g-appkey-a', appSecret: 'a0g-secret', rootDepartmentId: '1', pageSize: 50, baseUrl: undefined }
const goldenFile = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, '../fixtures/directory/golden', `${name}.json`), 'utf8'))

describe('synthetic tenant pull surface', () => {
  it('a manual pull issues the golden call sequence and counts every call', async () => {
    armGoldenClient(clientMocks, 'a')
    const counters = createDirectorySyncApiCallCounters()
    const departments = await fetchAllDepartments(config, 'a0g-int-a', counters)
    const users = await fetchAllUsers(config, departments, counters)
    await sampleRootDepartmentDiagnostics(config)

    expect(serializeCalls(sources())).toEqual(goldenFile('manual-apply').calls)
    expect(counters).toEqual({ departmentListCalls: 5, departmentDetailCalls: 5, userListPageCalls: 6, userDetailCalls: 12 })
    expect(Array.from(departments.keys())).toEqual(['1', 'dA', 'dB', 'dC', 'dA1'])
    expect(Array.from(users.keys())).toEqual([
      'a0g-u1', 'a0g-u2', 'a0g-u3', 'a0g-u4', 'a0g-u6', 'a0g-u8',
      'a0g-u5', 'a0g-u7', 'a0g-u10', 'a0g-u11', 'a0g-u12', 'a0g-u9',
    ])
    expect(users.get('a0g-u1')?.departmentIds).toEqual(['dA', 'dA1'])
    expect(departments.get('dB')?.managerUserIds).toEqual(['a0g-u10'])
    expect(departments.get('dA1')?.managerUserIds).toBeUndefined()
  })

  it('a pull without counters issues the same sequence as the golden preview', async () => {
    armGoldenClient(clientMocks, 'c')
    const departments = await fetchAllDepartments(config, 'a0g-int-c')
    await fetchAllUsers(config, departments)
    expect(serializeCalls(sources())).toEqual(goldenFile('preview').calls)
  })

  it('the connection test issues the golden calls and returns the golden values', async () => {
    armGoldenClient(clientMocks, 'd')
    const result = await testDirectoryIntegration({
      name: 'a0g-int-d', corpId: 'a0g-corp-d', appKey: 'a0g-appkey-d', appSecret: 'a0g-secret',
    })
    expect(serializeCalls(sources())).toEqual(goldenFile('connection-test').calls)
    expect(JSON.parse(JSON.stringify(result))).toEqual(goldenFile('connection-test').result)
    expect(Object.keys(result)).toEqual([
      'corpId', 'rootDepartmentId', 'appKey', 'departmentSampleCount', 'sampledDepartments',
      'userSampleCount', 'sampledUsers', 'diagnostics', 'summary', 'warnings',
    ])
  })

  it('a repeated member cursor stops the pull at the golden call', async () => {
    armGoldenClient(clientMocks, 'e', 'cursor')
    const departments = await fetchAllDepartments(config, 'a0g-int-e')
    await expect(fetchAllUsers(config, departments)).rejects.toBeInstanceOf(DirectoryUserPaginationError)
    expect(serializeCalls(sources())).toEqual(goldenFile('failure-pagination').calls)
  })

  it('an incomplete department response stops the pull at the golden call', async () => {
    armGoldenClient(clientMocks, 'f', 'shape')
    await expect(fetchAllDepartments(config, 'a0g-int-f')).rejects.toThrow()
    expect(serializeCalls(sources())).toEqual(goldenFile('failure-incomplete-response').calls)
  })
})
