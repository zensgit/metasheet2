/**
 * ④ C4 — attendance comp-time expiry scheduler base.
 *
 * Mirrors ApprovalSlaScheduler: a periodic tick (default hourly) that runs the
 * AttendanceExpiryService claim — flips `status='active' → 'expired'` on comp-time lots whose
 * `expires_at` has passed and writes one `expire` event per transitioned lot. Single-process interval
 * with a one-run guard; multi-instance fleets can opt into a Redis leader lock via
 * ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK=true. The expiry claim (AttendanceExpiryService) is itself
 * idempotent and concurrency-safe (the `status='active'` predicate is the guard), so the leader lock is
 * a LOAD optimisation only — never load-bearing for correctness.
 *
 * Default OFF: the scheduler starts only when ATTENDANCE_SCHEDULER_ENABLED=true. Until then, and until an
 * org sets compTimeFromOvertime.expiresInDays (which makes grants stamp expires_at), expiry never runs.
 *
 * Jobs per cycle (each independently guarded, one failing never affects the others):
 *   - the comp-time EXPIRY job (④ C4, always present);
 *   - registered secondary jobs such as the ⑤ UNSCHEDULED-REMINDER job and future A2 auto-shift jobs.
 * Reuses THIS scheduler base — never a second scheduler. Notification delivery is a separate C5 worker
 * path; scheduler jobs may produce outbox rows but must not call external channels directly.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import {
  getAttendanceExpiryService,
  type AttendanceExpiryService,
  type ExpiredCompTimeBalance,
} from './AttendanceExpiryService'
import { CompTimeExpiryReminderService } from './CompTimeExpiryReminderService'
import { UnscheduledReminderService } from './UnscheduledReminderService'

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000
const MIN_INTERVAL_MS = 5000
const DEFAULT_LOCK_TTL_MS = 30_000

/** A time-driven attendance job the scheduler runs each cycle (alongside expiry). */
export interface AttendanceSchedulerJob {
  name?: string
  run(): Promise<unknown>
}

// Backward-compatible alias for the ⑤ unscheduled-reminder job type.
export type AttendanceReminderJob = AttendanceSchedulerJob

export interface AttendanceSchedulerOptions {
  expiryService?: AttendanceExpiryService
  /** Additional jobs that run after expiry. Each job is isolated from its siblings. */
  jobs?: AttendanceSchedulerJob[]
  /** ⑤ legacy optional second job; folded into `jobs` for compatibility. */
  reminderJob?: AttendanceReminderJob | null
  intervalMs?: number
  leaderOptions?: AttendanceSchedulerLeaderOptions | null
  runtime?: AttendanceSchedulerRuntimeOptions
  logger?: Logger
}

export interface AttendanceSchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  lockKey?: string
  ownerId: string
  ttlMs?: number
  renewIntervalMs?: number
  retryIntervalMs?: number
}

export interface AttendanceSchedulerLeaderGauge {
  labels(labels: { state: 'leader' | 'follower' | 'relinquished' }): { set(value: number): void }
}

export interface AttendanceSchedulerRuntimeOptions {
  leaderStateGauge?: AttendanceSchedulerLeaderGauge
}

export class AttendanceScheduler {
  private readonly logger: Logger
  private readonly expiryService: AttendanceExpiryService
  private jobs: AttendanceSchedulerJob[]
  private readonly intervalMs: number
  private readonly leaderOptions: AttendanceSchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private readonly retryIntervalMs: number
  private readonly leaderStateGauge: AttendanceSchedulerLeaderGauge | null
  private timer: NodeJS.Timeout | null = null
  private renewalTimer: NodeJS.Timeout | null = null
  private acquisitionTimer: NodeJS.Timeout | null = null
  private running = false
  private started = false
  private isLeader = false
  public readonly ready: Promise<void>

  constructor(options: AttendanceSchedulerOptions = {}) {
    this.expiryService = options.expiryService ?? getAttendanceExpiryService()
    this.jobs = [...(options.jobs ?? [])]
    if (options.reminderJob) this.jobs.push(options.reminderJob)
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.leaderOptions = options.leaderOptions ?? null
    this.lockKey = this.leaderOptions?.lockKey ?? 'attendance-scheduler:leader'
    this.ttlMs = this.leaderOptions?.ttlMs ?? DEFAULT_LOCK_TTL_MS
    this.renewIntervalMs = this.leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.retryIntervalMs = this.leaderOptions?.retryIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = options.runtime?.leaderStateGauge ?? null
    this.logger = options.logger ?? new Logger('AttendanceScheduler')
    if (this.leaderOptions) {
      this.setLeaderGauge('follower')
      this.ready = this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Attendance leader-lock acquisition failed: ${error instanceof Error ? error.message : String(error)}`)
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
      this.logger.warn(`Attendance scheduler start skipped after leader-lock error: ${error instanceof Error ? error.message : String(error)}`)
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
    this.logger.info('Attendance scheduler stopped')
  }

  async tick(): Promise<ExpiredCompTimeBalance[]> {
    if (!this.isLeader) return []
    if (this.running) return []
    this.running = true
    try {
      const expired = await this.expiryService.expireCompTimeBalances()
      if (expired.length > 0) {
        this.logger.info(`Comp-time lots expired: ${expired.length}`)
      }
      return expired
    } catch (error) {
      this.logger.error(`Attendance expiry tick failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    } finally {
      this.running = false
    }
  }

