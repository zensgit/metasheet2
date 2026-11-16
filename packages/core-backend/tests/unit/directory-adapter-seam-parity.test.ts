import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The orchestration entry points drive the provider client with the committed goldens' call
 * sequence and write the allowlisted run-stats key set, without a database.
 *
 * Harness rules: query-mock lease/apply; the provider client is a closed factory armed by the
 * synthetic tenant; token, secret and app key values match the aliasing patterns of
 * `serializeCalls`; identifiers carry the `a0g-` prefix; the logger is silenced.
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
import {
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
  testDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { DirectoryUserPaginationError } from '../../src/directory/directory-user-pagination'
import { DingTalkIncompleteResponseError } from '../../src/integrations/dingtalk/transport'
import {
  GOLDEN_SECRET,
  armGoldenClient,
  scenarioNames,
  serializeCalls,
  type ClientVariant,
  type ScenarioKey,
} from '../fixtures/directory/dingtalk-golden-tenant'
import { assertKeySet, expectedStatsKeys, loadAllowlist } from '../fixtures/directory/golden-harness'

const sources = () => Object.entries(clientMocks).map(([name, fn]) => ({ name, fn }))
const goldenFile = (name: string) =>
  JSON.parse(readFileSync(path.join(__dirname, '../fixtures/directory/golden', `${name}.json`), 'utf8'))

const INTEGRATION_ID = 'a0g-dir-1'
const RUN_ID = 'a0g-run-1'

function integrationRow(key: ScenarioKey, extraConfig: Record<string, unknown> = {}) {
  const names = scenarioNames(key)
  return {
    id: INTEGRATION_ID,
    org_id: 'default',
    provider: 'dingtalk',
    name: names.integrationName,
    status: 'active',
    corp_id: names.corpId,
    config: { appKey: names.appKey, appSecret: GOLDEN_SECRET, ...extraConfig },
    sync_enabled: true,
    schedule_cron: null,
    default_deprovision_policy: 'mark_inactive',
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
  }
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: INTEGRATION_ID,
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

function installMocks(row: ReturnType<typeof integrationRow>) {
  const txCalls: LoggedCall[] = []
  pgMocks.query.mockReset().mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [row] }
    if (text.includes('FROM directory_sync_runs') && text.includes("status = 'running'")) return { rows: [] }
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

function completionStats(txCalls: LoggedCall[]): Record<string, unknown> {
  const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
  return JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
}

async function runSync(
  key: ScenarioKey,
  trigger: 'manual' | 'scheduler',
  variant: ClientVariant = 'normal',
  extraConfig: Record<string, unknown> = {},
) {
  armGoldenClient(clientMocks, key, variant)
  const { txCalls } = installMocks(integrationRow(key, extraConfig))
  await syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', trigger)
  return completionStats(txCalls)
}

describe('orchestration and the committed goldens', () => {
  let warnSpy: { mockRestore: () => void }
  let infoSpy: { mockRestore: () => void }

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('a manual run issues the golden call sequence and writes the manual key set', async () => {
    const stats = await runSync('a', 'manual')
    expect(serializeCalls(sources())).toEqual(goldenFile('manual-apply').calls)
    expect(Object.keys(stats)).toHaveLength(66)
    assertKeySet(Object.keys(stats), expectedStatsKeys(loadAllowlist(), 'manual'))
  })

  it('a scheduler run issues the golden call sequence and writes the scheduler key set', async () => {
    const stats = await runSync('b', 'scheduler')
    expect(serializeCalls(sources())).toEqual(goldenFile('scheduler-apply-auto-admission').calls)
    expect(Object.keys(stats)).toHaveLength(55)
    assertKeySet(Object.keys(stats), expectedStatsKeys(loadAllowlist(), 'scheduler'))
  })

  it('a preview issues the golden call sequence, which is the manual sequence without the sample', async () => {
    armGoldenClient(clientMocks, 'c')
    installMocks(integrationRow('c'))
    await previewDirectorySyncIntegration(INTEGRATION_ID)
    const calls = serializeCalls(sources())
    expect(calls).toEqual(goldenFile('preview').calls)
    expect(calls).toEqual(goldenFile('manual-apply').calls.slice(0, calls.length))
    expect(goldenFile('manual-apply').calls.length - calls.length).toBe(4)
  })

  it('a connection test issues the golden calls and returns the golden values and key order', async () => {
    armGoldenClient(clientMocks, 'd')
    const names = scenarioNames('d')
    const result = await testDirectoryIntegration({
      name: names.integrationName,
      corpId: names.corpId,
      appKey: names.appKey,
      appSecret: GOLDEN_SECRET,
    })
    expect(serializeCalls(sources())).toEqual(goldenFile('connection-test').calls)
    expect(JSON.parse(JSON.stringify(result))).toEqual(goldenFile('connection-test').result)
    expect(Object.keys(result)).toEqual([
      'corpId', 'rootDepartmentId', 'appKey', 'departmentSampleCount', 'sampledDepartments',
      'userSampleCount', 'sampledUsers', 'diagnostics', 'summary', 'warnings',
    ])
    expect(Object.keys(result.diagnostics)).toEqual([
      'rootDepartmentChildCount', 'rootDepartmentDirectUserCount', 'rootDepartmentDirectUserHasMore',
      'rootDepartmentDirectUserCountWithAccessLimit', 'rootDepartmentDirectUserHasMoreWithAccessLimit',
      'sampledRootDepartmentUsers', 'sampledRootDepartmentUsersWithAccessLimit',
    ])
    expect(Object.keys(result.summary)).toEqual(['code', 'title', 'nextAction'])
  })

  it('a repeated member cursor fails the run with the pagination error and stops at the golden call', async () => {
    armGoldenClient(clientMocks, 'e', 'cursor')
    installMocks(integrationRow('e'))
    await expect(syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual'))
      .rejects.toBeInstanceOf(DirectoryUserPaginationError)
    expect(serializeCalls(sources())).toEqual(goldenFile('failure-pagination').calls)
  })

  it('an incomplete department response fails the run with the incomplete-response error', async () => {
    armGoldenClient(clientMocks, 'f', 'shape')
    installMocks(integrationRow('f'))
    await expect(syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual'))
      .rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    expect(serializeCalls(sources())).toEqual(goldenFile('failure-incomplete-response').calls)
  })

  it('the configured base url and page size reach every provider call of a run', async () => {
    const baseUrl = 'https://a0g.example.test'
    await runSync('a', 'manual', 'normal', { baseUrl, pageSize: 7 })
    const calls = serializeCalls(sources())
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      const options = call.fn === 'fetchDingTalkAppAccessToken' ? call.args[0] : call.args[call.args.length - 1]
      expect((options as { baseUrl?: string }).baseUrl).toBe(baseUrl)
    }
    const pageSizes = calls
      .filter((call) => call.fn === 'listDingTalkDepartmentUsers')
      .map((call) => call.args[3])
    expect(pageSizes.length).toBeGreaterThan(0)
    // member pages use the configured size; the sample reads use min(size, 100)
    expect(new Set(pageSizes)).toEqual(new Set([7]))
  })
})
