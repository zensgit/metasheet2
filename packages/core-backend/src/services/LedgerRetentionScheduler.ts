/**
 * AI usage ledger retention scheduler (ladder #9).
 *
 * Runs a periodic tick that calls sweepAiUsageLedgerRetention() — a bounded
 * DELETE of multitable_ai_usage_ledger rows older than the retention window
 * (default 90 days, env-overridable, floored at 7 days). The M2 ledger inserts
 * a row for EVERY shortcut attempt (incl. zero-token rate-limited/blocked
 * rows), so without this sweep the table grows unbounded and a rate-limit
 * storm becomes a DB-write amplification vector. The retention floor is always
 * ≥ the widest quota window, so a sweep only ever deletes quota-inert rows —
 * the live quota SUMs are never affected (services/ai-usage-ledger.ts).
 *
 * Mirrors WebhookRetryScheduler exactly: a single-process interval with a
 * one-run guard; multi-instance fleets can opt into a Redis leader lock via
 * ENABLE_LEDGER_RETENTION_LEADER_LOCK=true. The sweep is idempotent and
 * convergent (a later tick deletes whatever a missed/duplicate tick left), so
 * the leader lock is a LOAD optimisation only, never load-bearing for
 * correctness — at-least-once is the accepted posture.
 *
 * Enabled by default; disable with MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1
 * (the same opt-out the sweep honors — a disabled config makes every tick a
 * no-op). Interval defaults to a daily-ish 6h
 * (LEDGER_RETENTION_SCHEDULER_INTERVAL_MS), clamped to a 60s floor.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import { poolManager } from '../integration/db/connection-pool'
import {
  resolveAiUsageRetentionConfig,
  sweepAiUsageLedgerRetention,
  type AiUsageQueryFn,
  type AiUsageRetentionConfig,
} from './ai-usage-ledger'

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000 // daily-ish: 4 passes/day
const MIN_INTERVAL_MS = 60_000
const DEFAULT_LOCK_TTL_MS = 30_000

export interface LedgerRetentionService {
  /** Run one bounded retention pass; returns the rows deleted. */
  sweep(): Promise<number>
}

/**
 * Default service: binds the sweep to the shared pg pool + the env-resolved
 * retention config. Re-reads the config each pass so an env change (or the
 * disabled opt-out) takes effect on the next tick without a restart.
 */
export class PgLedgerRetentionService implements LedgerRetentionService {
  private readonly config?: AiUsageRetentionConfig

  constructor(config?: AiUsageRetentionConfig) {
    this.config = config
  }

  async sweep(): Promise<number> {
    const config = this.config ?? resolveAiUsageRetentionConfig()
    if (config.disabled) return 0
    const pool = poolManager.get() as unknown as { query: AiUsageQueryFn }
    const query = pool.query.bind(pool) as AiUsageQueryFn
    return sweepAiUsageLedgerRetention(query, config)
  }
}

export interface LedgerRetentionSchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  lockKey?: string
  ownerId: string
  ttlMs?: number
  renewIntervalMs?: number
  retryIntervalMs?: number
}

export interface LedgerRetentionSchedulerLeaderGauge {
  labels(labels: { state: 'leader' | 'follower' | 'relinquished' }): { set(value: number): void }
}

export interface LedgerRetentionSchedulerRuntimeOptions {
  leaderStateGauge?: LedgerRetentionSchedulerLeaderGauge
}

export interface LedgerRetentionSchedulerOptions {
  service?: LedgerRetentionService
  intervalMs?: number
  leaderOptions?: LedgerRetentionSchedulerLeaderOptions | null
  runtime?: LedgerRetentionSchedulerRuntimeOptions
  logger?: Logger
}

