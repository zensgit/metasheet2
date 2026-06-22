import { randomBytes } from 'crypto'
import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationResult,
} from '../integrations/dingtalk/client'
import {
  readDingTalkMessageConfigFromRuntime,
} from '../integrations/dingtalk/work-notification-settings'
import nodemailer from 'nodemailer'
import {
  resolveEmailSmtpTransportConfig,
  resolveEmailTransportReadiness,
  redactEmailTransportText,
  type EmailSmtpTransportConfig,
} from './email-transport-readiness'

/**
 * C5-2 delivery worker.
 *
 * Consumes `attendance_notification_deliveries` outbox rows, claims due rows with a short lease, sends
 * each row through its named channel, and writes per-delivery status. This worker is the first component
 * allowed to turn C5 outbox rows into sends; source producers must only insert rows.
 */

export type AttendanceNotificationDeliveryQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface AttendanceDeliveryMessage {
  id: string
  orgId: string
  sourceType: string
  sourceId: string | null
  sourceKey: string
  recipientUserId: string
  recipientRole: string
  channel: string
  payload: Record<string, unknown>
}

export type AttendanceDeliveryChannelResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string }

export interface AttendanceDeliveryChannel {
  readonly name: string
  send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult>
}

export interface AttendanceNotificationDeliveryWorkerOptions {
  query?: AttendanceNotificationDeliveryQuery
  channels?: AttendanceDeliveryChannel[]
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  workerId?: string
  now?: () => Date
  logger?: Logger
}

export interface DingTalkAttendanceDeliveryChannelOptions {
  query?: AttendanceNotificationDeliveryQuery
  readConfig?: (integrationId?: string) => Promise<DingTalkMessageConfig>
  fetchAccessToken?: (config: DingTalkMessageConfig) => Promise<string>
  sendWorkNotification?: (
    accessToken: string,
    input: { userIds: string[]; title: string; content: string },
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>
}

export interface AttendanceNotificationDeliveryResult {
  claimed: number
  sent: number
  retrying: number
  failed: number
  lostLease?: number
}

interface DeliveryRow {
  id: string
  org_id: string
  source_type: string
  source_id: string | null
  source_key: string
  recipient_user_id: string
  recipient_role: string
  channel: string
  attempt_count: number | string
  payload: unknown
}

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 200
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 10 * 60_000
export const DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME = 'dingtalk_work_notification'
export const EMAIL_SMTP_CHANNEL_NAME = 'email_smtp'

export function clampDeliveryBatchSize(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(n)))
}

export function clampDeliveryLeaseMs(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MS
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(n)))
}

export function computeDeliveryBackoffMs(attemptCount: number): number {
  if (attemptCount <= 1) return 60_000
  if (attemptCount === 2) return 5 * 60_000
  if (attemptCount === 3) return 15 * 60_000
  if (attemptCount === 4) return 60 * 60_000
  return 6 * 60 * 60_000
}

export class DeterministicFakeAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const mode = String(message.payload.fakeDelivery ?? message.payload.deliveryMode ?? 'ok')
    if (mode === 'retry' || mode === 'retryable_failure') {
      return { ok: false, retryable: true, error: 'fake_retryable_failure' }
    }
    if (mode === 'fail' || mode === 'non_retryable_failure') {
      return { ok: false, retryable: false, error: 'fake_non_retryable_failure' }
    }
    return { ok: true }
  }
}

export function createAttendanceDeliveryChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): AttendanceDeliveryChannel[] {
  // Accumulate every enabled channel (the worker routes each delivery row by `row.channel` name, so
  // channels coexist). Each is independently env-gated + default-off.
  const channels: AttendanceDeliveryChannel[] = []
  if (env.ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED === 'true') {
    channels.push(new DingTalkAttendanceDeliveryChannel())
  } else if (env.ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED === 'true') {
    // Fake registers ONLY when the real in-app channel is not enabled (preserve real-over-fake
    // precedence; both gates accidentally on → real wins). Email below is a distinct channel and
    // coexists with whichever in-app channel is active (the worker routes by `row.channel` name).
    channels.push(new DeterministicFakeAttendanceDeliveryChannel())
  }
  // Email: register ONLY when explicitly enabled AND SMTP transport is actually configured+ready
  // (else an at-least-once retry would spin against an unconfigured transport — register-nothing instead).
  if (
    env.ATTENDANCE_NOTIFICATION_EMAIL_ENABLED === 'true' &&
    resolveEmailTransportReadiness(env).mode === 'smtp' &&
    resolveEmailTransportReadiness(env).ok
  ) {
    channels.push(new EmailAttendanceDeliveryChannel({ env }))
  }
  return channels
}

