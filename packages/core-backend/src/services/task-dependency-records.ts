/**
 * M5 PR-4a slice 4: the milestone flag and task dependencies. Design:
 * docs/development/task-m5-pr4a-backend-design-20261010.md §3.3, §3.4, §3.8 (the detail's
 * `isMilestone` and `dependencies`), §4.1, §4.2, §4.4, §4.7.
 *
 * Writes (`PATCH /milestone`, adding and removing an edge) run inside `withOrgStructure`: the
 * structure lock through the lock-order wrapper (rank 1), then every row the write depends on is read
 * again on the locked client, then the pure functions of task E decide (lock §6.4, E07: a dependency
 * change is a structure change; the whole graph is read again under the lock before the cycle
 * check). Reads take no lock.
 *
 * This module writes no input of the pending predicate (no `tasks` insert or soft delete, no
 * `task_assignees` row): its task writes are `is_milestone` and, with it, `updated_at`; the rest are
 * `task_dependencies` rows and events. `task-records.ts` imports it for the detail, so it keeps
 * PR-3c's rule that no statement error is swallowed (design §4.1, closing part): no `catch`, no
 * promise handler, no settling combinator.
 *
 * Edges are selected only through `buildOrgDependencyEdgesCondition`, candidate tasks only through
 * `buildDependencyCandidateTasksCondition`, single tasks only through `buildTaskByIdCondition`;
 * counterpart rows are joined from edges those builders selected (design §4.7). No org condition is
 * written here.
 */
import {
  buildDependencyCandidateTasksCondition,
  buildOrgDependencyEdgesCondition,
  buildTaskByIdCondition,
  can,
  resolveTaskRoles,
  type TaskRole,
} from '../tasks/task-access'
import {
  applyAddDependency,
  applyRemoveDependency,
  canManageDependency,
  dependencyCandidates,
  type TaskDependencyDirection,
  type TaskDependencyEdge,
  type TaskDependencyEvent,
} from '../tasks/task-dependencies'
import { isValidTaskDomainId } from '../tasks/task-ids'
import { applySetMilestone, parseMilestoneFlag } from '../tasks/task-milestone'
import { TASK_PAGE_SORT_KEY } from '../tasks/task-pagination'
import { isPrintableId } from './task-create'
import { enqueueTaskEventNotifications } from './task-notification-producer'
import {
  fail,
  groupUserIdsByTask,
  loadActorListMemberships,
  loadRowRoles,
  parseTaskPage,
  plainDb,
  withOrgStructure,
  writeEvents,
  type Db,
  type Row,
} from './task-records'

/** One task as the milestone and dependency paths read it, selected by id through the org builder. */
interface DependencyEndRow {
  id: string
  orgId: string
  createdBy: string
  isMilestone: boolean
}

/** The live task `taskId` of `orgId`, read on `db`; 404 when there is none (or the id is not printable). */
async function loadEnd(db: Db, taskId: string, orgId: string): Promise<DependencyEndRow> {
  if (!isPrintableId(taskId)) fail(404, 'NOT_FOUND')
  const cond = buildTaskByIdCondition({ taskIdParam: taskId, orgParam: orgId })
  const result = await db.query(`SELECT id, org_id, created_by, is_milestone FROM tasks WHERE ${cond.sql}`, cond.params)
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    createdBy: String(row.created_by),
    isMilestone: row.is_milestone === true,
  }
}

/** The acting user's full role set on `end` (list identity included), read on `db`. */
async function rolesOn(db: Db, end: DependencyEndRow, actorId: string): Promise<TaskRole[]> {
  const { roles } = await loadRowRoles(db, { taskId: end.id, actorId, createdBy: end.createdBy })
  return roles
}

/** One `clock_timestamp()` read on `db`, after the lock (design §4.4). */
async function lockClock(db: Db): Promise<Date> {
  const clock = await db.query(`SELECT clock_timestamp() AS at`)
  const at = clock.rows[0]?.at
  return at instanceof Date ? at : new Date(String(at))
}

// ---------------------------------------------------------------------------------------------
// §3.3 PATCH /api/tasks/:id/milestone
// ---------------------------------------------------------------------------------------------

/**
 * `PATCH /api/tasks/:id/milestone` `{ isMilestone: boolean }` (design §3.3). Under the structure lock,
 * in this order: the task (404), `can(roles, 'edit')` with list identity (404; RULED(2026-10-09):
 * [S13]), the body (422 INVALID_MILESTONE: only a real boolean), then `applySetMilestone`: the same
 * value is a no-op that writes nothing; otherwise the column and one `milestone_set` /
 * `milestone_cleared` event. No due date is required ([S13]). ASSUMPTION(task-m5a): [a-10]
 * `tasks.version` does not move. The event takes one `clock_timestamp()` read after the lock (design
 * §4.4). ASSUMPTION(task-m5a): the same reading is also written to `updated_at`, as the recurrence
 * write does (the open owner question of the slice 3 record, §9 item 2, covers both).
 */
