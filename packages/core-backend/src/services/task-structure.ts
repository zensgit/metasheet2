/**
 * M3 (P0-B) task persistence: subtree parenting, assignee/follower membership,
 * completion-mode switch, comments, soft delete. SQL text and transition
 * rules come from task C (`packages/core-backend/src/tasks/{task-tree,
 * task-membership,task-comments,task-deletion}.ts`); this module only
 * executes them and writes `task_events`.
 *
 * Reuses the shared read/write primitives exported from `task-records.ts`
 * (the P0-A structure-lock transaction wrapper, task load, row-ability
 * guard, assignee load/write, and done-state write) rather than duplicating
 * them — same lock protocol, same style, one place to change it.
 */
import { query, transaction } from '../db/pg'
import {
  buildTaskByIdCondition,
  can,
  canChangeTaskMembers,
  resolveTaskRoles,
  type TaskRole,
} from '../tasks/task-access'
import {
  type TaskAssigneeRow,
  type TaskCompletionMode,
} from '../tasks/task-completion'
import {
  applyAddAssignee,
  applyAddFollower,
  applyRemoveAssignee,
  applyRemoveFollower,
  applySwitchCompletionMode,
  type TaskMembershipStatus,
} from '../tasks/task-membership'
import {
  canDeleteComment,
  canEditComment,
  normalizeCommentBody,
  toCommentView,
  type TaskCommentRow,
  type TaskCommentView,
} from '../tasks/task-comments'
import { planDeleteTask, type TaskDeletionNodes } from '../tasks/task-deletion'
import {
  canReparent,
  parentCandidates,
  validateClearParent,
  validateSetParent,
  type TaskTreeNodes,
} from '../tasks/task-tree'
import { isPrintableId, isStorableText, isValidMemberId } from './task-create'
import { taskCountsSignal } from './task-counts-realtime'
import { newTaskCommentId, newTaskEventId } from './task-ids-runtime'
import { enqueueTaskEventNotifications, type WrittenTaskEvent } from './task-notification-producer'
import { assertActiveOrgMembers } from './task-org-members'
import {
  assertRowAbility,
  assigneeIds,
  fail,
  groupUserIdsByTask,
  loadActorListMemberships,
  loadAssignees,
  loadRowRoles,
  loadTask,
  plainDb,
  withOrgStructure,
  writeChangedAssignees,
  writeTaskDoneState,
  type Db,
  type LoadedTask,
  type Row,
} from './task-records'

/** `isValidMemberId` (`task-create.ts`) is the one validator for every
 * member-id ingress: task creation's `assignees` field and these M3 routes. */
function requireMemberUserId(value: unknown): string {
  if (!isValidMemberId(value)) fail(422, 'INVALID_ASSIGNEES')
  return value
}

function bodyField(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined
}

function asMembershipStatus(status: string): TaskMembershipStatus {
  return status === 'done' ? 'done' : 'open'
}

async function loadFollowerIds(db: Db, taskId: string): Promise<string[]> {
  const result = await db.query(`SELECT user_id FROM task_followers WHERE task_id = $1`, [taskId])
  return result.rows.map((row) => String(row.user_id))
}

/** Role set including list identity (`loadRowRoles`, RULED(2026-10-07): [R04]). */
async function loadRoles(db: Db, taskId: string, createdBy: string, actorId: string): Promise<TaskRole[]> {
  const { roles } = await loadRowRoles(db, { taskId, createdBy, actorId })
  return roles
}

/**
 * RULED(2026-10-07): [own-53]: the assignee and follower rows of `taskId`, read on
 * the locked client, after `canChangeTaskMembers` (a direct role: creator or assignee) has allowed
 * `actorId` to change them. Otherwise the same 404 as a missing task (ASSUMPTION(task-m4):
 * [own-09]), before the request body or the path user id is looked at. The rows are the input of
 * the pure transition that follows.
 */
async function loadMembersForChange(
  db: Db,
  task: LoadedTask,
  input: { taskId: string; actorId: string },
): Promise<{ assignees: TaskAssigneeRow[]; followers: string[] }> {
  const assignees = await loadAssignees(db, input.taskId)
  const followers = await loadFollowerIds(db, input.taskId)
  const allowed = canChangeTaskMembers({
    task: { createdBy: task.createdBy, assigneeIds: assignees.map((row) => row.userId), followerIds: followers },
    me: input.actorId,
  })
  if (!allowed) fail(404, 'NOT_FOUND')
  return { assignees, followers }
}

interface MembershipEventLike {
  type: string
  userId: string
  targetUserId?: string
  occurredAt?: Date
}

/**
 * Membership events carry `targetUserId` (the assignee/follower the change is
 * about) that the tree/deletion events do not — written into `task_events
 * .payload` (PR #6126 second-round review, P2 item 6). Tree/deletion events
 * have no `targetUserId` and keep the column's `{}` default. Returns the
 * events as written, ids included (ASSUMPTION(task-m4): [own-3b-12]: each id
 * is generated before its INSERT, for the notification producer).
 */
