/**
 * Task feature — task groups (named buckets, both LIST-scoped and personal USER-scoped).
 * PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-groups.ts`
 * Lock:   task-feature-design-lock-20260917.md §4.2 `:109` (P1 table `task_groups`/`task_group_items`),
 *         `:103` (`task_list_events` closed set: `group_created`/`group_renamed`/`group_deleted`),
 *         `:101` (`task_events` closed set: `group_changed`)
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 */
import { isStorableText, isValidPrintableAsciiId, normalizeUserText } from './task-ids'

// ASSUMPTION(task-d): [R11] the `scope` closed set is `list | user` (锁 `:779` "建议
// task_groups.scope='user'"); the owner ruled R11 on 2026-10-07. The exactly-one-default-group-
// per-scope rule and "delete reassigns to the default group" (see `applyCreateGroup` /
// `applyDeleteGroup` below) are R11's stated detail rules, not separate rulings.
// ── Scope closed set (§13-17 / R11) ───────────────────────────────────────────────────────────

export const TASK_GROUP_SCOPES = ['list', 'user'] as const
export type TaskGroupScope = (typeof TASK_GROUP_SCOPES)[number]

export interface TaskGroupRow {
  id: string
  scope: TaskGroupScope
  isDefault: boolean
  position: number
}

// ASSUMPTION(task-d, own choice — not ruling-derived): every `apply*` function below runtime-checks
// its `scope` input against `TASK_GROUP_SCOPES` and THROWS (`TypeError`) for anything outside the
// closed set, rather than silently treating an unrecognized scope as `'user'` (no `task_list_events`)
// or as `'list'` (writes events for a scope that may not even have a `listId`). `scope`'s
// compile-time type (`TaskGroupScope`) is a TypeScript-only guarantee, same rationale as
// `task-lists.ts`'s `parseTaskListMemberRole` guard — a caller crossing an untyped boundary (e.g. a
// raw HTTP body) is not bound by it. Matches `canListAction`'s own fail-closed-by-throwing style.
function assertValidTaskGroupScope(scope: TaskGroupScope, fnName: string): void {
  if (!(TASK_GROUP_SCOPES as readonly string[]).includes(scope)) {
    throw new TypeError(`${fnName}: unknown scope "${String(scope)}"`)
  }
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

// ── task_list_events (LIST-scope groups only — D2 writes no event for a personal-group move;
//    extended here to create / rename / delete for the same reason: a `task_list_events` row needs
//    a `listId`, and a USER-scope group has none) ────────────────────────────────────────────────────────────────────────────

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

// ASSUMPTION(task-d): [R11] new groups are never `isDefault` (the exactly-one-default-group-per-scope
// invariant is a DDL partial unique index; the default group itself is seeded once, outside this
// function, when the list/personal scope is created).
/**
 * `id`/`name` are already-validated inputs (caller generates the id via
 * `generateTaskDomainId('group', random)` in `task-ids.ts`, and validates the name via
 * `validateTaskGroupName` above — this function does not re-derive either). Position =
 * `existingCount` (appended at the end). D14: `TASK_GROUPS_PER_SCOPE_SOFT_LIMIT`.
 */
export function applyCreateGroup(input: {
  id: string
  scope: TaskGroupScope
  name: string
  existingCount: number
  actorId: string
}): ApplyCreateGroupResult {
  const { id, scope, name, existingCount, actorId } = input
  assertValidTaskGroupScope(scope, 'applyCreateGroup')
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
  assertValidTaskGroupScope(scope, 'applyRenameGroup')
  if (name === previousName) return { name: previousName, events: [] }
  const events: TaskGroupListEvent[] = scope === 'list' ? [{ type: 'group_renamed', userId: actorId }] : []
  return { name, events }
}

export type TaskGroupDeleteReason = 'not_found' | 'is_default'
export type ApplyDeleteGroupResult =
  | { ok: true; reassignToGroupId: string; events: TaskGroupListEvent[] }
  | { ok: false; reason: TaskGroupDeleteReason }

// ASSUMPTION(task-d): [R11] deleting the scope's own default group is never allowed ⇒ `is_default`;
// items in a deleted (non-default) group move to `defaultGroupId` (R11).
/**
 * `group` absent ⇒ `not_found`. Otherwise: items in the deleted group move to
 * `defaultGroupId` — the caller re-points `task_group_items.group_id`, this function only names
 * the target.
 */
export function applyDeleteGroup(input: {
  group: TaskGroupRow | undefined
  defaultGroupId: string
  scope: TaskGroupScope
  actorId: string
}): ApplyDeleteGroupResult {
  const { group, defaultGroupId, scope, actorId } = input
  assertValidTaskGroupScope(scope, 'applyDeleteGroup')
  if (!group) return { ok: false, reason: 'not_found' }
  if (group.scope !== scope) {
    throw new TypeError(`applyDeleteGroup: group.scope '${group.scope}' does not match scope '${scope}'`)
  }
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
// actually changes (`fromGroupId !== toGroupId`), and — mirroring D2, under which a move between
// personal groups writes no event — only when `scope === 'list'`. A pure REORDER within the SAME group
// (no group change) never emits `group_changed`, in either scope: the lock's `task_events` closed
// set records what happened to the TASK (which group it's in), not the group's internal item order.
/**
 * Recomputes integer positions for `toGroupId`'s FULL new order (`nextOrderedItemIds`, the target
 * group's item ids in final order, `itemId` included at its new spot). Positions are integers and
 * a reorder happens in one transaction (R11): the caller writes every returned position in that
 * transaction, not just the moved item's.
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
  assertValidTaskGroupScope(scope, 'applyMoveItem')
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

// ── M4 PR-3a additions (design task-m4-pr3a-backend-design-20260930.md §3.5, §4.1) ──────────────

// ASSUMPTION(task-m4): [own-12] [own-34] the default group's name. One constant for both scopes;
// the group can be renamed later, never deleted.
export const TASK_DEFAULT_GROUP_NAME = '默认分组'

// ── M4 PR-3a S8: names, the personal default group, placement order, group positions (design
//    task-m4-pr3a-backend-design-20260930.md §3.5, §4.1) ─────────────────────────────────────────

/**
 * A group name as the write routes accept it: `validateTaskGroupName`'s rules, and the text must be
 * storable exactly as sent (no U+0000, no lone surrogate), the same rule as a list name. A
 * non-storable name is `invalid_name`.
 */
export function parseTaskGroupName(raw: unknown): ValidateTaskGroupNameResult {
  const result = validateTaskGroupName(raw)
  if (result.ok && !isStorableText(result.name)) return { ok: false, reason: 'invalid_name' }
  return result
}

/** A group as the interface shows it. `id` is `null` only for the personal default group before
 * its row exists ([own-24]). */
export interface TaskGroupView {
  id: string | null
  scope: TaskGroupScope
  name: string
  position: number
  isDefault: boolean
}

// RULED(2026-10-07): [R11] one default group per scope. ASSUMPTION(task-m4): [own-24] the personal
// default group exists on the interface before it has a row: `GET /api/task-groups` shows this
// group, and a placement naming `groupId: null` means it. Its row is written by the first
// personal-group write.
/** The personal default group before its row exists. */
export function syntheticUserDefaultGroup(): TaskGroupView {
  return { id: null, scope: 'user', name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }
}

/**
 * The personal groups as the interface lists them: the stored rows in their order, preceded by the
 * synthetic default group when none of them is the default. Every container therefore shows
 * exactly one default group (R11).
 */
export function userGroupsWithDefault(rows: TaskGroupView[]): TaskGroupView[] {
  return rows.some((row) => row.isDefault === true) ? rows : [syntheticUserDefaultGroup(), ...rows]
}

export type ParseTargetGroupIdResult = { ok: true; groupId: string | null } | { ok: false; reason: 'invalid_group' }

// ASSUMPTION(task-m4): [own-12] [own-49] the target group of a placement: the body's `groupId` key
// must be present; `null` names the container's default group (both scopes); a string must be an
// id shape (printable ASCII) and is then checked against the container by the caller; anything
// else, a missing key included, is `invalid_group`.
export function parseTargetGroupId(body: unknown): ParseTargetGroupIdResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'invalid_group' }
  if (!Object.prototype.hasOwnProperty.call(body, 'groupId')) return { ok: false, reason: 'invalid_group' }
  const raw = (body as Record<string, unknown>).groupId
  if (raw === null) return { ok: true, groupId: null }
  if (isValidPrintableAsciiId(raw)) return { ok: true, groupId: raw as string }
  return { ok: false, reason: 'invalid_group' }
}

