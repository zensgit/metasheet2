/**
 * P0-A/P0-B (M2/M3) task routes. The factory returns null unless the tasks
 * feature flag is the exact string 'true'. Static segments are registered
 * before `/:id`; every new `/:id/<segment>` route below has a different
 * segment count from `/api/tasks/:id` itself, so route order among them
 * does not matter for correctness (contract §2 / lock §12 门 13).
 */
import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { validateViewerTimeZoneHeader } from '../tasks/task-dates'
import {
  completeTask,
  countPending,
  countPendingList,
  countTasks,
  createTask,
  getTask,
  listPending,
  listTasks,
  parseTaskPage,
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
import { isVersionConflict, patchTask } from '../services/task-patch'
import { actorId, orgId, sendError } from './tasks-http'
import { registerTaskListRoutes } from './tasks-lists'
import { registerTaskSettingsRoutes } from './tasks-settings'

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
      // RULED(2026-10-07): [R15] paged; an invalid page is 422 before anything is read.
      const page = parseTaskPage({ limit: req.query.limit, offset: req.query.offset })
      const viewerTz = validateViewerTimeZoneHeader(req.header('x-viewer-time-zone'))
      const items = await listPending({ orgId: org, actorId: actorId(req), viewerTz, page })
      const total = await countPendingList({ orgId: org, actorId: actorId(req) })
      res.json({ items, total })
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
      // ASSUMPTION(task-m4): [D5] [own-11] `null` means badge_scope 'off'; only then the extra key.
      res.json(count === null ? { count: 0, badgeScope: 'off' } : { count })
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
      // ASSUMPTION(task-m4): [own-10] the page is parsed before the view is checked, so an
      // invalid page is 422 even when the view is also invalid; a missing org still degrades first
      // ([own-19]). The service keeps its array return; the total is a separate count.
      const page = parseTaskPage({ limit: req.query.limit, offset: req.query.offset })
      const view = typeof req.query.view === 'string' ? req.query.view : 'assigned'
      const items = await listTasks({ orgId: org, actorId: actorId(req), view, page })
      const total = await countTasks({ orgId: org, actorId: actorId(req), view })
      res.json({ items, total })
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
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
      // RULED(2026-10-07): [R03] the date keys, `timeZone` and `remindAt` are accepted on create;
      // `description` is not (it is a PATCH field).
      const created = await createTask({
        orgId: org,
        creatorId: actorId(req),
        title: body.title,
        assignees: body.assignees,
        completionMode: body.completionMode,
        dueDate: body.dueDate,
        dueTime: body.dueTime,
        startDate: body.startDate,
        startTime: body.startTime,
        timeZone: body.timeZone,
        remindAt: body.remindAt,
      })
      res.status(200).json(created)
    } catch (err) {
      sendError(res, err)
    }
  })

  // M4 PR-3a (design §5.3). The only single-segment PATCH under /api/tasks/.
  router.patch('/api/tasks/:id', authenticate, rbacGuard('tasks', 'write'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const result = await patchTask({ orgId: org, actorId: actorId(req), taskId: req.params.id, body: req.body })
      res.json(result)
    } catch (err) {
      // RULED(2026-10-07): [R03] the one error body with a field beside `error`.
      if (isVersionConflict(err)) {
        res.status(409).json({ error: { code: 'VERSION_CONFLICT' }, currentVersion: err.currentVersion })
        return
      }
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

  // ASSUMPTION(task-m4): [own-17] M4 routes register on this same router (no nested Router, no
  // new mount, no new flag read). One call per line: gate 13's negative control rewrites it.
  registerTaskSettingsRoutes(router)
  registerTaskListRoutes(router)

  return router
}
