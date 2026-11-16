import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Transport retries are counted for exactly the two directory pulls (departments, then members)
 * and for nothing else. A manual run also takes a root-department diagnostic sample after the
 * pulls; a retry inside that sample must not reach `externalPullRetry*`.
 *
 * Harness: query-mock lease/apply with the real transport retry loop (the provider client is
 * mocked; each mocked call makes one real transport call that is rejected once and then served).
 */
const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const dingtalkMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: dingtalkMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: dingtalkMocks.listDingTalkDepartments,
  listDingTalkDepartmentUsers: dingtalkMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: dingtalkMocks.getDingTalkUserDetail,
  getDingTalkDepartmentDetail: dingtalkMocks.getDingTalkDepartmentDetail,
}))

import { Logger } from '../../src/core/logger'
import { requestDingTalkTransportJson } from '../../src/integrations/dingtalk/transport'
import { syncDirectoryIntegration } from '../../src/directory/directory-sync'

const INTEGRATION_ROW = {
  id: 'dir-1',
  org_id: 'default',
  provider: 'dingtalk',
  name: 'DingTalk CN',
  status: 'active',
  corp_id: 'dingcorp',
  config: { appKey: 'k', appSecret: 's' },
  sync_enabled: true,
  schedule_cron: null,
  default_deprovision_policy: 'mark_inactive',
  last_sync_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

const RUN_ID = 'run-1'

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: 'dir-1',
    status: 'running',
    started_at: '2026-07-09T00:00:00.000Z',
    finished_at: null,
    stats: {},
    error_message: null,
    triggered_by: 'admin-1',
    trigger_source: 'manual',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

type LoggedCall = { text: string; params: unknown[] | undefined }

function installRunMocks() {
  const txCalls: LoggedCall[] = []
  pgMocks.query.mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    if (text.includes('FROM directory_sync_runs')) return { rows: [runRow({ status: 'completed' })] }
    return { rows: [] }
  })
  pgMocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = String(sql)
        txCalls.push({ text, params })
        if (text.includes("SET status = 'completed'")) return { rows: [{ id: RUN_ID }] }
        return { rows: [] }
      },
    }
    return fn(client)
  })
  dingtalkMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  dingtalkMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  dingtalkMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false, nextCursor: null })
  return { txCalls }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** One real transport call that is rejected once with a flow-control envelope, then served. */
function makeRetryingCall() {
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ errcode: 90018, errmsg: 'flow control' }))
    .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok', result: [] }))
  const call = () => requestDingTalkTransportJson({
    input: 'https://example.test/topapi/v2/department/listsub',
    init: { method: 'POST', body: '{}' },
    fallbackError: 'department listing failed',
    kind: 'read',
    envelope: 'oapi',
    fetchFn: fetchFn as unknown as typeof fetch,
  })
  return { fetchFn, call }
}

function completionStats(txCalls: LoggedCall[]): Record<string, unknown> {
  const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
  return JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
}

describe('manual run: retry scope of the directory pulls', () => {
  let randomSpy: { mockRestore: () => void }
  let warnSpy: { mockRestore: () => void }

  beforeEach(() => {
    vi.clearAllMocks()
    // Full-jitter backoff x 0, so each retry waits 0 ms.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    randomSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('counts a retry made inside the department pull', async () => {
    const { txCalls } = installRunMocks()
    const retrying = makeRetryingCall()
    dingtalkMocks.listDingTalkDepartments
      .mockImplementationOnce(async () => {
        await retrying.call()
        return []
      })
      .mockResolvedValue([])

    await syncDirectoryIntegration('dir-1', 'admin-1', 'manual')

    expect(retrying.fetchFn).toHaveBeenCalledTimes(2)
    const stats = completionStats(txCalls)
    expect(stats.externalPullRetryCount).toBe(1)
    expect(stats.externalPullRetryFlowControlCount).toBe(1)
    // The diagnostic sample ran in this manual run.
    expect(stats).toHaveProperty('rootDepartmentChildCount')
  })

  it('does not count a retry made inside the root-department diagnostic sample', async () => {
    const { txCalls } = installRunMocks()
    const retrying = makeRetryingCall()
    dingtalkMocks.listDingTalkDepartments
      .mockResolvedValueOnce([]) // department pull
      .mockImplementationOnce(async () => { // diagnostic sample
        await retrying.call()
        return []
      })
      .mockResolvedValue([])

    await syncDirectoryIntegration('dir-1', 'admin-1', 'manual')

    // The retry happened, and the sample ran after both pulls.
    expect(retrying.fetchFn).toHaveBeenCalledTimes(2)
    expect(dingtalkMocks.listDingTalkDepartments).toHaveBeenCalledTimes(2)
    const stats = completionStats(txCalls)
    expect(stats).toHaveProperty('rootDepartmentChildCount')
    expect(stats.externalPullRetryCount).toBe(0)
    expect(stats.externalPullRetryFlowControlCount).toBe(0)
    expect(stats.externalPullRetryHttp429Count).toBe(0)
    expect(stats.externalPullRetryNetworkCount).toBe(0)
    expect(stats.externalPullRetryOtherCount).toBe(0)
  })
})
