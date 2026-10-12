/**
 * M5 PR-4a slice 3: recurring tasks — `PUT /api/tasks/:id/recurrence` (set and clear the rule) and
 * the series reads that the spawn hook (`task-records.ts`), series delete (`task-structure.ts`) and
 * the detail use. Design: docs/development/task-m5-pr4a-backend-design-20261010.md §2.10, §3.2,
 * §3.8, §4.1, §4.7.
 *
 * This module writes no input of the pending predicate (no `tasks` insert or soft delete, no
 * `task_assignees` row): its one task write is the `recurrence` column. It is imported by the two
 * writer files, so it keeps PR-3c's rule that no statement error is swallowed (design §4.1, closing
 * part): no `catch`, no promise handler, no settling combinator.
 *
 * Series rows are selected only through `buildTaskByIdAnyStateCondition` (the first occurrence) and
 * `buildTaskSeriesMembersCondition` (the others), soft-deleted occurrences included: they keep the
 * `previous_occurrence_id` chain whole (design §4.7).
 */
import {
  buildTaskByIdAnyStateCondition,
  buildTaskByIdCondition,
  buildTaskSeriesMembersCondition,
  can,
} from '../tasks/task-access'
import {
  applyClearRecurrence,
  applySetRecurrence,
  parseRecurrenceRule,
  TaskRecurrenceSeriesCorruptError,
  type TaskRecurrenceRule,
} from '../tasks/task-recurrence'
import { isPrintableId } from './task-create'
import { enqueueTaskEventNotifications } from './task-notification-producer'
import {
  fail,
  loadRowRoles,
  loadTask,
  withOrgStructure,
  writeEvents,
  type Db,
  type Row,
} from './task-records'

/** One occurrence of a series as the series reads see it, live or soft-deleted. */
export interface TaskSeriesRow {
  id: string
  previousOccurrenceId: string | null
  parentId: string | null
  status: 'open' | 'done'
  deleted: boolean
  hasRecurrence: boolean
  createdBy: string
  dueDate: string | null
}

const SERIES_COLUMNS = `id, previous_occurrence_id, parent_id, status, deleted_at IS NOT NULL AS is_deleted,
       recurrence IS NOT NULL AS has_recurrence, created_by, due_date::text AS due_date`

function toSeriesRow(row: Row): TaskSeriesRow {
  return {
    id: String(row.id),
    previousOccurrenceId: row.previous_occurrence_id === null || row.previous_occurrence_id === undefined ? null : String(row.previous_occurrence_id),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    status: row.status === 'done' ? 'done' : 'open',
    deleted: row.is_deleted === true,
    hasRecurrence: row.has_recurrence === true,
    createdBy: String(row.created_by),
    dueDate: typeof row.due_date === 'string' ? row.due_date.slice(0, 10) : null,
  }
}

/**
 * Every occurrence of the series whose first occurrence is `firstId`, the first one included when it
 * exists in the org (live or soft-deleted), read on `db`. Unordered: `orderSeriesChain` orders it.
 */
export async function loadSeries(db: Db, orgId: string, firstId: string): Promise<TaskSeriesRow[]> {
  const first = buildTaskByIdAnyStateCondition({ taskIdParam: firstId, orgParam: orgId })
  const firstRows = await db.query(`SELECT ${SERIES_COLUMNS} FROM tasks WHERE ${first.sql}`, first.params)
  const others = buildTaskSeriesMembersCondition({ seriesIdParam: firstId, orgParam: orgId })
  const otherRows = await db.query(`SELECT ${SERIES_COLUMNS} FROM tasks WHERE ${others.sql}`, others.params)
  return [...firstRows.rows, ...otherRows.rows].map(toSeriesRow)
}

/**
 * The series along its `previous_occurrence_id` links, first occurrence first. A broken chain (two
 * heads, a fork, a loop, an occurrence off the chain) is data corruption: the same error task E's
 * `planSeriesDelete` raises for it, a 500 at the route.
 */
