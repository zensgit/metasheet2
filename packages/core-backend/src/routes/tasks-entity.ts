/**
 * M5 PR-4a task entity routes (design docs/development/task-m5-pr4a-backend-design-20261010.md §3.0):
 * recurrence (slice 3); milestone and dependencies (slice 4). Registered by `tasksRouter()`
 * onto its own router with one line, so they exist only when that factory mounts (same flag, no new
 * mount, no new `TASKS_*` read; RULED(2026-10-09): [S30] ①).
 *
 * Every route: `authenticate` + `rbacGuard('tasks', …)`; the org comes from the session tenant only.
 * A write without one is 422 ORG_MISSING; a read under a task id without one is 404 (design §3.0:
 * a read under an id is a single-object read). Row-level failures are the uniform 404.
 */
import type { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import {
  addTaskDependency,
  getDependencyCandidates,
  getTaskDependencies,
  removeTaskDependency,
  setTaskMilestone,
} from '../services/task-dependency-records'
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

  // RULED(2026-10-09): [S13] the milestone flag (design §3.3): `{ isMilestone: boolean }`.
  router.patch('/api/tasks/:id/milestone', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await setTaskMilestone({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // RULED(2026-10-09): [S11] [S12] dependencies (design §3.4).
  router.get('/api/tasks/:id/dependencies', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await getTaskDependencies({ orgId: org, actorId: actorId(req), taskId: req.params.id }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/dependencies', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await addTaskDependency({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body }))
    } catch (err) {
      sendError(res, err)
    }
  })

  // ASSUMPTION(task-m5a): [a-12] one DELETE path per direction.
  router.delete('/api/tasks/:id/dependencies/predecessors/:otherId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await removeTaskDependency({
        orgId: org, actorId: actorId(req), taskId: req.params.id, otherId: req.params.otherId, direction: 'predecessor',
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/tasks/:id/dependencies/successors/:otherId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      res.json(await removeTaskDependency({
        orgId: org, actorId: actorId(req), taskId: req.params.id, otherId: req.params.otherId, direction: 'successor',
      }))
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/tasks/:id/dependency-candidates', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      res.json(await getDependencyCandidates({
        orgId: org,
        actorId: actorId(req),
        taskId: req.params.id,
        query: { direction: req.query.direction, q: req.query.q, limit: req.query.limit, offset: req.query.offset },
      }))
    } catch (err) {
      sendError(res, err)
    }
  })
}
