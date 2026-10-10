/**
 * P0-A task persistence. SQL text and completion transitions come from task B.
 * This module only executes them.
 */
import { query, transaction } from '../db/pg'
import { acquireTaskStructureLock, type TaskAdvisoryQuery } from '../db/task-advisory-locks'
import {
  buildTaskByIdCondition,
  buildTaskPendingCondition,
  buildTaskScopeCondition,
  can,
  canChangeCompletion,
  canChangeTaskMembers,
  resolveTaskRoles,
  TASK_VIEWS,
  type TaskAbility,
  type TaskListMembership,
  type TaskRole,
  type TaskView,
} from '../tasks/task-access'
import { computeDueAt } from '../tasks/task-dates'
import {
  needsDefaultRemindPolicy,
  parseRemindAtInput,
  planTaskDates,
  resolveCreateRemindAt,
  TASK_EMPTY_DATE_FIELDS,
} from '../tasks/task-edit'
import {
  applyComplete,
  applyReopen,
  computeTaskDone,
  type TaskAssigneeRow,
  type TaskCompletionEvent,
  type TaskCompletionMode,
  type TaskReopenScope,
} from '../tasks/task-completion'
import { normalizeUserText } from '../tasks/task-ids'
import { toTaskListMemberships, visibleTaskListIds, type TaskListMemberRole } from '../tasks/task-lists'
import { parsePageParams, TASK_PAGE_SORT_KEY, type TaskPageParams } from '../tasks/task-pagination'
import { pendingScopeForBadge } from '../tasks/task-settings'
import { isPrintableId, isStorableText, resolveCreateAssigneeIds } from './task-create'
import { newTaskEventId, newTaskId } from './task-ids-runtime'
import { enqueueTaskEventNotifications, type WrittenTaskEvent } from './task-notification-producer'
import { assertActiveOrgMembers } from './task-org-members'
import { loadBadgeScope, loadRemindPolicy } from './task-user-settings'

export type Row = Record<string, unknown>

export interface Db {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>
}

export function fail(status: number, code: string): never {
  throw Object.assign(new Error(code), { status, code })
}

function asQuery(client: { query: TaskAdvisoryQuery }): TaskAdvisoryQuery {
  return (sql, params) => client.query(sql, params)
}

/** Non-transactional `Db` for read paths that do not need the structure lock
 * (task-structure.ts's comment reads and parent-candidates). */
export const plainDb: Db = {
  query: async (sql, params) => {
    const result = await query<Row>(sql, params)
    return { rows: result.rows }
  },
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right
  return left.getTime() === right.getTime()
}

function changedAssigneeRows(before: TaskAssigneeRow[], after: TaskAssigneeRow[]): TaskAssigneeRow[] {
  const prior = new Map(before.map((row) => [row.userId, row.completedAt]))
  return after.filter((row) => !sameInstant(prior.get(row.userId) ?? null, row.completedAt))
}

// The structure lock is transaction-scoped. Reads of the task, the caller's
// row role, and assignee rows must happen after it is held, on this client.
export async function withOrgStructure<T>(orgId: string, run: (db: Db) => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    const db: Db = {
      query: async (sql, params) => {
        const result = await client.query(sql, params)
        return { rows: result.rows as Row[] }
      },
    }
    // First statement, so a REPEATABLE READ database default cannot freeze the snapshot.
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await acquireTaskStructureLock(asQuery(client), orgId)
    return run(db)
  })
}

