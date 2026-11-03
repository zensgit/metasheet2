/**
 * Task groups (M4 PR-3a S8, design task-m4-pr3a-backend-design-20260930.md §3.5, §4.2–§4.5). Two
 * scopes, one container each: the groups of one list (`/api/task-lists/:id/groups…`, placing the
 * list's items) and one user's personal groups in one org (`/api/task-groups…`, placing the tasks
 * on that user's assigned arm). Rules come from `src/tasks` (`task-groups.ts`,
 * `task-list-access.ts`, `task-access.ts`, `task-lists.ts`); this module reads rows, calls them and
 * writes.
 *
 * Every write runs in `withOrgStructure` ([own-04]) and re-reads after the lock every row it
 * depends on. A write stamps its rows with one `clock_timestamp()` reading taken after the lock;
 * the other rows and the events of the same write copy that reading from the row (design §4.4).
 *
 * RULED(2026-10-07): [R11] residual placements are not deleted and reads and writes filter by the
 * visible set. ASSUMPTION(task-m4): [own-13] the visible set of a container is defined once and
 * shared by reads and writes: the list's live items (`buildTaskInListCondition`), or the live tasks on the
 * user's assigned arm (`buildTaskScopeCondition({ view: 'assigned' })`). Placement rows outside it
 * (a deleted task, an assignment taken away) are kept: reads leave them out and number the rest
 * densely, and a placement write moves them after the visible rows of the group it rewrites.
 * ASSUMPTION(task-m4): [own-09] every row-level failure is the same 404.
 */
import {
  buildTaskInListCondition,
  buildTaskScopeCondition,
  type TaskScopeCondition,
} from '../tasks/task-access'
import {
  applyCreateGroup,
  applyDeleteGroup,
  applyMoveItem,
  applyRenameGroup,
  parseTargetGroupId,
  parseTaskGroupName,
  planGroupItemOrder,
  planGroupPositionsAfterDelete,
  TASK_DEFAULT_GROUP_NAME,
  userGroupsWithDefault,
  type TaskGroupScope,
  type TaskGroupView,
} from '../tasks/task-groups'
import {
  buildTaskListGroupScopeCondition,
  buildTaskUserGroupScopeCondition,
  TASK_GROUP_ITEM_ORDER_KEY,
  TASK_GROUP_PAGE_SORT_KEY,
  TASK_GROUP_PLACEMENT_PAGE_SORT_KEY,
  type TaskListCondition,
} from '../tasks/task-list-access'
import type { TaskListAction } from '../tasks/task-lists'
import type { TaskPageParams } from '../tasks/task-pagination'
import { isPrintableId } from './task-create'
import { newTaskEventId, newTaskGroupId } from './task-ids-runtime'
import { assertListAction, bodyField, loadMemberList, writeListEvent } from './task-list-records'
import { fail, parseTaskPage, plainDb, withOrgStructure, type Db } from './task-records'

/** One placement: the task's group and its dense index among the group's visible rows. */
export interface TaskGroupPlacementJson {
  groupId: string
  taskId: string
  position: number
}

export interface TaskGroupDeletedJson {
  id: string
  deleted: true
  reassignedTo: string
}

type Container =
  | { scope: 'list'; orgId: string; listId: string }
  | { scope: 'user'; orgId: string; userId: string }

interface GroupRow {
  id: string
  name: string
  position: number
  isDefault: boolean
}

/** Where a new row's instant comes from: one `clock_timestamp()` reading, or the `created_at` of a
 * group row this write has just inserted (design §4.4). */
type InstantSource = { from: 'clock' } | { from: 'group'; groupId: string }

/** The container's groups (`task_groups.org_id` through the builder's single org clause). */
function groupCondition(container: Container): TaskListCondition {
  return container.scope === 'list'
    ? buildTaskListGroupScopeCondition({ listIdParam: container.listId, orgParam: container.orgId })
    : buildTaskUserGroupScopeCondition({ userParam: container.userId, orgParam: container.orgId })
}

/** The container's visible set. It binds the same two values as `groupCondition` ($1 = the list or
 * the user, $2 = the org), so a query may AND the two over one parameter list. */
