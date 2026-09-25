/**
 * Task feature — completion-mode formulas + complete/reopen row transitions. PURE, no I/O; every
 * timestamp comes from an explicit `now` argument (never `Date.now()`/`new Date()` implicitly).
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1, §2.4
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §6.2, §13-9, §4.2
 */

export type TaskCompletionMode = 'all' | 'any'

export interface TaskAssigneeRow {
  userId: string
  completedAt: Date | null
}

/**
 * `all`: at least one row AND every row's `completedAt` non-null. `any`: any row non-null. Zero
 * rows is ALWAYS false for both modes (lock §4.2 formula — zero-row tasks are done only via the
 * creator-direct path in `applyComplete`, never through this formula).
 */
/** `completedAt` of `null` OR `undefined` means "not completed" (a missing field is never a completion). */
function isCompleted(row: TaskAssigneeRow): boolean {
  return row.completedAt !== null && row.completedAt !== undefined
}

export function computeTaskDone(input: { mode: TaskCompletionMode; assigneeRows: TaskAssigneeRow[] }): boolean {
  const { mode, assigneeRows } = input
  if (assigneeRows.length === 0) return false
  if (mode === 'all') return assigneeRows.every(isCompleted)
  return assigneeRows.some(isCompleted)
}

export type TaskCompletionEventType =
  | 'self_completed'
  | 'completed_by_any'
  | 'completed'
  | 'self_reopened'
  | 'reopened'

export interface TaskCompletionEvent {
  type: TaskCompletionEventType
  userId: string
  /** Present on complete events (an explicit `now` was supplied); absent on reopen events (no clock needed). */
  occurredAt?: Date
}

export interface ApplyCompleteResult {
  rows: TaskAssigneeRow[]
  done: boolean
  /** `'creator-direct'` = zero-assignee task, done set by the creator, bypassing `computeTaskDone`. `'formula'` = the normal path. */
  via: 'creator-direct' | 'formula'
  events: TaskCompletionEvent[]
}

// NOTE(task-b, own choice — not one of design §3's assumptions): re-completing an
// already-completed row is idempotent — an existing `completedAt` is preserved rather than
// overwritten with a new `now`, keeping the first completion instant stable across repeat calls.
/**
 * `complete` transition (lock §6.2 / §13-9). Zero-assignee tasks: only the creator may complete;
 * anyone else throws (design §5 test plan: "零负责人非 creator 拒绝"). Non-zero: `any` mode stamps
 * EVERY row (the actor's own and everyone else's) to the SAME `now` and records `completed_by_any`;
 * `all` mode stamps only the actor's own row and records `self_completed` while other rows remain
 * open, or `completed` once that stamp makes every row non-null.
 */
export function applyComplete(input: {
  mode: TaskCompletionMode
  rows: TaskAssigneeRow[]
  actorId: string
  createdBy: string
  now: Date
}): ApplyCompleteResult {
  const { mode, rows, actorId, createdBy, now } = input

  if (rows.length === 0) {
    if (actorId !== createdBy) {
      throw new Error('applyComplete: a zero-assignee task can only be completed by its creator')
    }
    return {
      rows: [],
      done: true,
      via: 'creator-direct',
      events: [{ type: 'completed', userId: actorId, occurredAt: now }],
    }
  }

  if (mode === 'any') {
    // An already-done any-mode task (every row stamped) is a no-op: no rows change, no event.
    const alreadyDone = computeTaskDone({ mode: 'all', assigneeRows: rows })
    const newRows = rows.map((row) => (isCompleted(row) ? { ...row } : { ...row, completedAt: now }))
    return {
      rows: newRows,
      done: computeTaskDone({ mode, assigneeRows: newRows }),
      via: 'formula',
      events: alreadyDone ? [] : [{ type: 'completed_by_any', userId: actorId, occurredAt: now }],
    }
  }

  // mode === 'all': only the actor's own row is stamped.
  // NOTE(task-b, design-gap — flag for owner ratification, alongside lock §13-9): `changed` tracks
  // whether this call actually stamped a row. Without it, an actor with NO row at all (e.g. the
  // creator, who `can(['creator'],'complete')` permits but who was never assigned) — or an actor
  // whose own row was ALREADY completed — silently changes nothing yet still emitted
  // `self_completed`/`completed`, a phantom event a `task_events` writer or notification fan-out
  // would announce as if the task had actually transitioned. Design §2.4 does not say what "all: 只
  // 置本人" means when 本人 has no row (or is already done); this picks "no-op ⇒ no events" over
  // throwing, since `complete` is otherwise idempotent everywhere else in this module (see the
  // `any`-mode idempotence note above).
  let changed = false
  const newRows = rows.map((row) => {
    if (row.userId === actorId && !isCompleted(row)) {
      changed = true
      return { ...row, completedAt: now }
    }
    return { ...row }
  })
  const done = computeTaskDone({ mode, assigneeRows: newRows })
  if (!changed) {
    return { rows: newRows, done, via: 'formula', events: [] }
  }
  return {
    rows: newRows,
    done,
    via: 'formula',
    events: [{ type: done ? 'completed' : 'self_completed', userId: actorId, occurredAt: now }],
  }
}

