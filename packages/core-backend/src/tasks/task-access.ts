/**
 * Task feature — access control: role/ability truth table, the TS-side list-view predicate, and the
 * text-only SQL scope builders. PURE, no I/O: `buildTaskScopeCondition` / `buildTaskPendingCondition`
 * only produce `{ sql, params }` text/value pairs — they never call `pg.query` themselves.
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1, §2.1, §2.2
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §6.1 `:241-253`, §13-4, §13-5
 */

/** Closed role set (lock §6.1). */
export const TASK_ROLES = ['creator', 'assignee', 'follower', 'list-editor', 'list-reader', 'none'] as const
export type TaskRole = (typeof TASK_ROLES)[number]

/** Closed ability set (lock §6.1). */
export const TASK_ABILITIES = ['view', 'edit', 'complete', 'reopen', 'comment', 'attach', 'delete', 'leave'] as const
export type TaskAbility = (typeof TASK_ABILITIES)[number]

// NOTE(task-b): `follower` = view + comment + leave only — lock §13-23 suggested value (not among the
// four items the owner ruled on 2026-09-26; revisit if §13-23 is ruled differently).
// ASSUMPTION(task-b): [design §3 item 1] `creator.leave = false` and `assignee.leave = false` —
// leaving a task is a follower-only action; creator/assignee "leave" is not a thing this period.
/**
 * `|R|×|A|` truth table (design §2.1). Multiple roles on the same actor take the UNION (`can` ORs
 * across the actor's role set) — this table itself holds only the per-role facts.
 */
export const TASK_ROLE_ABILITY: Record<TaskRole, Record<TaskAbility, boolean>> = {
  creator: {
    view: true,
    edit: true,
    complete: true,
    reopen: true,
    comment: true,
    attach: true,
    delete: true,
    leave: false,
  },
  assignee: {
    view: true,
    edit: true,
    complete: true,
    reopen: true,
    comment: true,
    attach: true,
    delete: false,
    leave: false,
  },
  follower: {
    view: true,
    edit: false,
    complete: false,
    reopen: false,
    comment: true,
    attach: false,
    delete: false,
    leave: true,
  },
  'list-editor': {
    view: true,
    edit: true,
    complete: true,
    reopen: true,
    comment: true,
    attach: true,
    delete: false,
    leave: false,
  },
  'list-reader': {
    view: true,
    edit: false,
    complete: false,
    reopen: false,
    comment: true,
    attach: false,
    delete: false,
    leave: false,
  },
  none: {
    view: false,
    edit: false,
    complete: false,
    reopen: false,
    comment: false,
    attach: false,
    delete: false,
    leave: false,
  },
}

export interface TaskRoleRow {
  createdBy: string
  assigneeIds: string[]
  followerIds: string[]
}

// ASSUMPTION(task-b): [design §3 item 2] list roles are P1 — `listMemberships` is accepted on
// `resolveTaskRoles` for forward-compat but defaults to empty, so `list-editor` / `list-reader`
// never appear this period (the P1 table they'd be read from does not exist yet).
export interface TaskListMembership {
  listId: string
  role: 'editor' | 'reader'
}

/** Row-level role set for `me` (lock §6.1). Returns `['none']` when no other role applies. */
export function resolveTaskRoles(
  row: TaskRoleRow,
  me: string,
  listMemberships: TaskListMembership[] = [],
): TaskRole[] {
  const roles: TaskRole[] = []
  if (row.createdBy === me) roles.push('creator')
  if (row.assigneeIds.includes(me)) roles.push('assignee')
  if (row.followerIds.includes(me)) roles.push('follower')
  let sawEditor = false
  let sawReader = false
  for (const membership of listMemberships) {
    if (membership.role === 'editor' && !sawEditor) {
      roles.push('list-editor')
      sawEditor = true
    } else if (membership.role === 'reader' && !sawReader) {
      roles.push('list-reader')
      sawReader = true
    }
  }
  return roles.length > 0 ? roles : ['none']
}

/** Union across `roles` of `TASK_ROLE_ABILITY[role][ability]`. Answers single-object "can I …", never list membership. */
export function can(roles: TaskRole[], ability: TaskAbility): boolean {
  return roles.some((role) => TASK_ROLE_ABILITY[role]?.[ability] === true)
}

export type TaskView = 'assigned' | 'following' | 'created' | 'delegated' | 'any_role'