function visibleCondition(container: Container): TaskScopeCondition {
  return container.scope === 'list'
    ? buildTaskInListCondition({ listIdParam: container.listId, orgParam: container.orgId })
    : buildTaskScopeCondition({ view: 'assigned', actorParam: container.userId, orgParam: container.orgId })
}

function userContainer(input: { orgId: string; actorId: string }): Container {
  return { scope: 'user', orgId: input.orgId, userId: input.actorId }
}

/** A list container for a caller holding `action` on the list: the list by id and org, the caller's
 * member row, then the ability; each failure is the 404 of a missing list. */
async function listContainer(
  db: Db,
  input: { orgId: string; actorId: string; listId: string },
  action: TaskListAction,
): Promise<Container> {
  const list = await loadMemberList(db, input)
  assertListAction(list, input.actorId, action)
  return { scope: 'list', orgId: input.orgId, listId: input.listId }
}

function toGroupView(scope: TaskGroupScope, row: GroupRow): TaskGroupView {
  return { id: row.id, scope, name: row.name, position: row.position, isDefault: row.isDefault }
}

function toGroupRow(row: Record<string, unknown>): GroupRow {
  return { id: String(row.id), name: String(row.name), position: Number(row.position), isDefault: row.is_default === true }
}

/** Every group of the container, in page order, read on `db` (after the lock on writes). */
async function loadGroups(db: Db, container: Container): Promise<GroupRow[]> {
  const cond = groupCondition(container)
  const result = await db.query(
    `SELECT task_groups.id, task_groups.name, task_groups.position, task_groups.is_default
       FROM task_groups WHERE ${cond.sql} ORDER BY ${TASK_GROUP_PAGE_SORT_KEY}`,
    cond.params,
  )
  return result.rows.map(toGroupRow)
}

/** The group `groupId` of the container, or the 404 of a missing group. */
function requireGroup(groups: GroupRow[], groupId: string): GroupRow {
  const group = isPrintableId(groupId) ? groups.find((row) => row.id === groupId) : undefined
  if (!group) fail(404, 'NOT_FOUND')
  return group
}

function parseGroupNameOrFail(body: unknown): string {
  const parsed = parseTaskGroupName(bodyField(body, 'name'))
  if (parsed.ok === false) fail(422, parsed.reason.toUpperCase())
  return parsed.name
}

async function insertGroup(
  db: Db,
  container: Container,
  group: { id: string; name: string; position: number; isDefault: boolean },
  at: InstantSource,
): Promise<void> {
  // ASSUMPTION(task-m4): [own-37] a list-scope group carries the org its list was read with; the
  // composite foreign key (list_id, org_id) refuses any other.
  const params: unknown[] = [
    group.id,
    container.orgId,
    container.scope,
    container.scope === 'list' ? container.listId : null,
    container.scope === 'user' ? container.userId : null,
    group.name,
    group.position,
    group.isDefault,
  ]
  const columns = 'INSERT INTO task_groups (id, org_id, scope, list_id, user_id, name, position, is_default, created_at, updated_at)'
  if (at.from === 'group') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4::text, $5::text, $6, $7::int, $8::boolean, src.created_at, src.created_at
         FROM task_groups AS src WHERE src.id = $9`, [...params, at.groupId])
  } else {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4::text, $5::text, $6, $7::int, $8::boolean, s.at, s.at
         FROM (SELECT clock_timestamp() AS at) AS s`, params)
  }
}

// ---------------------------------------------------------------------------------------------
// Groups: read, create, rename, delete
// ---------------------------------------------------------------------------------------------

/**
 * `GET /api/task-lists/:id/groups`. ASSUMPTION(task-m4): [own-48] as the list's other reads
 * ([own-33] [own-42] [own-43]): the list is resolved for a member first (404), then the page is
 * parsed (422); no org claim is 404 at the route. [own-51] by position, then id in byte order.
 */