export type TaskReopenScope = 'self' | 'all'

export interface ApplyReopenResult {
  rows: TaskAssigneeRow[]
  events: TaskCompletionEvent[]
}

/**
 * `reopen` transition (lock §6.2 / §13-9). Zero-assignee: creator-only, mirroring `applyComplete`.
 * `any` mode always clears EVERY row (there is no partial "any" reopen) and records `reopened`.
 * `all` mode honors `scope`: `'self'` clears only the actor's row (`self_reopened`), `'all'` clears
 * every row (`reopened`). No `now` parameter — reopening clears `completedAt` to `null`, it does not
 * stamp a new instant.
 */
export function applyReopen(input: {
  mode: TaskCompletionMode
  rows: TaskAssigneeRow[]
  actorId: string
  scope?: TaskReopenScope
  createdBy: string
}): ApplyReopenResult {
  const { mode, rows, actorId, scope, createdBy } = input

  if (rows.length === 0) {
    if (actorId !== createdBy) {
      throw new Error('applyReopen: a zero-assignee task can only be reopened by its creator')
    }
    return { rows: [], events: [{ type: 'reopened', userId: actorId }] }
  }

  if (mode === 'any') {
    const wasDone = rows.some(isCompleted)
    const newRows = rows.map((row) => ({ ...row, completedAt: null }))
    return { rows: newRows, events: wasDone ? [{ type: 'reopened', userId: actorId }] : [] }
  }

  // mode === 'all'
  if (scope !== 'self' && scope !== 'all') {
    throw new TypeError('applyReopen: mode "all" requires scope "self" or "all"')
  }
  // Same no-op-means-no-events choice as `applyComplete`'s all-mode branch above (see its NOTE):
  // `changed` tracks whether this call actually cleared a row, so reopening an already-all-open task
  // (scope 'all') or an actor whose own row was already null (scope 'self', including an actor with
  // no row at all) does not emit a phantom `reopened`/`self_reopened` event.
  if (scope === 'all') {
    let changed = false
    const newRows = rows.map((row) => {
      if (isCompleted(row)) changed = true
      return { ...row, completedAt: null }
    })
    return { rows: newRows, events: changed ? [{ type: 'reopened', userId: actorId }] : [] }
  }
  let changedSelf = false
  const newRows = rows.map((row) => {
    if (row.userId === actorId) {
      if (isCompleted(row)) changedSelf = true
      return { ...row, completedAt: null }
    }
    return { ...row }
  })
  return { rows: newRows, events: changedSelf ? [{ type: 'self_reopened', userId: actorId }] : [] }
}

/**
 * Invariant guarded on every complete/reopen call (门 3 survival gate): an `open` task in `any` mode
 * must never have a non-null `completedAt` row (an `any`-mode completion always finishes the whole
 * task, so `open` and "someone already completed" are mutually exclusive). Returns `false` on
 * violation rather than throwing — callers decide what a violated invariant means for them.
 */
export function assertAnyModeInvariant(status: string, mode: TaskCompletionMode, rows: TaskAssigneeRow[]): boolean {
  if (status === 'open' && mode === 'any') {
    return !rows.some(isCompleted)
  }
  return true
}
