/**
 * 待办中心 v1 首切片 — `GET /api/todo/items` (aggregated list) and `GET /api/todo/count`
 * (aggregated count), per todo-center-design-lock §3/§4.
 *
 * Both routes aggregate across `pendingSourceRegistry` (only the approval source is registered in
 * this slice — see `services/approval-pending-source.ts`). Neither route judges visibility itself:
 * each source's own query is scoped to the viewer's identity, so the center only aggregates and
 * reports per-source status (`ok` / `unavailable`), never re-deriving a pending predicate of its own
 * (lock §3 hard constraint).
 *
 * Permission gate (slice-1 note, revisit when a second source is registered): both routes require
 * `approvals:read` via `rbacGuard`. That is a real narrowing choice, not an oversight — today the
 * ONLY registered source is the approval domain, so the gate is exactly coextensive with the data
 * this endpoint can return, and it keeps the endpoint's exposure surface no wider than the existing
 * `/api/approvals/pending-count` badge. This must move to a per-source check (or `rbacGuardAny`)
 * once a second source (comments/tasks/...) is registered — a blanket `approvals:read` gate would
 * then wrongly hide non-approval pending items from a viewer who lacks that one permission.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { Logger } from '../core/logger'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { resolveApprovalActorId, resolveApprovalActorPermissions } from './approvals'
import { resolveApprovalActorRoles } from '../services/approval-actor-roles'
import { pendingSourceRegistry, type PendingViewer } from '../services/pending-source-registry'

const logger = new Logger('TodoRouter')

function resolveTodoViewer(req: Request): PendingViewer | null {
  const actorId = resolveApprovalActorId(req)
  if (!actorId) return null
  return {
    actorId,
    roles: resolveApprovalActorRoles(req),
    permissions: resolveApprovalActorPermissions(req),
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

  r.get('/api/todo/items', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    const viewer = resolveTodoViewer(req)
    if (!viewer) return todoUserRequiredResponse(res)

    try {
      const { items, sources } = await pendingSourceRegistry.listPendingForUser(viewer)
      res.json({ items, sources })
    } catch (error) {
      // The registry itself catches every per-source failure (fail-closed, see
      // pending-source-registry.ts); reaching here means a bug in the aggregation layer, not a
      // source outage, so this stays a 500 rather than a per-source `unavailable`.
      logger.error('Failed to list todo items', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: { code: 'TODO_ITEMS_FAILED', message: 'Failed to list todo items' } })
    }
  })

  r.get('/api/todo/count', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    const viewer = resolveTodoViewer(req)
    if (!viewer) return todoUserRequiredResponse(res)

    try {
      const { count, sources } = await pendingSourceRegistry.countPendingForUser(viewer)
      res.json({ count, sources })
    } catch (error) {
      logger.error('Failed to count todo items', error instanceof Error ? error : undefined)
      res.status(500).json({ ok: false, error: { code: 'TODO_COUNT_FAILED', message: 'Failed to count todo items' } })
    }
  })

  return r
}
