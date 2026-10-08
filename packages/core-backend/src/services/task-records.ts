/**
 * P0-A task persistence. SQL text and completion transitions come from task B.
 * This module only executes them.
 */
import { query, transaction } from '../db/pg'
import { acquireTaskStructureLock, type TaskAdvisoryQuery } from '../db/task-advisory-locks'
import {
  buildTaskPendingCondition,
  buildTaskScopeCondition,
  can,
  resolveTaskRoles,
  TASK_VIEWS,
  type TaskAbility,
  type TaskView,
} from '../tasks/task-access'
import { computeDueAt } from '../tasks/task-dates'
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
import { isPrintableId, isStorableText, resolveCreateAssigneeIds } from './task-create'
import { newTaskEventId, newTaskId } from './task-ids-runtime'

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
}): Promise<{ id: string }> {
  const title = normalizeUserText(input.title)
  // A title Postgres cannot store exactly as sent (U+0000, lone surrogate)
  // is the same 422 as a blank one (M3R3-IN-3, M3R3-IN-4).
  if (title === null || !isStorableText(title)) fail(422, 'INVALID_TITLE')
  const mode: TaskCompletionMode = input.completionMode === undefined ? 'all' : input.completionMode === 'any' ? 'any' : input.completionMode === 'all' ? 'all' : fail(422, 'INVALID_MODE')
  const assignees = resolveCreateAssigneeIds({ assignees: input.assignees, creatorId: input.creatorId })
  const id = newTaskId()
  await transaction(async (client) => {
    const q = asQuery(client)
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await acquireTaskStructureLock(q, input.orgId)
    await q(
      `INSERT INTO tasks (id, org_id, title, completion_mode, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.orgId, title, mode, input.creatorId],
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
  return { id }
}

export async function listTasks(input: { orgId: string; actorId: string; view: string }): Promise<Row[]> {
  if (!TASK_VIEWS.includes(input.view as TaskView)) fail(422, 'INVALID_VIEW')
  const cond = buildTaskScopeCondition({
    view: input.view as TaskView,
    actorParam: input.actorId,
    orgParam: input.orgId,
  })
  const result = await query<Row>(
    `SELECT id, title, status, completion_mode, created_by, due_at FROM tasks WHERE ${cond.sql} ORDER BY updated_at DESC LIMIT 100`,
    cond.params,
  )
  return result.rows
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

export async function listPending(input: { orgId: string; actorId: string; viewerTz: string | null }): Promise<Record<string, string>[]> {
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope: 'all_open',
    viewerTzParam: input.viewerTz,
  })
  const result = await query<Row>(
    `SELECT id, title, updated_at, due_at, due_date::text AS due_date, due_time::text AS due_time, time_zone FROM tasks WHERE ${cond.sql} ORDER BY updated_at DESC LIMIT 100`,
    cond.params,
  )
  return result.rows.map(toTaskPendingItem)
}

export async function getTask(input: { orgId: string; actorId: string; taskId: string }): Promise<Row> {
  // A non-printable id (U+0000 included) can match no row; 404 before SQL.
  if (!isPrintableId(input.taskId)) fail(404, 'NOT_FOUND')
  const cond = buildTaskScopeCondition({
    view: 'any_role',
    actorParam: input.actorId,
    orgParam: input.orgId,
  })
  const result = await query<Row>(
    `SELECT id, title, status, completion_mode, created_by, due_at, parent_id, depth, version,
            due_date::text AS due_date, due_time::text AS due_time, time_zone
     FROM tasks WHERE tasks.id = $3 AND ${cond.sql}`,
    [...cond.params, input.taskId],
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
  const roles = resolveTaskRoles({
    createdBy: String(row.created_by),
    assigneeIds: assignees.map((entry) => entry.userId),
    followerIds,
  }, input.actorId)
  const dueAt = row.due_at instanceof Date
    ? row.due_at
    : row.due_at
      ? new Date(String(row.due_at))
      : null
  const children = await loadVisibleChildren(input.orgId, input.taskId, input.actorId)
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
    canComplete: can(roles, 'complete'),
    canReopen: can(roles, 'reopen'),
    followers: followerIds,
    canEdit: can(roles, 'edit'),
    canDelete: can(roles, 'delete'),
    canComment: can(roles, 'comment'),
    canLeave: can(roles, 'leave'),
    version: Number(row.version),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    depth: Number(row.depth),
    children,
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
  const [assigneeRows, followerRows] = await Promise.all([
    query<Row>(`SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)`, [ids]),
    query<Row>(`SELECT task_id, user_id FROM task_followers WHERE task_id = ANY($1)`, [ids]),
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
    }, actorId)
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

export async function countPending(input: { orgId: string; actorId: string; viewerTz: string | null }): Promise<number> {
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope: 'overdue',
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
  const result = await db.query(
    `SELECT created_by, completion_mode, status, parent_id, depth, version FROM tasks WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [id, orgId],
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

export async function assertRowAbility(db: Db, input: {
  taskId: string
  actorId: string
  createdBy: string
  ability: TaskAbility
}): Promise<void> {
  const assignees = await loadAssignees(db, input.taskId)
  const followers = await db.query(
    `SELECT user_id FROM task_followers WHERE task_id = $1`,
    [input.taskId],
  )
  const roles = resolveTaskRoles({
    createdBy: input.createdBy,
    assigneeIds: assignees.map((row) => row.userId),
    followerIds: followers.rows.map((row) => String(row.user_id)),
  }, input.actorId)
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

export async function writeEvents(db: Db, taskId: string, events: TaskCompletionEvent[], fallbackAt: Date): Promise<void> {
  for (const event of events) {
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
      [newTaskEventId(), taskId, event.userId, event.type, event.occurredAt ?? fallbackAt],
    )
  }
}

export async function completeTask(input: { orgId: string; actorId: string; taskId: string }): Promise<{ done: boolean }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    await assertRowAbility(db, { ...input, createdBy: task.createdBy, ability: 'complete' })
    const rows = await loadAssignees(db, input.taskId)
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
    if ((task.status === 'done') !== next.done) await writeTaskDoneState(db, input.taskId, next.done, now)
    await writeEvents(db, input.taskId, next.events, now)
    return { done: next.done }
  })
}

export async function reopenTask(input: {
  orgId: string
  actorId: string
  taskId: string
  scope?: TaskReopenScope
}): Promise<{ ok: true }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    await assertRowAbility(db, { ...input, createdBy: task.createdBy, ability: 'reopen' })
    const rows = await loadAssignees(db, input.taskId)
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
    if ((task.status === 'done') !== done) await writeTaskDoneState(db, input.taskId, done, now)
    await writeEvents(db, input.taskId, next.events, now)
    return { ok: true }
  })
}