export async function setTaskMilestone(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<{ id: string; isMilestone: boolean }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadEnd(db, input.taskId, input.orgId)
    if (!can(await rolesOn(db, task, input.actorId), 'edit')) fail(404, 'NOT_FOUND')
    const raw = typeof input.body === 'object' && input.body !== null && !Array.isArray(input.body)
      ? (input.body as { isMilestone?: unknown }).isMilestone
      : undefined
    const parsed = parseMilestoneFlag(raw)
    if (parsed.ok === false) fail(422, 'INVALID_MILESTONE')
    const at = await lockClock(db)
    const result = applySetMilestone({ current: task.isMilestone, next: parsed.value, actorId: input.actorId, now: at })
    if (result.noop) return { id: task.id, isMilestone: result.isMilestone }
    await db.query(`UPDATE tasks SET is_milestone = $2, updated_at = $3 WHERE id = $1`, [task.id, result.isMilestone, at])
    const written = await writeEvents(db, task.id, result.events, at)
    // M4 PR-3b: the same-transaction enqueue of every event write; neither milestone word is in the
    // notifiable set, so the producer writes no row for them.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: task.id, createdBy: task.createdBy, events: written })
    return { id: task.id, isMilestone: result.isMilestone }
  })
}

// ---------------------------------------------------------------------------------------------
// §3.4 dependencies
// ---------------------------------------------------------------------------------------------

/** `DepItem` (design §3.4): one visible counterpart of a dependency edge. */
export interface DepItem {
  id: string
  title: string
  status: string
  dueAt: string | null
  isMilestone: boolean
  canRemove: boolean
}

export interface DependencyLists {
  predecessors: DepItem[]
  successors: DepItem[]
}

/** Every live edge of the org (both ends live), read on `db`. */
async function loadOrgEdges(db: Db, orgId: string): Promise<TaskDependencyEdge[]> {
  const cond = buildOrgDependencyEdgesCondition({ taskIdParam: null, orgParam: orgId })
  const result = await db.query(
    `SELECT task_dependencies.predecessor_id, task_dependencies.successor_id FROM task_dependencies WHERE ${cond.sql}`,
    cond.params,
  )
  return result.rows.map((row) => ({ predecessorId: String(row.predecessor_id), successorId: String(row.successor_id) }))
}

function dueAtIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * The two `DepItem` lists of `taskId` for `actorId`, whose role set on `taskId` is `selfRoles`, read
 * on `db` (design §3.4, §3.8). Only counterparts the caller can view are listed; one it cannot view
 * is neither listed nor counted (ASSUMPTION(task-m5a): [a-28]). `canRemove` is `canManageDependency`
 * over the two full role sets, the predicate of the remove routes (ASSUMPTION(task-m5a): [a-12]).
 * Each list is ordered by the edge's `created_at`, then the counterpart id in byte order ([a-34]).
 * D18 (ASSUMPTION): at most 50 edges per task, so neither list is paged.
 */
export async function loadDependencyItems(db: Db, input: {
  orgId: string
  taskId: string
  actorId: string
  selfRoles: TaskRole[]
}): Promise<DependencyLists> {
  const cond = buildOrgDependencyEdgesCondition({ taskIdParam: input.taskId, orgParam: input.orgId })
  const result = await db.query(
    `SELECT task_dependencies.predecessor_id, task_dependencies.successor_id,
            other_task.id AS other_id, other_task.title, other_task.status, other_task.due_at,
            other_task.is_milestone, other_task.created_by
       FROM task_dependencies
       JOIN tasks AS other_task ON other_task.id = CASE WHEN task_dependencies.predecessor_id = $1
                                                        THEN task_dependencies.successor_id
                                                        ELSE task_dependencies.predecessor_id END
      WHERE ${cond.sql}
      ORDER BY task_dependencies.created_at, other_task.id COLLATE "C"`,
    cond.params,
  )
  const lists: DependencyLists = { predecessors: [], successors: [] }
  if (result.rows.length === 0) return lists
  const ids = [...new Set(result.rows.map((row) => String(row.other_id)))]
  const assigneeRows = await db.query(`SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)`, [ids])
  const followerRows = await db.query(`SELECT task_id, user_id FROM task_followers WHERE task_id = ANY($1)`, [ids])
  const membershipsByTask = await loadActorListMemberships(db, ids, input.actorId)
  const assigneesByTask = groupUserIdsByTask(assigneeRows.rows)
  const followersByTask = groupUserIdsByTask(followerRows.rows)
  for (const row of result.rows) {
    const otherId = String(row.other_id)
    const otherRoles = resolveTaskRoles({
      createdBy: String(row.created_by),
      assigneeIds: assigneesByTask.get(otherId) ?? [],
      followerIds: followersByTask.get(otherId) ?? [],
    }, input.actorId, membershipsByTask.get(otherId) ?? [])
    if (!can(otherRoles, 'view')) continue
    const selfIsSuccessor = String(row.successor_id) === input.taskId
    const item: DepItem = {
      id: otherId,
      title: String(row.title),
      status: String(row.status),
      dueAt: dueAtIso(row.due_at),
      isMilestone: row.is_milestone === true,
      canRemove: canManageDependency({
        predecessorRoles: selfIsSuccessor ? otherRoles : input.selfRoles,
        successorRoles: selfIsSuccessor ? input.selfRoles : otherRoles,
        sameOrg: true,
      }),
    }
    if (selfIsSuccessor) lists.predecessors.push(item)
    else lists.successors.push(item)
  }
  return lists
}