export function orderSeriesChain(members: readonly TaskSeriesRow[]): TaskSeriesRow[] {
  const ids = new Set(members.map((m) => m.id))
  if (ids.size !== members.length) throw new TaskRecurrenceSeriesCorruptError('series: duplicate member id')
  const heads = members.filter((m) => m.previousOccurrenceId === null || !ids.has(m.previousOccurrenceId))
  if (heads.length !== 1) throw new TaskRecurrenceSeriesCorruptError(`series: expected one first occurrence, found ${heads.length}`)
  const next = new Map<string, TaskSeriesRow>()
  for (const member of members) {
    if (member.previousOccurrenceId === null || !ids.has(member.previousOccurrenceId)) continue
    if (next.has(member.previousOccurrenceId)) throw new TaskRecurrenceSeriesCorruptError('series: two occurrences share one predecessor')
    next.set(member.previousOccurrenceId, member)
  }
  const ordered: TaskSeriesRow[] = [heads[0]]
  let cursor = next.get(heads[0].id)
  while (cursor !== undefined && ordered.length <= members.length) {
    ordered.push(cursor)
    cursor = next.get(cursor.id)
  }
  if (ordered.length !== members.length) throw new TaskRecurrenceSeriesCorruptError('series: some occurrences are not on the chain')
  return ordered
}

// ASSUMPTION(task-m5a): [a-16] the 1-based position of an occurrence is counted along the
// `previous_occurrence_id` chain, from it back to the first occurrence, both ends included; never from
// `created_at` (application clocks of different instances are not monotonic, design §2.10).
/** The 1-based position of `taskId` in its series (`members` must include the first occurrence). */
export function occurrenceOrdinal(members: readonly TaskSeriesRow[], taskId: string): number {
  const byId = new Map(members.map((m) => [m.id, m]))
  let cursor = byId.get(taskId)
  if (cursor === undefined) throw new TaskRecurrenceSeriesCorruptError('series: the occurrence is not in its series')
  let position = 1
  while (cursor.previousOccurrenceId !== null) {
    const previous = byId.get(cursor.previousOccurrenceId)
    if (previous === undefined) throw new TaskRecurrenceSeriesCorruptError('series: the chain is broken')
    position += 1
    if (position > members.length) throw new TaskRecurrenceSeriesCorruptError('series: the chain loops')
    cursor = previous
  }
  return position
}

// ASSUMPTION(task-m5a): [a-17] the successor of an occurrence is the occurrence whose
// `previous_occurrence_id` is it, not soft-deleted. The same reading answers "latest" for
// NOT_CURRENT_OCCURRENCE (design §3.2: no successor that is not soft-deleted).
/** The id of the live direct successor of `taskId` among `members`, or `null`. */
export function liveSuccessorId(members: readonly TaskSeriesRow[], taskId: string): string | null {
  const successor = members.find((m) => m.previousOccurrenceId === taskId && !m.deleted)
  return successor === undefined ? null : successor.id
}

/** The series columns of one live task, read on `db`; `null` when no live row matches. */
export interface TaskSeriesFacts {
  /** `recurrence_series_id`, or the task's own id when it is a first occurrence. */
  firstId: string
  /** Has a rule, is a later occurrence, or is the predecessor of any occurrence (soft-deleted ones too). */
  inSeries: boolean
}

/**
 * Whether a task belongs to a series, for `DELETE /api/tasks/:id` (design §3.8): it has a rule, or
 * `recurrence_series_id` is set, or it is some occurrence's `previous_occurrence_id`. A missing row is
 * `null`, and the caller keeps the M3 path (which answers the 404 after its row lock).
 */
export async function loadTaskSeriesFacts(db: Db, taskId: string, orgId: string): Promise<TaskSeriesFacts | null> {
  if (!isPrintableId(taskId)) return null
  const cond = buildTaskByIdCondition({ taskIdParam: taskId, orgParam: orgId })
  const result = await db.query(
    `SELECT recurrence IS NOT NULL AS has_recurrence, recurrence_series_id FROM tasks WHERE ${cond.sql}`,
    cond.params,
  )
  const row = result.rows[0]
  if (!row) return null
  const seriesId = row.recurrence_series_id === null || row.recurrence_series_id === undefined ? null : String(row.recurrence_series_id)
  if (row.has_recurrence === true || seriesId !== null) return { firstId: seriesId ?? taskId, inSeries: true }
  const successors = buildTaskSeriesMembersCondition({ seriesIdParam: taskId, orgParam: orgId })
  const later = await db.query(`SELECT id FROM tasks WHERE ${successors.sql} LIMIT 1`, successors.params)
  return { firstId: taskId, inSeries: later.rows.length > 0 }
}

