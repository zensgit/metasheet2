/**
 * Automation Scheduler — V1
 * Manages cron and interval triggers.
 * V1 supports setInterval-based scheduling and simplified cron patterns.
 */

import { Logger } from '../core/logger'
import type { AutomationRule } from './automation-executor'

const logger = new Logger('AutomationScheduler')

export type ScheduleCallback = (rule: AutomationRule) => void | Promise<void>

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

  constructor(callback: ScheduleCallback) {
    this.callback = callback
  }

  /**
   * Register a scheduled rule (cron or interval trigger).
   * If the rule is already registered, it will be replaced.
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
  }
}
