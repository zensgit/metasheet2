/**
 * Task feature — membership transitions: add/remove assignee, switch completion mode, add/remove
 * follower (incl. self-leave). PURE, no I/O; every timestamp comes from an explicit `now` argument
 * (never `Date.now()`/`new Date()` implicitly).
 *
 * Design: docs/development/task-c-m3-pure-functions-design-20260928.md §3
 * Lock:   task-feature-design-lock-20260917.md §6.2, §13-9 (ratified 2026-09-26, owner「四题按建议
 *         值」), §13-23 (follower ability, suggested), §13-28 (soft limit, suggested)
 */
import { computeTaskDone, type TaskAssigneeRow, type TaskCompletionMode } from './task-completion'

export type TaskMembershipStatus = 'open' | 'done'

/** `completedAt` of `null` OR `undefined` means "not completed" — same semantics as
 * `task-completion.ts`'s private `isCompleted` (duplicated locally: that function is not exported
 * from that module, so this is the "small shared helper -> local function" case). */
function isCompleted(row: TaskAssigneeRow): boolean {
  return row.completedAt !== null && row.completedAt !== undefined
}

export interface TaskMembershipInput {
  mode: TaskCompletionMode
  status: TaskMembershipStatus
  rows: TaskAssigneeRow[]
  now: Date
  /** Who performs the change. Carried on every event, like `task-completion.ts` events. */
  actorId: string
}

export type TaskAssigneeEventType =
  | 'assignee_added'
  | 'assignee_removed'
  | 'completion_mode_changed'
  | 'completed_by_any'
  // RULED(2026-10-07): [N1] the status flip an assignee change causes in `all` mode.
  | 'completed'
  | 'reopened'
export interface TaskAssigneeEvent {
  type: TaskAssigneeEventType
  /** The actor, same meaning as `userId` on `task-completion.ts` events. */
  userId: string
  /** The assignee the change is about (add/remove only). */
  targetUserId?: string
  /** Present on `completed_by_any` and `completed` (an explicit `now` stamps them). */
  occurredAt?: Date
}

export interface TaskMembershipRowsResult {
  rows: TaskAssigneeRow[]
  status: TaskMembershipStatus
  events: TaskAssigneeEvent[]
}

// ASSUMPTION(task-c): A5 soft limit is a single-point, reversible constant (§13-28 is a suggested
// value, not ruled by owner) — same rationale at `TASK_FOLLOWER_SOFT_LIMIT` below.
export const TASK_ASSIGNEE_SOFT_LIMIT = 50
// ASSUMPTION(task-c): A5 (assignee/follower share the same rationale; two constants so either can
// be revised independently without implying the other must match).
export const TASK_FOLLOWER_SOFT_LIMIT = 50

export type TaskMembershipLimitReason = 'limit'

export type ApplyAddAssigneeResult =
  | ({ ok: true } & TaskMembershipRowsResult)
  | { ok: false; reason: TaskMembershipLimitReason }

/**
 * §5-4 / §13-9. Already an assignee ⇒ noop. New row starts `completedAt: null`. `all` mode: adding
 * a (necessarily incomplete) row to an already-done task reopens it, and `reopened` is recorded
 * after `assignee_added` (RULED(2026-10-07): [N1], the actor is the operator). `any` mode: task
 * status is untouched and nothing else is recorded.
 */
