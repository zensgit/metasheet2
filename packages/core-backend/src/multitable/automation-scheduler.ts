/**
 * Automation Scheduler — V1
 * Manages cron and interval triggers.
 * Cron triggers use UTC minute-resolution next-occurrence scheduling; interval
 * and date-field scans use fixed setInterval cadences.
 */

import { Logger } from '../core/logger'
import { dateReminderScanIntervalMs, type ScheduleDateFieldConfig } from './automation-date-reminder'
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

type CronField = ReadonlySet<number>

interface ParsedCronExpression {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
  dayOfMonthWildcard: boolean
  dayOfWeekWildcard: boolean
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  options: { sundaySeven?: boolean } = {},
): { values: Set<number>; wildcard: boolean } | null {
  if (!raw) return null
  const values = new Set<number>()
  const wildcard = raw === '*'

  for (const piece of raw.split(',')) {
    if (!piece) return null
    const [rangePart, stepPart] = piece.split('/')
    if (piece.split('/').length > 2) return null
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) return null

    let start: number
    let end: number
    if (rangePart === '*') {
      start = min
      end = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      if (!a || !b || rangePart.split('-').length !== 2) return null
      start = Number(a)
      end = Number(b)
    } else {
      start = Number(rangePart)
      end = start
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) return null
    if (start < min || start > max || end < min || end > max) return null
    if (start > end) return null
    for (let v = start; v <= end; v += step) {
      values.add(options.sundaySeven && v === 7 ? 0 : v)
    }
  }

  if (values.size === 0) return null
  return { values, wildcard }
}

export function parseCronExpression(expression: string): ParsedCronExpression | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts
  const minute = parseCronField(minuteRaw, 0, 59)
  const hour = parseCronField(hourRaw, 0, 23)
  const dayOfMonth = parseCronField(domRaw, 1, 31)
  const month = parseCronField(monthRaw, 1, 12)
  const dayOfWeek = parseCronField(dowRaw, 0, 7, { sundaySeven: true })
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    dayOfMonthWildcard: dayOfMonth.wildcard,
    dayOfWeekWildcard: dayOfWeek.wildcard,
  }
}

function cronMatches(parsed: ParsedCronExpression, date: Date): boolean {
  if (!parsed.minute.has(date.getUTCMinutes())) return false
  if (!parsed.hour.has(date.getUTCHours())) return false
  if (!parsed.month.has(date.getUTCMonth() + 1)) return false

  const domMatches = parsed.dayOfMonth.has(date.getUTCDate())
  const dowMatches = parsed.dayOfWeek.has(date.getUTCDay())
  if (parsed.dayOfMonthWildcard && parsed.dayOfWeekWildcard) return true
  if (parsed.dayOfMonthWildcard) return dowMatches
  if (parsed.dayOfWeekWildcard) return domMatches
  // Standard cron semantics: when both DOM and DOW are restricted, either can match.
  return domMatches || dowMatches
}

/** Leap-safe maximum day each month (1..12) can host (February = 29). */
const MONTH_MAX_DAYS: Readonly<Record<number, number>> = {
  1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
  7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
}

/**
 * True when a PARSED cron's day fields can never select a real calendar day.
 * Provably safe — only reports "impossible" when day-of-week is a wildcard
 * (otherwise the DOM/DOW OR-semantics could still match via a weekday, so the
 * day is reachable), day-of-month is restricted, and the smallest requested
 * day-of-month exceeds the largest day ANY restricted month can host.
 */
function dayUnreachable(parsed: ParsedCronExpression): boolean {
  // DOW restricted → a matching weekday can occur regardless of DOM (OR-semantics).
  if (!parsed.dayOfWeekWildcard) return false
  // DOM wildcard → every day is allowed.
  if (parsed.dayOfMonthWildcard) return false

  let maxHostableDay = 0
  for (const m of parsed.month) {
    const d = MONTH_MAX_DAYS[m] ?? 31
    if (d > maxHostableDay) maxHostableDay = d
  }
  let minRequestedDay = Infinity
  for (const d of parsed.dayOfMonth) {
    if (d < minRequestedDay) minRequestedDay = d
  }
  return minRequestedDay > maxHostableDay
}

/**
 * Cheap pre-check exposing {@link dayUnreachable} for a raw cron string so
 * `nextCronOccurrenceMs` (and tests) can prune day-impossible expressions —
 * e.g. `0 0 30 2 *` (February 30th) — instead of scanning ~5 years of minutes.
 * Returns `false` for unparseable input (that null path is handled by the
 * caller's own parse). February uses 29 so `0 0 29 2 *` is NOT pruned.
 */