async function writeMembershipEvents(db: Db, taskId: string, events: MembershipEventLike[], fallbackAt: Date): Promise<WrittenTaskEvent[]> {
  const written: WrittenTaskEvent[] = []
  for (const event of events) {
    const id = newTaskEventId()
    const occurredAt = event.occurredAt ?? fallbackAt
    const payload = event.targetUserId !== undefined ? JSON.stringify({ targetUserId: event.targetUserId }) : '{}'
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, payload, occurred_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [id, taskId, event.userId, event.type, payload, occurredAt],
    )
    written.push({ id, type: event.type, actorId: event.userId, occurredAt })
  }
  return written
}

interface MembershipResponse {
  id: string
  status: string
  completionMode: string
  assignees: Array<{ userId: string; completedAt: string | null }>
}

function membershipResponse(taskId: string, status: TaskMembershipStatus, mode: TaskCompletionMode, rows: TaskAssigneeRow[]): MembershipResponse {
  const sorted = [...rows].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
  return {
    id: taskId,
    status,
    completionMode: mode,
    assignees: sorted.map((row) => ({ userId: row.userId, completedAt: row.completedAt ? row.completedAt.toISOString() : null })),
  }
}

// ---------------------------------------------------------------------------
// §3.1 PATCH /api/tasks/:id/parent
// ---------------------------------------------------------------------------

type ParentBody = { kind: 'clear' } | { kind: 'set'; parentId: string }

/**
 * `{ parentId: string | null }`. A string that is not a printable id (empty,
 * or containing any character outside `[!-~]`, U+0000 included) is a
 * malformed body, 422 INVALID_PARENT like a missing or wrongly-typed field —
 * it could match no task, and must not reach a bind parameter.
 */
function parseParentBody(body: unknown): ParentBody {
  const parentId = bodyField(body, 'parentId')
  if (parentId === null) return { kind: 'clear' }
  if (isPrintableId(parentId)) return { kind: 'set', parentId }
  fail(422, 'INVALID_PARENT')
}

async function loadOrgTreeNodes(db: Db, orgId: string): Promise<Map<string, { parentId: string | null }>> {
  const result = await db.query(`SELECT id, parent_id FROM tasks WHERE org_id = $1 AND deleted_at IS NULL`, [orgId])
  const nodes = new Map<string, { parentId: string | null }>()
  for (const row of result.rows) {
    nodes.set(String(row.id), { parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id) })
  }
  return nodes
}

/**
 * Both the current parent (if any) and the new parent (if any) need `edit`,
 * same as the task itself — PR #6126 second-round review, P2 item 4. The
 * request body is validated before the ONE check that needs it (the new
 * parent's id); the task-itself and current-parent checks do not need the
 * body and run first, so an unreadable/unwritable task still 404s regardless
 * of what the body contains.
 */