export async function createTask(input: {
  orgId: string
  creatorId: string
  title: unknown
  assignees: unknown
  completionMode?: unknown
  dueDate?: unknown
  dueTime?: unknown
  startDate?: unknown
  startTime?: unknown
  timeZone?: unknown
  remindAt?: unknown
}): Promise<{ id: string; version: number }> {
  const title = normalizeUserText(input.title)
  // A title Postgres cannot store exactly as sent (U+0000, lone surrogate)
  // is the same 422 as a blank one (M3R3-IN-3, M3R3-IN-4).
  if (title === null || !isStorableText(title)) fail(422, 'INVALID_TITLE')
  const mode: TaskCompletionMode = input.completionMode === undefined ? 'all' : input.completionMode === 'any' ? 'any' : input.completionMode === 'all' ? 'all' : fail(422, 'INVALID_MODE')
  const assignees = resolveCreateAssigneeIds({ assignees: input.assignees, creatorId: input.creatorId })
  // RULED(2026-10-07): [R03] dates, zone and remindAt are validated before the transaction opens.
  const dates = planTaskDates(TASK_EMPTY_DATE_FIELDS, input)
  if (dates.ok === false) fail(422, dates.reason.toUpperCase())
  const remind = parseRemindAtInput(input.remindAt)
  if (remind.ok === false) fail(422, 'INVALID_REMIND_AT')
  const id = newTaskId()
  await transaction(async (client) => {
    const q = asQuery(client)
    const db: Db = { query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows as Row[] }) }
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await acquireTaskStructureLock(q, input.orgId)
    // RULED(2026-10-07): [R17] [N2] every assignee other than
    // the creator must be an active member of the org, the login test (task-org-members.ts); any
    // other id is 422 INACTIVE_ORG_MEMBER and nothing is written. Inside the transaction, after the
    // lock, before the first INSERT. ASSUMPTION(task-m4): [own-16] the creator is never looked up,
    // so a create that names only the creator, or nobody, sends no lookup (the helper sends nothing
    // for an empty list).
    await assertActiveOrgMembers(db, input.orgId, assignees.filter((userId) => userId !== input.creatorId))
    const policy = needsDefaultRemindPolicy({ remindAt: remind.remindAt, dueDate: dates.next.dueDate })
      ? await loadRemindPolicy(db, { orgId: input.orgId, actorId: input.creatorId })
      : null
    const remindAt = resolveCreateRemindAt({ remindAt: remind.remindAt, dates: dates.next, dueAt: dates.dueAt, policy })
    // The first five binds keep their M2 positions; the M4 columns follow.
    await q(
      `INSERT INTO tasks (id, org_id, title, completion_mode, created_by,
                          due_date, due_time, start_date, start_time, time_zone, due_at, remind_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz)`,
      [
        id, input.orgId, title, mode, input.creatorId,
        dates.next.dueDate, dates.next.dueTime, dates.next.startDate, dates.next.startTime, dates.next.timeZone,
        isoOrNull(dates.dueAt), isoOrNull(remindAt),
      ],
    )
    if (assignees.length > 0) {
      // One statement for every assignee row (M3R3-IN-2).
      await q(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by)
         SELECT $1, u.user_id, $3 FROM unnest($2::text[]) AS u(user_id)`,
        [id, assignees, input.creatorId],
      )
    }
    await q(
      `INSERT INTO task_events (id, task_id, actor_id, event_type) VALUES ($1, $2, $3, 'created')`,
      [newTaskEventId(), id, input.creatorId],
    )
  })
  // A new row starts at the column default, version 1.
  return { id, version: 1 }
}

/** Instants are bound as ISO-8601 UTC text so the driver never re-renders them in a local zone. */
export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}

// RULED(2026-10-07): [R15] list pagination. `limit` 1..100 (default 100, the former hard cap,
// so a caller that sends no page parameters gets the same rows as before), `offset` >= 0; any
// other form is 422 INVALID_LIMIT / INVALID_OFFSET, never clamped. Parsing is task D's
// `parsePageParams`; this wrapper only maps its reason to the HTTP code. The M3 comment list keeps
// its own parser and single INVALID_PAGE code; whether the two code sets merge is open (design
// §12-Q8), so they coexist.
export function parseTaskPage(input: { limit?: unknown; offset?: unknown }): TaskPageParams {
  const parsed = parsePageParams({ limit: input.limit, offset: input.offset })
  if (parsed.ok === false) fail(422, parsed.reason.toUpperCase())
  return parsed.params
}

function pageOrDefault(page: TaskPageParams | undefined): TaskPageParams {
  if (page) return page
  return parseTaskPage({})
}

/** `ORDER BY <stable key> LIMIT $n OFFSET $n+1`, numbered after the condition's own parameters. */
function pageClause(condParams: unknown[], page: TaskPageParams): { sql: string; params: unknown[] } {
  const n = condParams.length + 1
  return {
    sql: `ORDER BY ${TASK_PAGE_SORT_KEY} LIMIT $${n} OFFSET $${n + 1}`,
    params: [...condParams, page.limit, page.offset],
  }
}

function taskViewCondition(input: { orgId: string; actorId: string; view: string }) {
  if (!TASK_VIEWS.includes(input.view as TaskView)) fail(422, 'INVALID_VIEW')
  return buildTaskScopeCondition({
    view: input.view as TaskView,
    actorParam: input.actorId,
    orgParam: input.orgId,
  })
}

// ASSUMPTION(task-m4): [own-10] the list functions keep their array return; the routes pair each
// with the matching count function to build `{ items, total }`. RULED(2026-10-07): [R04] list
// identity never enters these view arms.
export async function listTasks(input: { orgId: string; actorId: string; view: string; page?: TaskPageParams }): Promise<Row[]> {
  const cond = taskViewCondition(input)
  const paged = pageClause(cond.params, pageOrDefault(input.page))
  const result = await query<Row>(
    `SELECT id, title, status, completion_mode, created_by, due_at FROM tasks WHERE ${cond.sql} ${paged.sql}`,
    paged.params,
  )
  return result.rows
}

/** Unpaged row count under the same view condition as `listTasks`. */
export async function countTasks(input: { orgId: string; actorId: string; view: string }): Promise<number> {
  const cond = taskViewCondition(input)
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  return Number(result.rows[0]?.n ?? 0)
}

function calendarDate(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  return null
}

function clockTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}:\d{2}(?::\d{2})?)/.exec(value)
  return match ? match[1] : null
}

export function toTaskPendingItem(row: Row): Record<string, string> {
  const id = String(row.id)
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at))
  const item: Record<string, string> = {
    source: 'task',
    id,
    title: String(row.title),
    href: `/tasks/${id}`,
    updatedAt: updatedAt.toISOString(),
  }
  const storedDue = row.due_at instanceof Date ? row.due_at : row.due_at ? new Date(String(row.due_at)) : null
  const dueDate = calendarDate(row.due_date)
  const dueAt = storedDue && !Number.isNaN(storedDue.getTime())
    ? storedDue
    : dueDate && typeof row.time_zone === 'string'
      ? computeDueAt({ dueDate, dueTime: clockTime(row.due_time), timeZone: row.time_zone })
      : null
  if (dueAt && !Number.isNaN(dueAt.getTime())) item.dueAt = dueAt.toISOString()
  return item
}

export async function listPending(input: {
  orgId: string
  actorId: string
  viewerTz: string | null
  page?: TaskPageParams
}): Promise<Record<string, string>[]> {
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope: 'all_open',
    viewerTzParam: input.viewerTz,
  })
  const paged = pageClause(cond.params, pageOrDefault(input.page))
  const result = await query<Row>(
    `SELECT id, title, updated_at, due_at, due_date::text AS due_date, due_time::text AS due_time, time_zone FROM tasks WHERE ${cond.sql} ${paged.sql}`,
    paged.params,
  )
  return result.rows.map(toTaskPendingItem)
}

/** Unpaged row count of `/pending` (always the `all_open` scope; never reads the badge setting). */
export async function countPendingList(input: { orgId: string; actorId: string }): Promise<number> {
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope: 'all_open',
    viewerTzParam: null,
  })
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  return Number(result.rows[0]?.n ?? 0)
}

export async function getTask(input: { orgId: string; actorId: string; taskId: string }): Promise<Row> {
  // A non-printable id (U+0000 included) can match no row; 404 before SQL.
  if (!isPrintableId(input.taskId)) fail(404, 'NOT_FOUND')
  // RULED(2026-10-07): [R04] fetch by id, then decide visibility from the role set (list
  // identity included); a row the caller cannot view is the same 404 as a missing row.
  const cond = buildTaskByIdCondition({ taskIdParam: input.taskId, orgParam: input.orgId })
  const result = await query<Row>(
    `SELECT id, title, status, completion_mode, created_by, due_at, parent_id, depth, version,
            due_date::text AS due_date, due_time::text AS due_time, time_zone,
            description, start_date::text AS start_date, start_time::text AS start_time, remind_at
     FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  const assigneeResult = await query<Row>(
    `SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1`,
    [input.taskId],
  )
  const assignees = assigneeResult.rows.map((entry) => ({
    userId: String(entry.user_id),
    completedAt: entry.completed_at instanceof Date
      ? entry.completed_at
      : entry.completed_at
        ? new Date(String(entry.completed_at))
        : null,
  }))
  const followers = await query<Row>(
    `SELECT user_id FROM task_followers WHERE task_id = $1 ORDER BY user_id`,
    [input.taskId],
  )
  const followerIds = followers.rows.map((entry) => String(entry.user_id))
  const memberships = await loadActorListMemberships(plainDb, [input.taskId], input.actorId)
  const roleRow = {
    createdBy: String(row.created_by),
    assigneeIds: assignees.map((entry) => entry.userId),
    followerIds,
  }
  const roles = resolveTaskRoles(roleRow, input.actorId, memberships.get(input.taskId) ?? [])
  if (!can(roles, 'view')) fail(404, 'NOT_FOUND')
  const dueAt = row.due_at instanceof Date
    ? row.due_at
    : row.due_at
      ? new Date(String(row.due_at))
      : null
  const children = await loadVisibleChildren(input.orgId, input.taskId, input.actorId)
  const remindAt = row.remind_at instanceof Date
    ? row.remind_at
    : row.remind_at
      ? new Date(String(row.remind_at))
      : null
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    completionMode: String(row.completion_mode),
    createdBy: String(row.created_by),
    dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt.toISOString() : null,
    dueDate: calendarDate(row.due_date),
    dueTime: clockTime(row.due_time),
    timeZone: typeof row.time_zone === 'string' ? row.time_zone : null,
    assignees: assignees.map((entry) => ({
      userId: entry.userId,
      completedAt: entry.completedAt ? entry.completedAt.toISOString() : null,
    })),
    canComplete: canChangeCompletion(roles, 'complete', assignees.length),
    canReopen: canChangeCompletion(roles, 'reopen', assignees.length),
    followers: followerIds,
    canEdit: can(roles, 'edit'),
    // RULED(2026-10-07): [own-53]: the predicate of the four assignee / follower
    // writes, over the direct roles only.
    canManageMembers: canChangeTaskMembers({ task: roleRow, me: input.actorId }),
    canDelete: can(roles, 'delete'),
    canComment: can(roles, 'comment'),
    canLeave: can(roles, 'leave'),
    version: Number(row.version),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    depth: Number(row.depth),
    children,
    // RULED(2026-10-07): [R03] detail fields added in PR-3a, assembled after the view check.
    description: typeof row.description === 'string' ? row.description : null,
    startDate: calendarDate(row.start_date),
    startTime: clockTime(row.start_time),
    remindAt: remindAt && !Number.isNaN(remindAt.getTime()) ? remindAt.toISOString() : null,
    // RULED(2026-10-07): [own-25] (a2); ASSUMPTION(task-m4): [own-46] list ids, assembled after the
    // view check: every list holding the task for its creator, the caller's own lists for anyone
    // else.
    listIds: visibleTaskListIds({
      isTaskCreator: roles.includes('creator'),
      taskListIds: await loadTaskListIds(plainDb, input.taskId),
      memberListIds: (memberships.get(input.taskId) ?? []).map((membership) => membership.listId),
    }),
  }
}