export const TASK_VIEWS: readonly TaskView[] = ['assigned', 'following', 'created', 'delegated', 'any_role']

export interface TaskViewRow {
  createdBy: string
  assigneeIds: string[]
  followerIds: string[]
}

/**
 * TS-side view predicate (lock §6.1 "ambient" table, gate 19). `othersAssigned` is read directly off
 * the row (an assignee other than `me`), not gated by view/role — matching the lock's ambient
 * definition used to build the 49-cell fixture grid.
 */
export function taskMatchesView(row: TaskViewRow, me: string, view: TaskView): boolean {
  const meInAssignees = row.assigneeIds.includes(me)
  const meInFollowers = row.followerIds.includes(me)
  const createdByMe = row.createdBy === me
  const othersAssigned = row.assigneeIds.some((id) => id !== me)
  const delegated = createdByMe && othersAssigned
  switch (view) {
    case 'assigned':
      return meInAssignees
    case 'following':
      return meInFollowers
    case 'created':
      return createdByMe
    case 'delegated':
      return delegated
    case 'any_role':
      return meInAssignees || meInFollowers || createdByMe || delegated
    default:
      throw new TypeError(`taskMatchesView: unknown view "${String(view)}"`)
  }
}

// ASSUMPTION(task-b): [design §3 item 4] placeholder form is fixed `$1` (actor) / `$2` (org) — and,
// for `buildTaskPendingCondition`'s date-scoped clauses only, `$3` (viewer tz, see that function) —
// the caller wires `params` straight into its own pg query call as the bind-values array — no re-indexing.
export interface TaskScopeCondition {
  /** WHERE-clause fragment using `$1`/`$2` placeholders — always ready to AND into a larger query. */
  sql: string
  /** Positional bind values: `[actorParam, orgParam]`, matching `$1`/`$2` in `sql`. */
  params: unknown[]
}

const ME_PLACEHOLDER = '$1'
const ORG_PLACEHOLDER = '$2'
const VIEWER_TZ_PLACEHOLDER = '$3'

function scopeArm(view: Exclude<TaskView, 'any_role'>): string {
  switch (view) {
    case 'assigned':
      return `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = ${ME_PLACEHOLDER})`
    case 'following':
      return `EXISTS (SELECT 1 FROM task_followers tf WHERE tf.task_id = tasks.id AND tf.user_id = ${ME_PLACEHOLDER})`
    case 'created':
      return `tasks.created_by = ${ME_PLACEHOLDER}`
    case 'delegated':
      return `tasks.created_by = ${ME_PLACEHOLDER} AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id <> ${ME_PLACEHOLDER})`
    default:
      throw new TypeError(`scopeArm: unknown view "${String(view)}"`)
  }
}

/**
 * Produces `{ sql, params }` TEXT for the tasks list-view scope — never executes anything.
 * BIND SLOTS: the fragment always occupies `$1` (actor) and `$2` (org); `buildTaskPendingCondition`
 * additionally uses `$3` (viewer tz). A caller that embeds the fragment in a larger query must put
 * these values FIRST in its params array and number its own parameters from `$4` on. The
 * `org_id` clause is emitted exactly once here (lock §4.3 "single-point emission"); no other
 * function in this module may write its own org clause. Throws for a `view` outside `TASK_VIEWS`
 * rather than silently emitting `(FALSE)` — a caller that forwards an unvalidated `?view=` should
 * see a predicate error (lock §4.3 `degraded:true, reason:'predicate_error'`), not an empty 200.
 */
export function buildTaskScopeCondition(input: {
  view: TaskView
  /** Bind VALUE for the acting user id (emitted as `$1`). */
  actorParam: string
  /** Bind VALUE for the org id (emitted as `$2`). */
  orgParam: string
}): TaskScopeCondition {
  const { view, actorParam, orgParam } = input
  if (!TASK_VIEWS.includes(view)) {
    throw new TypeError(`buildTaskScopeCondition: unknown view "${String(view)}"`)
  }
  const arm =
    view === 'any_role'
      ? (['assigned', 'following', 'created', 'delegated'] as const)
          .map((v) => `(${scopeArm(v)})`)
          .join(' OR ')
      : scopeArm(view)
  const sql = `(tasks.org_id = ${ORG_PLACEHOLDER}) AND tasks.deleted_at IS NULL AND (${arm})`
  return { sql, params: [actorParam, orgParam] }
}