interface DingTalkRecipientRow {
  integration_id: string
  external_user_id: string
}

export class DingTalkAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly readConfig: (integrationId?: string) => Promise<DingTalkMessageConfig>
  private readonly fetchAccessToken: (config: DingTalkMessageConfig) => Promise<string>
  private readonly sendWorkNotification: (
    accessToken: string,
    input: { userIds: string[]; title: string; content: string },
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>

  constructor(options: DingTalkAttendanceDeliveryChannelOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.readConfig = options.readConfig ?? readDingTalkMessageConfigFromRuntime
    this.fetchAccessToken = options.fetchAccessToken ?? fetchDingTalkAppAccessToken
    this.sendWorkNotification = options.sendWorkNotification ?? sendDingTalkWorkNotification
  }

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const recipient = await this.resolveRecipient(message)
    if (recipient.ok === false) return recipient.result

    let config: DingTalkMessageConfig
    try {
      config = await this.readConfig(recipient.integrationId)
    } catch (error) {
      return classifyConfigError(error)
    }

    try {
      const accessToken = await this.fetchAccessToken(config)
      await this.sendWorkNotification(
        accessToken,
        {
          userIds: [recipient.dingTalkUserId],
          title: buildDeliveryTitle(message),
          content: buildDeliveryContent(message),
        },
        config,
      )
      return { ok: true }
    } catch (error) {
      return classifyDingTalkSendError(error)
    }
  }

  private async resolveRecipient(message: AttendanceDeliveryMessage): Promise<
    | { ok: true; integrationId: string; dingTalkUserId: string }
    | { ok: false; result: AttendanceDeliveryChannelResult }
  > {
    const { rows } = await this.query<DingTalkRecipientRow>(
      `SELECT i.id::text AS integration_id,
              a.external_user_id
         FROM directory_account_links l
         JOIN directory_accounts a
           ON a.id = l.directory_account_id
          AND a.provider = 'dingtalk'
          AND a.is_active = true
         JOIN directory_integrations i
           ON i.id = a.integration_id
          AND i.provider = 'dingtalk'
          AND i.status = 'active'
          AND i.org_id = $2
        WHERE l.local_user_id = $1
          AND l.link_status = 'linked'
        ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
        LIMIT 2`,
      [message.recipientUserId, message.orgId],
    )
    if (rows.length === 0) {
      return {
        ok: false,
        result: { ok: false, retryable: false, error: 'dingtalk_recipient_not_bound' },
      }
    }
    if (rows.length > 1) {
      return {
        ok: false,
        result: { ok: false, retryable: false, error: 'dingtalk_recipient_ambiguous' },
      }
    }
    const dingTalkUserId = String(rows[0].external_user_id ?? '').trim()
    if (!dingTalkUserId) {
      return {
        ok: false,
        result: { ok: false, retryable: false, error: 'dingtalk_recipient_external_user_id_missing' },
      }
    }
    return {
      ok: true,
      integrationId: rows[0].integration_id,
      dingTalkUserId,
    }
  }
}

export class AttendanceNotificationDeliveryWorker {
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly channelsByName: Map<string, AttendanceDeliveryChannel>
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly workerId: string
  private readonly now: () => Date
  private readonly logger: Logger
  private running = false

  constructor(options: AttendanceNotificationDeliveryWorkerOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.channelsByName = new Map((options.channels ?? []).map((channel) => [channel.name, channel]))
    this.batchSize = clampDeliveryBatchSize(options.batchSize)
    this.leaseMs = clampDeliveryLeaseMs(options.leaseMs)
    this.maxAttempts = Number.isFinite(Number(options.maxAttempts)) && Number(options.maxAttempts) > 0
      ? Math.floor(Number(options.maxAttempts))
      : DEFAULT_MAX_ATTEMPTS
    this.workerId = options.workerId ?? `attendance-delivery:${process.pid}:${randomBytes(4).toString('hex')}`
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('AttendanceNotificationDeliveryWorker')
  }

