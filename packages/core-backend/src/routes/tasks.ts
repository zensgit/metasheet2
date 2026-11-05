/**
 * P0-A/P0-B (M2/M3) task routes. The factory returns null unless the tasks
 * feature flag is the exact string 'true'. Static segments are registered
 * before `/:id`; every new `/:id/<segment>` route below has a different
 * segment count from `/api/tasks/:id` itself, so route order among them
 * does not matter for correctness (contract §2 / lock §12 门 13).
 */
import { Router } from 'express'
import { query } from '../db/pg'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { validateViewerTimeZoneHeader } from '../tasks/task-dates'
import { parseTaskSourceInput } from '../tasks/task-source-links'
import {
  completeTask,
  countPending,
  countPendingList,
  countTasks,
  createTask,
  fail,
  getTask,
  listPending,
  listTasks,
  parseTaskPage,
  plainDb,
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
import { loadTaskPeople, resolveOrgPeople, searchOrgPeople } from '../services/task-people'
import { createRateLimiter } from '../middleware/rate-limiter'
import { PEOPLE_QUERY_MIN_LENGTH, parsePeopleRequest } from '../tasks/task-people-search'
import { actorId, orgId, sendError } from './tasks-http'
import { registerTaskListRoutes } from './tasks-lists'
import { registerTaskSettingsRoutes } from './tasks-settings'
import { requireRecordReadable } from './univer-meta'

/** The record read gate's query function for a dispatch from a record: the task module's own
 * database access, as a plain function. */
const sourceQuery: Parameters<typeof requireRecordReadable>[1] = (sql, params) => query(sql, params)

/**
 * The one refusal for a dispatch source the caller may not use: a missing or unreadable record, a
 * gated reader who is not the creator, or a view or base that is not the sheet's. Sent as
 * `{ error: { code } }`; a 401 from the gate stays a 401.
 */
function sourceNotReadable(status = 422): Error {
  return Object.assign(new Error('SOURCE_NOT_READABLE'), { status, code: 'SOURCE_NOT_READABLE' })
}

/** The per-router cleanup of `tasksRouter()`: the people search limiter's sweep timer. */
const routerDisposers = new WeakMap<Router, () => void>()

/** Stops the timer a `tasksRouter()` instance owns. The timer never keeps a process alive; tests
 *  that build routers call this when they are done with one. */
export function disposeTasksRouter(router: Router | null): void {
  if (!router) return
  routerDisposers.get(router)?.()
  routerDisposers.delete(router)
}

export function tasksRouter(): Router | null {
  if (process.env.TASKS_ENABLED !== 'true') return null
  const router = Router()
  // Package 1b: 120 people searches a minute per signed-in user, in memory, one counter per router.
  const peopleRateLimit = createRateLimiter({
    windowMs: 60_000,
    maxRequests: 120,
    keyPrefix: 'tasks-people',
    keyFn: (req) => actorId(req),
    onLimited: (_req, res) => {
      res.status(429).json({ error: { code: 'RATE_LIMITED' } })
    },
  })
  routerDisposers.set(router, peopleRateLimit._cleanup)

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

  // Package 1b: the people directory of the assignee and follower pickers (task-people.ts). It
  // takes tasks:write, the code of the writes it feeds, and answers a missing org like them.
  router.get('/api/tasks/people', authenticate, rbacGuard('tasks', 'write'), peopleRateLimit, async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(422).json({ error: { code: 'ORG_MISSING' } })
        return
      }
      const request = parsePeopleRequest({ q: req.query.q, ids: req.query.ids, limit: req.query.limit })
      if (!request) {
        res.status(422).json({ error: { code: 'PEOPLE_QUERY_INVALID' } })
        return
      }
      if (request.kind === 'blank') {
        res.json({ items: [], hasMore: false, requiresQuery: true, limit: request.limit, minQueryLength: PEOPLE_QUERY_MIN_LENGTH })
        return
      }
      if (request.kind === 'resolve') {
        const items = await resolveOrgPeople(plainDb, { orgId: org, ids: request.ids })
        res.json({ items, truncated: request.truncated })
        return
      }
      const found = await searchOrgPeople(plainDb, { orgId: org, term: request.term, limit: request.limit })
      res.json({ items: found.items, hasMore: found.hasMore, requiresQuery: false, limit: request.limit })
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
      // RULED(2026-10-09): G2-core `status` = open | done | all, orthogonal to the view; list and
      // total get the same value. ASSUMPTION(task-g2): absent = `all` (the service default); a
      // repeated or nested `status` is not a string; it is passed on as '' (outside the closed set)
      // and answered like an unknown value, not defaulted as `view` is, so a client that sends two
      // values never gets every row.
      const status = req.query.status === undefined
        ? undefined
        : typeof req.query.status === 'string' ? req.query.status : ''
      // Basic title search, read like `status`: a repeated or nested `q` is not a string and is
      // passed on as '', which the service refuses like an empty or blank one (422 INVALID_QUERY).
      // The order of refusals stays page, view, status, then query.
      const q = req.query.q === undefined
        ? undefined
        : typeof req.query.q === 'string' ? req.query.q : ''
      const items = await listTasks({ orgId: org, actorId: actorId(req), view, status, q, page })
      const total = await countTasks({ orgId: org, actorId: actorId(req), view, status, q })
      res.json({ items, total })
    } catch (err) {
      const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: string }).code) : ''
      // G2-core: an unknown status is answered exactly like an unknown view.
      if (code === 'INVALID_VIEW' || code === 'INVALID_STATUS' || (err instanceof TypeError)) {
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
      // A dispatch from a multitable record adds `source` and, only with it, `dispatchKey`. Both are
      // parsed before anything is read; a body without them is created exactly as before.
      const dispatch = parseTaskSourceInput({ source: body.source, dispatchKey: body.dispatchKey })
      if (dispatch.ok === false) fail(422, dispatch.reason.toUpperCase())
      const source = dispatch.source
      if (source) {
        // The record routes' own read gate, for this caller, before anything is written. A missing
        // record and an unreadable one are the same 422.
        const gate = await requireRecordReadable(req, sourceQuery, source.sheetId, source.recordId)
        if ('status' in gate) {
          throw sourceNotReadable(gate.status === 401 ? 401 : 422)
        }
        // The gated reader is the task's creator.
        if (gate.access.userId !== actorId(req)) throw sourceNotReadable()
        // A view or base sent with the source must be the sheet's; read only once the gate passed.
        if (source.viewId !== null) {
          const view = await query('SELECT sheet_id FROM meta_views WHERE id = $1', [source.viewId])
          if (view.rows[0]?.sheet_id !== source.sheetId) throw sourceNotReadable()
        }
        if (source.baseId !== null) {
          const sheet = await query('SELECT base_id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [source.sheetId])
          if (!sheet.rows[0] || sheet.rows[0].base_id !== source.baseId) throw sourceNotReadable()
        }
      }
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
        ...(source ? { source, dispatchKey: dispatch.dispatchKey } : {}),
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

  // Package 1b: the names on a task, and whether each person is still an active member.
  router.get('/api/tasks/:id/people', authenticate, rbacGuard('tasks', 'read'), async (req, res) => {
    try {
      const org = orgId(req)
      if (!org) {
        res.status(404).json({ error: { code: 'NOT_FOUND' } })
        return
      }
      const people = await loadTaskPeople({ orgId: org, actorId: actorId(req), taskId: req.params.id })
      res.json({ people })
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
