/**
 * Wave 2 WP5 — ApprovalBreachNotifier.
 *
 * Wires the SLA scheduler's `onBreach(ids)` hook to one or more output
 * channels (DingTalk webhook, email stub). Composes a per-instance
 * Chinese-language message from approval_metrics + approval_instances +
 * approval_templates context, then dispatches in parallel.
 *
 * Failure isolation: a channel that throws or returns `ok: false` is logged
 * but never blocks sibling channels or future instances. The notifier itself
 * never throws — `notifyBreaches` always resolves to a NotifyResult.
 *
 * Idempotency: we maintain an in-memory `Set<instanceId>` of already-notified
 * ids on the leader process. Justification (per task spec):
 *   - The scheduler runs only on the leader; one process is enough.
 *   - Avoids touching the WP5 schema bootstrap version + a brand-new migration.
 *   - Restart-time re-notification is acceptable for v0; the next 15-min tick
 *     would re-flag breaches whose `sla_breached` was set in a previous epoch
 *     anyway, so re-notify on cold start is a conservative default.
 *   - The set is bounded (FIFO trim at MAX_NOTIFIED_IDS) so a long-lived
 *     leader cannot grow unbounded.
 *   - A persistent `breach_notified_at` column is tracked as a follow-up.
 */

import { Logger } from '../core/logger'
import {
  getApprovalMetricsService,
  type ApprovalBreachContext,
  type ApprovalMetricsService,
} from './ApprovalMetricsService'
import type {
  BreachChannelResult,
  BreachMessage,
  BreachNotificationChannel,
} from './breach-channels'

const DEFAULT_MAX_NOTIFIED_IDS = 5_000

export interface ApprovalBreachNotifierOptions {
  channels: BreachNotificationChannel[]
  metrics?: ApprovalMetricsService
  logger?: Logger
  appBaseUrl?: string | null
  /** Upper bound on the in-memory dedupe set; FIFO eviction once exceeded. */
  maxNotifiedIds?: number
  /** Inject `() => Date` for deterministic tests. */
  now?: () => Date
}

export interface NotifyResultPerChannel {
  channel: string
  sent: number
  failed: number
  errors: string[]
}

export interface NotifyResult {
  requested: number
  notified: number
  skipped: number
  sent: number
  failed: number
  perChannel: NotifyResultPerChannel[]
}

export class ApprovalBreachNotifier {
  private readonly channels: BreachNotificationChannel[]
  private readonly metrics: ApprovalMetricsService
  private readonly logger: Logger
  private readonly appBaseUrl: string
  private readonly maxNotifiedIds: number
  private readonly now: () => Date
  private readonly notifiedIds = new Set<string>()
  private readonly notifiedOrder: string[] = []

  constructor(options: ApprovalBreachNotifierOptions) {
    this.channels = Array.isArray(options.channels) ? options.channels : []
    this.metrics = options.metrics ?? getApprovalMetricsService()
    this.logger = options.logger ?? new Logger('ApprovalBreachNotifier')
    this.appBaseUrl = normalizeBaseUrl(options.appBaseUrl ?? process.env.PUBLIC_APP_URL ?? process.env.APP_BASE_URL ?? '')
    this.maxNotifiedIds = Math.max(100, options.maxNotifiedIds ?? DEFAULT_MAX_NOTIFIED_IDS)
    this.now = options.now ?? (() => new Date())
  }