/**
 * `GET /api/tasks/:id/dependencies` (design §3.4): `view` on the task (404 otherwise; a missing org is
 * the route's 404), then the two `DepItem` lists. No lock.
 */
export async function getTaskDependencies(input: { orgId: string; actorId: string; taskId: string }): Promise<DependencyLists> {
  const task = await loadEnd(plainDb, input.taskId, input.orgId)
  const roles = await rolesOn(plainDb, task, input.actorId)
  if (!can(roles, 'view')) fail(404, 'NOT_FOUND')
  return loadDependencyItems(plainDb, { orgId: input.orgId, taskId: task.id, actorId: input.actorId, selfRoles: roles })
}

/** The edge a `POST /dependencies` body names, relative to the task in the path. */
interface RequestedEdge {
  predecessorId: string
  successorId: string
  otherId: string
}

// ASSUMPTION(task-m5a): [a-12] one POST takes exactly one key: `{ predecessorId }` adds
// `predecessorId → :id`, `{ successorId }` adds `:id → successorId`. [a-32] INVALID_DEPENDENCY is
// this design's code for a body of any other shape: not a plain object, no key, both keys, any other
// key next to the one, or an id that is not a task-domain id (the four-conjunct test, gate 10).
function parseDependencyBody(body: unknown, taskId: string): RequestedEdge {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail(422, 'INVALID_DEPENDENCY')
  const keys = Object.keys(body as object)
  if (keys.length !== 1) fail(422, 'INVALID_DEPENDENCY')
  const [key] = keys
  const value = (body as Record<string, unknown>)[key]
  if (!isValidTaskDomainId(value)) fail(422, 'INVALID_DEPENDENCY')
  const otherId = value as string
  if (key === 'predecessorId') return { predecessorId: otherId, successorId: taskId, otherId }
  if (key === 'successorId') return { predecessorId: taskId, successorId: otherId, otherId }
  return fail(422, 'INVALID_DEPENDENCY')
}

/** Writes the events of one dependency change, each end's on its own task, and enqueues each end once. */
async function writeEdgeEvents(db: Db, input: {
  orgId: string
  events: readonly TaskDependencyEvent[]
  ends: readonly DependencyEndRow[]
  at: Date
}): Promise<void> {
  for (const end of input.ends) {
    const own = input.events.filter((event) => event.taskId === end.id)
    if (own.length === 0) continue
    const written = await writeEvents(db, end.id, own, input.at)
    // M4 PR-3b: one enqueue per task, with that task's own creator and only its own events (the
    // producer loads the recipients of the task it is given). Neither dependency word is in the
    // notifiable set, so the producer writes no row for them.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: end.id, createdBy: end.createdBy, events: written })
  }
}

/** The two ends in edge order: the successor first, the predecessor second (the events' order). */
function endsOf(task: DependencyEndRow, other: DependencyEndRow, edge: { successorId: string }): DependencyEndRow[] {
  return edge.successorId === task.id ? [task, other] : [other, task]
}