/**
 * Direct, undeleted, same-org children of `taskId`, each filtered by
 * `can(resolveTaskRoles(...), 'view')` for `actorId`. Invisible children are
 * omitted, never turn the parent into a 404 (contract §3.2). Ordered by id
 * byte order (`COLLATE "C"`, matching the pure `parentCandidates`' sort).
 */
async function loadVisibleChildren(orgId: string, taskId: string, actorId: string): Promise<Row[]> {
  const rows = await query<Row>(
    `SELECT id, title, status, completion_mode, depth, created_by
     FROM tasks WHERE parent_id = $1 AND org_id = $2 AND deleted_at IS NULL
     ORDER BY id COLLATE "C"`,
    [taskId, orgId],
  )
  if (rows.rows.length === 0) return []
  const ids = rows.rows.map((row) => String(row.id))
  const [assigneeRows, followerRows, membershipsByTask] = await Promise.all([
    query<Row>(`SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)`, [ids]),
    query<Row>(`SELECT task_id, user_id FROM task_followers WHERE task_id = ANY($1)`, [ids]),
    loadActorListMemberships(plainDb, ids, actorId),
  ])
  const assigneesByTask = groupUserIdsByTask(assigneeRows.rows)
  const followersByTask = groupUserIdsByTask(followerRows.rows)
  const visible: Row[] = []
  for (const row of rows.rows) {
    const id = String(row.id)
    const roles = resolveTaskRoles({
      createdBy: String(row.created_by),
      assigneeIds: assigneesByTask.get(id) ?? [],
      followerIds: followersByTask.get(id) ?? [],
    }, actorId, membershipsByTask.get(id) ?? [])
    if (!can(roles, 'view')) continue
    visible.push({
      id,
      title: String(row.title),
      status: String(row.status),
      completionMode: String(row.completion_mode),
      depth: Number(row.depth),
    })
  }
  return visible
}