  async notifyBreaches(instanceIds: string[]): Promise<NotifyResult> {
    const empty: NotifyResult = {
      requested: 0,
      notified: 0,
      skipped: 0,
      sent: 0,
      failed: 0,
      perChannel: this.channels.map((channel) => ({ channel: channel.name, sent: 0, failed: 0, errors: [] })),
    }
    if (!Array.isArray(instanceIds) || instanceIds.length === 0) return empty
    if (this.channels.length === 0) {
      this.logger.warn('ApprovalBreachNotifier invoked with zero channels; skipping')
      return { ...empty, requested: instanceIds.length, skipped: instanceIds.length, perChannel: [] }
    }

    const unique: string[] = []
    let skipped = 0
    for (const raw of instanceIds) {
      if (typeof raw !== 'string') continue
      const id = raw.trim()
      if (id.length === 0) continue
      if (this.notifiedIds.has(id)) {
        skipped += 1
        continue
      }
      if (!unique.includes(id)) unique.push(id)
    }

    if (unique.length === 0) {
      return { ...empty, requested: instanceIds.length, skipped }
    }

    let contexts: ApprovalBreachContext[]
    try {
      contexts = await this.metrics.listBreachContextByIds(unique)
    } catch (error) {
      this.logger.warn(`Breach context fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      return { ...empty, requested: instanceIds.length, skipped }
    }
    const contextById = new Map<string, ApprovalBreachContext>()
    for (const ctx of contexts) contextById.set(ctx.instanceId, ctx)

    const perChannel: Record<string, NotifyResultPerChannel> = {}
    for (const channel of this.channels) {
      perChannel[channel.name] = { channel: channel.name, sent: 0, failed: 0, errors: [] }
    }

    let notified = 0
    let totalSent = 0
    let totalFailed = 0
    for (const id of unique) {
      const ctx = contextById.get(id)
      const message = this.composeMessage(id, ctx)
      const settlements = await Promise.all(
        this.channels.map(async (channel) => {
          const result = await this.dispatch(channel, message)
          return { channel, result }
        }),
      )
      let anySent = false
      for (const { channel, result } of settlements) {
        const bucket = perChannel[channel.name]
        if (result.ok) {
          bucket.sent += 1
          totalSent += 1
          anySent = true
        } else {
          bucket.failed += 1
          totalFailed += 1
          if (result.error) bucket.errors.push(result.error)
        }
      }
      if (anySent) {
        this.markNotified(id)
        notified += 1
      }
    }

    return {
      requested: instanceIds.length,
      notified,
      skipped,
      sent: totalSent,
      failed: totalFailed,
      perChannel: this.channels.map((channel) => perChannel[channel.name]),
    }
  }

  private async dispatch(
    channel: BreachNotificationChannel,
    message: BreachMessage,
  ): Promise<BreachChannelResult> {
    try {
      const result = await channel.send(message)
      if (!result.ok) {
        this.logger.warn(`Breach channel ${channel.name} reported failure for ${message.instanceId}: ${result.error ?? 'unknown'}`)
      }
      return result
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.warn(`Breach channel ${channel.name} threw for ${message.instanceId}: ${reason}`)
      return { ok: false, error: reason }
    }
  }

  private composeMessage(instanceId: string, ctx: ApprovalBreachContext | undefined): BreachMessage {
    const templateName = ctx?.templateName?.trim() || '未命名模板'
    const requester = ctx?.requesterName?.trim() || '未知申请人'
    const node = ctx?.currentNodeKey?.trim() || '未知节点'
    const startedAt = ctx?.startedAt ? formatTimestamp(ctx.startedAt) : '未知'
    const slaHours = typeof ctx?.slaHours === 'number' && Number.isFinite(ctx.slaHours) ? `${ctx.slaHours} 小时` : '未配置'
    const overdue = describeOverdue(ctx, this.now())
    const shortId = abbreviateId(instanceId)
    const title = `审批超时告警 | ${templateName} | 实例 #${shortId}`
    const link = this.buildLink(instanceId)
    const body = [
      `- 申请人：${requester}`,
      `- 启动时间：${startedAt}`,
      `- SLA 阈值：${slaHours}`,
      `- 超时时长：${overdue}`,
      `- 当前节点：${node}`,
      `- 详情链接：${link || '(未配置 PUBLIC_APP_URL)'}`,
    ].join('\n')
    return { instanceId, title, body, link, severity: 'warning' }
  }

  private buildLink(instanceId: string): string {
    if (!this.appBaseUrl) return ''
    return `${this.appBaseUrl}/approval/${encodeURIComponent(instanceId)}`
  }

  private markNotified(instanceId: string): void {
    if (this.notifiedIds.has(instanceId)) return
    this.notifiedIds.add(instanceId)
    this.notifiedOrder.push(instanceId)
    while (this.notifiedOrder.length > this.maxNotifiedIds) {
      const evicted = this.notifiedOrder.shift()
      if (evicted) this.notifiedIds.delete(evicted)
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function abbreviateId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return value
  return parsed.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

function describeOverdue(ctx: ApprovalBreachContext | undefined, now: Date): string {
  if (!ctx) return '未知'
  const baseTs = ctx.breachedAt ?? ctx.startedAt
  if (!baseTs) return '未知'
  const baseMs = Date.parse(baseTs)
  if (!Number.isFinite(baseMs)) return '未知'
  const slaHours = typeof ctx.slaHours === 'number' && Number.isFinite(ctx.slaHours) ? ctx.slaHours : 0
  const breachStartMs = ctx.breachedAt
    ? baseMs
    : baseMs + slaHours * 60 * 60 * 1000
  const elapsedMs = Math.max(0, now.getTime() - breachStartMs)
  const totalMinutes = Math.floor(elapsedMs / 60_000)
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分钟`
}
