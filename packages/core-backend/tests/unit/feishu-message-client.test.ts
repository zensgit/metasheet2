/**
 * The Feishu message client: the request it writes, where a failure is reported to have arisen, the one
 * replay after a refused token, and the send tier's rule that a request is never repeated.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FEISHU_ENDPOINTS, feishuEndpointUrl } from '../../src/integrations/feishu/endpoints'
import {
  FeishuBusinessError,
  FeishuRequestError,
  FeishuTimeoutError,
  isFeishuOutcomeUnknown,
} from '../../src/integrations/feishu/errors'
import {
  FEISHU_MESSAGE_RECEIVE_ID_TYPE,
  sendFeishuTextMessage,
  type FeishuMessageClientOptions,
  type FeishuTextMessageRequest,
} from '../../src/integrations/feishu/message-client'
import {
  APP_ID,
  APP_SECRET_PLAIN,
  CONNECTION_ID,
  MESSAGE_ID,
  MINT_ROUTE,
  OPEN_ID,
  SEND_ROUTE,
  acceptedStep,
  createSendHarness,
  refusedStep,
  type SendHarness,
} from '../helpers/feishu-send-harness'

let h: SendHarness

beforeEach(async () => {
  h = await createSendHarness()
})

afterEach(async () => {
  await h.close()
  expect(h.guard.violations).toEqual([])
  expect(h.server.unscripted).toEqual([])
})

const request = (overrides: Partial<FeishuTextMessageRequest> = {}): FeishuTextMessageRequest => ({
  credentials: { connectionId: CONNECTION_ID, appId: APP_ID, appSecret: APP_SECRET_PLAIN, brand: 'feishu' },
  receiveId: OPEN_ID,
  text: 'client text',
  uuid: 'ms2-client-fixed-uuid',
  ...overrides,
})

/** A token layer that hands a fixed token to the call and does nothing else. */
const fixedToken = (token = 't-fx-token-direct-0001'): FeishuMessageClientOptions['tokens'] => ({
  withTenantToken: (_credentials, call) => call(token),
})

const options = (overrides: Partial<FeishuMessageClientOptions> = {}): FeishuMessageClientOptions => ({
  tokens: fixedToken(),
  transport: { timeoutMs: 400, sleep: async () => false, random: () => 0 },
  ...overrides,
})

describe('the send endpoint', () => {
  it('is the frozen open-api messages path and takes the recipient id type as a query value', () => {
    expect(Object.isFrozen(FEISHU_ENDPOINTS.sendMessage)).toBe(true)
    expect(FEISHU_ENDPOINTS.sendMessage).toEqual({ role: 'openApi', path: '/open-apis/im/v1/messages' })
    expect(FEISHU_MESSAGE_RECEIVE_ID_TYPE).toBe('open_id')
    const url = new URL(feishuEndpointUrl('feishu', FEISHU_ENDPOINTS.sendMessage, { receive_id_type: FEISHU_MESSAGE_RECEIVE_ID_TYPE }))
    expect(url.pathname).toBe('/open-apis/im/v1/messages')
    expect(url.searchParams.get('receive_id_type')).toBe('open_id')
  })
})

describe('the request', () => {
  it('posts the text as a JSON string inside a JSON body, with the bearer token, on the send tier without following redirects', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} })
      return fetch(input, init)
    }) as typeof fetch
    const result = await sendFeishuTextMessage(options({ fetchFn }), request())
    expect(result).toEqual({ ok: true, messageId: MESSAGE_ID })
    expect(seen).toHaveLength(1)
    const headers = seen[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer t-fx-token-direct-0001')
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(seen[0].init.redirect).toBe('manual')
    expect(seen[0].init.method).toBe('POST')
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      receive_id: OPEN_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: 'client text' }),
      uuid: 'ms2-client-fixed-uuid',
    })
    expect(h.sendRequests()[0].query).toEqual({ receive_id_type: 'open_id' })
  })

  it('reports no message id when the acceptance carries none that is usable', async () => {
    h.server.script(SEND_ROUTE, [
      { kind: 'json', body: { code: 0 } },
      { kind: 'json', body: { code: 0, data: { message_id: '' } } },
      { kind: 'json', body: { code: 0, data: [] } },
    ])
    for (let index = 0; index < 3; index += 1) {
      expect(await sendFeishuTextMessage(options(), request())).toEqual({ ok: true, messageId: null })
    }
  })
})

