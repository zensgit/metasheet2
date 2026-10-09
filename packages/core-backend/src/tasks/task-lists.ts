/**
 * Task feature — task lists: list-role closed set + the `task-access.ts` bridge, list-action
 * ability matrix, member/ownership transitions, archive/unarchive, list-name validation, and the
 * two-event (`task_events` + `task_list_events`) plan for adding/removing a task from a list. PURE,
 * no I/O; every timestamp comes from an explicit `now` argument (never `Date.now()`/`new Date()`
 * implicitly).
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-lists.ts`
 * Lock:   task-feature-design-lock-20260917.md §4.2 `:109` (P1 tables), `:103` (`task_list_events`
 *         closed set), §6.1 `:243-244` / `:98-108` (`TaskListMembership`, `list-editor`/`list-reader`
 *         are a task-level role, not a list-level one — this module never invents a THIRD role
 *         scheme; `toTaskListMemberships` is the one bridge between the two).
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 */
import { type TaskListMembership } from './task-access'
import { normalizeUserText } from './task-ids'

// ── List-scoped role closed set: read / edit / owner (R12) ──────────────────────────────────────

/** Closed role set for `task_list_members.role` (R12). */
export const TASK_LIST_MEMBER_ROLES = ['read', 'edit', 'owner'] as const
export type TaskListMemberRole = (typeof TASK_LIST_MEMBER_ROLES)[number]

/** Roles an `applyAddMember`/`applyChangeMemberRole` CALLER may directly assign — `owner` is set
 * only via `applyTransferOwner` (ASSUMPTION(task-d): [R12(c)] a list has one owner and ownership
 * moves only by transfer, so no write path assigns 'owner' except the transfer transition). */
export const TASK_LIST_MEMBER_ASSIGNABLE_ROLES = ['read', 'edit'] as const
export type TaskListMemberAssignableRole = (typeof TASK_LIST_MEMBER_ASSIGNABLE_ROLES)[number]

export type ParseTaskListMemberRoleReason = 'invalid_role'
export type ParseTaskListMemberRoleResult =
  | { ok: true; role: TaskListMemberAssignableRole }
  | { ok: false; reason: ParseTaskListMemberRoleReason }

/**
 * Runtime closed-set guard for a caller-supplied ASSIGNABLE role, for the HTTP route boundary
 * (`req.body.role` arrives as `unknown`, not a `TaskListMemberAssignableRole` — TypeScript's
 * compile-time parameter type on `applyAddMember`/`applyChangeMemberRole` below is not itself a
 * runtime check; a caller that bypasses the type system, or forwards an unvalidated request body
 * straight through, can still reach those functions with anything). `'owner'` is deliberately
 * REJECTED here even though it is a member of `TASK_LIST_MEMBER_ROLES` — it is not in
 * `TASK_LIST_MEMBER_ASSIGNABLE_ROLES` (R12(c): ownership only ever moves via `applyTransferOwner`,
 * never a direct role assignment). Any other non-`'read'`/`'edit'` string, or a non-string, is also
 * `invalid_role`. `applyAddMember`/`applyChangeMemberRole` call this SAME function internally (not a
 * parallel check) so the route-boundary guard and the write-path guard can never drift apart.
 */
export function parseTaskListMemberRole(raw: unknown): ParseTaskListMemberRoleResult {
  if (typeof raw === 'string' && (TASK_LIST_MEMBER_ASSIGNABLE_ROLES as readonly string[]).includes(raw)) {
    return { ok: true, role: raw as TaskListMemberAssignableRole }
  }
  return { ok: false, reason: 'invalid_role' }
}

export interface TaskListMemberRow {
  userId: string
  role: TaskListMemberRole
}

// ASSUMPTION(task-d, own choice — not ruling-derived): an unrecognized `role` reaching this bridge
// (i.e. outside the `TASK_LIST_MEMBER_ROLES` closed set the DB CHECK is supposed to guarantee)
// THROWS rather than silently dropping the row or defaulting it to `'editor'`. This matches
// `canListAction` below's own fail-closed style — THROW on anything outside a closed set, never
// silently coerce — rather than "fail-closed by omission" (dropping the row): a corrupt/unknown
// role reaching here indicates a DB-level invariant violation (the CHECK constraint should have
// prevented it), and the caller should see that loudly, not have list membership silently vanish
// from a permission computation with no trace. Reversible: could be changed to drop-the-row without
// changing this file's shape.
/**
 * Bridges a list-membership row set into the `TaskListMembership[]` shape `task-access.ts`'s
 * `resolveTaskRoles` accepts (lock §6.1 `:98-108`): `read` → `'reader'`, `edit`/`owner` → `'editor'`
 * (an `owner` can do everything an `edit` member can at the TASK level; the extra list-management
 * powers `canListAction` below gates are list-scoped, not task-scoped, so they do not appear in
 * `task-access.ts`'s task-level ability matrix at all). Caller passes only the rows for lists that
 * CONTAIN the task being resolved, for the one user being resolved — this function does no
 * filtering itself.
 */
