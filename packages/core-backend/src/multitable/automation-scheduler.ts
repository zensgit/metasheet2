/**
 * Automation Scheduler — V1
 * Manages cron and interval triggers.
 * V1 supports setInterval-based scheduling and simplified cron patterns.
 */

import { Logger } from '../core/logger'
import type { AutomationRule } from './automation-executor'
import type { RedisLeaderLock } from './redis-leader-lock'

const logger = new Logger('AutomationScheduler')

export type ScheduleCallback = (rule: AutomationRule) => void | Promise<void>

/**
 * Minimal Prometheus gauge shape used via dependency injection so the
 * scheduler module stays import-light and unit tests don't need a real
 * prom-client registry. Mirrors the subset of the gauge API we touch.
 */
export interface AutomationSchedulerLeaderGauge {
  labels(labels: {
    state: 'leader' | 'follower' | 'relinquished'
  }): { set(value: number): void }
}

/**
 * Optional leader-election configuration for the scheduler.
 * When provided the scheduler will attempt to acquire the lock at startup
 * and only run timers on the replica that currently holds it.
 */
export interface AutomationSchedulerLeaderOptions {
  leaderLock: RedisLeaderLock
  /** Redis key to claim. Default: 'automation-scheduler:leader'. */
  lockKey?: string
  /** Unique id for this process instance. */
  ownerId: string
  /** Lock TTL in ms. Default: 30_000. */
  ttlMs?: number
  /**
   * Renewal cadence in ms. Defaults to `ttlMs / 3` which gives two
   * renewal attempts before the TTL expires (handles one transient failure
   * without losing the lock).
   */
  renewIntervalMs?: number
}

/**
 * Optional second constructor argument for the scheduler — purely for
 * dependency injection of observability hooks.  Keeps the `leaderOptions`
 * API signature stable (Sprint 6 contract) while letting callers pass a
 * Prometheus gauge without threading it through leader-lock options.
 */
export interface AutomationSchedulerRuntimeOptions {
  /**
   * Prometheus gauge reporting the current leader state. Each transition
   * sets exactly one of the labels to `1` and the other two to `0`.
   */
  leaderStateGauge?: AutomationSchedulerLeaderGauge
}

/**
 * Simplified cron parser for V1.
 * Supports common patterns:
 *   - * / N * * * *  (every N minutes)
 *   - 0 * * * *      (hourly at :00)
 *   - 0 0 * * *      (daily at midnight)
 *   - 0 0 * * 1      (weekly on Monday at midnight)
 *
 * Returns interval in milliseconds, or null if unsupported.
 */
export function parseCronToIntervalMs(expression: string): number | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  // */N * * * * — every N minutes
  if (/^\*\/(\d+)$/.test(minute) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = parseInt(minute.slice(2), 10)
    if (n > 0 && n <= 1440) return n * 60 * 1000
    return null
  }

  // 0 * * * * — hourly
  if (minute === '0' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 60 * 60 * 1000
  }

  // 0 */N * * * — every N hours
  if (minute === '0' && /^\*\/(\d+)$/.test(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = parseInt(hour.slice(2), 10)
    if (n > 0 && n <= 24) return n * 60 * 60 * 1000
    return null
  }

  // 0 0 * * * — daily at midnight
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 24 * 60 * 60 * 1000
  }

  // 0 0 * * N — weekly (N=0..6 or specific day)
  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && /^[0-6]$/.test(dayOfWeek)) {
    return 7 * 24 * 60 * 60 * 1000
  }

  return null
}

