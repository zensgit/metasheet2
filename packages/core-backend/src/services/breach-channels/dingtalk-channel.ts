/**
 * Wave 2 WP5 — DingTalk webhook channel for SLA breach notifications.
 *
 * Reuses `integrations/dingtalk/robot.ts` helpers for payload composition,
 * webhook normalization, signing, and response validation. The HTTP send
 * itself uses native `fetch` (Node 18+) to avoid pulling extra deps.
 *
 * Configuration:
 *   APPROVAL_BREACH_DINGTALK_WEBHOOK   robot webhook URL (with access_token)
 *   APPROVAL_BREACH_DINGTALK_SECRET    optional signing secret (SEC...)
 *
 * If the webhook env var is unset, `send()` resolves to
 * `{ ok: false, error: 'webhook not configured' }` so registering the
 * channel without configuration is safe.
 */

import { Logger } from '../../core/logger'
import {
  buildDingTalkMarkdown,
  buildSignedDingTalkWebhookUrl,
  normalizeDingTalkRobotWebhookUrl,
  normalizeDingTalkRobotSecret,
  validateDingTalkRobotResponse,
} from '../../integrations/dingtalk/robot'
import type {
  BreachChannelResult,
  BreachMessage,
  BreachNotificationChannel,
} from './index'

export interface ApprovalBreachDingTalkChannelOptions {
  webhookUrl?: string | null
  secret?: string | null
  fetchFn?: typeof fetch
  timeoutMs?: number
  logger?: Logger
}

const DEFAULT_TIMEOUT_MS = 10_000

export class ApprovalBreachDingTalkChannel implements BreachNotificationChannel {
  readonly name = 'dingtalk'
  private readonly webhookUrl: string | null
  private readonly secret: string | undefined
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly logger: Logger

  constructor(options: ApprovalBreachDingTalkChannelOptions = {}) {
    this.logger = options.logger ?? new Logger('ApprovalBreachDingTalk')
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const rawUrl = typeof options.webhookUrl === 'string' && options.webhookUrl.trim().length > 0
      ? options.webhookUrl.trim()
      : null
    if (rawUrl) {
      try {
        this.webhookUrl = normalizeDingTalkRobotWebhookUrl(rawUrl)
      } catch (error) {
        this.logger.warn(`Invalid DingTalk webhook URL ignored: ${error instanceof Error ? error.message : String(error)}`)
        this.webhookUrl = null
      }
    } else {
      this.webhookUrl = null
    }
    const rawSecret = typeof options.secret === 'string' && options.secret.trim().length > 0
      ? options.secret.trim()
      : undefined
    try {
      this.secret = normalizeDingTalkRobotSecret(rawSecret)
    } catch (error) {
      this.logger.warn(`Invalid DingTalk secret ignored: ${error instanceof Error ? error.message : String(error)}`)
      this.secret = undefined
    }
  }

  async send(message: BreachMessage): Promise<BreachChannelResult> {
    if (!this.webhookUrl) {
      return { ok: false, error: 'webhook not configured' }
    }
    const payload = buildDingTalkMarkdown(message.title, this.composeBody(message))
    const signedUrl = buildSignedDingTalkWebhookUrl(this.webhookUrl, this.secret)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchFn(signedUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MetaSheet-Approval-Breach/1.0',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const text = await readBodyText(response)
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${text || response.statusText}` }
      }
      const parsed = parseJson(text)
      try {
        validateDingTalkRobotResponse(parsed)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.warn(`DingTalk breach notification failed: ${reason}`)
      return { ok: false, error: reason }
    } finally {
      clearTimeout(timer)
    }
  }

  private composeBody(message: BreachMessage): string {
    const link = message.link.trim()
    if (link.length === 0) return message.body
    return `${message.body}\n\n[查看详情](${link})`
  }
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function createApprovalBreachDingTalkChannel(
  options: ApprovalBreachDingTalkChannelOptions = {},
): ApprovalBreachDingTalkChannel {
  const webhookUrl = options.webhookUrl ?? process.env.APPROVAL_BREACH_DINGTALK_WEBHOOK ?? null
  const secret = options.secret ?? process.env.APPROVAL_BREACH_DINGTALK_SECRET ?? null
  return new ApprovalBreachDingTalkChannel({ ...options, webhookUrl, secret })
}
