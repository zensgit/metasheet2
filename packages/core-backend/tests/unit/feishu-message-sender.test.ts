/**
 * The Feishu send core against a local server: local gates, request shape, classification of every
 * answer, one request per send, the single replay after a refused token, and the de-duplication key.
 * Time and waits are injected; nothing leaves the loopback.
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FEISHU_NOT_ATTEMPTED_REASONS,
  FEISHU_REJECT_REASONS,
  FEISHU_RETRYABLE_REJECT_REASONS,
  FEISHU_TEXT_MAX_UTF16_UNITS,
  FEISHU_UNKNOWN_REASONS,
  buildFeishuMessageUuid,
  classifyFeishuSend,
  feishuEndpointRefOf,
  truncateFeishuText,
  type FeishuSendOutcome,
} from '../../src/services/feishu-message-sender'
import {
  CONNECTION_ID,
  EFFECTIVE,
  MESSAGE_ID,
  MINT_ROUTE,
  OPEN_ID,
  OPEN_ID_2,
  OTHER_CONNECTION_ID,
  SEND_ROUTE,
  TENANT,
  acceptedStep,
  connectionRow,
  createSendHarness,
  endpointFor,
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

const outcomeJson = (outcome: FeishuSendOutcome): string => JSON.stringify(outcome)

describe('outcome vocabulary', () => {
  it('pins the closed reason sets and which refusals may be tried again', () => {
    expect([...FEISHU_REJECT_REASONS]).toEqual([
      'rate_limited',
      'token_rejected',
      'token_unavailable',
      'redirect_refused',
      'config_rejected',
      'recipient_rejected',
      'content_rejected',
    ])
    expect([...FEISHU_UNKNOWN_REASONS]).toEqual([
      'response_invalid',
      'in_progress',
      'server_error',
      'timeout',
      'network_error',
      'unclassified_code',
      'unclassified_status',
    ])
    expect([...FEISHU_NOT_ATTEMPTED_REASONS]).toEqual([
      'flag_off',
      'capability_off',
      'endpoint_scope_mismatch',
      'id_type_not_enabled',
      'endpoint_anchor_stale',
      'not_configured',
      'empty_message',
      'aborted',
    ])
    expect([...FEISHU_RETRYABLE_REJECT_REASONS].sort()).toEqual(['rate_limited', 'token_rejected', 'token_unavailable'])
    expect(FEISHU_TEXT_MAX_UTF16_UNITS).toBe(2000)
  })

  it('classifies an acceptance, a missing message id, a failure of the token phase and an abort without a request', () => {
    expect(classifyFeishuSend({ ok: true, messageId: 'om_x' })).toEqual({ kind: 'accepted', messageRef: 'om_x' })
    expect(classifyFeishuSend({ ok: true, messageId: null })).toEqual({ kind: 'unknown', reason: 'response_invalid' })
    expect(classifyFeishuSend({ ok: false, phase: 'token', error: new Error('x') })).toEqual({
      kind: 'rejected',
      retryable: true,
      reason: 'token_unavailable',
    })
    expect(classifyFeishuSend({ ok: false, phase: 'aborted' })).toEqual({ kind: 'not_attempted', reason: 'aborted' })
    expect(classifyFeishuSend({ ok: false, phase: 'send', error: 'not an error object' })).toEqual({
      kind: 'unknown',
      reason: 'network_error',
    })
  })
})

describe('FX-M01 a successful send', () => {
  it('posts one text message with the documented request shape and is accepted', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep()])
    const outcome = await h.sender.sendFeishuText(h.input({ text: 'Hello from a test' }))
    expect(outcome).toEqual({ kind: 'accepted', messageRef: MESSAGE_ID })

    expect(h.server.count(MINT_ROUTE)).toBe(1)
    expect(h.sendRequests()).toHaveLength(1)
    const request = h.sendRequests()[0]
    expect(request.method).toBe('POST')
    expect(request.path).toBe('/open-apis/im/v1/messages')
    expect(request.query).toEqual({ receive_id_type: 'open_id' })
    expect(request.headers.authorization).toBe('Bearer <token>')
    expect(request.headers['content-type']).toBe('application/json; charset=utf-8')
    const body = h.parsedBody(0)
    expect(Object.keys(body).sort()).toEqual(['content', 'msg_type', 'receive_id', 'uuid'])
    expect(body.receive_id).toBe(OPEN_ID)
    expect(body.msg_type).toBe('text')
    expect(typeof body.content).toBe('string')
    expect(JSON.parse(body.content)).toEqual({ text: 'Hello from a test' })
    expect(body.uuid).toMatch(/^ms2-[A-Za-z0-9_-]{43}$/)
    expect(body.uuid).toHaveLength(47)
  })

  it('uses the same uuid for the same send and endpoint, and another for another send, endpoint or connection', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep(), acceptedStep(), acceptedStep(), acceptedStep()])
    await h.sender.sendFeishuText(h.input())
    await h.sender.sendFeishuText(h.input())
    await h.sender.sendFeishuText(h.input({ dedupeKey: 'notification-fx-0002' }))
    await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID_2) }))
    await h.sender.sendFeishuText(
      h.input({ connectionId: OTHER_CONNECTION_ID, endpoint: endpointFor(OPEN_ID, { connectionId: OTHER_CONNECTION_ID, anchor: { tenant: TENANT, appScope: 'cli_fx_0002' } }) }),
    )
    const uuids = [0, 1, 2, 3, 4].map((index) => h.parsedBody(index).uuid)
    expect(uuids[0]).toBe(uuids[1])
    expect(new Set(uuids).size).toBe(4)
  })

  it('builds the uuid from the documented hash input', () => {
    const expected = `ms2-${createHash('sha256').update('feishu-msg-v2|c|d|e').digest('base64url').slice(0, 43)}`
    expect(buildFeishuMessageUuid('c', 'd', 'e')).toBe(expected)
    expect(expected).toHaveLength(47)
    expect(buildFeishuMessageUuid('c', 'd', 'e')).not.toBe(buildFeishuMessageUuid('c', 'd', 'f'))
  })
})

describe('FX-M02 an acceptance without a message id', () => {
  it.each([
    ['no data', { code: 0, msg: 'success' }],
    ['data without a message id', { code: 0, data: {} }],
    ['an empty message id', { code: 0, data: { message_id: '' } }],
    ['a message id that is not text', { code: 0, data: { message_id: 7 } }],
  ])('is unknown, response_invalid: %s', async (_name, body) => {
    h.server.script(SEND_ROUTE, [{ kind: 'json', body }])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'unknown', reason: 'response_invalid' })
    expect(h.sendRequests()).toHaveLength(1)
  })
})

describe('FX-M03 deterministic refusals', () => {
  const CASES: Array<[number, string]> = [
    [230013, 'recipient_rejected'],
    [230006, 'config_rejected'],
    [230027, 'config_rejected'],
    [230029, 'recipient_rejected'],
    [230034, 'recipient_rejected'],
    [230035, 'recipient_rejected'],
    [230038, 'recipient_rejected'],
    [230053, 'recipient_rejected'],
    [230022, 'content_rejected'],
    [230025, 'content_rejected'],
    [230028, 'content_rejected'],
    [230001, 'content_rejected'],
    [230099, 'content_rejected'],
    [99991672, 'config_rejected'],
    [10014, 'config_rejected'],
    [99991662, 'config_rejected'],
    [99991673, 'config_rejected'],
    [20009, 'config_rejected'],
    [99991401, 'config_rejected'],
    [99991403, 'config_rejected'],
  ]

  it.each(CASES)('code %i is a refusal that is not retryable (%s), one request', async (code, reason) => {
    h.server.script(SEND_ROUTE, [refusedStep(code)])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'rejected', retryable: false, reason, providerCode: code })
    expect(h.sendRequests()).toHaveLength(1)
  })

  it('a code other than 0 inside an HTTP 200 answer is the same refusal, never an acceptance', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(230013, 200)])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toEqual({ kind: 'rejected', retryable: false, reason: 'recipient_rejected', providerCode: 230013 })
    h.server.script(SEND_ROUTE, [refusedStep(999999, 200)])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'unknown', reason: 'unclassified_code', providerCode: 999999 })
  })
})

describe('FX-M04 rate limits', () => {
  it.each([
    ['HTTP 429 with a reset hint', { kind: 'json', status: 429, body: { code: 0 }, headers: { 'x-ogw-ratelimit-reset': '1' } }, undefined],
    ['HTTP 400 with the flow-control code', refusedStep(99991400), 99991400],
    ['code 230020', refusedStep(230020), 230020],
  ] as const)('%s: refused and retryable, and the transport makes exactly one request without waiting', async (_name, step, providerCode) => {
    h.server.script(SEND_ROUTE, [step, acceptedStep()])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toEqual({
      kind: 'rejected',
      retryable: true,
      reason: 'rate_limited',
      ...(providerCode === undefined ? {} : { providerCode }),
    })
    expect(h.sendRequests()).toHaveLength(1)
    expect(h.transportSleeps).toEqual([])
  })
})

describe('FX-M05 a refused tenant token', () => {
  it('mints again once and sends the same bytes with the same uuid; the second answer is the outcome', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(99991663), acceptedStep()])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toEqual({ kind: 'accepted', messageRef: MESSAGE_ID })
    expect(h.server.requests.map((request) => request.route)).toEqual([MINT_ROUTE, SEND_ROUTE, MINT_ROUTE, SEND_ROUTE])
    expect(h.sendRequests()[0].body).toBe(h.sendRequests()[1].body)
    expect(h.parsedBody(0).uuid).toBe(h.parsedBody(1).uuid)
  })

  it('a second refusal is a retryable refusal after exactly two sends and two mints', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(99991663), refusedStep(99991663), refusedStep(99991663)])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toEqual({ kind: 'rejected', retryable: true, reason: 'token_rejected', providerCode: 99991663 })
    expect(h.sendRequests()).toHaveLength(2)
    expect(h.server.count(MINT_ROUTE)).toBe(2)
    expect(h.parsedBody(0).uuid).toBe(h.parsedBody(1).uuid)
  })

  it.each([99991661, 99991663, 99991664, 99991665, 99991671, 20013])('code %i is a refused token', async (code) => {
    h.server.script(SEND_ROUTE, [refusedStep(code), refusedStep(code)])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toMatchObject({ kind: 'rejected', retryable: true, reason: 'token_rejected', providerCode: code })
  })

  it('a failed re-mint after a refused token is a retryable refusal; the message was not sent', async () => {
    h.server.script(MINT_ROUTE, [
      { kind: 'json', body: { access_token: 't-fx-token-1-abcdefghij', expires_in: 7200 } },
      { kind: 'json', status: 400, body: { code: 10003, msg: 'invalid' } },
    ])
    h.server.script(SEND_ROUTE, [refusedStep(99991663), acceptedStep()])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'rejected', retryable: true, reason: 'token_unavailable' })
    expect(h.sendRequests()).toHaveLength(1)
  })

  it('a token that cannot be obtained at all is a retryable refusal with no send request', async () => {
    h.server.script(MINT_ROUTE, [
      { kind: 'json', status: 500, body: { code: 0 } },
      { kind: 'json', status: 500, body: { code: 0 } },
      { kind: 'json', status: 500, body: { code: 0 } },
    ])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'rejected', retryable: true, reason: 'token_unavailable' })
    expect(h.sendRequests()).toHaveLength(0)
  })
})

describe('FX-M06 unknown outcomes: exactly one send request, never repeated', () => {
  const UNKNOWN_CASES: Array<[string, string, Parameters<SendHarness['server']['script']>[1][number]]> = [
    ['the connection is reset', 'network_error', { kind: 'reset' }],
    ['the answer never arrives', 'timeout', { kind: 'hang' }],
    ['the body stalls', 'timeout', { kind: 'stall-body' }],
    ['the body is cut', 'network_error', { kind: 'truncate' }],
    ['HTTP 500', 'server_error', { kind: 'json', status: 500, body: { code: 0 } }],
    ['HTTP 502', 'server_error', { kind: 'json', status: 502, body: { code: 0 } }],
    ['HTTP 503', 'server_error', { kind: 'json', status: 503, body: { code: 0 } }],
    ['HTTP 504', 'server_error', { kind: 'json', status: 504, body: { code: 0 } }],
    ['HTTP 500 with a provider code', 'server_error', refusedStep(230013, 500)],
    ['a server-error code in the body', 'server_error', refusedStep(20050, 200)],
    ['an HTTP 200 answer that is not JSON', 'response_invalid', { kind: 'raw', body: '<html>ok</html>' }],
    ['an HTTP 200 answer without a code', 'response_invalid', { kind: 'json', body: { data: { message_id: MESSAGE_ID } } }],
    ['the in-progress code', 'in_progress', refusedStep(230049)],
    ['an unrecognised code', 'unclassified_code', refusedStep(999999)],
    ['an unrecognised status without a code', 'unclassified_status', { kind: 'json', status: 404, body: {} }],
  ]

  it.each(UNKNOWN_CASES)('%s: unknown (%s) after one request, the next step is never used', async (_name, reason, step) => {
    h.server.script(SEND_ROUTE, [step, acceptedStep()])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toMatchObject({ kind: 'unknown', reason })
    expect(h.sendRequests()).toHaveLength(1)
    expect(h.server.count(MINT_ROUTE)).toBe(1)
  })
})

describe('FX-M07 and FX-M08 the endpoint must be addressable by this connection', () => {
  it('an endpoint of another connection is refused locally with no request at all', async () => {
    const outcome = await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID, { connectionId: OTHER_CONNECTION_ID }) }))
    expect(outcome).toEqual({ kind: 'not_attempted', reason: 'endpoint_scope_mismatch' })
    expect(h.server.count()).toBe(0)
  })

  it.each(['union_id', 'user_id', 'email', 'open_department_id', 'chat_id'])('an identifier of type %s is refused locally with no request', async (idType) => {
    const endpoint = { ...endpointFor(OPEN_ID), ref: { connectionId: CONNECTION_ID, idType, value: OPEN_ID } }
    const outcome = await h.sender.sendFeishuText(h.input({ endpoint: endpoint as never }))
    expect(outcome).toEqual({ kind: 'not_attempted', reason: 'id_type_not_enabled' })
    expect(h.server.count()).toBe(0)
  })
})

describe('FX-M09 and the local gates N1-N7: each refusal is local and makes no request', () => {
  const none = (): void => expect(h.server.count()).toBe(0)

  it('N1 the switch is on only for the exact text true', async () => {
    for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'false']) {
      h.flag.value = value
      expect(await h.sender.sendFeishuText(h.input()), String(value)).toEqual({ kind: 'not_attempted', reason: 'flag_off' })
    }
    none()
  })

  it('N1 an unreadable switch is off', async () => {
    const { createFeishuMessageSender } = await import('../../src/services/feishu-message-sender')
    const sender = createFeishuMessageSender({
      loadConnection: async () => connectionRow(),
      decodeSecret: (stored) => stored,
      tokens: h.tokens,
      deliveryFlag: () => {
        throw new Error('unreadable')
      },
    })
    expect(await sender.sendFeishuText(h.input())).toEqual({ kind: 'not_attempted', reason: 'flag_off' })
    none()
  })

  it('N2 the capability decision must say effective, exactly', async () => {
    for (const decision of [
      { effective: false, reason: 'switch_off' },
      { effective: false, reason: 'schema_unavailable' },
      { effective: false, reason: 'scope_changed' },
      { effective: false, reason: 'integration_inactive' },
      { effective: false, reason: 'transaction_required' },
      { effective: false, reason: 'read_failed' },
      { effective: 'true' },
      { effective: 1 },
      {},
      undefined,
      null,
    ]) {
      const outcome = await h.sender.sendFeishuText(h.input({ capabilityDecision: decision as never }))
      expect(outcome, JSON.stringify(decision)).toEqual({ kind: 'not_attempted', reason: 'capability_off' })
    }
    none()
  })

  it('N3 an endpoint of another connection', async () => {
    expect(await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID, { connectionId: OTHER_CONNECTION_ID }) }))).toEqual({
      kind: 'not_attempted',
      reason: 'endpoint_scope_mismatch',
    })
    none()
  })

  it('N4 an identifier that is not an open id', async () => {
    const endpoint = { ...endpointFor(OPEN_ID), ref: { connectionId: CONNECTION_ID, idType: 'union_id', value: OPEN_ID } }
    expect(await h.sender.sendFeishuText(h.input({ endpoint: endpoint as never }))).toEqual({ kind: 'not_attempted', reason: 'id_type_not_enabled' })
    none()
  })

  it('N5 an endpoint written under another tenant or another application scope is stale', async () => {
    for (const anchor of [
      { tenant: 'tk_other', appScope: 'cli_fx_0001' },
      { tenant: TENANT, appScope: 'cli_other' },
    ]) {
      expect(await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID, { anchor }) }))).toEqual({
        kind: 'not_attempted',
        reason: 'endpoint_anchor_stale',
      })
    }
    // the scope of the connection as it is now is what counts
    h.rows.set(CONNECTION_ID, connectionRow({ corp_id: 'tk_moved' }))
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'not_attempted', reason: 'endpoint_anchor_stale' })
    none()
  })

  it('N6 credentials that are missing, incomplete, unreadable or of an unknown brand', async () => {
    const cases: Array<[string, ReturnType<typeof connectionRow> | null]> = [
      ['no row', null],
      ['another provider', connectionRow({ provider: 'wecom' })],
      ['no application id', connectionRow({ config: { appSecret: 'enc:x' } })],
      ['no secret', connectionRow({ config: { appId: 'cli_fx_0001' } })],
      ['an unreadable secret', connectionRow({ config: { appId: 'cli_fx_0001', appSecret: 'plain-not-encrypted' } })],
      ['an unknown brand', connectionRow({ config: { appId: 'cli_fx_0001', appSecret: 'enc:x', brand: 'other' } })],
      ['a base address in the configuration', connectionRow({ config: { appId: 'cli_fx_0001', appSecret: 'enc:x', baseUrl: 'http://127.0.0.1:1' } })],
      ['a configuration that is not an object', connectionRow({ config: 'text' })],
    ]
    for (const [name, row] of cases) {
      h.rows.set(CONNECTION_ID, row)
      const outcome = await h.sender.sendFeishuText(h.input())
      expect(outcome, name).toEqual({ kind: 'not_attempted', reason: 'not_configured' })
    }
    none()
  })

  it('N6 a connection that cannot be read is not configured', async () => {
    const { createFeishuMessageSender } = await import('../../src/services/feishu-message-sender')
    const sender = createFeishuMessageSender({
      loadConnection: async () => {
        throw new Error('database unavailable')
      },
      decodeSecret: (stored) => stored,
      tokens: h.tokens,
      deliveryFlag: () => 'true',
    })
    expect(await sender.sendFeishuText(h.input())).toEqual({ kind: 'not_attempted', reason: 'not_configured' })
    none()
  })

  it('N7 a message that renders empty, and an aborted signal, make no request', async () => {
    for (const text of ['', '   ', '\n\t \n']) {
      expect(await h.sender.sendFeishuText(h.input({ text })), JSON.stringify(text)).toEqual({ kind: 'not_attempted', reason: 'empty_message' })
    }
    const controller = new AbortController()
    controller.abort()
    expect(await h.sender.sendFeishuText(h.input({ signal: controller.signal }))).toEqual({ kind: 'not_attempted', reason: 'aborted' })
    none()
  })

  it('FX-M09 a gate that passes lets exactly one request through', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep()])
    expect(await h.sender.sendFeishuText(h.input({ capabilityDecision: EFFECTIVE }))).toMatchObject({ kind: 'accepted' })
    expect(h.sendRequests()).toHaveLength(1)
  })
})

describe('FX-M10 text content', () => {
  const sentText = (): string => JSON.parse(h.parsedBody(0).content).text as string

  it('cuts long text to 2000 UTF-16 units', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep()])
    await h.sender.sendFeishuText(h.input({ text: 'a'.repeat(2500) }))
    expect(sentText()).toBe('a'.repeat(2000))
  })

  it('never ends a cut in the middle of a surrogate pair', async () => {
    const text = `${'a'.repeat(1999)}\u{1F600}tail`
    expect(truncateFeishuText(text)).toBe('a'.repeat(1999))
    expect(truncateFeishuText(`${'a'.repeat(1998)}\u{1F600}tail`)).toHaveLength(2000)
    expect(truncateFeishuText('short')).toBe('short')
    h.server.script(SEND_ROUTE, [acceptedStep()])
    await h.sender.sendFeishuText(h.input({ text }))
    expect(sentText()).toBe('a'.repeat(1999))
  })

  it('escapes quotes, line breaks and control characters so the body stays valid JSON', async () => {
    const text = 'He said "hi"\nsecond line\ttab \\ backslash \u0001 \u001f end'
    h.server.script(SEND_ROUTE, [acceptedStep()])
    await h.sender.sendFeishuText(h.input({ text }))
    expect(sentText()).toBe(text)
    expect(() => JSON.parse(h.sendRequests()[0].body)).not.toThrow()
  })
})

describe('FX-M11 a second send with the same key and endpoint', () => {
  it('(a) an acceptance with the same message id is an acceptance', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    const first = await h.sender.sendFeishuText(h.input())
    const second = await h.sender.sendFeishuText(h.input())
    expect(first).toEqual(second)
    expect(h.parsedBody(0).uuid).toBe(h.parsedBody(1).uuid)
  })

  it('(b) an unrecognised error code is unknown', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), refusedStep(999998)])
    await h.sender.sendFeishuText(h.input())
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'unknown', reason: 'unclassified_code', providerCode: 999998 })
    expect(h.parsedBody(0).uuid).toBe(h.parsedBody(1).uuid)
  })
})

describe('the uuid covers the addressed endpoint', () => {
  it('two endpoints of one event never share a uuid, whatever evidence they carry', () => {
    const a = endpointFor(OPEN_ID, { evidence: ['user-1', 'evidence-1', '3'] })
    const b = endpointFor(OPEN_ID_2, { evidence: ['user-1', 'evidence-1', '3'] })
    const c = endpointFor(OPEN_ID, { evidence: ['user-2', 'evidence-1', '3'] })
    const d = endpointFor(OPEN_ID, { evidence: ['user-1', 'evidence-1', '4'] })
    const refs = [a, b, c, d].map(feishuEndpointRefOf)
    expect(new Set(refs).size).toBe(4)
    expect(new Set(refs.map((ref) => buildFeishuMessageUuid(CONNECTION_ID, 'event', ref))).size).toBe(4)
  })

  it('the uuid of a real send differs between two recipients of the same event', async () => {
    h.server.script(SEND_ROUTE, [acceptedStep(), acceptedStep()])
    await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID) }))
    await h.sender.sendFeishuText(h.input({ endpoint: endpointFor(OPEN_ID_2) }))
    expect(h.parsedBody(0).uuid).not.toBe(h.parsedBody(1).uuid)
  })
})

describe('FX-M24 a redirect on the send tier', () => {
  it.each([301, 302, 307, 308] as const)('%i is refused and not followed: one request, not retryable', async (status) => {
    h.server.script(SEND_ROUTE, [{ kind: 'redirect', status, location: '/elsewhere' }, acceptedStep()])
    const outcome = await h.sender.sendFeishuText(h.input())
    expect(outcome).toEqual({ kind: 'rejected', retryable: false, reason: 'redirect_refused' })
    expect(h.sendRequests()).toHaveLength(1)
    expect(h.server.requests.filter((request) => request.path === '/elsewhere')).toHaveLength(0)
  })
})

describe('FX-M25 configuration refusals and codes that are deliberately unknown', () => {
  it('230036 is a permanent configuration refusal', async () => {
    h.server.script(SEND_ROUTE, [refusedStep(230036)])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'rejected', retryable: false, reason: 'config_rejected', providerCode: 230036 })
    expect(h.sendRequests()).toHaveLength(1)
  })

  it.each([230015, 230017, 230018, 230019, 230054, 230055])('%i is unknown after one request', async (code) => {
    h.server.script(SEND_ROUTE, [refusedStep(code)])
    expect(await h.sender.sendFeishuText(h.input())).toEqual({ kind: 'unknown', reason: 'unclassified_code', providerCode: code })
    expect(h.sendRequests()).toHaveLength(1)
  })
})

describe('FX-M15 nothing identifying is logged or placed in an outcome', () => {
  const SECRET_TEXT = 'confidential body text fx-0042'

  it('keeps open ids, text, tokens, uuids and message ids out of every log line and every non-accepted outcome', async () => {
    h.server.script(SEND_ROUTE, [
      acceptedStep(),
      refusedStep(230013),
      refusedStep(999999),
      { kind: 'reset' },
      refusedStep(99991663),
      refusedStep(99991663),
    ])
    const outcomes: FeishuSendOutcome[] = []
    for (let index = 0; index < 5; index += 1) {
      outcomes.push(await h.sender.sendFeishuText(h.input({ text: SECRET_TEXT, dedupeKey: `key-${index}` })))
    }
    h.flag.value = 'false'
    outcomes.push(await h.sender.sendFeishuText(h.input({ text: SECRET_TEXT })))
    h.flag.value = 'true'

    const uuids = h.sendRequests().map((request) => JSON.parse(request.body).uuid as string)
    const logged = JSON.stringify(h.logs)
    expect(h.logs.length).toBeGreaterThan(0)
    const forbidden = [OPEN_ID, SECRET_TEXT, 't-fx-token', MESSAGE_ID, 'ms2-', 'Bearer', ...uuids]
    for (const needle of forbidden) expect(logged.includes(needle), needle).toBe(false)
    for (const outcome of outcomes.filter((entry) => entry.kind !== 'accepted')) {
      const text = outcomeJson(outcome)
      for (const needle of [OPEN_ID, SECRET_TEXT, 't-fx-token', MESSAGE_ID, ...uuids]) expect(text.includes(needle), needle).toBe(false)
    }
  })
})

describe('abort', () => {
  it('a signal that aborted before the send makes no request and no mint', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await h.sender.sendFeishuText(h.input({ signal: controller.signal }))).toEqual({ kind: 'not_attempted', reason: 'aborted' })
    expect(h.server.count()).toBe(0)
  })
})
