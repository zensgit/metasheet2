/**
 * Automation Routes — V1
 *
 * REST API for automation test runs, execution logs, and stats. These
 * routes supplement the automation CRUD in univer-meta.ts.
 *
 * Mount point: `/api/multitable` (via index.ts).
 *
 * Endpoints:
 *   POST /api/multitable/sheets/:sheetId/automations/:ruleId/test
 *   GET  /api/multitable/sheets/:sheetId/automations/:ruleId/logs
 *   GET  /api/multitable/sheets/:sheetId/automations/:ruleId/stats
 *
 * Response shapes (match apps/web/src/multitable/api/client.ts):
 *   test  → AutomationExecution (flat object)
 *   logs  → { executions: AutomationExecution[] }
 *   stats → AutomationStats (flat object)
 */

import { Router, type Request, type Response } from 'express'
import type { AutomationService } from '../multitable/automation-service'
import type { AutomationExecution, AutomationStepResult } from '../multitable/automation-executor'
import { legacyAutomationStatusToJobStatus } from '../multitable/workflow-job-contract'
import { requireAdminRole } from '../guards/audit-integration'

// ── A2 run-governance read mappers (boundary only — no storage change) ───────

const LEGACY_STATUSES = new Set(['running', 'success', 'failed', 'skipped'])
// C1 WorkflowJobStatus values that map 1:1 back to a stored legacy value (for filtering).
const C1_TO_LEGACY: Record<string, string> = {
  running: 'running',
  resolved: 'success',
  failed: 'failed',
  skipped: 'skipped',
}
// C1 future states no stored row can match yet → legal filter, empty result (no contract churn at A6).
const C1_FUTURE_STATUSES = new Set(['queued', 'suspended', 'rejected', 'errored'])

type StatusFilter =
  | { kind: 'none' }
  | { kind: 'legacy'; value: string }
  | { kind: 'empty' }
  | { kind: 'invalid' }

/** Resolve a `status=` query value (accepts C1 canonical OR legacy) to a stored-legacy equality. */
function resolveStatusFilter(input: string | undefined): StatusFilter {
  if (!input) return { kind: 'none' }
  if (LEGACY_STATUSES.has(input)) return { kind: 'legacy', value: input }
  if (Object.prototype.hasOwnProperty.call(C1_TO_LEGACY, input)) return { kind: 'legacy', value: C1_TO_LEGACY[input] }
  if (C1_FUTURE_STATUSES.has(input)) return { kind: 'empty' }
  return { kind: 'invalid' }
}

/** Map one persisted step to the C1 WorkflowJob view at the read boundary. */
function toWorkflowJobView(execution: AutomationExecution, step: AutomationStepResult, index: number) {
  return {
    id: `${execution.id}:step:${index}`,
    executionId: execution.id,
    stepKey: String(index),
    status: legacyAutomationStatusToJobStatus(step.status),
    upstreamJobId: index > 0 ? `${execution.id}:step:${index - 1}` : null,
    result: step.output ?? null,
    // `error` must be string-or-ABSENT to satisfy the C1 WorkflowJob contract
    // (normalizeWorkflowJob rejects a non-string error) — never emit null.
    ...(typeof step.error === 'string' ? { error: step.error } : {}),
  }
}

/** Map a persisted execution to the runs-API view; `includeSnapshot` adds the redacted blobs (detail only). */
function toRunView(execution: AutomationExecution, { includeSnapshot }: { includeSnapshot: boolean }) {
  return {
    id: execution.id,
    ruleId: execution.ruleId,
    sheetId: execution.sheetId ?? null,
    status: legacyAutomationStatusToJobStatus(execution.status),
    statusLegacy: execution.status,
    triggeredBy: execution.triggeredBy,
    triggeredAt: execution.triggeredAt,
    finishedAt: execution.finishedAt ?? null,
    duration: execution.duration ?? null,
    error: execution.error ?? null,
    schemaVersion: execution.schemaVersion ?? null,
    steps: (execution.steps ?? []).map((s, i) => toWorkflowJobView(execution, s, i)),
    ...(includeSnapshot
      ? { triggerEvent: execution.triggerEvent ?? null, ruleSnapshot: execution.ruleSnapshot ?? null }
      : {}),
  }
}

/**
 * Build the automation routes router.
 *
 * Accepts either an AutomationService instance or a resolver function. The
 * resolver form is useful when the service is initialized AFTER routes are
 * mounted (which is the case at server startup today) — each request will
 * lazily resolve the current service instance.
 */
