/**
 * `GET/PATCH /api/task-settings` (M4 PR-3a). Registered by `tasksRouter()` onto its own router,
 * so these routes exist only when that factory mounts (same flag, no new mount).
 *
 * RULED(2026-10-07): [R02] the settings routes. ASSUMPTION(task-m4): [own-19] with no org claim the
 * single-object read is 404 and the write is 422 ORG_MISSING.
 */
import type { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { getTaskSettings, patchTaskSettings } from '../services/task-user-settings'
import { actorId, orgId, sendError } from './tasks-http'

export function registerTaskSettingsRoutes(router: Router): void {
  router.get('/api/task-settings', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await getTaskSettings({ orgId: org, actorId: actorId(req) }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/task-settings', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      // ASSUMPTION(task-m4): [own-39] only a JSON body is read; any other body (text, a form, none)
      // reaches the service as no body, which is 422 INVALID_SETTINGS.
      const body = req.is('application/json') ? req.body : undefined
      res.json(await patchTaskSettings({ orgId: org, actorId: actorId(req), body }))
    } catch (err) {
      sendError(res, err)
    }
  })
}
