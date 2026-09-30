/**
 * Task feature — task groups (kanban-style buckets, both LIST-scoped and personal USER-scoped).
 * PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-groups.ts`
 * Lock:   task-feature-design-lock-20260917.md §4.2 `:109` (P1 table `task_groups`/`task_group_items`),
 *         `:103` (`task_list_events` closed set: `group_created`/`group_renamed`/`group_deleted`),
 *         `:101` (`task_events` closed set: `group_changed`)
 *
 * This whole module implements the M4 ruling pack v2 (PROPOSED, not owner-ratified) — every
 * `ASSUMPTION(task-d)` comment below names the ruling id it implements the RECOMMENDED value of.
 */
import { normalizeUserText } from './task-ids'

// ── Scope closed set (§13-17 / R11: 锁 `:779` "建议 task_groups.scope='user'", accepted) ─────────

export const TASK_GROUP_SCOPES = ['list', 'user'] as const
export type TaskGroupScope = (typeof TASK_GROUP_SCOPES)[number]

export interface TaskGroupRow {
  id: string
  scope: TaskGroupScope
  isDefault: boolean
  position: number
}

// ── Soft limit + name validation (D14) ────────────────────────────────────────────────────────

// ASSUMPTION(task-d): [D14] single-point, reversible constant (D14 is a gate default, not an owner
// ruling) — every group scope container (one list, or one user's personal groups) gets its own
// count against this same limit.
export const TASK_GROUPS_PER_SCOPE_SOFT_LIMIT = 50
export const TASK_GROUP_NAME_MAX_CODEPOINTS = 100

export type TaskGroupNameInvalidReason = 'invalid_name' | 'name_too_long'
export type ValidateTaskGroupNameResult = { ok: true; name: string } | { ok: false; reason: TaskGroupNameInvalidReason }

/** D14: identical rule to `task-lists.ts`'s `validateTaskListName` (reuses `normalizeUserText`;
 * blank ⇒ `invalid_name`, over 100 CODE POINTS ⇒ `name_too_long`). Kept as its own small function
 * per-module (not imported from `task-lists.ts`) — same "small shared helper stays local" pattern
 * `task-membership.ts` already uses for `isCompleted`. */
export function validateTaskGroupName(raw: unknown): ValidateTaskGroupNameResult {
  const normalized = normalizeUserText(raw)
  if (normalized === null) return { ok: false, reason: 'invalid_name' }
  if ([...normalized].length > TASK_GROUP_NAME_MAX_CODEPOINTS) return { ok: false, reason: 'name_too_long' }
  return { ok: true, name: normalized }
}

// ── task_list_events (LIST-scope groups only — D2: "个人分组的移动不写事件", extended here to
//    创建/改名/删除 for the same reason: a `task_list_events` row needs a `listId`, and a USER-scope
//    group has none) ────────────────────────────────────────────────────────────────────────────

export type TaskGroupListEventType = 'group_created' | 'group_renamed' | 'group_deleted'
export interface TaskGroupListEvent {
  type: TaskGroupListEventType
  userId: string
}

// ── Create / rename / delete ──────────────────────────────────────────────────────────────────

export interface TaskGroupPlan {
  id: string
  scope: TaskGroupScope
  name: string
  position: number
  isDefault: false
}

export type ApplyCreateGroupResult =
  | { ok: true; group: TaskGroupPlan; events: TaskGroupListEvent[] }
  | { ok: false; reason: 'limit' }

/**
 * `id`/`name` are already-validated inputs (caller generates the id via
 * `generateTaskDomainId('group', random)` in `task-ids.ts`, and validates the name via
 * `validateTaskGroupName` above — this function does not re-derive either). New groups are never
 * `isDefault` (the exactly-one-default-group-per-scope invariant is a DDL partial unique index; the
 * default group itself is seeded once, outside this function, when the list/personal scope is
 * created). Position = `existingCount` (appended at the end). D14: `TASK_GROUPS_PER_SCOPE_SOFT_LIMIT`.
 */
export function applyCreateGroup(input: {
  id: string
  scope: TaskGroupScope
  name: string
  existingCount: number
  actorId: string
}): ApplyCreateGroupResult {
  const { id, scope, name, existingCount, actorId } = input
  if (existingCount >= TASK_GROUPS_PER_SCOPE_SOFT_LIMIT) {
    return { ok: false, reason: 'limit' }
  }
  const group: TaskGroupPlan = { id, scope, name, position: existingCount, isDefault: false }
  const events: TaskGroupListEvent[] = scope === 'list' ? [{ type: 'group_created', userId: actorId }] : []
  return { ok: true, group, events }
}