export type PlanGroupItemOrderResult =
  | { ok: true; before: string[]; after: string[] }
  | { ok: false; reason: 'invalid_position' }

// ASSUMPTION(task-m4): [own-13] [own-49] a placement's `position` is an index in the target group's
// VISIBLE set without the moved task: a JSON number that is a non-negative safe integer no larger
// than that set's size. Rows whose task is not visible keep their relative order and follow the
// visible rows on every rewrite, so they never collide with the rewritten positions.
/**
 * The whole target group before and after placing `taskId` at `position`, each as "visible rows
 * first, hidden rows after": `visibleOrderedIds` and `hiddenOrderedIds` are the group's rows split
 * by the visible-set rule, each in stored order. `before` is the canonical current order (equal to
 * `after` exactly when the visible order does not change); `after` is the order to write, one
 * position per index. The moved task is visible by definition, so finding it among the hidden rows
 * is a caller error and throws.
 */
export function planGroupItemOrder(input: {
  visibleOrderedIds: string[]
  hiddenOrderedIds: string[]
  taskId: string
  position: unknown
}): PlanGroupItemOrderResult {
  const { visibleOrderedIds, hiddenOrderedIds, taskId, position } = input
  if (hiddenOrderedIds.includes(taskId)) {
    throw new TypeError(`planGroupItemOrder: task "${taskId}" is among the hidden rows`)
  }
  const others = visibleOrderedIds.filter((id) => id !== taskId)
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position > others.length) {
    return { ok: false, reason: 'invalid_position' }
  }
  const visibleAfter = [...others.slice(0, position), taskId, ...others.slice(position)]
  return {
    ok: true,
    before: [...visibleOrderedIds, ...hiddenOrderedIds],
    after: [...visibleAfter, ...hiddenOrderedIds],
  }
}

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ASSUMPTION(task-m4): [own-13] [own-51] a container's groups keep positions 0..n-1. After a delete
// the remaining groups are renumbered in their current order (position, then id in byte order, the
// order the group reads use).
/**
 * The groups of one container whose position changes when `deletedGroupId` is deleted: the others,
 * renumbered from 0 in (position, id byte order) order. Groups already at their new position are
 * left out, so an empty result means nothing to write.
 */
export function planGroupPositionsAfterDelete(input: {
  groups: Array<{ id: string; position: number }>
  deletedGroupId: string
}): Array<{ id: string; position: number }> {
  const rest = input.groups
    .filter((group) => group.id !== input.deletedGroupId)
    .sort((a, b) => a.position - b.position || byteOrder(a.id, b.id))
  return rest
    .map((group, position) => ({ id: group.id, position, previous: group.position }))
    .filter((group) => group.position !== group.previous)
    .map(({ id, position }) => ({ id, position }))
}
