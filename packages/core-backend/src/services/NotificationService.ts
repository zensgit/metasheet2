/**
 * 通知服务实现
 * 支持多渠道通知发送，模板管理，订阅管理
 */

import { createHmac } from 'node:crypto'
import { EventEmitter } from 'eventemitter3'
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

/**
 * Email notification payload
 */
interface EmailPayload {
  to: string
  subject: string
  content: string
  metadata?: Record<string, unknown>
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

/**
 * Feishu message payload
 */
interface FeishuMessagePayload {
  title: string
  content: string
  data?: unknown
}

interface DingTalkRobotPayload {
  msgtype: 'markdown'
  markdown: {
    title: string
    text: string
  }
}

interface DingTalkRobotResponse {
  errcode?: number
  errmsg?: string
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

function validateDingTalkRobotResponse(payload: unknown): void {
  const data = payload as DingTalkRobotResponse | null
  if (!data || typeof data !== 'object') return
  const errcode = typeof data.errcode === 'number' ? data.errcode : 0
  if (errcode === 0) return
  const errmsg = typeof data.errmsg === 'string' && data.errmsg.trim().length > 0
    ? data.errmsg.trim()
    : 'DingTalk robot request failed'
  throw new NonRetryableNotificationError(`DingTalk errcode ${errcode}: ${errmsg}`)
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
      if (error instanceof NonRetryableNotificationError) {
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

function buildDingTalkMarkdown(subject: string, content: string): DingTalkRobotPayload {
  const title = subject.trim() || 'MetaSheet Notification'
  const body = content.trim() || title
  return {
    msgtype: 'markdown',
    markdown: {
      title,
      text: `### ${title}\n\n${body}`,
    },
  }
}

function buildSignedDingTalkWebhookUrl(baseUrl: string, secret?: string): string {
  const normalizedSecret = typeof secret === 'string' ? secret.trim() : ''
  if (!normalizedSecret) return baseUrl

  const timestamp = Date.now()
  const stringToSign = `${timestamp}\n${normalizedSecret}`
  const sign = encodeURIComponent(createHmac('sha256', normalizedSecret).update(stringToSign).digest('base64'))
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}timestamp=${timestamp}&sign=${sign}`
}

/**
 * 邮件通知渠道
 */
export class EmailNotificationChannel implements NotificationChannel {
  name = 'email'
  type = 'email' as const
  config: NotificationChannelConfig
  private logger: Logger

  constructor(config: NotificationChannelConfig) {
    this.config = config
    this.logger = new Logger('EmailChannel')
  }

  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    const id = `email_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    try {
      // 这里应该集成实际的邮件服务(如 SendGrid, SES, SMTP)
      const emailRecipients = recipients.filter(r => r.type === 'email')

      for (const recipient of emailRecipients) {
        await this.sendEmail({
          to: recipient.id,
          subject: notification.subject,
          content: notification.content,
          metadata: notification.metadata
        })
      }

      return {
        id,
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          channel: 'email',
          recipientCount: emailRecipients.length
        }
      }
    } catch (error) {
      this.logger.error('Failed to send email notification', error as Error)
      return {
        id,
        status: 'failed',
        failedReason: (error as Error).message,
        metadata: {
          channel: 'email'
        }
      }
    }
  }

  private async sendEmail(params: EmailPayload): Promise<void> {
    // 实际邮件发送实现
    this.logger.info(`Sending email to ${params.to}: ${params.subject}`)

    // 模拟异步发送
    await new Promise(resolve => setTimeout(resolve, 100))
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

    try {
      const webhookRecipients = recipients.filter(r => r.type === 'webhook')

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
    this.logger.info(`Sending dingtalk robot message to ${url}`)
    await postJsonWithRetry({
      url: signedUrl,
      payload,
      timeoutMs: resolvePositiveInt(this.config.timeout, 10_000, 500, 60_000),
      maxAttempts: resolvePositiveInt(this.config.maxAttempts, 3, 1, 6),
      retryDelayMs: resolvePositiveInt(this.config.retryDelayMs, 750, 50, 10_000),
      logger: this.logger,
      context: `DingTalk delivery failed for ${url}`,
      responseValidator: validateDingTalkRobotResponse,
    })
  }
}

/**
 * 飞书通知渠道
 */
export class FeishuNotificationChannel implements NotificationChannel {
  name = 'feishu'
  type = 'feishu' as const
  config: NotificationChannelConfig
  private logger: Logger

  constructor(config: NotificationChannelConfig) {
    this.config = config
    this.logger = new Logger('FeishuChannel')
  }

  async sender(notification: Notification, recipients: NotificationRecipient[]): Promise<NotificationResult> {
    const id = `feishu_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    try {
      // 集成飞书 API
      const userRecipients = recipients.filter(r => r.type === 'user')

      for (const recipient of userRecipients) {
        await this.sendFeishuMessage(recipient.id, {
          title: notification.subject,
          content: notification.content,
          data: notification.data
        })
      }

      return {
        id,
        status: 'sent',
        sentAt: new Date(),
        metadata: {
          channel: 'feishu',
          recipientCount: userRecipients.length
        }
      }
    } catch (error) {
      this.logger.error('Failed to send feishu notification', error as Error)
      return {
        id,
        status: 'failed',
        failedReason: (error as Error).message,
        metadata: {
          channel: 'feishu'
        }
      }
    }
  }

  private async sendFeishuMessage(userId: string, _message: FeishuMessagePayload): Promise<void> {
    // 实际飞书消息发送实现
    this.logger.info(`Sending feishu message to user ${userId}`)

    // 模拟异步发送
    await new Promise(resolve => setTimeout(resolve, 150))
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
