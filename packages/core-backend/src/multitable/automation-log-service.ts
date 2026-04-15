/**
 * Automation Execution Log Service — V2 (PostgreSQL-backed)
 * Replaces the in-memory circular buffer with Kysely queries
 * against the multitable_automation_executions table.
 */

import { sql } from 'kysely'
import { db } from '../db/db'
import type { AutomationExecution, AutomationStepResult } from './automation-executor'

export interface AutomationStats {
  total: number
  success: number
  failed: number
  skipped: number
  avgDuration: number
}

export class AutomationLogService {
  /**
   * Record an execution log by inserting into the database.
   */
  async record(execution: AutomationExecution): Promise<void> {
    await db
      .insertInto('multitable_automation_executions')
      .values({
        id: execution.id,
        rule_id: execution.ruleId,
        triggered_by: execution.triggeredBy,
        triggered_at: execution.triggeredAt,
        status: execution.status,
        steps: JSON.stringify(execution.steps) as unknown as Record<string, unknown>[],
        error: execution.error ?? null,
        duration: execution.duration ?? null,
      })
      .execute()
  }

  /**
   * Get executions for a specific rule, newest first.
   */
  async getByRule(ruleId: string, limit = 50): Promise<AutomationExecution[]> {
    const rows = await db
      .selectFrom('multitable_automation_executions')
      .selectAll()
      .where('rule_id', '=', ruleId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()

    return rows.map(toExecution)
  }

  /**
   * Get recent executions across all rules, newest first.
   */
  async getRecent(limit = 50): Promise<AutomationExecution[]> {
    const rows = await db
      .selectFrom('multitable_automation_executions')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()

    return rows.map(toExecution)
  }

  /**
   * Get a specific execution by ID.
   */
  async getById(executionId: string): Promise<AutomationExecution | undefined> {
    const row = await db
      .selectFrom('multitable_automation_executions')
      .selectAll()
      .where('id', '=', executionId)
      .executeTakeFirst()

    return row ? toExecution(row) : undefined
  }

  /**
   * Get aggregate stats for a rule.
   */
  async getStats(ruleId: string): Promise<AutomationStats> {
    const row = await db
      .selectFrom('multitable_automation_executions')
      .select([
        sql<number>`COUNT(*)::int`.as('total'),
        sql<number>`COUNT(*) FILTER (WHERE status = 'success')::int`.as('success'),
        sql<number>`COUNT(*) FILTER (WHERE status = 'failed')::int`.as('failed'),
        sql<number>`COUNT(*) FILTER (WHERE status = 'skipped')::int`.as('skipped'),
        sql<number>`COALESCE(AVG(duration) FILTER (WHERE duration > 0), 0)::int`.as('avg_duration'),
      ])
      .where('rule_id', '=', ruleId)
      .executeTakeFirst()

    if (!row) {
      return { total: 0, success: 0, failed: 0, skipped: 0, avgDuration: 0 }
    }

    return {
      total: Number(row.total),
      success: Number(row.success),
      failed: Number(row.failed),
      skipped: Number(row.skipped),
      avgDuration: Math.round(Number(row.avg_duration)),
    }
  }

  /**
   * Remove execution logs older than the given retention period.
   */
  async cleanup(retentionDays = 30): Promise<number> {
    const result = await db
      .deleteFrom('multitable_automation_executions')
      .where('created_at', '<', sql`NOW() - INTERVAL '${sql.raw(String(retentionDays))} days'`)
      .executeTakeFirst()

    return Number(result.numDeletedRows ?? 0)
  }
}

// ── Row-to-domain mapper ────────────────────────────────────────────────────

function toExecution(row: Record<string, unknown>): AutomationExecution {
  return {
    id: row.id as string,
    ruleId: row.rule_id as string,
    triggeredBy: row.triggered_by as string,
    triggeredAt:
      row.triggered_at instanceof Date
        ? row.triggered_at.toISOString()
        : String(row.triggered_at),
    status: row.status as AutomationExecution['status'],
    steps: (typeof row.steps === 'string'
      ? JSON.parse(row.steps)
      : row.steps) as AutomationStepResult[],
    error: (row.error as string) ?? undefined,
    duration: row.duration != null ? Number(row.duration) : undefined,
  }
}
