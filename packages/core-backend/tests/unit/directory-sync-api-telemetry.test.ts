/**
 * §7.7 Sync Performance — the external directory-pull call counters must count what actually
 * happens. This drives the REAL `fetchAllDepartments` / `fetchAllUsers` (the sync's pull code
 * path) with only the DingTalk HTTP client mocked (the network boundary), so the increments
 * under test run in real code. No DB — runs in the required test(20.x) job.
 *
 * The load-bearing property is the N+1 signature: exactly one `user/get` per UNIQUE user.
 * The fixture puts one user in TWO departments; the assertions pin BOTH the counter AND the
 * client mock's call count to the unique-user total, so the counter cannot be satisfied by a
 * stale/tautological value — remove the `userDetailCalls += 1` increment and the counter goes
 * to 0 while the mock call count stays 4 (they diverge → RED).
 */
import { describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { fetchAllDepartments, fetchAllUsers } from '../../src/directory/directory-sync'
import {
  createDirectorySyncApiCallCounters,
  summarizeDirectorySyncApiCalls,
} from '../../src/directory/directory-sync-api-telemetry'

const ROOT = 'r'
const DEPT_A = 'A'
const DEPT_B = 'B'

// minimal config — the pull helpers only read appKey/appSecret/baseUrl/rootDepartmentId/pageSize.
const config = {
  appKey: 'k',
  appSecret: 's',
  workNotificationAgentId: '',
  rootDepartmentId: ROOT,
  baseUrl: 'https://example.test',
  pageSize: 100,
  admissionMode: 'disabled',
  admissionDepartmentIds: [],
  excludeDepartmentIds: [],
  memberGroupSyncMode: 'disabled',
  memberGroupDepartmentIds: [],
  memberGroupDefaultRoleIds: [],
  memberGroupDefaultNamespaces: [],
} as unknown as Parameters<typeof fetchAllDepartments>[0]

function dept(id: string, parentId: string | null, name: string) {
  return { id, parentId, name, order: 0, source: {} }
}
function summary(userId: string, deptId: string) {
  return { userId, name: userId, departmentIds: [deptId], source: {} }
}
function detail(userId: string) {
  return { userId, name: userId, departmentIds: [], source: {} }
}

function wireClient() {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('app-token')
  // BFS: root -> [A, B]; A -> []; B -> []  => 3 listsub calls (r, A, B).
  clientMocks.listDingTalkDepartments.mockImplementation(async (_t: string, parentId: string) => {
    if (parentId === ROOT) return [dept(DEPT_A, ROOT, 'A'), dept(DEPT_B, ROOT, 'B')]
    return []
  })
  // department/get is called once per department (root + A + B = 3).
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  // Users:
  //   root -> 1 page, 0 users
  //   A    -> 2 pages: [U1,U2] then [U3]  (pagination proves pages counted, not departments)
  //   B    -> 1 page:  [U3,U4]            (U3 shared with A -> detail fetched ONCE)
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(
    async (_t: string, deptId: string, cursor: number) => {
      if (deptId === DEPT_A && cursor === 0) {
        return { users: [summary('U1', DEPT_A), summary('U2', DEPT_A)], nextCursor: 100, hasMore: true }
      }
      if (deptId === DEPT_A && cursor === 100) {
        return { users: [summary('U3', DEPT_A)], nextCursor: null, hasMore: false }
      }
      if (deptId === DEPT_B) {
        return { users: [summary('U3', DEPT_B), summary('U4', DEPT_B)], nextCursor: null, hasMore: false }
      }
      return { users: [], nextCursor: null, hasMore: false }
    },
  )
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_t: string, userId: string) => detail(userId))
}

describe('§7.7 directory-sync external API call telemetry', () => {
  it('fetchAllDepartments counts one listsub per department visited and one department/get per department', async () => {
    vi.clearAllMocks()
    wireClient()
    const counters = createDirectorySyncApiCallCounters()

    const departments = await fetchAllDepartments(config, 'Acme', counters)

    // root + A + B
    expect(departments.size).toBe(3)
    expect(counters.departmentListCalls).toBe(3)
    expect(counters.departmentDetailCalls).toBe(3)
    // both-assertions: the counter equals the actual client invocation count, so it can't be
    // a stale/tautological value.
    expect(clientMocks.listDingTalkDepartments.mock.calls.length).toBe(3)
    expect(clientMocks.getDingTalkDepartmentDetail.mock.calls.length).toBe(3)
  })

  it('fetchAllUsers issues exactly one user/get per UNIQUE user (the N+1 signature) and counts every list page', async () => {
    vi.clearAllMocks()
    wireClient()
    const departmentMap = await fetchAllDepartments(config, 'Acme')
    const counters = createDirectorySyncApiCallCounters()

    const users = await fetchAllUsers(config, departmentMap, counters)

    // U1, U2, U3, U4 — U3 appears in both A and B but is deduped.
    expect([...users.keys()].sort()).toEqual(['U1', 'U2', 'U3', 'U4'])

    // THE N+1: one user/get per unique user, NOT per (user × department) occurrence (which is 5).
    expect(counters.userDetailCalls).toBe(4)
    // both-assertions non-tautology: counter tracks the real client call count. Remove the
    // increment and this stays 4 while the counter drops to 0 -> divergence -> RED.
    expect(clientMocks.getDingTalkUserDetail.mock.calls.length).toBe(4)

    // Pages: root(1) + A(2) + B(1) = 4 — proves pages are counted, not departments (3).
    expect(counters.userListPageCalls).toBe(4)
    expect(clientMocks.listDingTalkDepartmentUsers.mock.calls.length).toBe(4)
  })

  it('summarizeDirectorySyncApiCalls projects external* keys and an honest pull-only aggregate', () => {
    const summarized = summarizeDirectorySyncApiCalls({
      departmentListCalls: 3,
      departmentDetailCalls: 3,
      userListPageCalls: 4,
      userDetailCalls: 4,
    })
    expect(summarized).toEqual({
      externalDepartmentListCalls: 3,
      externalDepartmentDetailCalls: 3,
      externalUserListPageCalls: 4,
      externalUserDetailCalls: 4,
      externalDirectoryPullCalls: 14, // 3 + 3 + 4 + 4 — sum of the four pull categories
    })
  })

  it('counters passed to neither helper stay pristine (optional param is truly optional)', async () => {
    vi.clearAllMocks()
    wireClient()
    // no counter argument — must not throw and must still return the full pull.
    const departmentMap = await fetchAllDepartments(config, 'Acme')
    const users = await fetchAllUsers(config, departmentMap)
    expect(departmentMap.size).toBe(3)
    expect(users.size).toBe(4)
  })
})
