/**
 * 待办中心二切片(B-2)—— `todo:counts-updated` realtime push, per todo-center-design-lock v2.14 §4
 * ("复用按用户 room,发 todo:counts-updated") and its §3 hard constraint ("只准一份" pending
 * predicate — the center "不得自己拼第二份 pending 谓词").
 *
 * B-1's own fix-round (`impl-gate-B-slice1-round2-20260918.md`'s P1-1 finding) REMOVED an earlier
 * version of this exact broadcast because that version wired `todo:counts-updated` onto
 * `approval-realtime.ts`'s `computeApprovalPendingCounts` — a pre-existing, KNOWN-DIVERGENT second
 * copy of the pending predicate (it hand-copies the three-arm assignee match but OMITS the
 * handler-node exclusion `approval-pending-query.ts` carries; see that module's own docblock for the
 * confirmed divergence). This module does not repeat that mistake: it calls
 * `pendingSourceRegistry.countPendingForUser` — the EXACT SAME registry method `GET /api/todo/count`
 * calls (`routes/todo.ts`) — so the realtime push and the REST endpoint can never read two different
 * queries. Nothing in this file re-derives a WHERE clause, a role set, or a permission set.
 *
 * Known, PRE-EXISTING input gap this module inherits rather than introduces: the trigger call site
 * (`routes/approvals.ts`'s `publishApprovalCountsForUsers`, shared by every approval action handler)
 * only carries `roles` for the OTHER users an action notifies (the assignees/watchers being told
 * about someone else's decision), never `permissions` for them — `publishApprovalCountsUpdate`'s
 * pre-existing `approval:counts-updated` broadcast has always had this identical limitation (see its
 * call site: it never receives a `permissions` field either). Calling this function with
 * `permissions` omitted reuses that already-live limitation; it does not add a new one, and it does
 * NOT change the query — the shared query still runs, just with an empty permissions array bound to
 * its `$3` parameter, exactly as `countApprovalPendingForViewer` would for any caller that hands it
 * one. Effect, precisely stated: a viewer whose ONLY qualifying seat is a `source_queue` (permission)
 * arm will not see that seat reflected in a REALTIME push's count; their next `GET /api/todo/count`
 * (which always resolves `permissions` from the authenticated request) is unaffected and correct.
 */
import type { Injector } from '@wendellhu/redi'
import { ICollabService, type ICollabService as CollabServicePort, type ILogger } from '../di/identifiers'
import { buildAuthenticatedUserRoom } from './CollabService'
import { pendingSourceRegistry, type PendingCountResult, type PendingViewer } from './pending-source-registry'

export interface TodoCountsUpdatedPayload extends PendingCountResult {
  reason: string
  updatedAt: string
}

/** Injectable so tests can assert this module calls it with a `PendingViewer` and does no querying
 *  of its own — mirrors `approval-realtime.ts`'s injectable `ApprovalCountQuery` pattern. Defaults to
 *  the process-wide `pendingSourceRegistry` singleton (the same one `routes/todo.ts` reads). */
export type TodoCountFetcher = (viewer: PendingViewer) => Promise<PendingCountResult>

const defaultCountPendingForUser: TodoCountFetcher = (viewer) =>
  pendingSourceRegistry.countPendingForUser(viewer)

export async function publishTodoCountsUpdate(input: {
  injector?: Injector
  collabService?: Pick<CollabServicePort, 'broadcastTo'>
  logger?: Pick<ILogger, 'warn'>
  userId: string
  roles?: string[]
  permissions?: string[]
  reason: string
  countPendingForUser?: TodoCountFetcher
}): Promise<void> {
  try {
    const collabService = input.collabService ?? input.injector?.get(ICollabService)
    if (!collabService) return
    const countPendingForUser = input.countPendingForUser ?? defaultCountPendingForUser
    const viewer: PendingViewer = {
      actorId: input.userId,
      roles: input.roles ?? [],
      permissions: input.permissions ?? [],
    }
    const { count, sources } = await countPendingForUser(viewer)
    const payload: TodoCountsUpdatedPayload = {
      count,
      sources,
      reason: input.reason,
      updatedAt: new Date().toISOString(),
    }
    collabService.broadcastTo(buildAuthenticatedUserRoom(input.userId), 'todo:counts-updated', payload)
  } catch (error) {
    input.logger?.warn(
      'Failed to publish todo count update',
      error instanceof Error ? error : undefined,
    )
  }
}
