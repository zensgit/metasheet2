/**
 * DingTalk work-notification channel for task notifications (M4 PR-3b design
 * `docs/development/task-m4-pr3b-backend-design-20261001.md` §8).
 *
 * `prepare` has no side effect towards the recipient. In order:
 *   1. the recipient's DingTalk identity through the org-bound identity join (link → account →
 *      active integration of the delivery row's own org). No row is told apart by one more read of
 *      that org's integration rows (none at all / none active / active but this user not bound);
 *      two rows are an identity-data anomaly;
 *   2. the app configuration from the integration row that produced the identity, and from nowhere
 *      else (key, secret, agent id, base URL);
 *   3. the base URL, normalised the way the DingTalk client normalises it (blank ⇒ the default host,
 *      trimmed, no trailing slash), must pass `isAllowedTaskDingTalkBaseUrl`; that same string is what
 *      the token request and the send use. A refused URL ends the row and nothing is requested;
 *   4. the app token, each request bounded by TASK_DINGTALK_REQUEST_TIMEOUT_MS; the channel waits
 *      for it at most TASK_DELIVERY_PREPARE_BUDGET_MS (the fetch is raced against the budget here,
 *      so a token request shared with another caller can neither stretch the budget nor be cut
 *      short by it), and a fetch that outlives the budget ends the row as `dingtalk_token_unavailable`;
 *   5. the identity and configuration read again and compared with the first read, so the time the
 *      token took never lets a send use a stale destination.
 * It returns a fixed-code result that ends the row before the fence, or a `send` closure holding
 * exactly one external call. After that call only a determinate rejection is `retryable` or
 * `failed`; a response without a task id, a call the transport marks as of unknown outcome, and
 * anything that cannot be classified are `outcomeUnknown` (never sent again).
 *
 * Error text (the worker writes it to `last_error`): before the fence a fixed code only — a token
 * failure's own text may carry the token URL with its secret, so it is dropped. After the fence a
 * fixed code, the HTTP status or errcode as a number where there is one, and the transport's message
 * after redaction (ASSUMPTION(task-m4): [own-3b-34] [own-3b-40]), in this order: the message is cut
 * to TASK_DINGTALK_ERROR_RAW_MAX_LENGTH characters before anything else runs on it (bounded work on
 * untrusted text), and a cut that lands inside one of the values below drops the value's leading
 * part too; every value the closure holds is removed, longest first and as plain text (token, app
 * key, app secret, agent id, the recipient's DingTalk id, the title, the content, each content line
 * and each quoted user-text fragment, each of two characters or more); then secret query
 * parameters, `key=value` / `key: value` / `"key":"value"` secrets and `Bearer` tokens, URLs and
 * host names (a scheme with optional user-info, a dotted host with a letter top label or an IPv4
 * literal, an optional port and path) are replaced; control and format characters (C0, DEL, C1,
 * the line and paragraph separators, zero-width and bidi controls) become spaces; the result is
 * cut to 240 UTF-16 code units (neither cut lands between the halves of a surrogate pair). The
 * rule covers exactly the value forms and patterns listed: a transformed copy of a value (a
 * truncated line, a JSON-escaped or case-changed form), a URL outside the pattern (a bracketed
 * IPv6 literal, a dot-less host with a port, an IDN host, a host with a format character inside
 * it: the URL rule runs before the control-character replacement) and a secret the closure does
 * not hold in another key or quote shape are outside it and are recorded as known limitations in
 * design §8.5. The transport's own log line for a rejected call of this channel carries the status and
 * a fixed note, not the upstream message (`logUpstreamMessage: false`).
 *
 * ASSUMPTION(task-m4): [D4] [own-3b-18] the identity branches and their fixed codes. [own-3b-19]
 * the app configuration comes only from the integration row that produced the identity.
 * [own-3b-21] the outbound base URL allowlist.
 */
