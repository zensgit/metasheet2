/**
 * Wave 2 WP5 slice 1 — SLA / approval-duration observability.
 *
 * Per-instance metrics pipeline. Writes are driven by hooks in
 * ApprovalProductService; all hooks are guarded (log-and-swallow) so
 * metrics failures cannot break the parent approval flow.
 *
 * Query API is injected via the `Query` type so unit tests can mock
 * the pg pool without needing a live database.
 */

import { pool } from '../db/pg'

export type Query = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export type TransactionRunner = <T>(
  fn: (query: Query) => Promise<T>,
) => Promise<T>

export type ApprovalTerminalState = 'approved' | 'rejected' | 'revoked' | 'returned'

export interface NodeBreakdownEntry {
  nodeKey: string
  activatedAt: string | null
  decidedAt: string | null
  durationSeconds: number | null
  approverIds: string[]
}

export interface ApprovalMetricsRow {
  id: string
  instance_id: string
  template_id: string | null
  tenant_id: string
  started_at: string
  terminal_at: string | null
  terminal_state: ApprovalTerminalState | null
  duration_seconds: number | null
  sla_hours: number | null
  sla_breached: boolean
  sla_breached_at: string | null
  node_breakdown: NodeBreakdownEntry[]
  created_at: string
  updated_at: string
}

export interface MetricsSummaryTemplateRow {
  templateId: string | null
  total: number
  approved: number
  rejected: number
  revoked: number
  avgDurationSeconds: number | null
  slaBreachRate: number
}

export interface MetricsSummary {
  total: number
  approved: number
  rejected: number
  revoked: number
  returned: number
  running: number
  avgDurationSeconds: number | null
  p50DurationSeconds: number | null
  p95DurationSeconds: number | null
  slaBreachCount: number
  slaCandidateCount: number
  slaBreachRate: number
  byTemplate: MetricsSummaryTemplateRow[]
}

export interface MetricsTopInstanceRow {
  instanceId: string
  templateId: string | null
  startedAt: string
  terminalAt: string | null
  terminalState: ApprovalTerminalState | null
  durationSeconds: number
  slaHours: number | null
  slaBreached: boolean
  slaBreachedAt: string | null
}

export interface MetricsTopTemplateRow {
  templateId: string | null
  total: number
  slaCandidateCount: number
  slaBreachCount: number
  slaBreachRate: number
  avgDurationSeconds: number | null
  p95DurationSeconds: number | null
}

export interface MetricsReport {
  summary: MetricsSummary
  slowestInstances: MetricsTopInstanceRow[]
  breachedTemplates: MetricsTopTemplateRow[]
}

export interface ApprovalBreachContext {
  instanceId: string
  templateId: string | null
  templateName: string | null
  currentNodeKey: string | null
  requesterName: string | null
  startedAt: string
  slaHours: number | null
  breachedAt: string | null
}

export interface MetricsSummaryQuery {
  tenantId?: string
  since?: Date | string
  until?: Date | string
  limit?: number
}

const DEFAULT_TENANT_ID = 'default'

function resolveTenantId(tenantId?: string | null): string {
  const normalized = typeof tenantId === 'string' ? tenantId.trim() : ''
  return normalized.length > 0 ? normalized : DEFAULT_TENANT_ID
}

function normalizeDate(value: Date | string | undefined | null): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function clampReportLimit(value: number | undefined | null): number {
  return Math.max(1, Math.min(Number.isFinite(value) ? Number(value) : 10, 50))
}

function toNodeBreakdown(raw: unknown): NodeBreakdownEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is NodeBreakdownEntry => {
    return Boolean(entry) && typeof entry === 'object' && 'nodeKey' in (entry as Record<string, unknown>)
  })
}

export class ApprovalMetricsService {
  private readonly transaction: TransactionRunner

  constructor(
    private readonly query: Query = defaultQuery,
    transaction?: TransactionRunner,
  ) {
    this.transaction = transaction ?? (
      query === defaultQuery
        ? defaultTransaction
        : ((fn) => fn(query))
    )
  }