export interface ApplyRenameGroupResult {
  name: string
  events: TaskGroupListEvent[]
}

/** Same name ⇒ noop. */
export function applyRenameGroup(input: {
  scope: TaskGroupScope
  name: string
  previousName: string
  actorId: string
}): ApplyRenameGroupResult {
  const { scope, name, previousName, actorId } = input
  if (name === previousName) return { name: previousName, events: [] }
  const events: TaskGroupListEvent[] = scope === 'list' ? [{ type: 'group_renamed', userId: actorId }] : []
  return { name, events }
}

export type TaskGroupDeleteReason = 'not_found' | 'is_default'
export type ApplyDeleteGroupResult =
  | { ok: true; reassignToGroupId: string; events: TaskGroupListEvent[] }
  | { ok: false; reason: TaskGroupDeleteReason }

/**
 * `group` absent ⇒ `not_found`. Deleting the scope's own default group is never allowed (there must
 * always be exactly one) ⇒ `is_default`. Otherwise: items in the deleted group move to
 * `defaultGroupId` — "删组后项回默认组" — the caller re-points `task_group_items.group_id`, this
 * function only names the target.
 */
export function applyDeleteGroup(input: {
  group: TaskGroupRow | undefined
  defaultGroupId: string
  scope: TaskGroupScope
  actorId: string
}): ApplyDeleteGroupResult {
  const { group, defaultGroupId, scope, actorId } = input
  if (!group) return { ok: false, reason: 'not_found' }
  if (group.isDefault) return { ok: false, reason: 'is_default' }
  const events: TaskGroupListEvent[] = scope === 'list' ? [{ type: 'group_deleted', userId: actorId }] : []
  return { ok: true, reassignToGroupId: defaultGroupId, events }
}

// ── Move / reorder an item (position uses whole integers, reindexed atomically) ──────────────────

export interface TaskGroupItemPosition {
  itemId: string
  groupId: string
  position: number
}

export type TaskGroupChangedEventType = 'group_changed'
export interface TaskGroupChangedEvent {
  type: TaskGroupChangedEventType
  userId: string
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

// ASSUMPTION(task-d): [D2] `group_changed` (a `task_events` row) fires only when the item's GROUP
// actually changes (`fromGroupId !== toGroupId`), and — mirroring D2's explicit "个人分组的移动不写
// 事件" for the list/user split — only when `scope === 'list'`. A pure REORDER within the SAME group
// (no group change) never emits `group_changed`, in either scope: the lock's `task_events` closed
// set records what happened to the TASK (which group it's in), not the group's internal item order.
/**
 * Recomputes integer positions for `toGroupId`'s FULL new order (`nextOrderedItemIds`, the target
 * group's item ids in final order, `itemId` included at its new spot) — "整数重排…在同一事务内重排"
 * means the caller writes every returned position in one transaction, not just the moved item's.
 * Same group AND identical order to `previousOrderedItemIds` (the FROM group's order before the
 * move) ⇒ noop (`changed: false`, no positions, no events) — this is the module's "no change ⇒ no
 * event" rule applied to reordering specifically.
 */
export function applyMoveItem(input: {
  scope: TaskGroupScope
  fromGroupId: string
  toGroupId: string
  previousOrderedItemIds: string[]
  nextOrderedItemIds: string[]
  actorId: string
}): { changed: boolean; positions: TaskGroupItemPosition[]; taskEvents: TaskGroupChangedEvent[] } {
  const { scope, fromGroupId, toGroupId, previousOrderedItemIds, nextOrderedItemIds, actorId } = input
  const sameGroup = fromGroupId === toGroupId
  if (sameGroup && arraysEqual(previousOrderedItemIds, nextOrderedItemIds)) {
    return { changed: false, positions: [], taskEvents: [] }
  }
  const positions: TaskGroupItemPosition[] = nextOrderedItemIds.map((itemId, position) => ({
    itemId,
    groupId: toGroupId,
    position,
  }))
  const taskEvents: TaskGroupChangedEvent[] =
    !sameGroup && scope === 'list' ? [{ type: 'group_changed', userId: actorId }] : []
  return { changed: true, positions, taskEvents }
}