export async function listTaskListGroups(input: {
  orgId: string
  actorId: string
  listId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskGroupView[]; total: number }> {
  const container = await listContainer(plainDb, input, 'view')
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const cond = groupCondition(container)
  const n = cond.params.length + 1
  const rows = await plainDb.query(
    `SELECT task_groups.id, task_groups.name, task_groups.position, task_groups.is_default
       FROM task_groups WHERE ${cond.sql} ORDER BY ${TASK_GROUP_PAGE_SORT_KEY} LIMIT $${n} OFFSET $${n + 1}`,
    [...cond.params, page.limit, page.offset],
  )
  const counted = await plainDb.query(`SELECT count(*)::text AS n FROM task_groups WHERE ${cond.sql}`, cond.params)
  return { items: rows.rows.map((row) => toGroupView('list', toGroupRow(row))), total: Number(counted.rows[0]?.n ?? 0) }
}

/**
 * `GET /api/task-groups`: the caller's personal groups in this org, read without writing. Until the
 * default group has a row, the list starts with the synthetic default group ([own-24],
 * `userGroupsWithDefault`). The synthetic group is not a table row, so the whole list (at most the
 * D14 soft limit of rows) is built and then paged; `total` is its length.
 */
export async function listUserTaskGroups(input: {
  orgId: string
  actorId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskGroupView[]; total: number }> {
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  const rows = await loadGroups(plainDb, userContainer(input))
  const groups = userGroupsWithDefault(rows.map((row) => toGroupView('user', row)))
  return { items: groups.slice(page.offset, page.offset + page.limit), total: groups.length }
}

/**
 * Creates a group at the end of the container ([own-13]: positions stay 0..n-1, so the count is the
 * next position). [D14] [own-12] the default group counts toward the limit, also before its row
 * exists; a container without a default row gets it first, at position 0 ([own-24], the personal
 * scope's first write). One `clock_timestamp()` reading after the lock stamps the first new row;
 * the second row and the list-scope `group_created` event copy it.
 */
async function createGroup(db: Db, container: Container, name: string, actorId: string): Promise<TaskGroupView> {
  const groups = await loadGroups(db, container)
  const hasDefault = groups.some((row) => row.isDefault)
  const plan = applyCreateGroup({
    id: newTaskGroupId(),
    scope: container.scope,
    name,
    existingCount: groups.length + (hasDefault ? 0 : 1),
    actorId,
  })
  if (plan.ok === false) fail(422, plan.reason.toUpperCase())
  let at: InstantSource = { from: 'clock' }
  if (!hasDefault) {
    const defaultId = newTaskGroupId()
    await insertGroup(db, container, { id: defaultId, name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }, { from: 'clock' })
    at = { from: 'group', groupId: defaultId }
  }
  await insertGroup(db, container, { id: plan.group.id, name: plan.group.name, position: plan.group.position, isDefault: false }, at)
  if (container.scope === 'list') {
    for (const event of plan.events) {
      await writeListEvent(db, {
        listId: container.listId, actorId: event.userId, type: event.type, payload: { groupId: plan.group.id },
        at: { from: 'group', groupId: plan.group.id },
      })
    }
  }
  return { id: plan.group.id, scope: container.scope, name: plan.group.name, position: plan.group.position, isDefault: false }
}

/**
 * `POST /api/task-lists/:id/groups` `{ name }`. ASSUMPTION(task-m4): [own-52] after the lock: the
 * list for a member (404) → `manage_groups` (404) → the name (422) → the limit (422 LIMIT).
 */
export async function createTaskListGroup(input: {
  orgId: string
  actorId: string
  listId: string
  body: unknown
}): Promise<TaskGroupView> {
  return withOrgStructure(input.orgId, async (db) => {
    const container = await listContainer(db, input, 'manage_groups')
    const name = parseGroupNameOrFail(input.body)
    return createGroup(db, container, name, input.actorId)
  })
}

/**
 * `POST /api/task-groups` `{ name }`. ASSUMPTION(task-m4): [own-52] the container is the caller's
 * own, so there is no row-level object to hide: the name is checked before the transaction opens
 * (as `POST /api/task-lists`), the limit after the lock.
 */
export async function createUserTaskGroup(input: { orgId: string; actorId: string; body: unknown }): Promise<TaskGroupView> {
  const name = parseGroupNameOrFail(input.body)
  return withOrgStructure(input.orgId, (db) => createGroup(db, userContainer(input), name, input.actorId))
}

/** Renames a group of the container; the same name is a no-op. The row's `updated_at` is one
 * `clock_timestamp()` reading after the lock, and the list-scope `group_renamed` copies it. */
async function renameGroup(db: Db, container: Container, input: { actorId: string; groupId: string; body: unknown }): Promise<TaskGroupView> {
  const group = requireGroup(await loadGroups(db, container), input.groupId)
  const name = parseGroupNameOrFail(input.body)
  const plan = applyRenameGroup({ scope: container.scope, name, previousName: group.name, actorId: input.actorId })
  if (plan.name !== group.name) {
    await db.query(
      `UPDATE task_groups AS g SET name = $2, updated_at = s.at
         FROM (SELECT clock_timestamp() AS at) AS s
        WHERE g.id = $1`,
      [group.id, plan.name],
    )
    if (container.scope === 'list') {
      for (const event of plan.events) {
        await writeListEvent(db, {
          listId: container.listId, actorId: event.userId, type: event.type, payload: { groupId: group.id },
          at: { from: 'group', groupId: group.id },
        })
      }
    }
  }
  return toGroupView(container.scope, { ...group, name: plan.name })
}

/**
 * `PATCH /api/task-lists/:id/groups/:groupId` `{ name }`. ASSUMPTION(task-m4): [own-52] after the
 * lock: the list for a member (404) → `manage_groups` (404) → the group, one of this list's (404)
 * → the name (422).
 */
export async function renameTaskListGroup(input: {
  orgId: string
  actorId: string
  listId: string
  groupId: string
  body: unknown
}): Promise<TaskGroupView> {
  return withOrgStructure(input.orgId, async (db) => {
    const container = await listContainer(db, input, 'manage_groups')
    return renameGroup(db, container, input)
  })
}

/** `PATCH /api/task-groups/:groupId` `{ name }`: one of the caller's own groups in this org (404),
 * then the name (422). The default group can be renamed once it has a row ([own-24]). */
export async function renameUserTaskGroup(input: {
  orgId: string
  actorId: string
  groupId: string
  body: unknown
}): Promise<TaskGroupView> {
  return withOrgStructure(input.orgId, (db) => renameGroup(db, userContainer(input), input))
}

/**
 * Deletes a group of the container. [R11] the default group is never deleted (422 IS_DEFAULT); the
 * deleted group's placements go with it (foreign key cascade), so its tasks are back in the default
 * group, after the placed ones, and `reassignedTo` names the default group. [own-13] the remaining
 * groups are renumbered 0..n-2 in the same transaction (`planGroupPositionsAfterDelete`); the
 * renumbering writes `position` only. The list-scope `group_deleted` takes one `clock_timestamp()`
 * reading after the lock.
 */
async function deleteGroup(db: Db, container: Container, input: { actorId: string; groupId: string }): Promise<TaskGroupDeletedJson> {
  const groups = await loadGroups(db, container)
  const group = requireGroup(groups, input.groupId)
  // A container that has a group has its default group: a write lands the default before any other
  // group, and the default is never deleted.
  const defaultGroup = groups.find((row) => row.isDefault)
  if (!defaultGroup) throw new Error('task group container without a default group')
  const plan = applyDeleteGroup({
    group: { id: group.id, scope: container.scope, isDefault: group.isDefault, position: group.position },
    defaultGroupId: defaultGroup.id,
    scope: container.scope,
    actorId: input.actorId,
  })
  if (plan.ok === false) fail(422, plan.reason.toUpperCase())
  await db.query(`DELETE FROM task_groups WHERE id = $1`, [group.id])
  const moves = planGroupPositionsAfterDelete({ groups, deletedGroupId: group.id })
  if (moves.length > 0) {
    await db.query(
      `UPDATE task_groups SET position = v.position
         FROM unnest($1::text[], $2::int[]) AS v(id, position)
        WHERE task_groups.id = v.id`,
      [moves.map((move) => move.id), moves.map((move) => move.position)],
    )
  }
  if (container.scope === 'list') {
    for (const event of plan.events) {
      await writeListEvent(db, {
        listId: container.listId, actorId: event.userId, type: event.type, payload: { groupId: group.id }, at: { from: 'clock' },
      })
    }
  }
  return { id: group.id, deleted: true, reassignedTo: plan.reassignToGroupId }
}

/**
 * `DELETE /api/task-lists/:id/groups/:groupId`. ASSUMPTION(task-m4): [own-52] after the lock: the
 * list for a member (404) → `manage_groups` (404) → the group, one of this list's (404) → the
 * default group (422 IS_DEFAULT). A group that is already gone is the 404.
 */
export async function deleteTaskListGroup(input: {
  orgId: string
  actorId: string
  listId: string
  groupId: string
}): Promise<TaskGroupDeletedJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const container = await listContainer(db, input, 'manage_groups')
    return deleteGroup(db, container, input)
  })
}