  /**
   * Insert a metrics row when a new approval instance is created. Idempotent:
   * a duplicate instance_id is a no-op (approval flow may retry internally).
   */
  async recordInstanceStart(input: {
    instanceId: string
    templateId: string | null
    tenantId?: string | null
    startedAt: Date
    slaHours?: number | null
    initialNodeKey?: string | null
  }): Promise<void> {
    const tenantId = resolveTenantId(input.tenantId)
    const initialBreakdown: NodeBreakdownEntry[] = input.initialNodeKey
      ? [{
        nodeKey: input.initialNodeKey,
        activatedAt: input.startedAt.toISOString(),
        decidedAt: null,
        durationSeconds: null,
        approverIds: [],
      }]
      : []
    await this.query(
      `INSERT INTO approval_metrics
         (instance_id, template_id, tenant_id, started_at, sla_hours, node_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (instance_id) DO NOTHING`,
      [
        input.instanceId,
        input.templateId,
        tenantId,
        input.startedAt.toISOString(),
        input.slaHours ?? null,
        JSON.stringify(initialBreakdown),
      ],
    )
  }

  /**
   * Append a fresh entry to node_breakdown marking the node's activation.
   * If the node already has an open entry (same key, no decidedAt), leave it
   * alone — ApprovalProductService may re-emit on retries.
   */
  async recordNodeActivation(input: {
    instanceId: string
    nodeKey: string
    activatedAt: Date
  }): Promise<void> {
    await this.mutateBreakdown(input.instanceId, (breakdown) => {
      const hasOpen = breakdown.some(
        (entry) => entry.nodeKey === input.nodeKey && !entry.decidedAt,
      )
      if (hasOpen) return null
      breakdown.push({
        nodeKey: input.nodeKey,
        activatedAt: input.activatedAt.toISOString(),
        decidedAt: null,
        durationSeconds: null,
        approverIds: [],
      })
      return breakdown
    })
  }

  /**
   * Close the most recent open entry for `nodeKey`. If no open entry exists
   * (e.g. metrics were wired mid-flight), synthesize a zero-duration entry
   * so the audit trail isn't silently dropped.
   */
  async recordNodeDecision(input: {
    instanceId: string
    nodeKey: string
    decidedAt: Date
    approverIds: string[]
  }): Promise<void> {
    await this.mutateBreakdown(input.instanceId, (breakdown) => {
      const openIndex = [...breakdown].reverse().findIndex(
        (entry) => entry.nodeKey === input.nodeKey && !entry.decidedAt,
      )
      if (openIndex >= 0) {
        const trueIndex = breakdown.length - 1 - openIndex
        const entry = breakdown[trueIndex]
        const activatedMs = entry.activatedAt ? Date.parse(entry.activatedAt) : NaN
        const duration = Number.isFinite(activatedMs)
          ? Math.max(0, Math.floor((input.decidedAt.getTime() - activatedMs) / 1000))
          : null
        breakdown[trueIndex] = {
          ...entry,
          decidedAt: input.decidedAt.toISOString(),
          durationSeconds: duration,
          approverIds: input.approverIds,
        }
      } else {
        breakdown.push({
          nodeKey: input.nodeKey,
          activatedAt: null,
          decidedAt: input.decidedAt.toISOString(),
          durationSeconds: null,
          approverIds: input.approverIds,
        })
      }
      return breakdown
    })
  }

  /**
   * Mark the instance terminal: set terminal_at, terminal_state, and
   * duration_seconds = terminal_at - started_at. Overwrites any previously
   * set terminal fields — callers should only invoke when the approval
   * instance actually enters a terminal status (approved/rejected/revoked),
   * or when 'returned' is a deliberate close-out.
   */
  async recordTerminal(input: {
    instanceId: string
    terminalState: ApprovalTerminalState
    terminalAt: Date
  }): Promise<void> {
    await this.query(
      `UPDATE approval_metrics
         SET terminal_at = $2,
             terminal_state = $3,
             duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - started_at))::INTEGER)
       WHERE instance_id = $1`,
      [input.instanceId, input.terminalAt.toISOString(), input.terminalState],
    )
  }