/**
 * The acting user's list identities on each of `taskIds`: one row per (task, list) where the task
 * is an item of the list and the user is a member of it. RULED(2026-10-07): [R04] archived lists
 * still count (archiving does not change visibility). A list grants a role on a task only when the
 * list row's org_id equals the task row's org_id; the comparison is made here, on the two rows, for
 * every caller (ASSUMPTION(task-m4): [own-37] enforces the same equality on the item rows
 * themselves). The caller's org
 * is applied where the task ids are selected (the org predicate of `task-access.ts`).
 */
export async function loadActorListMemberships(
  db: Db,
  taskIds: string[],
  actorId: string,
): Promise<Map<string, TaskListMembership[]>> {
  const byTask = new Map<string, TaskListMembership[]>()
  if (taskIds.length === 0) return byTask
  const result = await db.query(
    `SELECT tli.task_id, tlm.list_id, tlm.role
     FROM task_list_items tli
     JOIN tasks t ON t.id = tli.task_id
     JOIN task_lists tl ON tl.id = tli.list_id AND tl.org_id = t.org_id
     JOIN task_list_members tlm ON tlm.list_id = tli.list_id AND tlm.user_id = $2
     WHERE tli.task_id = ANY($1)`,
    [taskIds, actorId],
  )
  const rowsByTask = new Map<string, Array<{ listId: string; role: TaskListMemberRole }>>()
  for (const row of result.rows) {
    const taskId = String(row.task_id)
    const entry = { listId: String(row.list_id), role: String(row.role) as TaskListMemberRole }
    const list = rowsByTask.get(taskId)
    if (list) list.push(entry)
    else rowsByTask.set(taskId, [entry])
  }
  for (const [taskId, rows] of rowsByTask) byTask.set(taskId, toTaskListMemberships(rows))
  return byTask
}