/** `DELETE /api/task-groups/:groupId`: one of the caller's own groups in this org (404), then the
 * default group (422 IS_DEFAULT). */
export async function deleteUserTaskGroup(input: { orgId: string; actorId: string; groupId: string }): Promise<TaskGroupDeletedJson> {
  return withOrgStructure(input.orgId, (db) => deleteGroup(db, userContainer(input), input))
}

// ---------------------------------------------------------------------------------------------
// Placements: read and place
// ---------------------------------------------------------------------------------------------

/**
 * The container's placements in its visible set. Each `position` is the dense index of the task
 * among its group's visible rows (stored position, then task id in byte order), numbered before
 * the page is cut; `total` counts the visible placements only.
 */
async function readPlacements(container: Container, page: TaskPageParams): Promise<{ items: TaskGroupPlacementJson[]; total: number }> {
  const groups = groupCondition(container)
  const visible = visibleCondition(container)
  const from = `FROM task_group_items
       JOIN task_groups ON task_groups.id = task_group_items.group_id
       JOIN tasks ON tasks.id = task_group_items.task_id
      WHERE ${groups.sql} AND ${visible.sql}`
  const n = groups.params.length + 1
  const rows = await plainDb.query(
    `SELECT placement.group_id, placement.task_id, placement.position FROM (
       SELECT task_group_items.group_id, task_group_items.task_id,
              (row_number() OVER (PARTITION BY task_group_items.group_id ORDER BY ${TASK_GROUP_ITEM_ORDER_KEY}) - 1)::int AS position
       ${from}
     ) AS placement
     ORDER BY ${TASK_GROUP_PLACEMENT_PAGE_SORT_KEY} LIMIT $${n} OFFSET $${n + 1}`,
    [...groups.params, page.limit, page.offset],
  )
  const counted = await plainDb.query(`SELECT count(*)::text AS n ${from}`, groups.params)
  return {
    items: rows.rows.map((row) => ({ groupId: String(row.group_id), taskId: String(row.task_id), position: Number(row.position) })),
    total: Number(counted.rows[0]?.n ?? 0),
  }
}