export async function setTaskParent(input: {
  orgId: string
  actorId: string
  taskId: string
  body: unknown
}): Promise<{ id: string; parentId: string | null; depth: number }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const childRoles = await loadRoles(db, input.taskId, task.createdBy, input.actorId)
    if (!can(childRoles, 'edit')) fail(404, 'NOT_FOUND')

    if (task.parentId !== null) {
      const currentParent = await loadTask(db, task.parentId, input.orgId)
      const currentParentRoles = await loadRoles(db, task.parentId, currentParent.createdBy, input.actorId)
      if (!canReparent({ childRoles, parentRoles: currentParentRoles, sameOrg: true })) fail(404, 'NOT_FOUND')
    }

    const parsed = parseParentBody(input.body)

    if (parsed.kind === 'set') {
      const newParent = await loadTask(db, parsed.parentId, input.orgId)
      const newParentRoles = await loadRoles(db, parsed.parentId, newParent.createdBy, input.actorId)
      if (!canReparent({ childRoles, parentRoles: newParentRoles, sameOrg: true })) fail(404, 'NOT_FOUND')
    }

    const nodes: TaskTreeNodes = await loadOrgTreeNodes(db, input.orgId)
    const result = parsed.kind === 'clear'
      ? validateClearParent({ taskId: input.taskId, nodes })
      : validateSetParent({ taskId: input.taskId, newParentId: parsed.parentId, nodes })

    if (result.ok === false) {
      if (result.reason === 'not_found') fail(404, 'NOT_FOUND')
      if (result.reason === 'depth_exceeded') fail(422, 'DEPTH_EXCEEDED')
      fail(422, 'INVALID_PARENT')
    }
    if (result.noop) {
      return { id: input.taskId, parentId: task.parentId, depth: task.depth }
    }

    const now = new Date()
    const own = result.depthChanges.find((change) => change.id === input.taskId)
    if (own) {
      await db.query(
        `UPDATE tasks SET parent_id = $2, depth = $3, updated_at = $4 WHERE id = $1`,
        [input.taskId, parsed.kind === 'set' ? parsed.parentId : null, own.depth, now],
      )
    }
    // Every descendant's depth in one statement (M3R2-CONC-4), so the time
    // this transaction holds the org lock and the row locks does not grow
    // with one round trip per descendant.
    const descendants = result.depthChanges.filter((change) => change.id !== input.taskId)
    if (descendants.length > 0) {
      await db.query(
        `UPDATE tasks AS t SET depth = v.depth, updated_at = $3
         FROM unnest($1::text[], $2::int[]) AS v(id, depth)
         WHERE t.id = v.id`,
        [descendants.map((change) => change.id), descendants.map((change) => change.depth), now],
      )
    }
    const eventType = result.events[0]?.type
    if (eventType) {
      await db.query(
        `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
        [newTaskEventId(), input.taskId, input.actorId, eventType, now],
      )
    }
    const depth = result.depthChanges.find((change) => change.id === input.taskId)?.depth ?? task.depth
    return { id: input.taskId, parentId: parsed.kind === 'set' ? parsed.parentId : null, depth }
  })
}

// ---------------------------------------------------------------------------
// GET /api/tasks/:id/parent-candidates (PR #6126 second-round review, P3/NIT 8)
// ---------------------------------------------------------------------------

export async function getParentCandidates(input: {
  orgId: string
  actorId: string
  taskId: string
}): Promise<{ items: Array<{ id: string; title: string }> }> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  await assertRowAbility(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'edit' })

  const rowsResult = await query<Row>(
    `SELECT id, title, parent_id, created_by FROM tasks WHERE org_id = $1 AND deleted_at IS NULL`,
    [input.orgId],
  )
  const ids = rowsResult.rows.map((row) => String(row.id))
  const nodes = new Map<string, { parentId: string | null }>()
  const titleById = new Map<string, string>()
  const createdByById = new Map<string, string>()
  for (const row of rowsResult.rows) {
    const id = String(row.id)
    nodes.set(id, { parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id) })
    titleById.set(id, String(row.title))
    createdByById.set(id, String(row.created_by))
  }
  const [assigneeRows, followerRows, membershipsByTask] = await Promise.all([
    query<Row>(`SELECT task_id, user_id FROM task_assignees WHERE task_id = ANY($1)`, [ids]),
    query<Row>(`SELECT task_id, user_id FROM task_followers WHERE task_id = ANY($1)`, [ids]),
    loadActorListMemberships(plainDb, ids, input.actorId),
  ])
  const assigneesByTask = groupUserIdsByTask(assigneeRows.rows)
  const followersByTask = groupUserIdsByTask(followerRows.rows)

  const candidateIds = parentCandidates({ taskId: input.taskId, nodes })
  const items = candidateIds
    .filter((id) => can(resolveTaskRoles({
      createdBy: createdByById.get(id) ?? '',
      assigneeIds: assigneesByTask.get(id) ?? [],
      followerIds: followersByTask.get(id) ?? [],
    }, input.actorId, membershipsByTask.get(id) ?? []), 'edit'))
    .map((id) => ({ id, title: titleById.get(id) ?? '' }))
  return { items }
}

// ---------------------------------------------------------------------------
// §3.3 assignees, §3.4 completion-mode
// ---------------------------------------------------------------------------

export async function addAssignee(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<MembershipResponse> {
  const counts = taskCountsSignal()
  const response = await withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { assignees: rows } = await loadMembersForChange(db, task, input)
    const userId = requireMemberUserId(bodyField(input.body, 'userId'))
    const now = new Date()
    const result = applyAddAssignee({
      mode: task.mode,
      status: asMembershipStatus(task.status),
      rows,
      now,
      actorId: input.actorId,
      userId,
    })
    if (result.ok === false) fail(422, 'LIMIT')
    if (result.events.length > 0) {
      // RULED(2026-10-07): [R17] [N2] a new assignee must be an active member of the
      // org (task-org-members.ts), else 422 INACTIVE_ORG_MEMBER and nothing is written. Only for an
      // addition the pure function made, so a re-add stays a no-op without a lookup; after the
      // direct-role check ([own-53]) and the id check above. ASSUMPTION(task-m4): [own-16] never for
      // the caller adding themselves.
      if (userId !== input.actorId) await assertActiveOrgMembers(db, input.orgId, [userId])
      await db.query(
        `INSERT INTO task_assignees (task_id, user_id, completed_at, assigned_by) VALUES ($1, $2, NULL, $3)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [input.taskId, userId, input.actorId],
      )
    }
    if (result.status !== task.status) await writeTaskDoneState(db, input.taskId, result.status === 'done', now)
    const written = await writeMembershipEvents(db, input.taskId, result.events, now)
    // M4 PR-3b: outbox rows for the events that notify, in this transaction.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    // RULED(2026-10-07): [R16] a real addition (or a status change): the assignees before it and
    // after it; never the followers.
    if (result.events.length > 0 || result.status !== task.status) {
      counts.note({ before: assigneeIds(rows), after: assigneeIds(result.rows) })
    }
    return membershipResponse(input.taskId, result.status, task.mode, result.rows)
  })
  // RULED(2026-10-07): [R16] sent only once the transaction above committed.
  counts.publish()
  return response
}