export function toTaskListMemberships(
  rows: Array<{ listId: string; role: TaskListMemberRole }>,
): TaskListMembership[] {
  return rows.map((row) => {
    if (row.role === 'read') return { listId: row.listId, role: 'reader' as const }
    if (row.role === 'edit' || row.role === 'owner') return { listId: row.listId, role: 'editor' as const }
    throw new TypeError(`toTaskListMemberships: unknown role "${String(row.role)}" for list "${row.listId}"`)
  })
}

// ── List-action ability matrix: the closed action set of `canListAction` ─────────────────────────

/** Closed action set for `canListAction`. */
export const TASK_LIST_ACTIONS = [
  'view',
  'rename',
  'archive',
  'unarchive',
  'manage_members',
  'transfer_owner',
  'add_item',
  'remove_item',
  'manage_groups',
] as const
export type TaskListAction = (typeof TASK_LIST_ACTIONS)[number]

/** `'none'` = not a member at all (ctx also carries `isCreator` separately — a list's creator can
 * archive it even at `'read'`, per §13-14, without being promoted to a stronger membership role). */
export type TaskListCtxRole = TaskListMemberRole | 'none'

// ASSUMPTION(task-d): [R12(a)] `add_item`/`remove_item` need list `edit` or `owner`; R12(a) is the
// only ruling item that names a list-action ability. `manage_members`,
// `manage_groups`, and `rename` are this module's OWN CHOICE (not named by any R-number): they
// follow the same "edit-or-owner" class as `add_item`/`remove_item` because R12 gives list-editor
// no narrower carve-out anywhere, and `task-access.ts`'s `TASK_ROLE_ABILITY` uses the same
// "edit ⇒ broad write access" shape for the task-level `list-editor` role. `transfer_owner` is
// owner-only because `applyTransferOwner` below requires the FROM side to already hold `'owner'` —
// gating the action the same way keeps `canListAction` and the transition function's own guard in
// agreement. Reversible: any of these can be tightened to owner-only without changing this file's
// shape, only these table values.
const TASK_LIST_ROLE_ABILITY: Record<Exclude<TaskListCtxRole, 'none'>, Record<TaskListAction, boolean>> = {
  owner: {
    view: true,
    rename: true,
    archive: true,
    unarchive: true,
    manage_members: true,
    transfer_owner: true,
    add_item: true,
    remove_item: true,
    manage_groups: true,
  },
  edit: {
    view: true,
    rename: true,
    archive: true,
    unarchive: true,
    manage_members: true,
    transfer_owner: false,
    add_item: true,
    remove_item: true,
    manage_groups: true,
  },
  read: {
    view: true,
    rename: false,
    archive: false,
    unarchive: false,
    manage_members: false,
    transfer_owner: false,
    add_item: false,
    remove_item: false,
    manage_groups: false,
  },
}

/**
 * `archive`/`unarchive` additionally pass for the list's CREATOR even at `role: 'read'` (lock
 * §13-14 `:776`, an already-decided direction: the list's creator and its `edit` / `owner` members
 * may archive). Every other action ignores `isCreator` and reads the role table only.
 */
