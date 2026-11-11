/**
 * 通知服务实现
 * 支持多渠道通知发送，模板管理，订阅管理
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'eventemitter3'
import nodemailer from 'nodemailer'
import type {
  NotificationService,
  Notification,
  NotificationResult,
  NotificationRecipient,
  NotificationChannel,
  NotificationChannelConfig,
  NotificationTemplate,
  NotificationHistory,
  NotificationHistoryOptions,
  NotificationSubscription,
  NotificationPreferences
} from '../types/plugin'
import { Logger } from '../core/logger'
import { BackoffStrategy } from '../utils/BackoffStrategy'
import { maskDingTalkWebhookUrl } from '../integrations/dingtalk/runtime-policy'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  type DingTalkRobotPayload,
  DingTalkRobotResponseError,
  validateDingTalkRobotResponse,
} from '../integrations/dingtalk/robot'
import {
  redactEmailTransportText,
  resolveEmailTransportReadiness,
  resolveEmailSmtpTransportConfig,
  type EmailTransportEnv,
  type EmailTransportReadinessReport,
} from './email-transport-readiness'
import {
  NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON,
  NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON,
  NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON,
  NOTIFICATION_TRANSPORT_DISABLED_REASON,
  NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON,
  NOTIFICATION_TRANSPORT_SIMULATED_REASON,
} from './notification-delivery-outcome'
import type {
  FeishuCapabilityDecision,
  FeishuSendEndpoint,
  FeishuSendInput,
  FeishuSendOutcome,
} from './feishu-message-sender'

/**
 * Email notification payload
 */
interface EmailPayload {
  to: string
  subject: string
  content: string
  metadata?: Record<string, unknown>
}

interface EmailSmtpTransportOptions {
  host: string
  port: number
  secure: boolean
  auth: {
    user: string
    pass: string
  }
  connectionTimeout: number
  greetingTimeout: number
}

interface EmailSmtpSendMailOptions {
  from: string
  to: string
  subject: string
  text: string
  headers?: Record<string, string>
}

interface EmailSmtpTransport {
  sendMail(options: EmailSmtpSendMailOptions): Promise<unknown>
}

interface EmailSmtpTransportFactory {
  createTransport(options: EmailSmtpTransportOptions): EmailSmtpTransport
}

/**
 * Webhook notification payload
 */
interface WebhookPayload {
  subject: string
  content: string
  data?: unknown
  metadata?: Record<string, unknown>
}

function resolvePositiveInt(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(Math.trunc(numeric), min), max)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

class NonRetryableNotificationError extends Error {}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function postJsonWithRetry(options: {
  url: string
  headers?: Record<string, string>
  payload: unknown
  timeoutMs: number
  maxAttempts: number
  retryDelayMs: number
  logger: Logger
  context: string
  responseValidator?: (payload: unknown) => void
}): Promise<void> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MetaSheet-Notification-Service/1.0',
          ...(options.headers ?? {}),
        },
        body: JSON.stringify(options.payload),
        signal: AbortSignal.timeout(options.timeoutMs),
      })

      if (!response.ok) {
        const message = `HTTP ${response.status}: ${response.statusText}`
        if (attempt < options.maxAttempts && isRetryableStatus(response.status)) {
          const delay = BackoffStrategy.calculate(attempt, {
            type: 'exponential',
            initialDelay: options.retryDelayMs,
            maxDelay: Math.max(options.retryDelayMs, 5_000),
            jitter: true,
          })
          options.logger.warn(`${options.context} failed on attempt ${attempt}, retrying in ${delay}ms: ${message}`)
          await sleep(delay)
          continue
        }
        throw new NonRetryableNotificationError(message)
      }

      if (options.responseValidator) {
        const payload = await readJsonSafely(response)
        options.responseValidator(payload)
      }

      return
    } catch (error) {
      lastError = error as Error
      if (error instanceof NonRetryableNotificationError || error instanceof DingTalkRobotResponseError) {
        throw error
      }
      if (attempt >= options.maxAttempts) break
      const delay = BackoffStrategy.calculate(attempt, {
        type: 'exponential',
        initialDelay: options.retryDelayMs,
        maxDelay: Math.max(options.retryDelayMs, 5_000),
        jitter: true,
      })
      options.logger.warn(`${options.context} attempt ${attempt} failed, retrying in ${delay}ms`, {
        error: lastError,
      })
      await sleep(delay)
    }
  }

  throw lastError ?? new Error(`${options.context} failed`)
}