export async function removeAssignee(input: { orgId: string; actorId: string; taskId: string; userId: string }): Promise<MembershipResponse> {
  const counts = taskCountsSignal()
  const response = await withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { assignees: rows } = await loadMembersForChange(db, task, input)
    const userId = requireMemberUserId(input.userId)
    const now = new Date()
    const result = applyRemoveAssignee({
      mode: task.mode,
      status: asMembershipStatus(task.status),
      rows,
      now,
      actorId: input.actorId,
      userId,
    })
    if (result.events.length > 0) {
      await db.query(`DELETE FROM task_assignees WHERE task_id = $1 AND user_id = $2`, [input.taskId, userId])
    }
    if (result.status !== task.status) await writeTaskDoneState(db, input.taskId, result.status === 'done', now)
    const written = await writeMembershipEvents(db, input.taskId, result.events, now)
    // M4 PR-3b: outbox rows for the events that notify, in this transaction.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    // RULED(2026-10-07): [R16] a real removal (or a status change): the removed assignee is in the
    // set before it; never the followers.
    if (result.events.length > 0 || result.status !== task.status) {
      counts.note({ before: assigneeIds(rows), after: assigneeIds(result.rows) })
    }
    return membershipResponse(input.taskId, result.status, task.mode, result.rows)
  })
  // RULED(2026-10-07): [R16] sent only once the transaction above committed.
  counts.publish()
  return response
}

function parseCompletionMode(value: unknown): TaskCompletionMode {
  if (value === 'all' || value === 'any') return value
  // M2 already owns this code for the same field on POST /api/tasks
  // (`task-records.ts`'s `createTask`) — reused rather than introducing a
  // second name for the same validation failure (PR #6126 second-round
  // review, P3/NIT 11).
  fail(422, 'INVALID_MODE')
}