export function canListAction(
  ctx: { role: TaskListCtxRole; isCreator?: boolean },
  action: TaskListAction,
): boolean {
  if (!(TASK_LIST_ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError(`canListAction: unknown action "${String(action)}"`)
  }
  if ((action === 'archive' || action === 'unarchive') && ctx.isCreator === true) {
    return true
  }
  if (ctx.role === 'none') return false
  return TASK_LIST_ROLE_ABILITY[ctx.role][action]
}

// ── Soft limits ([D14]) ──────────────────────────────────────────────────────────────────────────

// ASSUMPTION(task-d): [D14] soft limits are single-point, reversible constants (D14 is a "gate
// default", not an owner ruling) — same rationale as task-c's A5 (`TASK_ASSIGNEE_SOFT_LIMIT`).
export const TASK_LIST_MEMBER_SOFT_LIMIT = 100
export const TASK_LISTS_PER_TASK_SOFT_LIMIT = 10
export const TASK_LIST_NAME_MAX_CODEPOINTS = 100

export type TaskListNameInvalidReason = 'invalid_name' | 'name_too_long'
export type ValidateTaskListNameResult = { ok: true; name: string } | { ok: false; reason: TaskListNameInvalidReason }

/**
 * D14: reuses `task-ids.ts`'s `normalizeUserText` (NFC, edge-trim); blank ⇒ `invalid_name`, over
 * 100 CODE POINTS (not UTF-16 units — same astral-plane concern as `task-comments.ts`) ⇒
 * `name_too_long`. D14 explicitly does NOT reuse the `'limit'` reason code for this.
 */
export function validateTaskListName(raw: unknown): ValidateTaskListNameResult {
  const normalized = normalizeUserText(raw)
  if (normalized === null) return { ok: false, reason: 'invalid_name' }
  if ([...normalized].length > TASK_LIST_NAME_MAX_CODEPOINTS) return { ok: false, reason: 'name_too_long' }
  return { ok: true, name: normalized }
}

// ── task_list_events closed-set events this module can emit ─────────────────────────────────────

export type TaskListEventType =
  | 'member_added'
  | 'member_removed'
  | 'member_role_changed'
  | 'owner_transferred'
  | 'archived'
  | 'unarchived'
  | 'item_added'
  | 'item_removed'

export interface TaskListEvent {
  type: TaskListEventType
  /** The actor. */
  userId: string
  /** The member the change is about (member/transfer events only). */
  targetUserId?: string
}

// ── Member transitions (§3.1: applyAddMember / applyRemoveMember / applyChangeMemberRole /
//    applyTransferOwner) ─────────────────────────────────────────────────────────────────────────

export type TaskListMemberWriteReason = 'limit' | 'inactive_org_member' | 'invalid_role'
export type ApplyAddListMemberResult =
  | { ok: true; members: TaskListMemberRow[]; events: TaskListEvent[] }
  | { ok: false; reason: TaskListMemberWriteReason }

// ASSUMPTION(task-d): [R17] `isActiveInOrg` is a caller-supplied boolean (the actual
// active-member lookup (the login test) is I/O — the caller's job, same pattern as
// `task-membership.ts`'s soft-limit checks being pure booleans the caller assembles). Already-a-
// member is checked BEFORE the org-membership gate: re-adding an existing member is always a noop
// regardless of that member's current org status (this function never REMOVES a row).
// ASSUMPTION(task-d, own choice — not ruling-derived): the `role` closed-set guard runs FIRST, even
// before the already-a-member noop — a structurally malformed request (an untyped caller passing
// `'owner'`/`'admin'`/non-string through `req.body.role`) should be rejected regardless of whether
// the target user happens to already be a member; silently succeeding on garbage input just because
// membership already existed would mask a client bug. `role`'s compile-time type
// (`TaskListMemberAssignableRole`) is a TypeScript-only guarantee, not a runtime one — this reuses
// `parseTaskListMemberRole` (not a parallel check) so the two can never drift apart.
/**
 * Already a member ⇒ noop (role is NOT changed here even if `role` differs from the existing row —
 * use `applyChangeMemberRole` for that). R17: caller must have already resolved whether `userId` is
 * an active member of the list's org; `false` ⇒ 422 `inactive_org_member`. D14: `TASK_LIST_MEMBER_SOFT_LIMIT`.
 */
export function applyAddMember(input: {
  members: TaskListMemberRow[]
  userId: string
  role: TaskListMemberAssignableRole
  actorId: string
  isActiveInOrg: boolean
}): ApplyAddListMemberResult {
  const { members, userId, role, actorId, isActiveInOrg } = input
  if (!parseTaskListMemberRole(role).ok) {
    return { ok: false, reason: 'invalid_role' }
  }
  if (members.some((m) => m.userId === userId)) {
    return { ok: true, members: members.map((m) => ({ ...m })), events: [] }
  }
  if (!isActiveInOrg) {
    return { ok: false, reason: 'inactive_org_member' }
  }
  if (members.length >= TASK_LIST_MEMBER_SOFT_LIMIT) {
    return { ok: false, reason: 'limit' }
  }
  const newMembers: TaskListMemberRow[] = [...members.map((m) => ({ ...m })), { userId, role }]
  return {
    ok: true,
    members: newMembers,
    events: [{ type: 'member_added', userId: actorId, targetUserId: userId }],
  }
}

export type TaskListRemoveMemberReason = 'created_by_immutable' | 'owner_must_transfer'
export type ApplyRemoveListMemberResult =
  | { ok: true; members: TaskListMemberRow[]; events: TaskListEvent[] }
  | { ok: false; reason: TaskListRemoveMemberReason }

// ASSUMPTION(task-d): [R12(b)] the list's `created_by` can never be removed (422
// `created_by_immutable`), regardless of their current role.
// ASSUMPTION(task-d): [R12(c)] a member currently holding `'owner'` can never be removed
// directly — `applyTransferOwner` must run first (422 `owner_must_transfer`).
/** Not a member ⇒ noop. */
export function applyRemoveMember(input: {
  members: TaskListMemberRow[]
  userId: string
  actorId: string
  createdBy: string
}): ApplyRemoveListMemberResult {
  const { members, userId, actorId, createdBy } = input
  const existing = members.find((m) => m.userId === userId)
  if (!existing) {
    return { ok: true, members: members.map((m) => ({ ...m })), events: [] }
  }
  if (userId === createdBy) {
    return { ok: false, reason: 'created_by_immutable' }
  }
  if (existing.role === 'owner') {
    return { ok: false, reason: 'owner_must_transfer' }
  }
  const newMembers = members.filter((m) => m.userId !== userId).map((m) => ({ ...m }))
  return {
    ok: true,
    members: newMembers,
    events: [{ type: 'member_removed', userId: actorId, targetUserId: userId }],
  }
}

export type TaskListChangeRoleReason = 'not_found' | 'owner_must_transfer' | 'invalid_role'
export type ApplyChangeMemberRoleResult =
  | { ok: true; members: TaskListMemberRow[]; events: TaskListEvent[] }
  | { ok: false; reason: TaskListChangeRoleReason }

// ASSUMPTION(task-d): [R12(c)] current role `'owner'` ⇒ `owner_must_transfer` (same rule as
// `applyRemoveMember`: ownership only moves via `applyTransferOwner`).
// ASSUMPTION(task-d, own choice — not ruling-derived): same role-first ordering and same reused
// `parseTaskListMemberRole` guard as `applyAddMember` above, for the same reason — see that
// function's ASSUMPTION note.
/**
 * Not a member ⇒ `not_found` (this is a change to an EXISTING member, unlike `applyAddMember`'s
 * noop-on-existing shape — there is no row to no-op against). Same role requested ⇒ noop.
 */
export function applyChangeMemberRole(input: {
  members: TaskListMemberRow[]
  userId: string
  role: TaskListMemberAssignableRole
  actorId: string
}): ApplyChangeMemberRoleResult {
  const { members, userId, role, actorId } = input
  if (!parseTaskListMemberRole(role).ok) {
    return { ok: false, reason: 'invalid_role' }
  }
  const existing = members.find((m) => m.userId === userId)
  if (!existing) return { ok: false, reason: 'not_found' }
  if (existing.role === 'owner') return { ok: false, reason: 'owner_must_transfer' }
  if (existing.role === role) {
    return { ok: true, members: members.map((m) => ({ ...m })), events: [] }
  }
  const newMembers = members.map((m) => (m.userId === userId ? { ...m, role } : { ...m }))
  return {
    ok: true,
    members: newMembers,
    events: [{ type: 'member_role_changed', userId: actorId, targetUserId: userId }],
  }
}

export type TaskListTransferOwnerReason = 'not_owner' | 'target_not_member'
export type ApplyTransferOwnerResult =
  | { ok: true; members: TaskListMemberRow[]; events: TaskListEvent[] }
  | { ok: false; reason: TaskListTransferOwnerReason }

// ASSUMPTION(task-d): [R12(d)] `toUserId` must already be a list member (`target_not_member` if
// not): R12(d) demotes the former owner to `edit`, which presumes a target already in the member
// set, and it does not say a transfer may also add a new member. Requiring pre-membership is the
// conservative, reversible reading.
/**
 * R12(c)/(d): `fromUserId` must currently hold `'owner'` (422 `not_owner` otherwise — this is also
 * what makes `canListAction(…, 'transfer_owner')` and this function's own guard agree).
 * `fromUserId === toUserId` ⇒ noop. Otherwise: `toUserId` → `'owner'`, `fromUserId` → `'edit'`
 * (never `'read'`: R12(d) demotes the former owner to `edit`), event `owner_transferred`.
 */
export function applyTransferOwner(input: {
  members: TaskListMemberRow[]
  fromUserId: string
  toUserId: string
  actorId: string
}): ApplyTransferOwnerResult {
  const { members, fromUserId, toUserId, actorId } = input
  const from = members.find((m) => m.userId === fromUserId)
  if (!from || from.role !== 'owner') return { ok: false, reason: 'not_owner' }
  if (fromUserId === toUserId) {
    return { ok: true, members: members.map((m) => ({ ...m })), events: [] }
  }
  const to = members.find((m) => m.userId === toUserId)
  if (!to) return { ok: false, reason: 'target_not_member' }
  const newMembers = members.map((m) => {
    if (m.userId === fromUserId) return { ...m, role: 'edit' as const }
    if (m.userId === toUserId) return { ...m, role: 'owner' as const }
    return { ...m }
  })
  return {
    ok: true,
    members: newMembers,
    events: [{ type: 'owner_transferred', userId: actorId, targetUserId: toUserId }],
  }
}

// ── Archive / unarchive (§13-14, already decided: does NOT change task status/visibility) ────────

export interface ApplyArchiveResult {
  archivedAt: Date | null
  events: TaskListEvent[]
}

/** Already archived ⇒ noop. `archive`/`unarchive` permission is `canListAction` above, NOT checked
 * here (this function only computes the resulting state once permission is already established —
 * same split as `task-tree.ts`'s `canReparent` being separate from `validateSetParent`). */
export function applyArchive(input: { archivedAt: Date | null; now: Date; actorId: string }): ApplyArchiveResult {
  if (input.archivedAt !== null) {
    return { archivedAt: input.archivedAt, events: [] }
  }
  return { archivedAt: input.now, events: [{ type: 'archived', userId: input.actorId }] }
}

/** Not archived ⇒ noop. */
export function applyUnarchive(input: { archivedAt: Date | null; actorId: string }): ApplyArchiveResult {
  if (input.archivedAt === null) {
    return { archivedAt: null, events: [] }
  }
  return { archivedAt: null, events: [{ type: 'unarchived', userId: input.actorId }] }
}

// ── Add/remove a task to/from a list: two-event plan ([D2]) ──────────────────────────────────────

export type TaskListItemTaskEventType = 'list_added' | 'list_removed'
export interface TaskListItemTaskEvent {
  type: TaskListItemTaskEventType
  userId: string
}
export type TaskListItemListEventType = 'item_added' | 'item_removed'
export interface TaskListItemListEvent {
  type: TaskListItemListEventType
  userId: string
}

export type TaskListItemPlanReason = 'limit'
export type PlanAddTaskToListResult =
  | { ok: true; changed: boolean; taskEvents: TaskListItemTaskEvent[]; listEvents: TaskListItemListEvent[] }
  | { ok: false; reason: TaskListItemPlanReason }

/**
 * D2: adding a task to a list writes BOTH `task_events.list_added` AND
 * `task_list_events.item_added` in the SAME transaction (the caller's job — this only plans the two
 * event rows). Already in the list ⇒ noop (no events). D14: `TASK_LISTS_PER_TASK_SOFT_LIMIT`.
 * Authorization (R12(a): caller needs list `edit`/`owner` via `canListAction('add_item', …)` AND
 * task `can(roles,'edit')` via `task-access.ts` AND `task.orgId === list.orgId`) is composed by the
 * CALLER across both modules — this function does not re-derive it.
 */
export function planAddTaskToList(input: {
  currentListIds: string[]
  listId: string
  actorId: string
}): PlanAddTaskToListResult {
  const { currentListIds, listId, actorId } = input
  if (currentListIds.includes(listId)) {
    return { ok: true, changed: false, taskEvents: [], listEvents: [] }
  }
  if (currentListIds.length >= TASK_LISTS_PER_TASK_SOFT_LIMIT) {
    return { ok: false, reason: 'limit' }
  }
  return {
    ok: true,
    changed: true,
    taskEvents: [{ type: 'list_added', userId: actorId }],
    listEvents: [{ type: 'item_added', userId: actorId }],
  }
}

export interface PlanRemoveTaskFromListResult {
  changed: boolean
  taskEvents: TaskListItemTaskEvent[]
  listEvents: TaskListItemListEvent[]
}

/** D2, remove side. Not in the list ⇒ noop. No soft limit to check (removal can never exceed one). */
export function planRemoveTaskFromList(input: {
  currentListIds: string[]
  listId: string
  actorId: string
}): PlanRemoveTaskFromListResult {
  const { currentListIds, listId, actorId } = input
  if (!currentListIds.includes(listId)) {
    return { changed: false, taskEvents: [], listEvents: [] }
  }
  return {
    changed: true,
    taskEvents: [{ type: 'list_removed', userId: actorId }],
    listEvents: [{ type: 'item_removed', userId: actorId }],
  }
}