export function applyAddAssignee(input: TaskMembershipInput & { userId: string }): ApplyAddAssigneeResult {
  const { mode, status, rows, userId } = input
  if (rows.some((r) => r.userId === userId)) {
    return { ok: true, rows: rows.map((r) => ({ ...r })), status, events: [] }
  }
  if (rows.length >= TASK_ASSIGNEE_SOFT_LIMIT) {
    return { ok: false, reason: 'limit' }
  }
  const newRows: TaskAssigneeRow[] = [...rows.map((r) => ({ ...r })), { userId, completedAt: null }]
  let newStatus = status
  if (mode === 'all' && status === 'done') {
    // §5-4: `all`-mode reopens when a new (incomplete) assignee is added to an already-done task.
    newStatus = 'open'
  }
  // ASSUMPTION(task-c): A1 adding an assignee to an ALREADY-DONE `any`-mode task leaves the task
  // done (no branch above touches `newStatus` for `any` mode). §5-4 only wrote the reopen rule for
  // `all` mode; the §6.2 invariant only constrains `open` status, so a done `any`-mode task growing
  // a new incomplete row is not itself an invariant violation.
  const events: TaskAssigneeEvent[] = [{ type: 'assignee_added', userId: input.actorId, targetUserId: input.userId }]
  // RULED(2026-10-07): [N1] a status flip records `reopened` in the same batch, by the operator.
  if (newStatus !== status) events.push({ type: 'reopened', userId: input.actorId })
  return { ok: true, rows: newRows, status: newStatus, events }
}

// RULED(2026-10-07): [N1] removing the LAST incomplete `all`-mode assignee PROMOTES `status` from
// `open` to `done` (A2 below); that flip records `completed` after `assignee_removed`, by the
// operator, stamped with `now`. No flip (the task was already done, or rows remain incomplete, or
// none remain) records `assignee_removed` only.
export function applyRemoveAssignee(input: TaskMembershipInput & { userId: string }): TaskMembershipRowsResult {
  const { mode, status, rows, userId } = input
  if (!rows.some((r) => r.userId === userId)) {
    return { rows: rows.map((r) => ({ ...r })), status, events: [] }
  }
  const newRows = rows.filter((r) => r.userId !== userId).map((r) => ({ ...r }))
  let newStatus = status
  // ASSUMPTION(task-c): A2 recompute-on-remove is PROMOTE-ONLY. `all` mode: if the rows remaining
  // (>=1) are now all complete, promote to `done`; otherwise (or with zero rows remaining) `status`
  // is left EXACTLY as passed in — it is NEVER forced back to `open` here. `any` mode: status is
  // never recomputed by this function.
  // NOTE(task-c, design-gap): §5-4's literal text states only the ⇒done promotion and the
  // zero-rows-remaining case ("维持原状态"); it is silent on "rows remain but are not all complete".
  // A demote-to-open reading is reachable to a real bug: `any`-mode done (one row completed) ->
  // `applyAddAssignee` grows a new incomplete row (A1: still done) -> `applySwitchCompletionMode`
  // any->all preserves done (§5-4) -> removing the ORIGINAL completed row would, under a naive
  // "recompute unconditionally" reading, silently reopen an already-done task. Promote-only closes
  // that gap and matches A2's own stated rationale ("不因删人把 done 任务悄悄改回 open").
  if (mode === 'all' && newRows.length > 0 && computeTaskDone({ mode: 'all', assigneeRows: newRows })) {
    newStatus = 'done'
  }
  const events: TaskAssigneeEvent[] = [{ type: 'assignee_removed', userId: input.actorId, targetUserId: input.userId }]
  if (newStatus !== status) events.push({ type: 'completed', userId: input.actorId, occurredAt: input.now })
  return { rows: newRows, status: newStatus, events }
}

/**
 * `all -> any`: if at least one row is already complete, the task becomes done — every OTHER
 * still-open row is stamped to the SAME `now` (mirrors `applyComplete`'s any-mode fan-out in
 * `task-completion.ts`), and `completed_by_any` is recorded ALONGSIDE `completion_mode_changed`;
 * with nobody complete, only `completion_mode_changed` fires and the task stays open. `any -> all`:
 * rows and status are carried over untouched (§5-4 "保留各人记录,已 done 的维持 done"). Same mode
 * on both sides ⇒ noop.
 */
