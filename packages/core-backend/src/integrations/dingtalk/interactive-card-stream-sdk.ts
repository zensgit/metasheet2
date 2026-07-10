/**
 * Slice-B SDK adapter: wires the official DingTalk Stream SDK (`dingtalk-stream`,
 * github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) as the production
 * `DingTalkInteractiveCardStreamClient` behind the B-1 factory seam.
 *
 * Import discipline (B-1 gate invariant): this module is loaded ONLY via dynamic import from the
 * worker's default client factory, which runs strictly after the env gate resolved enabled — with
 * the flag off (the default) neither this module nor `dingtalk-stream` (ws/axios transport) is
 * ever imported. The `dingtalk-stream` import below is itself dynamic so merely loading this
 * module stays side-effect-free as well.
 *
 * Topic discipline: subscribes ONLY to the card-callback topic (the SDK's `TOPIC_CARD`,
 * `/v1.0/card/instances/callback`). The SDK's default wildcard EVENT subscription is dropped
 * before connecting so the gateway registration carries exactly that one CALLBACK subscription.
 * Frames are threaded into the worker's existing `handlers.onEvent` seam unchanged — semantic
 * parsing of the payload stays owned by the B-3 callback adapter.
 *
 * Reconnect: the SDK's built-in reconnect (`autoReconnect`, default on) owns retry after
 * transport drops and CONNECT failures; `close()` disables it BEFORE disconnecting so an
 * already-scheduled reconnect timer can never resurrect the connection after shutdown (the SDK
 * clears its own user-disconnect latch on every connection attempt).
 *
 * Values-free logging: this adapter logs reason categories only — never frame data, card
 * payloads, operator ids, or credentials. The SDK's `debug` mode is NEVER enabled: it dumps the
 * full client config — including the client secret — to the console.
 */
import { Logger } from '../../core/logger'
import {
  DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED_ERROR,
  type DingTalkInteractiveCardStreamClient,
  type DingTalkInteractiveCardStreamConfig,
  type DingTalkInteractiveCardStreamHandlers,
} from './interactive-card-stream'

type EnabledStreamConfig = Extract<DingTalkInteractiveCardStreamConfig, { enabled: true }>

/**
 * Shape of a downstream frame as delivered by the SDK's callback listener (`DWClientDownStream`),
 * kept structurally loose: every field is re-validated here before use.
 */
export type DingTalkStreamDownStreamFrame = {
  type?: string
  headers?: {
    messageId?: string
    topic?: string
  }
  /** JSON-encoded card-callback payload (a string on the wire). */
  data?: unknown
}

/**
 * The narrow slice of the SDK's `DWClient` this adapter relies on (structurally satisfied by the
 * real class). Keeping the surface minimal pins exactly what an SDK upgrade must preserve.
 */
export type DingTalkStreamClientLike = {
  config: {
    subscriptions: Array<{ type: string; topic: string }>
    autoReconnect?: boolean
  }
  registerCallbackListener(topic: string, listener: (frame: DingTalkStreamDownStreamFrame) => void): unknown
  connect(): Promise<void>
  disconnect(): void
  /** Acks a pushed frame so the gateway stops re-delivering it (~60s retry window otherwise). */
  socketCallBackResponse(messageId: string, response: unknown): void
}

export type DingTalkStreamSdkModule = {
  DWClient: new (opts: {
    clientId: string
    clientSecret: string
    keepAlive?: boolean
    debug?: boolean
  }) => DingTalkStreamClientLike
  /** Card-callback topic constant (`/v1.0/card/instances/callback`). */
  TOPIC_CARD: string
}

async function importDingTalkStreamSdk(): Promise<DingTalkStreamSdkModule> {
  return import('dingtalk-stream')
}

/**
 * Transport-frame handling: validate framing, ack, JSON-decode, and thread the decoded payload
 * into the worker's `handleEvent` seam. Malformed frames are rejected values-free (reason
 * category only — the raw wire bytes are never logged and never forwarded).
 */