/**
 * 邮件通知渠道
 */
export class EmailNotificationChannel implements NotificationChannel {
  name = 'email'
  type = 'email' as const
  config: NotificationChannelConfig
  private logger: Logger
  private readiness: EmailTransportReadinessReport
  private env: EmailTransportEnv
  private smtpTransportFactory: EmailSmtpTransportFactory
  private smtpTransport: EmailSmtpTransport | null = null

  constructor(config: NotificationChannelConfig) {
    this.config = config
    this.logger = new Logger('EmailChannel')
    this.env = resolveEmailTransportEnv(config)
    this.readiness = resolveEmailTransportReadiness(this.env)
    this.smtpTransportFactory = resolveEmailSmtpTransportFactory(config)
  }

  /**
   * Result contract (see `NotificationResult`): `sent` only after the SMTP transport accepted every
   * email-type recipient (at least one); `simulated` in mock mode (no transport call); `cancelled` when
   * nothing is attempted (no email-type recipient, or transport disabled); `failed` for configuration
   * failures and transport errors, with `acceptedCount` naming how many recipients were accepted first.
   */
  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    const id = `email_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const emailRecipients = recipients.filter(r => r.type === 'email')
    const recipientCount = emailRecipients.length

    if (recipientCount === 0) {
      return {
        id,
        status: 'cancelled',
        metadata: {
          channel: 'email',
          reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON,
          recipientCount: 0,
        },
      }
    }

    const mode = this.readiness.mode
    if (mode === 'mock') {
      // Development simulation: no transport is touched, and the result says so.
      this.logger.info('Mock email transport simulated the notification; no email was sent', {
        channel: 'email',
        transport: 'mock',
        recipientCount,
      })
      return {
        id,
        status: 'simulated',
        metadata: {
          channel: 'email',
          transport: 'mock',
          reason: NOTIFICATION_TRANSPORT_SIMULATED_REASON,
          recipientCount,
        },
      }
    }
    if (mode === 'disabled') {
      return {
        id,
        status: 'cancelled',
        metadata: {
          channel: 'email',
          transport: 'disabled',
          reason: NOTIFICATION_TRANSPORT_DISABLED_REASON,
          recipientCount,
        },
      }
    }

    let acceptedCount = 0
    try {
      if (mode === 'unsupported') {
        throw new Error(`Email transport configuration is unsupported: ${this.readiness.messages.join(' ')}`)
      }
      if (!this.readiness.ok) {
        throw new Error(`SMTP email transport blocked: ${this.readiness.messages.join(' ')}`)
      }
      for (const recipient of emailRecipients) {
        await this.sendSmtpEmail({
          to: recipient.id,
          subject: notification.subject,
          content: notification.content,
          metadata: notification.metadata
        })
        acceptedCount += 1
      }

      return {
        id,
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          channel: 'email',
          transport: 'smtp',
          recipientCount,
          acceptedCount,
        }
      }
    } catch (error) {
      const failedReason = redactEmailTransportText(
        error instanceof Error ? error.message : String(error),
        this.env,
      )
      this.logger.error('Failed to send email notification', new Error(failedReason))
      return {
        id,
        status: 'failed',
        failedReason,
        metadata: {
          channel: 'email',
          recipientCount,
          acceptedCount,
        }
      }
    }
  }

  private async sendSmtpEmail(params: EmailPayload): Promise<void> {
    const smtpConfig = resolveEmailSmtpTransportConfig(this.env)
    const transport = this.smtpTransport ?? this.smtpTransportFactory.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.authUser,
        pass: smtpConfig.authPass,
      },
      connectionTimeout: smtpConfig.connectionTimeoutMs,
      greetingTimeout: smtpConfig.greetingTimeoutMs,
    })
    this.smtpTransport = transport

    await transport.sendMail({
      from: smtpConfig.from,
      to: params.to,
      subject: params.subject,
      text: params.content,
      headers: {
        'X-MetaSheet-Notification-Channel': 'email',
        'X-MetaSheet-Notification-Source': 'automation',
      },
    })
  }
}

function resolveEmailTransportEnv(config: NotificationChannelConfig): EmailTransportEnv {
  const candidate = config.env
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return process.env

  const env: EmailTransportEnv = {}
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function resolveEmailSmtpTransportFactory(config: NotificationChannelConfig): EmailSmtpTransportFactory {
  const candidate = config.smtpTransportFactory
  if (
    candidate &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    typeof (candidate as { createTransport?: unknown }).createTransport === 'function'
  ) {
    return candidate as EmailSmtpTransportFactory
  }

  return {
    createTransport(options) {
      return nodemailer.createTransport(options) as EmailSmtpTransport
    },
  }
}

/**
 * Webhook 通知渠道
 */
export class WebhookNotificationChannel implements NotificationChannel {
  name = 'webhook'
  type = 'webhook' as const
  config: NotificationChannelConfig
  private logger: Logger

  constructor(config: NotificationChannelConfig) {
    this.config = config
    this.logger = new Logger('WebhookChannel')
  }

  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    const id = `webhook_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    const webhookRecipients = recipients.filter(r => r.type === 'webhook')
    if (webhookRecipients.length === 0) {
      return {
        id,
        status: 'cancelled',
        metadata: {
          channel: 'webhook',
          reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON,
          recipientCount: 0,
        },
      }
    }

