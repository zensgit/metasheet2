import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Directory sync characterization against real PostgreSQL.
 *
 * The provider client is mocked; the real `syncDirectoryIntegration`,
 * `previewDirectorySyncIntegration` and `testDirectoryIntegration` run against a synthetic
 * tenant. Each scenario serializes its observable surface (provider client calls, shadow rows,
 * link / membership / user / identity / grant rows, run stats, preview and test responses, failure
 * text and alert rows) and compares it with a committed golden. Golden values are as recorded
 * on main 7363f2d570707c075e6a5e22687613bf4d2eba4a.
 *
 * Harness rules:
 *  - every read is limited to this file's own integrations and `a0g-` identifiers;
 *  - random identifiers are aliased before serialization;
 *  - environment variables that influence a sync are pinned in `beforeAll` and restored in
 *    `afterAll`; the two module-load constants are pinned before the module import;
 *  - a comparison never prints values: the actual object is written to
 *    `test-results/directory-adapter-golden/<scenario>.actual.json` and the failure message
 *    only names the scenario;
 *  - the stats and preview key sets are compared with `golden/stats-allowlist.json`.
 */
const hoistedEnv = vi.hoisted(() => {
  const saved = {
    DIRECTORY_DEPROVISION_MAX_BATCH: process.env.DIRECTORY_DEPROVISION_MAX_BATCH,
    DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS: process.env.DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS,
  }
  process.env.DIRECTORY_DEPROVISION_MAX_BATCH = '25'
  process.env.DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS = '5000'
  return { saved }
})

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

import { query } from '../../src/db/pg'
import {
  createDirectoryIntegration,
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
  testDirectoryIntegration,
} from '../../src/directory/directory-sync'
import { DirectoryUserPaginationError } from '../../src/directory/directory-user-pagination'
import { DingTalkIncompleteResponseError } from '../../src/integrations/dingtalk/transport'
import {
  compareWithGolden,
  loadAllowlist,
  projectPreview,
  projectStats,
  type StatsTrigger,
} from '../fixtures/directory/golden-harness'
import {
  armGoldenClient,
  captureRunAndAlerts,
  captureShadow,
  cleanLeftovers,
  cleanupIntegrationRows,
  cleanupUsers,
  scenarioNames,
  seedPriorState,
  seededLocalUserIds,
  serializeCalls,
  type ScenarioKey,
} from '../fixtures/directory/dingtalk-golden-tenant'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip

itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const PINNED_ENV: Record<string, string | undefined> = {
  DIRECTORY_PRIMARY_DEPT_FROM_ORDER: undefined,
  DIRECTORY_SYNC_ALERT_WEBHOOK: '',
  DIRECTORY_SYNC_ALERT_WEBHOOK_SECRET: '',
  DIRECTORY_PENDING_ACTIVATION_ENABLED: undefined,
  DIRECTORY_DEPROVISION_ENABLED: undefined,
  DINGTALK_ALLOWED_CORP_IDS: undefined,
}

const allowlist = loadAllowlist()
const callSources = () => [
  { name: 'fetchDingTalkAppAccessToken', fn: clientMocks.fetchDingTalkAppAccessToken },
  { name: 'listDingTalkDepartments', fn: clientMocks.listDingTalkDepartments },
  { name: 'getDingTalkDepartmentDetail', fn: clientMocks.getDingTalkDepartmentDetail },
  { name: 'listDingTalkDepartmentUsers', fn: clientMocks.listDingTalkDepartmentUsers },
  { name: 'getDingTalkUserDetail', fn: clientMocks.getDingTalkUserDetail },
]

const createdIntegrationIds: string[] = []
const touchedUserIds = new Set<string>()

async function createScenarioIntegration(
  key: ScenarioKey,
  admissionMode: 'manual_only' | 'auto_for_scoped_departments',
  options: { seed: boolean },
): Promise<{ id: string; name: string }> {
  const names = scenarioNames(key)
  const integration = await createDirectoryIntegration({
    name: names.integrationName,
    corpId: names.corpId,
    appKey: names.appKey,
    appSecret: 'a0g-secret',
    admissionMode,
    admissionDepartmentIds: admissionMode === 'auto_for_scoped_departments' ? ['dA'] : [],
    excludeDepartmentIds: [],
  })
  createdIntegrationIds.push(integration.id)
  if (options.seed) {
    for (const id of seededLocalUserIds(key)) touchedUserIds.add(id)
    await seedPriorState(query, key, integration.id)
  }
  return { id: integration.id, name: integration.name }
}

