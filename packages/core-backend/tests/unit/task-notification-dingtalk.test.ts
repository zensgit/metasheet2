import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => {
    throw new Error('the channel under test must use its injected query')
  }),
  transaction: vi.fn(async () => {
    throw new Error('the channel under test must not open a transaction')
  }),
  pool: null,
}))

import { Logger } from '../../src/core/logger'
import {
  DingTalkBusinessError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
} from '../../src/integrations/dingtalk/client'
import { requestDingTalkTransportJson } from '../../src/integrations/dingtalk/transport'
import {
  classifyTaskDingTalkSendError,
  DingTalkTaskDeliveryChannel,
  normalizeTaskDingTalkBaseUrl,
  redactTaskDingTalkErrorText,
  TASK_DINGTALK_CHANNEL_CODES,
  TASK_DINGTALK_DEFAULT_BASE_URL,
  TASK_DINGTALK_ERROR_RAW_MAX_LENGTH,
} from '../../src/services/task-notification-dingtalk'
import type { TaskDeliveryPrepared, TaskDeliveryQuery } from '../../src/services/task-notification-delivery-worker'
import type { Row } from '../../src/services/task-records'
import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { TASK_DELIVERY_PREPARE_BUDGET_MS, TASK_DINGTALK_REQUEST_TIMEOUT_MS } from '../../src/tasks/task-delivery-protocol'
import type { TaskDeliveryMessage } from '../../src/tasks/task-notification-text'

/**
 * M4 PR-3b S6 (design task-m4-pr3b-backend-design-20261001.md §8, §11.7): the DingTalk channel on
 * a scripted directory and outbound doubles (no network). Pins the statement texts and binds, every
 * prepare branch and its fixed code, where the configuration comes from, the base URL rule, the
 * timeouts, the re-check after the token, the one send, the classification of what the send
 * throws, and the redaction of every error text the worker would store. The database behaviour,
 * with the worker, is tests/integration/task-m4-dingtalk.db.test.ts.
 */

const ORG = 'org_unit_dingtalk'
const USER = 'usr_unit_recipient'
const TARGET = { deliveryId: '6a1c2e3f-2222-4bbb-8ccc-0123456789ab', orgId: ORG, recipientUserId: USER }
const CONFIG = { appKey: 'appkey-X-123456', appSecret: 'secret-X-abcdef', workNotificationAgentId: '4001234567' }
const MESSAGE: TaskDeliveryMessage = { title: '任务动态', content: '任务「季度备料复核」已完成\n\n编号 6a1c2e3f' }
const codes = TASK_DINGTALK_CHANNEL_CODES