import { query as defaultQuery } from '../db/pg'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  isDingTalkOutcomeUnknown,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationInput,
  type DingTalkWorkNotificationResult,
} from '../integrations/dingtalk/client'
import { isDingTalkFlowControlErrcode } from '../integrations/dingtalk/transport'
import { normalizeDingTalkWorkNotificationAgentId } from '../integrations/dingtalk/work-notification-settings'
import { decryptStoredSecretValue } from '../security/encrypted-secrets'
import {
  isAllowedTaskDingTalkBaseUrl,
  TASK_DELIVERY_PREPARE_BUDGET_MS,
  TASK_DINGTALK_REQUEST_TIMEOUT_MS,
  type TaskDeliveryChannelResult,
} from '../tasks/task-delivery-protocol'
import { TASK_NOTIFICATION_CHANNEL_DINGTALK } from '../tasks/task-notifications'
import type { TaskDeliveryMessage } from '../tasks/task-notification-text'
import type {
  TaskDeliveryChannel,
  TaskDeliveryPrepared,
  TaskDeliveryPrepareTarget,
  TaskDeliveryQuery,
} from './task-notification-delivery-worker'

/** The fixed codes this channel puts at the start of every error it returns. */
export const TASK_DINGTALK_CHANNEL_CODES = Object.freeze({
  orgIntegrationMissing: 'dingtalk_org_integration_missing',
  orgIntegrationInactive: 'dingtalk_org_integration_inactive',
  recipientNotBound: 'dingtalk_recipient_not_bound',
  recipientAmbiguous: 'dingtalk_recipient_ambiguous',
  configUnavailable: 'dingtalk_config_unavailable',
  baseUrlRejected: 'dingtalk_base_url_rejected',
  tokenUnavailable: 'dingtalk_token_unavailable',
  destinationChanged: 'dingtalk_destination_changed',
  sendResponseInvalid: 'dingtalk_send_response_invalid',
  sendOutcomeUnknown: 'dingtalk_send_outcome_unknown',
  sendRequestRejected: 'dingtalk_request',
  sendBusinessError: 'dingtalk_business_error',
  sendUnclassified: 'dingtalk_send_unclassified',
} as const)

/** The host the DingTalk client uses when an integration stores no base URL. */
export const TASK_DINGTALK_DEFAULT_BASE_URL = 'https://oapi.dingtalk.com'

const ERROR_TEXT_MAX_LENGTH = 240
/** The most of a transport message the redaction looks at; the rest is dropped unread. */
export const TASK_DINGTALK_ERROR_RAW_MAX_LENGTH = 4096
const REDACTED = '[redacted]'

interface OutboundCallOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** `false`: the transport logs the status of a rejected call with a fixed note, not the upstream message. */
  logUpstreamMessage?: boolean
}

type FetchAccessToken = (config: DingTalkMessageConfig, options?: OutboundCallOptions) => Promise<string>
type SendWorkNotification = (
  accessToken: string,
  input: DingTalkWorkNotificationInput,
  config: DingTalkMessageConfig,
  options?: OutboundCallOptions,
) => Promise<DingTalkWorkNotificationResult>

export interface DingTalkTaskDeliveryChannelOptions {
  /** Statement runner for the identity and integration reads; default `db/pg.ts#query`. */
  query?: TaskDeliveryQuery
  fetchAccessToken?: FetchAccessToken
  sendWorkNotification?: SendWorkNotification
}

interface Destination {
  integrationId: string
  dingTalkUserId: string
  config: DingTalkMessageConfig & { baseUrl: string }
}

type Lookup = { ok: true; destination: Destination } | { ok: false; result: TaskDeliveryChannelResult }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function skip(error: string): TaskDeliveryChannelResult {
  return { ok: false, retryable: false, skip: true, error }
}

function failed(error: string): TaskDeliveryChannelResult {
  return { ok: false, retryable: false, error }
}

function retryable(error: string): TaskDeliveryChannelResult {
  return { ok: false, retryable: true, error }
}