/**
 * `GET /api/task-lists/:id/group-items`. ASSUMPTION(task-m4): [own-48] the list is resolved for a
 * member first (404), then the page is parsed (422); no org claim is 404 at the route. [own-51] by
 * group id in byte order, then the dense index.
 */
export async function listTaskListGroupItems(input: {
  orgId: string
  actorId: string
  listId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskGroupPlacementJson[]; total: number }> {
  const container = await listContainer(plainDb, input, 'view')
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  return readPlacements(container, page)
}

/** `GET /api/task-groups/items`: the caller's personal placements of the live tasks still on their
 * assigned arm in this org. */
export async function listUserTaskGroupItems(input: {
  orgId: string
  actorId: string
  query: { limit?: unknown; offset?: unknown }
}): Promise<{ items: TaskGroupPlacementJson[]; total: number }> {
  const page = parseTaskPage({ limit: input.query.limit, offset: input.query.offset })
  return readPlacements(userContainer(input), page)
}

/** 404 unless `taskId` is in the container's visible set (a live item of the list, or a live task
 * on the user's assigned arm, in the container's org). */
async function requireVisibleTask(db: Db, container: Container, taskId: string): Promise<void> {
  if (!isPrintableId(taskId)) fail(404, 'NOT_FOUND')
  const cond = visibleCondition(container)
  const n = cond.params.length + 1
  const found = await db.query(`SELECT tasks.id FROM tasks WHERE ${cond.sql} AND tasks.id = $${n}`, [...cond.params, taskId])
  if (found.rows.length === 0) fail(404, 'NOT_FOUND')
}

/** The groups of the container that hold a row for `taskId` (normally at most one). */
async function loadTaskGroupIds(db: Db, container: Container, taskId: string): Promise<string[]> {
  const cond = groupCondition(container)
  const n = cond.params.length + 1
  const result = await db.query(
    `SELECT task_group_items.group_id FROM task_group_items
       JOIN task_groups ON task_groups.id = task_group_items.group_id
      WHERE ${cond.sql} AND task_group_items.task_id = $${n}
      ORDER BY task_group_items.group_id COLLATE "C"`,
    [...cond.params, taskId],
  )
  return result.rows.map((row) => String(row.group_id))
}

/** The rows of one group split by the container's visible set, each part in stored order. */
async function loadGroupRows(db: Db, container: Container, groupId: string): Promise<{ visible: string[]; hidden: string[] }> {
  const cond = visibleCondition(container)
  const n = cond.params.length + 1
  const result = await db.query(
    `SELECT task_group_items.task_id,
            EXISTS (SELECT 1 FROM tasks WHERE tasks.id = task_group_items.task_id AND ${cond.sql}) AS visible
       FROM task_group_items WHERE task_group_items.group_id = $${n}
      ORDER BY ${TASK_GROUP_ITEM_ORDER_KEY}`,
    [...cond.params, groupId],
  )
  const visible: string[] = []
  const hidden: string[] = []
  for (const row of result.rows) (row.visible === true ? visible : hidden).push(String(row.task_id))
  return { visible, hidden }
}

async function insertPlacement(
  db: Db,
  placement: { groupId: string; taskId: string; orgId: string; position: number },
  at: InstantSource,
): Promise<void> {
  // ASSUMPTION(task-m4): [own-37] the placement carries the org its group and task were read with;
  // the composite foreign keys refuse any other.
  const params: unknown[] = [placement.groupId, placement.taskId, placement.orgId, placement.position]
  const columns = 'INSERT INTO task_group_items (group_id, task_id, org_id, position, created_at)'
  if (at.from === 'group') {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4::int, src.created_at FROM task_groups AS src WHERE src.id = $5`, [...params, at.groupId])
  } else {
    await db.query(`${columns}
       SELECT $1, $2, $3, $4::int, s.at FROM (SELECT clock_timestamp() AS at) AS s`, params)
  }
}

/**
 * Places the task in a group of the container. ASSUMPTION(task-m4): [own-49] after the container
 * check: the task, in the container's visible set (404) → the body's `groupId` (422 INVALID_GROUP:
 * missing, not `null` or an id string, or no group of this container) → `position` (422
 * INVALID_POSITION) → the plan. [own-12] `groupId: null` is the default group; a container without
 * a default row (the personal scope before its first write) gets it here, at position 0, when the
 * placement writes. [own-50] a task without a row is in the default group, so placing it there is
 * not a move between groups.
 *
 * A change writes, in one transaction: the task's rows in the container's other groups are deleted
 * (the source group is not rewritten; reads renumber it), the new row (one `clock_timestamp()`
 * reading after the lock, or the instant of the default row just written), the positions of the
 * whole target group in `planGroupItemOrder`'s order (visible rows first, hidden rows after), and,
 * for a list-scope move between groups, `task_events.group_changed` (D2) copying the new row's
 * instant. The same visible order is a no-op that writes nothing.
 */
async function placeTask(
  db: Db,
  container: Container,
  input: { actorId: string; taskId: string; body: unknown },
): Promise<TaskGroupPlacementJson> {
  await requireVisibleTask(db, container, input.taskId)
  const target = parseTargetGroupId(input.body)
  if (target.ok === false) fail(422, 'INVALID_GROUP')
  const groups = await loadGroups(db, container)
  const defaultGroup = groups.find((row) => row.isDefault)
  let toGroupId: string
  let materialize = false
  if (target.groupId === null) {
    if (defaultGroup) {
      toGroupId = defaultGroup.id
    } else {
      toGroupId = newTaskGroupId()
      materialize = true
    }
  } else {
    const named = groups.find((row) => row.id === target.groupId)
    if (!named) fail(422, 'INVALID_GROUP')
    toGroupId = named.id
  }
  const current = await loadTaskGroupIds(db, container, input.taskId)
  const rows = await loadGroupRows(db, container, toGroupId)
  const order = planGroupItemOrder({
    visibleOrderedIds: rows.visible,
    hiddenOrderedIds: rows.hidden,
    taskId: input.taskId,
    position: bodyField(input.body, 'position'),
  })
  if (order.ok === false) fail(422, 'INVALID_POSITION')
  const fromGroupId = current.includes(toGroupId) ? toGroupId : current[0] ?? defaultGroup?.id ?? toGroupId
  const move = applyMoveItem({
    scope: container.scope,
    fromGroupId,
    toGroupId,
    previousOrderedItemIds: order.before,
    nextOrderedItemIds: order.after,
    actorId: input.actorId,
  })
  const placed: TaskGroupPlacementJson = { taskId: input.taskId, groupId: toGroupId, position: order.after.indexOf(input.taskId) }
  if (!move.changed) return placed
  if (materialize) {
    await insertGroup(db, container, { id: toGroupId, name: TASK_DEFAULT_GROUP_NAME, position: 0, isDefault: true }, { from: 'clock' })
  }
  const cond = groupCondition(container)
  const n = cond.params.length + 1
  await db.query(
    `DELETE FROM task_group_items USING task_groups
      WHERE task_groups.id = task_group_items.group_id AND ${cond.sql}
        AND task_group_items.task_id = $${n} AND task_group_items.group_id <> $${n + 1}`,
    [...cond.params, input.taskId, toGroupId],
  )
  if (!current.includes(toGroupId)) {
    await insertPlacement(
      db,
      { groupId: toGroupId, taskId: input.taskId, orgId: container.orgId, position: placed.position },
      materialize ? { from: 'group', groupId: toGroupId } : { from: 'clock' },
    )
  }
  await db.query(
    `UPDATE task_group_items SET position = v.position
       FROM unnest($2::text[], $3::int[]) AS v(task_id, position)
      WHERE task_group_items.group_id = $1 AND task_group_items.task_id = v.task_id
        AND task_group_items.position <> v.position`,
    [toGroupId, move.positions.map((entry) => entry.itemId), move.positions.map((entry) => entry.position)],
  )
  if (container.scope === 'list') {
    for (const event of move.taskEvents) {
      // ASSUMPTION(task-m4): [D2] [own-50] payload `{ listId, fromGroupId, toGroupId }`; the instant
      // is the new row's.
      await db.query(
        `INSERT INTO task_events (id, task_id, actor_id, event_type, payload, occurred_at)
         SELECT $1, $2, $3, $4, $5::jsonb, created_at FROM task_group_items WHERE group_id = $6 AND task_id = $2`,
        [
          newTaskEventId(), input.taskId, event.userId, event.type,
          JSON.stringify({ listId: container.listId, fromGroupId, toGroupId }), toGroupId,
        ],
      )
    }
  }
  return placed
}

/** `PUT /api/task-lists/:id/group-items/:taskId` `{ groupId, position }`: the list for a member
 * (404) → `manage_groups` (404) → `placeTask`. */
export async function placeTaskInListGroup(input: {
  orgId: string
  actorId: string
  listId: string
  taskId: string
  body: unknown
}): Promise<TaskGroupPlacementJson> {
  return withOrgStructure(input.orgId, async (db) => {
    const container = await listContainer(db, input, 'manage_groups')
    return placeTask(db, container, input)
  })
}

/** `PUT /api/task-groups/items/:taskId` `{ groupId, position }`: the caller's own groups in this
 * org, for a task on their assigned arm (R11). */
export async function placeTaskInUserGroup(input: {
  orgId: string
  actorId: string
  taskId: string
  body: unknown
}): Promise<TaskGroupPlacementJson> {
  return withOrgStructure(input.orgId, (db) => placeTask(db, userContainer(input), input))
}