  /**
   * Find all active rows where started_at + sla_hours has elapsed and mark
   * them breached. Returns the list of newly-breached instance ids so the
   * caller can emit audit events / notifications.
   */
  async checkSlaBreaches(now: Date): Promise<string[]> {
    const result = await this.query<{ instance_id: string }>(
      `UPDATE approval_metrics
         SET sla_breached = TRUE,
             sla_breached_at = $1
       WHERE terminal_at IS NULL
         AND sla_hours IS NOT NULL
         AND sla_breached = FALSE
         AND started_at + (sla_hours * interval '1 hour') < $1
       RETURNING instance_id`,
      [now.toISOString()],
    )
    return result.rows.map((row) => row.instance_id)
  }

  /**
   * Persist that the breach notifier successfully dispatched for the given
   * instance. Sets `breach_notified_at` only if it was previously NULL — so
   * a redundant call (e.g. retry after restart) is a safe no-op rather than
   * a duplicate timestamp overwrite.
   *
   * Pairs with migration 058 (`breach_notified_at TIMESTAMPTZ NULL`).
   */
  async markBreachNotified(instanceId: string, now: Date = new Date()): Promise<void> {
    if (typeof instanceId !== 'string' || instanceId.trim().length === 0) return
    await this.query(
      `UPDATE approval_metrics
          SET breach_notified_at = $1
        WHERE instance_id = $2
          AND breach_notified_at IS NULL`,
      [now.toISOString(), instanceId.trim()],
    )
  }