    try {
      for (const recipient of webhookRecipients) {
        await this.sendWebhook(recipient.id, {
          subject: notification.subject,
          content: notification.content,
          data: notification.data,
          metadata: notification.metadata
        })
      }

      return {
        id,
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          channel: 'webhook',
          recipientCount: webhookRecipients.length
        }
      }
    } catch (error) {
      this.logger.error('Failed to send webhook notification', error as Error)
      return {
        id,
        status: 'failed',
        failedReason: (error as Error).message,
        metadata: {
          channel: 'webhook'
        }
      }
    }
  }

  private async sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
    this.logger.info(`Sending webhook to ${url}`)
    await postJsonWithRetry({
      url,
      payload,
      timeoutMs: resolvePositiveInt(this.config.timeout, 10_000, 500, 60_000),
      maxAttempts: resolvePositiveInt(this.config.maxAttempts, 3, 1, 6),
      retryDelayMs: resolvePositiveInt(this.config.retryDelayMs, 750, 50, 10_000),
      logger: this.logger,
      context: `Webhook delivery failed for ${url}`,
    })
  }
}

/**
 * 钉钉机器人通知渠道
 */
export class DingTalkNotificationChannel implements NotificationChannel {
  name = 'dingtalk'
  type = 'dingtalk' as const
  config: NotificationChannelConfig
  private logger: Logger

