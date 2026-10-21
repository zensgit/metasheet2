/**
 * Task feature — comment body normalization/length, comment permissions, tombstone view shape.
 * PURE, no I/O.
 *
 * Design: docs/development/task-c-m3-pure-functions-design-20260928.md §4
 * Lock:   task-feature-design-lock-20260917.md §4 (event_type closed set, `commented`), §13-23
 */
import { can, type TaskRole } from './task-access'
import { normalizeUserText } from './task-ids'

/** Same value as `approval-comment-service.ts`'s `APPROVAL_COMMENT_BODY_MAX_CHARS` — design §4
 * "照审批评论表的形". Counted in Unicode CODE POINTS, not UTF-16 code units. */
export const TASK_COMMENT_BODY_MAX_CHARS = 5000

export type TaskCommentNormalizeFailureReason = 'blank' | 'too_long'
export type NormalizeCommentBodyResult = { ok: true; body: string } | { ok: false; reason: TaskCommentNormalizeFailureReason }

/**
 * Reuses `task-ids.ts`'s `normalizeUserText` (NFC, edge-trim Unicode whitespace + zero-width
 * marks, rejects blank). Length is then checked by CODE POINT (`[...s].length`), not `.length`
 * (UTF-16 units) — an astral-plane character (e.g. an emoji) is one code point but two UTF-16
 * units, so a `.length`-based check would reject strings that are actually within bounds.
 */
export function normalizeCommentBody(raw: unknown): NormalizeCommentBodyResult {
  const normalized = normalizeUserText(raw)
  if (normalized === null) {
    return { ok: false, reason: 'blank' }
  }
  if ([...normalized].length > TASK_COMMENT_BODY_MAX_CHARS) {
    return { ok: false, reason: 'too_long' }
  }
  return { ok: true, body: normalized }
}

/** Followers can comment (§13-23 suggested value, already in the task-B ability matrix). */
export function canComment(roles: TaskRole[]): boolean {
  return can(roles, 'comment')
}

// ASSUMPTION(task-c): A3 comment edit/delete is author-only, with NO admin override — matches the
// approval-comment precedent (`approval-comment-service.ts`'s R1: "S1 admits you to the INSTANCE;
// it does not make you the author of someone else's comment") and is the most conservative reading
// of an unruled §13 item.
/** A deleted comment can never be edited again, even by its own author. */
export function canEditComment(input: { authorId: string; actorId: string; deleted: boolean }): boolean {
  return !input.deleted && input.authorId === input.actorId
}

// ASSUMPTION(task-c): A3 (same rationale as `canEditComment` above).
export function canDeleteComment(input: { authorId: string; actorId: string; deleted: boolean }): boolean {
  return !input.deleted && input.authorId === input.actorId
}

/** The only comment event in the lock's closed set (§4 event_type; edit/delete emit nothing —
 * "编辑与删除不产生 task_events,事件闭集里没有对应词"). Exported as a type only: this module has
 * no state-transition function that PRODUCES the event — creating a comment has no noop branch (a
 * validated `normalizeCommentBody` success always becomes exactly one `commented` row), so the
 * service layer that actually inserts the row is the one that emits it. */
export type TaskCommentEventType = 'commented'

export interface TaskCommentRow {
  id: string
  taskId: string
  authorId: string
  body: string | null
  deleted: boolean
  createdAt: Date
}

export interface TaskCommentView {
  id: string
  taskId: string
  authorId: string
  body: string | null
  deleted: boolean
  createdAt: Date
}

/** Tombstone shape (design §4): a deleted comment's `body` reads as `null` — same shape as the
 * approval-comment tombstone (`approval-comment-service.ts`'s `toView`). */
export function toCommentView(row: TaskCommentRow): TaskCommentView {
  return {
    id: row.id,
    taskId: row.taskId,
    authorId: row.authorId,
    body: row.deleted ? null : row.body,
    deleted: row.deleted,
    createdAt: row.createdAt,
  }
}