/**
 * Every list holding `taskId`, read on `db`. A list counts only when its org is the task row's org,
 * compared on the two rows as in `loadActorListMemberships` ([own-37]: the composite foreign keys
 * already refuse an item whose list and task are in different orgs; this covers rows written past
 * them). Archived lists count. Unordered.
 */
export async function loadTaskListIds(db: Db, taskId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT tli.list_id
       FROM task_list_items tli
       JOIN tasks item_task ON item_task.id = tli.task_id
       JOIN task_lists holding_list ON holding_list.id = tli.list_id
        AND holding_list.org_id = item_task.org_id
      WHERE tli.task_id = $1`,
    [taskId],
  )
  return result.rows.map((row) => String(row.list_id))
}

export function groupUserIdsByTask(rows: Row[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const taskId = String(row.task_id)
    const userId = String(row.user_id)
    const list = map.get(taskId)
    if (list) list.push(userId)
    else map.set(taskId, [userId])
  }
  return map
}

// RULED(2026-10-07): [R02] the badge count follows the caller's own `badge_scope` (no row:
// 'overdue'). ASSUMPTION(task-m4): [D5] [own-11] 'off' returns `null` before any query touches
// `tasks`; the route turns that into `{ count: 0, badgeScope: 'off' }`.
export async function countPending(input: { orgId: string; actorId: string; viewerTz: string | null }): Promise<number | null> {
  const scope = pendingScopeForBadge(await loadBadgeScope({ orgId: input.orgId, actorId: input.actorId }))
  if (scope === null) return null
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope,
    viewerTzParam: input.viewerTz,
  })
  const result = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  return Number(result.rows[0]?.n ?? 0)
}

export interface LoadedTask {
  createdBy: string
  mode: TaskCompletionMode
  status: string
  parentId: string | null
  depth: number
  version: number
}

export async function loadTask(db: Db, id: string, orgId: string): Promise<LoadedTask> {
  // A non-printable id (U+0000 included) can match no row; 404 before SQL,
  // so the driver never sees a value Postgres rejects as text.
  if (!isPrintableId(id)) fail(404, 'NOT_FOUND')
  const cond = buildTaskByIdCondition({ taskIdParam: id, orgParam: orgId })
  const result = await db.query(
    `SELECT created_by, completion_mode, status, parent_id, depth, version FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  return {
    createdBy: String(row.created_by),
    mode: row.completion_mode === 'any' ? 'any' : 'all',
    status: String(row.status),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    depth: Number(row.depth),
    version: Number(row.version),
  }
}