async function rememberLinkedUsers(integrationId: string): Promise<void> {
  const rows = await query<{ local_user_id: string }>(
    `SELECT l.local_user_id
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
      WHERE a.integration_id = $1 AND l.local_user_id IS NOT NULL`,
    [integrationId],
  )
  for (const row of rows.rows) touchedUserIds.add(row.local_user_id)
}

/** The serialized observable surface of one applied or failed sync. */
async function serializeScenario(
  key: ScenarioKey,
  integrationId: string,
): Promise<Record<string, unknown>> {
  await rememberLinkedUsers(integrationId)
  const calls = serializeCalls(callSources())
  const { accountAlias, ...shadow } = await captureShadow(query, key, integrationId)
  const { runs, integration, alerts } = await captureRunAndAlerts(query, integrationId)
  return { calls, ...shadow, runs, integration, alerts, __accountAlias: accountAlias }
}

function withoutAlias(serialized: Record<string, unknown>): Record<string, unknown> {
  const { __accountAlias: _alias, ...rest } = serialized
  return rest
}

function projectRunStats(
  serialized: Record<string, unknown>,
  stats: Record<string, unknown>,
  trigger: StatsTrigger,
): Record<string, unknown> {
  const alias = serialized.__accountAlias as (id: string | null | undefined) => string | null
  const projected = projectStats(stats, allowlist, trigger)
  const mapAccountIds = (entries: unknown): unknown =>
    Array.isArray(entries)
      ? entries.map((entry) => ({ ...(entry as Record<string, unknown>), directoryAccountId: alias((entry as { directoryAccountId: string }).directoryAccountId) }))
      : entries
  projected.deprovisionAffected = mapAccountIds(projected.deprovisionAffected)
  projected.deprovisionManualReviewPending = mapAccountIds(projected.deprovisionManualReviewPending)
  return projected
}

