/**
 * M5 PR-4a task entity routes (design docs/development/task-m5-pr4a-backend-design-20261010.md §3.0):
 * recurrence (slice 3); milestone and dependencies follow in slice 4. Registered by `tasksRouter()`
 * onto its own router with one line, so they exist only when that factory mounts (same flag, no new
 * mount, no new `TASKS_*` read; RULED(2026-10-09): [S30] ①).
 *
 * Every route: `authenticate` + `rbacGuard('tasks', …)`; the org comes from the session tenant only.
 * A write without one is 422 ORG_MISSING. Row-level failures are the uniform 404.
 */
import type { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { setTaskRecurrence } from '../services/task-recurrence-records'
import { actorId, orgId, sendError } from './tasks-http'

export function registerTaskEntityRoutes(router: Router): void {
  // RULED(2026-10-09): [S14] [S17] [S35] set or clear the rule (design §3.2): `{ recurrence: Rule | null }`.
  router.put('/api/tasks/:id/recurrence', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await setTaskRecurrence({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })
}
