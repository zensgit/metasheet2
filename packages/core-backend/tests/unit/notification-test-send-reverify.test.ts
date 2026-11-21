import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DingTalkIntegrationScopedMessageTuple } from '../../src/integrations/dingtalk/work-notification-settings'
import { DingTalkWorkNotificationAdapter } from '../../src/notifications/adapters/dingtalk-work-notification-adapter'
import { createNotificationTestSendService } from '../../src/notifications/test-send-service'
import { ProtectedAddress, type Db, type RecipientResolver, type ResolvedTarget, type ResolveResult } from '../../src/notifications/recipient-resolver'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(() => { throw new Error('no database in reverify tests') }), pool: null }))

const INPUT = {
  orgId: 'fixture-org', userId: 'fixture-user',
  endpointId: '00000000-0000-4000-8000-000000000111', idempotencyKey: 'fixture-key-0001',
}
const CONNECTION = '00000000-0000-4000-8000-000000000112'
const SEND_ID = '00000000-0000-4000-8000-000000000113'
const CONFIG = { appKey: 'fixture-app-key', appSecret: 'fixture-secret', agentId: '900000001', baseUrl: 'https://oapi.dingtalk.com' }

function target(address: string, proofWitness = 'proof'): ResolvedTarget {
  return {
    connectionId: CONNECTION, provider: 'dingtalk', transport: 'work_notification', addressKind: 'dingtalk_userid',
    proofKind: 'directory_link', proofId: '00000000-0000-4000-8000-000000000114', proofWitness,
    addressWitness: `address-${address}`, tenantAddressWitness: `tenant-address-${address}`,
    boundTenant: 'fixture-tenant', boundAppScope: 'fixture-app', address: new ProtectedAddress(address),
  }
}

type Scenario = 'unchanged' | 'revoked-before-admission' | 'revoked-during-prepare' | 'rebound-during-prepare'

function harness(scenario: Scenario) {
  const endpoint = { id: INPUT.endpointId, connection_id: CONNECTION, provider: 'dingtalk', status: 'active' }
  let currentTarget = target('fixture-recipient')
  let ledger: Record<string, unknown> | undefined
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^SET /u.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('FROM user_notification_endpoints')) return { rows: [{ ...endpoint }] }
    if (sql.includes("SET state = 'outcome_unknown'")) return { rows: [] }
    if (sql.includes('SELECT ceil(extract')) return { rows: [{ retry_after: 0 }] }
    if (sql.startsWith('SELECT') && sql.includes('FROM notification_test_sends')) return { rows: ledger ? [ledger] : [] }
    if (sql.startsWith('INSERT INTO notification_test_sends')) {
      ledger = { id: SEND_ID, state: 'pending', outcome_code: null }
      return { rows: [ledger] }
    }
    if (sql.includes("SET state = 'sending'")) {
      if (ledger?.state !== 'pending') return { rows: [] }
      ledger = { ...ledger, state: 'sending' }
      return { rows: [ledger] }
    }
    if (sql.includes('SET state = $2')) {
      if (!ledger || !(params[3] as string[]).includes(String(ledger.state))) return { rows: [] }
      ledger = { ...ledger, state: params[1], outcome_code: params[2] }
      return { rows: [ledger] }
    }
    throw new Error('unexpected fixture query')
  })
  const db: Db = { query }
  const verifyEndpoint = vi.fn(async (): Promise<ResolveResult> => ({ ok: true, target: currentTarget }))
  const unused = vi.fn(async () => { throw new Error('unexpected resolver method') })
  const resolver: RecipientResolver = {
    listCandidates: unused, resolveMany: unused, verifyEndpoints: unused, deriveDefaultTargets: unused,
    resolveForConnection: unused, verifyEndpoint, deriveDefaultTarget: unused,
  }
  const fetchAccessToken = vi.fn(async () => {
    // Change state at the token boundary, independently of how many endpoint reads occur.
    if (scenario === 'revoked-during-prepare') endpoint.status = 'revoked'
    if (scenario === 'rebound-during-prepare') currentTarget = target('fixture-other-recipient', 'changed-proof')
    return 'fixture-access-token'
  })
  const sendWorkNotification = vi.fn(async () => ({ taskId: 'fixture-task', raw: {} }))
  const adapter = new DingTalkWorkNotificationAdapter({
    normalizeBaseUrl: (value) => String(value ?? CONFIG.baseUrl),
    classifySendError: () => ({ ok: false, retryable: false, error: 'dingtalk_send_unclassified' }),
    readTuple: vi.fn(async (): Promise<DingTalkIntegrationScopedMessageTuple> => ({
      config: CONFIG, source: 'integration',
      integration: { id: CONNECTION, name: 'Fixture', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
      environment: { appKey: false, appSecret: false, agentId: false, baseUrl: false },
    })),
    fetchAccessToken, sendWorkNotification,
  })
  const service = createNotificationTestSendService({
    db,
    transaction: async (fn) => {
      if (scenario === 'revoked-before-admission') endpoint.status = 'revoked'
      return fn(db)
    },
    resolver, prepareBudgetMs: 5000,
    checkConnection: async () => ({ ok: true, witness: 'fixture-capability' }),
    isPreferencesEnabled: () => true, isDeliveryEnabled: () => true, adapter: () => adapter,
  })
  return { service, query, fetchAccessToken, sendWorkNotification, ledger: () => ledger }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network is forbidden in reverify tests') })))
afterEach(() => vi.unstubAllGlobals())

describe('notification test send reverify with the real adapter', () => {
  it('sends once and records acceptance when the endpoint stays unchanged', async () => {
    const h = harness('unchanged')
    expect(await h.service.send(INPUT)).toEqual({ outcome: 'accepted', code: 'accepted', testSendId: SEND_ID })
    expect(h.fetchAccessToken).toHaveBeenCalledOnce()
    expect(h.sendWorkNotification).toHaveBeenCalledOnce()
    expect(h.sendWorkNotification).toHaveBeenCalledWith('fixture-access-token', {
      userIds: ['fixture-recipient'], title: 'MetaSheet 通知测试', content: '这是一条测试通知，用于确认此渠道可用，无需操作。',
    }, CONFIG, expect.any(Object))
    expect(h.ledger()).toEqual({ id: SEND_ID, state: 'accepted', outcome_code: 'accepted' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['revoked-during-prepare', 'rebound-during-prepare'] as const)('refuses an endpoint that is %s without transport', async (scenario) => {
    const h = harness(scenario)
    const result = await h.service.send(INPUT)
    expect(h.fetchAccessToken).toHaveBeenCalledOnce()
    expect(h.sendWorkNotification).not.toHaveBeenCalled()
    expect(result).toEqual({ outcome: 'refused', code: 'routed_destination_changed', testSendId: SEND_ID })
    expect(h.ledger()).toEqual({ id: SEND_ID, state: 'refused', outcome_code: 'routed_destination_changed' })
    expect(h.query.mock.calls.some(([sql]) => sql.includes("SET state = 'sending'"))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects revocation after preflight before creating a ledger entry or preparing transport', async () => {
    const h = harness('revoked-before-admission')
    await expect(h.service.send(INPUT)).rejects.toMatchObject({
      status: 409, code: 'ENDPOINT_NOT_USABLE', details: { reason: 'endpoint_stale' },
    })
    expect(h.ledger()).toBeUndefined()
    expect(h.query.mock.calls.some(([sql]) => sql.includes('notification_test_sends'))).toBe(false)
    expect(h.fetchAccessToken).not.toHaveBeenCalled()
    expect(h.sendWorkNotification).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