async function writeCompletionModeState(db: Db, taskId: string, opts: { mode: TaskCompletionMode; statusChanged: boolean; done: boolean; now: Date }): Promise<void> {
  if (opts.statusChanged) {
    if (opts.done) {
      await db.query(
        `UPDATE tasks SET status = 'done', completed_at = $2, completion_mode = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
        [taskId, opts.now, opts.mode],
      )
    } else {
      await db.query(
        `UPDATE tasks SET status = 'open', completed_at = NULL, completion_mode = $2, updated_at = now(), version = version + 1 WHERE id = $1`,
        [taskId, opts.mode],
      )
    }
    return
  }
  await db.query(`UPDATE tasks SET completion_mode = $2, updated_at = now() WHERE id = $1`, [taskId, opts.mode])
}

/**
 * Version bump rule (not written in the original contract; recorded here and
 * in the M3 verification doc): `tasks.version` increments only when
 * `tasks.status` actually flips (matching `writeTaskDoneState`, the M2
 * precedent). A completion-mode switch that does not flip status updates
 * `completion_mode`/`updated_at` only. When BOTH the mode and the status
 * change in the same call (`all -> any` completing the task), exactly one
 * `UPDATE` and one version bump cover both — never two.
 */
export async function switchCompletionMode(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<MembershipResponse> {
  const counts = taskCountsSignal()
  const response = await withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    await assertRowAbility(db, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'edit' })
    const to = parseCompletionMode(bodyField(input.body, 'completionMode'))
    const rows = await loadAssignees(db, input.taskId)
    const now = new Date()
    const result = applySwitchCompletionMode({
      mode: task.mode,
      status: asMembershipStatus(task.status),
      rows,
      now,
      actorId: input.actorId,
      to,
    })
    if (to !== task.mode) {
      await writeChangedAssignees(db, input.taskId, rows, result.rows)
      const statusChanged = result.status !== task.status
      await writeCompletionModeState(db, input.taskId, { mode: to, statusChanged, done: result.status === 'done', now })
    }
    const written = await writeMembershipEvents(db, input.taskId, result.events, now)
    // M4 PR-3b: outbox rows for the events that notify, in this transaction.
    await enqueueTaskEventNotifications(db, { orgId: input.orgId, taskId: input.taskId, createdBy: task.createdBy, events: written })
    // RULED(2026-10-07): [R16] ASSUMPTION(task-m4): [own-3c-02] every real mode change, whether or
    // not it moved the status or a completion; the same mode is a no-op and sends nothing.
    if (to !== task.mode) counts.note({ before: assigneeIds(rows), after: assigneeIds(result.rows) })
    return membershipResponse(input.taskId, result.status, to, result.rows)
  })
  // RULED(2026-10-07): [R16] sent only once the transaction above committed.
  counts.publish()
  return response
}

// ---------------------------------------------------------------------------
// §3.5 followers / leave
// ---------------------------------------------------------------------------

export async function addFollower(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<{ id: string; followers: string[] }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { followers } = await loadMembersForChange(db, task, input)
    const userId = requireMemberUserId(bodyField(input.body, 'userId'))
    const result = applyAddFollower({ followers, userId, actorId: input.actorId })
    if (result.ok === false) fail(422, 'LIMIT')
    if (result.events.length > 0) {
      // RULED(2026-10-07): [R17] [N2] the same check for a new follower, at the same point and,
      // ASSUMPTION(task-m4): [own-16], with the same exemption as addAssignee.
      if (userId !== input.actorId) await assertActiveOrgMembers(db, input.orgId, [userId])
      await db.query(
        `INSERT INTO task_followers (task_id, user_id) VALUES ($1, $2) ON CONFLICT (task_id, user_id) DO NOTHING`,
        [input.taskId, userId],
      )
    }
    await writeMembershipEvents(db, input.taskId, result.events, new Date())
    return { id: input.taskId, followers: result.followers }
  })
}

export async function removeFollower(input: { orgId: string; actorId: string; taskId: string; userId: string }): Promise<{ id: string; followers: string[] }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    const { followers } = await loadMembersForChange(db, task, input)
    const userId = requireMemberUserId(input.userId)
    const result = applyRemoveFollower({ followers, userId, actorId: input.actorId })
    if (result.events.length > 0) {
      await db.query(`DELETE FROM task_followers WHERE task_id = $1 AND user_id = $2`, [input.taskId, userId])
    }
    await writeMembershipEvents(db, input.taskId, result.events, new Date())
    return { id: input.taskId, followers: result.followers }
  })
}

export async function leaveTask(input: { orgId: string; actorId: string; taskId: string }): Promise<{ id: string; followers: string[] }> {
  return withOrgStructure(input.orgId, async (db) => {
    const task = await loadTask(db, input.taskId, input.orgId)
    await assertRowAbility(db, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'leave' })
    const followers = await loadFollowerIds(db, input.taskId)
    const result = applyRemoveFollower({ followers, userId: input.actorId, actorId: input.actorId })
    if (result.events.length > 0) {
      await db.query(`DELETE FROM task_followers WHERE task_id = $1 AND user_id = $2`, [input.taskId, input.actorId])
    }
    await writeMembershipEvents(db, input.taskId, result.events, new Date())
    return { id: input.taskId, followers: result.followers }
  })
}

// ---------------------------------------------------------------------------
// §3.6 comments
// ---------------------------------------------------------------------------

export interface CommentJson {
  id: string
  taskId: string
  authorId: string
  body: string | null
  deleted: boolean
  createdAt: string
}

function toCommentRow(row: Row): TaskCommentRow {
  const deletedAt = row.deleted_at
  const createdAt = row.created_at
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    authorId: String(row.author_id),
    body: row.body === null || row.body === undefined ? null : String(row.body),
    deleted: deletedAt !== null && deletedAt !== undefined,
    createdAt: createdAt instanceof Date ? createdAt : new Date(String(createdAt)),
  }
}

function commentJson(view: TaskCommentView): CommentJson {
  return {
    id: view.id,
    taskId: view.taskId,
    authorId: view.authorId,
    body: view.body,
    deleted: view.deleted,
    createdAt: view.createdAt.toISOString(),
  }
}

const PAGE_LIMIT_MAX = 100
const PAGE_LIMIT_DEFAULT = 100
/**
 * Upper bound for a pagination parameter. Postgres coerces `LIMIT`/`OFFSET`
 * to `bigint`; 2^31-1 is a chosen cap far below bigint max (~9.22e18), well
 * inside the range where `Number()` is exact, so the JS-side comparison is
 * safe (a "<= bigint max" comparison would not be: `Number()` rounds long
 * before that point) (M3-CF-1).
 */
const PAGE_INT_MAX = 2 ** 31 - 1

/** A repeated or bracketed query parameter (`?limit=1&limit=2`,
 * `?limit[]=1`) arrives as an array or object; it is not a decimal integer,
 * so it maps to '' and fails as 422 INVALID_PAGE (M3R2-CF-9). */
function parsePaginationParam(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  return typeof raw === 'string' ? raw : ''
}

/**
 * Decimal digits only, and a JS-safe integer no larger than `PAGE_INT_MAX`.
 * Anything else is 422 INVALID_PAGE, rather than reaching a `LIMIT`/`OFFSET`
 * bind param that Postgres rejects with its own SQLSTATE (out of range, or
 * not an integer once `Number()` serializes it as `1e+21`), which the route
 * would surface as a 500 (M3-CF-1).
 */
function parseBoundedInt(raw: string): number {
  if (!/^\d+$/.test(raw)) fail(422, 'INVALID_PAGE')
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n > PAGE_INT_MAX) fail(422, 'INVALID_PAGE')
  return n
}

/** `limit` 1..100 (default 100), `offset` >= 0 (default 0) — PR #6126
 * second-round review, P3/NIT 7. Both are bounded by `parseBoundedInt`
 * (M3-CF-1). */
function parsePagination(input: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  let limit = PAGE_LIMIT_DEFAULT
  const rawLimit = parsePaginationParam(input.limit)
  if (rawLimit !== undefined) {
    const n = parseBoundedInt(rawLimit)
    if (n < 1 || n > PAGE_LIMIT_MAX) fail(422, 'INVALID_PAGE')
    limit = n
  }
  let offset = 0
  const rawOffset = parsePaginationParam(input.offset)
  if (rawOffset !== undefined) {
    offset = parseBoundedInt(rawOffset)
  }
  return { limit, offset }
}

export async function listComments(input: {
  orgId: string
  actorId: string
  taskId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: CommentJson[]; total: number }> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  await assertRowAbility(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'view' })
  const { limit, offset } = parsePagination(input.query)
  const totalResult = await query<{ n: string }>(`SELECT count(*)::text AS n FROM task_comments WHERE task_id = $1`, [input.taskId])
  const total = Number(totalResult.rows[0]?.n ?? 0)
  const rowsResult = await query<Row>(
    `SELECT id, task_id, author_id, body, deleted_at, created_at FROM task_comments
     WHERE task_id = $1 ORDER BY created_at, id LIMIT $2 OFFSET $3`,
    [input.taskId, limit, offset],
  )
  const items = rowsResult.rows.map((row) => commentJson(toCommentView(toCommentRow(row))))
  return { items, total }
}

/**
 * Task liveness for the comment writes, taken inside the comment's own
 * transaction (M3-CONC-6, narrowed in M3R2-CONC-1). The comment write takes
 * `FOR KEY SHARE` on the live task row; `deleteTaskById` takes `FOR UPDATE`
 * on the same row before it stamps `deleted_at`. Only those two modes
 * conflict:
 * - delete first (uncommitted): this waits, and once the delete commits READ
 *   COMMITTED re-evaluates the `WHERE` on the new row version, so 0 rows ⇒ 404;
 * - this first: the delete's `FOR UPDATE` waits until the comment commits, so
 *   the comment lands before the task is deleted, which is an ordinary ordering.
 * Every other task write (complete, reopen, mode switch, membership, parent)
 * updates non-key columns and takes `FOR NO KEY UPDATE`, which does not
 * conflict with `FOR KEY SHARE`, so comment traffic never makes those writes
 * wait while they hold the org structure lock. Folding `deleted_at IS NULL`
 * into the write statement instead (`INSERT … SELECT`, `AND EXISTS (…)`)
 * would be a snapshot read that does not wait for an uncommitted delete, so
 * it would only narrow the window, not close it.
 *
 * Scope: liveness only. Assignee/follower removal does not update the tasks
 * row (unless it flips status), so this lock does not order a comment write
 * against a concurrent membership change; the caller's `comment` ability is
 * the one checked just before the transaction.
 */
async function lockLiveTaskForComment(db: Db, taskId: string, orgId: string): Promise<void> {
  const cond = buildTaskByIdCondition({ taskIdParam: taskId, orgParam: orgId })
  const result = await db.query(`SELECT 1 FROM tasks WHERE ${cond.sql} FOR KEY SHARE`, cond.params)
  if (result.rows.length === 0) fail(404, 'NOT_FOUND')
}

/**
 * `normalizeCommentBody` (task C) plus one service-level rule: text that
 * cannot be stored exactly as sent — U+0000 (M3R2-AUTHZ-4) or a string that
 * is not well-formed UTF-16 (M3R3-IN-4) — is rejected as 422
 * COMMENT_INVALID_CHAR. Rejected, not stripped or replaced: either would
 * store a body other than the one the author sent.
 */
function requireCommentBody(body: unknown): string {
  const normalized = normalizeCommentBody(bodyField(body, 'body'))
  if (normalized.ok === false) fail(422, normalized.reason === 'blank' ? 'COMMENT_BLANK' : 'COMMENT_TOO_LONG')
  if (!isStorableText(normalized.body)) fail(422, 'COMMENT_INVALID_CHAR')
  return normalized.body
}

function wrapClient(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db {
  return { query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows as Row[] } } }
}

export async function addComment(input: { orgId: string; actorId: string; taskId: string; body: unknown }): Promise<CommentJson> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  await assertRowAbility(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'comment' })
  const body = requireCommentBody(input.body)
  const id = newTaskCommentId()
  return transaction(async (client) => {
    const db = wrapClient(client)
    // First statement, so a REPEATABLE READ database default cannot turn the
    // row-lock wait below into a 40001 serialization error instead of a
    // clean wait-then-recheck (same reasoning as `withOrgStructure`).
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await lockLiveTaskForComment(db, input.taskId, input.orgId)
    const insertResult = await db.query(
      `INSERT INTO task_comments (id, task_id, author_id, body) VALUES ($1, $2, $3, $4) RETURNING created_at`,
      [id, input.taskId, input.actorId, body],
    )
    const createdAtRaw = insertResult.rows[0]?.created_at
    const createdAt = createdAtRaw instanceof Date ? createdAtRaw : new Date(String(createdAtRaw))
    const eventId = newTaskEventId()
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type) VALUES ($1, $2, $3, 'commented')`,
      [eventId, input.taskId, input.actorId],
    )
    // M4 PR-3b: outbox rows for the comment, on this transaction's client.
    await enqueueTaskEventNotifications(db, {
      orgId: input.orgId,
      taskId: input.taskId,
      createdBy: task.createdBy,
      events: [{ id: eventId, type: 'commented', actorId: input.actorId, occurredAt: null }],
    })
    return commentJson(toCommentView({
      id, taskId: input.taskId, authorId: input.actorId, body, deleted: false, createdAt,
    }))
  })
}

