/**
 * Wave 2 WP5 slice 1 — SLA breach scanner.
 *
 * Runs a periodic (default 15 min) scan that flips `sla_breached = TRUE`
 * on approval_metrics rows whose `started_at + sla_hours` have elapsed.
 * Single-process interval with a one-run guard — multi-instance fleets
 * should either disable the scheduler on all but one pod (env
 * APPROVAL_SLA_SCHEDULER_DISABLED=1) or wrap this in leader election at
 * a future point.
 */

import { Logger } from '../core/logger'
import { getApprovalMetricsService, type ApprovalMetricsService } from './ApprovalMetricsService'

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const MIN_INTERVAL_MS = 5000

export interface ApprovalSlaSchedulerOptions {
  metrics?: ApprovalMetricsService
  intervalMs?: number
  /**
   * Optional hook invoked once per breach cycle with the newly-breached
   * instance ids. Main caller wires it to approval audit + notifications.
   */
  onBreach?: (instanceIds: string[]) => Promise<void> | void
  logger?: Logger
}

export class ApprovalSlaScheduler {
  private readonly logger: Logger
  private readonly metrics: ApprovalMetricsService
  private readonly intervalMs: number
  private readonly onBreach: ApprovalSlaSchedulerOptions['onBreach']
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(options: ApprovalSlaSchedulerOptions = {}) {
    this.metrics = options.metrics ?? getApprovalMetricsService()
    this.intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.onBreach = options.onBreach
    this.logger = options.logger ?? new Logger('ApprovalSlaScheduler')
  }

  start(): void {
    if (this.timer) return
    this.logger.info(`SLA scheduler starting with interval ${this.intervalMs}ms`)
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.logger.info('SLA scheduler stopped')
  }

  async tick(now: Date = new Date()): Promise<string[]> {
    if (this.running) return []
    this.running = true
    try {
      const breached = await this.metrics.checkSlaBreaches(now)
      if (breached.length > 0) {
        this.logger.warn(`SLA breaches flagged: ${breached.length}`)
        if (this.onBreach) {
          try {
            await this.onBreach(breached)
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