  async claimDueDeliveries(): Promise<DeliveryRow[]> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<DeliveryRow>(
      `WITH claim AS (
         SELECT id
           FROM attendance_notification_deliveries
          WHERE (
                  status IN ('pending','retrying')
              AND next_attempt_at <= $1::timestamptz
            )
             OR (
                  status = 'sending'
              AND claim_expires_at <= $1::timestamptz
            )
          ORDER BY COALESCE(next_attempt_at, claim_expires_at) ASC, created_at ASC
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE attendance_notification_deliveries d
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                last_attempt_at = $1::timestamptz,
                claimed_at = $1::timestamptz,
                claim_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
                claim_worker_id = $4,
                updated_at = $1::timestamptz
           FROM claim
          WHERE d.id = claim.id
          RETURNING d.id::text AS id,
                    d.org_id,
                    d.source_type,
                    d.source_id,
                    d.source_key,
                    d.recipient_user_id,
                    d.recipient_role,
                    d.channel,
                    d.attempt_count,
                    d.payload
       )
       SELECT *
         FROM claimed
        ORDER BY id`,
      [asOf, this.batchSize, this.leaseMs, this.workerId],
    )
    return rows
  }

  async runBatch(): Promise<AttendanceNotificationDeliveryResult> {
    if (this.running) return { claimed: 0, sent: 0, retrying: 0, failed: 0 }
    this.running = true
    const result: AttendanceNotificationDeliveryResult = { claimed: 0, sent: 0, retrying: 0, failed: 0 }
    try {
      const rows = await this.claimDueDeliveries()
      result.claimed = rows.length
      let lostLease = 0
      for (const row of rows) {
        const outcome = await this.deliver(row)
        if (outcome === 'sent') result.sent += 1
        else if (outcome === 'retrying') result.retrying += 1
        else if (outcome === 'failed') result.failed += 1
        else lostLease += 1
      }
      if (lostLease > 0) {
        result.lostLease = lostLease
      }
      if (result.claimed > 0) {
        this.logger.info(`Attendance deliveries claimed=${result.claimed} sent=${result.sent} retrying=${result.retrying} failed=${result.failed} lostLease=${lostLease}`)
      }
      return result
    } finally {
      this.running = false
    }
  }

  private async deliver(row: DeliveryRow): Promise<'sent' | 'retrying' | 'failed' | 'lost-lease'> {
    const channel = this.channelsByName.get(row.channel)
    const attemptCount = Number(row.attempt_count)
    if (!channel) {
      return await this.markFailed(row.id, 'attendance_delivery_channel_not_configured', attemptCount)
        ? 'failed'
        : 'lost-lease'
    }

    const message: AttendanceDeliveryMessage = {
      id: row.id,
      orgId: row.org_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceKey: row.source_key,
      recipientUserId: row.recipient_user_id,
      recipientRole: row.recipient_role,
      channel: row.channel,
      payload: parsePayload(row.payload),
    }

    let channelResult: AttendanceDeliveryChannelResult
    try {
      channelResult = await channel.send(message)
    } catch (error) {
      channelResult = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
    }

    if (channelResult.ok) {
      return await this.markSent(row.id, attemptCount) ? 'sent' : 'lost-lease'
    }

    const failure = channelResult as Extract<AttendanceDeliveryChannelResult, { ok: false }>
    if (!failure.retryable || attemptCount >= this.maxAttempts) {
      return await this.markFailed(row.id, failure.error, attemptCount) ? 'failed' : 'lost-lease'
    }

    return await this.markRetrying(row.id, failure.error, attemptCount) ? 'retrying' : 'lost-lease'
  }

  private async markSent(id: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'sent',
              delivered_at = $2::timestamptz,
              last_error = NULL,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markRetrying(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now()
    const next = new Date(now.getTime() + computeDeliveryBackoffMs(attemptCount)).toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'retrying',
              next_attempt_at = $2::timestamptz,
              last_error = $3,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $4::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $5
          AND attempt_count = $6::int`,
      [id, next, error.slice(0, 1000), now.toISOString(), this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markFailed(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'failed',
              last_error = $2,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $3::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $4
          AND attempt_count = $5::int`,
      [id, error.slice(0, 1000), now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return value as Record<string, unknown>
}

function normalizePayloadText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildDeliveryTitle(message: AttendanceDeliveryMessage): string {
  const title = normalizePayloadText(message.payload.title)
  if (title) return title
  if (message.sourceType === 'comp_time_expiry_reminder') return 'Comp-time expiry reminder'
  if (message.sourceType === 'unscheduled_reminder') return 'Unscheduled shift reminder'
  return 'Attendance notification'
}

function buildDeliveryContent(message: AttendanceDeliveryMessage): string {
  const body = normalizePayloadText(message.payload.body)
  if (body) return body
  const content = normalizePayloadText(message.payload.content)
  if (content) return content
  return `Attendance notification source: ${message.sourceType}`
}

function normalizeErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = redactDingTalkErrorText(raw.trim() || fallback)
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function redactDingTalkErrorText(text: string): string {
  const redactedSecrets = text
    .replace(/([?&](?:access_token|accessToken|appkey|appKey|appsecret|appSecret|app_secret|client_secret|clientSecret)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/((?:access_token|accessToken|appkey|appKey|appsecret|appSecret|app_secret|client_secret|clientSecret)\s*[:=]\s*)[^&\s'")]+/gi, '$1[redacted]')
  return redactedSecrets.replace(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s'")]*)?/gi, '[redacted-url]')
}

function classifyConfigError(error: unknown): AttendanceDeliveryChannelResult {
  const message = normalizeErrorText(error, 'DingTalk work-notification config unavailable')
  const retryable = !/not configured|required|not found|Agent ID/i.test(message)
  return { ok: false, retryable, error: `dingtalk_work_notification_config_unavailable: ${message}` }
}

function isRetryableDingTalkBusinessError(error: DingTalkBusinessError): boolean {
  const code = readDingTalkErrorNumber(error.responseBody, 'errcode', 'code', 'statusCode', 'status')
  if (code !== null && isRetryableDingTalkErrorCode(code)) return true
  const responseText = typeof error.responseBody?.errmsg === 'string' ? error.responseBody.errmsg : ''
  const message = `${error.message} ${responseText}`.toLowerCase()
  return /rate.?limit|too many|throttl|system busy|server busy|temporar|timeout|timed out|try again|retry|busy|限流|频繁|繁忙|超时|稍后|重试|系统异常|服务异常/i.test(message)
}

function readDingTalkErrorNumber(body: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!body) return null
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return null
}

function isRetryableDingTalkErrorCode(code: number): boolean {
  return code === 408 || code === 429 || (code >= 500 && code < 600) || code === 50001
}

function classifyDingTalkSendError(error: unknown): AttendanceDeliveryChannelResult {
  if (error instanceof DingTalkRequestError) {
    return {
      ok: false,
      retryable: isRetryableDingTalkErrorCode(error.statusCode),
      error: `dingtalk_request_${error.statusCode}: ${normalizeErrorText(error, 'DingTalk request failed')}`,
    }
  }
  if (error instanceof DingTalkBusinessError) {
    return {
      ok: false,
      retryable: isRetryableDingTalkBusinessError(error),
      error: `dingtalk_business_error: ${normalizeErrorText(error, 'DingTalk business error')}`,
    }
  }
  return {
    ok: false,
    retryable: true,
    error: `dingtalk_send_failed: ${normalizeErrorText(error, 'DingTalk send failed')}`,
  }
}

// ── Email (SMTP) delivery channel ───────────────────────────────────────────────
// A second AttendanceDeliveryChannel beside the in-app work-notification channel. Sends the SAME
// delivery content over SMTP, reusing the app's existing email transport config + readiness. Env-gated
// + default-off (see createAttendanceDeliveryChannelsFromEnv). Recipient email resolved from users.email.

export interface EmailDeliveryTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    text: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

export interface EmailAttendanceDeliveryChannelOptions {
  query?: AttendanceNotificationDeliveryQuery
  env?: NodeJS.ProcessEnv
  createTransport?: (config: EmailSmtpTransportConfig) => EmailDeliveryTransport
}

function defaultEmailTransportFactory(config: EmailSmtpTransportConfig): EmailDeliveryTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.authUser, pass: config.authPass },
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
  }) as unknown as EmailDeliveryTransport
}

export class EmailAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = EMAIL_SMTP_CHANNEL_NAME
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly env: NodeJS.ProcessEnv
  private readonly createTransport: (config: EmailSmtpTransportConfig) => EmailDeliveryTransport
  private transport: EmailDeliveryTransport | null = null

  constructor(options: EmailAttendanceDeliveryChannelOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.env = options.env ?? process.env
    this.createTransport = options.createTransport ?? defaultEmailTransportFactory
  }

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    // 1. Resolve recipient email — STRICTLY scoped to the delivery's org (tenant boundary). The user
    //    must be active AND an active member of message.orgId. Email is EXTERNAL egress, so this is
    //    fail-closed: the producer / deliveries table does not prove recipient↔org membership, so a
    //    bare `users.id` lookup could send cross-tenant. No matching active org-member row → permanent
    //    (non-retryable), do NOT send. A lookup error is transient (retryable); no row (missing email /
    //    inactive user / not a member of this org) is permanent (dead-letter, no spin).
    let email: string
    try {
      const { rows } = await this.query<{ email: string | null }>(
        `SELECT u.email
           FROM users u
           JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $2 AND uo.is_active = true
          WHERE u.id = $1 AND u.is_active = true`,
        [message.recipientUserId, message.orgId],
      )
      email = (rows[0]?.email ?? '').trim()
    } catch (error) {
      return { ok: false, retryable: true, error: `email_recipient_lookup_failed: ${normalizeEmailErrorText(error, 'recipient lookup failed', this.env)}` }
    }
    if (!email) {
      return { ok: false, retryable: false, error: 'email_recipient_unresolved: no active org-member email for this recipient in the delivery org' }
    }

    // 2. Resolve SMTP config. resolveEmailSmtpTransportConfig throws when transport is not smtp-mode or
    //    readiness is blocked → a permanent config error (non-retryable).
    let config: EmailSmtpTransportConfig
    try {
      config = resolveEmailSmtpTransportConfig(this.env)
    } catch (error) {
      return { ok: false, retryable: false, error: `email_smtp_config_unavailable: ${normalizeEmailErrorText(error, 'SMTP config unavailable', this.env)}` }
    }

    // 3. Send. Subject/body come from the SHARED content helpers (one content source; no per-channel drift).
    try {
      const transport = this.transport ?? this.createTransport(config)
      this.transport = transport
      await transport.sendMail({
        from: config.from,
        to: email,
        subject: buildDeliveryTitle(message),
        text: buildDeliveryContent(message),
        headers: {
          'X-MetaSheet-Notification-Channel': EMAIL_SMTP_CHANNEL_NAME,
          'X-MetaSheet-Notification-Source': message.sourceType,
        },
      })
      return { ok: true }
    } catch (error) {
      return classifyEmailSendError(error, this.env)
    }
  }
}