export function applySwitchCompletionMode(
  input: TaskMembershipInput & { to: TaskCompletionMode },
): TaskMembershipRowsResult {
  const { mode, status, rows, now, to } = input
  if (to !== 'all' && to !== 'any') {
    throw new TypeError('applySwitchCompletionMode: `to` must be "all" or "any"')
  }
  if (to === mode) {
    return { rows: rows.map((r) => ({ ...r })), status, events: [] }
  }
  if (mode === 'all' && to === 'any') {
    // An already-done task only changes its mode: nothing to stamp, and `completed_by_any` would
    // announce a completion that happened earlier.
    if (status === 'done') {
      return { rows: rows.map((r) => ({ ...r })), status, events: [{ type: 'completion_mode_changed', userId: input.actorId }] }
    }
    const anyCompleted = rows.some(isCompleted)
    if (!anyCompleted) {
      return { rows: rows.map((r) => ({ ...r })), status, events: [{ type: 'completion_mode_changed', userId: input.actorId }] }
    }
    // An open `all` task cannot have every row completed (that would already be done), and the
    // done case returned above, so here some row is complete and some row is still open: the task
    // becomes done now, every open row is stamped with the same `now` (§13-9), existing stamps are kept.
    const newRows = rows.map((r) => (isCompleted(r) ? { ...r } : { ...r, completedAt: now }))
    return {
      rows: newRows,
      status: 'done',
      events: [
        { type: 'completion_mode_changed', userId: input.actorId },
        { type: 'completed_by_any', userId: input.actorId, occurredAt: now },
      ],
    }
  }
  // mode === 'any', to === 'all': §5-4 "保留各人记录,已 done 的维持 done" — no row/status rewrite.
  return { rows: rows.map((r) => ({ ...r })), status, events: [{ type: 'completion_mode_changed', userId: input.actorId }] }
}

export type TaskFollowerEventType = 'follower_added' | 'follower_removed' | 'left'
export interface TaskFollowerEvent {
  type: TaskFollowerEventType
  /** The actor. For `left` this is the follower themself. */
  userId: string
  /** The follower the change is about. */
  targetUserId: string
}

export interface TaskFollowerRowsResult {
  followers: string[]
  events: TaskFollowerEvent[]
}

export type ApplyAddFollowerResult =
  | ({ ok: true } & TaskFollowerRowsResult)
  | { ok: false; reason: TaskMembershipLimitReason }

/** Already following ⇒ noop; event `follower_added`. */
export function applyAddFollower(input: { followers: string[]; userId: string; actorId: string }): ApplyAddFollowerResult {
  const { followers, userId } = input
  if (followers.includes(userId)) {
    return { ok: true, followers: [...followers], events: [] }
  }
  if (followers.length >= TASK_FOLLOWER_SOFT_LIMIT) {
    return { ok: false, reason: 'limit' }
  }
  return { ok: true, followers: [...followers, userId], events: [{ type: 'follower_added', userId: input.actorId, targetUserId: userId }] }
}

/**
 * Not following ⇒ noop. Actor removing THEMSELVES ⇒ `left`; anyone else being removed ⇒
 * `follower_removed`. Whether `actorId` is ALLOWED to remove `userId` (leave is a `follower`-only
 * ability, `can(roles, 'leave')` from `task-access.ts`) is the CALLER's job — this function only
 * picks the event name once that permission has already been established.
 */
export function applyRemoveFollower(input: {
  followers: string[]
  userId: string
  actorId: string
}): TaskFollowerRowsResult {
  const { followers, userId, actorId } = input
  if (!followers.includes(userId)) {
    return { followers: [...followers], events: [] }
  }
  const newFollowers = followers.filter((id) => id !== userId)
  const type: TaskFollowerEventType = actorId === userId ? 'left' : 'follower_removed'
  return { followers: newFollowers, events: [{ type, userId: actorId, targetUserId: userId }] }
}

// This module does not export a `canLeave` wrapper: `leave` permission is `can(roles, 'leave')`
// straight from `task-access.ts` (follower can, creator/assignee cannot) — the design doc's
// function list for this module has exactly the five functions above, and the caller/route wires
// the permission check directly against `task-access.ts` rather than through a re-export here.
