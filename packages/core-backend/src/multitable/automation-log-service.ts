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
    const persisted = toPersistedExecutionValues(execution)
    await db
      .insertInto('multitable_automation_executions')
      .values({
        id: execution.id,
        rule_id: execution.ruleId,
        triggered_by: execution.triggeredBy,
        triggered_at: execution.triggeredAt,
        status: execution.status,
        steps: persisted.stepsJsonb,
        error: persisted.error,
        duration: execution.duration ?? null,
        sheet_id: execution.sheetId ?? null,
        trigger_event: persisted.triggerEventJsonb,
        rule_snapshot: persisted.ruleSnapshotJsonb,
        finished_at: execution.finishedAt ?? null,
        schema_version: execution.schemaVersion ?? AUTOMATION_EXECUTION_SCHEMA_VERSION,
        // A5 retry provenance — plain identifiers, NOT redacted (an execution id / a user id).
        rerun_of_execution_id: execution.rerunOfExecutionId ?? null,
        initiated_by: execution.initiatedBy ?? null,
      })
      .execute()
  }

  /**
   * Update an already-inserted execution row. A6-1 uses this after pre-creating
   * the parent execution before job/action side effects, so job rows never become
   * invisible orphans just because final execution persistence is delayed.
   */
  async updateRecordedExecution(execution: AutomationExecution): Promise<void> {
    const persisted = toPersistedExecutionValues(execution)
    await db
      .updateTable('multitable_automation_executions')
      .set({
        status: execution.status,
        steps: persisted.stepsJsonb,
        error: persisted.error,
        duration: execution.duration ?? null,
        sheet_id: execution.sheetId ?? null,
        trigger_event: persisted.triggerEventJsonb,
        rule_snapshot: persisted.ruleSnapshotJsonb,
        finished_at: execution.finishedAt ?? null,
        schema_version: execution.schemaVersion ?? AUTOMATION_EXECUTION_SCHEMA_VERSION,
        rerun_of_execution_id: execution.rerunOfExecutionId ?? null,
        initiated_by: execution.initiatedBy ?? null,
      })
      .where('id', '=', execution.id)
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
   * List executions across rules with optional filters (A2 read-only runs API).
   * `status` is the LEGACY stored value — the route resolves C1↔legacy (and the
   * "future-state → empty" case) before calling, so this stays a plain equality.
   */
  async listExecutions(
    filters: { sheetId?: string; ruleId?: string; status?: string; limit?: number } = {},
  ): Promise<AutomationExecution[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)
    let q = db.selectFrom('multitable_automation_executions').selectAll()
    if (filters.sheetId) q = q.where('sheet_id', '=', filters.sheetId)
    if (filters.ruleId) q = q.where('rule_id', '=', filters.ruleId)
    if (filters.status) q = q.where('status', '=', filters.status)
    const rows = await q.orderBy('created_at', 'desc').limit(limit).execute()
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

function toPersistedExecutionValues(execution: AutomationExecution): {
  stepsJsonb: Record<string, unknown>[]
  triggerEventJsonb: Record<string, unknown> | null
  ruleSnapshotJsonb: Record<string, unknown> | null
  error: string | null
} {
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
  return {
    stepsJsonb,
    triggerEventJsonb,
    ruleSnapshotJsonb,
    error: execution.error != null ? redactString(execution.error) : null,
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
    // A5 retry provenance — null-safe for non-retry / pre-A5 rows.
    rerunOfExecutionId: (row.rerun_of_execution_id as string) ?? undefined,
    initiatedBy: (row.initiated_by as string) ?? undefined,
  }
}

/** JSONB columns arrive as parsed objects from pg, but tolerate string form too. */
function parseJsonColumn(value: unknown): unknown {
  if (value == null) return undefined
  return typeof value === 'string' ? JSON.parse(value) : value
}

/**
 * Redact an IN-MEMORY AutomationExecution for an HTTP response — the same four
 * secret channels `record()` scrubs at persist (steps / triggerEvent / ruleSnapshot
 * / error), returning a NEW object with the flat AutomationExecution shape intact.
 *
 * Used as the SAFE fallback when the persisted (already-redacted) row can't be
 * re-fetched: a fresh in-memory execution carries the live rule (credentials) in
 * `ruleSnapshot` and raw action output in `steps`, which must never be serialized
 * raw. Prefer the persisted row; fall back to this — never the raw execution.
 */
export function redactAutomationExecutionForResponse(execution: AutomationExecution): AutomationExecution {
  return {
    ...execution,
    steps: redactValue(execution.steps) as AutomationStepResult[],
    triggerEvent: redactValue(execution.triggerEvent),
    ruleSnapshot: redactValue(execution.ruleSnapshot) as AutomationExecution['ruleSnapshot'],
    error: execution.error !== undefined ? redactString(execution.error) : undefined,
  }
}
