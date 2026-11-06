/**
 * Explicit verification of ONE DingTalk directory integration's work-notification credentials, the way the
 * integration-scoped send path resolves them — so an admin can check a chosen integration BEFORE that
 * resolution is switched on for deliveries.
 *
 * What is shared with the send path: readDingTalkIntegrationScopedMessageTuple (work-notification-settings.ts)
 * is the one export the switch-ON send branch calls for a named integration; this module calls the same
 * export and nothing else for resolution. This module does not read the switch, does not read the
 * environment itself and does not write it: its answer is the same whatever the switch says, and the send
 * path's answer for the same integration, once the switch is on, is this answer.
 *
 * Three levels of evidence, each strictly weaker than the next and never implying it:
 *   config — the tuple resolves (row read, one query, no network): which source would be used and that it
 *            is complete. Says nothing about DingTalk accepting it.
 *   token  — a gettoken minted NOW for the resolved appKey / appSecret / baseUrl, bypassing the shared token
 *            cache (not read, not written, not evicted, no in-flight request joined). Says nothing about the
 *            Agent ID.
 *   send   — one asyncsend_v2 to one explicit recipient with the resolved Agent ID. DingTalk ACCEPTING the
 *            request (errcode 0 with a task id) is what is reported; delivery to the device is not observed.
 * What NO level proves: that a given recipient's deliveries route to this integration (each sender maps
 * recipient → integration by its own rule), and nothing about the senders that resolve credentials by their
 * own rule (task notifications, e-learning notifications) or about the todo-mirror's todo API.
 * The report's `scope` sentences are chosen by the level the run REACHED (none / config / token / send), so
 * a report never says in words more than its structured fields say: a config-level pass does not mention
 * DingTalk accepting anything, and a send-level request that failed at the token step carries the config
 * sentences, not the send ones.
 *
 * Values-free by construction: the report carries booleans, lengths, ids, codes and fixed sentences; the
 * config-level failure sentence comes through classifyDirectoryFailureText with DingTalkMessageConfigError
 * as the one allowed class (its constructions are under the fixed-sentence constructor guard); token / send
 * failures carry the fixed sentence plus DingTalk's numeric code; the log gets the error's class name and
 * that code, never its message, stack or cause — a token failure's text can carry the gettoken URL with the
 * secret in it.
 */
import { randomBytes } from 'node:crypto'
import { createLogger } from '../../core/logger'
import { classifyDirectoryFailureText } from '../../directory/directory-failure-text'
import {
  fetchDingTalkAppAccessTokenFresh,
  isDingTalkOutcomeUnknown,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
} from './client'
import { DingTalkConfigValidationError, DingTalkMessageConfigError } from './config-validation-error'
import {
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
} from './transport'
import {
  readDingTalkIntegrationScopedMessageTuple,
  type DingTalkIntegrationScopedMessageTuple,
  type DingTalkMessageEnvPresence,
  type DingTalkMessageTupleSource,
} from './work-notification-settings'

const logger = createLogger('dingtalk-work-notification-verify')

export const DINGTALK_WORK_NOTIFICATION_VERIFY_LEVELS = ['config', 'token', 'send'] as const
export type DingTalkWorkNotificationVerifyLevel = (typeof DINGTALK_WORK_NOTIFICATION_VERIFY_LEVELS)[number]
export type DingTalkWorkNotificationVerifyReachedLevel = 'none' | DingTalkWorkNotificationVerifyLevel

export type DingTalkWorkNotificationVerifyInput = {
  /**
   * Required and explicit. A blank id is refused here, before any read (the shared reader would otherwise
   * fall back to the store's preferred row for an empty id); the route additionally requires UUID shape.
   */
  integrationId: string
  level: unknown
  /** Level send only; ignored (and reported as not attempted) at the other levels. */
  recipientUserId?: unknown
}

