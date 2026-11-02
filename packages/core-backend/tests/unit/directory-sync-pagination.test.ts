import { beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => clientMocks)

import { fetchAllUsers } from '../../src/directory/directory-sync'
import { createDirectorySyncApiCallCounters } from '../../src/directory/directory-sync-api-telemetry'

const config = {
  appKey: 'synthetic-key',
  appSecret: 'synthetic-secret',
  rootDepartmentId: 'root',
  pageSize: 100,
} as Parameters<typeof fetchAllUsers>[0]

function departments(...ids: string[]) {
  return new Map(ids.map((id) => [id, { id, parentId: null, name: id, order: 0, source: {} }]))
}

function page(departmentId: string, ids: string[], nextCursor: number | null, hasMore = true) {
  return {
    users: ids.map((userId) => ({ userId, name: userId, departmentIds: [departmentId], source: {} })),
    nextCursor,
    hasMore,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('synthetic-token')
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => ({
    userId, name: userId, departmentIds: [], source: {},
  }))
  clientMocks.listDingTalkDepartmentUsers.mockRejectedValue(new Error('UNEXPECTED_PAGE_REQUEST'))
})

describe('directory user pagination completeness', () => {
  it('collects every valid page, keeps per-department cursors separate and deduplicates user details', async () => {
    clientMocks.listDingTalkDepartmentUsers
      .mockResolvedValueOnce(page('a', ['u1'], 200))
      .mockResolvedValueOnce(page('a', ['u2'], 100))
      .mockResolvedValueOnce(page('a', ['u3'], null, false))
      .mockResolvedValueOnce(page('b', ['u1'], 200))
      .mockResolvedValueOnce(page('b', ['u4'], null, false))
    const counters = createDirectorySyncApiCallCounters()

    const users = await fetchAllUsers(config, departments('a', 'b'), counters)

    expect([...users.keys()]).toEqual(['u1', 'u2', 'u3', 'u4'])
    expect(users.get('u1')?.departmentIds).toEqual(['a', 'b'])
    expect(clientMocks.listDingTalkDepartmentUsers.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['a', 0], ['a', 200], ['a', 100], ['b', 0], ['b', 200],
    ])
    expect(clientMocks.getDingTalkUserDetail).toHaveBeenCalledTimes(4)
    expect(counters.userListPageCalls).toBe(5)
    expect(counters.userDetailCalls).toBe(4)
  })

  it.each([
    { label: 'missing', cursor: null },
    { label: 'undefined', cursor: undefined },
    { label: 'negative', cursor: -1 },
    { label: 'fractional', cursor: 0.5 },
    { label: 'unsafe integer', cursor: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'NaN', cursor: Number.NaN },
    { label: 'infinity', cursor: Number.POSITIVE_INFINITY },
  ])('rejects a $label next cursor before fetching details from an incomplete page', async ({ cursor }) => {
    clientMocks.listDingTalkDepartmentUsers.mockResolvedValueOnce({
      ...page('a', ['must-not-apply'], null), nextCursor: cursor,
    })

    await expect(fetchAllUsers(config, departments('a'))).rejects.toMatchObject({
      code: 'DIRECTORY_USER_PAGINATION_INCOMPLETE',
      message: 'Directory sync user pagination is incomplete',
    })
    expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(1)
    expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalled()
  })

  it('rejects a cursor that repeats the current page instead of requesting it again', async () => {
    clientMocks.listDingTalkDepartmentUsers.mockResolvedValueOnce(page('a', ['must-not-apply'], 0))

    await expect(fetchAllUsers(config, departments('a'))).rejects.toMatchObject({
      code: 'DIRECTORY_USER_PAGINATION_INCOMPLETE',
    })
    expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(1)
    expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalled()
  })

  it('rejects a multi-page cursor cycle without requesting the repeated page', async () => {
    clientMocks.listDingTalkDepartmentUsers
      .mockResolvedValueOnce(page('a', ['u1'], 100))
      .mockResolvedValueOnce(page('a', ['u2'], 200))
      .mockResolvedValueOnce(page('a', ['must-not-apply'], 100))

    await expect(fetchAllUsers(config, departments('a'))).rejects.toMatchObject({
      code: 'DIRECTORY_USER_PAGINATION_INCOMPLETE',
    })
    expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(3)
    expect(clientMocks.getDingTalkUserDetail.mock.calls.map((call) => call[1])).toEqual(['u1', 'u2'])
  })

  it('accepts an explicitly final empty page regardless of its unused cursor', async () => {
    clientMocks.listDingTalkDepartmentUsers.mockResolvedValueOnce(page('a', [], 0, false))

    expect(await fetchAllUsers(config, departments('a'))).toEqual(new Map())
    expect(clientMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(1)
    expect(clientMocks.getDingTalkUserDetail).not.toHaveBeenCalled()
  })
})