function parseConfig(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readSecret(value: unknown): string {
  const stored = text(value)
  return stored ? decryptStoredSecretValue(stored).trim() : ''
}

/** The base URL as the DingTalk client will use it: blank ⇒ the default host; trimmed; no trailing slash. */
export function normalizeTaskDingTalkBaseUrl(value: unknown): string {
  const trimmed = text(value)
  return (trimmed.length > 0 ? trimmed : TASK_DINGTALK_DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/**
 * The app configuration stored on one integration row, or `null` when any part is missing or
 * unreadable. ASSUMPTION(task-m4): [own-3b-19] no other source is consulted.
 */
function readIntegrationConfig(raw: unknown): (DingTalkMessageConfig & { baseUrl: string }) | null {
  const config = parseConfig(raw)
  if (!config) return null
  try {
    const appKey = text(config.appKey)
    const appSecret = readSecret(config.appSecret)
    const agentId = normalizeDingTalkWorkNotificationAgentId(readSecret(config.workNotificationAgentId ?? config.agentId))
    if (!appKey || !appSecret || !agentId) return null
    return { appKey, appSecret, agentId, baseUrl: normalizeTaskDingTalkBaseUrl(config.baseUrl) }
  } catch {
    return null
  }
}

/** `promise`, or a rejection once `budget` aborts first; the abort listener is detached either way. */
function withinBudget<T>(promise: Promise<T>, budget: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('task dingtalk prepare budget exceeded'))
    if (budget.aborted) {
      onAbort()
      return
    }
    budget.addEventListener('abort', onAbort, { once: true })
    const done = (): void => budget.removeEventListener('abort', onAbort)
    promise.then(
      (value) => {
        done()
        resolve(value)
      },
      (error: unknown) => {
        done()
        reject(error as Error)
      },
    )
  })
}

function sameDestination(a: Destination, b: Destination): boolean {
  return a.integrationId === b.integrationId
    && a.dingTalkUserId === b.dingTalkUserId
    && a.config.appKey === b.config.appKey
    && a.config.appSecret === b.config.appSecret
    && a.config.agentId === b.config.agentId
    && a.config.baseUrl === b.config.baseUrl
}

// ── Error text (the redaction the channel owes the worker's `last_error`) ────────────────────────