/**
 * The acting user's role set on one task (creator / assignee / follower / list roles), plus the
 * assignee rows it was resolved from, read on `db` (under the structure lock when `db` is the
 * locked client).
 */
export async function loadRowRoles(db: Db, input: {
  taskId: string
  actorId: string
  createdBy: string
}): Promise<{ roles: TaskRole[]; assignees: TaskAssigneeRow[] }> {
  const assignees = await loadAssignees(db, input.taskId)
  const followers = await db.query(
    `SELECT user_id FROM task_followers WHERE task_id = $1`,
    [input.taskId],
  )
  const memberships = await loadActorListMemberships(db, [input.taskId], input.actorId)
  const roles = resolveTaskRoles({
    createdBy: input.createdBy,
    assigneeIds: assignees.map((row) => row.userId),
    followerIds: followers.rows.map((row) => String(row.user_id)),
  }, input.actorId, memberships.get(input.taskId) ?? [])
  return { roles, assignees }
}

/**
 * 404 unless the acting user's role set grants `ability`. `complete` / `reopen` are not decided
 * here: those two go through `canChangeCompletion` in `completeTask` / `reopenTask`, which also
 * needs the assignee count, so there is one predicate for them, not two.
 */
export async function assertRowAbility(db: Db, input: {
  taskId: string
  actorId: string
  createdBy: string
  ability: TaskAbility
}): Promise<void> {
  if (input.ability === 'complete' || input.ability === 'reopen') {
    throw new TypeError(`assertRowAbility: ${input.ability} is decided by canChangeCompletion`)
  }
  const { roles } = await loadRowRoles(db, input)
  if (!can(roles, input.ability)) fail(404, 'NOT_FOUND')
}

export async function loadAssignees(db: Db, taskId: string): Promise<TaskAssigneeRow[]> {
  const result = await db.query(
    `SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1`,
    [taskId],
  )
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    completedAt: row.completed_at instanceof Date ? row.completed_at : row.completed_at ? new Date(String(row.completed_at)) : null,
  }))
}

