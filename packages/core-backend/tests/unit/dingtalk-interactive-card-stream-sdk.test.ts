/**
 * SDK-adapter slice: `createDingTalkInteractiveCardStreamSdkClient` against a mocked
 * `dingtalk-stream` module (injected through the `loadSdk` test seam — the real package is never
 * touched here).
 *
 * Locks: card-callback-topic-only subscription, connection lifecycle (start/close incl.
 * reconnect kill-switch ordering), frame → `handlers.onEvent` threading, malformed-frame
 * values-free rejection, ack semantics, secrets-never-logged, and the honest `sdk_unwired`
 * sentinel when the SDK module is genuinely unavailable.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED_ERROR,
  DingTalkInteractiveCardStreamWorker,
  resolveDingTalkInteractiveCardStreamConfig,
  type DingTalkInteractiveCardStreamConfig,
  type DingTalkInteractiveCardStreamEvent,
  type DingTalkInteractiveCardStreamHandlers,
} from '../../src/integrations/dingtalk/interactive-card-stream'
import {
  createDingTalkInteractiveCardStreamSdkClient,
  type DingTalkStreamDownStreamFrame,
  type DingTalkStreamSdkModule,
} from '../../src/integrations/dingtalk/interactive-card-stream-sdk'

const TOPIC_CARD = '/v1.0/card/instances/callback'

function logger() {
  return { info: vi.fn(), warn: vi.fn() }
}

function enabledConfig(): Extract<DingTalkInteractiveCardStreamConfig, { enabled: true }> {
  const config = resolveDingTalkInteractiveCardStreamConfig({
    [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
    [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
    [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
    [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
  } as NodeJS.ProcessEnv)
  if (config.enabled !== true) throw new Error('fixture config must be enabled')
  return config
}

/** Mirrors the real DWClient surface the adapter relies on, incl. subscription bookkeeping. */
class FakeDWClient {
  config: { subscriptions: Array<{ type: string; topic: string }>; autoReconnect?: boolean } = {
    // Real SDK default: a wildcard EVENT subscription the adapter must drop.
    subscriptions: [{ type: 'EVENT', topic: '*' }],
    autoReconnect: true,
  }

  listeners = new Map<string, (frame: DingTalkStreamDownStreamFrame) => void>()
  connect = vi.fn(async () => {})
  disconnect = vi.fn(() => {})
  socketCallBackResponse = vi.fn((_messageId: string, _response: unknown) => {})
  readonly constructorOpts: Record<string, unknown>

  constructor(opts: Record<string, unknown>) {
    this.constructorOpts = opts
  }

  registerCallbackListener(topic: string, listener: (frame: DingTalkStreamDownStreamFrame) => void) {
    // Real SDK behavior: registering a callback listener records a CALLBACK subscription.
    if (!this.config.subscriptions.find((s) => s.topic === topic && s.type === 'CALLBACK')) {
      this.config.subscriptions.push({ type: 'CALLBACK', topic })
    }
    this.listeners.set(topic, listener)
    return this
  }
}

function fakeSdk() {
  const instances: FakeDWClient[] = []
  const sdk: DingTalkStreamSdkModule = {
    DWClient: class extends FakeDWClient {
      constructor(opts: Record<string, unknown>) {
        super(opts)
        instances.push(this)
      }
    },
    TOPIC_CARD,
  }
  return { sdk, instances }
}

async function adapter(overrides: {
  onEvent?: DingTalkInteractiveCardStreamHandlers['onEvent']
} = {}) {
  const log = logger()
  const { sdk, instances } = fakeSdk()
  const onEvent = overrides.onEvent ?? vi.fn(async () => {})
  const client = await createDingTalkInteractiveCardStreamSdkClient(
    enabledConfig(),
    { onEvent },
    { logger: log, loadSdk: async () => sdk },
  )
  expect(instances).toHaveLength(1)
  return { log, client, dw: instances[0]!, onEvent }
}

function loggedText(log: ReturnType<typeof logger>): string {
  return JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls])
}

