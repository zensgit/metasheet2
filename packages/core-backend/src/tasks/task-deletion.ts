/**
 * Task feature — pre-flight decision for deleting a task (soft-delete only, P0). PURE, no I/O.
 *
 * Design: docs/development/task-c-m3-pure-functions-design-20260928.md §5
 * Lock:   task-feature-design-lock-20260917.md §13-27 (P0 只软删, suggested), §6.3 (tree)
 */
import { can, type TaskRole } from './task-access'

/** Same node-table convention as `task-tree.ts`'s `TaskTreeNodes`: same org, undeleted tasks only
 * (kept as a LOCAL type rather than importing `task-tree.ts` — this module deliberately does not
 * take on tree-corruption exceptions; it only asks a much narrower question, "does this task have
 * any undeleted children right now"). */
export interface TaskDeletionNode {
  parentId: string | null
}
export type TaskDeletionNodes = ReadonlyMap<string, TaskDeletionNode>

export type TaskDeletionFailureReason = 'not_found' | 'forbidden' | 'has_children'

export type TaskDeletionEventType = 'deleted'
export interface TaskDeletionEvent {
  type: TaskDeletionEventType
}

export type PlanDeleteTaskResult = { ok: false; reason: TaskDeletionFailureReason } | { ok: true; events: TaskDeletionEvent[] }

/**
 * Direct-children check over the "only undeleted org rows" node-map convention (`task-tree.ts` §2):
 * any row in `nodes` still pointing at `taskId` as its parent is, by that map's own contract, an
 * undeleted child. Equivalent to "has any descendant" for a well-formed tree (a descendant can only
 * exist through a chain of still-present direct children), without pulling in `task-tree.ts`'s
 * cycle/dangling-parent exceptions for what is otherwise a narrow, single-purpose check.
 */
function hasUndeletedChildren(taskId: string, nodes: TaskDeletionNodes): boolean {
  for (const node of nodes.values()) {
    if (node.parentId === taskId) return true
  }
  return false
}

/**
 * (0) Task not in the map ⇒ `not_found`. (1) No `delete` ability ⇒ `forbidden` (route maps this to a uniform 404, §6.3's pattern). (2)
 * Still has undeleted children ⇒ `has_children`. (3) Otherwise ⇒ ok, event `deleted`.
 */
export function planDeleteTask(input: { taskId: string; nodes: TaskDeletionNodes; roles: TaskRole[] }): PlanDeleteTaskResult {
  const { taskId, nodes, roles } = input
  // The node map holds undeleted rows only, so an absent task is either missing or already deleted.
  // Deleting it again must not emit a second `deleted` event.
  if (!nodes.has(taskId)) {
    return { ok: false, reason: 'not_found' }
  }
  if (!can(roles, 'delete')) {
    return { ok: false, reason: 'forbidden' }
  }
  // ASSUMPTION(task-c): A4 deleting a task that still has undeleted children is REJECTED outright
  // (no cascade). §13-27 leaves cascade behavior undecided; rejecting is reversible (the caller can
  // delete the children first), cascading is not.
  if (hasUndeletedChildren(taskId, nodes)) {
    return { ok: false, reason: 'has_children' }
  }
  return { ok: true, events: [{ type: 'deleted' }] }
}
