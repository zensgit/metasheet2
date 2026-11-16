/**
 * The Feishu send core: local gates, one tenant token, one send request, one classification.
 *
 * Shape of a send: the local gates N1-N7 run first and any failure is `not_attempted` with no request;
 * then the tenant token is obtained, ONE `send` request is made, and the result is classified by the
 * single pure function `classifyFeishuSend`, which every shell around this core shares.
 *
 * Invariants:
 *  - An outcome is exactly one of `accepted` (the provider accepted the request and returned a message
 *    id), `rejected` (refused before the request was processed; no message was created), `unknown` (the
 *    message may have been created and no usable answer was seen) and `not_attempted` (decided locally,
 *    no request). Anything not listed as a deterministic refusal is `unknown`.
 *  - An unknown outcome is never repeated, never redirected to another endpoint, connection or channel,
 *    and never reported as a failure that is safe to resend.
 *  - `accepted` is provider acceptance of the request; it is neither delivery nor a read.
 *  - Every attempt of one send carries the same `uuid`. The `uuid` covers the addressed endpoint, so two
 *    recipients of one event never share one.
 *  - The core reads no database and no environment variable: the connection row, the secret decoder, the
 *    token service and the delivery flag value are injected. The flag is on only for the exact text 'true'.
 *  - No identifier, text, token or `uuid` is logged or placed in an outcome; the message id appears only in
 *    an `accepted` outcome, for the caller.
 *  - A connection row that cannot be read is a transient infrastructure failure: it is `not_attempted` with
 *    its own reason, the same family as an unreadable capability, never a configuration failure.
 */
import { createHash, randomUUID } from 'node:crypto'
import { feishuScopeOf, parseFeishuConfig, resolveFeishuAppSecret, type FeishuIdRef } from '../integrations/feishu/config'
import {
  FEISHU_FLOW_CONTROL_CODE,
  FeishuBusinessError,
  FeishuHostNotAllowedError,
  FeishuMalformedResponseError,
  FeishuRequestError,
  FeishuTimeoutError,
  isFeishuOutcomeUnknown,
  isFeishuTokenInvalidCode,
} from '../integrations/feishu/errors'
import { sendFeishuTextMessage, type FeishuMessageClientOptions, type FeishuTextMessageResult } from '../integrations/feishu/message-client'
import { feishuLogLabel } from '../integrations/feishu/redaction'
import type { FeishuTenantTokenService } from '../integrations/feishu/token'
import { Logger } from '../core/logger'

const logger = new Logger('FeishuMessageSender')

export const FEISHU_REJECT_REASONS = Object.freeze([
  'rate_limited',
  'token_rejected',
  'token_unavailable',
  'redirect_refused',
  'config_rejected',
  'recipient_rejected',
  'content_rejected',
] as const)
export type FeishuRejectReason = (typeof FEISHU_REJECT_REASONS)[number]

export const FEISHU_UNKNOWN_REASONS = Object.freeze([
  'response_invalid',
  'in_progress',
  'server_error',
  'timeout',
  'network_error',
  'unclassified_code',
  'unclassified_status',
] as const)
export type FeishuUnknownReason = (typeof FEISHU_UNKNOWN_REASONS)[number]

export const FEISHU_NOT_ATTEMPTED_REASONS = Object.freeze([
  'flag_off',
  'capability_off',
  'endpoint_scope_mismatch',
  'id_type_not_enabled',
  'endpoint_anchor_stale',
  'connection_unavailable',
  'not_configured',
  'empty_message',
  'aborted',
] as const)
export type FeishuNotAttemptedReason = (typeof FEISHU_NOT_ATTEMPTED_REASONS)[number]

export type FeishuSendOutcome =
  | { kind: 'accepted'; messageRef: string }
  | { kind: 'rejected'; retryable: boolean; reason: FeishuRejectReason; providerCode?: number }
  | { kind: 'unknown'; reason: FeishuUnknownReason; providerCode?: number }
  | { kind: 'not_attempted'; reason: FeishuNotAttemptedReason }

/** Reasons for which a refused send may be tried again later; no other refusal is retryable. */
export const FEISHU_RETRYABLE_REJECT_REASONS: ReadonlySet<FeishuRejectReason> = new Set<FeishuRejectReason>([
  'rate_limited',
  'token_rejected',
  'token_unavailable',
])

/** Provider codes that are a deterministic refusal, by category. */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([FEISHU_FLOW_CONTROL_CODE, 230020])
const CONFIG_REJECT_CODES: ReadonlySet<number> = new Set([230006, 230027, 230036, 99991672, 10014, 99991662, 99991673, 20009, 99991401, 99991403])
const RECIPIENT_REJECT_CODES: ReadonlySet<number> = new Set([230013, 230029, 230034, 230035, 230038, 230053])
const CONTENT_REJECT_CODES: ReadonlySet<number> = new Set([230001, 230022, 230025, 230028, 230099])
const IN_PROGRESS_CODE = 230049

export const FEISHU_TEXT_MAX_UTF16_UNITS = 2000

