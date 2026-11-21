import { afterEach, describe, expect, it, vi } from 'vitest'

const pool = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: pool.query, transaction: vi.fn() }))
vi.mock('../../src/security/encrypted-secrets', () => ({ decryptStoredSecretValue: (value: string) => value }))

import '../../src/services/notification-adapter-bootstrap'
import { resolveNotificationAdapter } from '../../src/notifications/adapters/notification-adapter'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { notificationTupleFingerprint, readNotificationTupleFingerprint } from '../../src/integrations/dingtalk/notification-fingerprint'
import { normalizeTaskDingTalkBaseUrl, classifyTaskDingTalkSendError } from '../../src/services/task-notification-dingtalk'
import { metrics } from '../../src/metrics/metrics'

const id = '00000000-0000-4000-8000-000000000123'
const config = { appKey: 'fixture-app', appSecret: 'fixture-secret', agentId: '1234', baseUrl: 'https://oapi.dingtalk.com' }

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('notification production composition', () => {
  it('registers the implemented provider even with every switch off and reuses the exact channel functions', () => {
    vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'false')
    vi.stubEnv('EXTERNAL_NOTIFICATION_DELIVERY_ENABLED', 'false')
    const adapter = resolveNotificationAdapter('dingtalk')
    expect(adapter.transport).toBe('work_notification')
    expect(isCapabilityImplementationAvailable(adapter.provider, 'notification')).toBe(true)
    expect(resolveProviderCapabilityDescriptor(adapter.provider)?.governance.notification).toBe('gated')
    expect(adapter).toHaveProperty('normalizeBaseUrl', normalizeTaskDingTalkBaseUrl)
    expect(adapter).toHaveProperty('classifySendError', classifyTaskDingTalkSendError)
    for (const provider of ['local', 'wecom', 'feishu']) expect(() => resolveNotificationAdapter(provider)).toThrow()
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('runs the registered precondition against only the write client, with the actual shared tuple reader', async () => {
    vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'true')
    for (const key of ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_AGENT_ID', 'DINGTALK_BASE_URL', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_WORK_NOTIFICATION_AGENT_ID']) vi.stubEnv(key, '')
    const fingerprint = notificationTupleFingerprint(config)
    if (!fingerprint.ok) throw new Error('fixture fingerprint rejected')
    const client = { query: vi.fn(async (sql: string) => ({ rows: sql.includes('FROM directory_integrations')
      ? [{ id, name: 'fixture', status: 'active', corp_id: 'fixture-tenant', config: { ...config, workNotificationAgentId: config.agentId } }]
      : [{ provider: 'dingtalk', reached_level: 'token', tuple_fingerprint: fingerprint.value,
        bound_tenant: 'fixture-tenant', bound_app_scope: config.appKey,
        verified_at: new Date(), invalidated_at: null }], rowCount: 1 })) }
    const context = { integrationId: id, provider: 'dingtalk', orgId: 'default', scope: { tenant: 'fixture-tenant', appScope: config.appKey }, client }
    const precondition = resolveProviderCapabilityDescriptor('dingtalk')!.enablePreconditions!
    expect(await precondition('notification', context)).toEqual({ ok: true })
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(pool.query).not.toHaveBeenCalled()
    for (const [sql] of client.query.mock.calls) expect(sql).not.toMatch(/\bFOR\s+(SHARE|UPDATE)\b|\bLOCK TABLE\b|^\s*(INSERT|UPDATE)\b/i)
    client.query.mockClear()
    expect(await precondition('login', context)).toEqual({ ok: false, code: 'precondition_not_registered' })
    expect(client.query).not.toHaveBeenCalled()
  })

  it('does not read verification or credentials while notification preferences are off', async () => {
    vi.stubEnv('USER_NOTIFICATION_PREFERENCES_ENABLED', 'false')
    const client = { query: vi.fn() }
    const precondition = resolveProviderCapabilityDescriptor('dingtalk')!.enablePreconditions!
    expect(await precondition('notification', { integrationId: id, provider: 'dingtalk', orgId: 'default',
      scope: { tenant: 'fixture', appScope: 'fixture' }, client })).toEqual({ ok: false, code: 'verification_missing' })
    expect(client.query).not.toHaveBeenCalled()
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('propagates transaction failures without making a second query in the aborted transaction', async () => {
    const timeout = Object.assign(new Error('fixture timeout'), { code: '57014' })
    const client = { query: vi.fn().mockRejectedValue(timeout) }
    await expect(readNotificationTupleFingerprint(id, client)).rejects.toBe(timeout)
    expect(client.query).toHaveBeenCalledTimes(1)
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('shares normalized fingerprints with the registered adapter and binds every credential field', async () => {
    for (const key of ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_AGENT_ID', 'DINGTALK_BASE_URL', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_WORK_NOTIFICATION_AGENT_ID']) vi.stubEnv(key, '')
    pool.query.mockResolvedValue({ rows: [{ id, name: 'fixture', status: 'active', corp_id: 'fixture-tenant', config: { ...config, workNotificationAgentId: config.agentId } }] })
    expect(await resolveNotificationAdapter('dingtalk').fingerprint(id)).toEqual(notificationTupleFingerprint(config))
    expect(notificationTupleFingerprint({ ...config, baseUrl: ' https://oapi.dingtalk.com/// ' })).toEqual(notificationTupleFingerprint(config))
    for (const key of ['appKey', 'appSecret', 'agentId'] as const) {
      expect(notificationTupleFingerprint({ ...config, [key]: `${config[key]}1` })).not.toEqual(notificationTupleFingerprint(config))
    }
    expect(notificationTupleFingerprint({ ...config, baseUrl: 'https://example.invalid' })).toEqual({ ok: false, code: 'routed_base_url_rejected' })
  })

  it('exposes only the five fixed outcome labels, including zero-traffic startup', async () => {
    const result = await metrics.notificationTestSendsTotal.get()
    expect(result.name).toBe('notification_test_sends_total')
    expect(result.values.map((value) => value.labels)).toEqual(
      ['accepted', 'failed', 'outcome_unknown', 'refused', 'rate_limited'].map((outcome) => ({ outcome })),
    )
    expect(result.values.every((value) => value.value === 0)).toBe(true)
  })
})
