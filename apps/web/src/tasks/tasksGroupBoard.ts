// The grouping board's rules (M4 frontend design §4.4, §6; backend PR-3a §3.5): the order the
// board shows, the visible set a move counts in, and the PUT body a move sends. No I/O; the board
// component (views/tasks/TaskGroupBoard.vue) renders and sends, these functions decide.
//
// Order:
//   - groups by `position`, then `id` in code-unit order (ids are printable ASCII, so this is the
//     server's byte order);
//   - inside a group, the placed rows by the placement's `position`, then `taskId` in the same order;
//   - the default group also holds the rows without a placement, after its placed rows and in the
//     rows' own (server) order: the "unsorted" tail. Those rows are outside the index space.
//   - a placement whose group is not on the board is shown in the default group's placed rows;
//     a placement whose task is not among the rows is not shown.
//
// Moves count in the target group's visible set as the board shows it, with the moved task taken
// out; the PUT names the default group with `null` in both scopes. A move that leaves the task in
// the same group at the same index is no move. Moves are offered only while the board's index space
// is the server's (`consistent`): every placement names a shown row and a known group.

import type { TaskGroup, TaskListItem, TaskPlacement } from './tasksApi'

/** The key the default group is filed under; every other group is filed under its id. */
export const DEFAULT_GROUP_KEY = ''

// ASSUMPTION(task-m4-fe): [D14] — at most 50 groups per container, the default group included.
export const GROUP_CAP = 50

export interface BoardModel {
  /** Every group, in board order. */
  groups: TaskGroup[]
  /** Group key -> the ids of its placed rows in board order: that group's visible set. */
  ordered: Record<string, string[]>
  /** The default group's rows without a placement, in the rows' own order. */
  tail: string[]
  /** Every placement names a shown row and a known group. */
  consistent: boolean
}

/** Where a task sits on the board; `index` is -1 for a row in the unsorted tail. */
export interface TaskLocation {
  key: string
  index: number
}

export interface PlannedMove {
  taskId: string
  /** The target group's key on the board. */
  key: string
  /** The PUT body's `groupId`: `null` names the default group. */
  groupId: string | null
  /** The PUT body's `position`: the index in the target group's visible set without the task. */
  position: number
}

export function groupKey(group: TaskGroup): string {
  return group.isDefault ? DEFAULT_GROUP_KEY : (group.id ?? DEFAULT_GROUP_KEY)
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export function compareGroups(a: TaskGroup, b: TaskGroup): number {
  if (a.position !== b.position) return a.position - b.position
  return compareCodeUnits(a.id ?? '', b.id ?? '')
}

function comparePlacements(a: TaskPlacement, b: TaskPlacement): number {
  if (a.position !== b.position) return a.position - b.position
  return compareCodeUnits(a.taskId, b.taskId)
}

/** The board for these reads, or `null` when the groups cannot hold one: not exactly one default
 *  group, or a group other than the default without an id, with an empty id or with an id another
 *  group has. */
export function buildBoardModel(
  groups: readonly TaskGroup[],
  placements: readonly TaskPlacement[],
  items: readonly TaskListItem[],
): BoardModel | null {
  const sorted = [...groups].sort(compareGroups)
  if (sorted.filter((group) => group.isDefault).length !== 1) return null
  const keyById = new Map<string, string>()
  for (const group of sorted) {
    if (group.id === null) {
      if (!group.isDefault) return null
      continue
    }
    if (group.id === '' || keyById.has(group.id)) return null
    keyById.set(group.id, groupKey(group))
  }

  const rowIds = new Set(items.map((item) => item.id))
  const byKey = new Map<string, TaskPlacement[]>(sorted.map((group) => [groupKey(group), []]))
  const placed = new Set<string>()
  let consistent = true
  for (const placement of placements) {
    if (!rowIds.has(placement.taskId)) {
      consistent = false
      continue
    }
    if (placed.has(placement.taskId)) continue
    placed.add(placement.taskId)
    const key = keyById.get(placement.groupId)
    if (key === undefined) consistent = false
    ;(byKey.get(key ?? DEFAULT_GROUP_KEY) as TaskPlacement[]).push(placement)
  }

  const ordered: Record<string, string[]> = {}
  for (const [key, list] of byKey) ordered[key] = [...list].sort(comparePlacements).map((placement) => placement.taskId)
  const tail = items.filter((item) => !placed.has(item.id)).map((item) => item.id)
  return { groups: sorted, ordered, tail, consistent }
}

export function locateTask(model: BoardModel, taskId: string): TaskLocation | null {
  for (const group of model.groups) {
    const key = groupKey(group)
    const index = model.ordered[key].indexOf(taskId)
    if (index >= 0) return { key, index }
  }
  return model.tail.includes(taskId) ? { key: DEFAULT_GROUP_KEY, index: -1 } : null
}

/** The move of `taskId` to `position` in group `key`'s visible set without the task, or `null`
 *  when the target is unknown, the position is out of range, or the task would stay where it is. */
export function planMove(model: BoardModel, taskId: string, key: string, position: number): PlannedMove | null {
  const from = locateTask(model, taskId)
  const target = model.ordered[key]
  if (from === null || target === undefined) return null
  const others = target.filter((id) => id !== taskId)
  if (!Number.isInteger(position) || position < 0 || position > others.length) return null
  if (from.key === key && from.index === position) return null
  return { taskId, key, groupId: key === DEFAULT_GROUP_KEY ? null : key, position }
}

/** One place up (`-1`) or down (`1`) inside the task's own group; the tail has no such step. */
export function planStep(model: BoardModel, taskId: string, step: -1 | 1): PlannedMove | null {
  const from = locateTask(model, taskId)
  if (from === null || from.index < 0) return null
  return planMove(model, taskId, from.key, from.index + step)
}

/** A tail row joins the default group's order at its end. */
export function planJoinOrder(model: BoardModel, taskId: string): PlannedMove | null {
  const from = locateTask(model, taskId)
  if (from === null || from.index >= 0) return null
  return planMove(model, taskId, DEFAULT_GROUP_KEY, model.ordered[DEFAULT_GROUP_KEY].length)
}

/** To the end of another group's order; the task's own group is no move. */
export function planToGroup(model: BoardModel, taskId: string, key: string): PlannedMove | null {
  const from = locateTask(model, taskId)
  const target = model.ordered[key]
  if (from === null || target === undefined || from.key === key) return null
  return planMove(model, taskId, key, target.filter((id) => id !== taskId).length)
}

/** A drop in group `key`: before row `rowId` (after it when `after`), or at the end of the group's
 *  order when `rowId` is `null` or a row of the unsorted tail. */
export function planDrop(model: BoardModel, taskId: string, key: string, rowId: string | null, after: boolean): PlannedMove | null {
  const target = model.ordered[key]
  if (target === undefined || rowId === taskId) return null
  const others = target.filter((id) => id !== taskId)
  const index = rowId === null ? -1 : others.indexOf(rowId)
  if (index < 0) return planMove(model, taskId, key, others.length)
  return planMove(model, taskId, key, after ? index + 1 : index)
}

/** The board as it reads once the move is applied: the shown order a move puts on screen before
 *  the server answers. */
export function applyMove(model: BoardModel, move: PlannedMove): BoardModel {
  const ordered: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(model.ordered)) ordered[key] = ids.filter((id) => id !== move.taskId)
  ordered[move.key].splice(move.position, 0, move.taskId)
  return {
    groups: model.groups,
    ordered,
    tail: model.tail.filter((id) => id !== move.taskId),
    consistent: model.consistent,
  }
}
