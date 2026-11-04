/**
 * The task domain's `PendingSource` (todo-center-design-lock §3): the open tasks assigned to the
 * viewer in the viewer's session organization that the viewer has not finished yet.
 *
 * Both methods reuse the functions behind the task module's own `/api/tasks/pending` route
 * (`listPending`, `countPendingList`), so this file holds no pending rule of its own and the center's
 * rows are that route's rows. The count covers every open task. It is not the personal badge number,
 * which follows the viewer's badge setting.
 *
 * The organization is the session's (`viewer.orgId`). A viewer without one makes this source throw,
 * and the registry reports it as `unavailable`. `actionable` is absent: whether the viewer may act on
 * a task is decided on the task's own page.
 */
import { countPendingList, listPending } from './task-records'
import type { PendingItem, PendingSource, PendingViewer } from './pending-source-registry'

export const TASK_PENDING_SOURCE_NAME = 'task'

function requireOrg(viewer: PendingViewer): string {
  if (!viewer.orgId) throw new Error('TASK_ORG_MISSING')
  return viewer.orgId
}

function toPendingItem(row: Record<string, string>): PendingItem {
  return {
    source: row.source,
    id: row.id,
    title: row.title,
    href: row.href,
    updatedAt: row.updatedAt,
    ...(row.dueAt ? { dueAt: row.dueAt } : {}),
  }
}

export const taskPendingSource: PendingSource = {
  name: TASK_PENDING_SOURCE_NAME,
  permission: 'tasks:read',

  async listPendingForUser(viewer: PendingViewer): Promise<PendingItem[]> {
    const orgId = requireOrg(viewer)
    const rows = await listPending({ orgId, actorId: viewer.actorId, viewerTz: viewer.timeZone ?? null })
    return rows.map(toPendingItem)
  },

  async countPendingForUser(viewer: PendingViewer): Promise<number> {
    return countPendingList({ orgId: requireOrg(viewer), actorId: viewer.actorId })
  },
}