async function loadCommentForTask(taskId: string, commentId: string): Promise<{ authorId: string; deleted: boolean }> {
  // A non-printable id (U+0000 included) can match no row; 404 before SQL.
  if (!isPrintableId(commentId)) fail(404, 'NOT_FOUND')
  const result = await query<Row>(`SELECT author_id, task_id, deleted_at FROM task_comments WHERE id = $1`, [commentId])
  const row = result.rows[0]
  if (!row || String(row.task_id) !== taskId) fail(404, 'NOT_FOUND')
  return { authorId: String(row.author_id), deleted: row.deleted_at !== null && row.deleted_at !== undefined }
}

/**
 * Same task pre-conditions as the other single-task write routes (RBAC code
 * at the route, task in caller's org and not soft-deleted, caller can
 * `comment` on it), PLUS `task_comments.task_id = :id` — a comment id from
 * another task 404s here before the author check ever runs (PR #6126
 * second-round review, P2 item 1). The `UPDATE ... WHERE deleted_at IS NULL`
 * guard makes a concurrent delete a 404, not a tombstone-CHECK 500 (same
 * review, P3/NIT 10).
 */
export async function updateComment(input: { orgId: string; actorId: string; taskId: string; commentId: string; body: unknown }): Promise<CommentJson> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  await assertRowAbility(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'comment' })
  const existing = await loadCommentForTask(input.taskId, input.commentId)
  if (!canEditComment({ authorId: existing.authorId, actorId: input.actorId, deleted: existing.deleted })) fail(404, 'NOT_FOUND')
  const body = requireCommentBody(input.body)
  return transaction(async (client) => {
    const db = wrapClient(client)
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await lockLiveTaskForComment(db, input.taskId, input.orgId)
    const updateResult = await db.query(
      `UPDATE task_comments SET body = $3, updated_at = now(), edited_at = now()
       WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL
       RETURNING id, task_id, author_id, body, deleted_at, created_at`,
      [input.commentId, input.taskId, body],
    )
    const updated = updateResult.rows[0]
    if (!updated) fail(404, 'NOT_FOUND')
    return commentJson(toCommentView(toCommentRow(updated)))
  })
}

