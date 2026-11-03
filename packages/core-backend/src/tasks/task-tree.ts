/**
 * Task feature — subtask tree: depth, descendants, set-parent/clear-parent validation, parent
 * candidates. PURE, no I/O; every timestamp-free (tree structure has no clock dependency).
 *
 * Design: docs/development/task-c-m3-pure-functions-design-20260928.md §2
 * Lock:   task-feature-design-lock-20260917.md §6.3, 门 6, §13-25 (depth 0..4, ratified)
 */
import { can, type TaskRole } from './task-access'

/** `depth` 0..4 including the root (lock §13-25, already ratified — five levels total). */
export const TASK_MAX_DEPTH = 4

/**
 * A node table representing the SAME-org, undeleted tasks (§2: "服务层负责只传同 org、未软删的
 * 行"). This module never mutates the map it is given.
 */
export interface TaskTreeNode {
  parentId: string | null
}
export type TaskTreeNodes = ReadonlyMap<string, TaskTreeNode>

/** Data corruption (a cycle, or a parent pointer to a node that isn't in `nodes`), never a user
 * error — a well-formed tree can never trigger this from the intended write paths. */
export class TaskTreeCorruptError extends Error {
  readonly code = 'TASK_TREE_CORRUPT'
  constructor(message: string) {
    super(message)
    this.name = 'TaskTreeCorruptError'
  }
}

function buildChildrenIndex(nodes: TaskTreeNodes): Map<string, string[]> {
  const children = new Map<string, string[]>()
  for (const [id, node] of nodes) {
    if (node.parentId === null) continue
    const list = children.get(node.parentId)
    if (list) list.push(id)
    else children.set(node.parentId, [id])
  }
  return children
}

/**
 * Root is 0. Walks the parent chain from `id` toward the root. Throws `TaskTreeCorruptError` if
 * `id` (or any ancestor along the way) is missing from `nodes` (a dangling parent pointer), or if
 * the walk revisits a node already seen (a cycle).
 */
export function depthOf(id: string, nodes: TaskTreeNodes): number {
  const visited = new Set<string>()
  let current = id
  let depth = 0
  while (true) {
    if (visited.has(current)) {
      throw new TaskTreeCorruptError(
        `depthOf: cycle detected while walking the parent chain from "${id}" (revisited "${current}")`,
      )
    }
    visited.add(current)
    const node = nodes.get(current)
    if (!node) {
      throw new TaskTreeCorruptError(
        `depthOf: dangling parent — node "${current}" not found while walking from "${id}"`,
      )
    }
    if (node.parentId === null) return depth
    current = node.parentId
    depth += 1
  }
}

/**
 * All descendants of `id` (not including `id` itself). Throws `TaskTreeCorruptError` if `id`
 * itself is not in `nodes` (a dangling reference — this function was asked for the subtree of a
 * task that does not exist), or if the downward walk revisits an already-visited node (a cycle
 * reachable from `id`).
 */
export function descendantsOf(id: string, nodes: TaskTreeNodes): string[] {
  if (!nodes.has(id)) {
    throw new TaskTreeCorruptError(`descendantsOf: dangling reference — node "${id}" not found in nodes`)
  }
  const children = buildChildrenIndex(nodes)
  const visited = new Set<string>([id])
  const result: string[] = []
  const queue: string[] = [...(children.get(id) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) {
      throw new TaskTreeCorruptError(`descendantsOf: cycle detected in the subtree of "${id}" (revisited "${current}")`)
    }
    visited.add(current)
    result.push(current)
    const kids = children.get(current)
    if (kids) queue.push(...kids)
  }
  return result
}

/**
 * Distance (in edges) from `id` down to its deepest descendant; a leaf is 0. Calls `depthOf(id,
 * nodes)` UNCONDITIONALLY first (before even looking at descendants) so a leaf whose OWN ancestor
 * chain is corrupt (cycle / dangling parent) still throws `TaskTreeCorruptError`, matching
 * `depthOf`/`descendantsOf`'s own contract.
 */
export function subtreeHeight(id: string, nodes: TaskTreeNodes): number {
  const idDepth = depthOf(id, nodes)
  const descendants = descendantsOf(id, nodes)
  if (descendants.length === 0) return 0
  let maxDepth = idDepth
  for (const d of descendants) {
    const dDepth = depthOf(d, nodes)
    if (dDepth > maxDepth) maxDepth = dDepth
  }
  return maxDepth - idDepth
}

export type TaskReparentFailureReason = 'not_found' | 'self' | 'descendant' | 'depth_exceeded'

export interface TaskDepthChange {
  id: string
  depth: number
}

export type TaskTreeEventType = 'parent_set' | 'parent_cleared'
export interface TaskTreeEvent {
  type: TaskTreeEventType
}

export type ValidateSetParentResult =
  | { ok: false; reason: TaskReparentFailureReason }
  | { ok: true; noop: boolean; depthChanges: TaskDepthChange[]; events: TaskTreeEvent[] }

