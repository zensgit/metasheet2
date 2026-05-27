/**
 * Automation Execution Log Service — V2 (PostgreSQL-backed)
 * Replaces the in-memory circular buffer with Kysely queries
 * against the multitable_automation_executions table.
 */

import { sql } from 'kysely'
import { db } from '../db/db'
import { toJsonValue } from '../db/type-helpers'
import { AUTOMATION_EXECUTION_SCHEMA_VERSION } from './automation-executor'
import type { AutomationExecution, AutomationStepResult } from './automation-executor'
import { redactString, redactValue } from './automation-log-redact'

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
    // Redact secret-shaped values out of ALL FOUR free-form channels BEFORE they
    // hit the DB (they ride into the runs UI and would survive any future replay):
    // steps (recursive — covers step.output/step.error), trigger_event,
    // rule_snapshot, and the execution-level error. Business field values are
    // preserved — this is secret-shaped value scrubbing only.
    // node-postgres treats JS arrays as PostgreSQL array literals unless we cast explicit JSON text.
    const stepsJsonb = toJsonValue(redactValue(execution.steps)) as unknown as Record<string, unknown>[]
    const triggerEventJsonb =
      execution.triggerEvent == null
        ? null
        : (toJsonValue(redactValue(execution.triggerEvent)) as unknown as Record<string, unknown>)
    const ruleSnapshotJsonb =
      execution.ruleSnapshot == null
        ? null
        : (toJsonValue(redactValue(execution.ruleSnapshot)) as unknown as Record<string, unknown>)
    await db
      .insertInto('multitable_automation_executions')
      .values({
        id: execution.id,
        rule_id: execution.ruleId,
        triggered_by: execution.triggeredBy,
        triggered_at: execution.triggeredAt,
        status: execution.status,
        steps: stepsJsonb,
        error: execution.error != null ? redactString(execution.error) : null,
        duration: execution.duration ?? null,
        sheet_id: execution.sheetId ?? null,
        trigger_event: triggerEventJsonb,
        rule_snapshot: ruleSnapshotJsonb,
        finished_at: execution.finishedAt ?? null,
        schema_version: execution.schemaVersion ?? AUTOMATION_EXECUTION_SCHEMA_VERSION,
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
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    const result = await db
      .deleteFrom('multitable_automation_executions')
      .where('created_at', '<', cutoff)
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
    // A1 snapshot fields — null-safe for rows predating the migration.
    sheetId: (row.sheet_id as string) ?? undefined,
    triggerEvent: parseJsonColumn(row.trigger_event),
    ruleSnapshot: parseJsonColumn(row.rule_snapshot) as AutomationExecution['ruleSnapshot'],
    finishedAt:
      row.finished_at == null
        ? undefined
        : row.finished_at instanceof Date
          ? row.finished_at.toISOString()
          : String(row.finished_at),
    schemaVersion: row.schema_version != null ? Number(row.schema_version) : undefined,
  }
}

/** JSONB columns arrive as parsed objects from pg, but tolerate string form too. */
function parseJsonColumn(value: unknown): unknown {
  if (value == null) return undefined
  return typeof value === 'string' ? JSON.parse(value) : value
}