const SECRET_KEYS = 'access_token|accessToken|appkey|appKey|appsecret|appSecret|app_secret|client_secret|clientSecret'
const SECRET_PARAM_RE = new RegExp(`([?&](?:${SECRET_KEYS})=)[^&\\s'")]+`, 'gi')
const SECRET_PAIR_RE = new RegExp(`("?(?:${SECRET_KEYS})"?\\s*[:=]\\s*"?)[^&\\s'")]+`, 'gi')
const BEARER_RE = /(bearer\s+)[a-z0-9._~+\/=-]+/gi
const URL_RE = /(?:https?:\/\/(?:[^\s\/@'"]+@)?)?(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/[^\s'")]*)?/gi
// Control and format characters: C0, DEL and C1 (\p{Cc}), the line and paragraph separators, the
// zero-width and bidi format characters and the byte-order mark; the ranges are built from code
// points so the source holds none of these characters.
const FORMAT_CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [[0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
const CONTROL_RE = new RegExp(
  `[\\p{Cc}${FORMAT_CONTROL_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]+`,
  'gu',
)
const QUOTED_USER_TEXT_RE = /「([^」]*)」/g

/** Every value of a send that must never appear in its error text. */
function sensitiveValues(input: { accessToken: string; config: DingTalkMessageConfig; dingTalkUserId: string; message: TaskDeliveryMessage }): string[] {
  const { message } = input
  const values = [
    input.accessToken, input.config.appKey, input.config.appSecret, input.config.agentId, input.dingTalkUserId, message.title, message.content,
  ]
  for (const line of message.content.split('\n')) values.push(line.trim())
  for (const match of message.content.matchAll(QUOTED_USER_TEXT_RE)) values.push(match[1])
  return [...new Set(values.filter((value) => value.length >= 2))].sort((a, b) => b.length - a.length)
}

/**
 * `text` without a tail that is the leading part of one of `values`: when the raw cut lands inside
 * a value, the part of the value before the cut would otherwise survive the replacement.
 */
function withoutValuePrefixTail(text: string, values: readonly string[]): string {
  let cut = text.length
  for (const value of values) {
    const window = text.slice(Math.max(0, text.length - (value.length - 1)))
    for (let at = 0; at < window.length; at += 1) {
      if (window[at] !== value[0]) continue
      const length = window.length - at
      if (text.endsWith(value.slice(0, length))) {
        cut = Math.min(cut, text.length - length)
        break
      }
    }
  }
  return text.slice(0, cut)
}

/** `text` cut to at most `max` UTF-16 code units, never between the two halves of a surrogate pair. */
function cutCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

/**
 * The transport's message cut to TASK_DINGTALK_ERROR_RAW_MAX_LENGTH before anything else, then
 * with every listed value (longest first), secret parameter, secret pair, bearer token, URL and
 * host removed, control and format characters turned into spaces, cut to 240 code units; neither
 * cut splits a surrogate pair.
 */
export function redactTaskDingTalkErrorText(raw: string, values: readonly string[]): string {
  const bounded = raw.length > TASK_DINGTALK_ERROR_RAW_MAX_LENGTH
    ? withoutValuePrefixTail(cutCodeUnits(raw, TASK_DINGTALK_ERROR_RAW_MAX_LENGTH), values)
    : raw
  let out = bounded
  for (const value of values) {
    if (value.length > 0) out = out.split(value).join(REDACTED)
  }
  out = out
    .replace(SECRET_PARAM_RE, `$1${REDACTED}`)
    .replace(SECRET_PAIR_RE, `$1${REDACTED}`)
    .replace(BEARER_RE, `$1${REDACTED}`)
    .replace(URL_RE, '[redacted-url]')
    .replace(CONTROL_RE, ' ')
    .trim()
  return out.length > ERROR_TEXT_MAX_LENGTH ? `${cutCodeUnits(out, ERROR_TEXT_MAX_LENGTH - 3)}...` : out
}

function withDetail(code: string, raw: unknown, values: readonly string[]): string {
  const message = raw instanceof Error ? raw.message : ''
  const detail = redactTaskDingTalkErrorText(message, values)
  return detail.length > 0 ? `${code}: ${detail}` : code
}

function errcodeOf(body: Record<string, unknown> | null): number | null {
  if (!body) return null
  for (const key of ['errcode', 'code']) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600)
}

const RETRYABLE_BUSINESS_TEXT_RE = /rate.?limit|too many|throttl|system busy|server busy|temporar|timeout|timed out|try again|retry|busy|限流|频繁|繁忙|超时|稍后|重试|系统异常|服务异常/i

/**
 * Design §8.4: the classification of an error thrown by the one send. A call the transport marks as
 * of unknown outcome comes first (a 5xx on a send is such a call); then a rejected HTTP status and
 * a DingTalk business error, each retryable only when it says so; anything else is of unknown
 * outcome, since an error that cannot be recognised does not prove the request was not sent.
 */
export function classifyTaskDingTalkSendError(error: unknown, values: readonly string[]): TaskDeliveryChannelResult {
  const codes = TASK_DINGTALK_CHANNEL_CODES
  if (isDingTalkOutcomeUnknown(error)) {
    return { ok: false, retryable: false, outcomeUnknown: true, error: withDetail(codes.sendOutcomeUnknown, error, values) }
  }
  if (error instanceof DingTalkRequestError) {
    return {
      ok: false,
      retryable: isRetryableStatus(error.statusCode),
      error: withDetail(`${codes.sendRequestRejected}_${error.statusCode}`, error, values),
    }
  }
  if (error instanceof DingTalkBusinessError) {
    const errcode = errcodeOf(error.responseBody)
    const errmsg = typeof error.responseBody?.errmsg === 'string' ? error.responseBody.errmsg : ''
    const retry = (errcode !== null && isDingTalkFlowControlErrcode(errcode)) || RETRYABLE_BUSINESS_TEXT_RE.test(`${error.message} ${errmsg}`)
    return { ok: false, retryable: retry, error: withDetail(`${codes.sendBusinessError}_${errcode ?? 'unknown'}`, error, values) }
  }
  return { ok: false, retryable: false, outcomeUnknown: true, error: withDetail(codes.sendUnclassified, error, values) }
}

// ── The channel ──────────────────────────────────────────────────────────────────────────────────

export class DingTalkTaskDeliveryChannel implements TaskDeliveryChannel {
  readonly name = TASK_NOTIFICATION_CHANNEL_DINGTALK
  private readonly query: TaskDeliveryQuery
  private readonly fetchAccessToken: FetchAccessToken
  private readonly sendWorkNotification: SendWorkNotification

  constructor(options: DingTalkTaskDeliveryChannelOptions = {}) {
    this.query = options.query ?? ((sql, params) => defaultQuery(sql, params))
    this.fetchAccessToken = options.fetchAccessToken ?? fetchDingTalkAppAccessToken
    this.sendWorkNotification = options.sendWorkNotification ?? sendDingTalkWorkNotification
  }

  async prepare(target: TaskDeliveryPrepareTarget): Promise<TaskDeliveryPrepared> {
    const codes = TASK_DINGTALK_CHANNEL_CODES
    const first = await this.lookup(target)
    if (first.ok === false) return { ok: false, result: first.result }
    const destination = first.destination
    // ASSUMPTION(task-m4): [own-3b-21] nothing is requested from a host outside the allowlist.
    if (!isAllowedTaskDingTalkBaseUrl(destination.config.baseUrl)) {
      return { ok: false, result: failed(codes.baseUrlRejected) }
    }

    // The budget is enforced here, by racing the fetch against it: the client shares one in-flight
    // token request between callers, so a signal passed into it would govern (or be ignored by)
    // another caller's request. The fetch keeps its own per-request timeout.
    let accessToken: string
    try {
      accessToken = text(await withinBudget(
        this.fetchAccessToken(destination.config, { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false }),
        AbortSignal.timeout(TASK_DELIVERY_PREPARE_BUDGET_MS),
      ))
    } catch {
      return { ok: false, result: retryable(codes.tokenUnavailable) }
    }
    if (!accessToken) return { ok: false, result: retryable(codes.tokenUnavailable) }

    const second = await this.lookup(target)
    if (second.ok === false || !sameDestination(destination, second.destination)) {
      return { ok: false, result: retryable(codes.destinationChanged) }
    }

    return {
      ok: true,
      send: async (message: TaskDeliveryMessage): Promise<TaskDeliveryChannelResult> => {
        const values = sensitiveValues({ accessToken, config: destination.config, dingTalkUserId: destination.dingTalkUserId, message })
        let response: DingTalkWorkNotificationResult
        try {
          response = await this.sendWorkNotification(
            accessToken,
            { userIds: [destination.dingTalkUserId], title: message.title, content: message.content },
            destination.config,
            { timeoutMs: TASK_DINGTALK_REQUEST_TIMEOUT_MS, logUpstreamMessage: false },
          )
        } catch (error) {
          return classifyTaskDingTalkSendError(error, values)
        }
        if (!text(response?.taskId)) {
          return { ok: false, retryable: false, outcomeUnknown: true, error: codes.sendResponseInvalid }
        }
        return { ok: true }
      },
    }
  }

  /** Steps 1 and 2: the org-bound identity and the configuration of the same integration row. */
  private async lookup(target: TaskDeliveryPrepareTarget): Promise<Lookup> {
    const codes = TASK_DINGTALK_CHANNEL_CODES
    const { rows } = await this.query(
      `SELECT i.id::text AS integration_id, a.external_user_id, i.config AS integration_config
         FROM directory_account_links l
         JOIN directory_accounts a
           ON a.id = l.directory_account_id AND a.provider = 'dingtalk' AND a.is_active = true
         JOIN directory_integrations i
           ON i.id = a.integration_id AND i.provider = 'dingtalk' AND i.status = 'active' AND i.org_id = $2
        WHERE l.local_user_id = $1 AND l.link_status = 'linked'
        ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
        LIMIT 2`,
      [target.recipientUserId, target.orgId],
    )
    if (rows.length === 0) {
      // ASSUMPTION(task-m4): [D4] [own-3b-18] three different reasons for no identity, each skipped.
      const integrations = await this.query(
        `SELECT status FROM directory_integrations WHERE org_id = $1 AND provider = 'dingtalk'`,
        [target.orgId],
      )
      if (integrations.rows.length === 0) return { ok: false, result: skip(codes.orgIntegrationMissing) }
      if (!integrations.rows.some((row) => row.status === 'active')) return { ok: false, result: skip(codes.orgIntegrationInactive) }
      return { ok: false, result: skip(codes.recipientNotBound) }
    }
    if (rows.length > 1) return { ok: false, result: failed(codes.recipientAmbiguous) }
    const [row] = rows
    const dingTalkUserId = text(row.external_user_id)
    if (!dingTalkUserId) return { ok: false, result: skip(codes.recipientNotBound) }
    const config = readIntegrationConfig(row.integration_config)
    if (!config) return { ok: false, result: retryable(codes.configUnavailable) }
    return { ok: true, destination: { integrationId: String(row.integration_id), dingTalkUserId, config } }
  }
}
