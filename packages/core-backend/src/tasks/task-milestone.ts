/**
 * Task feature — the milestone flag: request-body parsing and the set/clear transition. PURE, no
 * I/O; the timestamp comes from an explicit `now`.
 *
 * Design: docs/development/task-e-m5-pure-functions-design-20261007.md §2.3
 * Lock:   task-feature-design-lock-20260917.md §3 (P2 scope), §4.2 (event words `milestone_set` /
 *         `milestone_cleared`)
 *
 * Kept as its own file (not appended to the in-flight PR-3a `task-edit.ts`). Who may flip the flag
 * is `can(roles, 'edit')` from `task-access.ts`, called by the route directly — no wrapper here.
 */

// RULED(2026-10-09): [S13] a milestone is an entity attribute only: no due date is required to set
// it, and nothing here changes how a task is drawn or scheduled.

export type ParseMilestoneFlagResult = { ok: true; value: boolean } | { ok: false; reason: 'invalid_milestone' }

/** Only a real boolean is accepted — `'true'`, `1` and `null` are all `invalid_milestone` (422). */
export function parseMilestoneFlag(raw: unknown): ParseMilestoneFlagResult {
  if (raw === true || raw === false) return { ok: true, value: raw }
  return { ok: false, reason: 'invalid_milestone' }
}

export type TaskMilestoneEventType = 'milestone_set' | 'milestone_cleared'

export interface TaskMilestoneEvent {
  type: TaskMilestoneEventType
  userId: string
  occurredAt: Date
}

export interface ApplySetMilestoneResult {
  isMilestone: boolean
  noop: boolean
  events: TaskMilestoneEvent[]
}

/** Same value ⇒ no-op, no event. `false → true` ⇒ `milestone_set`; `true → false` ⇒ `milestone_cleared`. */
export function applySetMilestone(input: {
  current: boolean
  next: boolean
  actorId: string
  now: Date
}): ApplySetMilestoneResult {
  const fn = 'applySetMilestone'
  if (typeof input !== 'object' || input === null) {
    throw new TypeError(`${fn}: input must be an object`)
  }
  const { current, next, actorId, now } = input
  if (typeof current !== 'boolean' || typeof next !== 'boolean') {
    throw new TypeError(`${fn}: current and next must be booleans`)
  }
  if (typeof actorId !== 'string' || actorId.length === 0) {
    throw new TypeError(`${fn}: actorId must be a non-empty string`)
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError(`${fn}: now must be a valid Date`)
  }
  if (current === next) {
    return { isMilestone: current, noop: true, events: [] }
  }
  return {
    isMilestone: next,
    noop: false,
    events: [{ type: next ? 'milestone_set' : 'milestone_cleared', userId: actorId, occurredAt: now }],
  }
}