/**
 * `POST /api/tasks/:id/dependencies` (design §3.4). Under the structure lock, the frozen order: the
 * task and `edit` on it (404) → the body (422 INVALID_DEPENDENCY) → the counterpart, live in the org
 * (404) → `canManageDependency` over both full role sets (404; RULED(2026-10-09): [S11]) →
 * `validateAddDependency` over every live edge of the org, read again under the lock (D4,
 * ASSUMPTION): `cross_org` 404, then 422 SELF, DUPLICATE, LIMIT, CYCLE in the pure function's order
 * (S31's adopted M5-c cell: self, duplicate and cycle are all 422). A diamond is accepted. The edge
 * and its two `dependency_added` events (each end's carrying the other end's id, [S11]) share one
 * `clock_timestamp()` read after the lock. ASSUMPTION(task-m5a): [a-10] no task row is written.
 */
export async function addTaskDependency(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<{ predecessorId: string; successorId: string }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadEnd(db, input.taskId, input.orgId)
    const taskRoles = await rolesOn(db, task, input.actorId)
    if (!can(taskRoles, 'edit')) fail(404, 'NOT_FOUND')
    const requested = parseDependencyBody(input.body, task.id)
    const other = await loadEnd(db, requested.otherId, input.orgId)
    const otherRoles = other.id === task.id ? taskRoles : await rolesOn(db, other, input.actorId)
    const taskIsSuccessor = requested.successorId === task.id
    const predecessor = taskIsSuccessor ? other : task
    const successor = taskIsSuccessor ? task : other
    if (!canManageDependency({
      predecessorRoles: taskIsSuccessor ? otherRoles : taskRoles,
      successorRoles: taskIsSuccessor ? taskRoles : otherRoles,
      sameOrg: predecessor.orgId === successor.orgId,
    })) fail(404, 'NOT_FOUND')
    const edges = await loadOrgEdges(db, input.orgId)
    const at = await lockClock(db)
    const result = applyAddDependency({
      predecessorId: predecessor.id,
      successorId: successor.id,
      predecessorOrgId: predecessor.orgId,
      successorOrgId: successor.orgId,
      edges,
      actorId: input.actorId,
      now: at,
    })
    if (result.ok === false) {
      if (result.reason === 'cross_org') fail(404, 'NOT_FOUND')
      fail(422, result.reason.toUpperCase())
    }
    await db.query(
      `INSERT INTO task_dependencies (predecessor_id, successor_id, org_id, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [result.edge.predecessorId, result.edge.successorId, predecessor.orgId, input.actorId, at],
    )
    await writeEdgeEvents(db, { orgId: input.orgId, events: result.events, ends: endsOf(task, other, result.edge), at })
    return { predecessorId: result.edge.predecessorId, successorId: result.edge.successorId }
  })
}

/**
 * `DELETE /api/tasks/:id/dependencies/predecessors/:otherId` (`direction: 'predecessor'`, the edge
 * `otherId → :id`) and `…/successors/:otherId` (`'successor'`, the edge `:id → otherId`), design §3.4.
 * Under the structure lock: the task and `edit` (404) → the counterpart (404) → `canManageDependency`
 * (404) → `applyRemoveDependency`: an edge that is not there is a no-op that writes nothing; otherwise
 * the row and two `dependency_removed` events. A non-printable id in the path is 404 before any SQL.
 */
export async function removeTaskDependency(input: {
  orgId: string
  actorId: string
  taskId: string
  otherId: string
  direction: TaskDependencyDirection
}): Promise<{ predecessorId: string; successorId: string }> {
  if (!isPrintableId(input.taskId) || !isPrintableId(input.otherId)) fail(404, 'NOT_FOUND')
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadEnd(db, input.taskId, input.orgId)
    const taskRoles = await rolesOn(db, task, input.actorId)
    if (!can(taskRoles, 'edit')) fail(404, 'NOT_FOUND')
    const other = await loadEnd(db, input.otherId, input.orgId)
    const otherRoles = other.id === task.id ? taskRoles : await rolesOn(db, other, input.actorId)
    const taskIsSuccessor = input.direction === 'predecessor'
    const edge = taskIsSuccessor
      ? { predecessorId: other.id, successorId: task.id }
      : { predecessorId: task.id, successorId: other.id }
    if (!canManageDependency({
      predecessorRoles: taskIsSuccessor ? otherRoles : taskRoles,
      successorRoles: taskIsSuccessor ? taskRoles : otherRoles,
      sameOrg: task.orgId === other.orgId,
    })) fail(404, 'NOT_FOUND')
    const cond = buildOrgDependencyEdgesCondition({ taskIdParam: task.id, orgParam: input.orgId })
    const n = cond.params.length + 1
    const existing = await db.query(
      `SELECT task_dependencies.predecessor_id, task_dependencies.successor_id FROM task_dependencies
        WHERE ${cond.sql} AND task_dependencies.predecessor_id = $${n} AND task_dependencies.successor_id = $${n + 1}`,
      [...cond.params, edge.predecessorId, edge.successorId],
    )
    const at = await lockClock(db)
    const result = applyRemoveDependency({
      ...edge,
      edges: existing.rows.map((row) => ({ predecessorId: String(row.predecessor_id), successorId: String(row.successor_id) })),
      actorId: input.actorId,
      now: at,
    })
    if (result.noop) return edge
    await db.query(`DELETE FROM task_dependencies WHERE predecessor_id = $1 AND successor_id = $2`, [edge.predecessorId, edge.successorId])
    await writeEdgeEvents(db, { orgId: input.orgId, events: result.events, ends: endsOf(task, other, edge), at })
    return edge
  })
}

/** The longest candidate search text, in UTF-16 code units of the text as sent (design §3.4, [a-32]). */
const CANDIDATE_QUERY_MAX = 200

// ASSUMPTION(task-m5a): [a-32] `q` is a literal, case-insensitive title substring: no wildcard is
// interpreted. Absent, or blank once trimmed ⇒ no filter; not one string, or longer than 200 code
// units as sent ⇒ 422 INVALID_QUERY.
function parseCandidateQuery(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || raw.length > CANDIDATE_QUERY_MAX) fail(422, 'INVALID_QUERY')
  const trimmed = (raw as string).trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * `GET /api/tasks/:id/dependency-candidates?direction=predecessor|successor&q=&limit=&offset=`
 * (design §3.4). No lock. Order: the task and `edit` on it (404; a missing org is the route's 404),
 * then the query parameters (422 INVALID_DIRECTION, INVALID_QUERY, the page codes: all after the 404,
 * design §3.0). The rows are the org's live tasks other than this one (the candidate builder), in the
 * M4 task page order (`TASK_PAGE_SORT_KEY`, [a-34]), kept where the caller may edit them (the full
 * role set, [S11]) and where task E's `dependencyCandidates` keeps them: not linked to this task in
 * either direction, and not closing a cycle (task E's own choice, X3, the design default; parent and
 * child relations are not excluded, the per-task limit is not applied). `total` counts every kept row;
 * the page is cut after the filter.
 */
export async function getDependencyCandidates(input: {
  orgId: string
  actorId: string
  taskId: string
  query: { direction?: unknown; q?: unknown; limit?: unknown; offset?: unknown }
}): Promise<{ items: Array<{ id: string; title: string; status: string }>; total: number }> {
  const task = await loadEnd(plainDb, input.taskId, input.orgId)
  if (!can(await rolesOn(plainDb, task, input.actorId), 'edit')) fail(404, 'NOT_FOUND')
  const direction = input.query.direction
  if (direction !== 'predecessor' && direction !== 'successor') fail(422, 'INVALID_DIRECTION')
  const q = parseCandidateQuery(input.query.q)
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const cond = buildDependencyCandidateTasksCondition({ taskIdParam: task.id, orgParam: input.orgId })
  const n = cond.params.length + 1
  const rows = await plainDb.query(
    `SELECT id, title, status, created_by FROM tasks WHERE ${cond.sql}
     ${q === null ? '' : `AND strpos(lower(tasks.title), lower($${n})) > 0`}
     ORDER BY ${TASK_PAGE_SORT_KEY}`,
    q === null ? cond.params : [...cond.params, q],
  )
  const ids = rows.rows.map((row) => String(row.id))
  const assigneeRows = ids.length === 0 ? [] : (await plainDb.query(`SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)`, [ids])).rows
  const followerRows = ids.length === 0 ? [] : (await plainDb.query(`SELECT task_id, user_id FROM task_followers WHERE task_id = ANY($1)`, [ids])).rows
  const membershipsByTask = await loadActorListMemberships(plainDb, ids, input.actorId)
  const assigneesByTask = groupUserIdsByTask(assigneeRows)
  const followersByTask = groupUserIdsByTask(followerRows)
  const editable = rows.rows.filter((row: Row) => {
    const id = String(row.id)
    return can(resolveTaskRoles({
      createdBy: String(row.created_by),
      assigneeIds: assigneesByTask.get(id) ?? [],
      followerIds: followersByTask.get(id) ?? [],
    }, input.actorId, membershipsByTask.get(id) ?? []), 'edit')
  })
  const kept = new Set(dependencyCandidates({
    taskId: task.id,
    direction,
    candidateIds: editable.map((row) => String(row.id)),
    edges: await loadOrgEdges(plainDb, input.orgId),
  }))
  const ordered = editable.filter((row) => kept.has(String(row.id)))
  return {
    items: ordered.slice(page.offset, page.offset + page.limit).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      status: String(row.status),
    })),
    total: ordered.length,
  }
}