export function cronHasNoMatchingDay(expression: string): boolean {
  const parsed = parseCronExpression(expression)
  if (!parsed) return false
  return dayUnreachable(parsed)
}

export function nextCronOccurrenceMs(expression: string, fromMs: number = Date.now()): number | null {
  const parsed = parseCronExpression(expression)
  if (!parsed) return null
  // Fast path: a day-impossible cron (e.g. Feb 30) would otherwise scan the full
  // ~5-year window before returning null. Short-circuit it up front.
  if (dayUnreachable(parsed)) return null
  const minuteMs = 60 * 1000
  let candidate = Math.floor(fromMs / minuteMs) * minuteMs + minuteMs
  const max = candidate + 5 * 366 * 24 * 60 * minuteMs
  while (candidate <= max) {
    if (cronMatches(parsed, new Date(candidate))) return candidate
    candidate += minuteMs
  }
  return null
}

/**
 * Legacy helper kept for callers/tests that need the old fixed-interval
 * approximation. The scheduler itself uses `nextCronOccurrenceMs` so custom
 * wall-clock expressions such as `15 9 * * *` fire at the requested time.
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
      this.clearTimer(timer)
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

  private runScheduledRule(rule: AutomationRule): void {
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
  }

  /**
   * Cancel a rule timer. The `timers` map mixes setTimeout handles (cron,
   * which re-arm) and setInterval handles (interval / date_field scans).
   * Node's `clearTimeout` cancels both kinds — they share one `Timeout`
   * object — so routing every rule-timer teardown through this one helper
   * keeps the call sites consistent without tracking each handle's kind. The
   * renewal loop is cleared separately with `clearInterval`; it is not a rule
   * timer and never enters this map.
   */
  private clearTimer(timer: NodeJS.Timeout): void {
    clearTimeout(timer)
  }

  private registerCron(rule: AutomationRule, expression: string): void {
    const nextMs = nextCronOccurrenceMs(expression)
    if (!nextMs) {
      logger.warn(`Rule ${rule.id}: unsupported cron expression: ${expression}`)
      return
    }
    const delayMs = Math.max(1_000, nextMs - Date.now())
    const timer = setTimeout(() => {
      if (!this.timers.has(rule.id)) return
      this.runScheduledRule(rule)
      this.timers.delete(rule.id)
      if (this.isLeader) this.registerCron(rule, expression)
    }, delayMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.timers.set(rule.id, timer)
    logger.info(`Registered cron schedule for rule ${rule.id} (next: ${new Date(nextMs).toISOString()})`)
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
    let cronExpression: string | null = null

    if (trigger.type === 'schedule.interval') {
      intervalMs = typeof trigger.config.intervalMs === 'number' ? trigger.config.intervalMs : null
      if (!intervalMs || intervalMs < 1000) {
        logger.warn(`Rule ${rule.id}: interval too small (${intervalMs}ms), minimum 1000ms`)
        return
      }
    } else if (trigger.type === 'schedule.cron') {
      cronExpression = typeof trigger.config.expression === 'string'
        ? trigger.config.expression
        : typeof trigger.config.cron === 'string'
          ? trigger.config.cron
          : ''
      if (!nextCronOccurrenceMs(cronExpression)) {
        logger.warn(`Rule ${rule.id}: unsupported cron expression: ${cronExpression}`)
        return
      }
    } else if (trigger.type === 'schedule.date_field') {
      // Date-reminder: a fixed SCAN cadence (default daily). The timer fires the same callback as cron, but
      // the service callback branches on the type and runs evaluateDateReminders (scan → claim → fire) rather
      // than executing the rule once. Correctness lives in the firing-window predicate, not the cadence.
      intervalMs = dateReminderScanIntervalMs(trigger.config as Partial<ScheduleDateFieldConfig>)
    } else {
      // Not a schedule trigger — skip
      return
    }

    if (!this.isLeader) {
      // Non-leaders silently skip timer creation; the leader owns execution.
      logger.debug(`Rule ${rule.id}: non-leader instance — skipping timer`)
      return
    }

    if (cronExpression) {
      this.registerCron(rule, cronExpression)
      return
    }

    const timer = setInterval(() => {
      this.runScheduledRule(rule)
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
      this.clearTimer(timer)
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
      this.clearTimer(timer)
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
