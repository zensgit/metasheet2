/**
 * Task feature — socket fan-out recipients (§13-30). PURE, no I/O; this module never touches a
 * socket/room API itself, it only computes WHO the caller should emit to.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-realtime.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-30 `:798` (suggested: per-user room, P0-A emits
 *         on complete/assign/reopen)
 *
 * Each `ASSUMPTION(task-d)` comment below names the ruling item it implements. The owner ruled the
 * R and N items on 2026-10-07 (values and R12's narrowed form: PR-3a design §11).
 */

// ASSUMPTION(task-d): [R16] recipients are the UNION of the assignee set BEFORE and AFTER the
// write — not just one side. A pure reassignment (someone added AND someone else removed in the
// same write) must reach BOTH the newly-added person (their badge now needs to count this task) and
// the newly-removed person (their badge no longer does); a person present on both sides is
// naturally deduplicated by the `Set`. Followers never receive this event (R16: a follower's count
// does not change, so nothing is sent — the badge R16 invalidates is driven off the `assigned` view,
// not `following`).
// Output is sorted (own choice, not ruling-derived — deterministic, diffable, and order-independent
// for a caller that just iterates the room list).
/**
 * `tasks:counts-updated` room recipients (R16): union of `beforeAssignees` and `afterAssignees`.
 * The event this feeds is a bare invalidation signal with NO count/task payload (R16: the payload
 * only invalidates — the client re-fetches `/pending-count` with its own `x-viewer-time-zone` header) —
 * this module only computes the recipient set, it does not shape any payload.
 */
export function countsUpdateRecipients(beforeAssignees: string[], afterAssignees: string[]): string[] {
  const recipients = new Set<string>()
  for (const id of beforeAssignees) recipients.add(id)
  for (const id of afterAssignees) recipients.add(id)
  return [...recipients].sort()
}

// ---------------------------------------------------------------------------------------------
// M4 PR-3c (design task-m4-pr3c-backend-design-20261008.md §3): appended; the function above is
// unchanged.
// ---------------------------------------------------------------------------------------------

/** The stored task fields of a `PATCH` that the pending predicate reads. */
export interface TaskPendingDueFields {
  dueDate: string | null
  dueTime: string | null
  timeZone: string | null
  dueAt: Date | null
}

function sameDueInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right
  return left.getTime() === right.getTime()
}

// RULED(2026-10-07): [R16] a `PATCH` is a touchpoint when it changes a due field or the time zone.
// ASSUMPTION(task-m4): [own-3c-03] any change of the stored `due_date`, `due_time`, `time_zone` or
// `due_at`, a time-zone change on a task without a due date included; title, description, start
// and reminder fields are not inputs of the pending predicate.
/** Whether `after` differs from `before` in a field the pending predicate reads. */
export function patchChangesPendingInputs(before: TaskPendingDueFields, after: TaskPendingDueFields): boolean {
  return before.dueDate !== after.dueDate
    || before.dueTime !== after.dueTime
    || before.timeZone !== after.timeZone
    || !sameDueInstant(before.dueAt, after.dueAt)
}