  /**
   * Find rows that were flagged as breached but never had a successful
   * notifier dispatch persisted. Used by the notifier on startup to retry
   * the dispatches that were lost when the previous leader process died
   * between `channel.send` and `markNotified` (in-memory dedupe was lost
   * but the DB flag was already TRUE so checkSlaBreaches would never
   * return them again).
   *
   * Capped to keep the recovery query bounded; the caller is expected to
   * iterate if more rows exist than the cap.
   */
  async findUnnotifiedBreaches(limit = 500): Promise<string[]> {
    const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 5000) : 500
    const result = await this.query<{ instance_id: string }>(
      `SELECT instance_id
         FROM approval_metrics
        WHERE sla_breached = TRUE
          AND breach_notified_at IS NULL
        ORDER BY sla_breached_at ASC
        LIMIT ${cap}`,
    )
    return result.rows.map((row) => row.instance_id)
  }

  async getMetricsSummary(input: MetricsSummaryQuery = {}): Promise<MetricsSummary> {
    const tenantId = resolveTenantId(input.tenantId)
    const since = normalizeDate(input.since)
    const until = normalizeDate(input.until)

    const conditions: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    if (since) {
      params.push(since.toISOString())
      conditions.push(`started_at >= $${params.length}`)
    }
    if (until) {
      params.push(until.toISOString())
      conditions.push(`started_at <= $${params.length}`)
    }
    const where = `WHERE ${conditions.join(' AND ')}`

    const overall = await this.query<{
      total: string
      approved: string
      rejected: string
      revoked: string
      returned: string
      running: string
      avg_duration: string | null
      p50_duration: string | null
      p95_duration: string | null
      sla_breach_count: string
      sla_candidate_count: string
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE terminal_state = 'approved')::text AS approved,
         COUNT(*) FILTER (WHERE terminal_state = 'rejected')::text AS rejected,
         COUNT(*) FILTER (WHERE terminal_state = 'revoked')::text AS revoked,
         COUNT(*) FILTER (WHERE terminal_state = 'returned')::text AS returned,
         COUNT(*) FILTER (WHERE terminal_state IS NULL)::text AS running,
         AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)::text AS avg_duration,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds)
           FILTER (WHERE duration_seconds IS NOT NULL)::text AS p50_duration,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_seconds)
           FILTER (WHERE duration_seconds IS NOT NULL)::text AS p95_duration,
         COUNT(*) FILTER (WHERE sla_breached = TRUE)::text AS sla_breach_count,
         COUNT(*) FILTER (WHERE sla_hours IS NOT NULL)::text AS sla_candidate_count
       FROM approval_metrics
       ${where}`,
      params,
    )
    const row = overall.rows[0]
    const total = Number.parseInt(row?.total ?? '0', 10) || 0
    const approved = Number.parseInt(row?.approved ?? '0', 10) || 0
    const rejected = Number.parseInt(row?.rejected ?? '0', 10) || 0
    const revoked = Number.parseInt(row?.revoked ?? '0', 10) || 0
    const returned = Number.parseInt(row?.returned ?? '0', 10) || 0
    const running = Number.parseInt(row?.running ?? '0', 10) || 0
    const slaBreachCount = Number.parseInt(row?.sla_breach_count ?? '0', 10) || 0
    const slaCandidateCount = Number.parseInt(row?.sla_candidate_count ?? '0', 10) || 0

    const perTemplate = await this.query<{
      template_id: string | null
      total: string
      approved: string
      rejected: string
      revoked: string
      avg_duration: string | null
      sla_breach_count: string
      sla_candidate_count: string
    }>(
      `SELECT
         template_id,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE terminal_state = 'approved')::text AS approved,
         COUNT(*) FILTER (WHERE terminal_state = 'rejected')::text AS rejected,
         COUNT(*) FILTER (WHERE terminal_state = 'revoked')::text AS revoked,
         AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)::text AS avg_duration,
         COUNT(*) FILTER (WHERE sla_breached = TRUE)::text AS sla_breach_count,
         COUNT(*) FILTER (WHERE sla_hours IS NOT NULL)::text AS sla_candidate_count
       FROM approval_metrics
       ${where}
       GROUP BY template_id
       ORDER BY COUNT(*) DESC
       LIMIT 100`,
      params,
    )

    return {
      total,
      approved,
      rejected,
      revoked,
      returned,
      running,
      avgDurationSeconds: parseNullableNumber(row?.avg_duration),
      p50DurationSeconds: parseNullableNumber(row?.p50_duration),
      p95DurationSeconds: parseNullableNumber(row?.p95_duration),
      slaBreachCount,
      slaCandidateCount,
      slaBreachRate: slaCandidateCount > 0 ? slaBreachCount / slaCandidateCount : 0,
      byTemplate: perTemplate.rows.map((tpl) => {
        const tplCandidate = Number.parseInt(tpl.sla_candidate_count ?? '0', 10) || 0
        const tplBreach = Number.parseInt(tpl.sla_breach_count ?? '0', 10) || 0
        return {
          templateId: tpl.template_id,
          total: Number.parseInt(tpl.total ?? '0', 10) || 0,
          approved: Number.parseInt(tpl.approved ?? '0', 10) || 0,
          rejected: Number.parseInt(tpl.rejected ?? '0', 10) || 0,
          revoked: Number.parseInt(tpl.revoked ?? '0', 10) || 0,
          avgDurationSeconds: parseNullableNumber(tpl.avg_duration),
          slaBreachRate: tplCandidate > 0 ? tplBreach / tplCandidate : 0,
        }
      }),
    }
  }

  async getMetricsReport(input: MetricsSummaryQuery = {}): Promise<MetricsReport> {
    const summary = await this.getMetricsSummary(input)
    const tenantId = resolveTenantId(input.tenantId)
    const since = normalizeDate(input.since)
    const until = normalizeDate(input.until)
    const limit = clampReportLimit(input.limit)

    const conditions: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    if (since) {
      params.push(since.toISOString())
      conditions.push(`started_at >= $${params.length}`)
    }
    if (until) {
      params.push(until.toISOString())
      conditions.push(`started_at <= $${params.length}`)
    }
    const where = `WHERE ${conditions.join(' AND ')}`

    const slowestLimitParam = [...params, limit]
    const slowestInstances = await this.query<{
      instance_id: string
      template_id: string | null
      started_at: string
      terminal_at: string | null
      terminal_state: ApprovalTerminalState | null
      duration_seconds: string | number
      sla_hours: string | number | null
      sla_breached: boolean
      sla_breached_at: string | null
    }>(
      `SELECT
         instance_id,
         template_id,
         started_at,
         terminal_at,
         terminal_state,
         duration_seconds,
         sla_hours,
         sla_breached,
         sla_breached_at
       FROM approval_metrics
       ${where}
         AND duration_seconds IS NOT NULL
       ORDER BY duration_seconds DESC, terminal_at DESC NULLS LAST
       LIMIT $${slowestLimitParam.length}`,
      slowestLimitParam,
    )

    const templateLimitParam = [...params, limit]
    const breachedTemplates = await this.query<{
      template_id: string | null
      total: string
      sla_candidate_count: string
      sla_breach_count: string
      avg_duration: string | null
      p95_duration: string | null
    }>(
      `SELECT
         template_id,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE sla_hours IS NOT NULL)::text AS sla_candidate_count,
         COUNT(*) FILTER (WHERE sla_breached = TRUE)::text AS sla_breach_count,
         AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)::text AS avg_duration,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_seconds)
           FILTER (WHERE duration_seconds IS NOT NULL)::text AS p95_duration
       FROM approval_metrics
       ${where}
       GROUP BY template_id
       HAVING COUNT(*) FILTER (WHERE sla_hours IS NOT NULL) > 0
       ORDER BY
         (COUNT(*) FILTER (WHERE sla_breached = TRUE))::float
           / NULLIF(COUNT(*) FILTER (WHERE sla_hours IS NOT NULL), 0) DESC,
         COUNT(*) FILTER (WHERE sla_breached = TRUE) DESC,
         COUNT(*) DESC
       LIMIT $${templateLimitParam.length}`,
      templateLimitParam,
    )

    return {
      summary,
      slowestInstances: slowestInstances.rows.map((row) => ({
        instanceId: row.instance_id,
        templateId: row.template_id,
        startedAt: row.started_at,
        terminalAt: row.terminal_at,
        terminalState: row.terminal_state,
        durationSeconds: Number(row.duration_seconds) || 0,
        slaHours: row.sla_hours === null ? null : Number(row.sla_hours),
        slaBreached: row.sla_breached,
        slaBreachedAt: row.sla_breached_at,
      })),
      breachedTemplates: breachedTemplates.rows.map((row) => {
        const slaCandidateCount = Number.parseInt(row.sla_candidate_count ?? '0', 10) || 0
        const slaBreachCount = Number.parseInt(row.sla_breach_count ?? '0', 10) || 0
        return {
          templateId: row.template_id,
          total: Number.parseInt(row.total ?? '0', 10) || 0,
          slaCandidateCount,
          slaBreachCount,
          slaBreachRate: slaCandidateCount > 0 ? slaBreachCount / slaCandidateCount : 0,
          avgDurationSeconds: parseNullableNumber(row.avg_duration),
          p95DurationSeconds: parseNullableNumber(row.p95_duration),
        }
      }),
    }
  }

  async getInstanceMetrics(instanceId: string): Promise<ApprovalMetricsRow | null> {
    const result = await this.query<ApprovalMetricsRow>(
      `SELECT * FROM approval_metrics WHERE instance_id = $1`,
      [instanceId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { ...row, node_breakdown: toNodeBreakdown(row.node_breakdown) }
  }

  async listActiveBreaches(input: { tenantId?: string | null; limit?: number } = {}): Promise<ApprovalMetricsRow[]> {
    const tenantId = resolveTenantId(input.tenantId)
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
    const result = await this.query<ApprovalMetricsRow>(
      `SELECT * FROM approval_metrics
       WHERE tenant_id = $1
         AND sla_breached = TRUE
         AND terminal_at IS NULL
       ORDER BY sla_breached_at DESC NULLS LAST, started_at ASC
       LIMIT $2`,
      [tenantId, limit],
    )
    return result.rows.map((row) => ({ ...row, node_breakdown: toNodeBreakdown(row.node_breakdown) }))
  }

  /**
   * Wave 2 WP5 — breach notifier support. Returns per-instance context the
   * notifier needs to compose human-readable messages: template name, current
   * node, requester display name, started_at, sla_hours.
   *
   * The JOINs are LEFT so a missing template / instance row degrades to
   * `null` rather than silently dropping a breach from the notification batch.
   */
  async listBreachContextByIds(instanceIds: string[]): Promise<ApprovalBreachContext[]> {
    if (!Array.isArray(instanceIds) || instanceIds.length === 0) return []
    const result = await this.query<{
      instance_id: string
      template_id: string | null
      template_name: string | null
      instance_title: string | null
      current_node_key: string | null
      requester_snapshot: unknown
      started_at: string
      sla_hours: string | number | null
      sla_breached_at: string | null
    }>(
      `SELECT m.instance_id,
              m.template_id,
              m.started_at,
              m.sla_hours,
              m.sla_breached_at,
              t.name AS template_name,
              i.title AS instance_title,
              i.current_node_key,
              i.requester_snapshot
         FROM approval_metrics m
         LEFT JOIN approval_instances i ON i.id = m.instance_id
         LEFT JOIN approval_templates t ON t.id = m.template_id
        WHERE m.instance_id = ANY($1::text[])`,
      [instanceIds],
    )
    return result.rows.map((row) => {
      const requester = row.requester_snapshot && typeof row.requester_snapshot === 'object'
        ? row.requester_snapshot as Record<string, unknown>
        : null
      const requesterName = typeof requester?.name === 'string' && requester.name.trim().length > 0
        ? requester.name.trim()
        : typeof requester?.id === 'string' && requester.id.trim().length > 0
          ? requester.id.trim()
          : null
      const slaHours = row.sla_hours === null || row.sla_hours === undefined
        ? null
        : Number(row.sla_hours)
      return {
        instanceId: row.instance_id,
        templateId: row.template_id,
        templateName: row.template_name ?? row.instance_title ?? null,
        currentNodeKey: row.current_node_key,
        requesterName,
        startedAt: row.started_at,
        slaHours: Number.isFinite(slaHours) ? (slaHours as number) : null,
        breachedAt: row.sla_breached_at,
      }
    })
  }

  private async mutateBreakdown(
    instanceId: string,
    mutate: (breakdown: NodeBreakdownEntry[]) => NodeBreakdownEntry[] | null,
  ): Promise<void> {
    await this.transaction(async (query) => {
      const row = await this.loadBreakdown(instanceId, query)
      if (!row) return
      const next = mutate(row.breakdown)
      if (!next) return
      await query(
        `UPDATE approval_metrics SET node_breakdown = $2::jsonb WHERE instance_id = $1`,
        [instanceId, JSON.stringify(next)],
      )
    })
  }

  private async loadBreakdown(instanceId: string, query: Query): Promise<{ breakdown: NodeBreakdownEntry[] } | null> {
    const result = await query<{ node_breakdown: unknown }>(
      `SELECT node_breakdown FROM approval_metrics WHERE instance_id = $1 FOR UPDATE`,
      [instanceId],
    )
    const row = result.rows[0]
    if (!row) return null
    return { breakdown: toNodeBreakdown(row.node_breakdown) }
  }
}

function parseNullableNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : null
}

async function defaultQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount?: number | null }> {
  if (!pool) throw new Error('Database not available')
  const result = await pool.query<T>(sql, params)
  return { rows: result.rows, rowCount: result.rowCount }
}

async function defaultTransaction<T>(fn: (query: Query) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('Database not available')
  const client = await pool.connect()
  const txQuery: Query = async <R = unknown>(sqlText: string, params: unknown[] = []) => {
    const result = await client.query<R>(sqlText, params)
    return { rows: result.rows, rowCount: result.rowCount }
  }
  try {
    await client.query('BEGIN')
    const result = await fn(txQuery)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve the original metrics failure; rollback failures are secondary.
    }
    throw error
  } finally {
    client.release()
  }
}

let sharedInstance: ApprovalMetricsService | null = null
export function getApprovalMetricsService(): ApprovalMetricsService {
  if (!sharedInstance) sharedInstance = new ApprovalMetricsService()
  return sharedInstance
}

export function resetApprovalMetricsServiceForTesting(): void {
  sharedInstance = null
}
