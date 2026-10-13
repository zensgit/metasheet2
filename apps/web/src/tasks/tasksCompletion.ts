/**
 * Task detail — whether the viewer's complete / reopen click would change anything, read from the
 * detail body alone. PURE: no I/O.
 *
 * The server answers 200 to a complete or reopen that changes nothing. In "all assignees complete"
 * mode a complete stamps only the caller's own assignee row, and a reopen with scope `self` clears
 * only the caller's own row (and reopens the task when a row is still open). So a caller the
 * detail's `canComplete` / `canReopen` permits can still click and see nothing happen: a creator or
 * a list editor who is not an assignee, or an assignee whose own part is already done. These
 * helpers name those cases so the page can turn the button off and say why; the server stays the
 * gate for everything else.
 *
 * Mirrors `applyComplete` / `applyReopen` (core-backend `tasks/task-completion.ts`) on main. Any
 * mode, and a task with no assignees, are never a no-op here: an any-mode complete or reopen
 * changes every row, and a task with no assignees is completed and reopened by its creator alone.
 *
 * `viewerId` `null` = the viewer's id is not known (still resolving, or could not be resolved):
 * nothing is reported, and the buttons stay as they were.
 */
import type { TaskDetail } from './tasksApi'

export type TaskCompletionSource = Pick<TaskDetail, 'status' | 'completionMode' | 'assignees' | 'canReopen'>

/** Why a complete click would change nothing. */
export type CompleteNoopReason = 'not_assignee' | 'own_part_done'

function isAllModeWithAssignees(task: TaskCompletionSource): boolean {
  return task.completionMode === 'all' && task.assignees.length > 0
}

/** For an open all-mode task: `'not_assignee'` when the viewer has no assignee row, `'own_part_done'`
 *  when their row is already complete; `null` when the click would complete their part, or when
 *  the rule does not apply. */
export function completeNoopReason(task: TaskCompletionSource, viewerId: string | null): CompleteNoopReason | null {
  if (viewerId === null || task.status !== 'open' || !isAllModeWithAssignees(task)) return null
  const own = task.assignees.find((row) => row.userId === viewerId)
  if (!own) return 'not_assignee'
  if (own.completedAt !== null) return 'own_part_done'
  return null
}

/** For a done all-mode task: `true` when a reopen with scope `self` would change nothing — the
 *  viewer has no completed row of their own and every assignee row is complete, so the task stays
 *  done. (A done task with an open row, carried over from any mode, does reopen.) */
export function reopenSelfIsNoop(task: TaskCompletionSource, viewerId: string | null): boolean {
  if (viewerId === null || task.status !== 'done' || !isAllModeWithAssignees(task)) return false
  const own = task.assignees.find((row) => row.userId === viewerId)
  if (own && own.completedAt !== null) return false
  return task.assignees.every((row) => row.completedAt !== null)
}
