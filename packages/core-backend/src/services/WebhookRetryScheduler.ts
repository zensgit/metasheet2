/**
 * Webhook retry scheduler.
 *
 * Runs a periodic tick that calls WebhookService.retryFailedDeliveries() — picking
 * up `pending` delivery rows whose `next_retry_at` has elapsed and re-attempting
 * delivery with the existing exponential-backoff bookkeeping. This is the missing
 * half of the webhook outbound pipeline: without it, a delivery that fails its first
 * attempt is parked `pending` forever.
 *
 * Mirrors ApprovalSlaScheduler exactly: a single-process interval with a one-run
 * guard; multi-instance fleets can opt into a Redis leader lock via
 * ENABLE_WEBHOOK_RETRY_LEADER_LOCK=true. retryFailedDeliveries() is itself
 * concurrency-tolerant (each attempt re-reads webhook state and the delivery's
 * attempt_count guards termination), so the leader lock is a LOAD optimisation only,
 * never load-bearing for correctness — at-least-once is the accepted posture.
 *
 * Enabled by default (webhooks are DB-row-driven, not env-gated); disable with
 * WEBHOOK_RETRY_SCHEDULER_DISABLED=1. Interval defaults to 60s
 * (WEBHOOK_RETRY_SCHEDULER_INTERVAL_MS), clamped to a 5s floor.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import { WebhookService } from '../multitable/webhook-service'
import { db } from '../db/db'

const DEFAULT_INTERVAL_MS = 60 * 1000
const MIN_INTERVAL_MS = 5000
const DEFAULT_LOCK_TTL_MS = 30_000

export interface WebhookRetryService {
  retryFailedDeliveries(): Promise<number>
}

export interface WebhookRetrySchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  lockKey?: string
  ownerId: string
  ttlMs?: number
  renewIntervalMs?: number
  retryIntervalMs?: number
}

export interface WebhookRetrySchedulerLeaderGauge {
  labels(labels: { state: 'leader' | 'follower' | 'relinquished' }): { set(value: number): void }
}

export interface WebhookRetrySchedulerRuntimeOptions {
  leaderStateGauge?: WebhookRetrySchedulerLeaderGauge
}

export interface WebhookRetrySchedulerOptions {
  service?: WebhookRetryService
  intervalMs?: number
  leaderOptions?: WebhookRetrySchedulerLeaderOptions | null
  runtime?: WebhookRetrySchedulerRuntimeOptions
  logger?: Logger
}

export class WebhookRetryScheduler {
  private readonly logger: Logger
  private readonly service: WebhookRetryService
  private readonly intervalMs: number
  private readonly leaderOptions: WebhookRetrySchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly leaderStateGauge: WebhookRetrySchedulerLeaderGauge | null
  private timer: NodeJS.Timeout | null = null
  private renewalTimer: NodeJS.Timeout | null = null
  private acquisitionTimer: NodeJS.Timeout | null = null
  private running = false
  private started = false
  private isLeader = false
  public readonly ready: Promise<void>

  constructor(options: WebhookRetrySchedulerOptions = {}) {
    this.service = options.service ?? new WebhookService(db)
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.leaderOptions = options.leaderOptions ?? null
    this.lockKey = this.leaderOptions?.lockKey ?? 'webhook-retry-scheduler:leader'
    this.ttlMs = this.leaderOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS
    this.renewIntervalMs = this.leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.retryIntervalMs = this.leaderOptions?.retryIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = options.runtime?.leaderStateGauge ?? null
    this.logger = options.logger ?? new Logger('WebhookRetryScheduler')
    if (this.leaderOptions) {
      this.setLeaderGauge('follower')
      this.ready = this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Webhook retry leader-lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else {
      this.isLeader = true
      this.setLeaderGauge('leader')
      this.ready = Promise.resolve()
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.ready.then(() => {
      if (!this.started) return
      if (this.isLeader) {
        this.startTickLoop()
      } else {
        this.startAcquisitionRetryLoop()
      }
    }).catch((error) => {
      this.logger.warn(`Webhook retry scheduler start skipped after leader-lock error: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  stop(): void {
    this.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
    if (this.acquisitionTimer) {
      clearInterval(this.acquisitionTimer)
      this.acquisitionTimer = null
    }
    if (this.leaderOptions && this.isLeader) {
      const { leaderLock, ownerId } = this.leaderOptions
      leaderLock.release(this.lockKey, ownerId).catch(() => {})
      this.isLeader = false
    }
    this.setLeaderGauge('relinquished')
    this.logger.info('Webhook retry scheduler stopped')
  }

  /**
   * Run one retry pass. Returns the number of deliveries re-attempted. The one-run
   * guard (`running`) prevents overlapping passes when a tick runs long.
   */
  async tick(): Promise<number> {
    if (!this.isLeader) return 0
    if (this.running) return 0
    this.running = true
    try {
      const retried = await this.service.retryFailedDeliveries()
      if (retried > 0) {
        this.logger.info(`Webhook deliveries retried: ${retried}`)
      }
      return retried
    } catch (error) {
      this.logger.error(`Webhook retry tick failed: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    } finally {
      this.running = false
    }
  }

  get leader(): boolean {
    return this.isLeader
  }

  private async attemptLeadership(): Promise<void> {
    if (!this.leaderOptions) return
    const { leaderLock, ownerId } = this.leaderOptions
    const won = await leaderLock.acquire(this.lockKey, ownerId, this.ttlMs)
    this.isLeader = won
    if (won) {
      this.logger.info(`Acquired webhook retry scheduler leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`)
      this.setLeaderGauge('leader')
      this.stopAcquisitionRetryLoop()
      this.startRenewalLoop()
      if (this.started) this.startTickLoop()
    } else {
      this.logger.info(`Did not acquire webhook retry scheduler leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`)
      this.setLeaderGauge('follower')
    }
  }

  private setLeaderGauge(state: 'leader' | 'follower' | 'relinquished'): void {
    if (!this.leaderStateGauge) return
    try {
      for (const candidate of ['leader', 'follower', 'relinquished'] as const) {
        this.leaderStateGauge.labels({ state: candidate }).set(candidate === state ? 1 : 0)
      }
    } catch {
      // Metrics failures must not break the scheduler.
    }
  }

  private startTickLoop(): void {
    if (!this.started || !this.isLeader || this.timer) return
    this.logger.info(`Webhook retry scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private startAcquisitionRetryLoop(): void {
    if (!this.leaderOptions || this.acquisitionTimer || this.isLeader) return
    this.acquisitionTimer = setInterval(() => {
      this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Webhook retry leader-lock retry failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, this.retryIntervalMs)
    if (typeof this.acquisitionTimer.unref === 'function') this.acquisitionTimer.unref()
  }

  private stopAcquisitionRetryLoop(): void {
    if (!this.acquisitionTimer) return
    clearInterval(this.acquisitionTimer)
    this.acquisitionTimer = null
  }

  private startRenewalLoop(): void {
    if (!this.leaderOptions) return
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    const { leaderLock, ownerId } = this.leaderOptions
    this.renewalTimer = setInterval(() => {
      leaderLock.renew(this.lockKey, ownerId, this.ttlMs).then(
        (ok) => {
          if (!ok) this.relinquishLeadership('renewal rejected')
        },
        (error) => {
          this.logger.warn(`Webhook retry leader renewal error for ${this.lockKey}: ${error instanceof Error ? error.message : String(error)}`)
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') this.renewalTimer.unref()
  }

  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    this.logger.warn(`Relinquishing webhook retry scheduler leadership (${reason})`)
    this.isLeader = false
    this.setLeaderGauge('relinquished')
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
    if (this.started) this.startAcquisitionRetryLoop()
  }
}

let sharedScheduler: WebhookRetryScheduler | null = null

/**
 * Enabled by default; opt OUT with WEBHOOK_RETRY_SCHEDULER_DISABLED=1. Returns null
 * when disabled or already started.
 */
export function startWebhookRetryScheduler(options: WebhookRetrySchedulerOptions = {}): WebhookRetryScheduler | null {
  if (process.env.WEBHOOK_RETRY_SCHEDULER_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new WebhookRetryScheduler(options)
  sharedScheduler.start()
  return sharedScheduler
}

export function getSharedWebhookRetryScheduler(): WebhookRetryScheduler | null {
  return sharedScheduler
}

export function stopWebhookRetryScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export function resolveWebhookRetrySchedulerIntervalMs(): number | undefined {
  const raw = Number(process.env.WEBHOOK_RETRY_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export async function resolveWebhookRetrySchedulerLeaderOptions(): Promise<WebhookRetrySchedulerLeaderOptions | null> {
  if (process.env.ENABLE_WEBHOOK_RETRY_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.WEBHOOK_RETRY_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.WEBHOOK_RETRY_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.WEBHOOK_RETRY_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.WEBHOOK_RETRY_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `webhook-retry:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