/**
 * Design §2 check order (exact): (1) not_found, (2) self, (3) descendant (would create a cycle),
 * (4) depth_exceeded, (5) noop (already this parent), (6) apply. `depthChanges` covers the moved
 * task AND all of its descendants (their absolute depth shifts by the same delta as the task
 * itself — the relative shape of the subtree is unchanged by a reparent).
 *
 * This module never touches completion state (§6.3 "父完成不级联子"): it exports no function that
 * writes `completedAt` or `status`, and this function reads `nodes` only for `parentId`.
 */
export function validateSetParent(input: {
  taskId: string
  newParentId: string
  nodes: TaskTreeNodes
}): ValidateSetParentResult {
  const { taskId, newParentId, nodes } = input

  if (!nodes.has(taskId) || !nodes.has(newParentId)) {
    return { ok: false, reason: 'not_found' }
  }
  if (newParentId === taskId) {
    return { ok: false, reason: 'self' }
  }
  if (descendantsOf(taskId, nodes).includes(newParentId)) {
    return { ok: false, reason: 'descendant' }
  }
  const height = subtreeHeight(taskId, nodes)
  if (depthOf(newParentId, nodes) + 1 + height > TASK_MAX_DEPTH) {
    return { ok: false, reason: 'depth_exceeded' }
  }
  const currentParentId = nodes.get(taskId)!.parentId
  if (currentParentId === newParentId) {
    return { ok: true, noop: true, depthChanges: [], events: [] }
  }

  const oldDepth = depthOf(taskId, nodes)
  const newDepth = depthOf(newParentId, nodes) + 1
  const delta = newDepth - oldDepth
  const descendants = descendantsOf(taskId, nodes)
  const depthChanges: TaskDepthChange[] = [
    { id: taskId, depth: newDepth },
    ...descendants.map((id) => ({ id, depth: depthOf(id, nodes) + delta })),
  ]
  return { ok: true, noop: false, depthChanges, events: [{ type: 'parent_set' }] }
}

export type ValidateClearParentResult =
  | { ok: false; reason: 'not_found' }
  | { ok: true; noop: boolean; depthChanges: TaskDepthChange[]; events: TaskTreeEvent[] }

/**
 * "转独立" — clears `taskId`'s parent, making it a root (depth 0). Already a root ⇒ noop. Not in
 * the design doc's literal text (which only spells out the noop/else branches), but symmetric with
 * `validateSetParent`'s own `not_found` handling: an unknown `taskId` is reported the same way
 * rather than left to throw from a downstream `depthOf`/`descendantsOf` call.
 */
export function validateClearParent(input: { taskId: string; nodes: TaskTreeNodes }): ValidateClearParentResult {
  const { taskId, nodes } = input
  const node = nodes.get(taskId)
  if (!node) {
    return { ok: false, reason: 'not_found' }
  }
  if (node.parentId === null) {
    return { ok: true, noop: true, depthChanges: [], events: [] }
  }

  const oldDepth = depthOf(taskId, nodes)
  const delta = 0 - oldDepth
  const descendants = descendantsOf(taskId, nodes)
  const depthChanges: TaskDepthChange[] = [
    { id: taskId, depth: 0 },
    ...descendants.map((id) => ({ id, depth: depthOf(id, nodes) + delta })),
  ]
  return { ok: true, noop: false, depthChanges, events: [{ type: 'parent_cleared' }] }
}

/**
 * Both ends need `edit` and must be in the same org (§6.3). A failed check is surfaced by the
 * ROUTE as a uniform 404 (§6.3) — this function only returns the boolean.
 */
export function canReparent(input: { childRoles: TaskRole[]; parentRoles: TaskRole[]; sameOrg: boolean }): boolean {
  return input.sameOrg && can(input.childRoles, 'edit') && can(input.parentRoles, 'edit')
}

/**
 * Candidate new parents for `taskId`: excludes `taskId` itself, ALL of its descendants (lock §2
 * item 4's "自有加强" — not just direct children), and any node that would push the subtree past
 * `TASK_MAX_DEPTH` if attached. Returned sorted (lexicographic).
 */
export function parentCandidates(input: { taskId: string; nodes: TaskTreeNodes }): string[] {
  const { taskId, nodes } = input
  // An unknown task has no candidates (the route answers 404 before asking). Rows elsewhere in the
  // map are still walked, so a corrupt row anywhere in the org throws `TaskTreeCorruptError`.
  if (!nodes.has(taskId)) return []
  const excluded = new Set<string>([taskId, ...descendantsOf(taskId, nodes)])
  const height = subtreeHeight(taskId, nodes)
  const result: string[] = []
  for (const id of nodes.keys()) {
    if (excluded.has(id)) continue
    if (depthOf(id, nodes) + 1 + height > TASK_MAX_DEPTH) continue
    result.push(id)
  }
  return result.sort()
}