/** The scope anchor an endpoint was written with. */
export interface FeishuEndpointAnchor {
  readonly tenant: string
  readonly appScope: string
}

export interface FeishuSendEndpoint {
  readonly ref: FeishuIdRef
  readonly anchor: FeishuEndpointAnchor
  /**
   * Terms that make the de-duplication key specific to this endpoint (for example the local user and the
   * evidence reference and version it was read from). The open id is always part of the key as well.
   */
  readonly evidence?: readonly string[]
}

/** The result of the capability decision; anything but `effective === true` is a refusal. */
export interface FeishuCapabilityDecision {
  readonly effective: boolean
  readonly reason?: string | null
}

export interface FeishuSendInput {
  connectionId: string
  endpoint: FeishuSendEndpoint
  /** The rendered text; it is cut to FEISHU_TEXT_MAX_UTF16_UNITS before it is sent. */
  text: string
  /**
   * The caller's identifier of this one send; the same value gives the same `uuid` for the same endpoint.
   * An empty or missing value is treated as no key: the core then uses a random key for this one call, so
   * the attempts of the call share one `uuid` and no two calls or endpoints do.
   */
  dedupeKey: string
  capabilityDecision: FeishuCapabilityDecision
  signal?: AbortSignal
}

export interface FeishuSenderConnectionRow {
  provider?: string
  corp_id: string
  config: unknown
}

export interface FeishuMessageSenderDeps {
  loadConnection(connectionId: string): Promise<FeishuSenderConnectionRow | null>
  decodeSecret(stored: string): string
  tokens: Pick<FeishuTenantTokenService, 'withTenantToken'>
  /** The raw value of the delivery switch; the send core compares it to the exact text 'true'. */
  deliveryFlag(): string | undefined
  fetchFn?: typeof fetch
  transport?: FeishuMessageClientOptions['transport']
}

export interface FeishuMessageSender {
  sendFeishuText(input: FeishuSendInput): Promise<FeishuSendOutcome>
}

/** The request de-duplication key: 47 characters, covering the connection, the send and the endpoint. */
export function buildFeishuMessageUuid(connectionId: string, dedupeKey: string, endpointRef: string): string {
  const digest = createHash('sha256').update(`feishu-msg-v2|${connectionId}|${dedupeKey}|${endpointRef}`).digest('base64url')
  return `ms2-${digest.slice(0, 43)}`
}

/** The endpoint term of the key: the evidence terms followed by the open id, unambiguously encoded. */
export function feishuEndpointRefOf(endpoint: FeishuSendEndpoint): string {
  return JSON.stringify([...(endpoint.evidence ?? []), endpoint.ref.value])
}