export class LedgerRetentionScheduler {
  private readonly logger: Logger
  private readonly service: LedgerRetentionService
  private readonly intervalMs: number
  private readonly leaderOptions: LedgerRetentionSchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly leaderStateGauge: LedgerRetentionSchedulerLeaderGauge | null
  private timer: NodeJS.Timeout | null = null
  private renewalTimer: NodeJS.Timeout | null = null
  private acquisitionTimer: NodeJS.Timeout | null = null
  private running = false
  private started = false
  private isLeader = false
  public readonly ready: Promise<void>

  constructor(options: LedgerRetentionSchedulerOptions = {}) {
    this.service = options.service ?? new PgLedgerRetentionService()
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.leaderOptions = options.leaderOptions ?? null
    this.lockKey = this.leaderOptions?.lockKey ?? 'ledger-retention-scheduler:leader'
    this.ttlMs = this.leaderOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS
    this.renewIntervalMs = this.leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.retryIntervalMs = this.leaderOptions?.retryIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = options.runtime?.leaderStateGauge ?? null
    this.logger = options.logger ?? new Logger('LedgerRetentionScheduler')
    if (this.leaderOptions) {
      this.setLeaderGauge('follower')
      this.ready = this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Ledger retention leader-lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.warn(`Ledger retention scheduler start skipped after leader-lock error: ${error instanceof Error ? error.message : String(error)}`)
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
    this.logger.info('Ledger retention scheduler stopped')
  }

  /**
   * Run one retention pass. Returns the number of rows deleted. The one-run
   * guard (`running`) prevents overlapping passes when a tick runs long.
   */
  async tick(): Promise<number> {
    if (!this.isLeader) return 0
    if (this.running) return 0
    this.running = true
    try {
      const deleted = await this.service.sweep()
      if (deleted > 0) {
        this.logger.info(`AI usage ledger rows swept (retention): ${deleted}`)
      }
      return deleted
    } catch (error) {
      this.logger.error(`Ledger retention tick failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.info(`Acquired ledger retention scheduler leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`)
      this.setLeaderGauge('leader')
      this.stopAcquisitionRetryLoop()
      this.startRenewalLoop()
      if (this.started) this.startTickLoop()
    } else {
      this.logger.info(`Did not acquire ledger retention scheduler leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`)
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
    this.logger.info(`Ledger retention scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private startAcquisitionRetryLoop(): void {
    if (!this.leaderOptions || this.acquisitionTimer || this.isLeader) return
    this.acquisitionTimer = setInterval(() => {
      this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Ledger retention leader-lock retry failed: ${error instanceof Error ? error.message : String(error)}`)
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
          this.logger.warn(`Ledger retention leader renewal error for ${this.lockKey}: ${error instanceof Error ? error.message : String(error)}`)
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') this.renewalTimer.unref()
  }

  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    this.logger.warn(`Relinquishing ledger retention scheduler leadership (${reason})`)
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

let sharedScheduler: LedgerRetentionScheduler | null = null

/**
 * Enabled by default; opt OUT with MULTITABLE_AI_LEDGER_RETENTION_DISABLED=1.
 * Returns null when disabled or already started.
 */
export function startLedgerRetentionScheduler(options: LedgerRetentionSchedulerOptions = {}): LedgerRetentionScheduler | null {
  if (process.env.MULTITABLE_AI_LEDGER_RETENTION_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new LedgerRetentionScheduler(options)
  sharedScheduler.start()
  return sharedScheduler
}

export function getSharedLedgerRetentionScheduler(): LedgerRetentionScheduler | null {
  return sharedScheduler
}

export function stopLedgerRetentionScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export function resolveLedgerRetentionSchedulerIntervalMs(): number | undefined {
  const raw = Number(process.env.LEDGER_RETENTION_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export async function resolveLedgerRetentionSchedulerLeaderOptions(): Promise<LedgerRetentionSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_LEDGER_RETENTION_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.LEDGER_RETENTION_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.LEDGER_RETENTION_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.LEDGER_RETENTION_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.LEDGER_RETENTION_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `ledger-retention:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