describe('where a failure arose', () => {
  it('a failure of the send request is handed back unchanged and marked as the send phase', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(230013)])
    const result = await sendFeishuTextMessage(options(), request())
    expect(result.ok).toBe(false)
    if (result.ok === false && result.phase !== 'aborted') {
      expect(result.phase).toBe('send')
      expect(result.error).toBeInstanceOf(FeishuBusinessError)
      expect((result.error as FeishuBusinessError).code).toBe(230013)
    } else {
      throw new Error('expected a failure of the send phase')
    }
  })

  it('a failure while the token is obtained is the token phase and no request was made', async () => {
    const failure = new Error('token layer failed')
    const result = await sendFeishuTextMessage(
      options({
        tokens: {
          withTenantToken: async () => {
            throw failure
          },
        },
      }),
      request(),
    )
    expect(result).toEqual({ ok: false, phase: 'token', error: failure })
    expect(h.server.count()).toBe(0)
  })

  it('the single replay after a refused token sends the same bytes; the replay answer is the answer', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(99991663), acceptedStep()])
    const result = await sendFeishuTextMessage(options({ tokens: h.tokens }), request())
    expect(result).toEqual({ ok: true, messageId: MESSAGE_ID })
    expect(h.server.requests.map((entry) => entry.route)).toEqual([MINT_ROUTE, SEND_ROUTE, MINT_ROUTE, SEND_ROUTE])
    expect(h.sendRequests()[0].body).toBe(h.sendRequests()[1].body)
  })

  it('a refusal of the replay is the send phase; a failed re-mint is the token phase', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(99991663), refusedStep(99991663)])
    const refused = await sendFeishuTextMessage(options({ tokens: h.tokens }), request())
    expect(refused).toMatchObject({ ok: false, phase: 'send' })
    expect(h.sendRequests()).toHaveLength(2)

    h.server.script(SEND_ROUTE, [refusedStep(99991663)])
    h.server.script(MINT_ROUTE, [{ kind: 'json', status: 400, body: { code: 10003 } }])
    const remint = await sendFeishuTextMessage(options({ tokens: h.tokens }), request({ credentials: { connectionId: 'conn-fx-9', appId: 'cli_fx_9', appSecret: 'secret-9' } }))
    expect(remint).toMatchObject({ ok: false, phase: 'token' })
  })
})

describe('abort', () => {
  it('a signal that aborted before the send request ends without any request', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await sendFeishuTextMessage(options({ signal: controller.signal }), request())).toEqual({ ok: false, phase: 'aborted' })
    expect(h.server.count()).toBe(0)
  })

  it('a signal that aborts after a refused request leaves that refusal as the answer; no second request is made', async () => {
    const controller = new AbortController()
    h.server.script(SEND_ROUTE, [refusedStep(99991663), acceptedStep()])
    const tokens: FeishuMessageClientOptions['tokens'] = {
      withTenantToken: async (_credentials, call) => {
        try {
          return await call('t-fx-token-a')
        } catch (error) {
          controller.abort()
          return await call('t-fx-token-b')
        }
      },
    }
    const result = await sendFeishuTextMessage(options({ tokens, signal: controller.signal }), request())
    expect(result).toMatchObject({ ok: false, phase: 'send' })
    expect(h.sendRequests()).toHaveLength(1)
  })
})

describe('the send tier never repeats a request', () => {
  it.each([
    ['a reset connection', { kind: 'reset' }],
    ['HTTP 500', { kind: 'json', status: 500, body: { code: 0 } }],
    ['HTTP 429', { kind: 'json', status: 429, body: { code: 0 }, headers: { 'x-ogw-ratelimit-reset': '1' } }],
    ['the flow-control code', refusedStep(99991400)],
    ['an answer that does not come', { kind: 'hang' }],
  ] as const)('%s: one request and no wait', async (_name, step) => {
    h.server.script(SEND_ROUTE, [step, acceptedStep()])
    const result = await sendFeishuTextMessage(options(), request())
    expect(result).toMatchObject({ ok: false, phase: 'send' })
    expect(h.sendRequests()).toHaveLength(1)
    expect(h.transportSleeps).toEqual([])
  })

  it('marks an answer that may have been processed as unknown, and a refusal or rate limit as not unknown', async () => {
    const errorOf = async (step: Parameters<SendHarness['server']['script']>[1][number]): Promise<unknown> => {
      h.server.script(SEND_ROUTE, [step])
      const result = await sendFeishuTextMessage(options(), request())
      return result.ok === false && result.phase === 'send' ? result.error : undefined
    }
    const timeout = await errorOf({ kind: 'hang' })
    expect(timeout).toBeInstanceOf(FeishuTimeoutError)
    expect(isFeishuOutcomeUnknown(timeout)).toBe(true)
    const serverError = await errorOf({ kind: 'json', status: 503, body: {} })
    expect(serverError).toBeInstanceOf(FeishuRequestError)
    expect(isFeishuOutcomeUnknown(serverError)).toBe(true)
    expect(isFeishuOutcomeUnknown(await errorOf(refusedStep(230013)))).toBe(false)
    expect(isFeishuOutcomeUnknown(await errorOf({ kind: 'json', status: 429, body: {} }))).toBe(false)
  })
})
