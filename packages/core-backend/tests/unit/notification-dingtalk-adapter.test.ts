import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({ query: vi.fn(() => { throw new Error('no database in adapter tests') }), pool: null }))

import {
  DingTalkBusinessError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  type DingTalkMessageConfig,
} from '../../src/integrations/dingtalk/client'
import { DingTalkMessageConfigError, type DingTalkMessageConfigErrorCode } from '../../src/integrations/dingtalk/config-validation-error'
import type { DingTalkIntegrationScopedMessageTuple } from '../../src/integrations/dingtalk/work-notification-settings'
import {
  DingTalkWorkNotificationAdapter,
  type DingTalkWorkNotificationAdapterOptions,
} from '../../src/notifications/adapters/dingtalk-work-notification-adapter'
import type { AdapterPrepareContext } from '../../src/notifications/adapters/notification-adapter'
import { ProtectedAddress, type ResolvedTarget } from '../../src/notifications/recipient-resolver'
import { sha256Hex } from '../../src/notifications/witness'
import {
  classifyTaskDingTalkSendError,
  normalizeTaskDingTalkBaseUrl,
} from '../../src/services/task-notification-dingtalk'
import { TASK_DINGTALK_REQUEST_TIMEOUT_MS } from '../../src/tasks/task-delivery-protocol'

const CONNECTION = '00000000-0000-4000-8000-000000000001'
const CONFIG = { appKey: 'fixture-app-key', appSecret: 'fixture-secret', agentId: '900000001' }
const MESSAGE = { title: 'Fixture title', content: 'Fixture first line\nFixture 「quoted text」' }
const TOKEN = 'fixture-access-token'
const ADDRESS = 'fixture-recipient'

function target(overrides: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return {
    connectionId: CONNECTION, provider: 'dingtalk', transport: 'work_notification', addressKind: 'dingtalk_userid',
    proofKind: 'directory_link', proofId: 'proof-fixture', proofWitness: 'proof-witness',
    addressWitness: 'address-witness', tenantAddressWitness: 'tenant-witness',
    boundTenant: 'fixture-tenant', boundAppScope: 'fixture-scope', address: new ProtectedAddress(ADDRESS),
    ...overrides,
  }
}

