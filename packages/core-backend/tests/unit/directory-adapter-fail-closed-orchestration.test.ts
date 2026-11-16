import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Orchestration resolves the integration's provider adapter before any provider call or run row,
 * fails closed for a provider without an adapter, and treats the adapter's provider status and
 * capability fields as data it does not read.
 *
 * Harness rules: query-mock lease/apply, closed provider-client factory, no database, identifiers
 * carry the `a0g-` prefix. The integration rows with a foreign provider are returned by a mocked
 * query; the integration lookup itself selects only the DingTalk provider, so these rows are not
 * reachable through it.
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
import type { DirectoryAdapter, DirectoryMemberRecord } from '../../src/directory/directory-adapter'
import {
  DirectoryProviderAdapterUnavailableError,
  __directoryAdapterRegistryForTests,
} from '../../src/directory/directory-adapter-registry'
import {
  __directorySyncInternalsForTests,
  DirectoryValidationError,
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
  testDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { assertKeySet, expectedStatsKeys, loadAllowlist } from '../fixtures/directory/golden-harness'

const INTEGRATION_ID = 'a0g-dir-1'
const RUN_ID = 'a0g-run-1'

function integrationRow(provider: string) {
  return {
    id: INTEGRATION_ID,
    org_id: 'default',
    provider,
    name: 'a0g-int-x',
    status: 'active',
    corp_id: 'a0g-corp-x',
    config: { appKey: 'a0g-appkey-x', appSecret: 'a0g-secret' },
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

function installMocks(provider: string) {
  const queryTexts: string[] = []
  const txCalls: LoggedCall[] = []
  pgMocks.query.mockReset().mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    queryTexts.push(text)
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [integrationRow(provider)] }
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
  return { queryTexts, txCalls }
}

function providerCallCount(): number {
  return Object.values(clientMocks).reduce((total, fn) => total + fn.mock.calls.length, 0)
}

function fakeAdapter(overrides: Partial<DirectoryAdapter<unknown>> = {}): DirectoryAdapter<unknown> {
  const member: DirectoryMemberRecord = {
    userId: 'a0g-fake-1',
    name: 'a0g-fake-1',
    unionId: 'a0g-fake-1-union',
    departmentIds: ['1'],
    source: {},
    providerStatus: 'provider_marked_inactive',
  }
  return {
    provider: 'dingtalk',
    capabilities: {
      contactFields: { email: 'unavailable', mobile: 'unavailable' },
      memberOpenId: 'unavailable',
      memberUnionId: 'unavailable',
      managerIds: false,
      primaryDepartmentSignal: false,
      diagnostics: false,
    },
    fetchDepartments: async (_config, integrationName) => new Map([
      ['1', { id: '1', parentId: null, name: integrationName, order: 0, source: { syntheticRoot: true } }],
    ]),
    fetchMembers: async () => new Map([[member.userId, member]]),
    observeRetries: (_observer, fn) => fn(),
    ...overrides,
  }
}

describe('adapter resolution in the orchestration entry points', () => {
  let warnSpy: { mockRestore: () => void }
  let infoSpy: { mockRestore: () => void }

  beforeEach(() => {
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
    for (const fn of Object.values(clientMocks)) fn.mockReset()
  })

  afterEach(() => {
    __directoryAdapterRegistryForTests.restore()
    warnSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('a run for a provider without an adapter fails before a run row, a transaction or a provider call', async () => {
    const { queryTexts } = installMocks('a0g-other')

    await expect(syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual'))
      .rejects.toBeInstanceOf(DirectoryProviderAdapterUnavailableError)

    expect(queryTexts.some((text) => text.includes('INSERT INTO directory_sync_runs'))).toBe(false)
    expect(pgMocks.transaction).not.toHaveBeenCalled()
    expect(providerCallCount()).toBe(0)
  })

  it('a preview for a provider without an adapter fails before any provider call', async () => {
    installMocks('a0g-other')

    await expect(previewDirectorySyncIntegration(INTEGRATION_ID))
      .rejects.toBeInstanceOf(DirectoryProviderAdapterUnavailableError)

    expect(providerCallCount()).toBe(0)
  })

  it('a run fails closed when the registry has no adapter at all', async () => {
    installMocks('dingtalk')
    __directoryAdapterRegistryForTests.replace(new Map())

    await expect(syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual'))
      .rejects.toBeInstanceOf(DirectoryProviderAdapterUnavailableError)
    expect(providerCallCount()).toBe(0)
  })

  it('the connection test uses the registered adapter and refuses an adapter that cannot probe', async () => {
    __directoryAdapterRegistryForTests.replace(new Map([['dingtalk', fakeAdapter()]]))

    await expect(testDirectoryIntegration({
      name: 'a0g-int-x', corpId: 'a0g-corp-x', appKey: 'a0g-appkey-x', appSecret: 'a0g-secret',
    })).rejects.toBeInstanceOf(DirectoryValidationError)
    expect(providerCallCount()).toBe(0)
  })

  it('the connection test fails closed when the registry has no adapter', async () => {
    __directoryAdapterRegistryForTests.replace(new Map())

    await expect(testDirectoryIntegration({
      name: 'a0g-int-x', corpId: 'a0g-corp-x', appKey: 'a0g-appkey-x', appSecret: 'a0g-secret',
    })).rejects.toBeInstanceOf(DirectoryProviderAdapterUnavailableError)
  })

  it('a member marked inactive by the provider is still written, and capabilities do not change the run', async () => {
    const { txCalls } = installMocks('dingtalk')
    __directoryAdapterRegistryForTests.replace(new Map([['dingtalk', fakeAdapter()]]))

    await syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual')

    const upserts = txCalls.filter((call) => call.text === __directorySyncInternalsForTests.DIRECTORY_ACCOUNT_UPSERT_SQL)
    expect(upserts).toHaveLength(1)
    expect(upserts[0].params).toContain('a0g-fake-1')
    // an adapter without a diagnostic sample leaves a manual run with the scheduler key set
    const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
    const stats = JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
    assertKeySet(Object.keys(stats), expectedStatsKeys(loadAllowlist(), 'scheduler'))
    expect(providerCallCount()).toBe(0)
  })

  it('the pull maps are written for the integration provider', async () => {
    const { txCalls } = installMocks('dingtalk')
    __directoryAdapterRegistryForTests.replace(new Map([['dingtalk', fakeAdapter()]]))

    await syncDirectoryIntegration(INTEGRATION_ID, 'a0g-admin', 'manual')

    const departmentWrite = txCalls.find((call) => call.text.includes('INSERT INTO directory_departments'))
    expect(departmentWrite?.params?.[1]).toBe('dingtalk')
    const accountWrite = txCalls.find((call) => call.text === __directorySyncInternalsForTests.DIRECTORY_ACCOUNT_UPSERT_SQL)
    expect(accountWrite?.params?.[1]).toBe('dingtalk')
  })
})

describe('provider arguments of the access-graph helpers', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
  })

  it.each(['', '  ', undefined as unknown as string])('the match-map loader refuses an empty provider (%j) before any query', async (provider) => {
    const clientQuery = vi.fn()

    await expect(__directorySyncInternalsForTests.loadMatchMaps([], provider, { query: clientQuery })).rejects.toThrow()

    expect(clientQuery).not.toHaveBeenCalled()
    expect(pgMocks.query).not.toHaveBeenCalled()
  })

  it.each(['', '  ', undefined as unknown as string])('the access-graph inventory refuses an empty provider (%j) before any query', async (provider) => {
    const clientQuery = vi.fn()

    await expect(__directorySyncInternalsForTests.lockDirectorySyncAccessGraphUsers(
      { query: clientQuery } as never,
      { integrationId: 'a0g-dir-1', provider, users: [] },
    )).rejects.toThrow()

    expect(clientQuery).not.toHaveBeenCalled()
  })

  it('the match-map loader binds the given provider to the identity query', async () => {
    const clientQuery = vi.fn(async () => ({ rows: [] }))
    pgMocks.query.mockResolvedValue({ rows: [] })

    await __directorySyncInternalsForTests.loadMatchMaps(
      [{ external_key: 'a0g-k', union_id: 'a0g-union', open_id: null, email: null, mobile: null }] as never,
      'a0g-provider',
      { query: clientQuery },
    )

    const identityCall = (clientQuery.mock.calls as unknown as Array<[string, unknown[]]>)
      .find(([sql]) => sql.includes('FROM user_external_identities'))
    expect(identityCall?.[1][0]).toBe('a0g-provider')
  })
})