/** A stored rule in the canonical key order of `parseRecurrenceRule` (jsonb reorders keys). */
export function canonicalRecurrence(stored: unknown): unknown {
  if (stored === null || stored === undefined) return null
  const parsed = parseRecurrenceRule(stored)
  return parsed.ok ? parsed.rule : stored
}

/** The body of `PUT /recurrence`: an object with a `recurrence` key; otherwise 422 INVALID_RECURRENCE. */
function recurrenceFromBody(body: unknown): unknown {
  // ASSUMPTION(task-m5a): [a-32] a missing `recurrence` key is not a clear: clearing is an explicit null.
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'recurrence')) {
    fail(422, 'INVALID_RECURRENCE')
  }
  return (body as { recurrence: unknown }).recurrence
}

export interface RecurrenceResponse {
  id: string
  recurrence: unknown
  seriesId: string | null
  previousOccurrenceId: string | null
}

/**
 * `PUT /api/tasks/:id/recurrence` (design §3.2). Under the structure lock, in this order: the task
 * (404), `can(roles, 'edit')` with list identity (404; RULED(2026-10-09): [S35]), the body (422
 * INVALID_RECURRENCE), then the pure transition: setting validates the rule before the due date
 * (422 INVALID_RECURRENCE, then DUE_REQUIRED); clearing a task without a rule is a no-op, and on an
 * occurrence that is not the series' latest still-open one is 422 NOT_CURRENT_OCCURRENCE
 * (RULED(2026-10-09): [S17] (a)). An equal rule or a clear without a rule writes nothing.
 * ASSUMPTION(task-m5a): [a-10] `tasks.version` does not move. The event and `updated_at` take one
 * `clock_timestamp()` read after the lock (design §4.4).
 */
export async function setTaskRecurrence(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<RecurrenceResponse> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { roles } = await loadRowRoles(db, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy })
    if (!can(roles, 'edit')) fail(404, 'NOT_FOUND')
    const requested = recurrenceFromBody(input.body)
    const clock = await db.query(`SELECT clock_timestamp() AS at`)
    const at = clock.rows[0]?.at instanceof Date ? clock.rows[0].at as Date : new Date(String(clock.rows[0]?.at))
    const respond = (recurrence: unknown): RecurrenceResponse => ({
      id: input.taskId,
      recurrence: canonicalRecurrence(recurrence),
      seriesId: task.seriesId,
      previousOccurrenceId: task.previousOccurrenceId,
    })
    if (requested === null) {
      const members = task.recurrence === null ? [] : await loadSeries(db, input.orgId, task.seriesId ?? input.taskId)
      const result = applyClearRecurrence({
        taskId: input.taskId,
        current: task.recurrence as TaskRecurrenceRule | null,
        isLatestOpenOccurrence: task.status === 'open' && liveSuccessorId(members, input.taskId) === null,
        actorId: input.actorId,
        now: at,
      })
      if (result.ok === false) fail(422, 'NOT_CURRENT_OCCURRENCE')
      if (result.noop) return respond(null)
      await db.query(`UPDATE tasks SET recurrence = NULL, updated_at = $2 WHERE id = $1`, [input.taskId, at])
      const written = await writeEvents(db, input.taskId, result.events, at)
      await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
      return respond(null)
    }
    const result = applySetRecurrence({
      taskId: input.taskId,
      current: task.recurrence as TaskRecurrenceRule | null,
      next: requested,
      dueDate: task.dueDate,
      actorId: input.actorId,
      now: at,
    })
    if (result.ok === false) fail(422, result.reason.toUpperCase())
    if (result.noop) return respond(result.recurrence)
    await db.query(
      `UPDATE tasks SET recurrence = $2::jsonb, updated_at = $3 WHERE id = $1`,
      [input.taskId, JSON.stringify(result.recurrence), at],
    )
    const written = await writeEvents(db, input.taskId, result.events, at)
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    return respond(result.recurrence)
  })
}
