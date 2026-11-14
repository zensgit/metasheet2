import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A manual run takes a root-department diagnostic sample after the two pulls. When the sample
 * fails the run still completes: the sample keys are absent from the completion stats and one
 * warning is logged. When the sample succeeds the completion stats carry the sample keys.
 *
 * Harness rules: query-mock lease/apply, closed provider-client factory, no database,
 * identifiers carry the `a0g-` prefix.
 */
const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({ ...clientMocks }))

import { Logger } from '../../src/core/logger'
import { syncDirectoryIntegration } from '../../src/directory/directory-sync'
import { assertKeySet, expectedStatsKeys, loadAllowlist } from '../fixtures/directory/golden-harness'

const INTEGRATION_ROW = {
  id: 'a0g-dir-1',
  org_id: 'default',
  provider: 'dingtalk',
  name: 'a0g-int-s',
  status: 'active',
  corp_id: 'a0g-corp-s',
  config: { appKey: 'a0g-appkey-s', appSecret: 'a0g-secret' },
  sync_enabled: true,
  schedule_cron: null,
  default_deprovision_policy: 'mark_inactive',
  last_sync_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

const RUN_ID = 'a0g-run-1'

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: 'a0g-dir-1',
    status: 'running',
    started_at: '2026-07-09T00:00:00.000Z',
    finished_at: null,
    stats: {},
    error_message: null,
    triggered_by: 'a0g-admin',
    trigger_source: 'manual',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

type LoggedCall = { text: string; params: unknown[] | undefined }

function installMocks() {
  const txCalls: LoggedCall[] = []
  pgMocks.query.mockReset().mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    if (text.includes('FROM directory_sync_runs')) return { rows: [runRow({ status: 'completed' })] }
    return { rows: [] }
  })
  pgMocks.transaction.mockReset().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
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
  return { txCalls }
}

function armClient(): void {
  for (const fn of Object.values(clientMocks)) fn.mockReset()
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false, nextCursor: null })
  clientMocks.getDingTalkUserDetail.mockResolvedValue({ userId: 'a0g-u1', name: 'a0g-u1', departmentIds: [], source: {} })
}

function completionStats(txCalls: LoggedCall[]): Record<string, unknown> {
  const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
  return JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
}

const SAMPLE_WARNING = /^Failed to sample directory diagnostics for integration /

describe('manual run: diagnostic sample', () => {
  let warnSpy: { mockRestore: () => void; mock: { calls: unknown[][] } }

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  const sampleWarnings = () => warnSpy.mock.calls.filter(([message]) => SAMPLE_WARNING.test(String(message)))

  it('completes without the sample keys and warns once when the sample fails', async () => {
    const { txCalls } = installMocks()
    armClient()
    clientMocks.listDingTalkDepartments
      .mockResolvedValueOnce([]) // department pull
      .mockRejectedValueOnce(new Error('a0g-sample-down')) // sample

    await expect(syncDirectoryIntegration('a0g-dir-1', 'a0g-admin', 'manual')).resolves.toBeDefined()

    const stats = completionStats(txCalls)
    const allowlist = loadAllowlist()
    assertKeySet(Object.keys(stats), expectedStatsKeys(allowlist, 'scheduler'))
    expect(Object.keys(stats)).toHaveLength(55)
    for (const key of allowlist.diagnosticKeys) expect(stats).not.toHaveProperty(key)
    expect(stats.externalPullRetryCount).toBe(0)
    expect(stats.externalPullRetryFlowControlCount).toBe(0)
    expect(stats.externalPullRetryHttp429Count).toBe(0)
    expect(stats.externalPullRetryNetworkCount).toBe(0)
    expect(stats.externalPullRetryOtherCount).toBe(0)
    expect(sampleWarnings()).toHaveLength(1)
  })

  it('completes with the sample keys and no sample warning when the sample succeeds', async () => {
    const { txCalls } = installMocks()
    armClient()
    clientMocks.listDingTalkDepartments.mockResolvedValue([])

    await expect(syncDirectoryIntegration('a0g-dir-1', 'a0g-admin', 'manual')).resolves.toBeDefined()

    const stats = completionStats(txCalls)
    assertKeySet(Object.keys(stats), expectedStatsKeys(loadAllowlist(), 'manual'))
    expect(Object.keys(stats)).toHaveLength(66)
    expect(sampleWarnings()).toHaveLength(0)
  })
})
