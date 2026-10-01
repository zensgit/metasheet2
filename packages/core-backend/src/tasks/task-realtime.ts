/**
 * Task feature — socket fan-out recipients (§13-30). PURE, no I/O; this module never touches a
 * socket/room API itself, it only computes WHO the caller should emit to.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-realtime.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-30 `:798` (suggested: per-user room, P0-A emits
 *         on complete/assign/reopen)
 *
 * This whole module implements the M4 ruling pack v2 (PROPOSED, not owner-ratified) — every
 * `ASSUMPTION(task-d)` comment below names the ruling id it implements the RECOMMENDED value of.
 */

// ASSUMPTION(task-d): [R16] recipients are the UNION of the assignee set BEFORE and AFTER the
// write — not just one side. A pure reassignment (someone added AND someone else removed in the
// same write) must reach BOTH the newly-added person (their badge now needs to count this task) and
// the newly-removed person (their badge no longer does); a person present on both sides is
// naturally deduplicated by the `Set`. Followers never receive this event (R16: "关注人的计数不会
// 变,不发" — the badge R16 invalidates is driven off the `assigned` view, not `following`).
// Output is sorted (own choice, not ruling-derived — deterministic, diffable, and order-independent
// for a caller that just iterates the room list).
/**
 * `tasks:counts-updated` room recipients (R16): union of `beforeAssignees` and `afterAssignees`.
 * The event this feeds is a bare invalidation signal with NO count/task payload (R16: "载荷只作
 * 失效信号" — the client re-fetches `/pending-count` with its own `x-viewer-time-zone` header) —
 * this module only computes the recipient set, it does not shape any payload.
 */
export function countsUpdateRecipients(beforeAssignees: string[], afterAssignees: string[]): string[] {
  const recipients = new Set<string>()
  for (const id of beforeAssignees) recipients.add(id)
  for (const id of afterAssignees) recipients.add(id)
  return [...recipients].sort()
}
