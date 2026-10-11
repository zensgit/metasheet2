/**
 * Task lists (M4 PR-3a, design task-m4-pr3a-backend-design-20260930.md §3.2–§3.4, §4.2–§4.6):
 * create, read, "my lists", rename, archive / unarchive, list events (S5); the member roster, add /
 * change role / remove a member (a manager, or a member leaving) and ownership transfer (S6); the
 * list's items: read, add a task, remove a task (S7). Rules come from `src/tasks` (`task-lists.ts`,
 * `task-list-access.ts`, `task-access.ts`, `task-groups.ts`); this module reads rows, calls them
 * and writes. The groups (S8) are in `task-group-records.ts`, which takes the list loading, the
 * ability check, the body field reader and the list event writer from here.
 *
 * Every write runs in `withOrgStructure` ([own-04]). Order inside it: path id (404) → list row by
 * id and org (404) → the caller's member row (no row ⇒ 404, before any ability) → the ability,
 * `canListAction` or, for a removal, `canRemoveListMember` (404) → request body and path user id
 * (422) → member rows → pure transition (the §4.6 org lookup feeds `applyAddMember`, and follows
 * `applyTransferOwner` when the transfer changes something) → write and event. Reads use `plainDb`
 * and the same order without the lock. ASSUMPTION(task-m4): [own-09] every row-level failure is the
 * same 404.
 */
import {
  applyAddMember,
  applyArchive,
  applyChangeMemberRole,
  applyRemoveMember,
  applyRenameList,
  applyTransferOwner,
  applyUnarchive,
  canAddTaskToList,
  canListAction,
  canRemoveListMember,
  canRemoveTaskFromList,
  parseIncludeArchived,
  parseTaskListMemberRole,
  parseTaskListName,
  planAddTaskToList,
  planRemoveTaskFromList,
  type TaskListAction,
  type TaskListCtxRole,
  type TaskListEvent,
  type TaskListMemberAssignableRole,
  type TaskListMemberRole,
  type TaskListMemberRow,
} from '../tasks/task-lists'
import {
  buildTaskListByIdCondition,
  buildTaskListScopeCondition,
  TASK_LIST_EVENT_PAGE_SORT_KEY,
  TASK_LIST_MEMBER_PAGE_SORT_KEY,
  TASK_LIST_PAGE_SORT_KEY,
} from '../tasks/task-list-access'
import { buildTaskInListCondition } from '../tasks/task-access'
import { TASK_DEFAULT_GROUP_NAME } from '../tasks/task-groups'
import { TASK_PAGE_SORT_KEY, type TaskPageParams } from '../tasks/task-pagination'
import { isPrintableId, isValidMemberId } from './task-create'
import { newTaskEventId, newTaskGroupId, newTaskListEventId, newTaskListId } from './task-ids-runtime'
import { enqueueTaskListEventNotifications } from './task-notification-producer'
import { assertActiveOrgMembers, findActiveOrgMembers } from './task-org-members'
import {
  fail,
  loadAssignees,
  loadRowRoles,
  loadTask,
  loadTaskListIds,
  parseTaskPage,
  plainDb,
  withOrgStructure,
  type Db,
  type Row,
} from './task-records'

export interface TaskListJson {
  id: string
  name: string
  createdBy: string
  ownerId: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  myRole: TaskListMemberRole
}

export interface TaskListEventJson {
  id: string
  listId: string
  actorId: string
  eventType: string
  payload: unknown
  occurredAt: string
}

/** Columns of the `List` shape; `actorPlaceholder` binds the acting user. */
function listColumns(actorPlaceholder: string): string {
  return `task_lists.id, task_lists.name, task_lists.created_by, task_lists.archived_at,
  task_lists.created_at, task_lists.updated_at,
  (SELECT tlm_owner.user_id FROM task_list_members tlm_owner
     WHERE tlm_owner.list_id = task_lists.id AND tlm_owner.role = 'owner') AS owner_id,
  (SELECT tlm_role.role FROM task_list_members tlm_role
     WHERE tlm_role.list_id = task_lists.id AND tlm_role.user_id = ${actorPlaceholder}) AS my_role`
}

function isoOf(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString()
}

function isoOrNullOf(value: unknown): string | null {
  return value === null || value === undefined ? null : isoOf(value)
}

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value : new Date(String(value))
}

