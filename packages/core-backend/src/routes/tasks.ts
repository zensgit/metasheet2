/**
 * P0-A/P0-B (M2/M3) task routes. The factory returns null unless the tasks
 * feature flag is the exact string 'true'. Static segments are registered
 * before `/:id`; every new `/:id/<segment>` route below has a different
 * segment count from `/api/tasks/:id` itself, so route order among them
 * does not matter for correctness (contract §2 / lock §12 门 13).
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { Logger } from '../core/logger'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { validateViewerTimeZoneHeader } from '../tasks/task-dates'
import {
  completeTask,
  countPending,
  createTask,
  getTask,
  listPending,
  listTasks,
  reopenTask,
} from '../services/task-records'
import {
  addAssignee,
  addComment,
  addFollower,
  deleteComment,
  deleteTaskById,
  getParentCandidates,
  leaveTask,
  listComments,
  removeAssignee,
  removeFollower,
  setTaskParent,
  switchCompletionMode,
  updateComment,
} from '../services/task-structure'

function actorId(req: Request): string {
  const sub = req.user && typeof req.user === 'object' && 'sub' in req.user ? String(req.user.sub ?? '') : ''
  return sub || String(req.user?.id ?? '')
}

function orgId(req: Request): string {
  return typeof req.authenticatedTenantId === 'string' ? req.authenticatedTenantId : ''
}

const logger = new Logger('TasksRoutes')

/**
 * Errors raised by the task services through `fail()` carry a numeric 4xx
 * `status` and a contract `code`, and are sent as-is. Anything else (a
 * driver error, a bug) is logged and answered 500 `INTERNAL`: its own `code`
 * (for a pg error, the SQLSTATE) is never echoed to the client (M3R2-AUTHZ-4).
 */
function sendError(res: Response, err: unknown): void {
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: unknown }).status) : NaN
  const code = typeof err === 'object' && err && 'code' in err ? (err as { code: unknown }).code : undefined
  if (Number.isInteger(status) && status >= 400 && status < 500 && typeof code === 'string') {
    res.status(status).json({ error: { code } })
    return
  }
  logger.error('tasks route failed', err instanceof Error ? err : undefined)
  res.status(500).json({ error: { code: 'INTERNAL' } })
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

  router.get('/api/tasks/:id', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      const item = await getTask({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json(item)
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

  // ---------------------------------------------------------------------
  // M3 (P0-B): subtree parenting, membership, completion-mode, comments,
  // soft delete. Write routes 422 ORG_MISSING with no org claim, same as
  // the M2 write routes above; read routes 404 with no org claim, same as
  // GET /api/tasks/:id above.
  // ---------------------------------------------------------------------

  router.patch('/api/tasks/:id/parent', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await setTaskParent({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/tasks/:id/parent-candidates', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      const result = await getParentCandidates({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/assignees', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await addAssignee({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/tasks/:id/assignees/:userId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await removeAssignee({ orgId: org, actorId: actorId(req), taskId: req.params.id, userId: req.params.userId })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/tasks/:id/completion-mode', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await switchCompletionMode({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/followers', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await addFollower({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/tasks/:id/followers/:userId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await removeFollower({ orgId: org, actorId: actorId(req), taskId: req.params.id, userId: req.params.userId })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/leave', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await leaveTask({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.get('/api/tasks/:id/comments', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      const result = await listComments({
        orgId: org,
        actorId: actorId(req),
        taskId: req.params.id,
        query: { limit: req.query.limit, offset: req.query.offset },
      })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.post('/api/tasks/:id/comments', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await addComment({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.patch('/api/tasks/:id/comments/:commentId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await updateComment({
        orgId: org, actorId: actorId(req), taskId: req.params.id, commentId: req.params.commentId, body: req.body,
      })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/tasks/:id/comments/:commentId', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await deleteComment({ orgId: org, actorId: actorId(req), taskId: req.params.id, commentId: req.params.commentId })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  router.delete('/api/tasks/:id', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await deleteTaskById({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json(result)
    } catch (err) {
      sendError(res, err)
    }
  })

  return router
}