async function handleCardCallbackFrame(
  client: DingTalkStreamClientLike,
  frame: DingTalkStreamDownStreamFrame,
  handlers: DingTalkInteractiveCardStreamHandlers,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const messageId = typeof frame?.headers?.messageId === 'string' ? frame.headers.messageId : ''

  // Ack first (empty card response — no card update, no frame data echoed back): the gateway
  // re-pushes unacked callbacks for ~60s, and the B-3 executor behind onEvent may legitimately be
  // slow (engine execution). B-3's ledger/stale handling keeps redelivery harmless, but acking up
  // front avoids systematic duplicate deliveries. Malformed frames are acked too — they will
  // never become well-formed on retry.
  if (messageId) {
    try {
      client.socketCallBackResponse(messageId, {})
    } catch {
      logger.warn('DingTalk interactive-card Stream frame ack failed (ack_failed)')
    }
  }

  if (typeof frame?.data !== 'string') {
    logger.warn('DingTalk interactive-card Stream frame rejected (malformed_frame:data_not_string)')
    return
  }
  let payload: unknown
  try {
    payload = JSON.parse(frame.data)
  } catch {
    // Values-free reject: never log (or forward) unparseable wire bytes.
    logger.warn('DingTalk interactive-card Stream frame rejected (malformed_frame:data_not_json)')
    return
  }

  try {
    await handlers.onEvent({
      eventType: typeof frame.type === 'string' ? frame.type : undefined,
      eventId: messageId || undefined,
      payload,
    })
  } catch {
    // The worker's handleEvent is designed to never throw; belt-and-braces so a rejection can
    // never surface as an unhandled rejection inside the SDK's EventEmitter dispatch.
    logger.warn('DingTalk interactive-card Stream event dispatch failed (event_dispatch_failed)')
  }
}

export async function createDingTalkInteractiveCardStreamSdkClient(
  config: EnabledStreamConfig,
  handlers: DingTalkInteractiveCardStreamHandlers,
  seams: {
    logger?: Pick<Logger, 'info' | 'warn'>
    /** Test seam: SDK module override. Production loads the real `dingtalk-stream` package. */
    loadSdk?: () => Promise<DingTalkStreamSdkModule>
  } = {},
): Promise<DingTalkInteractiveCardStreamClient> {
  const logger = seams.logger ?? new Logger('DingTalkInteractiveCardStreamSdk')

  let sdk: DingTalkStreamSdkModule
  try {
    sdk = await (seams.loadSdk ?? importDingTalkStreamSdk)()
  } catch {
    // SDK module genuinely unavailable: surface the honest unwired sentinel (the worker maps it
    // to `{ state: 'failed', reason: 'sdk_unwired' }`) instead of a generic start failure.
    throw new Error(DINGTALK_INTERACTIVE_CARD_STREAM_SDK_UNWIRED_ERROR)
  }

  const client = new sdk.DWClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Client-side ping/pong heartbeat so half-dead connections are terminated and reconnected.
    keepAlive: true,
    // NEVER enable: SDK debug mode dumps the full config — including the client secret.
    debug: false,
  })

  // Subscribe ONLY to the card-callback topic: drop the SDK's default wildcard EVENT
  // subscription so the gateway registration carries exactly the CALLBACK topic added below.
  client.config.subscriptions.length = 0
  client.registerCallbackListener(sdk.TOPIC_CARD, (frame) => {
    void handleCardCallbackFrame(client, frame, handlers, logger)
  })

  return {
    async start() {
      // The SDK owns retry from here: CONNECT/registration failures and later transport drops are
      // re-attempted by its built-in reconnect loop (autoReconnect, default on).
      await client.connect()
    },
    async close() {
      // Disable the built-in reconnect FIRST — the SDK resets its own user-disconnect latch on
      // every connection attempt, so a pending reconnect timer could otherwise reconnect after
      // shutdown — then close the socket (a no-op if the client never connected).
      client.config.autoReconnect = false
      client.disconnect()
    },
  }
}
