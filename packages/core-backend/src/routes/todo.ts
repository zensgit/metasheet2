/**
 * 待办中心 v1 首切片 — `GET /api/todo/items` (aggregated list) and `GET /api/todo/count`
 * (aggregated count), per todo-center-design-lock §3/§4.
 *
 * Both routes aggregate across `pendingSourceRegistry`. Neither route judges row visibility itself:
 * each source's own query is scoped to the viewer's identity, so the center only aggregates and
 * reports per-source status (`ok` / `unavailable`), never re-deriving a pending predicate of its own
 * (lock §3 hard constraint).
 *
 * Access is decided per source (`todoSourceDoor`): a viewer gets exactly the sources whose declared
 * permission `requestHasPermission` grants them, the same answer that source's own read routes give.
 * A viewer with no such source gets the usual 403. The optional `?sources=a,b` query can only narrow
 * that set.
 */
import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { Logger } from '../core/logger'
import { authenticate } from '../middleware/auth'
import { requestHasPermission } from '../rbac/rbac'
import { validateViewerTimeZoneHeader } from '../tasks/task-dates'
import { resolveApprovalActorId, resolveApprovalActorPermissions } from './approvals'
import { orgId as sessionOrgId } from './tasks-http'
import { resolveApprovalActorRoles } from '../services/approval-actor-roles'
import { pendingSourceRegistry, type PendingViewer } from '../services/pending-source-registry'

const logger = new Logger('TodoRouter')

// Async because the role set is read from the database (`resolveApprovalActorRoles`); callers await
// it INSIDE their try so a failed role read answers the route's own 500 rather than a narrower count.
async function resolveTodoViewer(req: Request): Promise<PendingViewer | null> {
  const actorId = resolveApprovalActorId(req)
  if (!actorId) return null
  return {
    actorId,
    roles: await resolveApprovalActorRoles(req),
    permissions: resolveApprovalActorPermissions(req),
    orgId: sessionOrgId(req) || null,
    timeZone: validateViewerTimeZoneHeader(req.header('x-viewer-time-zone')),
  }
}

/**
 * The requested source names, or `null` when the request names none (every allowed source). The query
 * parser can hand over a string, an array or an object: a string or the string members of an array
 * are read, anything else counts as not named. `?sources=` names an empty set, which differs from not
 * naming any. The result is only ever intersected with the allowed set.
 */
function parseRequestedSources(raw: unknown): ReadonlySet<string> | null {
  let members: string[]
  if (typeof raw === 'string') members = [raw]
  else if (Array.isArray(raw)) members = raw.filter((member): member is string => typeof member === 'string')
  else return null
  return new Set(
    members
      .flatMap((member) => member.split(','))
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  )
}

/**
 * Decides which registered sources this request may read. Answers 401 / 403 / 500 with the same bodies
 * as `rbacGuard`; otherwise leaves the effective source names (registration order) in
 * `res.locals.todoSources`. Each distinct permission code is evaluated once per request.
 */
async function todoSourceDoor(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id?.toString()
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }

    const requested = parseRequestedSources(req.query.sources)
    const decisions = new Map<string, boolean>()
    const allowed: string[] = []
    for (const { name, permission } of pendingSourceRegistry.sourceEntries()) {
      let decision = decisions.get(permission)
      if (decision === undefined) {
        decision = await requestHasPermission(req, permission)
        decisions.set(permission, decision)
      }
      if (decision) allowed.push(name)
    }

    if (allowed.length === 0) {
      logger.warn(`Access denied for user ${userId}: no readable todo source`)
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }

    res.locals.todoSources = requested ? allowed.filter((name) => requested.has(name)) : allowed
    next()
  } catch (error) {
    logger.error('Todo source check error', error instanceof Error ? error : undefined)
    res.status(500).json({ error: 'Permission check failed' })
  }
}

function todoUserRequiredResponse(res: Response): Response {
  return res.status(401).json({
    ok: false,
    error: { code: 'TODO_USER_REQUIRED', message: 'User ID not found in token' },
  })
}

export function todoRouter(): Router {
  const r = Router()

  r.get('/api/todo/items', authenticate, todoSourceDoor, async (req: Request, res: Response) => {
    const allowedSources = res.locals.todoSources
    if (!Array.isArray(allowedSources)) return res.status(403).json({ error: 'Insufficient permissions' })
    if (!resolveApprovalActorId(req)) return todoUserRequiredResponse(res)

    try {
      const viewer = await resolveTodoViewer(req)
      if (!viewer) return todoUserRequiredResponse(res)
      const { items, sources } = await pendingSourceRegistry.listPendingForUser(viewer, {
        sources: allowedSources,
      })
      res.json({ items, sources })
    } catch (error) {
      // The registry itself catches every per-source failure (fail-closed, see
      // pending-source-registry.ts); reaching here means a bug in the aggregation layer or a failed
      // read of the viewer's own role set, not a source outage, so this stays a 500 rather than a
      // per-source `unavailable` (a narrower count would hide the failure).
      logger.error('Failed to list todo items', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: { code: 'TODO_ITEMS_FAILED', message: 'Failed to list todo items' } })
    }
  })

  r.get('/api/todo/count', authenticate, todoSourceDoor, async (req: Request, res: Response) => {
    const allowedSources = res.locals.todoSources
    if (!Array.isArray(allowedSources)) return res.status(403).json({ error: 'Insufficient permissions' })
    if (!resolveApprovalActorId(req)) return todoUserRequiredResponse(res)

    try {
      const viewer = await resolveTodoViewer(req)
      if (!viewer) return todoUserRequiredResponse(res)
      const { count, sources } = await pendingSourceRegistry.countPendingForUser(viewer, {
        sources: allowedSources,
      })
      res.json({ count, sources })
    } catch (error) {
      logger.error('Failed to count todo items', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: { code: 'TODO_COUNT_FAILED', message: 'Failed to count todo items' } })
    }
  })

  return r
}