export type DingTalkWorkNotificationVerifyFailureCode =
  | DingTalkMessageConfigError['code']
  | 'token_rejected'
  | 'token_error_status'
  | 'token_incomplete_response'
  | 'token_malformed_response'
  | 'token_timeout'
  | 'token_network_error'
  | 'send_rejected'
  | 'send_error_status'
  | 'send_incomplete_response'
  | 'send_malformed_response'
  | 'send_timeout'
  | 'send_network_error'
  | 'send_outcome_unknown'
  | 'send_not_confirmed'

export type DingTalkWorkNotificationVerifyResult = {
  integrationId: string
  /** The row as resolved; null when resolution failed (the status face GET …/work-notification shows the row). */
  integration: DingTalkIntegrationScopedMessageTuple['integration'] | null
  requestedLevel: DingTalkWorkNotificationVerifyLevel
  reachedLevel: DingTalkWorkNotificationVerifyReachedLevel
  /** The verdict. The HTTP status of the report is 200 either way; read this field, not the status. */
  passed: boolean
  /**
   * Fixed sentences for the level this report REACHED (one pair per value of `reachedLevel`): what this run
   * established and what it did not. A config-level report never claims anything about DingTalk; a run that
   * failed above the level it reached carries the reached level's sentences.
   */
  scope: {
    proves: string
    doesNotProve: string
  }
  resolution: null | {
    source: DingTalkMessageTupleSource
    appKey: { configured: true; length: number; valuePrinted: false }
    appSecret: { configured: true; valuePrinted: false }
    agentId: { configured: true; length: number; valuePrinted: false }
    /** `parseable`: whether the configured value is an absolute http(s) URL (null when none is configured). Diagnostic only — it does not change `passed`; the send path would resolve this row the same way and fail at the token step. */
    baseUrl: { configured: boolean; parseable: boolean | null }
    /** Which env inputs were present when resolving (presence only). */
    environment: DingTalkMessageEnvPresence
  }
  /** `cacheBypassed`: true once a gettoken was requested (it bypassed the shared token cache); null when no token was requested by this run (level config, or resolution failed). */
  accessToken: { verified: boolean; cacheBypassed: true | null; valuePrinted: false }
  notification: {
    attempted: boolean
    /** true = DingTalk accepted the request (errcode 0 with a task id); 'unknown' = no usable confirmation; false = not accepted or not attempted. */
    accepted: boolean | 'unknown'
    recipientUserIdLength: number | null
    /** A short random run marker written into the test message, so the message on the device can be matched to this report. */
    verificationRunId: string | null
    taskId?: string
    requestId?: string
  }
  failure: null | {
    level: DingTalkWorkNotificationVerifyLevel
    code: DingTalkWorkNotificationVerifyFailureCode
    message: string
    providerCode?: number
    providerCodeKind?: 'errcode' | 'http_status'
  }
}

/**
 * One fixed pair of sentences per reached level. The `proves` sentence of a level states only what that
 * level observed; everything a higher level would add is listed under `doesNotProve`, together with what no
 * level proves. Pinned word for word by the verification tests.
 */
const SCOPE_NO_LEVEL_PROVES =
  'That any recipient routes to this integration (each sender maps recipient to integration by its own rule); anything about senders that resolve credentials by their own rule (task and e-learning notifications) or about the todo-mirror API.'
export const DINGTALK_WORK_NOTIFICATION_VERIFY_SCOPE: Readonly<
  Record<DingTalkWorkNotificationVerifyReachedLevel, Readonly<{ proves: string; doesNotProve: string }>>