  constructor(config: NotificationChannelConfig) {
    this.config = config
    this.logger = new Logger('DingTalkChannel')
  }

  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    const id = `dingtalk_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    try {
      const robotRecipients = recipients.filter((recipient) => recipient.type === 'webhook' || recipient.type === 'group')
      if (robotRecipients.length === 0) {
        throw new Error('DingTalk notification requires webhook/group recipients')
      }

      for (const recipient of robotRecipients) {
        const metadata = recipient.metadata as Record<string, unknown> | undefined
        const url = typeof metadata?.webhookUrl === 'string' && metadata.webhookUrl.trim().length > 0
          ? metadata.webhookUrl.trim()
          : recipient.id
        const secret = typeof metadata?.secret === 'string' && metadata.secret.trim().length > 0
          ? metadata.secret.trim()
          : typeof this.config.secret === 'string' && this.config.secret.trim().length > 0
            ? this.config.secret.trim()
            : undefined

        await this.sendRobotMessage(url, secret, buildDingTalkMarkdown(notification.subject, notification.content))
      }

      return {
        id,
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          channel: 'dingtalk',
          recipientCount: robotRecipients.length,
        },
      }
    } catch (error) {
      this.logger.error('Failed to send dingtalk notification', error as Error)
      return {
        id,
        status: 'failed',
        failedReason: (error as Error).message,
        metadata: {
          channel: 'dingtalk',
        },
      }
    }
  }

  private async sendRobotMessage(url: string, secret: string | undefined, payload: DingTalkRobotPayload): Promise<void> {
    const signedUrl = buildSignedDingTalkWebhookUrl(url, secret)
    const maskedUrl = maskDingTalkWebhookUrl(url)
    this.logger.info(`Sending dingtalk robot message to ${maskedUrl}`)
    await postJsonWithRetry({
      url: signedUrl,
      payload,
      timeoutMs: resolvePositiveInt(this.config.timeout, 10_000, 500, 60_000),
      maxAttempts: resolvePositiveInt(this.config.maxAttempts, 3, 1, 6),
      retryDelayMs: resolvePositiveInt(this.config.retryDelayMs, 750, 50, 10_000),
      logger: this.logger,
      context: `DingTalk delivery failed for ${maskedUrl}`,
      responseValidator: validateDingTalkRobotResponse,
    })
  }
}

/** What the channel needs to know about a notification topic: only topics in the closed set are known. */
export interface FeishuChannelTopic {
  /** True once the topic's business path is wired to routing and carries its own business authorisation. */
  integrated: boolean
}

export type FeishuChannelEndpointResult =
  | {
      kind: 'found'
      connectionId: string
      endpoint: FeishuSendEndpoint
      /** A stored second endpoint of the same user. This channel never sends to it: no result redirects a send. */
      backup?: { connectionId: string; endpoint: FeishuSendEndpoint }
    }
  | { kind: 'none' }

/**
 * The collaborators of the real path of {@link FeishuNotificationChannel}. The names are provisional
 * until the routing allow-set and endpoint resolver exist; the semantics are fixed:
 *  - the allow-set decides, for an organisation, a topic and local user ids, which users may be sent to;
 *  - the endpoint resolver returns the stored endpoint of a LOCAL user id, never a Feishu identifier that
 *    the notification carried.
 */
export interface FeishuChannelDeps {
  /** The raw value of the delivery switch. */
  deliveryFlag(): string | undefined
  /** The topic from the closed topic set, or null when the topic is not in it. */
  resolveTopic(topic: string): FeishuChannelTopic | null | Promise<FeishuChannelTopic | null>
  resolveAllowSet(input: { orgId: string; topic: string; userIds: readonly string[] }): Promise<ReadonlySet<string>>
  resolveEndpoint(input: { orgId: string; userId: string }): Promise<FeishuChannelEndpointResult>
  resolveCapability(connectionId: string): Promise<FeishuCapabilityDecision>
  sender: { sendFeishuText(input: FeishuSendInput): Promise<FeishuSendOutcome> }
  sleep?(ms: number): Promise<void>
  newDedupeKey?(): string
}

/** Minimum gap between two sends on one connection. */
export const FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS = 200

/** What became of one addressed user: not allowed, without an endpoint, or the outcome of the send core. */
type FeishuRecipientState =
  | { kind: 'not_allowed' }
  | { kind: 'not_bound' }
  | { kind: 'outcome'; outcome: FeishuSendOutcome }

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : 'non-error'
}

/**
 * 飞书通知渠道
 *
 * Constructed with `{}` and no collaborators it has no sender: it reports `failed` with a stable reason,
 * makes no call and no wait. Constructed with collaborators it sends text to LOCAL users:
 *  - a recipient of type `user` carries a local user id; no Feishu identifier supplied by a caller (in the
 *    notification metadata or anywhere else) is read;
 *  - a recipient is sent to only when the topic is in the closed set and integrated, the organisation is
 *    known, the allow-set names the user and the user has a stored endpoint;
 *  - `sent` means the provider accepted EVERY addressed recipient; a recipient that was not allowed, had
 *    no endpoint, was refused, or whose result is unknown is not accepted, so the result is `failed`;
 *  - an unknown outcome is never repeated and never redirected;
 *  - there is no ledger here: a caller that retries after `failed` must treat it as an unknown outcome.
 */
export class FeishuNotificationChannel implements NotificationChannel {
  name = 'feishu'
  type = 'feishu' as const
  config: NotificationChannelConfig
  private logger: Logger
  private deps: FeishuChannelDeps | undefined

  constructor(config: NotificationChannelConfig, deps?: FeishuChannelDeps) {
    this.config = config
    this.deps = deps ?? undefined
    this.logger = new Logger('FeishuChannel')
  }

  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    if (this.deps !== undefined) return this.sendWithDeps(this.deps, notification, recipients)

    const id = `feishu_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const userRecipients = recipients.filter(r => r.type === 'user')