// ASSUMPTION(task-b): [design §3 item 3] the `scope` closed set is exactly `all_open | overdue |
// overdue_or_today`; the persisted `badge_scope='off'` column value never reaches this function —
// the caller is responsible for short-circuiting an "off" badge before calling at all.
export type TaskPendingScope = 'all_open' | 'overdue' | 'overdue_or_today'

// NOTE(task-b, design-gap — flag for owner ratification): design §1's signature for
// `buildTaskPendingCondition` is `{actorParam, orgParam, scope}`, with no viewer-tz input, but lock
// §4.4's pinned SQL for `overdue`/`overdue_or_today` is explicitly viewer-tz-aware (`COALESCE(viewer
// tz, tasks.time_zone)` per row) and branches on `tasks.due_time IS NULL` for the all-day rule
// rather than comparing `due_at` uniformly. `viewerTzParam` is added here as an OPTIONAL fourth
// input, bound as `$3` ONLY in the two date-scoped clauses (never in `all_open`, which has no date
// comparison); omitting it (or passing `null`) reproduces the lock's own fallback — each row's own
// `tasks.time_zone` — via `COALESCE($3, tasks.time_zone)`, so every existing call site keeps working
// unchanged, just now correctly split on `due_time IS NULL` per row. The `viewerTzParam` value is
// expected to already be VALIDATED (e.g. `task-dates.ts`'s `validateViewerTimeZoneHeader`, which
// returns `null` for a missing/invalid header) — this function does not itself re-validate it.
export type TaskPendingConditionInput = {
  actorParam: string
  orgParam: string
  scope: TaskPendingScope
  /** Validated viewer-tz header (see the NOTE above), or `null`/omitted for "no viewer header". */
  viewerTzParam?: string | null
}

/**
 * `/pending` and `/pending-count` condition. MUST derive from `buildTaskScopeCondition({view:
 * 'assigned'})` (lock `:414`) rather than emit its own role arm, and must not emit any OTHER role
 * arm (only `assigned`).
 */
export function buildTaskPendingCondition(input: TaskPendingConditionInput): TaskScopeCondition {
  const { actorParam, orgParam, scope, viewerTzParam } = input
  const base = buildTaskScopeCondition({ view: 'assigned', actorParam, orgParam })
  // Pure filter, not a second membership arm (P2 fix): the assigned-arm EXISTS above is the ONLY
  // positive existential this function is allowed to add rows through (lock `:414`). This clause
  // can only REMOVE rows the assigned arm already admitted — it cannot by itself make a row match —
  // so it is expressed as NOT EXISTS(a completed row of mine), not EXISTS(an open row of mine).
  const notCompletedByMe =
    `NOT EXISTS (SELECT 1 FROM task_assignees ta_done WHERE ta_done.task_id = tasks.id ` +
    `AND ta_done.user_id = ${ME_PLACEHOLDER} AND ta_done.completed_at IS NOT NULL)`
  let scopeClause = ''
  let params = base.params
  if (scope === 'overdue') {
    // Lock §4.4 rule 1 (scheduled) OR rule 3 (all-day), split per row on `due_time IS NULL`.
    scopeClause =
      ` AND ((tasks.due_time IS NOT NULL AND tasks.due_at < now()) OR ` +
      `(tasks.due_time IS NULL AND tasks.due_date < (now() AT TIME ZONE COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone))::date))`
    params = [...base.params, viewerTzParam ?? null]
  } else if (scope === 'overdue_or_today') {
    // Lock §4.4 rule 2 (scheduled) OR rule 3 (all-day), same per-row split.
    scopeClause =
      ` AND ((tasks.due_time IS NOT NULL AND tasks.due_at < (((now() AT TIME ZONE COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone))::date + 1)::timestamp AT TIME ZONE COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone))) OR ` +
      `(tasks.due_time IS NULL AND tasks.due_date <= (now() AT TIME ZONE COALESCE(${VIEWER_TZ_PLACEHOLDER}, tasks.time_zone))::date))`
    params = [...base.params, viewerTzParam ?? null]
  } else if (scope !== 'all_open') {
    throw new TypeError(`buildTaskPendingCondition: unknown scope "${String(scope)}"`)
  }
  const sql = `${base.sql} AND tasks.status = 'open' AND ${notCompletedByMe}${scopeClause}`
  return { sql, params }
}
