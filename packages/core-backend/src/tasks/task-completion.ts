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

/**
 * What an event records in `task_events.payload`: closed key names and task-domain ids only, never
 * business content such as a title or a value (M5 PR-4a design §1.2, §4.4).
 */
export type TaskCompletionEventPayload = Readonly<Record<string, string>>

export interface TaskCompletionEvent {
  type: TaskCompletionEventType
  userId: string
  /** Present on complete events (an explicit `now` was supplied); absent on reopen events (no clock needed). */
  occurredAt?: Date
  /**
   * M5 PR-4a slice 1: written into `task_events.payload`; absent means the column's `{}`. Only the
   * `completed` of a creator's complete for every assignee carries one (`applyCompleteForAll`).
   */
  payload?: TaskCompletionEventPayload
}

export interface ApplyCompleteResult {
  rows: TaskAssigneeRow[]
  done: boolean
  /** `'creator-direct'` = zero-assignee task, done set by the creator, bypassing `computeTaskDone`. `'formula'` = the normal path. */
  via: 'creator-direct' | 'formula'
  events: TaskCompletionEvent[]
}

// NOTE(task-b, own choice, owner 2026-09-27 「按建议执行」 on the gate's proposal): zero-assignee
// complete/reopen take a required `wasDone` so a repeat call is a no-op with no event, the same
// no-op-means-no-events rule as the non-zero branches.
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
  /**
   * Whether the task was ALREADY done before this call. Required so every caller has to decide.
   * The task row is the source of truth for done-ness (task-c A6): a done task can legitimately
   * hold null rows (an assignee added to a done `any` task, task-c A1, then possibly switched to
   * `all`, which keeps done per §5-4), so it cannot always be derived from `rows`. `true` makes a
   * repeat complete a no-op with no event, in every mode. MUST come from
   * the task row read AFTER the structure lock is held: a stale `true` would silently drop a real
   * open-to-done transition's event.
   */
  wasDone: boolean
}): ApplyCompleteResult {
  const { mode, rows, actorId, createdBy, now, wasDone } = input

  if (rows.length === 0) {
    if (actorId !== createdBy) {
      throw new Error('applyComplete: a zero-assignee task can only be completed by its creator')
    }
    if (wasDone === true) {
      return { rows: [], done: true, via: 'creator-direct', events: [] }
    }
    return {
      rows: [],
      done: true,
      via: 'creator-direct',
      events: [{ type: 'completed', userId: actorId, occurredAt: now }],
    }
  }

  if (mode === 'any') {
    // task-c A6: the task row is the source of truth for an `any` task's done state. A done task
    // may hold null rows (an assignee added after it was done, A1), so re-completing it must be a
    // no-op instead of stamping those rows and emitting a second `completed_by_any`.
    if (wasDone === true) {
      return { rows: rows.map((row) => ({ ...row })), done: true, via: 'formula', events: [] }
    }
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

  // task-c A6: a task that is already done stays a no-op in `all` mode too, even if some rows are
  // null (carried over from `any`), so completing cannot re-announce `completed`.
  if (wasDone === true) {
    return { rows: rows.map((row) => ({ ...row })), done: true, via: 'formula', events: [] }
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

// RULED(2026-10-09): six items, item 3: a task's creator may complete it for every assignee, and
// completing a task that is already done again is a no-op that records no second event.
// ASSUMPTION(task-m5a): [a-03] that completion records `completed` with payload `{ scope: 'all' }`.
// ASSUMPTION(task-m5a): [a-04] in `any` mode and on a task without assignees it is exactly the
// default complete (the creator's own completion already finishes the whole task there).
/**
 * `complete` with scope `all` (M5 PR-4a design §3.1, §4.1, §5). Order of the branches:
 * 1. an actor other than `createdBy` throws (the service answers 404 first, via `canCompleteForAll`);
 * 2. `wasDone` ⇒ no-op, no event, in every mode, even when a row is still null (task-c A6: an
 *    assignee added to a done task, then the mode switched to `all`);
 * 3. `all` mode with at least one assignee: every null row is stamped with the SAME `now`, a row that
 *    already holds a completion instant keeps it, the task is done, and one `completed` is recorded
 *    for the actor with payload `{ scope: 'all' }` (design §3.1 events row, §4.1: one `completed` on
 *    the flip). That holds when no row was left to stamp too: past the `wasDone` branch every call
 *    here flips the task, so it never flips without its event. `applyComplete` keeps its own
 *    "no stamped row ⇒ no event" rule for the default path;
 * 4. otherwise (`any` mode, or no assignee): `applyComplete` itself, result for result.
 */
export function applyCompleteForAll(input: {
  mode: TaskCompletionMode
  rows: TaskAssigneeRow[]
  actorId: string
  createdBy: string
  now: Date
  /** Same contract as `applyComplete`'s `wasDone`: the task row's status, read under the structure lock. */
  wasDone: boolean
}): ApplyCompleteResult {
  const { mode, rows, actorId, createdBy, now, wasDone } = input
  if (actorId !== createdBy) {
    throw new Error('applyCompleteForAll: only the task creator may complete a task for every assignee')
  }
  if (wasDone === true) {
    return { rows: rows.map((row) => ({ ...row })), done: true, via: rows.length === 0 ? 'creator-direct' : 'formula', events: [] }
  }
  if (mode !== 'all' || rows.length === 0) {
    return applyComplete(input)
  }
  const newRows = rows.map((row) => (isCompleted(row) ? { ...row } : { ...row, completedAt: now }))
  return {
    rows: newRows,
    done: computeTaskDone({ mode, assigneeRows: newRows }),
    via: 'formula',
    events: [{ type: 'completed', userId: actorId, occurredAt: now, payload: { scope: 'all' } }],
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
  /**
   * Whether the task was done before this call. Required; same rules as `applyComplete`'s
   * `wasDone` (the task row's state, read under the structure lock). `false` makes reopening an
   * already-open zero-assignee task a no-op with no event; `true` lets a done task reopen with
   * scope `all` (or in `any` mode) even when no row is stamped.
   */
  wasDone: boolean
}): ApplyReopenResult {
  const { mode, rows, actorId, scope, createdBy, wasDone } = input

  if (rows.length === 0) {
    if (actorId !== createdBy) {
      throw new Error('applyReopen: a zero-assignee task can only be reopened by its creator')
    }
    if (wasDone === false) {
      return { rows: [], events: [] }
    }
    return { rows: [], events: [{ type: 'reopened', userId: actorId }] }
  }

  if (mode === 'any') {
    // task-c A6: a done `any` task reopens from the task row's state, not only from stamped rows,
    // so a done task whose rows are all null (assignee added after it was done, A1) is not stuck.
    const wasTaskDone = wasDone === true || rows.some(isCompleted)
    const newRows = rows.map((row) => ({ ...row, completedAt: null }))
    return { rows: newRows, events: wasTaskDone ? [{ type: 'reopened', userId: actorId }] : [] }
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
    // task-c A6: a done task whose rows are all null (carried over from `any`) still reopens.
    return { rows: newRows, events: changed || wasDone === true ? [{ type: 'reopened', userId: actorId }] : [] }
  }
  let changedSelf = false
  const newRows = rows.map((row) => {
    if (row.userId === actorId) {
      if (isCompleted(row)) changedSelf = true
      return { ...row, completedAt: null }
    }
    return { ...row }
  })
  if (changedSelf) {
    return { rows: newRows, events: [{ type: 'self_reopened', userId: actorId }] }
  }
  // task-c A7 (owner accepted 2026-09-28): the actor's own row did not change, yet the task was
  // done and no longer counts as done once recomputed (e.g. rows carried over from `any` include a
  // null row), so the service flips it to open. That flip is recorded as `reopened`. If the task
  // still counts as done (every row complete, actor has no row), nothing happens and no event fires.
  if (wasDone === true && !computeTaskDone({ mode, assigneeRows: newRows })) {
    return { rows: newRows, events: [{ type: 'reopened', userId: actorId }] }
  }
  return { rows: newRows, events: [] }
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