export async function deleteComment(input: { orgId: string; actorId: string; taskId: string; commentId: string }): Promise<CommentJson> {
  const task = await loadTask(plainDb, input.taskId, input.orgId)
  await assertRowAbility(plainDb, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy, ability: 'comment' })
  const existing = await loadCommentForTask(input.taskId, input.commentId)
  if (!canDeleteComment({ authorId: existing.authorId, actorId: input.actorId, deleted: existing.deleted })) fail(404, 'NOT_FOUND')
  return transaction(async (client) => {
    const db = wrapClient(client)
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await lockLiveTaskForComment(db, input.taskId, input.orgId)
    const updateResult = await db.query(
      `UPDATE task_comments SET deleted_at = now(), body = NULL, updated_at = now()
       WHERE id = $1 AND task_id = $2 AND deleted_at IS NULL
       RETURNING id, task_id, author_id, body, deleted_at, created_at`,
      [input.commentId, input.taskId],
    )
    const updated = updateResult.rows[0]
    if (!updated) fail(404, 'NOT_FOUND')
    return commentJson(toCommentView(toCommentRow(updated)))
  })
}

// ---------------------------------------------------------------------------
// §3.7 DELETE /api/tasks/:id
// ---------------------------------------------------------------------------

/**
 * Bound on the whole row-lock statement in `deleteTaskById`: a
 * `statement_timeout`, which bounds the statement as a whole, rather than a
 * `lock_timeout`, which would bound each lock wait separately. Past this
 * bound the delete gives up with 409 TASK_BUSY (retryable) and the
 * transaction rolls back, releasing the org lock (M3R2-CONC-1, M3R3-LOCK-1).
 */
const DELETE_ROW_LOCK_TIMEOUT = '3s'

/** SQLSTATEs that mean the bounded row-lock statement gave up:
 * 57014 `query_canceled` (statement_timeout), 55P03 `lock_not_available`. */
const DELETE_ROW_LOCK_BUSY_CODES = new Set(['57014', '55P03'])

/** `FOR UPDATE` on the live task row, taken after the org structure lock and
 * before any read, so the reads below see the row as of the lock
 * (M3R2-CONC-1). Conflicts with the comment writes' `FOR KEY SHARE`; see
 * `lockLiveTaskForComment`. The statement runs under a transaction-local
 * `statement_timeout`; on success the prior value is restored for the rest
 * of the transaction. On failure the transaction is rolled back, which
 * discards the transaction-local setting. */