    this.logger.warn('Feishu notification channel has no sender configured; nothing was sent', {
      channel: 'feishu',
      recipientCount: userRecipients.length,
    })

    return {
      id,
      status: 'failed',
      failedReason: 'feishu transport is not configured',
      metadata: {
        channel: 'feishu',
        reason: NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON,
        recipientCount: userRecipients.length,
      },
    }
  }

  private cancelled(id: string, reason: string, recipientCount: number): NotificationResult {
    this.logger.info('Feishu notification cancelled', { channel: 'feishu', reason, recipientCount })
    return { id, status: 'cancelled', metadata: { channel: 'feishu', reason, recipientCount } }
  }

  private async sendWithDeps(
    deps: FeishuChannelDeps,
    notification: Notification,
    recipients: NotificationRecipient[],
  ): Promise<NotificationResult> {
    const id = `feishu_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
    const userIds = [...new Set(recipients.filter(r => r.type === 'user').map(r => r.id))]
    const recipientCount = userIds.length
    if (recipientCount === 0) return this.cancelled(id, NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON, 0)

    let flag: string | undefined
    try {
      flag = deps.deliveryFlag()
    } catch {
      flag = undefined
    }
    if (flag !== 'true') return this.cancelled(id, NOTIFICATION_TRANSPORT_DISABLED_REASON, recipientCount)

    const metadata = notification.metadata ?? {}
    const topic = typeof metadata.topic === 'string' && metadata.topic.length > 0 ? metadata.topic : null
    let topicInfo: FeishuChannelTopic | null = null
    if (topic !== null) {
      try {
        topicInfo = await deps.resolveTopic(topic)
      } catch (error) {
        this.logger.warn(`Feishu topic lookup failed (${errorLabel(error)})`)
      }
    }
    if (topic === null || topicInfo === null || topicInfo.integrated !== true) {
      return this.cancelled(id, NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON, recipientCount)
    }

    const orgId = typeof metadata.orgId === 'string' && metadata.orgId.length > 0 ? metadata.orgId : null
    if (orgId === null) return this.cancelled(id, NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON, recipientCount)

    let allowed: ReadonlySet<string> = new Set()
    try {
      allowed = await deps.resolveAllowSet({ orgId, topic, userIds })
    } catch (error) {
      this.logger.warn(`Feishu allow-set lookup failed (${errorLabel(error)})`)
    }
    const allowedUserIds = userIds.filter(userId => allowed.has(userId))
    if (allowedUserIds.length === 0) return this.cancelled(id, NOTIFICATION_RECIPIENTS_NOT_ALLOWED_REASON, recipientCount)

    const dedupeKey =
      typeof notification.id === 'string' && notification.id.length > 0
        ? notification.id
        : (deps.newDedupeKey?.() ?? randomUUID())
    const text = [notification.subject, notification.content]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .join('\n')
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
    const capabilities = new Map<string, FeishuCapabilityDecision>()
    const sentOn = new Set<string>()
    const states: FeishuRecipientState[] = userIds.filter(userId => !allowed.has(userId)).map(() => ({ kind: 'not_allowed' }))

    for (const userId of allowedUserIds) {
      let found: FeishuChannelEndpointResult = { kind: 'none' }
      try {
        found = await deps.resolveEndpoint({ orgId, userId })
      } catch (error) {
        this.logger.warn(`Feishu endpoint lookup failed (${errorLabel(error)})`)
      }
      if (found.kind !== 'found') {
        states.push({ kind: 'not_bound' })
        continue
      }

      let decision = capabilities.get(found.connectionId)
      if (decision === undefined) {
        try {
          decision = await deps.resolveCapability(found.connectionId)
        } catch (error) {
          this.logger.warn(`Feishu capability lookup failed (${errorLabel(error)})`)
          decision = { effective: false, reason: 'read_failed' }
        }
        capabilities.set(found.connectionId, decision)
      }

      // The endpoint term of the request key: local user, then the evidence the resolver names, then the open id.
      const endpoint: FeishuSendEndpoint = { ...found.endpoint, evidence: [userId, ...(found.endpoint.evidence ?? [])] }
      if (sentOn.has(found.connectionId)) await sleep(FEISHU_CHANNEL_MIN_SEND_INTERVAL_MS)
      let outcome: FeishuSendOutcome
      try {
        outcome = await deps.sender.sendFeishuText({
          connectionId: found.connectionId,
          endpoint,
          text,
          dedupeKey,
          capabilityDecision: decision,
        })
      } catch (error) {
        // The sender does not throw; if one does, the message may have been written.
        this.logger.warn(`Feishu sender failed unexpectedly (${errorLabel(error)})`)
        outcome = { kind: 'unknown', reason: 'network_error' }
      }
      if (outcome.kind !== 'not_attempted') sentOn.add(found.connectionId)
      states.push({ kind: 'outcome', outcome })
    }

    return this.aggregate(id, recipientCount, states)
  }

  private aggregate(id: string, recipientCount: number, states: FeishuRecipientState[]): NotificationResult {
    const outcomes = states.flatMap(state => (state.kind === 'outcome' ? [state.outcome] : []))
    const acceptedCount = outcomes.filter(outcome => outcome.kind === 'accepted').length
    const unknownCount = outcomes.filter(outcome => outcome.kind === 'unknown').length
    const requestedCount = outcomes.filter(outcome => outcome.kind !== 'not_attempted').length
    this.logger.info('Feishu notification finished', { channel: 'feishu', recipientCount, acceptedCount, unknownCount })

    if (requestedCount === 0) {
      const notAttemptedReasons = new Set<string>(
        outcomes.flatMap(outcome => (outcome.kind === 'not_attempted' ? [outcome.reason] : [])),
      )
      const hasAny = (...reasons: string[]): boolean => reasons.some(reason => notAttemptedReasons.has(reason))
      if (hasAny('not_configured', 'empty_message', 'aborted')) {
        return {
          id,
          status: 'failed',
          failedReason: 'feishu send was not attempted for every recipient',
          metadata: { channel: 'feishu', recipientCount, acceptedCount, unknownCount, sendOutcome: 'rejected' },
        }
      }
      if (hasAny('flag_off', 'capability_off')) return this.cancelled(id, NOTIFICATION_TRANSPORT_DISABLED_REASON, recipientCount)
      return this.cancelled(id, NOTIFICATION_RECIPIENTS_NOT_BOUND_REASON, recipientCount)
    }

    if (acceptedCount === recipientCount) {
      return { id, status: 'sent', sentAt: new Date(), metadata: { channel: 'feishu', recipientCount, acceptedCount } }
    }
    return {
      id,
      status: 'failed',
      failedReason:
        unknownCount > 0
          ? 'feishu did not confirm the send for at least one recipient'
          : 'feishu send was not accepted for every recipient',
      metadata: {
        channel: 'feishu',
        recipientCount,
        acceptedCount,
        unknownCount,
        sendOutcome: unknownCount > 0 ? 'unknown' : 'rejected',
      },
    }
  }
}

/**
 * 通知服务实现
 */
export class NotificationServiceImpl extends EventEmitter implements NotificationService {
  private channels = new Map<string, NotificationChannel>()
  private templates = new Map<string, NotificationTemplate>()
  private history: NotificationHistory[] = []
  private subscriptions = new Map<string, NotificationSubscription[]>()
  private logger: Logger

  constructor() {
    super()
    this.logger = new Logger('NotificationService')

    // 注册默认通知渠道
    this.registerChannel(new EmailNotificationChannel({}))
    this.registerChannel(new WebhookNotificationChannel({}))
    this.registerChannel(new DingTalkNotificationChannel({}))
    this.registerChannel(new FeishuNotificationChannel({}))
  }

  async send(notification: Notification): Promise<NotificationResult> {
    try {
      const channelName = notification.channel || 'email'
      const channel = this.channels.get(channelName)
      if (!channel) {
        throw new Error(`Unknown notification channel: ${channelName}`)
      }

      // 过滤收件人的通知偏好
      const filteredRecipients = await this.filterRecipientsByPreferences(
        notification.recipients,
        channelName
      )

      if (filteredRecipients.length === 0) {
        const result: NotificationResult = {
          id: `skip_${Date.now()}`,
          status: 'cancelled',
          metadata: {
            reason: 'No recipients after preference filtering'
          }
        }

        this.addToHistory({
          id: result.id,
          notification,
          result,
          createdAt: new Date()
        })

        return result
      }

      // 检查是否需要延迟发送
      if (notification.scheduledAt && notification.scheduledAt > new Date()) {
        return this.scheduleNotification(notification, filteredRecipients)
      }

      // 立即发送
      const result = await channel.sender(notification, filteredRecipients)

      // 记录历史
      this.addToHistory({
        id: result.id,
        notification: { ...notification, recipients: filteredRecipients },
        result,
        createdAt: new Date()
      })

      this.emit('notification:sent', { notification, result })
      return result

    } catch (error) {
      this.logger.error('Failed to send notification', error as Error)

      const result: NotificationResult = {
        id: `error_${Date.now()}`,
        status: 'failed',
        failedReason: (error as Error).message
      }

      this.addToHistory({
        id: result.id,
        notification,
        result,
        createdAt: new Date()
      })

      this.emit('notification:error', { notification, error })
      return result
    }
  }

  async sendBatch(notifications: Notification[]): Promise<NotificationResult[]> {
    const results: NotificationResult[] = []

    for (const notification of notifications) {
      try {
        const result = await this.send(notification)
        results.push(result)
      } catch (error) {
        results.push({
          id: `batch_error_${Date.now()}`,
          status: 'failed',
          failedReason: (error as Error).message
        })
      }
    }

    this.emit('notification:batch:sent', { notifications, results })
    return results
  }

  async sendTemplate(
    templateName: string,
    recipients: NotificationRecipient[],
    data: Record<string, unknown>
  ): Promise<NotificationResult> {
    const template = this.templates.get(templateName)
    if (!template) {
      throw new Error(`Unknown notification template: ${templateName}`)
    }

    // 渲染模板
    const subject = this.renderTemplate(template.subject, data)
    const content = this.renderTemplate(template.content, data)

    const notification: Notification = {
      channel: template.channel,
      recipients,
      subject,
      content,
      data,
      metadata: {
        template: templateName,
        ...template.metadata
      }
    }

    return this.send(notification)
  }

  registerChannel(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel)
    this.logger.info(`Registered notification channel: ${channel.name}`)
  }

  getChannels(): NotificationChannel[] {
    return Array.from(this.channels.values())
  }

  registerTemplate(template: NotificationTemplate): void {
    this.templates.set(template.name, template)
    this.logger.info(`Registered notification template: ${template.name}`)
  }

  getTemplate(name: string): NotificationTemplate | null {
    return this.templates.get(name) || null
  }

  async getHistory(options: NotificationHistoryOptions = {}): Promise<NotificationHistory[]> {
    let filtered = [...this.history]

    if (options.userId) {
      filtered = filtered.filter(h =>
        h.notification && h.notification.recipients.some(r => r.id === options.userId)
      )
    }

    if (options.channel) {
      filtered = filtered.filter(h => h.notification && h.notification.channel === options.channel)
    }

    if (options.status) {
      filtered = filtered.filter(h => h.result && h.result.status === options.status)
    }

    if (options.dateFrom) {
      filtered = filtered.filter(h => h.createdAt && h.createdAt >= options.dateFrom!)
    }

    if (options.dateTo) {
      filtered = filtered.filter(h => h.createdAt && h.createdAt <= options.dateTo!)
    }

    // 分页
    const offset = options.offset || 0
    const limit = options.limit || 100

    return filtered
      .sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0))
      .slice(offset, offset + limit)
  }

  async subscribe(
    userId: string,
    channel: string,
    preferences: NotificationPreferences
  ): Promise<void> {
    const userSubscriptions = this.subscriptions.get(userId) || []

    // 移除已存在的同渠道订阅
    const filtered = userSubscriptions.filter(s => s.channel !== channel)

    // 添加新订阅
    const subscription: NotificationSubscription = {
      userId,
      channel,
      preferences,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    filtered.push(subscription)
    this.subscriptions.set(userId, filtered)

    this.emit('notification:subscribed', { userId, channel, preferences })
    this.logger.info(`User ${userId} subscribed to ${channel} channel`)
  }

  async unsubscribe(userId: string, channel: string): Promise<void> {
    const userSubscriptions = this.subscriptions.get(userId) || []
    const filtered = userSubscriptions.filter(s => s.channel !== channel)

    if (filtered.length !== userSubscriptions.length) {
      this.subscriptions.set(userId, filtered)
      this.emit('notification:unsubscribed', { userId, channel })
      this.logger.info(`User ${userId} unsubscribed from ${channel} channel`)
    }
  }

  async getSubscriptions(userId: string): Promise<NotificationSubscription[]> {
    return this.subscriptions.get(userId) || []
  }

  private async filterRecipientsByPreferences(
    recipients: NotificationRecipient[],
    channel: string
  ): Promise<NotificationRecipient[]> {
    const filtered: NotificationRecipient[] = []

    for (const recipient of recipients) {
      // 检查用户订阅偏好
      if (recipient.type === 'user') {
        const subscriptions = await this.getSubscriptions(recipient.id)
        const subscription = subscriptions.find(s => s.channel === channel)

        if (subscription && subscription.preferences && !subscription.preferences.enabled) {
          continue // 跳过已禁用通知的用户
        }

        // 检查静默时间
        if (subscription?.preferences?.quiet_hours) {
          const now = new Date()
          const quietHours = subscription.preferences.quiet_hours

          if (this.isInQuietHours(now, quietHours)) {
            continue // 跳过静默时间内的通知
          }
        }
      }

      filtered.push(recipient)
    }

    return filtered
  }

  private isInQuietHours(
    now: Date,
    quietHours: { start: string; end: string; timezone?: string }
  ): boolean {
    // 简化的静默时间检查实现
    const currentTime = now.toTimeString().substring(0, 5) // HH:MM format

    if (quietHours.start <= quietHours.end) {
      return currentTime >= quietHours.start && currentTime <= quietHours.end
    } else {
      // 跨天的情况
      return currentTime >= quietHours.start || currentTime <= quietHours.end
    }
  }

  private async scheduleNotification(
    notification: Notification,
    recipients: NotificationRecipient[]
  ): Promise<NotificationResult> {
    const id = `scheduled_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    // 这里应该集成到调度服务中
    const delay = notification.scheduledAt!.getTime() - Date.now()

    setTimeout(async () => {
      try {
        const channelName = notification.channel || 'email'
        const channel = this.channels.get(channelName)
        if (channel) {
          const result = await channel.sender(notification, recipients)
          this.emit('notification:scheduled:sent', { notification, result })
        }
      } catch (error) {
        this.emit('notification:scheduled:error', { notification, error })
      }
    }, delay)

    const result: NotificationResult = {
      id,
      status: 'pending',
      metadata: {
        scheduledAt: notification.scheduledAt,
        delay
      }
    }

    this.addToHistory({
      id,
      notification: { ...notification, recipients },
      result,
      createdAt: new Date()
    })

    return result
  }

  private renderTemplate(template: string, data: Record<string, unknown>): string {
    // 简单的模板渲染实现
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = data[key]
      return value !== undefined && value !== null ? String(value) : match
    })
  }

  private addToHistory(history: NotificationHistory): void {
    this.history.unshift(history)

    // 保持历史记录在合理范围内
    const maxHistorySize = 10000
    if (this.history.length > maxHistorySize) {
      this.history = this.history.slice(0, maxHistorySize)
    }
  }

  /**
   * 获取服务统计信息
   */
  getStats(): {
    channels: number
    templates: number
    historySize: number
    subscriptions: number
  } {
    return {
      channels: this.channels.size,
      templates: this.templates.size,
      historySize: this.history.length,
      subscriptions: Array.from(this.subscriptions.values()).reduce(
        (total, subs) => total + subs.length,
        0
      )
    }
  }

  /**
   * 清理历史记录
   */
  cleanHistory(beforeDate: Date): void {
    const originalSize = this.history.length
    this.history = this.history.filter(h => h.createdAt && h.createdAt >= beforeDate)
    const cleaned = originalSize - this.history.length

    if (cleaned > 0) {
      this.logger.info(`Cleaned ${cleaned} notification history entries`)
    }
  }
}

// Re-export removed in Phase A to avoid duplicate export conflicts under isolatedModules
export const notificationService = new NotificationServiceImpl()