function tuple(config: DingTalkMessageConfig = CONFIG): DingTalkIntegrationScopedMessageTuple {
  return {
    config, source: 'integration',
    integration: { id: CONNECTION, name: 'Fixture', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
    environment: { appKey: false, appSecret: false, agentId: false, baseUrl: false },
  }
}

function setup(overrides: Partial<DingTalkWorkNotificationAdapterOptions> = {}) {
  const readTuple = vi.fn(async (_connectionId: string) => tuple())
  const fetchAccessToken = vi.fn(async () => TOKEN)
  const sendWorkNotification = vi.fn(async () => ({ taskId: 'fixture-task', raw: {} }))
  const options = {
    readTuple, fetchAccessToken, sendWorkNotification,
    normalizeBaseUrl: normalizeTaskDingTalkBaseUrl, classifySendError: classifyTaskDingTalkSendError,
    ...overrides,
  }
  const adapter = new DingTalkWorkNotificationAdapter(options)
  const context: AdapterPrepareContext = {
    connectionId: CONNECTION, target: target(), reverify: vi.fn(async () => ({ ok: true, target: target() })),
    budgetMs: 12_000, dedupeHint: 'fixture-dedupe',
  }
  return { adapter, context, readTuple, fetchAccessToken, sendWorkNotification }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network is forbidden in adapter tests') })))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('DingTalk notification adapter', () => {
  it.each([undefined, '', '  ', 'https://oapi.dingtalk.com/', '  https://oapi.dingtalk.com///  '])('normalizes base URL %j for both requests', async (baseUrl) => {
    const { adapter, context, readTuple, fetchAccessToken, sendWorkNotification } = setup()
    readTuple.mockResolvedValue(tuple({ ...CONFIG, baseUrl }))
    const prepared = await adapter.prepare(context)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected prepared')
    expect(await prepared.send(MESSAGE)).toEqual({ ok: true })
    const normalized = { ...CONFIG, baseUrl: 'https://oapi.dingtalk.com' }
    const options = { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false }
    expect(readTuple.mock.calls).toEqual([[CONNECTION], [CONNECTION]])
    expect(fetchAccessToken).toHaveBeenCalledOnce()
    expect(fetchAccessToken).toHaveBeenCalledWith(normalized, options)
    expect(sendWorkNotification).toHaveBeenCalledOnce()
    expect(sendWorkNotification).toHaveBeenCalledWith(TOKEN, {
      userIds: [ADDRESS], title: MESSAGE.title, content: MESSAGE.content,
    }, normalized, options)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['https://example.test', 'https://user:pass@oapi.dingtalk.com', 'http://oapi.dingtalk.com'])('rejects unsafe base URL %s before any request', async (baseUrl) => {
    const { adapter, context, readTuple, fetchAccessToken, sendWorkNotification } = setup()
    readTuple.mockResolvedValue(tuple({ ...CONFIG, baseUrl }))
    expect(await adapter.prepare(context)).toEqual({ ok: false, retryable: false, code: 'routed_base_url_rejected' })
    expect(fetchAccessToken).not.toHaveBeenCalled()
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('uses the same classifier and normalizer references as the legacy channel', () => {
    const { adapter } = setup()
    expect(adapter['classifySendError']).toBe(classifyTaskDingTalkSendError)
    expect(adapter['normalizeBaseUrl']).toBe(normalizeTaskDingTalkBaseUrl)
  })

  it.each([
    ['integration_not_found', 'routed_target_capability_unavailable', false],
    ['integration_inactive', 'routed_target_capability_unavailable', false],
    ['integration_tuple_incomplete', 'routed_credentials_unavailable', true],
    ['env_agent_id_invalid', 'routed_credentials_unavailable', true],
  ] as const)('maps credential-reader %s to its fixed code', async (sourceCode: DingTalkMessageConfigErrorCode, code, retryable) => {
    const { adapter, context, readTuple, fetchAccessToken } = setup()
    readTuple.mockRejectedValue(new DingTalkMessageConfigError(sourceCode, 'fixture detail'))
    expect(await adapter.prepare(context)).toEqual({ ok: false, retryable, code, ...(!retryable ? { skip: true } : {}) })
    expect(fetchAccessToken).not.toHaveBeenCalled()
  })

  it('drops unknown credential-read and token-failure details', async () => {
    const first = setup()
    first.readTuple.mockRejectedValue(new Error(CONFIG.appSecret))
    expect(await first.adapter.prepare(first.context)).toEqual({ ok: false, retryable: true, code: 'routed_credentials_unavailable' })
    const second = setup()
    second.fetchAccessToken.mockRejectedValue(new Error(`${TOKEN} ${CONFIG.appSecret}`))
    expect(await second.adapter.prepare(second.context)).toEqual({ ok: false, retryable: true, code: 'routed_credentials_unavailable' })
  })

  it('bounds a shared token request without calling reverify or send after budget expiry', async () => {
    vi.useFakeTimers()
    const { adapter, context, fetchAccessToken, sendWorkNotification } = setup()
    fetchAccessToken.mockImplementation(() => new Promise(() => {}))
    const pending = adapter.prepare({ ...context, budgetMs: 25 })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toEqual({ ok: false, retryable: true, code: 'routed_credentials_unavailable' })
    expect(context.reverify).not.toHaveBeenCalled()
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it('does not fetch a token when the prepare budget has already expired', async () => {
    const { adapter, context, fetchAccessToken } = setup()
    expect(await adapter.prepare({ ...context, budgetMs: 0 })).toEqual({ ok: false, retryable: true, code: 'routed_credentials_unavailable' })
    expect(fetchAccessToken).not.toHaveBeenCalled()
  })

  it('rejects an empty token', async () => {
    const { adapter, context, fetchAccessToken } = setup()
    fetchAccessToken.mockResolvedValue(' ')
    expect(await adapter.prepare(context)).toEqual({ ok: false, retryable: true, code: 'routed_credentials_unavailable' })
  })

  it.each(['appKey', 'appSecret', 'agentId', 'baseUrl'] as const)('rechecks credential field %s after acquiring the token', async (field) => {
    const { adapter, context, readTuple, sendWorkNotification } = setup()
    readTuple.mockResolvedValueOnce(tuple()).mockResolvedValueOnce(tuple({ ...CONFIG, [field]: 'changed-fixture' }))
    expect(await adapter.prepare(context)).toEqual({ ok: false, retryable: true, code: 'routed_destination_changed' })
    expect(context.reverify).toHaveBeenCalledOnce()
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it.each([
    'connectionId', 'provider', 'transport', 'addressKind', 'proofKind', 'proofId', 'proofWitness',
    'addressWitness', 'tenantAddressWitness', 'boundTenant', 'boundAppScope',
  ] as const)('rechecks target field %s after acquiring the token', async (field) => {
    const { adapter, context } = setup()
    const reverify = vi.fn(async () => ({ ok: true as const, target: target({ [field]: 'changed-fixture' } as Partial<ResolvedTarget>) }))
    expect(await adapter.prepare({ ...context, reverify })).toEqual({ ok: false, retryable: true, code: 'routed_destination_changed' })
  })

  it('rechecks the protected recipient address and rejects failed proof revalidation', async () => {
    const { adapter, context } = setup()
    expect(await adapter.prepare({ ...context, reverify: async () => ({ ok: true, target: target({ address: new ProtectedAddress('other') }) }) }))
      .toEqual({ ok: false, retryable: true, code: 'routed_destination_changed' })
    expect(await adapter.prepare({ ...context, reverify: async () => ({ ok: false, code: 'proof_missing' }) }))
      .toEqual({ ok: false, retryable: true, code: 'routed_destination_changed' })
  })

  it('normalizes the second credential read before comparison', async () => {
    const { adapter, context, readTuple } = setup()
    readTuple.mockResolvedValueOnce(tuple()).mockResolvedValueOnce(tuple({ ...CONFIG, baseUrl: ' https://oapi.dingtalk.com/// ' }))
    expect((await adapter.prepare(context)).ok).toBe(true)
  })

  it('does not resolve a blank or mismatched connection id through a preferred-row fallback', async () => {
    const { adapter, context, readTuple } = setup()
    expect((await adapter.prepare({ ...context, connectionId: ' ' })).ok).toBe(false)
    expect((await adapter.prepare({ ...context, connectionId: 'other' })).ok).toBe(false)
    expect(readTuple).not.toHaveBeenCalled()
  })

  it.each([undefined, '', '  '])('treats taskId %j as unknown, never accepted', async (taskId) => {
    const { adapter, context, sendWorkNotification } = setup()
    sendWorkNotification.mockResolvedValue({ taskId: taskId as string, raw: {} })
    const prepared = await adapter.prepare(context)
    if (!prepared.ok) throw new Error('expected prepared')
    expect(await prepared.send(MESSAGE)).toEqual({ ok: false, retryable: false, outcomeUnknown: true, code: 'dingtalk_send_response_invalid' })
  })

  it.each([
    [new DingTalkRequestError('fixture detail', 403, null), 'dingtalk_request_403', false],
    [new DingTalkRequestError('fixture detail', 429, null), 'dingtalk_request_429', true],
    [new DingTalkBusinessError('fixture detail', { errcode: -1 }), 'dingtalk_business_error_-1', true],
    [new DingTalkBusinessError('fixture detail', { errcode: 1.5 }), 'dingtalk_business_error_1.5', false],
    [new DingTalkBusinessError('fixture detail', { errcode: 'unknown' }), 'dingtalk_business_error_unknown', false],
    [new Error('fixture detail'), 'dingtalk_send_unclassified', false],
    [Object.assign(new DingTalkTimeoutError(10_000), { outcomeUnknown: true }), 'dingtalk_send_outcome_unknown', false],
  ] as const)('uses the existing classification and stores only %s', async (error, code, retryable) => {
    const { adapter, context, sendWorkNotification } = setup()
    sendWorkNotification.mockRejectedValue(error)
    const prepared = await adapter.prepare(context)
    if (!prepared.ok) throw new Error('expected prepared')
    const result = await prepared.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable, code })
    expect(JSON.stringify(result)).not.toContain('fixture detail')
    expect(result.ok ? null : result.code).toBe(code)
  })

  it('supplies all held values, content lines and quoted fragments to the shared redactor', async () => {
    const classify = vi.fn(classifyTaskDingTalkSendError)
    const { adapter, context, sendWorkNotification } = setup({ classifySendError: classify })
    const secretText = [TOKEN, CONFIG.appKey, CONFIG.appSecret, CONFIG.agentId, ADDRESS, MESSAGE.title, MESSAGE.content, 'quoted text']
    sendWorkNotification.mockRejectedValue(new DingTalkBusinessError(secretText.join(' '), { errcode: 40035 }))
    const prepared = await adapter.prepare(context)
    if (!prepared.ok) throw new Error('expected prepared')
    const result = await prepared.send(MESSAGE)
    expect(classify).toHaveBeenCalledOnce()
    expect(classify.mock.calls[0][1]).toEqual(expect.arrayContaining([...secretText, ...MESSAGE.content.split('\n')]))
    const classified = classify.mock.results[0].value
    for (const value of secretText) {
      expect(JSON.stringify(classified)).not.toContain(value)
      expect(JSON.stringify(result)).not.toContain(value)
    }
    expect(result).toEqual({ ok: false, retryable: false, code: 'dingtalk_business_error_40035' })
  })

  it.each(['unapproved_code: fixture-secret', 'dingtalk_request_99: fixture-secret', 'dingtalk_business_error_infinity'])('replaces out-of-contract classifier output %s with unknown', async (code) => {
    const { adapter, context, sendWorkNotification } = setup({ classifySendError: () => ({ ok: false, retryable: true, error: code }) })
    sendWorkNotification.mockRejectedValue(new Error('fixture'))
    const prepared = await adapter.prepare(context)
    if (!prepared.ok) throw new Error('expected prepared')
    expect(await prepared.send(MESSAGE)).toEqual({ ok: false, retryable: false, outcomeUnknown: true, code: 'routed_send_unclassified' })
  })

  it.each([64, 65])('bounds a business error code of length %i to the ledger contract', async (length) => {
    const prefix = 'dingtalk_business_error_'
    const code = prefix + '9'.repeat(length - prefix.length)
    const { adapter, context, sendWorkNotification } = setup({ classifySendError: () => ({ ok: false, retryable: true, error: code }) })
    sendWorkNotification.mockRejectedValue(new Error('fixture'))
    const prepared = await adapter.prepare(context)
    if (!prepared.ok) throw new Error('expected prepared')
    expect(await prepared.send(MESSAGE)).toEqual(length === 64
      ? { ok: false, retryable: true, code }
      : { ok: false, retryable: false, outcomeUnknown: true, code: 'routed_send_unclassified' })
  })
})

describe('DingTalk notification credential fingerprint', () => {
  it('hashes the normalized effective tuple from the connection-scoped reader without transport requests', async () => {
    const { adapter, readTuple, fetchAccessToken, sendWorkNotification } = setup()
    expect(await adapter.fingerprint(CONNECTION)).toEqual({
      ok: true,
      value: sha256Hex('mx.notif.tuple.v1', {
        provider: 'dingtalk', appKey: CONFIG.appKey, secret: CONFIG.appSecret,
        agentId: CONFIG.agentId, baseUrl: 'https://oapi.dingtalk.com',
      }),
    })
    expect(readTuple).toHaveBeenCalledOnce()
    expect(readTuple).toHaveBeenCalledWith(CONNECTION)
    expect(fetchAccessToken).not.toHaveBeenCalled()
    expect(sendWorkNotification).not.toHaveBeenCalled()
  })

  it.each(['appKey', 'appSecret', 'agentId', 'baseUrl'] as const)('changes when effective %s changes', async (field) => {
    const { adapter, readTuple } = setup()
    const before = await adapter.fingerprint(CONNECTION)
    readTuple.mockResolvedValue(tuple({ ...CONFIG, [field]: field === 'baseUrl' ? 'https://api.dingtalk.com' : 'changed-fixture' }))
    expect(await adapter.fingerprint(CONNECTION)).not.toEqual(before)
  })

  it('returns fixed errors, not credential read details, and refuses blank connections', async () => {
    const { adapter, readTuple } = setup()
    readTuple.mockRejectedValue(new Error(CONFIG.appSecret))
    expect(await adapter.fingerprint(CONNECTION)).toEqual({ ok: false, code: 'routed_credentials_unavailable', failureKind: 'read_failed' })
    readTuple.mockClear()
    expect(await adapter.fingerprint(' ')).toEqual({ ok: false, code: 'routed_credentials_unavailable' })
    expect(readTuple).not.toHaveBeenCalled()
  })
})

it.each(['integration_tuple_incomplete', 'integration_inactive', 'integration_not_found', 'env_agent_id_invalid'] as const)
  ('fingerprint keeps deterministic configuration error %s distinct from read failures', async code => {
    const { adapter, readTuple } = setup()
    readTuple.mockRejectedValue(new DingTalkMessageConfigError(code, 'Synthetic configuration unavailable'))
    const result = await adapter.fingerprint(CONNECTION)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('failureKind')
  })
