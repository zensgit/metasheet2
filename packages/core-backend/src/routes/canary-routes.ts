/**
 * Canary Admin Routes
 *
 * REST endpoints for managing canary routing rules, viewing
 * comparative metrics, and performing promote/rollback operations.
 */

import { Router, type Request, type Response } from 'express'
import { requireAdminRole } from '../guards'
import { CanaryRouter } from '../canary/CanaryRouter'
import { canaryMetrics } from '../canary/CanaryMetrics'
import { Logger } from '../core/logger'

const logger = new Logger('CanaryRoutes')

export function canaryRoutes(router: CanaryRouter): Router {
  const r = Router()

  /**
   * GET /api/admin/canary/rules
   * List all canary routing rules.
   */
  r.get('/rules', requireAdminRole(), (_req: Request, res: Response) => {
    try {
      const rules = router.getAllRules()
      res.json({ ok: true, rules })
    } catch (error) {
      logger.error('Failed to list canary rules', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to list canary rules' })
    }
  })

  /**
   * PUT /api/admin/canary/rules/:topic
   * Create or update a canary routing rule.
   *
   * Body: { canaryWeight: number, stableHandler?: string, canaryHandler?: string, overrides?: Record<string, 'stable' | 'canary'> }
   */
  r.put('/rules/:topic', requireAdminRole(), (req: Request, res: Response) => {
    try {
      const { topic } = req.params
      const { canaryWeight, stableHandler, canaryHandler, overrides } = req.body ?? {}

      if (typeof canaryWeight !== 'number' || canaryWeight < 0 || canaryWeight > 100) {
        res.status(400).json({ ok: false, error: 'canaryWeight must be a number between 0 and 100' })
        return
      }

      router.updateRule({
        topic,
        canaryWeight,
        stableHandler: stableHandler ?? 'default-stable',
        canaryHandler: canaryHandler ?? 'default-canary',
        overrides,
      })

      canaryMetrics.setWeight(topic, canaryWeight)

      res.json({ ok: true, rule: router.getRule(topic) })
    } catch (error) {
      logger.error('Failed to update canary rule', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to update canary rule' })
    }
  })

  /**
   * DELETE /api/admin/canary/rules/:topic
   * Remove a canary routing rule.
   */
  r.delete('/rules/:topic', requireAdminRole(), (req: Request, res: Response) => {
    try {
      const { topic } = req.params
      const removed = router.removeRule(topic)

      if (!removed) {
        res.status(404).json({ ok: false, error: 'Rule not found' })
        return
      }

      canaryMetrics.setWeight(topic, 0)
      res.json({ ok: true })
    } catch (error) {
      logger.error('Failed to delete canary rule', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to delete canary rule' })
    }
  })

  /**
   * GET /api/admin/canary/stats/:topic
   * Compare stable vs canary metrics for a topic.
   */
  r.get('/stats/:topic', requireAdminRole(), async (req: Request, res: Response) => {
    try {
      const { topic } = req.params
      const stats = await canaryMetrics.compareVersions(topic)
      const rule = router.getRule(topic)

      res.json({
        ok: true,
        topic,
        canaryWeight: rule?.canaryWeight ?? null,
        stats,
      })
    } catch (error) {
      logger.error('Failed to get canary stats', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to get canary stats' })
    }
  })

  /**
   * POST /api/admin/canary/promote/:topic
   * Set canary weight to 100% (full rollout).
   */
  r.post('/promote/:topic', requireAdminRole(), (req: Request, res: Response) => {
    try {
      const { topic } = req.params
      const promoted = router.promote(topic)

      if (!promoted) {
        res.status(404).json({ ok: false, error: 'Rule not found' })
        return
      }

      canaryMetrics.setWeight(topic, 100)
      res.json({ ok: true, rule: router.getRule(topic) })
    } catch (error) {
      logger.error('Failed to promote canary', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to promote canary' })
    }
  })

  /**
   * POST /api/admin/canary/rollback/:topic
   * Set canary weight to 0% (full rollback).
   */
  r.post('/rollback/:topic', requireAdminRole(), (req: Request, res: Response) => {
    try {
      const { topic } = req.params
      const rolledBack = router.rollback(topic)

      if (!rolledBack) {
        res.status(404).json({ ok: false, error: 'Rule not found' })
        return
      }

      canaryMetrics.setWeight(topic, 0)
      res.json({ ok: true, rule: router.getRule(topic) })
    } catch (error) {
      logger.error('Failed to rollback canary', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: 'Failed to rollback canary' })
    }
  })

  return r
}