const ENV_KEYS = ['DINGTALK_APP_KEY', 'DINGTALK_APP_SECRET', 'DINGTALK_AGENT_ID', 'DINGTALK_BASE_URL', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

interface Recorded { sql: string; params: unknown[] }

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function identity(over: Partial<{ integration_id: string; external_user_id: string; integration_config: unknown }> = {}): Row {
  return { integration_id: 'int-X', external_user_id: 'dt-user-77', integration_config: CONFIG, ...over }
}

/** Identity reads answer from `identities` in turn (the last answer repeats); integration reads from `integrations`. */
function directory(script: { identities?: Row[][]; integrations?: Row[] } = {}): { query: TaskDeliveryQuery; log: Recorded[] } {
  const log: Recorded[] = []
  const answers = script.identities ?? [[identity()]]
  let call = 0
  const query: TaskDeliveryQuery = async (sql, params = []) => {
    const text = oneLine(sql)
    log.push({ sql: text, params })
    if (text.startsWith('SELECT i.id::text AS integration_id')) {
      const rows = answers[Math.min(call, answers.length - 1)]
      call += 1
      return { rows }
    }
    if (text.startsWith('SELECT status FROM directory_integrations')) return { rows: script.integrations ?? [] }
    throw new Error(`unexpected statement: ${text.slice(0, 80)}`)
  }
  return { query, log }
}

interface CallOptions { timeoutMs?: number; signal?: AbortSignal; logUpstreamMessage?: boolean }

interface Outbound {
  tokenCalls: Array<{ config: DingTalkMessageConfig; options: CallOptions | undefined }>
  sendCalls: Array<{ token: string; input: { userIds: string[]; title: string; content: string }; config: DingTalkMessageConfig; options: CallOptions | undefined }>
}

function channelWith(
  script: Parameters<typeof directory>[0] = {},
  outbound: { token?: () => Promise<string>; send?: () => Promise<{ taskId?: string; raw: Record<string, unknown> }>; onToken?: () => void } = {},
): { channel: DingTalkTaskDeliveryChannel; calls: Outbound; log: Recorded[] } {
  const { query, log } = directory(script)
  const calls: Outbound = { tokenCalls: [], sendCalls: [] }
  const channel = new DingTalkTaskDeliveryChannel({
    query,
    fetchAccessToken: async (config, options) => {
      calls.tokenCalls.push({ config: { ...config }, options })
      outbound.onToken?.()
      return outbound.token ? outbound.token() : 'token-T-998877'
    },
    sendWorkNotification: async (token, input, config, options) => {
      calls.sendCalls.push({ token, input: { ...input, userIds: [...input.userIds] }, config: { ...config }, options })
      return outbound.send ? outbound.send() : { taskId: '700001', raw: {} }
    },
  })
  return { channel, calls, log }
}

function ended(prepared: TaskDeliveryPrepared): unknown {
  expect(prepared.ok).toBe(false)
  return prepared.ok === false ? prepared.result : undefined
}

async function sendOnce(prepared: TaskDeliveryPrepared, message: TaskDeliveryMessage = MESSAGE): Promise<unknown> {
  expect(prepared.ok).toBe(true)
  if (prepared.ok !== true) return undefined
  return prepared.send(message)
}

function markedUnknown<T extends Error>(error: T): T {
  Object.defineProperty(error, 'outcomeUnknown', { value: true, enumerable: true, configurable: true })
  return error
}

// ── Statements ───────────────────────────────────────────────────────────────────────────────────

describe('the identity statements (design §8.2 step 1; ASSUMPTION(task-m4): [D4] [own-3b-18])', () => {
  it('the identity join is bound to the delivery row\'s org and the recipient; it is read twice around the token', async () => {
    const { channel, log, calls } = channelWith()
    await sendOnce(await channel.prepare(TARGET))
    const reads = log.filter((entry) => entry.sql.startsWith('SELECT i.id::text AS integration_id'))
    expect(reads).toHaveLength(2)
    expect(reads[0]).toEqual({
      sql: 'SELECT i.id::text AS integration_id, a.external_user_id, i.config AS integration_config FROM directory_account_links l '
        + "JOIN directory_accounts a ON a.id = l.directory_account_id AND a.provider = 'dingtalk' AND a.is_active = true "
        + "JOIN directory_integrations i ON i.id = a.integration_id AND i.provider = 'dingtalk' AND i.status = 'active' AND i.org_id = $2 "
        + "WHERE l.local_user_id = $1 AND l.link_status = 'linked' ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC LIMIT 2",
      params: [USER, ORG],
    })
    expect(reads[1]).toEqual(reads[0])
    expect(calls.tokenCalls).toHaveLength(1)
    expect(calls.sendCalls).toHaveLength(1)
  })

  it('no identity: the org\'s integration rows decide — none ⇒ missing, none active ⇒ inactive, an active one ⇒ not bound; all skipped, nothing requested', async () => {
    const cases: Array<[Row[], string]> = [
      [[], codes.orgIntegrationMissing],
      [[{ status: 'inactive' }, { status: 'paused' }], codes.orgIntegrationInactive],
      [[{ status: 'inactive' }, { status: 'active' }], codes.recipientNotBound],
    ]
    for (const [integrations, code] of cases) {
      const { channel, log, calls } = channelWith({ identities: [[]], integrations })
      expect(ended(await channel.prepare(TARGET)), code).toEqual({ ok: false, retryable: false, skip: true, error: code })
      expect(log.map((entry) => (entry.sql.startsWith('SELECT i.id::text AS integration_id') ? 'identity' : 'other'))).toEqual(['identity', 'other'])
      expect(log[1]).toEqual({ sql: "SELECT status FROM directory_integrations WHERE org_id = $1 AND provider = 'dingtalk'", params: [ORG] })
      expect(calls.tokenCalls).toEqual([])
    }
  })

  it('two identities ⇒ failed / ambiguous (not skipped); a blank DingTalk id ⇒ skipped / not bound', async () => {
    const two = channelWith({ identities: [[identity(), identity({ integration_id: 'int-Y', external_user_id: 'dt-user-88' })]] })
    expect(ended(await two.channel.prepare(TARGET))).toEqual({ ok: false, retryable: false, error: codes.recipientAmbiguous })
    const blank = channelWith({ identities: [[identity({ external_user_id: '   ' })]] })
    expect(ended(await blank.channel.prepare(TARGET))).toEqual({ ok: false, retryable: false, skip: true, error: codes.recipientNotBound })
    expect([...two.calls.tokenCalls, ...blank.calls.tokenCalls]).toEqual([])
  })
})

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

describe('the app configuration comes from the identity\'s integration row only (ASSUMPTION(task-m4): [own-3b-19])', () => {
  it('the token request and the send use that row\'s key, secret and agent id, not the process environment', async () => {
    process.env.DINGTALK_APP_KEY = 'appkey-ENV-Y'
    process.env.DINGTALK_APP_SECRET = 'secret-ENV-Y'
    process.env.DINGTALK_AGENT_ID = '9009009'
    process.env.DINGTALK_BASE_URL = 'https://env.dingtalk.com'
    const { channel, calls } = channelWith()
    await sendOnce(await channel.prepare(TARGET))
    const expected = { appKey: CONFIG.appKey, appSecret: CONFIG.appSecret, agentId: CONFIG.workNotificationAgentId, baseUrl: TASK_DINGTALK_DEFAULT_BASE_URL }
    expect(calls.tokenCalls[0].config).toEqual(expected)
    expect(calls.sendCalls[0].config).toEqual(expected)
  })

  it('reads agentId when workNotificationAgentId is absent, a JSON-text config, and encrypted secrets', async () => {
    const legacy = channelWith({ identities: [[identity({ integration_config: { appKey: 'k-1', appSecret: 's-1', agentId: '12345' } })]] })
    await sendOnce(await legacy.channel.prepare(TARGET))
    expect(legacy.calls.sendCalls[0].config).toMatchObject({ appKey: 'k-1', appSecret: 's-1', agentId: '12345' })
    const asText = channelWith({ identities: [[identity({ integration_config: JSON.stringify(CONFIG) })]] })
    await sendOnce(await asText.channel.prepare(TARGET))
    expect(asText.calls.sendCalls[0].config.appKey).toBe(CONFIG.appKey)
    const sealed = channelWith({
      identities: [[identity({ integration_config: { appKey: 'k-2', appSecret: encryptStoredSecretValue('s-2'), workNotificationAgentId: encryptStoredSecretValue('777') } })]],
    })
    await sendOnce(await sealed.channel.prepare(TARGET))
    expect(sealed.calls.sendCalls[0].config).toMatchObject({ appKey: 'k-2', appSecret: 's-2', agentId: '777' })
  })

  it('a missing key, secret or agent id, an agent id that is not numeric, or a config that is not an object ⇒ retrying / config_unavailable, no token request', async () => {
    const broken: unknown[] = [
      { appSecret: 's', workNotificationAgentId: '1' },
      { appKey: 'k', workNotificationAgentId: '1' },
      { appKey: 'k', appSecret: 's' },
      { appKey: 'k', appSecret: 's', workNotificationAgentId: 'agent-1' },
      '["k"]',
      'not json',
      null,
    ]
    for (const integration_config of broken) {
      const { channel, calls } = channelWith({ identities: [[identity({ integration_config })]] })
      expect(ended(await channel.prepare(TARGET)), JSON.stringify(integration_config)).toEqual({ ok: false, retryable: true, error: codes.configUnavailable })
      expect(calls.tokenCalls).toEqual([])
    }
  })
})

// ── Base URL ─────────────────────────────────────────────────────────────────────────────────────

describe('the outbound base URL (ASSUMPTION(task-m4): [own-3b-21]; design §8.2 step 3, §8.5)', () => {
  it('is normalised the way the client does it: blank ⇒ the default host, trimmed, no trailing slash', () => {
    expect(normalizeTaskDingTalkBaseUrl(undefined)).toBe('https://oapi.dingtalk.com')
    expect(normalizeTaskDingTalkBaseUrl('   ')).toBe('https://oapi.dingtalk.com')
    expect(normalizeTaskDingTalkBaseUrl(' https://oapi.dingtalk.com// ')).toBe('https://oapi.dingtalk.com')
    expect(normalizeTaskDingTalkBaseUrl('https://api.dingtalk.com/')).toBe('https://api.dingtalk.com')
  })

  it('a refused base URL ⇒ failed / base_url_rejected and nothing is requested; an allowed one reaches the token request and the send unchanged', async () => {
    for (const baseUrl of ['http://oapi.dingtalk.com', 'https://evil.example', 'https://oapi.dingtalk.com.example', 'https://user:pw@oapi.dingtalk.com', 'ftp://oapi.dingtalk.com']) {
      const { channel, calls } = channelWith({ identities: [[identity({ integration_config: { ...CONFIG, baseUrl } })]] })
      expect(ended(await channel.prepare(TARGET)), baseUrl).toEqual({ ok: false, retryable: false, error: codes.baseUrlRejected })
      expect(calls.tokenCalls).toEqual([])
      expect(calls.sendCalls).toEqual([])
    }
    for (const [baseUrl, used] of [[undefined, 'https://oapi.dingtalk.com'], ['', 'https://oapi.dingtalk.com'], [' https://oapi.dingtalk.com/ ', 'https://oapi.dingtalk.com'], ['https://gw.dingtalk.com', 'https://gw.dingtalk.com']] as const) {
      const { channel, calls } = channelWith({ identities: [[identity({ integration_config: { ...CONFIG, baseUrl } })]] })
      expect(await sendOnce(await channel.prepare(TARGET)), String(baseUrl)).toEqual({ ok: true })
      expect(calls.tokenCalls[0].config.baseUrl).toBe(used)
      expect(calls.sendCalls[0].config.baseUrl).toBe(used)
    }
  })
})

// ── Token, re-check, send ────────────────────────────────────────────────────────────────────────

describe('the token, the re-check after it and the one send (design §8.2 steps 4–6)', () => {
  it('the token request carries the request timeout and no signal; the prepare budget is a race the channel runs itself; the send carries the request timeout; neither call lets the transport log the upstream message', async () => {
    const timeouts = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { channel, calls } = channelWith()
      await sendOnce(await channel.prepare(TARGET))
      expect(calls.tokenCalls[0].options).toEqual({ timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })
      expect(timeouts).toHaveBeenCalledWith(TASK_DELIVERY_PREPARE_BUDGET_MS)
      expect(calls.sendCalls[0].options).toEqual({ timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false })
      expect(TASK_DINGTALK_REQUEST_TIMEOUT_MS).toBe(10_000)
      expect(TASK_DELIVERY_PREPARE_BUDGET_MS).toBe(12_000)
    } finally {
      timeouts.mockRestore()
    }
  })

  it('a token request that outlives the prepare budget ⇒ retrying / token_unavailable, no send, even when the request itself never settles', async () => {
    const controller = new AbortController()
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    try {
      const { channel, calls } = channelWith({}, { token: () => new Promise<string>(() => undefined) })
      const prepare = channel.prepare(TARGET)
      await vi.waitFor(() => expect(calls.tokenCalls).toHaveLength(1))
      controller.abort()
      expect(ended(await prepare)).toEqual({ ok: false, retryable: true, error: codes.tokenUnavailable })
      expect(calls.sendCalls).toEqual([])
    } finally {
      timeouts.mockRestore()
    }
  }, 2000)

  it('the transport: with logUpstreamMessage false the warn line for a rejected response carries the status and a fixed note, not the upstream message; by default it carries the message', async () => {
    const warns: string[] = []
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(((message: string) => { warns.push(message) }) as never)
    const fetchFn = (async () => new Response(JSON.stringify({ message: 'upstream-text-marker-77' }), { status: 403, headers: { 'content-type': 'application/json' } })) as typeof fetch
    try {
      for (const logUpstreamMessage of [false, undefined]) {
        warns.length = 0
        const request = { input: 'https://oapi.dingtalk.com/x', init: { method: 'GET' }, fallbackError: 'f', kind: 'send' as const, envelope: 'oapi' as const, fetchFn, logUpstreamMessage }
        await expect(requestDingTalkTransportJson(request)).rejects.toBeInstanceOf(DingTalkRequestError)
        expect(warns).toHaveLength(1)
        if (logUpstreamMessage === false) {
          expect(warns[0]).toBe('DingTalk request failed (403); the upstream message is not logged for this call')
        } else {
          expect(warns[0]).toBe('DingTalk request failed (403): upstream-text-marker-77')
        }
      }
      // The option reaches the transport through the client's send function.
      warns.length = 0
      const config = { appKey: 'k', appSecret: 's', agentId: '1', baseUrl: 'https://oapi.dingtalk.com' }
      await expect(sendDingTalkWorkNotification('tok', { userIds: ['u'], title: 't', content: 'c' }, config, { fetchFn, logUpstreamMessage: false }))
        .rejects.toBeInstanceOf(DingTalkRequestError)
      expect(warns).toEqual(['DingTalk request failed (403); the upstream message is not logged for this call'])
      // And through the client's token function (a fresh app key: nothing cached or in flight for it).
      warns.length = 0
      const tokenConfig = { ...config, appKey: `k-tokenlog-${Date.now().toString(36)}` }
      await expect(fetchDingTalkAppAccessToken(tokenConfig, { fetchFn, logUpstreamMessage: false })).rejects.toBeInstanceOf(DingTalkRequestError)
      expect(warns).toEqual(['DingTalk request failed (403); the upstream message is not logged for this call'])
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('a token that fails or comes back empty ⇒ retrying / token_unavailable with the code alone (its own text may carry the token URL)', async () => {
    const leaky = new Error('GET https://oapi.dingtalk.com/gettoken?appkey=appkey-X-123456&appsecret=secret-X-abcdef failed')
    for (const token of [async () => { throw leaky }, async () => '', async () => '   ']) {
      const { channel, calls } = channelWith({}, { token })
      expect(ended(await channel.prepare(TARGET))).toEqual({ ok: false, retryable: true, error: codes.tokenUnavailable })
      expect(calls.sendCalls).toEqual([])
    }
  })

  it('anything that changed between the two reads ⇒ retrying / destination_changed and no send', async () => {
    const changes: Row[][] = [
      [identity({ external_user_id: 'dt-user-other' })],
      [identity({ integration_id: 'int-Z' })],
      [identity({ integration_config: { ...CONFIG, appKey: 'appkey-new' } })],
      [identity({ integration_config: { ...CONFIG, appSecret: 'secret-new' } })],
      [identity({ integration_config: { ...CONFIG, workNotificationAgentId: '4009999999' } })],
      [identity({ integration_config: { ...CONFIG, baseUrl: 'https://gw.dingtalk.com' } })],
      [],
    ]
    for (const second of changes) {
      const { channel, calls } = channelWith({ identities: [[identity()], second], integrations: [{ status: 'active' }] })
      expect(ended(await channel.prepare(TARGET)), JSON.stringify(second)).toEqual({ ok: false, retryable: true, error: codes.destinationChanged })
      expect(calls.tokenCalls).toHaveLength(1)
      expect(calls.sendCalls).toEqual([])
    }
  })

  it('the closure sends once to the identity\'s DingTalk id with the title and content; a response without a task id ⇒ outcome unknown', async () => {
    const { channel, calls } = channelWith()
    const prepared = await channel.prepare(TARGET)
    expect(calls.sendCalls).toEqual([])
    expect(await sendOnce(prepared)).toEqual({ ok: true })
    expect(calls.sendCalls).toEqual([{
      token: 'token-T-998877',
      input: { userIds: ['dt-user-77'], title: MESSAGE.title, content: MESSAGE.content },
      config: { appKey: CONFIG.appKey, appSecret: CONFIG.appSecret, agentId: CONFIG.workNotificationAgentId, baseUrl: TASK_DINGTALK_DEFAULT_BASE_URL },
      options: { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false },
    }])
    for (const response of [{ raw: {} }, { taskId: '', raw: {} }, { taskId: '  ', raw: {} }]) {
      const empty = channelWith({}, { send: async () => response })
      expect(await sendOnce(await empty.channel.prepare(TARGET))).toEqual({ ok: false, retryable: false, outcomeUnknown: true, error: codes.sendResponseInvalid })
    }
  })
})

// ── Classification ───────────────────────────────────────────────────────────────────────────────

describe('what the send throws (design §8.4)', () => {
  it('outcome unknown first, then determinate rejections by status, errcode and text; anything else is outcome unknown', () => {
    const table: Array<[string, unknown, { retryable: boolean; outcomeUnknown?: true; code: string }]> = [
      ['timeout (marked)', markedUnknown(new DingTalkTimeoutError(10000)), { retryable: false, outcomeUnknown: true, code: codes.sendOutcomeUnknown }],
      ['5xx (marked)', markedUnknown(new DingTalkRequestError('upstream', 503, null)), { retryable: false, outcomeUnknown: true, code: codes.sendOutcomeUnknown }],
      ['malformed 2xx (marked)', markedUnknown(new DingTalkMalformedResponseError('unparseable_body', 200, 'send')), { retryable: false, outcomeUnknown: true, code: codes.sendOutcomeUnknown }],
      ['network error (marked)', markedUnknown(new TypeError('fetch failed')), { retryable: false, outcomeUnknown: true, code: codes.sendOutcomeUnknown }],
      ['429', new DingTalkRequestError('slow down', 429, null), { retryable: true, code: `${codes.sendRequestRejected}_429` }],
      ['408 (not marked)', new DingTalkRequestError('request timeout', 408, null), { retryable: true, code: `${codes.sendRequestRejected}_408` }],
      ['403', new DingTalkRequestError('forbidden', 403, null), { retryable: false, code: `${codes.sendRequestRejected}_403` }],
      ['404', new DingTalkRequestError('not found', 404, null), { retryable: false, code: `${codes.sendRequestRejected}_404` }],
      ['errcode 90018, neutral text', new DingTalkBusinessError('quota', { errcode: 90018, errmsg: 'quota' }), { retryable: true, code: `${codes.sendBusinessError}_90018` }],
      ['90018 under code, no errcode, neutral text', new DingTalkBusinessError('quota', { code: 90018, errmsg: 'quota' }), { retryable: true, code: `${codes.sendBusinessError}_90018` }],
      ['40035 under code, no errcode', new DingTalkBusinessError('invalid', { code: '40035', errmsg: 'invalid' }), { retryable: false, code: `${codes.sendBusinessError}_40035` }],
      ['errcode -1 as text', new DingTalkBusinessError('quota', { errcode: '-1', errmsg: 'x' }), { retryable: true, code: `${codes.sendBusinessError}_-1` }],
      ['errcode 40035, neutral text', new DingTalkBusinessError('invalid', { errcode: 40035, errmsg: 'invalid' }), { retryable: false, code: `${codes.sendBusinessError}_40035` }],
      ['errcode 33012, busy text', new DingTalkBusinessError('rejected', { errcode: 33012, errmsg: 'system busy' }), { retryable: true, code: `${codes.sendBusinessError}_33012` }],
      ['no errcode', new DingTalkBusinessError('rejected', null), { retryable: false, code: `${codes.sendBusinessError}_unknown` }],
      ['plain Error', new Error('x'), { retryable: false, outcomeUnknown: true, code: codes.sendUnclassified }],
      ['thrown string', 'boom', { retryable: false, outcomeUnknown: true, code: codes.sendUnclassified }],
    ]
    for (const [label, error, expected] of table) {
      const result = classifyTaskDingTalkSendError(error, []) as { ok: false; retryable: boolean; outcomeUnknown?: boolean; error: string }
      expect(result.ok, label).toBe(false)
      expect(result.retryable, label).toBe(expected.retryable)
      expect(result.outcomeUnknown, label).toBe(expected.outcomeUnknown)
      expect(result.error === expected.code || result.error.startsWith(`${expected.code}: `), `${label}: ${result.error}`).toBe(true)
    }
    expect((classifyTaskDingTalkSendError('boom', []) as { error: string }).error).toBe(codes.sendUnclassified)
  })

  it('through the closure: a thrown plain Error after the send started is outcome unknown, a 4xx is failed, 90018 is retrying', async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [new Error('socket hang up'), { retryable: false, outcomeUnknown: true }],
      [new DingTalkRequestError('bad request', 400, null), { retryable: false }],
      [new DingTalkBusinessError('quota', { errcode: 90018, errmsg: 'quota' }), { retryable: true }],
    ]
    for (const [error, expected] of cases) {
      const { channel } = channelWith({}, { send: async () => { throw error } })
      expect(await sendOnce(await channel.prepare(TARGET))).toMatchObject({ ok: false, ...expected })
    }
  })
})

// ── Redaction ────────────────────────────────────────────────────────────────────────────────────

describe('error text never carries a secret, a URL or user content (design §8.5)', () => {
  const secrets = [
    'token-T-998877', 'appkey-X-123456', 'secret-X-abcdef', '4001234567', 'dt-user-77', '任务动态', '季度备料复核', '任务「季度备料复核」已完成', 'oapi.dingtalk.com',
    'https://', 'access_token=', 'zzz-leaked-token', 'yyy-leaked-secret', 'gw.example.net',
  ]

  it('a send error whose message holds every one of them comes back with none of them, on one line, at most 240 characters after the code', async () => {
    const message = [
      'failed for token-T-998877 app appkey-X-123456 secret secret-X-abcdef agent 4001234567 user dt-user-77',
      'POST https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token=zzz-leaked-token',
      'appSecret: yyy-leaked-secret via gw.example.net:8443/path',
      'echo: 任务「季度备料复核」已完成 / 季度备料复核 / title 任务动态',
    ].join('\n')
    const { channel } = channelWith({}, { send: async () => { throw new DingTalkBusinessError(message, { errcode: 40035, errmsg: 'invalid' }) } })
    const result = await sendOnce(await channel.prepare(TARGET)) as { error: string }
    expect(result.error.startsWith(`${codes.sendBusinessError}_40035: `)).toBe(true)
    for (const secret of secrets) expect(result.error, secret).not.toContain(secret)
    expect(result.error).not.toMatch(/[\u0000-\u001f]/)
    expect(result.error.length).toBeLessThanOrEqual(`${codes.sendBusinessError}_40035: `.length + 240)
    expect(result.error).toContain('[redacted]')
  })

  it('redactTaskDingTalkErrorText: listed values, secret parameters and pairs, URLs and hosts, control characters, the 240-character cut', () => {
    expect(redactTaskDingTalkErrorText('a VALUE-1 b', ['VALUE-1'])).toBe('a [redacted] b')
    expect(redactTaskDingTalkErrorText('see https://h.example.com/x?y=1 now', [])).toBe('see [redacted-url] now')
    expect(redactTaskDingTalkErrorText('k appKey=abc123&x=1', [])).toBe('k appKey=[redacted]&x=1')
    expect(redactTaskDingTalkErrorText('line1\nline2\tend', [])).toBe('line1 line2 end')
    const long = redactTaskDingTalkErrorText('x'.repeat(500), [])
    expect(long).toHaveLength(240)
    expect(long.endsWith('...')).toBe(true)
  })

  it('user-info, IP-literal hosts and bare IPv4 are URLs; quoted JSON pairs and bearer tokens are secrets; C1 and Unicode format controls become spaces', () => {
    expect(redactTaskDingTalkErrorText('via https://user:p4ss@h.example.com/x done', [])).toBe('via [redacted-url] done')
    // Documentation-range addresses (TEST-NET-1 / TEST-NET-2), never a real host.
    expect(redactTaskDingTalkErrorText('proxy http://192.0.2.5:3128/ and peer 198.51.100.2 here', [])).toBe('proxy [redacted-url] and peer [redacted-url] here')
    expect(redactTaskDingTalkErrorText('{"access_token":"other-token-zzz","appsecret":"sec-zzz"}', [])).toBe('{"access_token":"[redacted]","appsecret":"[redacted]"}')
    expect(redactTaskDingTalkErrorText('Authorization: Bearer abc.DEF-123 end', [])).toBe('Authorization: Bearer [redacted] end')
    // One point from each range of the rule: C1, the separators, each bidi and zero-width range, the word joiner and invisible operators, the byte-order mark, C0.
    const controls = [0x85, 0x9b, 0x2028, 0x2029, 0x202a, 0x202e, 0x200b, 0x200c, 0x200f, 0x2060, 0x2064, 0xfeff, 0x1f].map((point) => String.fromCodePoint(point))
    expect(redactTaskDingTalkErrorText(`a${controls.join('')}b`, [])).toBe('a b')
    for (const control of controls) expect(redactTaskDingTalkErrorText(`x${control}y`, [])).toBe('x y')
  })

  it('the agent id the closure holds is removed from a send error that echoes it', async () => {
    const { channel } = channelWith({}, { send: async () => { throw new DingTalkBusinessError('agent 4001234567 rejected the send for agentid=4001234567', { errcode: 40035, errmsg: 'invalid' }) } })
    const result = await sendOnce(await channel.prepare(TARGET)) as { error: string }
    expect(result.error).toBe(`${codes.sendBusinessError}_40035: agent [redacted] rejected the send for agentid=[redacted]`)
  })

  it('the title is removed as a value of its own: an echo of the title alone leaves no residue', async () => {
    const { channel } = channelWith({}, { send: async () => { throw new DingTalkBusinessError('echo: 任务动态 here', { errcode: 40035, errmsg: 'invalid' }) } })
    const result = await sendOnce(await channel.prepare(TARGET)) as { error: string }
    expect(result.error).toBe(`${codes.sendBusinessError}_40035: echo: [redacted] here`)
  })

  it('neither cut lands between the halves of a surrogate pair: the output is well formed at the 240 cut and at the raw cut', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    // 236 code units, then an astral character whose high half would be the 237th code unit.
    const at240 = redactTaskDingTalkErrorText(`${'x'.repeat(236)}\u{1F600}${'y'.repeat(40)}`, [])
    expect(at240).not.toMatch(lone)
    expect(at240).toBe(`${'x'.repeat(236)}...`)
    expect(at240.length).toBeLessThanOrEqual(240)
    // 4095 code units of a listed value, then an astral character whose high half would be the 4096th code unit.
    const value = `S${'e'.repeat(4094)}`
    const atRaw = redactTaskDingTalkErrorText(`${value}\u{1F600}${'z'.repeat(20)}`, [value])
    expect(atRaw).not.toMatch(lone)
    expect(atRaw).toBe('[redacted]')
    // A cut that lands after a whole pair keeps it.
    const kept = redactTaskDingTalkErrorText(`${'x'.repeat(235)}\u{1F600}${'y'.repeat(40)}`, [])
    expect(kept).toBe(`${'x'.repeat(235)}\u{1F600}...`)
    expect(kept).not.toMatch(lone)
  })

  it('a two-character user value is removed; a title with 」 is removed as the whole content line the transport echoes; a value inside a longer one is removed by the longer one first', async () => {
    const twoChar: TaskDeliveryMessage = { title: '任务动态', content: '任务「报销」已完成\n\n编号 6a1c2e3f' }
    const short = channelWith({}, { send: async () => { throw new DingTalkBusinessError('rejected 报销 here', { errcode: 40035, errmsg: 'invalid' }) } })
    const shortResult = await sendOnce(await short.channel.prepare(TARGET), twoChar) as { error: string }
    expect(shortResult.error).not.toContain('报销')
    expect(shortResult.error).toContain('[redacted]')

    const nested: TaskDeliveryMessage = { title: '任务动态', content: '任务「报销A」B单」已完成\n\n编号 6a1c2e3f' }
    const line = channelWith({}, { send: async () => { throw new DingTalkBusinessError('echo: 任务「报销A」B单」已完成', { errcode: 40035, errmsg: 'invalid' }) } })
    const lineResult = await sendOnce(await line.channel.prepare(TARGET), nested) as { error: string }
    for (const residue of ['报销A', 'B单', '已完成']) expect(lineResult.error, residue).not.toContain(residue)

    // The recipient's DingTalk id is a substring of the title: the title goes first, whole.
    const overlapping = channelWith({ identities: [[identity({ external_user_id: '报销' })]] }, {
      send: async () => { throw new DingTalkBusinessError('echo: 报销单', { errcode: 40035, errmsg: 'invalid' }) },
    })
    const message: TaskDeliveryMessage = { title: '任务动态', content: '任务「报销单」已完成\n\n编号 6a1c2e3f' }
    const overlapResult = await sendOnce(await overlapping.channel.prepare(TARGET), message) as { error: string }
    expect(overlapResult.error).not.toContain('单')
    expect(overlapResult.error).not.toContain('报销')
    expect(overlapResult.error).toBe(`${codes.sendBusinessError}_40035: echo: [redacted]`)
  })

  it('the transport message is cut to the raw bound before anything else runs on it: no super-linear work on a long message, and a value the cut lands inside leaves no leading part behind', () => {
    expect(TASK_DINGTALK_ERROR_RAW_MAX_LENGTH).toBe(4096)
    const started = performance.now()
    const dotless = redactTaskDingTalkErrorText('a1-'.repeat(60_000), ['SECRET-VALUE'])
    expect(performance.now() - started).toBeLessThan(500)
    expect(dotless).toHaveLength(240)
    const line = 'A'.repeat(400)
    const raw = `${`${line}\n`.repeat(10)}${'z'.repeat(TASK_DINGTALK_ERROR_RAW_MAX_LENGTH - 4010 - 6)}SECRET-VALUE-tail`
    expect(raw.slice(0, TASK_DINGTALK_ERROR_RAW_MAX_LENGTH).endsWith('SECRET')).toBe(true)
    const out = redactTaskDingTalkErrorText(raw, [line, 'SECRET-VALUE-tail'])
    expect(out).not.toContain('SECRET')
    expect(out.startsWith('[redacted] [redacted]')).toBe(true)
    expect(out.endsWith('z')).toBe(true)
    // A whole value past the bound is simply gone with the rest of the message.
    expect(redactTaskDingTalkErrorText(`${'k'.repeat(5000)}SECRET-VALUE`, ['SECRET-VALUE'])).not.toContain('SECRET')
  })

  it('every error before the fence is one of the fixed codes, with nothing appended', async () => {
    const results: unknown[] = []
    results.push(ended(await channelWith({ identities: [[]], integrations: [] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[]], integrations: [{ status: 'inactive' }] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[]], integrations: [{ status: 'active' }] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[identity(), identity({ integration_id: 'int-Y' })]] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[identity({ integration_config: {} })]] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[identity({ integration_config: { ...CONFIG, baseUrl: 'https://evil.example' } })]] }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({}, { token: async () => { throw new Error('appsecret=secret-X-abcdef') } }).channel.prepare(TARGET)))
    results.push(ended(await channelWith({ identities: [[identity()], []], integrations: [{ status: 'active' }] }).channel.prepare(TARGET)))
    const fixed = new Set<string>(Object.values(codes))
    for (const result of results) {
      expect(fixed.has((result as { error: string }).error), JSON.stringify(result)).toBe(true)
    }
  })
})