export async function writeChangedAssignees(db: Db, taskId: string, before: TaskAssigneeRow[], after: TaskAssigneeRow[]): Promise<void> {
  for (const row of changedAssigneeRows(before, after)) {
    await db.query(
      `UPDATE task_assignees SET completed_at = $3 WHERE task_id = $1 AND user_id = $2`,
      [taskId, row.userId, row.completedAt],
    )
  }
}

export async function writeTaskDoneState(db: Db, taskId: string, done: boolean, now: Date): Promise<void> {
  if (done) {
    await db.query(
      `UPDATE tasks SET status = 'done', completed_at = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
      [taskId, now],
    )
    return
  }
  await db.query(
    `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = now(), version = version + 1 WHERE id = $1`,
    [taskId],
  )
}

/**
 * Writes `events` and returns them as written, ids included (ASSUMPTION(task-m4): [own-3b-12]: the
 * notification producer reads the event ids, so each id is generated before its INSERT).
 */
export async function writeEvents(db: Db, taskId: string, events: TaskCompletionEvent[], fallbackAt: Date): Promise<WrittenTaskEvent[]> {
  const written: WrittenTaskEvent[] = []
  for (const event of events) {
    const id = newTaskEventId()
    const occurredAt = event.occurredAt ?? fallbackAt
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
      [id, taskId, event.userId, event.type, occurredAt],
    )
    written.push({ id, type: event.type, actorId: event.userId, occurredAt })
  }
  return written
}

// RULED(2026-10-07): [R03] complete / reopen answer with `version`: the value read under the
// lock, plus one when this call flipped the task's status (the only write that bumps it here).
export async function completeTask(input: { orgId: string; actorId: string; taskId: string }): Promise<{ done: boolean; version: number }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { roles, assignees: rows } = await loadRowRoles(db, { ...input, createdBy: task.createdBy })
    // Lock §6.2: zero-assignee tasks are completed by the creator only. Refused here as the same
    // 404 as any other missing ability, before `applyComplete` (which throws for that case).
    if (!canChangeCompletion(roles, 'complete', rows.length)) fail(404, 'NOT_FOUND')
    const now = new Date()
    const next = applyComplete({
      mode: task.mode,
      rows,
      actorId: input.actorId,
      createdBy: task.createdBy,
      now,
      wasDone: task.status === 'done',
    })
    await writeChangedAssignees(db, input.taskId, rows, next.rows)
    const flipped = (task.status === 'done') !== next.done
    if (flipped) await writeTaskDoneState(db, input.taskId, next.done, now)
    const written = await writeEvents(db, input.taskId, next.events, now)
    // M4 PR-3b: outbox rows for the events that notify, in this transaction.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    return { done: next.done, version: flipped ? task.version + 1 : task.version }
  })
}

export async function reopenTask(input: {
  orgId: string
  actorId: string
  taskId: string
  scope?: TaskReopenScope
}): Promise<{ ok: true; version: number }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { roles, assignees: rows } = await loadRowRoles(db, { ...input, createdBy: task.createdBy })
    // Lock §6.2, same as `completeTask`.
    if (!canChangeCompletion(roles, 'reopen', rows.length)) fail(404, 'NOT_FOUND')
    const now = new Date()
    const next = applyReopen({
      mode: task.mode,
      rows,
      actorId: input.actorId,
      createdBy: task.createdBy,
      scope: input.scope,
      wasDone: task.status === 'done',
    })
    const done = computeTaskDone({ mode: task.mode, assigneeRows: next.rows })
    await writeChangedAssignees(db, input.taskId, rows, next.rows)
    const flipped = (task.status === 'done') !== done
    if (flipped) await writeTaskDoneState(db, input.taskId, done, now)
    const written = await writeEvents(db, input.taskId, next.events, now)
    // M4 PR-3b: outbox rows for the events that notify, in this transaction.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    return { ok: true, version: flipped ? task.version + 1 : task.version }
  })
}