/** Cuts text to FEISHU_TEXT_MAX_UTF16_UNITS, never leaving half of a surrogate pair. */
export function truncateFeishuText(text: string): string {
  if (text.length <= FEISHU_TEXT_MAX_UTF16_UNITS) return text
  let end = FEISHU_TEXT_MAX_UTF16_UNITS
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

function rejected(reason: FeishuRejectReason, providerCode?: number): FeishuSendOutcome {
  const outcome: FeishuSendOutcome = { kind: 'rejected', retryable: FEISHU_RETRYABLE_REJECT_REASONS.has(reason), reason }
  if (providerCode !== undefined) outcome.providerCode = providerCode
  return outcome
}

function unknown(reason: FeishuUnknownReason, providerCode?: number): FeishuSendOutcome {
  const outcome: FeishuSendOutcome = { kind: 'unknown', reason }
  if (providerCode !== undefined) outcome.providerCode = providerCode
  return outcome
}

function notAttempted(reason: FeishuNotAttemptedReason): FeishuSendOutcome {
  return { kind: 'not_attempted', reason }
}

function unknownReasonOf(error: unknown): FeishuUnknownReason {
  if (error instanceof FeishuTimeoutError) return 'timeout'
  if (error instanceof FeishuMalformedResponseError) return 'response_invalid'
  if (error instanceof FeishuRequestError) return error.statusCode >= 500 ? 'server_error' : 'unclassified_status'
  if (error instanceof FeishuBusinessError) {
    if (error.code === IN_PROGRESS_CODE) return 'in_progress'
    return error.code === 20050 || error.code === 20072 ? 'server_error' : 'unclassified_code'
  }
  return 'network_error'
}

function classifySendError(error: unknown): FeishuSendOutcome {
  if (error instanceof FeishuHostNotAllowedError) return notAttempted('not_configured')
  const providerCode = error instanceof FeishuBusinessError ? error.code : undefined
  if (isFeishuOutcomeUnknown(error)) return unknown(unknownReasonOf(error), providerCode)

  if (error instanceof FeishuRequestError) {
    if (error.statusCode >= 300 && error.statusCode < 400) return rejected('redirect_refused')
    if (error.statusCode === 429) return rejected('rate_limited')
    return unknown(unknownReasonOf(error))
  }
  if (error instanceof FeishuBusinessError) {
    const code = error.code
    if (RATE_LIMIT_CODES.has(code)) return rejected('rate_limited', code)
    if (isFeishuTokenInvalidCode(code)) return rejected('token_rejected', code)
    if (CONFIG_REJECT_CODES.has(code)) return rejected('config_rejected', code)
    if (RECIPIENT_REJECT_CODES.has(code)) return rejected('recipient_rejected', code)
    if (CONTENT_REJECT_CODES.has(code)) return rejected('content_rejected', code)
    return unknown(unknownReasonOf(error), code)
  }
  return unknown(unknownReasonOf(error))
}

/**
 * The one classification of a send, shared by every shell. Total: every input yields an outcome.
 * A failure that arose while the tenant token was being obtained is a refusal before any message was
 * sent; on the send request itself, only the listed deterministic refusals are refusals.
 */
export function classifyFeishuSend(result: FeishuTextMessageResult): FeishuSendOutcome {
  if (result.ok === true) {
    return result.messageId === null ? unknown('response_invalid') : { kind: 'accepted', messageRef: result.messageId }
  }
  if (result.phase === 'aborted') return notAttempted('aborted')
  if (result.phase === 'token') return rejected('token_unavailable')
  return classifySendError(result.error)
}

function safeFlag(read: () => string | undefined): string | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function logOutcome(outcome: FeishuSendOutcome): void {
  if (outcome.kind === 'accepted') {
    logger.info('Feishu text send accepted')
    return
  }
  const code = 'providerCode' in outcome && outcome.providerCode !== undefined ? ` code ${outcome.providerCode}` : ''
  logger.warn(`Feishu text send ${outcome.kind}: ${outcome.reason}${code}`)
}

export function createFeishuMessageSender(deps: FeishuMessageSenderDeps): FeishuMessageSender {
  async function run(input: FeishuSendInput): Promise<FeishuSendOutcome> {
    // N1: the delivery switch is on only for the exact text 'true'.
    if (safeFlag(deps.deliveryFlag) !== 'true') return notAttempted('flag_off')
    // N2: the capability decision must say effective, exactly.
    if (input.capabilityDecision?.effective !== true) return notAttempted('capability_off')
    // N3: the endpoint belongs to the connection whose credentials are used.
    if (input.endpoint.ref.connectionId !== input.connectionId) return notAttempted('endpoint_scope_mismatch')
    // N4: only open ids are addressed.
    if (input.endpoint.ref.idType !== 'open_id') return notAttempted('id_type_not_enabled')

    let row: FeishuSenderConnectionRow | null
    try {
      row = await deps.loadConnection(input.connectionId)
    } catch (error) {
      logger.warn(`Feishu connection could not be read (${feishuLogLabel(error)})`)
      return notAttempted('connection_unavailable')
    }
    if (row === null || (row.provider !== undefined && row.provider !== 'feishu')) return notAttempted('not_configured')
    const scope = feishuScopeOf(row)
    if (scope === null) return notAttempted('not_configured')
    // N5: the endpoint was written under the scope the connection has now.
    if (input.endpoint.anchor.tenant !== scope.tenant || input.endpoint.anchor.appScope !== scope.appScope) {
      return notAttempted('endpoint_anchor_stale')
    }
    // N6: the credentials are present and complete and the brand is in the closed set.
    const parsed = parseFeishuConfig(row.config)
    if (!parsed.ok) return notAttempted('not_configured')
    const appSecret = resolveFeishuAppSecret(parsed.settings, deps.decodeSecret)
    if (appSecret === null) return notAttempted('not_configured')
    // N7: there is something to send once the text is cut to the size that is sent.
    const text = truncateFeishuText(input.text)
    if (text.trim().length === 0) return notAttempted('empty_message')
    if (input.signal?.aborted) return notAttempted('aborted')

    // One key for every attempt of this call; an empty or missing key is replaced by a random one.
    const dedupeKey = typeof input.dedupeKey === 'string' && input.dedupeKey.length > 0 ? input.dedupeKey : randomUUID()
    const uuid = buildFeishuMessageUuid(input.connectionId, dedupeKey, feishuEndpointRefOf(input.endpoint))
    const result = await sendFeishuTextMessage(
      { tokens: deps.tokens, fetchFn: deps.fetchFn, signal: input.signal, transport: deps.transport },
      {
        credentials: { connectionId: input.connectionId, appId: parsed.settings.appId, appSecret, brand: parsed.settings.brand },
        receiveId: input.endpoint.ref.value,
        text,
        uuid,
      },
    )
    return classifyFeishuSend(result)
  }

  return {
    async sendFeishuText(input) {
      let outcome: FeishuSendOutcome
      try {
        outcome = await run(input)
      } catch (error) {
        // Never throws: a failure that is not a typed one may have come after the request was written.
        logger.warn(`Feishu text send failed unexpectedly (${feishuLogLabel(error)})`)
        outcome = unknown('network_error')
      }
      logOutcome(outcome)
      return outcome
    },
  }
}
