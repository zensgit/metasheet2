/**
 * `PATCH /api/tasks/:id` (M4 PR-3a, design §5.3). Rules come from `src/tasks/task-edit.ts`; this
 * module reads the rows under the org structure lock, calls the pure functions and writes.
 *
 * RULED(2026-10-07): [R03] required `expectedVersion`; a stale one is 409 VERSION_CONFLICT with
 * the current version. ASSUMPTION(task-m4): [own-04] the write takes the org structure lock.
 * [own-05] `version` moves only when a stored field changed.
 */
import { buildTaskByIdCondition, can } from '../tasks/task-access'
import { newTaskEventId } from './task-ids-runtime'
import {
  parseExpectedVersion,
  planTaskPatch,
  type TaskEditableState,
  type TaskPatchInput,
} from '../tasks/task-edit'
import { patchChangesPendingInputs } from '../tasks/task-realtime'
import { taskCountsSignal } from './task-counts-realtime'
import { isPrintableId } from './task-create'
import { assigneeIds, fail, isoOrNull, loadRowRoles, withOrgStructure, type Db, type Row } from './task-records'

export interface VersionConflictError extends Error {
  status: 409
  code: 'VERSION_CONFLICT'
  currentVersion: number
}

function versionConflict(currentVersion: number): never {
  throw Object.assign(new Error('VERSION_CONFLICT'), {
    status: 409 as const,
    code: 'VERSION_CONFLICT' as const,
    currentVersion,
  })
}

export function isVersionConflict(err: unknown): err is VersionConflictError {
  return typeof err === 'object'
    && err !== null
    && (err as { code?: unknown }).code === 'VERSION_CONFLICT'
    && Number.isSafeInteger((err as { currentVersion?: unknown }).currentVersion)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function toTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}:\d{2}:\d{2})/.exec(value)
  return match ? match[1] : null
}

function toCalendarDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

function toEditableState(row: Row): TaskEditableState {
  return {
    title: String(row.title),
    description: typeof row.description === 'string' ? row.description : null,
    dueDate: toCalendarDate(row.due_date),
    dueTime: toTime(row.due_time),
    startDate: toCalendarDate(row.start_date),
    startTime: toTime(row.start_time),
    timeZone: typeof row.time_zone === 'string' ? row.time_zone : null,
    dueAt: toDate(row.due_at),
    remindAt: toDate(row.remind_at),
  }
}

async function loadEditableRow(db: Db, taskId: string, orgId: string): Promise<Row> {
  // A non-printable id (U+0000 included) can match no row; 404 before SQL.
  if (!isPrintableId(taskId)) fail(404, 'NOT_FOUND')
  const cond = buildTaskByIdCondition({ taskIdParam: taskId, orgParam: orgId })
  const result = await db.query(
    `SELECT id, created_by, version, title, description,
            due_date::text AS due_date, due_time::text AS due_time,
            start_date::text AS start_date, start_time::text AS start_time,
            time_zone, due_at, remind_at
     FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  return row
}

/**
 * Order (design §5.3): lock → task by id (404) → roles incl. list identity, `edit` (404) →
 * `expectedVersion` (422) → stale version (409) → field plan (422) → no-op (200, nothing written) →
 * one guarded UPDATE and one event per changed surface.
 */
export async function patchTask(input: {
  orgId: string
  actorId: string
  taskId: string
  body: unknown
}): Promise<{ id: string; version: number }> {
  // RULED(2026-10-07): [R03] a body that is not a plain object is read as `{}` (so it lands on
  // INVALID_VERSION once the task is visible and editable); unknown keys are ignored.
  const body: Record<string, unknown> = isPlainObject(input.body) ? input.body : {}
  const counts = taskCountsSignal()
  const result = await withOrgStructure(input.orgId, async (db) => {
    const row = await loadEditableRow(db, input.taskId, input.orgId)
    const { roles, assignees } = await loadRowRoles(db, {
      taskId: input.taskId,
      actorId: input.actorId,
      createdBy: String(row.created_by),
    })
    if (!can(roles, 'edit')) fail(404, 'NOT_FOUND')
    const currentVersion = Number(row.version)
    const expected = parseExpectedVersion(body.expectedVersion)
    if (expected.ok === false) fail(422, 'INVALID_VERSION')
    // Compared in JS against the locked row, so a request value never reaches SQL.
    if (expected.version !== currentVersion) versionConflict(currentVersion)
    const patch: TaskPatchInput = {
      title: body.title,
      description: body.description,
      dueDate: body.dueDate,
      dueTime: body.dueTime,
      startDate: body.startDate,
      startTime: body.startTime,
      timeZone: body.timeZone,
      remindAt: body.remindAt,
    }
    const current = toEditableState(row)
    const plan = planTaskPatch(current, patch)
    if (plan.ok === false) fail(422, plan.reason.toUpperCase())
    if (!plan.changed) return { id: input.taskId, version: currentVersion }
    const next = plan.next
    // `updated_at` and the `occurred_at` of every event below are one `clock_timestamp()` reading
    // taken after the structure lock is held (`now()` is the transaction start, read before the
    // lock wait).
    const updated = await db.query(
      `UPDATE tasks AS t
       SET title = $3, description = $4, due_date = $5, due_time = $6, start_date = $7, start_time = $8,
           time_zone = $9, due_at = $10::timestamptz, remind_at = $11::timestamptz,
           updated_at = s.at, version = t.version + 1
       FROM (SELECT clock_timestamp() AS at) AS s
       WHERE t.id = $1 AND t.version = $2
       RETURNING t.version`,
      [
        input.taskId, currentVersion,
        next.title, next.description, next.dueDate, next.dueTime, next.startDate, next.startTime,
        next.timeZone, isoOrNull(next.dueAt), isoOrNull(next.remindAt),
      ],
    )
    if (updated.rows.length === 0) {
      // Not reachable under the structure lock; kept so a lost race still answers 409, not 500.
      const reread = await db.query(`SELECT version FROM tasks WHERE id = $1`, [input.taskId])
      const version = reread.rows[0] ? Number(reread.rows[0].version) : currentVersion
      versionConflict(version)
    }
    // Every event of one PATCH copies the row's `updated_at` (the value never leaves SQL).
    for (const eventType of plan.events) {
      await db.query(
        `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at)
         SELECT $1, $2, $3, $4, updated_at FROM tasks WHERE id = $2`,
        [newTaskEventId(), input.taskId, input.actorId, eventType],
      )
    }
    // RULED(2026-10-07): [R16] ASSUMPTION(task-m4): [own-3c-03] a stored due field or the time
    // zone changed: every assignee.
    if (patchChangesPendingInputs(current, next)) {
      counts.note({ before: assigneeIds(assignees), after: assigneeIds(assignees) })
    }
    return { id: input.taskId, version: Number(updated.rows[0].version) }
  })
  // RULED(2026-10-07): [R16] sent only once the transaction above committed.
  counts.publish()
  return result
}