export function createAutomationRoutes(
  serviceOrResolver: AutomationService | (() => AutomationService | undefined),
): Router {
  const router = Router()
  const resolve = typeof serviceOrResolver === 'function'
    ? serviceOrResolver
    : () => serviceOrResolver

  function getService(res: Response): AutomationService | null {
    const svc = resolve()
    if (!svc) {
      res.status(503).json({ error: 'Automation service is not initialized yet' })
      return null
    }
    return svc
  }

  // ── Test run ────────────────────────────────────────────────────────────

  router.post('/sheets/:sheetId/automations/:ruleId/test', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ error: 'sheetId and ruleId are required' })
    }

    const svc = getService(res)
    if (!svc) return undefined

    try {
      const execution = await svc.testRun(ruleId, sheetId)
      // Flat shape — client does parseJson<AutomationExecution>(res)
      return res.json(execution)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test run failed'
      const code = message.includes('not found') ? 404 : 500
      return res.status(code).json({ error: message })
    }
  })

  // ── Execution logs ──────────────────────────────────────────────────────

  router.get('/sheets/:sheetId/automations/:ruleId/logs', async (req: Request, res: Response) => {
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!ruleId) {
      return res.status(400).json({ error: 'ruleId is required' })
    }

    const svc = getService(res)
    if (!svc) return undefined

    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200)
      const executions = await svc.logs.getByRule(ruleId, limit)
      // Client does parseJson<{ executions: AutomationExecution[] }>(res)
      return res.json({ executions })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load logs'
      return res.status(500).json({ error: message })
    }
  })

  // ── Execution stats ─────────────────────────────────────────────────────

  router.get('/sheets/:sheetId/automations/:ruleId/stats', async (req: Request, res: Response) => {
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!ruleId) {
      return res.status(400).json({ error: 'ruleId is required' })
    }

    const svc = getService(res)
    if (!svc) return undefined

    try {
      const stats = await svc.logs.getStats(ruleId)
      // Flat shape — client does parseJson<AutomationStats>(res)
      return res.json(stats)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load stats'
      return res.status(500).json({ error: message })
    }
  })

  // ── A2: read-only runs API (cross-rule; status emitted as C1 WorkflowJobStatus) ──

  // Cross-sheet run snapshots (incl. detail's triggerEvent/ruleSnapshot) are a
  // PLATFORM-ADMIN governance surface — gate behind requireAdminRole() (isAdmin,
  // fail-safe 503 on RBAC error). Narrowed from multitable:write per review so a
  // plain platform editor cannot read cross-sheet automation runs.
  router.get('/automation-executions', requireAdminRole(), async (req: Request, res: Response) => {
    const svc = getService(res)
    if (!svc) return undefined

    const statusFilter = resolveStatusFilter(
      typeof req.query.status === 'string' ? req.query.status : undefined,
    )
    if (statusFilter.kind === 'invalid') {
      return res.status(400).json({ error: 'invalid status filter' })
    }
    // A future-state C1 filter (queued/suspended/rejected/errored) is legal but no stored
    // row can match it yet — return empty rather than 400, so A6 adds no contract churn.
    if (statusFilter.kind === 'empty') {
      return res.json({ executions: [] })
    }

    try {
      // Default missing/NaN → 50; clamp to [1,200]. Use a finite check (not `|| 50`)
      // so `?limit=0` clamps to 1 rather than falling back to the default.
      const rawLimit = parseInt(String(req.query.limit), 10)
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200)
      const executions = await svc.logs.listExecutions({
        sheetId: typeof req.query.sheetId === 'string' ? req.query.sheetId : undefined,
        ruleId: typeof req.query.ruleId === 'string' ? req.query.ruleId : undefined,
        status: statusFilter.kind === 'legacy' ? statusFilter.value : undefined,
        limit,
      })
      return res.json({ executions: executions.map((e) => toRunView(e, { includeSnapshot: false })) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load runs'
      return res.status(500).json({ error: message })
    }
  })

  router.get('/automation-executions/:executionId', requireAdminRole(), async (req: Request, res: Response) => {
    const executionId = typeof req.params.executionId === 'string' ? req.params.executionId : ''
    if (!executionId) {
      return res.status(400).json({ error: 'executionId is required' })
    }

    const svc = getService(res)
    if (!svc) return undefined

    try {
      const execution = await svc.logs.getById(executionId)
      if (!execution) {
        return res.status(404).json({ error: 'execution not found' })
      }
      return res.json(toRunView(execution, { includeSnapshot: true }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load run'
      return res.status(500).json({ error: message })
    }
  })

  return router
}
