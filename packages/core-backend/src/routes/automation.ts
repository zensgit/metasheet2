/**
 * Automation Routes — V1
 * REST API for automation rule management, test runs, and execution logs.
 * These routes supplement the existing CRUD in univer-meta.ts.
 */

import { Router, type Request, type Response } from 'express'
import type { AutomationService } from '../multitable/automation-service'

export function createAutomationRoutes(automationService: AutomationService): Router {
  const router = Router()

  // ── Test run ────────────────────────────────────────────────────────────

  router.post('/sheets/:sheetId/automations/:ruleId/test', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and ruleId are required' } })
    }

    try {
      const execution = await automationService.testRun(ruleId, sheetId)
      return res.json({ ok: true, data: { execution } })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test run failed'
      if (message.includes('not found')) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message } })
      }
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message } })
    }
  })

  // ── Execution logs ──────────────────────────────────────────────────────

  router.get('/sheets/:sheetId/automations/:ruleId/logs', async (req: Request, res: Response) => {
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'ruleId is required' } })
    }

    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 50, 1), 200)
    const logs = automationService.logs.getByRule(ruleId, limit)
    return res.json({ ok: true, data: { logs } })
  })

  // ── Execution stats ─────────────────────────────────────────────────────

  router.get('/sheets/:sheetId/automations/:ruleId/stats', async (req: Request, res: Response) => {
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'ruleId is required' } })
    }

    const stats = automationService.logs.getStats(ruleId)
    return res.json({ ok: true, data: { stats } })
  })

  return router
}
