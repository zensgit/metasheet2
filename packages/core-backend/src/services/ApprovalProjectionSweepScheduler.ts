/**
 * T3-6 approval read-model projection sweep scheduler (design-lock §6b).
 *
 * Runs a periodic tick that calls the projection service `sweep()` — a bounded scan for instances
 * whose authoritative `approval_instances.version` is ahead of their projection (or that have no
 * mapping row at all, i.e. a lost create write) — and reconciles them idempotently. This is the
 * self-heal that keeps the read-model consistent after a best-effort projection failure.
 *
 * Mirrors LedgerRetentionScheduler exactly: a single-process interval with a one-run guard;
 * multi-instance fleets opt into a Redis leader lock via ENABLE_APPROVAL_PROJECTION_SWEEP_LEADER_LOCK.
 * The sweep is idempotent + convergent (a later tick reconciles whatever a missed/duplicate tick
 * left, and the per-instance advisory lock + projected_version guard make it clobber-safe), so the
 * leader lock is a LOAD optimisation only, never load-bearing for correctness.
 *
 * Enabled by default; disable with APPROVAL_PROJECTION_SWEEP_DISABLED=1. Interval defaults to 5min
 * (APPROVAL_PROJECTION_SWEEP_INTERVAL_MS), clamped to a 30s floor.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import {
  ApprovalRecordProjectionService,
  getApprovalRecordProjectionService,
} from '../multitable/approval-record-projection-service'

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000
const MIN_INTERVAL_MS = 30_000
const DEFAULT_LOCK_TTL_MS = 30_000
const DEFAULT_SWEEP_LIMIT = 200

export interface ApprovalProjectionSweepSchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  lockKey?: string
  ownerId: string
  ttlMs?: number
  renewIntervalMs?: number
  retryIntervalMs?: number
}

export interface ApprovalProjectionSweepSchedulerLeaderGauge {
  labels(labels: { state: 'leader' | 'follower' | 'relinquished' }): { set(value: number): void }
}

export interface ApprovalProjectionSweepSchedulerRuntimeOptions {
  leaderStateGauge?: ApprovalProjectionSweepSchedulerLeaderGauge
}

export interface ApprovalProjectionSweepSchedulerOptions {
  service?: ApprovalRecordProjectionService
  intervalMs?: number
  sweepLimit?: number
  leaderOptions?: ApprovalProjectionSweepSchedulerLeaderOptions | null
  runtime?: ApprovalProjectionSweepSchedulerRuntimeOptions
  logger?: Logger
}

export class ApprovalProjectionSweepScheduler {
  private readonly logger: Logger
  private readonly service: ApprovalRecordProjectionService
  private readonly intervalMs: number
  private readonly sweepLimit: number
  private readonly leaderOptions: ApprovalProjectionSweepSchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly leaderStateGauge: ApprovalProjectionSweepSchedulerLeaderGauge | null
  private timer: NodeJS.Timeout | null = null
  private renewalTimer: NodeJS.Timeout | null = null
  private acquisitionTimer: NodeJS.Timeout | null = null
  private running = false
  private started = false
  private isLeader = false
  public readonly ready: Promise<void>

  constructor(options: ApprovalProjectionSweepSchedulerOptions = {}) {
    this.service = options.service ?? getApprovalRecordProjectionService()
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.sweepLimit = Math.max(1, options.sweepLimit ?? DEFAULT_SWEEP_LIMIT)
    this.leaderOptions = options.leaderOptions ?? null
    this.lockKey = this.leaderOptions?.lockKey ?? 'approval-projection-sweep:leader'
    this.ttlMs = this.leaderOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS
    this.renewIntervalMs = this.leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.retryIntervalMs = this.leaderOptions?.retryIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = options.runtime?.leaderStateGauge ?? null
    this.logger = options.logger ?? new Logger('ApprovalProjectionSweepScheduler')
    if (this.leaderOptions) {
      this.setLeaderGauge('follower')
      this.ready = this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Approval projection sweep leader-lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.warn(`Approval projection sweep scheduler start skipped after leader-lock error: ${error instanceof Error ? error.message : String(error)}`)
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
    this.logger.info('Approval projection sweep scheduler stopped')
  }

  /** Run one sweep pass. Returns rows reconciled. The one-run guard prevents overlapping passes. */
  async tick(): Promise<number> {
    if (!this.isLeader) return 0
    if (this.running) return 0
    this.running = true
    try {
      const { scanned, reconciled } = await this.service.sweep({ limit: this.sweepLimit })
      if (reconciled > 0) {
        this.logger.info(`Approval projection sweep reconciled ${reconciled}/${scanned} drifted instance(s)`)
      }
      return reconciled
    } catch (error) {
      this.logger.error(`Approval projection sweep tick failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.info(`Acquired approval projection sweep leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`)
      this.setLeaderGauge('leader')
      this.stopAcquisitionRetryLoop()
      this.startRenewalLoop()
      if (this.started) this.startTickLoop()
    } else {
      this.logger.info(`Did not acquire approval projection sweep leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`)
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
    this.logger.info(`Approval projection sweep scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private startAcquisitionRetryLoop(): void {
    if (!this.leaderOptions || this.acquisitionTimer || this.isLeader) return
    this.acquisitionTimer = setInterval(() => {
      this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Approval projection sweep leader-lock retry failed: ${error instanceof Error ? error.message : String(error)}`)
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
          this.logger.warn(`Approval projection sweep leader renewal error for ${this.lockKey}: ${error instanceof Error ? error.message : String(error)}`)
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') this.renewalTimer.unref()
  }

  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    this.logger.warn(`Relinquishing approval projection sweep leadership (${reason})`)
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

let sharedScheduler: ApprovalProjectionSweepScheduler | null = null

/** Enabled by default; opt OUT with APPROVAL_PROJECTION_SWEEP_DISABLED=1. Returns null when disabled/started. */
export function startApprovalProjectionSweepScheduler(
  options: ApprovalProjectionSweepSchedulerOptions = {},
): ApprovalProjectionSweepScheduler | null {
  if (process.env.APPROVAL_PROJECTION_SWEEP_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new ApprovalProjectionSweepScheduler(options)
  sharedScheduler.start()
  return sharedScheduler
}

export function getSharedApprovalProjectionSweepScheduler(): ApprovalProjectionSweepScheduler | null {
  return sharedScheduler
}

export function stopApprovalProjectionSweepScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export function resolveApprovalProjectionSweepIntervalMs(): number | undefined {
  const raw = Number(process.env.APPROVAL_PROJECTION_SWEEP_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export async function resolveApprovalProjectionSweepLeaderOptions(): Promise<ApprovalProjectionSweepSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_APPROVAL_PROJECTION_SWEEP_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.APPROVAL_PROJECTION_SWEEP_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.APPROVAL_PROJECTION_SWEEP_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.APPROVAL_PROJECTION_SWEEP_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.APPROVAL_PROJECTION_SWEEP_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `approval-projection-sweep:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