describeIfDatabase('directory sync characterization (real DB)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let manualApplyCalls: Array<{ fn: string; args: unknown[] }> = []
  let manualApplyStats: Record<string, unknown> = {}

  beforeAll(async () => {
    for (const [name, value] of Object.entries(PINNED_ENV)) {
      savedEnv[name] = process.env[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await cleanLeftovers(query)
  })

  afterAll(async () => {
    for (const integrationId of createdIntegrationIds) await cleanupIntegrationRows(query, integrationId)
    await cleanupUsers(query, Array.from(touchedUserIds))
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    for (const [name, value] of Object.entries(hoistedEnv.saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('manual run with manual admission matches the golden', async () => {
    const integration = await createScenarioIntegration('a', 'manual_only', { seed: true })
    armGoldenClient(clientMocks, 'a')

    const result = await syncDirectoryIntegration(integration.id, 'system:a0g-a', 'manual')
    const serialized = await serializeScenario('a', integration.id)
    const stats = projectRunStats(serialized, result.run.stats as Record<string, unknown>, 'manual')
    manualApplyCalls = serialized.calls as Array<{ fn: string; args: unknown[] }>
    manualApplyStats = stats

    compareWithGolden({
      scenario: 'manual-apply',
      actual: {
        ...withoutAlias(serialized),
        stats,
        onboardingPacketCount: result.autoAdmissionOnboardingPackets.length,
      },
    })
  }, 60_000)

  it('scheduler run with scoped auto admission matches the golden', async () => {
    const integration = await createScenarioIntegration('b', 'auto_for_scoped_departments', { seed: true })
    armGoldenClient(clientMocks, 'b')

    const result = await syncDirectoryIntegration(integration.id, 'system:a0g-b', 'scheduler')
    const serialized = await serializeScenario('b', integration.id)
    const stats = projectRunStats(serialized, result.run.stats as Record<string, unknown>, 'scheduler')

    compareWithGolden({
      scenario: 'scheduler-apply-auto-admission',
      actual: {
        ...withoutAlias(serialized),
        stats,
        onboardingPacketCount: result.autoAdmissionOnboardingPackets.length,
      },
    })
  }, 60_000)

  it('preview matches the golden and pulls the same prefix of calls as a manual run', async () => {
    const integration = await createScenarioIntegration('c', 'auto_for_scoped_departments', { seed: true })
    armGoldenClient(clientMocks, 'c')

    const preview = await previewDirectorySyncIntegration(integration.id)
    const calls = serializeCalls(callSources())
    const projected = projectPreview(preview as unknown as Record<string, unknown>, allowlist)
    expect(projected.integrationId).toBe(integration.id)
    projected.integrationId = '<integration-id>'

    compareWithGolden({ scenario: 'preview', actual: { calls, preview: projected } })

    // A manual run pulls the same sequence followed by the four diagnostic-sample calls.
    expect(manualApplyCalls.length).toBeGreaterThan(4)
    expect(calls).toEqual(manualApplyCalls.slice(0, -4))
    const sampleCalls = manualApplyCalls.slice(-4)
    expect(sampleCalls.map((call) => call.fn)).toEqual([
      'fetchDingTalkAppAccessToken',
      'listDingTalkDepartments',
      'listDingTalkDepartmentUsers',
      'listDingTalkDepartmentUsers',
    ])
    expect((sampleCalls[3].args[4] as { containAccessLimit?: boolean }).containAccessLimit).toBe(true)
    expect(preview.departmentsSeen).toBe(manualApplyStats.departmentsSynced)
    expect(preview.accountsSeen).toBe(manualApplyStats.accountsSynced)
  }, 60_000)

  it('connection test response matches the golden, including key order', async () => {
    const integration = await createScenarioIntegration('d', 'manual_only', { seed: false })
    armGoldenClient(clientMocks, 'd')
    const names = scenarioNames('d')

    const result = await testDirectoryIntegration({
      integrationId: integration.id,
      name: names.integrationName,
      corpId: names.corpId,
      appKey: names.appKey,
    })
    const calls = serializeCalls(callSources())

    expect(Object.keys(result)).toEqual([
      'corpId',
      'rootDepartmentId',
      'appKey',
      'departmentSampleCount',
      'sampledDepartments',
      'userSampleCount',
      'sampledUsers',
      'diagnostics',
      'summary',
      'warnings',
    ])
    expect(Object.keys(result.diagnostics)).toEqual([
      'rootDepartmentChildCount',
      'rootDepartmentDirectUserCount',
      'rootDepartmentDirectUserHasMore',
      'rootDepartmentDirectUserCountWithAccessLimit',
      'rootDepartmentDirectUserHasMoreWithAccessLimit',
      'sampledRootDepartmentUsers',
      'sampledRootDepartmentUsersWithAccessLimit',
    ])
    compareWithGolden({ scenario: 'connection-test', actual: { calls, result } })
  }, 60_000)

  it('a pagination failure ends the run before any further member detail call and leaves shadow rows unchanged', async () => {
    const integration = await createScenarioIntegration('e', 'manual_only', { seed: true })
    armGoldenClient(clientMocks, 'e', 'cursor')

    const failure = await syncDirectoryIntegration(integration.id, 'system:a0g-e', 'manual').then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(failure).toBeInstanceOf(DirectoryUserPaginationError)
    const serialized = await serializeScenario('e', integration.id)

    compareWithGolden({ scenario: 'failure-pagination', actual: withoutAlias(serialized) })
  }, 60_000)

  it('an incomplete provider response ends the run with the provider failure text and leaves shadow rows unchanged', async () => {
    const integration = await createScenarioIntegration('f', 'manual_only', { seed: true })
    armGoldenClient(clientMocks, 'f', 'shape')

    const failure = await syncDirectoryIntegration(integration.id, 'system:a0g-f', 'scheduler').then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(failure).toBeInstanceOf(DingTalkIncompleteResponseError)
    const serialized = await serializeScenario('f', integration.id)

    compareWithGolden({ scenario: 'failure-incomplete-response', actual: withoutAlias(serialized) })
  }, 60_000)
})