  /**
   * One scheduler cycle = the expiry job, then registered secondary jobs (⑤ reminder, A2 auto-shift,
   * etc.). Each is independently try/caught so a failure in one never skips the rest. `tick()` stays the
   * public expiry entry point (signature/return unchanged → ④ tests untouched); secondary jobs run only
   * when registered AND on the leader.
   */
  async runCycle(): Promise<void> {
    await this.tick()
    if (!this.isLeader) return
    for (const job of [...this.jobs]) {
      try {
        await job.run()
      } catch (error) {
        const name = job.name || 'unnamed'
        this.logger.error(`Attendance scheduler job ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  get leader(): boolean {
    return this.isLeader
  }

  registerJob(job: AttendanceSchedulerJob): () => void {
    const name = typeof job.name === 'string' ? job.name.trim() : ''
    if (name) {
      this.jobs = this.jobs.filter(existing => existing.name !== name)
    }
    this.jobs.push(job)
    return () => {
      this.jobs = this.jobs.filter(existing => existing !== job)
    }
  }

  private async attemptLeadership(): Promise<void> {
    if (!this.leaderOptions) return
    const { leaderLock, ownerId } = this.leaderOptions
    const won = await leaderLock.acquire(this.lockKey, ownerId, this.ttlMs)
    this.isLeader = won
    if (won) {
      this.logger.info(`Acquired attendance scheduler leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`)
      this.setLeaderGauge('leader')
      this.stopAcquisitionRetryLoop()
      this.startRenewalLoop()
      if (this.started) this.startTickLoop()
    } else {
      this.logger.info(`Did not acquire attendance scheduler leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`)
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
    this.logger.info(`Attendance scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.runCycle() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private startAcquisitionRetryLoop(): void {
    if (!this.leaderOptions || this.acquisitionTimer || this.isLeader) return
    this.acquisitionTimer = setInterval(() => {
      this.attemptLeadership().catch((error) => {
        this.isLeader = false
        this.setLeaderGauge('follower')
        this.logger.warn(`Attendance leader-lock retry failed: ${error instanceof Error ? error.message : String(error)}`)
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
          this.logger.warn(`Attendance leader renewal error for ${this.lockKey}: ${error instanceof Error ? error.message : String(error)}`)
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') this.renewalTimer.unref()
  }

  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    this.logger.warn(`Relinquishing attendance scheduler leadership (${reason})`)
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

let sharedScheduler: AttendanceScheduler | null = null

/**
 * Opt-in: starts the attendance scheduler only when ATTENDANCE_SCHEDULER_ENABLED=true (default OFF).
 * Returns null when disabled or already started.
 */
export function startAttendanceScheduler(options: AttendanceSchedulerOptions = {}): AttendanceScheduler | null {
  if (process.env.ATTENDANCE_SCHEDULER_ENABLED !== 'true') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new AttendanceScheduler(options)
  sharedScheduler.start()
  return sharedScheduler
}

export function getSharedAttendanceScheduler(): AttendanceScheduler | null {
  return sharedScheduler
}

export function registerAttendanceSchedulerJob(job: AttendanceSchedulerJob): (() => void) | null {
  return sharedScheduler?.registerJob(job) ?? null
}

export function stopAttendanceScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export async function resolveAttendanceSchedulerLeaderOptions(): Promise<AttendanceSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.ATTENDANCE_SCHEDULER_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.ATTENDANCE_SCHEDULER_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.ATTENDANCE_SCHEDULER_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.ATTENDANCE_SCHEDULER_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `attendance-scheduler:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}

export function resolveAttendanceSchedulerIntervalMs(): number | undefined {
  const raw = Number(process.env.ATTENDANCE_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/**
 * ⑤ Opt-in: the unscheduled-reminder job, only when ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true
 * (default OFF → null → the scheduler runs expiry only, ④ unchanged). The job produces C5 outbox rows
 * only; the delivery worker is the only path that may call a real notification channel. Lookahead defaults
 * to 1 day and is clamped inside the service.
 */
export function resolveUnscheduledReminderJob(): AttendanceSchedulerJob | null {
  if (process.env.ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED !== 'true') return null
  const service = new UnscheduledReminderService({
    lookaheadDays: Number(process.env.ATTENDANCE_UNSCHEDULED_REMINDER_LOOKAHEAD_DAYS),
  })
  return {
    name: 'unscheduled-reminder',
    run: () => service.run(),
  }
}

/**
 * C5-1b opt-in: comp-time expiry reminder producer, only when
 * ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_ENABLED=true. It produces C5 outbox rows only; the delivery
 * worker is the only path that may call a real channel. Lookahead defaults to 7 days and is clamped
 * inside the service.
 */
export function resolveCompTimeExpiryReminderJob(): AttendanceSchedulerJob | null {
  if (process.env.ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_ENABLED !== 'true') return null
  const service = new CompTimeExpiryReminderService({
    lookaheadDays: Number(process.env.ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_LOOKAHEAD_DAYS),
  })
  return {
    name: 'comp-time-expiry-reminder',
    run: () => service.run(),
  }
}