describe('DingTalk interactive-card Stream SDK adapter', () => {
  it('constructs the SDK client from the gated config with debug OFF and never logs the secret', async () => {
    const { log, dw } = await adapter()
    expect(dw.constructorOpts).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      keepAlive: true,
      debug: false,
    })
    expect(loggedText(log)).not.toContain('secret-1')
  })

  it('subscribes ONLY to the card-callback topic (drops the SDK default wildcard EVENT subscription)', async () => {
    const { dw } = await adapter()
    expect(dw.config.subscriptions).toEqual([{ type: 'CALLBACK', topic: TOPIC_CARD }])
    expect(dw.listeners.size).toBe(1)
    expect(dw.listeners.has(TOPIC_CARD)).toBe(true)
  })

  it('start() connects once; close() kills the SDK reconnect BEFORE disconnecting', async () => {
    const { client, dw } = await adapter()
    await client.start()
    expect(dw.connect).toHaveBeenCalledTimes(1)

    let autoReconnectAtDisconnect: boolean | undefined = true
    dw.disconnect.mockImplementation(() => {
      autoReconnectAtDisconnect = dw.config.autoReconnect
    })
    await client.close()
    expect(dw.disconnect).toHaveBeenCalledTimes(1)
    expect(autoReconnectAtDisconnect).toBe(false)
    expect(dw.config.autoReconnect).toBe(false)
  })

  it('threads a card-callback frame into handlers.onEvent with the JSON-decoded payload and acks it', async () => {
    const events: DingTalkInteractiveCardStreamEvent[] = []
    const onEvent = vi.fn(async (event: DingTalkInteractiveCardStreamEvent) => { events.push(event) })
    const { dw } = await adapter({ onEvent })

    const wirePayload = { outTrackId: 'd-1', userId: 'dd_op', content: '{"cardPrivateData":{"actionIds":["approve"]}}' }
    dw.listeners.get(TOPIC_CARD)!({
      type: 'CALLBACK',
      headers: { messageId: 'msg-1', topic: TOPIC_CARD },
      data: JSON.stringify(wirePayload),
    })

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(events[0]).toEqual({
      eventType: 'CALLBACK',
      eventId: 'msg-1',
      payload: wirePayload,
    })
    expect(dw.socketCallBackResponse).toHaveBeenCalledTimes(1)
    expect(dw.socketCallBackResponse).toHaveBeenCalledWith('msg-1', {})
  })

  it('rejects a frame whose data is not a string: values-free warn, no onEvent, still acked', async () => {
    const onEvent = vi.fn(async () => {})
    const { log, dw } = await adapter({ onEvent })

    dw.listeners.get(TOPIC_CARD)!({
      type: 'CALLBACK',
      headers: { messageId: 'msg-2', topic: TOPIC_CARD },
      data: { SECRET_FIELD: 'SECRET_FORM_VALUE' },
    })

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'DingTalk interactive-card Stream frame rejected (malformed_frame:data_not_string)',
    ))
    expect(onEvent).not.toHaveBeenCalled()
    expect(dw.socketCallBackResponse).toHaveBeenCalledWith('msg-2', {})
    expect(loggedText(log)).not.toContain('SECRET_FORM_VALUE')
  })

  it('rejects a frame whose data is not JSON: values-free warn, wire bytes never logged or forwarded', async () => {
    const onEvent = vi.fn(async () => {})
    const { log, dw } = await adapter({ onEvent })

    dw.listeners.get(TOPIC_CARD)!({
      type: 'CALLBACK',
      headers: { messageId: 'msg-3', topic: TOPIC_CARD },
      data: 'SECRET_RAW_WIRE_BYTES{{{not-json',
    })

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'DingTalk interactive-card Stream frame rejected (malformed_frame:data_not_json)',
    ))
    expect(onEvent).not.toHaveBeenCalled()
    expect(loggedText(log)).not.toContain('SECRET_RAW_WIRE_BYTES')
  })

  it('skips the ack (send would throw) when the frame carries no messageId', async () => {
    const onEvent = vi.fn(async () => {})
    const { dw } = await adapter({ onEvent })

    dw.listeners.get(TOPIC_CARD)!({ type: 'CALLBACK', headers: {}, data: JSON.stringify({ outTrackId: 'd-2' }) })

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(dw.socketCallBackResponse).not.toHaveBeenCalled()
  })

  it('an ack failure is warned values-free and does not block payload delivery', async () => {
    const onEvent = vi.fn(async () => {})
    const { log, dw } = await adapter({ onEvent })
    dw.socketCallBackResponse.mockImplementation(() => {
      throw new Error('socket closed with secret-1 in message')
    })

    dw.listeners.get(TOPIC_CARD)!({
      type: 'CALLBACK',
      headers: { messageId: 'msg-4', topic: TOPIC_CARD },
      data: JSON.stringify({ outTrackId: 'd-3' }),
    })

    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1))
    expect(log.warn).toHaveBeenCalledWith('DingTalk interactive-card Stream frame ack failed (ack_failed)')
    expect(loggedText(log)).not.toContain('secret-1')
  })

  it('an onEvent rejection is contained as a values-free warn (never an unhandled rejection)', async () => {
    const onEvent = vi.fn(async () => {
      throw new Error('executor exploded with SECRET_FORM_VALUE')
    })
    const { log, dw } = await adapter({ onEvent })

    dw.listeners.get(TOPIC_CARD)!({
      type: 'CALLBACK',
      headers: { messageId: 'msg-5', topic: TOPIC_CARD },
      data: JSON.stringify({ outTrackId: 'd-4' }),
    })

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
      'DingTalk interactive-card Stream event dispatch failed (event_dispatch_failed)',
    ))
    expect(loggedText(log)).not.toContain('SECRET_FORM_VALUE')
  })

  it('an unavailable SDK module surfaces the honest sdk_unwired sentinel end-to-end', async () => {
    await expect(createDingTalkInteractiveCardStreamSdkClient(
      enabledConfig(),
      { onEvent: async () => {} },
      { logger: logger(), loadSdk: async () => { throw new Error('Cannot find module dingtalk-stream') } },
    )).rejects.toThrow(DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED_ERROR)

    const log = logger()
    const worker = new DingTalkInteractiveCardStreamWorker({
      logger: log,
      clientFactory: (config, handlers) => createDingTalkInteractiveCardStreamSdkClient(config, handlers, {
        logger: log,
        loadSdk: async () => { throw new Error('Cannot find module dingtalk-stream') },
      }),
    })
    await expect(worker.initialize({
      [DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]: '1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]: 'client-1',
      [DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]: 'secret-1',
      [DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]: 'template-1',
    } as NodeJS.ProcessEnv)).resolves.toEqual({ state: 'failed', reason: 'sdk_unwired' })
    expect(log.warn).toHaveBeenCalledWith('DingTalk interactive-card Stream worker failed to start (sdk_unwired)')
  })
})
