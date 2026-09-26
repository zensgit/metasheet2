/**
 * P0-A task routes. The factory returns null unless the tasks feature flag
 * is the exact string 'true'.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { validateViewerTimeZoneHeader } from '../tasks/task-dates'
import {
  completeTask,
  countPending,
  createTask,
  listPending,
  listTasks,
  reopenTask,
} from '../services/task-records'

function actorId(req: Request): string {
  const sub = req.user && typeof req.user === 'object' && 'sub' in req.user ? String(req.user.sub ?? '') : ''
  return sub || String(req.user?.id ?? '')
}

function orgId(req: Request): string {
  return typeof req.authenticatedTenantId === 'string' ? req.authenticatedTenantId : ''
}

function sendError(res: Response, err: unknown): void {
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: number }).status) : 500
  const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: string }).code) : 'INTERNAL'
  res.status(status).json({ error: { code } })
}

export function tasksRouter(): Router | null {
  if (process.env.TASKS_ENABLED !== 'true') return null
  const router = Router()

  router.get('/api/tasks/context', authenticate, rbacGuard('tasks', 'read'), (req, res) => {
    const id = orgId(req)
    res.json({ orgId: id || null })
  })

  router.get('/api/tasks/pending', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ items: [], degraded: true, reason: 'org_missing' })
        return
      }
      const viewerTz = validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))
      const items = await listPending({ orgId: org, actorId: actorId(req), viewerTz })
      res.json({ items })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/tasks/pending-count', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ count: 0, degraded: true, reason: 'org_missing' })
        return
      }
      const viewerTz = validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))
      const count = await countPending({ orgId: org, actorId: actorId(req), viewerTz })
      res.json({ count })
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/tasks', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.json({ items: [], degraded: true, reason: 'org_missing' })
        return
      }
      const view = typeof req.query.view === 'string' ? req.query.view : 'assigned'
      const items = await listTasks({ orgId: org, actorId: actorId(req), view })
      res.json({ items })
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: string }).code) : ''
      if (code === 'INVALID_VIEW' || (err instanceof TypeError)) {
        res.json({ items: [], degraded: true, reason: 'predicate_error' })
        return
      }
      sendError(res, err)
    }
  })

  router.post('/api/tasks', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const body = req.body && typeof req.body === 'object' ? req.body as { title?: unknown; assignees?: unknown; completionMode?: unknown } : {}
      const created = await createTask({
        orgId: org,
        creatorId: actorId(req),
        title: body.title,
        assignees: body.assignees,
        completionMode: body.completionMode,
      })
      res.status(200).json(created)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/complete', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await completeTask({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/reopen', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const scope = req.body && typeof req.body === 'object' && (req.body as { scope?: unknown }).scope === 'all' ? 'all' : 'self'
      const result = await reopenTask({ orgId: org, actorId: actorId(req), taskId: req.params.id, scope })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
