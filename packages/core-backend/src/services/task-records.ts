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
import {
  applyComplete,
  applyReopen,
  type TaskAssigneeRow,
  type TaskCompletionMode,
  type TaskReopenScope,
} from '../tasks/task-completion'
import { resolveCreateAssigneeIds } from './task-create'
import { newTaskEventId, newTaskId } from './task-ids-runtime'

type Row = Record<string, unknown>

function fail(status: number, code: string): never {
  throw Object.assign(new Error(code), { status, code })
}

function asQuery(client: { query: TaskAdvisoryQuery }): TaskAdvisoryQuery {
  return (sql, params) => client.query(sql, params)
}

export async function createTask(input: {
  orgId: string
  creatorId: string
  title: unknown
  assignees: unknown
  completionMode?: unknown
}): Promise<{ id: string }> {
  if (typeof input.title !== 'string' || input.title.trim() === '') fail(422, 'INVALID_TITLE')
  const mode: TaskCompletionMode = input.completionMode === undefined ? 'all' : input.completionMode === 'any' ? 'any' : input.completionMode === 'all' ? 'all' : fail(422, 'INVALID_MODE')
  const assignees = resolveCreateAssigneeIds({ assignees: input.assignees, creatorId: input.creatorId })
  const id = newTaskId()
  await transaction(async (client) => {
    const q = asQuery(client)
    await acquireTaskStructureLock(q, input.orgId)
    await q(
      `INSERT INTO tasks (id, org_id, title, completion_mode, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, input.orgId, input.title, mode, input.creatorId],
    )
    for (const userId of assignees) {
      await q(
        `INSERT INTO task_assignees (task_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
        [id, userId, input.creatorId],
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

export async function listPending(input: { orgId: string; actorId: string; viewerTz: string | null }): Promise<Row[]> {
  const cond = buildTaskPendingCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    scope: 'all_open',
    viewerTzParam: input.viewerTz,
  })
  const result = await query<Row>(
    `SELECT id, title, status, due_at FROM tasks WHERE ${cond.sql} ORDER BY updated_at DESC LIMIT 100`,
    cond.params,
  )
  return result.rows
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

async function loadTask(id: string, orgId: string): Promise<{ createdBy: string; mode: TaskCompletionMode; status: string }> {
  const result = await query<Row>(
    `SELECT created_by, completion_mode, status FROM tasks WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [id, orgId],
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  return {
    createdBy: String(row.created_by),
    mode: row.completion_mode === 'any' ? 'any' : 'all',
    status: String(row.status),
  }
}

async function assertRowAbility(input: {
  taskId: string
  orgId: string
  actorId: string
  createdBy: string
  ability: TaskAbility
}): Promise<void> {
  const assignees = await loadAssignees(input.taskId)
  const followers = await query<Row>(
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

async function loadAssignees(taskId: string): Promise<TaskAssigneeRow[]> {
  const result = await query<Row>(
    `SELECT user_id, completed_at FROM task_assignees WHERE task_id = $1`,
    [taskId],
  )
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    completedAt: row.completed_at instanceof Date ? row.completed_at : row.completed_at ? new Date(String(row.completed_at)) : null,
  }))
}

export async function completeTask(input: { orgId: string; actorId: string; taskId: string }): Promise<{ done: boolean }> {
  const task = await loadTask(input.taskId, input.orgId)
  await assertRowAbility({ ...input, createdBy: task.createdBy, ability: 'complete' })
  const rows = await loadAssignees(input.taskId)
  const now = new Date()
  const next = applyComplete({ mode: task.mode, rows, actorId: input.actorId, createdBy: task.createdBy, now })
  await transaction(async (client) => {
    const q = asQuery(client)
    await acquireTaskStructureLock(q, input.orgId)
    for (const row of next.rows) {
      await q(
        `UPDATE task_assignees SET completed_at = $3 WHERE task_id = $1 AND user_id = $2`,
        [input.taskId, row.userId, row.completedAt],
      )
    }
    if (next.done) {
      await q(`UPDATE tasks SET status = 'done', completed_at = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [input.taskId, now])
    }
    for (const event of next.events) {
      await q(
        `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
        [newTaskEventId(), input.taskId, event.userId, event.type, event.occurredAt ?? now],
      )
    }
  })
  return { done: next.done }
}

export async function reopenTask(input: {
  orgId: string
  actorId: string
  taskId: string
  scope?: TaskReopenScope
}): Promise<{ ok: true }> {
  const task = await loadTask(input.taskId, input.orgId)
  await assertRowAbility({ ...input, createdBy: task.createdBy, ability: 'reopen' })
  const rows = await loadAssignees(input.taskId)
  const next = applyReopen({
    mode: task.mode,
    rows,
    actorId: input.actorId,
    createdBy: task.createdBy,
    scope: input.scope,
  })
  await transaction(async (client) => {
    const q = asQuery(client)
    await acquireTaskStructureLock(q, input.orgId)
    for (const row of next.rows) {
      await q(
        `UPDATE task_assignees SET completed_at = NULL WHERE task_id = $1 AND user_id = $2`,
        [input.taskId, row.userId],
      )
    }
    await q(`UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = now(), version = version + 1 WHERE id = $1`, [input.taskId])
    for (const event of next.events) {
      await q(
        `INSERT INTO task_events (id, task_id, actor_id, event_type) VALUES ($1, $2, $3, $4)`,
        [newTaskEventId(), input.taskId, event.userId, event.type],
      )
    }
  })
  return { ok: true }
}