export class AutomationScheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map()
  private callback: ScheduleCallback
  private readonly leaderOptions: AutomationSchedulerLeaderOptions | null
  private readonly lockKey: string
  private readonly ttlMs: number
  private readonly renewIntervalMs: number
  private renewalTimer: NodeJS.Timeout | null = null
  private isLeader: boolean = false
  private readonly leaderStateGauge: AutomationSchedulerLeaderGauge | null
  /**
   * Resolves once the initial leader-election attempt has completed. When
   * no leader options are configured this is an already-resolved promise.
   * Callers (e.g. `AutomationService`) can `await` it before bulk-loading
   * rules to ensure the scheduler has an accurate `isLeader` verdict.
   */
  public readonly ready: Promise<void>

  constructor(
    callback: ScheduleCallback,
    leaderOptions: AutomationSchedulerLeaderOptions | null = null,
    runtime: AutomationSchedulerRuntimeOptions = {},
  ) {
    this.callback = callback
    this.leaderOptions = leaderOptions
    this.lockKey = leaderOptions?.lockKey ?? 'automation-scheduler:leader'
    this.ttlMs = leaderOptions?.ttlMs ?? 30_000
    // Renew at ttl/3 by default so two consecutive missed renewals are
    // required before the lock times out.
    this.renewIntervalMs =
      leaderOptions?.renewIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3))
    this.leaderStateGauge = runtime.leaderStateGauge ?? null

    if (leaderOptions) {
      // Default to "follower" until the initial acquisition attempt
      // concludes.  This guarantees the gauge always reports a value once
      // the scheduler is constructed, even before `ready` resolves.
      this.setLeaderGauge('follower')
      // Kick off acquisition asynchronously but expose a promise so callers
      // can wait for the verdict before registering rules in bulk.
      this.ready = this.attemptLeadership().catch((err) => {
        logger.error(
          'Leader-lock acquisition failed; scheduler will behave as non-leader',
          err instanceof Error ? err : undefined,
        )
        this.isLeader = false
        this.setLeaderGauge('follower')
      })
    } else {
      // No leader config → always act as leader (legacy behaviour).
      this.isLeader = true
      this.setLeaderGauge('leader')
      this.ready = Promise.resolve()
    }
  }

  /**
   * Report the current leader state to the injected Prometheus gauge.
   * Sets exactly one of {leader, follower, relinquished} to 1 and the
   * other two to 0 so Prometheus queries like
   * `automation_scheduler_leader{state="leader"} == 1` unambiguously
   * identify the current node. No-op when no gauge was injected.
   */
  private setLeaderGauge(
    state: 'leader' | 'follower' | 'relinquished',
  ): void {
    if (!this.leaderStateGauge) return
    const all: Array<'leader' | 'follower' | 'relinquished'> = [
      'leader',
      'follower',
      'relinquished',
    ]
    try {
      for (const s of all) {
        this.leaderStateGauge.labels({ state: s }).set(s === state ? 1 : 0)
      }
    } catch {
      // Metrics failures must not break the scheduler.
    }
  }

  private async attemptLeadership(): Promise<void> {
    if (!this.leaderOptions) return
    const { leaderLock, ownerId } = this.leaderOptions
    const won = await leaderLock.acquire(this.lockKey, ownerId, this.ttlMs)
    this.isLeader = won
    if (won) {
      logger.info(
        `Acquired scheduler leader lock ${this.lockKey} (owner=${ownerId}, ttl=${this.ttlMs}ms)`,
      )
      this.setLeaderGauge('leader')
      this.startRenewalLoop()
    } else {
      logger.info(
        `Did not acquire scheduler leader lock ${this.lockKey}; operating as non-leader (owner=${ownerId})`,
      )
      this.setLeaderGauge('follower')
    }
  }

  private startRenewalLoop(): void {
    if (!this.leaderOptions) return
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    const { leaderLock, ownerId } = this.leaderOptions
    this.renewalTimer = setInterval(() => {
      // Fire and forget — errors inside the renew path flip the flag so
      // the scheduler relinquishes gracefully on the next tick.
      leaderLock.renew(this.lockKey, ownerId, this.ttlMs).then(
        (ok) => {
          if (!ok) this.relinquishLeadership('renewal rejected')
        },
        (err) => {
          logger.warn(
            `Leader renewal error for ${this.lockKey}: ${err instanceof Error ? err.message : String(err)}`,
          )
          this.relinquishLeadership('renewal error')
        },
      )
    }, this.renewIntervalMs)
    if (typeof this.renewalTimer.unref === 'function') {
      this.renewalTimer.unref()
    }
  }

  /**
   * Tear down all active timers when the leadership lease is lost. A future
   * process can reclaim the lock via normal TTL expiry — no forced retry
   * here, which keeps the behaviour deterministic under network partition.
   */
  private relinquishLeadership(reason: string): void {
    if (!this.isLeader) return
    logger.warn(`Relinquishing scheduler leadership (${reason}); clearing ${this.timers.size} timer(s)`)
    this.isLeader = false
    this.setLeaderGauge('relinquished')
    for (const [ruleId, timer] of this.timers.entries()) {
      clearInterval(timer)
      logger.info(`Cleared schedule for rule ${ruleId} after leader loss`)
    }
    this.timers.clear()
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
  }

  /** Test / diagnostics hook. */
  get leader(): boolean {
    return this.isLeader
  }

  /**
   * Register a scheduled rule (cron or interval trigger).
   * If the rule is already registered, it will be replaced.
   *
   * When the scheduler is configured with a leader lock and this process
   * is NOT the current leader, timer creation is silently skipped — the
   * non-leader keeps tracking which rules *would* have been registered
   * only via its in-memory state and relies on the leader to execute them.
   */
  register(rule: AutomationRule): void {
    // Unregister first if already exists
    this.unregister(rule.id)

    const trigger = rule.trigger
    let intervalMs: number | null = null

    if (trigger.type === 'schedule.interval') {
      intervalMs = typeof trigger.config.intervalMs === 'number' ? trigger.config.intervalMs : null
      if (!intervalMs || intervalMs < 1000) {
        logger.warn(`Rule ${rule.id}: interval too small (${intervalMs}ms), minimum 1000ms`)
        return
      }
    } else if (trigger.type === 'schedule.cron') {
      const expression = typeof trigger.config.expression === 'string' ? trigger.config.expression : ''
      intervalMs = parseCronToIntervalMs(expression)
      if (!intervalMs) {
        logger.warn(`Rule ${rule.id}: unsupported cron expression: ${expression}`)
        return
      }
    } else {
      // Not a schedule trigger — skip
      return
    }

    if (!this.isLeader) {
      // Non-leaders silently skip timer creation; the leader owns execution.
      logger.debug(`Rule ${rule.id}: non-leader instance — skipping timer`)
      return
    }

    const timer = setInterval(() => {
      try {
        const result = this.callback(rule)
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            logger.error(`Scheduled rule ${rule.id} execution failed`, err instanceof Error ? err : undefined)
          })
        }
      } catch (err) {
        logger.error(`Scheduled rule ${rule.id} execution failed`, err instanceof Error ? err : undefined)
      }
    }, intervalMs)

    // Prevent timer from keeping the process alive in tests
    if (typeof timer.unref === 'function') {
      timer.unref()
    }

    this.timers.set(rule.id, timer)
    logger.info(`Registered schedule for rule ${rule.id} (interval: ${intervalMs}ms)`)
  }

  /**
   * Unregister a scheduled rule.
   */
  unregister(ruleId: string): void {
    const timer = this.timers.get(ruleId)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(ruleId)
      logger.info(`Unregistered schedule for rule ${ruleId}`)
    }
  }

  /**
   * Check if a rule is currently scheduled.
   */
  isRegistered(ruleId: string): boolean {
    return this.timers.has(ruleId)
  }

  /**
   * Get count of active scheduled rules.
   */
  get activeCount(): number {
    return this.timers.size
  }

  /**
   * Cleanup all timers.
   */
  destroy(): void {
    for (const [ruleId, timer] of this.timers.entries()) {
      clearInterval(timer)
      logger.info(`Destroyed schedule for rule ${ruleId}`)
    }
    this.timers.clear()
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer)
      this.renewalTimer = null
    }
    if (this.leaderOptions && this.isLeader) {
      // Best-effort lock release so a replacement replica can take over
      // without waiting for the full TTL. Failures are intentionally
      // swallowed — Redis will eventually expire the key regardless.
      const { leaderLock, ownerId } = this.leaderOptions
      leaderLock.release(this.lockKey, ownerId).catch(() => {})
      this.isLeader = false
    }
  }
}