async function lockTaskRowForDelete(db: Db, taskId: string, orgId: string): Promise<void> {
  if (!isPrintableId(taskId)) fail(404, 'NOT_FOUND')
  const prior = await db.query(`SELECT current_setting('statement_timeout') AS value`)
  const priorValue = String(prior.rows[0]?.value ?? '0')
  await db.query(`SELECT set_config('statement_timeout', $1, true)`, [DELETE_ROW_LOCK_TIMEOUT])
  let rows: Row[]
  try {
    const cond = buildTaskByIdCondition({ taskIdParam: taskId, orgParam: orgId })
    const result = await db.query(`SELECT 1 FROM tasks WHERE ${cond.sql} FOR UPDATE`, cond.params)
    rows = result.rows
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
    if (typeof code === 'string' && DELETE_ROW_LOCK_BUSY_CODES.has(code)) fail(409, 'TASK_BUSY')
    throw err
  }
  await db.query(`SELECT set_config('statement_timeout', $1, true)`, [priorValue])
  if (rows.length === 0) fail(404, 'NOT_FOUND')
}

/**
 * `delete` is decided from `created_by` alone (task B's truth table), and
 * `created_by` never changes after insert. This snapshot read runs before the
 * org lock and the row lock, so a caller without the ability, or an id with
 * no live task, gets the same 404 at once: no lock wait, no TASK_BUSY, no
 * lock taken (M3R3-IN-1). The decision is re-checked after the locks.
 */
async function precheckDeleteAbility(input: { orgId: string; actorId: string; taskId: string }): Promise<void> {
  if (!isPrintableId(input.taskId)) fail(404, 'NOT_FOUND')
  const result = await query<Row>(
    `SELECT created_by FROM tasks WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [input.taskId, input.orgId],
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  const roles = resolveTaskRoles({ createdBy: String(row.created_by), assigneeIds: [], followerIds: [] }, input.actorId)
  if (!can(roles, 'delete')) fail(404, 'NOT_FOUND')
}

export async function deleteTaskById(input: { orgId: string; actorId: string; taskId: string }): Promise<{ id: string; deleted: true }> {
  await precheckDeleteAbility(input)
  const counts = taskCountsSignal()
  const response = await withOrgStructure<{ id: string; deleted: true }>(input.orgId, async (db) => {
    await lockTaskRowForDelete(db, input.taskId, input.orgId)
    const task = await loadTask(db, input.taskId, input.orgId)
    // List roles never grant `delete`; resolved the same way as every other site so the role set
    // here cannot drift from the detail's `canDelete`. The assignee rows come from the same reads
    // (`loadRoles` is this call keeping only the roles).
    const { roles, assignees } = await loadRowRoles(db, { taskId: input.taskId, createdBy: task.createdBy, actorId: input.actorId })
    const childrenResult = await db.query(
      `SELECT id FROM tasks WHERE parent_id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [input.taskId, input.orgId],
    )
    const nodes: TaskDeletionNodes = (() => {
      const map = new Map<string, { parentId: string | null }>()
      map.set(input.taskId, { parentId: task.parentId })
      for (const row of childrenResult.rows) map.set(String(row.id), { parentId: input.taskId })
      return map
    })()
    const plan = planDeleteTask({ taskId: input.taskId, nodes, roles })
    if (plan.ok === false) {
      if (plan.reason === 'has_children') fail(409, 'HAS_CHILDREN')
      fail(404, 'NOT_FOUND')
    }
    // Stamped after the locks are held (M3R2-CONC-5), from the database
    // clock like the comments' `created_at`: `now()` would be the start of
    // this transaction, taken before the waits above, and could read earlier
    // than a comment that was accepted while this delete was queued. One
    // `clock_timestamp()` evaluation is written to `deleted_at` and
    // `updated_at`, and the event copies it from the row, so the value never
    // leaves SQL and keeps its microseconds (M3R3-LOCK-2).
    await db.query(
      `UPDATE tasks AS t SET deleted_at = s.at, updated_at = s.at
       FROM (SELECT clock_timestamp() AS at) AS s
       WHERE t.id = $1`,
      [input.taskId],
    )
    const eventId = newTaskEventId()
    await db.query(
      `INSERT INTO task_events (id, task_id, actor_id, event_type, occurred_at)
       SELECT $1, $2, $3, 'deleted', deleted_at FROM tasks WHERE id = $2`,
      [eventId, input.taskId, input.actorId],
    )
    // M4 PR-3b: outbox rows for the deletion, in this transaction. The producer does not read the
    // task row again, so the soft-deleted task is still notified.
    await enqueueTaskEventNotifications(db, {
      orgId: input.orgId,
      taskId: input.taskId,
      createdBy: task.createdBy,
      events: [{ id: eventId, type: 'deleted', actorId: input.actorId, occurredAt: null }],
    })
    // RULED(2026-10-07): [R16] a deleted task leaves every assignee's badge.
    counts.note({ before: assigneeIds(assignees), after: assigneeIds(assignees) })
    return { id: input.taskId, deleted: true }
  })
  // RULED(2026-10-07): [R16] sent only once the transaction above committed.
  counts.publish()
  return response
}