> = Object.freeze({
  none: Object.freeze({
    proves: 'Nothing: the integration-scoped resolution did not yield a credential tuple for this integration (see failure). No request was made to DingTalk.',
    doesNotProve: `Anything about DingTalk accepting credentials or an Agent ID for this integration; delivery of any message to a device. ${SCOPE_NO_LEVEL_PROVES}`,
  }),
  config: Object.freeze({
    proves: 'The integration-scoped resolution yields a complete credential tuple for this integration, from the side resolution.source names.',
    doesNotProve: `That DingTalk issues a token for these credentials (level token); that DingTalk takes a work notification with this Agent ID (level send); delivery of any message to a device. ${SCOPE_NO_LEVEL_PROVES}`,
  }),
  token: Object.freeze({
    proves: 'DingTalk issued an access token, minted now with the shared token cache bypassed, for the appKey and appSecret the integration-scoped resolution chooses for this integration, at the resolved baseUrl.',
    doesNotProve: `That DingTalk takes a work notification with this Agent ID (level send); delivery of any message to a device. ${SCOPE_NO_LEVEL_PROVES}`,
  }),
  send: Object.freeze({
    proves: 'DingTalk accepted one work notification sent with the resolved Agent ID to the one explicit recipient (errcode 0 with a task id).',
    doesNotProve: `Delivery of the test message to the device (only acceptance is observed). ${SCOPE_NO_LEVEL_PROVES}`,
  }),
})

const TOKEN_FALLBACK = 'Access token was not obtained'
const SEND_FALLBACK = 'Test work notification was not accepted'
const SEND_OUTCOME_UNKNOWN_SENTENCE =
  'DingTalk did not confirm the outcome. The test message may still have been delivered — check the test message on the device before retrying.'
const SEND_NOT_CONFIRMED_SENTENCE = 'DingTalk answered without a task id; the test message was not confirmed as accepted'
const CONFIG_FALLBACK = 'Work-notification credentials were not resolved for the integration'

const RECIPIENT_USER_ID_RE = /^[^\s,]{1,64}$/

function readIntegrationId(value: unknown): string {
  const integrationId = typeof value === 'string' ? value.trim() : ''
  // No "preferred integration" fallback at this level: an empty id would make the shared reader pick the
  // store's preferred row, and the report would then be about an integration nobody named.
  if (!integrationId) throw new DingTalkConfigValidationError('integrationId is required')
  return integrationId
}

function readLevel(value: unknown): DingTalkWorkNotificationVerifyLevel {
  // Exact match only: no trim, no case folding ('SEND', ' send' are refused), so a client cannot reach the
  // send tier by accident of normalisation.
  if (typeof value === 'string' && (DINGTALK_WORK_NOTIFICATION_VERIFY_LEVELS as readonly string[]).includes(value)) {
    return value as DingTalkWorkNotificationVerifyLevel
  }
  throw new DingTalkConfigValidationError('level must be one of config, token, send')
}