function toListJson(row: Row): TaskListJson {
  return {
    id: String(row.id),
    name: String(row.name),
    createdBy: String(row.created_by),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    archivedAt: isoOrNullOf(row.archived_at),
    createdAt: isoOf(row.created_at),
    updatedAt: isoOf(row.updated_at),
    myRole: String(row.my_role) as TaskListMemberRole,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function bodyName(body: unknown): unknown {
  return isPlainObject(body) ? body.name : undefined
}

function parseNameOrFail(body: unknown): string {
  const parsed = parseTaskListName(bodyName(body))
  if (parsed.ok === false) fail(422, parsed.reason.toUpperCase())
  return parsed.name
}

export interface LoadedList {
  row: Row
  role: TaskListCtxRole
  createdBy: string
}

/**
 * The list `listId` of `orgId` with `actorId`'s role on it, `'none'` without a member row. 404 when
 * the id cannot be stored or the list is not in the org. Callers decide what a `'none'` caller may
 * do; nothing about the list may reach a response before they have.
 */
async function loadOrgList(db: Db, input: { orgId: string; actorId: string; listId: string }): Promise<LoadedList> {
  if (!isPrintableId(input.listId)) fail(404, 'NOT_FOUND')
  const cond = buildTaskListByIdCondition({ listIdParam: input.listId, orgParam: input.orgId })
  const result = await db.query(
    `SELECT ${listColumns('$3')} FROM task_lists WHERE ${cond.sql}`,
    [...cond.params, input.actorId],
  )
  const row = result.rows[0]
  if (!row) fail(404, 'NOT_FOUND')
  const role: TaskListCtxRole = row.my_role === null || row.my_role === undefined
    ? 'none'
    : String(row.my_role) as TaskListMemberRole
  return { row, role, createdBy: String(row.created_by) }
}

/**
 * The list `listId` of `orgId` as seen by `actorId`. 404 when the id cannot be stored, the list is
 * not in the org, or the caller has no member row. Nothing about the list leaves this function on
 * those paths.
 */
export async function loadMemberList(db: Db, input: { orgId: string; actorId: string; listId: string }): Promise<LoadedList> {
  const list = await loadOrgList(db, input)
  // List membership is the first row-level decision on every list route (design §3.0).
  if (list.role === 'none') fail(404, 'NOT_FOUND')
  return list
}

export function assertListAction(list: LoadedList, actorId: string, action: TaskListAction): void {
  if (!canListAction({ role: list.role, isCreator: list.createdBy === actorId }, action)) fail(404, 'NOT_FOUND')
}

/**
 * Where a list event's `occurred_at` comes from (design §4.4). Every list write takes its instant in
 * SQL, after the org structure lock is held: `now()` is the transaction start, read before the lock
 * wait, so a write that queued behind another would carry an earlier instant than the write that
 * committed before it. The instant never leaves SQL, so it keeps its microseconds.
 * - `list`: the list row's `updated_at`, which this write has just stamped (create, rename, archive,
 *   unarchive), so the row and its event are one instant;
 * - `clock`: one `clock_timestamp()` reading, for a write that stamps no list row (the member
 *   writes, and an item removal, whose task-side event then copies this event's instant);
 * - `item`: the `created_at` of the item row this write has just inserted (an item added);
 * - `group`: the `updated_at` of the group row this write has just stamped (a list-scope group
 *   created or renamed, S8).
 */
export type ListEventAt = { from: 'list' } | { from: 'clock' } | { from: 'item'; taskId: string } | { from: 'group'; groupId: string }

/** Writes one `task_list_events` row and returns its id. */
export async function writeListEvent(
  db: Db,
  input: { listId: string; actorId: string; type: string; payload: Record<string, unknown>; at: ListEventAt },
): Promise<string> {
  // ASSUMPTION(task-m4): [own-36] created / renamed / archived / unarchived carry payload `{}`;
  // the member and transfer events carry `{ targetUserId }` (design §4.3); the item events
  // `{ taskId }` (design §3.4); the group events `{ groupId }` (design §4.3).
  const id = newTaskListEventId()
  const params: unknown[] = [id, input.listId, input.actorId, input.type, JSON.stringify(input.payload)]
  const columns = 'INSERT INTO task_list_events (id, list_id, actor_id, event_type, payload, occurred_at)'
  if (input.at.from === 'list') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4, $5::jsonb, updated_at FROM task_lists WHERE id = $2`, params)
  } else if (input.at.from === 'item') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4, $5::jsonb, created_at FROM task_list_items WHERE list_id = $2 AND task_id = $6`,
    [...params, input.at.taskId])
  } else if (input.at.from === 'group') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4, $5::jsonb, updated_at FROM task_groups WHERE id = $6 AND list_id = $2`,
    [...params, input.at.groupId])
  } else {
    await db.query(`${columns}
       VALUES ($1, $2, $3, $4, $5::jsonb, clock_timestamp())`, params)
  }
  return id
}

async function reloadList(db: Db, input: { orgId: string; actorId: string; listId: string }): Promise<TaskListJson> {
  return toListJson((await loadMemberList(db, input)).row)
}

/**
 * `POST /api/task-lists`. The name is checked before the transaction opens. One transaction writes
 * the list, the caller's `owner` row, the list's default group and the `created` event. One
 * `clock_timestamp()` reading after the lock stamps the list row; the owner row, the default group
 * and the event copy it from the row, so the four are one instant (design §4.4).
 */
export async function createTaskList(input: { orgId: string; actorId: string; body: unknown }): Promise<TaskListJson> {
  const name = parseNameOrFail(input.body)
  const listId = newTaskListId()
  return withOrgStructure(input.orgId, async (db) => {
    await db.query(
      `INSERT INTO task_lists (id, org_id, name, created_by, created_at, updated_at)
       SELECT $1, $2, $3, $4, s.at, s.at FROM (SELECT clock_timestamp() AS at) AS s`,
      [listId, input.orgId, name, input.actorId],
    )
    await db.query(
      `INSERT INTO task_list_members (list_id, user_id, role, created_at)
       SELECT $1, $2, 'owner', created_at FROM task_lists WHERE id = $1`,
      [listId, input.actorId],
    )
    // RULED(2026-10-07): [R11] one default group per list. ASSUMPTION(task-m4): [own-12] it is
    // created with the list.
    await db.query(
      `INSERT INTO task_groups (id, org_id, scope, list_id, name, position, is_default, created_at, updated_at)
       SELECT $1, $2, 'list', $3, $4, 0, true, created_at, created_at FROM task_lists WHERE id = $3`,
      [newTaskGroupId(), input.orgId, listId, TASK_DEFAULT_GROUP_NAME],
    )
    await writeListEvent(db, { listId, actorId: input.actorId, type: 'created', payload: {}, at: { from: 'list' } })
    return reloadList(db, { orgId: input.orgId, actorId: input.actorId, listId })
  })
}

/** `GET /api/task-lists/:id`. */
export async function getTaskList(input: { orgId: string; actorId: string; listId: string }): Promise<TaskListJson> {
  const list = await loadMemberList(plainDb, input)
  assertListAction(list, input.actorId, 'view')
  return toListJson(list.row)
}

/**
 * `GET /api/task-lists`: the caller's lists. ASSUMPTION(task-m4): [own-10] [own-32] the page is
 * parsed first, then `includeArchived`; either failing is 422 before anything is read.
 */
export async function listTaskLists(input: {
  orgId: string
  actorId: string
  query: { limit?: unknown; offset?: unknown; includeArchived?: unknown }
}): Promise<{ items: TaskListJson[]; total: number }> {
  const page: TaskPageParams = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const filter = parseIncludeArchived(input.query.includeArchived)
  if (filter.ok === false) fail(422, 'INVALID_FILTER')
  const cond = buildTaskListScopeCondition({
    actorParam: input.actorId,
    orgParam: input.orgId,
    includeArchived: filter.includeArchived,
  })
  const n = cond.params.length + 1
  const rows = await plainDb.query(
    `SELECT ${listColumns('$1')} FROM task_lists WHERE ${cond.sql}
     ORDER BY ${TASK_LIST_PAGE_SORT_KEY} LIMIT $${n} OFFSET $${n + 1}`,
    [...cond.params, page.limit, page.offset],
  )
  const counted = await plainDb.query(
    `SELECT count(*)::text AS n FROM task_lists WHERE ${cond.sql}`,
    cond.params,
  )
  return { items: rows.rows.map(toListJson), total: Number(counted.rows[0]?.n ?? 0) }
}

/** `PATCH /api/task-lists/:id` `{ name }`. The same name is a no-op. */
export async function renameTaskList(input: {
  orgId: string
  actorId: string
  listId: string
  body: unknown
}): Promise<TaskListJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, 'rename')
    const name = parseNameOrFail(input.body)
    const plan = applyRenameList({ currentName: String(list.row.name), name, actorId: input.actorId })
    if (!plan.changed) return toListJson(list.row)
    // One clock_timestamp() reading after the lock; the event copies it from the row (design §4.4).
    await db.query(
      `UPDATE task_lists AS l SET name = $2, updated_at = s.at
       FROM (SELECT clock_timestamp() AS at) AS s
       WHERE l.id = $1`,
      [input.listId, plan.name],
    )
    for (const event of plan.events) {
      await writeListEvent(db, { listId: input.listId, actorId: event.userId, type: event.type, payload: {}, at: { from: 'list' } })
    }
    return reloadList(db, input)
  })
}

/**
 * `POST /api/task-lists/:id/archive` and `/unarchive`. Already in the requested state is a no-op.
 * `archived_at` (when archiving), `updated_at` and the event's `occurred_at` are one
 * `clock_timestamp()` reading taken in the UPDATE, after the lock (design §4.4).
 */
export async function setTaskListArchived(input: {
  orgId: string
  actorId: string
  listId: string
  archived: boolean
}): Promise<TaskListJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, input.archived ? 'archive' : 'unarchive')
    const archivedAt = dateOrNull(list.row.archived_at)
    // The pure transitions decide whether the state changes and which event is written. The `now`
    // that `applyArchive` takes only completes its input: the stored instant is the SQL reading
    // below, and the plan's `archivedAt` value is never written.
    const plan = input.archived
      ? applyArchive({ archivedAt, now: new Date(), actorId: input.actorId })
      : applyUnarchive({ archivedAt, actorId: input.actorId })
    if (plan.events.length === 0) return toListJson(list.row)
    await db.query(
      `UPDATE task_lists AS l SET archived_at = ${plan.archivedAt === null ? 'NULL' : 's.at'}, updated_at = s.at
       FROM (SELECT clock_timestamp() AS at) AS s
       WHERE l.id = $1`,
      [input.listId],
    )
    for (const event of plan.events) {
      const eventId = await writeListEvent(db, { listId: input.listId, actorId: event.userId, type: event.type, payload: {}, at: { from: 'list' } })
      // M4 PR-3b: outbox rows for the list event, in this transaction (only `archived` notifies).
      await enqueueTaskListEventNotifications(db, {
        orgId: input.orgId,
        listId: input.listId,
        listCreatorId: list.createdBy,
        actorId: event.userId,
        event: { id: eventId, type: event.type },
      })
    }
    return reloadList(db, input)
  })
}

/**
 * `GET /api/task-lists/:id/events`. RULED(2026-10-07): [R19] members read the list's events,
 * paged. ASSUMPTION(task-m4): [own-33] the list is resolved (404) before the page is parsed (422),
 * the order M3 uses for a task's comments.
 */
export async function listTaskListEvents(input: {
  orgId: string
  actorId: string
  listId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskListEventJson[]; total: number }> {
  const list = await loadMemberList(plainDb, input)
  assertListAction(list, input.actorId, 'view')
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const rows = await plainDb.query(
    `SELECT id, list_id, actor_id, event_type, payload, occurred_at FROM task_list_events
     WHERE list_id = $1 ORDER BY ${TASK_LIST_EVENT_PAGE_SORT_KEY} LIMIT $2 OFFSET $3`,
    [input.listId, page.limit, page.offset],
  )
  const counted = await plainDb.query(
    `SELECT count(*)::text AS n FROM task_list_events WHERE list_id = $1`,
    [input.listId],
  )
  return {
    items: rows.rows.map((row) => ({
      id: String(row.id),
      listId: String(row.list_id),
      actorId: String(row.actor_id),
      eventType: String(row.event_type),
      payload: row.payload ?? {},
      occurredAt: isoOf(row.occurred_at),
    })),
    total: Number(counted.rows[0]?.n ?? 0),
  }
}

// ---------------------------------------------------------------------------------------------
// Members and ownership (S6, design §3.3, §4.3, §4.6)
// ---------------------------------------------------------------------------------------------

export interface TaskListMemberJson {
  userId: string
  role: TaskListMemberRole
}

/** The body of every member write: the list id and the roster after the write. */
export interface TaskListMembersJson {
  id: string
  members: TaskListMemberJson[]
}

export interface TaskListMemberItemJson extends TaskListMemberJson {
  createdAt: string
}

export function bodyField(body: unknown, key: string): unknown {
  return isPlainObject(body) ? body[key] : undefined
}

/** `isValidMemberId` (`task-create.ts`) is the one validator for every member-id ingress (M3's
 * assignee and follower routes, and the member routes here); here it answers `INVALID_MEMBER`. */
function requireMemberId(value: unknown): string {
  if (!isValidMemberId(value)) fail(422, 'INVALID_MEMBER')
  return value
}

/** The role a caller may assign: `parseTaskListMemberRole` rejects `owner` (R12: only a transfer
 * makes an owner) and everything outside the closed set, as `INVALID_ROLE`. */
function parseRoleOrFail(raw: unknown): TaskListMemberAssignableRole {
  const parsed = parseTaskListMemberRole(raw)
  if (parsed.ok === false) fail(422, parsed.reason.toUpperCase())
  return parsed.role
}

/** Every member row of the list, read on the caller's connection (after the lock on writes). */
async function loadMembers(db: Db, listId: string): Promise<TaskListMemberRow[]> {
  const result = await db.query(`SELECT user_id, role FROM task_list_members WHERE list_id = $1`, [listId])
  return result.rows.map((row) => ({ userId: String(row.user_id), role: String(row.role) as TaskListMemberRole }))
}

function byUserId(a: { userId: string }, b: { userId: string }): number {
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
}

// ASSUMPTION(task-m4): [own-40] the roster is ordered by `userId` in byte order, as the assignee
// roster of `task-structure.ts` (`membershipResponse`).
function membersJson(listId: string, members: TaskListMemberRow[]): TaskListMembersJson {
  return { id: listId, members: [...members].sort(byUserId).map((m) => ({ userId: m.userId, role: m.role })) }
}

/** The member and transfer events: a member write stamps no list row, so each event takes one
 * `clock_timestamp()` reading after the lock (design §4.4). */
async function writeListEvents(db: Db, listId: string, events: TaskListEvent[]): Promise<void> {
  for (const event of events) {
    await writeListEvent(db, {
      listId,
      actorId: event.userId,
      type: event.type,
      payload: event.targetUserId === undefined ? {} : { targetUserId: event.targetUserId },
      at: { from: 'clock' },
    })
  }
}

/**
 * `GET /api/task-lists/:id/members`. ASSUMPTION(task-m4): [own-42] as the events route ([own-33]):
 * the list is resolved for a member first (404), then the page is parsed (422); no org claim is 404
 * at the route. [own-40] `user_id` in byte order.
 */
export async function listTaskListMembers(input: {
  orgId: string
  actorId: string
  listId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskListMemberItemJson[]; total: number }> {
  const list = await loadMemberList(plainDb, input)
  assertListAction(list, input.actorId, 'view')
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const rows = await plainDb.query(
    `SELECT user_id, role, created_at FROM task_list_members
     WHERE list_id = $1 ORDER BY ${TASK_LIST_MEMBER_PAGE_SORT_KEY} LIMIT $2 OFFSET $3`,
    [input.listId, page.limit, page.offset],
  )
  const counted = await plainDb.query(
    `SELECT count(*)::text AS n FROM task_list_members WHERE list_id = $1`,
    [input.listId],
  )
  return {
    items: rows.rows.map((row) => ({
      userId: String(row.user_id),
      role: String(row.role) as TaskListMemberRole,
      createdAt: isoOf(row.created_at),
    })),
    total: Number(counted.rows[0]?.n ?? 0),
  }
}

/**
 * `POST /api/task-lists/:id/members` `{ userId, role }`. ASSUMPTION(task-m4): [own-41] after the
 * ability check, the member id is checked before the role (the other member routes take the id from
 * the path, which is read before the body; the same order here). RULED(2026-10-07): [R17] the org
 * lookup runs inside the transaction and its answer is `applyAddMember`'s `isActiveInOrg`; that
 * function's own order (role, existing member, active, limit) decides, so re-adding an existing
 * member is a no-op whatever the lookup said. ASSUMPTION(task-m4): [own-16] the caller's own status
 * never decides anything: the caller is a member already, so naming themselves is that no-op
 * whatever the lookup answers.
 */
export async function addTaskListMember(input: {
  orgId: string
  actorId: string
  listId: string
  body: unknown
}): Promise<TaskListMembersJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, 'manage_members')
    const userId = requireMemberId(bodyField(input.body, 'userId'))
    const role = parseRoleOrFail(bodyField(input.body, 'role'))
    const members = await loadMembers(db, input.listId)
    const isActiveInOrg = (await findActiveOrgMembers(db, input.orgId, [userId])).has(userId)
    const plan = applyAddMember({ members, userId, role, actorId: input.actorId, isActiveInOrg })
    if (plan.ok === false) fail(422, plan.reason.toUpperCase())
    if (plan.events.length > 0) {
      await db.query(
        `INSERT INTO task_list_members (list_id, user_id, role) VALUES ($1, $2, $3)`,
        [input.listId, userId, role],
      )
      await writeListEvents(db, input.listId, plan.events)
    }
    return membersJson(input.listId, plan.members)
  })
}

/**
 * `PATCH /api/task-lists/:id/members/:userId` `{ role }`. A target that is not a member is the same
 * 404 as a missing list ([own-09]); the owner's role moves only by transfer (R12,
 * `OWNER_MUST_TRANSFER`); the same role is a no-op.
 */
export async function changeTaskListMemberRole(input: {
  orgId: string
  actorId: string
  listId: string
  userId: string
  body: unknown
}): Promise<TaskListMembersJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, 'manage_members')
    const userId = requireMemberId(input.userId)
    const role = parseRoleOrFail(bodyField(input.body, 'role'))
    const members = await loadMembers(db, input.listId)
    const plan = applyChangeMemberRole({ members, userId, role, actorId: input.actorId })
    if (plan.ok === false) {
      if (plan.reason === 'not_found') fail(404, 'NOT_FOUND')
      fail(422, plan.reason.toUpperCase())
    }
    if (plan.events.length > 0) {
      await db.query(
        `UPDATE task_list_members SET role = $3 WHERE list_id = $1 AND user_id = $2`,
        [input.listId, userId, role],
      )
      await writeListEvents(db, input.listId, plan.events)
    }
    return membersJson(input.listId, plan.members)
  })
}

/**
 * `DELETE /api/task-lists/:id/members/:userId`: a manager removing a member, or a member leaving.
 * Order after the lock (design §3.3): the list by org (404); the caller's member row (404);
 * [own-14] `canRemoveListMember` (404, so a non-member naming themselves gets the missing-list
 * answer and no roster is read); the path id (422 `INVALID_MEMBER`); `applyRemoveMember` (the
 * creator and the owner are 422). A target that is not a member is a no-op.
 */
export async function removeTaskListMember(input: {
  orgId: string
  actorId: string
  listId: string
  userId: string
}): Promise<TaskListMembersJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    if (!canRemoveListMember({ role: list.role, isSelf: input.userId === input.actorId })) fail(404, 'NOT_FOUND')
    const userId = requireMemberId(input.userId)
    const members = await loadMembers(db, input.listId)
    const plan = applyRemoveMember({ members, userId, actorId: input.actorId, createdBy: list.createdBy })
    if (plan.ok === false) fail(422, plan.reason.toUpperCase())
    if (plan.events.length > 0) {
      await db.query(`DELETE FROM task_list_members WHERE list_id = $1 AND user_id = $2`, [input.listId, userId])
      await writeListEvents(db, input.listId, plan.events)
    }
    return membersJson(input.listId, plan.members)
  })
}

/**
 * `POST /api/task-lists/:id/transfer-owner` `{ userId }`: the owner hands the list to a member;
 * the former owner becomes `edit` (R12). The current owner as target is a no-op. [own-27] [R17] a
 * transfer that changes something checks the target is active in the org and writes nothing when
 * not. The two role updates run demote-then-promote: `uq_tlsm_owner` is a non-deferrable partial
 * unique index, so promoting first would fail (design §3.3).
 */
export async function transferTaskListOwner(input: {
  orgId: string
  actorId: string
  listId: string
  body: unknown
}): Promise<TaskListMembersJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, 'transfer_owner')
    const toUserId = requireMemberId(bodyField(input.body, 'userId'))
    const members = await loadMembers(db, input.listId)
    const plan = applyTransferOwner({ members, fromUserId: input.actorId, toUserId, actorId: input.actorId })
    if (plan.ok === false) fail(422, plan.reason.toUpperCase())
    if (plan.events.length > 0) {
      await assertActiveOrgMembers(db, input.orgId, [toUserId])
      await db.query(
        `UPDATE task_list_members SET role = 'edit' WHERE list_id = $1 AND user_id = $2`,
        [input.listId, input.actorId],
      )
      await db.query(
        `UPDATE task_list_members SET role = 'owner' WHERE list_id = $1 AND user_id = $2`,
        [input.listId, toUserId],
      )
      await writeListEvents(db, input.listId, plan.events)
    }
    return membersJson(input.listId, plan.members)
  })
}

// ---------------------------------------------------------------------------------------------
// List items (S7, design §3.4, §4.3, §4.4)
// ---------------------------------------------------------------------------------------------

/** The body of both item writes. */
export interface TaskListItemJson {
  listId: string
  taskId: string
}

// ASSUMPTION(task-m4): [own-44] the body's `taskId` is a string that can be an id (printable
// ASCII, the shape every stored task id has); anything else, a missing key included, is 422
// INVALID_TASK.
function requireTaskId(value: unknown): string {
  if (!isPrintableId(value)) fail(422, 'INVALID_TASK')
  return value
}

/** The live task `taskId` of `orgId` (404 otherwise) and the holders of its direct roles. */
async function loadItemTask(db: Db, taskId: string, orgId: string): Promise<{ createdBy: string; assigneeIds: string[]; followerIds: string[] }> {
  const task = await loadTask(db, taskId, orgId)
  const assignees = await loadAssignees(db, taskId)
  const followers = await db.query(`SELECT user_id FROM task_followers WHERE task_id = $1`, [taskId])
  return {
    createdBy: task.createdBy,
    assigneeIds: assignees.map((row) => row.userId),
    followerIds: followers.rows.map((row) => String(row.user_id)),
  }
}

/**
 * The task-side event of an item write (`list_added` / `list_removed`, payload `{ listId }`,
 * design §3.4) at the instant of the same write: the item row's `created_at` when the write added
 * it, otherwise the `occurred_at` of the list-side event the write has just written.
 */
async function writeTaskItemEvent(
  db: Db,
  input: { taskId: string; actorId: string; type: string; listId: string; at: { from: 'item' } | { from: 'list_event'; eventId: string } },
): Promise<void> {
  const params: unknown[] = [newTaskEventId(), input.taskId, input.actorId, input.type, JSON.stringify({ listId: input.listId })]
  const columns = 'INSERT INTO task_events (id, task_id, actor_id, event_type, payload, occurred_at)'
  if (input.at.from === 'item') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4, $5::jsonb, created_at FROM task_list_items WHERE task_id = $2 AND list_id = $6`,
    [...params, input.listId])
  } else {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4, $5::jsonb, occurred_at FROM task_list_events WHERE id = $6`,
    [...params, input.at.eventId])
  }
}

/**
 * `GET /api/task-lists/:id/items`: the list's live tasks, with the item columns of `GET /api/tasks`.
 * ASSUMPTION(task-m4): [own-43] as the events and roster reads: the list is resolved for a member
 * first (404), then the page is parsed (422); no org claim is 404 at the route. The order is the
 * task page order (`TASK_PAGE_SORT_KEY`); `total` is the unpaged count under the same condition.
 */
export async function listTaskListItems(input: {
  orgId: string
  actorId: string
  listId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: Row[]; total: number }> {
  const list = await loadMemberList(plainDb, input)
  assertListAction(list, input.actorId, 'view')
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const cond = buildTaskInListCondition({ listIdParam: input.listId, orgParam: input.orgId })
  const n = cond.params.length + 1
  const rows = await plainDb.query(
    `SELECT id, title, status, completion_mode, created_by, due_at FROM tasks WHERE ${cond.sql}
     ORDER BY ${TASK_PAGE_SORT_KEY} LIMIT $${n} OFFSET $${n + 1}`,
    [...cond.params, page.limit, page.offset],
  )
  const counted = await plainDb.query(`SELECT count(*)::text AS n FROM tasks WHERE ${cond.sql}`, cond.params)
  return { items: rows.rows, total: Number(counted.rows[0]?.n ?? 0) }
}

/**
 * `POST /api/task-lists/:id/items` `{ taskId }`. Order after the lock (design §3.4, §4.3): the list
 * for a member (404) → the list's `add_item` (404, so a member without it never reaches the body)
 * → [own-44] the body's `taskId` (422 INVALID_TASK) → the live task by id and org (404) →
 * `canAddTaskToList`, direct roles only (404) → `planAddTaskToList` over every list holding the
 * task: already there ⇒ no-op, [own-47] the D14 quota ⇒ 422 LIMIT. Both come after the task-side
 * checks (the live task, then `canAddTaskToList`). The item row's `org_id` is the
 * org both rows were read with ([own-37]; the composite foreign keys refuse any other). One
 * `clock_timestamp()` reading after the lock stamps the item row; both events copy it.
 */
export async function addTaskToList(input: {
  orgId: string
  actorId: string
  listId: string
  body: unknown
}): Promise<TaskListItemJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const list = await loadMemberList(db, input)
    assertListAction(list, input.actorId, 'add_item')
    const taskId = requireTaskId(bodyField(input.body, 'taskId'))
    const task = await loadItemTask(db, taskId, input.orgId)
    if (!canAddTaskToList({ listRole: list.role, task, me: input.actorId })) fail(404, 'NOT_FOUND')
    const plan = planAddTaskToList({
      currentListIds: await loadTaskListIds(db, taskId),
      listId: input.listId,
      actorId: input.actorId,
    })
    if (plan.ok === false) fail(422, plan.reason.toUpperCase())
    if (plan.changed) {
      await db.query(
        `INSERT INTO task_list_items (list_id, task_id, org_id, created_at)
         SELECT $1, $2, $3, s.at FROM (SELECT clock_timestamp() AS at) AS s`,
        [input.listId, taskId, input.orgId],
      )
      for (const event of plan.listEvents) {
        await writeListEvent(db, { listId: input.listId, actorId: event.userId, type: event.type, payload: { taskId }, at: { from: 'item', taskId } })
      }
      for (const event of plan.taskEvents) {
        await writeTaskItemEvent(db, { taskId, actorId: event.userId, type: event.type, listId: input.listId, at: { from: 'item' } })
      }
    }
    return { listId: input.listId, taskId }
  })
}

/**
 * `DELETE /api/task-lists/:id/items/:taskId`. Allowed by `canRemoveTaskFromList`: a member with
 * `remove_item` who has `edit` on the task (list identity counts), or [own-25] (a2) the task's
 * creator, member or not, when the task is an item of the list.
 * ASSUMPTION(task-m4): [own-45] the list is read by id and org without requiring a member row, and
 * nothing about it reaches the response before the predicate passes: path ids that cannot be
 * stored, a list that does not exist or is in another org, a task that is missing, deleted or in
 * another org, and a caller neither way allows all get the same 404. A member's request for a task
 * that is not in the list is a no-op; the creator's never is (no item, no way in). In the same
 * transaction the task leaves this list's groups (design §3.4). The list-side event takes one
 * `clock_timestamp()` reading after the lock; the task-side event copies it.
 */
export async function removeTaskFromList(input: {
  orgId: string
  actorId: string
  listId: string
  taskId: string
}): Promise<TaskListItemJson> {
  return withOrgStructure(input.orgId, async (db) => {
    // Each loader answers 404 for an id that cannot be stored before any statement carries it.
    const list = await loadOrgList(db, input)
    const task = await loadTask(db, input.taskId, input.orgId)
    const { roles } = await loadRowRoles(db, { taskId: input.taskId, actorId: input.actorId, createdBy: task.createdBy })
    const currentListIds = await loadTaskListIds(db, input.taskId)
    const allowed = canRemoveTaskFromList({
      listRole: list.role,
      taskRoles: roles,
      isTaskCreator: task.createdBy === input.actorId,
      itemExists: currentListIds.includes(input.listId),
    })
    if (!allowed) fail(404, 'NOT_FOUND')
    const plan = planRemoveTaskFromList({ currentListIds, listId: input.listId, actorId: input.actorId })
    if (plan.changed) {
      await db.query(`DELETE FROM task_list_items WHERE list_id = $1 AND task_id = $2`, [input.listId, input.taskId])
      await db.query(
        `DELETE FROM task_group_items gi USING task_groups g
          WHERE gi.group_id = g.id AND g.list_id = $1 AND gi.task_id = $2`,
        [input.listId, input.taskId],
      )
      let listEventId = ''
      for (const event of plan.listEvents) {
        listEventId = await writeListEvent(db, {
          listId: input.listId, actorId: event.userId, type: event.type, payload: { taskId: input.taskId }, at: { from: 'clock' },
        })
      }
      for (const event of plan.taskEvents) {
        await writeTaskItemEvent(db, {
          taskId: input.taskId, actorId: event.userId, type: event.type, listId: input.listId, at: { from: 'list_event', eventId: listEventId },
        })
      }
    }
    return { listId: input.listId, taskId: input.taskId }
  })
}
