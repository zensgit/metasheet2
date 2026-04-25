/**
 * Wave 2 WP5 slice 1 — SLA breach scanner.
 *
 * Runs a periodic (default 15 min) scan that flips `sla_breached = TRUE`
 * on approval_metrics rows whose `started_at + sla_hours` have elapsed.
 * Single-process interval with a one-run guard. Multi-instance fleets can
 * opt into a Redis leader lock via ENABLE_APPROVAL_SLA_LEADER_LOCK=true.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import { getApprovalMetricsService, type ApprovalMetricsService } from './ApprovalMetricsService'

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const MIN_INTERVAL_MS = 5000
const DEFAULT_LOCK_TTL_MS = 30_000

export interface ApprovalSlaSchedulerOptions {
  metrics?: ApprovalMetricsService
  intervalMs?: number
  leaderOptions?: ApprovalSlaSchedulerLeaderOptions | null
  runtime?: ApprovalSlaSchedulerRuntimeOptions
  /**
   * Optional hook invoked once per breach cycle with the newly-breached
   * instance ids. Main caller wires it to approval audit + notifications.
   */
  onBreach?: (instanceIds: string[]) => Promise<void> | void
  logger?: Logger
}

export interface ApprovalSlaSchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  lockKey?: string
  ownerId: string
  ttlMs?: number
  renewIntervalMs?: number
  retryIntervalMs?: number
}

export interface ApprovalSlaSchedulerLeaderGauge {
  labels(labels: {
    state: 'leader' | 'follower' | 'relinquished'
  }): { set(value: number): void }
}

export interface ApprovalSlaSchedulerRuntimeOptions {
  leaderStateGauge?: ApprovalSlaSchedulerLeaderGauge
}

export class ApprovalSlaScheduler {
  private readonly logger: Logger
  private readonly metrics: ApprovalMetricsService
  private readonly intervalMs: number
  private readonly leaderOptions: ApprovalSlaSchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly leaderStateGauge: ApprovalSlaSchedulerLeaderGauge | null
  private readonly onBreach: ApprovalSlaSchedulerOptions['onBreach']
  private timer: NodeJS.Timeout | null = null
  private renewalTimer: NodeJS.Timeout | null = null
  private acquisitionTimer: NodeJS.Timeout | null = null
  private running = false
  private started = false
  private isLeader = false
  public readonly ready: Promise<void>

  constructor(options: ApprovalSlaSchedulerOptions = {}) {
    this.metrics = options.metrics ?? getApprovalMetricsService()
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.leaderOptions = options.leaderOptions ?? null
    this.lockKey = this.leaderOptions?.lockKey ?? 'approval-sla-scheduler:leader'
    this.ttlMs = this.leaderOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS
    this.renewIntervalMs = this.leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.retryIntervalMs = this.leaderOptions?.retryIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = options.runtime?.leaderStateGauge ?? null
    this.onBreach = options.onBreach
    this.logger = options.logger ?? new Logger('ApprovalSlaScheduler')
    if (this.leaderOptions) {
      this.setLeaderGauge('follower')
      this.ready = this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`SLA leader-lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.warn(`SLA scheduler start skipped after leader-lock error: ${error instanceof Error ? error.message : String(error)}`)
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
    this.logger.info('SLA scheduler stopped')
  }

  async tick(now: Date = new Date()): Promise<string[]> {
    if (!this.isLeader) return []
    if (this.running) return []
    this.running = true
    try {
      const breached = await this.metrics.checkSlaBreaches(now)
      if (breached.length > 0) {
        this.logger.warn(`SLA breaches flagged: ${breached.length}`)
      }
      if (this.onBreach) {
        let pending: string[] = []
        try {
          pending = await this.metrics.listBreachesPendingNotification()
        } catch (error) {
          this.logger.warn(`SLA pending-breach lookup failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        const dispatch = mergeUnique(breached, pending)
        if (dispatch.length > 0) {
          try {
            await this.onBreach(dispatch)
          } catch (error) {
            this.logger.warn(`SLA onBreach hook failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      return breached
    } catch (error) {
      this.logger.error(`SLA tick failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
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
      this.logger.info(`Acquired SLA scheduler leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`)
      this.setLeaderGauge('leader')
      this.stopAcquisitionRetryLoop()
      this.startRenewalLoop()
      if (this.started) this.startTickLoop()
    } else {
      this.logger.info(`Did not acquire SLA scheduler leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`)
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
    this.logger.info(`SLA scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private startAcquisitionRetryLoop(): void {
    if (!this.leaderOptions || this.acquisitionTimer || this.isLeader) return
    this.acquisitionTimer = setInterval(() => {
      this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`SLA leader-lock retry failed: ${error instanceof Error ? error.message : String(error)}`)
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
          this.logger.warn(`SLA leader renewal error for ${this.lockKey}: ${error instanceof Error ? error.message : String(error)}`)
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') this.renewalTimer.unref()
  }

  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    this.logger.warn(`Relinquishing SLA scheduler leadership (${reason})`)
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

function mergeUnique(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const id of list) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

let sharedScheduler: ApprovalSlaScheduler | null = null

export function startApprovalSlaScheduler(options: ApprovalSlaSchedulerOptions = {}): ApprovalSlaScheduler | null {
  if (process.env.APPROVAL_SLA_SCHEDULER_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new ApprovalSlaScheduler(options)
  sharedScheduler.start()
  return sharedScheduler
}

export function stopApprovalSlaScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export async function resolveApprovalSlaSchedulerLeaderOptions(): Promise<ApprovalSlaSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_APPROVAL_SLA_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.APPROVAL_SLA_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.APPROVAL_SLA_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.APPROVAL_SLA_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.APPROVAL_SLA_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `approval-sla:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
