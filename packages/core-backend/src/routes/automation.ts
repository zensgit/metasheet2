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

  return router
}