function normalizeEmailErrorText(error: unknown, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  // Scrub the configured SMTP host/user/password/from + token/password patterns — the password could
  // otherwise surface verbatim in an SMTP transport error string written to the delivery record.
  const text = redactEmailTransportText(raw.trim() || fallback, env)
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function classifyEmailSendError(error: unknown, env: NodeJS.ProcessEnv = process.env): AttendanceDeliveryChannelResult {
  const responseCode =
    typeof (error as { responseCode?: unknown } | null)?.responseCode === 'number'
      ? (error as { responseCode: number }).responseCode
      : null
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code.toUpperCase()
      : ''
  let retryable: boolean
  if (responseCode !== null) {
    // SMTP reply codes: 4xx = transient (greylist / rate / try-later) → retry; 5xx = permanent → dead-letter.
    retryable = responseCode >= 400 && responseCode < 500
  } else if (/^(ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNRESET|ENOTFOUND|EDNS|ECONNECTION|ETLS|EHOSTUNREACH|EPIPE)$/.test(code)) {
    retryable = true
  } else if (/^(EAUTH|EENVELOPE|EMESSAGE)$/.test(code)) {
    retryable = false
  } else {
    // Unknown failure: retry (bounded by the worker's max-attempts → dead-letter); never silently drop.
    retryable = true
  }
  const suffix = responseCode !== null ? `_${responseCode}` : code ? `_${code.toLowerCase()}` : ''
  return { ok: false, retryable, error: `email_send_failed${suffix}: ${normalizeEmailErrorText(error, 'email send failed', env)}` }
}
