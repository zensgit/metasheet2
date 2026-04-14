/**
 * Automation Execution Log Service — V1
 * In-memory circular buffer for execution logs.
 * State is lost on restart; suitable for V1.
 */

import type { AutomationExecution } from './automation-executor'

export interface AutomationStats {
  total: number
  success: number
  failed: number
  skipped: number
  avgDuration: number
}

export class AutomationLogService {
  private logs: AutomationExecution[] = []
  private maxLogs: number

  constructor(maxLogs = 1000) {
    this.maxLogs = maxLogs
  }

  /**
   * Record an execution log. Circular buffer — oldest entries are evicted.
   */
  record(execution: AutomationExecution): void {
    this.logs.push(execution)
    if (this.logs.length > this.maxLogs) {
      this.logs.splice(0, this.logs.length - this.maxLogs)
    }
  }

  /**
   * Get executions for a specific rule, newest first.
   */
  getByRule(ruleId: string, limit = 50): AutomationExecution[] {
    const filtered = this.logs.filter((l) => l.ruleId === ruleId)
    return filtered.slice(-limit).reverse()
  }

  /**
   * Get recent executions across all rules, newest first.
   */
  getRecent(limit = 50): AutomationExecution[] {
    return this.logs.slice(-limit).reverse()
  }

  /**
   * Get a specific execution by ID.
   */
  getById(executionId: string): AutomationExecution | undefined {
    return this.logs.find((l) => l.id === executionId)
  }

  /**
   * Get aggregate stats for a rule.
   */
  getStats(ruleId: string): AutomationStats {
    const ruleLogs = this.logs.filter((l) => l.ruleId === ruleId)
    const total = ruleLogs.length
    const success = ruleLogs.filter((l) => l.status === 'success').length
    const failed = ruleLogs.filter((l) => l.status === 'failed').length
    const skipped = ruleLogs.filter((l) => l.status === 'skipped').length

    const durations = ruleLogs
      .map((l) => l.duration)
      .filter((d): d is number => typeof d === 'number' && d > 0)
    const avgDuration = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0

    return { total, success, failed, skipped, avgDuration }
  }

  /**
   * Get total log count.
   */
  get size(): number {
    return this.logs.length
  }

  /**
   * Clear all logs.
   */
  clear(): void {
    this.logs = []
  }
}