function readRecipientUserId(value: unknown): string {
  const recipient = typeof value === 'string' ? value.trim() : ''
  if (!recipient) throw new DingTalkConfigValidationError('recipientUserId is required for level send')
  // The client joins userIds with ',' — a comma inside one value would address several people.
  if (!RECIPIENT_USER_ID_RE.test(recipient)) {
    throw new DingTalkConfigValidationError('recipientUserId must be a single DingTalk userid without commas or whitespace, at most 64 characters')
  }
  return recipient
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function describeResolution(tuple: DingTalkIntegrationScopedMessageTuple): NonNullable<DingTalkWorkNotificationVerifyResult['resolution']> {
  const { config } = tuple
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  return {
    source: tuple.source,
    appKey: { configured: true, length: config.appKey.length, valuePrinted: false },
    appSecret: { configured: true, valuePrinted: false },
    agentId: { configured: true, length: config.agentId.length, valuePrinted: false },
    baseUrl: { configured: baseUrl.length > 0, parseable: baseUrl.length > 0 ? isAbsoluteHttpUrl(baseUrl) : null },
    environment: tuple.environment,
  }
}

type ProviderFailureKind = 'rejected' | 'error_status' | 'incomplete_response' | 'malformed_response' | 'timeout' | 'network_error'

function providerFailureKind(error: unknown): ProviderFailureKind {
  if (error instanceof DingTalkBusinessError) return 'rejected'
  if (error instanceof DingTalkRequestError) return 'error_status'
  if (error instanceof DingTalkIncompleteResponseError) return 'incomplete_response'
  if (error instanceof DingTalkMalformedResponseError) return 'malformed_response'
  if (error instanceof DingTalkTimeoutError) return 'timeout'
  return 'network_error'
}

function errorClassName(error: unknown): string {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
  return typeof name === 'string' && name.length > 0 ? name : typeof error
}

/**
 * The only log line a provider failure gets: the level, the error's CLASS NAME and DingTalk's numeric code.
 * Never the message, stack or cause — for a gettoken failure they can carry the request URL, which holds
 * the app secret as a query parameter.
 */
function logProviderFailure(
  level: DingTalkWorkNotificationVerifyLevel,
  integrationId: string,
  error: unknown,
  providerCode: number | undefined,
  providerCodeKind: 'errcode' | 'http_status' | undefined,
): void {
  logger.warn('DingTalk work-notification verification provider failure', {
    integrationId,
    level,
    errorName: errorClassName(error),
    ...(providerCode !== undefined ? { providerCode, providerCodeKind } : {}),
  })
}

/** The one place `reachedLevel` advances: the scope sentences follow it, so the two cannot disagree. */
function markReached(result: DingTalkWorkNotificationVerifyResult, level: DingTalkWorkNotificationVerifyLevel): void {
  result.reachedLevel = level
  result.scope = { ...DINGTALK_WORK_NOTIFICATION_VERIFY_SCOPE[level] }
}

function buildVerificationContent(integrationId: string, runId: string): string {
  return `This message verifies the work-notification credentials resolved for directory integration ${integrationId} as the integration-scoped send path resolves them. Verification run ${runId}.`
}

export async function verifyDingTalkWorkNotificationIntegration(
  input: DingTalkWorkNotificationVerifyInput,
): Promise<DingTalkWorkNotificationVerifyResult> {
  const integrationId = readIntegrationId(input.integrationId)
  const requestedLevel = readLevel(input.level)
  // Validated before any I/O: a send-level request with a bad recipient is refused without a row read.
  const recipientUserId = requestedLevel === 'send' ? readRecipientUserId(input.recipientUserId) : null

  const result: DingTalkWorkNotificationVerifyResult = {
    integrationId,
    integration: null,
    requestedLevel,
    reachedLevel: 'none',
    passed: false,
    scope: { ...DINGTALK_WORK_NOTIFICATION_VERIFY_SCOPE.none },
    resolution: null,
    accessToken: { verified: false, cacheBypassed: null, valuePrinted: false },
    notification: {
      attempted: false,
      accepted: false,
      recipientUserIdLength: recipientUserId === null ? null : recipientUserId.length,
      verificationRunId: null,
    },
    failure: null,
  }

  // ── level config ──────────────────────────────────────────────────────────────────────────────────────
  let tuple: DingTalkIntegrationScopedMessageTuple
  try {
    tuple = await readDingTalkIntegrationScopedMessageTuple(integrationId)
  } catch (error) {
    // Only the resolver's typed verdicts are a report; a decryption or driver failure is the route's 400.
    if (!(error instanceof DingTalkMessageConfigError)) throw error
    const text = classifyDirectoryFailureText(error, { fallback: CONFIG_FALLBACK, fixedSentenceClasses: [DingTalkMessageConfigError] })
    result.failure = { level: 'config', code: error.code, message: text.text }
    return result
  }
  result.integration = tuple.integration
  result.resolution = describeResolution(tuple)
  markReached(result, 'config')
  if (requestedLevel === 'config') {
    result.passed = true
    return result
  }

  // ── level token ───────────────────────────────────────────────────────────────────────────────────────
  const config: DingTalkMessageConfig = tuple.config
  let accessToken: string
  // A gettoken is requested from here on, whatever its outcome; it bypasses the shared cache.
  result.accessToken.cacheBypassed = true
  try {
    accessToken = await fetchDingTalkAppAccessTokenFresh(config)
  } catch (error) {
    const text = classifyDirectoryFailureText(error, { fallback: TOKEN_FALLBACK })
    logProviderFailure('token', integrationId, error, text.providerCode, text.providerCodeKind)
    result.failure = {
      level: 'token',
      code: `token_${providerFailureKind(error)}`,
      message: text.text,
      ...(text.providerCode !== undefined ? { providerCode: text.providerCode, providerCodeKind: text.providerCodeKind } : {}),
    }
    return result
  }
  result.accessToken.verified = true
  markReached(result, 'token')
  if (requestedLevel === 'token') {
    result.passed = true
    return result
  }

  // ── level send ────────────────────────────────────────────────────────────────────────────────────────
  const runId = randomBytes(4).toString('hex')
  result.notification.attempted = true
  result.notification.verificationRunId = runId
  try {
    const sent = await sendDingTalkWorkNotification(
      accessToken,
      {
        userIds: [recipientUserId as string],
        title: 'MetaSheet DingTalk work notification verification',
        content: buildVerificationContent(integrationId, runId),
      },
      config,
    )
    if (sent.requestId) result.notification.requestId = sent.requestId
    if (!sent.taskId) {
      // errcode 0 without a task id: DingTalk did not confirm acceptance; the client does not throw for it.
      result.notification.accepted = 'unknown'
      result.failure = { level: 'send', code: 'send_not_confirmed', message: SEND_NOT_CONFIRMED_SENTENCE }
      return result
    }
    result.notification.taskId = sent.taskId
    result.notification.accepted = true
    markReached(result, 'send')
    result.passed = true
    return result
  } catch (error) {
    const text = classifyDirectoryFailureText(error, { fallback: SEND_FALLBACK })
    logProviderFailure('send', integrationId, error, text.providerCode, text.providerCodeKind)
    const providerCodeFields = text.providerCode !== undefined
      ? { providerCode: text.providerCode, providerCodeKind: text.providerCodeKind }
      : {}
    if (isDingTalkOutcomeUnknown(error)) {
      // Send tier: a timeout / network error / 5xx / unusable 2xx — the message may have been delivered.
      result.notification.accepted = 'unknown'
      result.failure = { level: 'send', code: 'send_outcome_unknown', message: SEND_OUTCOME_UNKNOWN_SENTENCE, ...providerCodeFields }
      return result
    }
    result.failure = { level: 'send', code: `send_${providerFailureKind(error)}`, message: text.text, ...providerCodeFields }
    return result
  }
}

/** The audit meta the route records: identifiers, levels, codes, lengths and booleans — never a value. */
export function buildDingTalkWorkNotificationVerifyAuditMeta(
  result: DingTalkWorkNotificationVerifyResult,
  recipientUserId: unknown,
): Record<string, unknown> {
  return {
    integrationId: result.integrationId,
    integrationName: result.integration?.name ?? null,
    requestedLevel: result.requestedLevel,
    reachedLevel: result.reachedLevel,
    passed: result.passed,
    failureLevel: result.failure?.level ?? null,
    failureCode: result.failure?.code ?? null,
    source: result.resolution?.source ?? null,
    agentIdLength: result.resolution?.agentId.length ?? null,
    agentIdValuePrinted: false,
    accessTokenVerified: result.accessToken.verified,
    notificationAttempted: result.notification.attempted,
    notificationAccepted: result.notification.accepted,
    verificationRunId: result.notification.verificationRunId,
    // The DingTalk userid is an identifier (the same kind the delivery ledgers hold), not a credential.
    recipientUserId: result.notification.attempted && typeof recipientUserId === 'string' ? recipientUserId.trim() : null,
  }
}
