/**
 * Task feature — task list access: SQL condition TEXT for selecting task lists, and the stable
 * sort keys of the list endpoints that do not page `tasks`. PURE, no I/O: the builders only return
 * `{ sql, params }`; they never run a query.
 *
 * Design: docs/development/task-m4-pr3a-backend-design-20260930.md §3.0, §3.2, §4.1
 *
 * ASSUMPTION(task-m4): [D8] `task_lists.org_id` is written in exactly one place in this module
 * (`taskListOrgClause`), and `task_groups.org_id` in exactly one other (`taskGroupOrgClause`); every
 * exported builder goes through one of them.
 * ASSUMPTION(task-m4): [own-01] placeholders: `$1` is the object id (or the acting user for the
 * "my lists" and personal-group builders) and `$2` the org. A caller that appends its own
 * parameters numbers them from `params.length + 1`.
 */

export interface TaskListCondition {
  /** WHERE-clause fragment over `task_lists`, using `$1` / `$2`. */
  sql: string
  /** Positional bind values matching `$1` / `$2`. */
  params: unknown[]
}

const FIRST_PLACEHOLDER = '$1'
const ORG_PLACEHOLDER = '$2'

/** The org clause of every builder below, followed by the rest of that builder's condition. */
function taskListOrgClause(rest: string): string {
  return `(task_lists.org_id = ${ORG_PLACEHOLDER}) AND ${rest}`
}

/**
 * The lists of one org that the acting user is a member of (any role). Archived lists are left
 * out unless `includeArchived` is true. `$1` = acting user, `$2` = org.
 */
export function buildTaskListScopeCondition(input: {
  actorParam: string
  orgParam: string
  includeArchived: boolean
}): TaskListCondition {
  const member =
    `EXISTS (SELECT 1 FROM task_list_members tlm_me WHERE tlm_me.list_id = task_lists.id ` +
    `AND tlm_me.user_id = ${FIRST_PLACEHOLDER})`
  const archived = input.includeArchived === true ? '' : ' AND task_lists.archived_at IS NULL'
  return {
    sql: taskListOrgClause(`${member}${archived}`),
    params: [input.actorParam, input.orgParam],
  }
}

/**
 * One list of one org by id, archived or not. Membership is decided by the caller from the member
 * rows. `$1` = list id, `$2` = org.
 */
export function buildTaskListByIdCondition(input: { listIdParam: string; orgParam: string }): TaskListCondition {
  return {
    sql: taskListOrgClause(`task_lists.id = ${FIRST_PLACEHOLDER}`),
    params: [input.listIdParam, input.orgParam],
  }
}

// M4 PR-3b S2 (design task-m4-pr3b-backend-design-20261001.md §5.3): the notification producer's
// list-member fan-out. RULED(2026-10-07): [R05] [D13] a task's list members are the members of every
// list that holds it, archived lists included, so there is no `archived_at` filter here.
/**
 * Every list of one org that holds one task as an item, archived or not. `$1` = task id, `$2` = org.
 * The org clause is the list org clause of every builder in this module, so a list of another org
 * never contributes members, whatever its item rows say.
 */
export function buildTaskListsOfTaskCondition(input: { taskIdParam: string; orgParam: string }): TaskListCondition {
  return {
    sql: taskListOrgClause(
      `EXISTS (SELECT 1 FROM task_list_items tli_task WHERE tli_task.list_id = task_lists.id ` +
        `AND tli_task.task_id = ${FIRST_PLACEHOLDER})`,
    ),
    params: [input.taskIdParam, input.orgParam],
  }
}

// ASSUMPTION(task-m4): [D9] [own-35] ORDER BY bodies of the list endpoints. Each ends with the
// primary key, so the order is total. Lists: most recently updated first. List events: newest
// first; the events of one transaction share `occurred_at` and are ordered by id.
export const TASK_LIST_PAGE_SORT_KEY = 'task_lists.updated_at DESC, task_lists.id DESC' as const
export const TASK_LIST_EVENT_PAGE_SORT_KEY = 'task_list_events.occurred_at DESC, task_list_events.id DESC' as const

// ASSUMPTION(task-m4): [own-40] the member roster of one list is ordered by `user_id` in byte order
// (`COLLATE "C"`, independent of the database's default collation), the order the member write
// bodies use (`task-structure.ts` orders the assignee roster by comparing the strings the same way).
// `(list_id, user_id)` is the primary key, so within one list the order is total without a tie key.
export const TASK_LIST_MEMBER_PAGE_SORT_KEY = 'task_list_members.user_id COLLATE "C"' as const

// ── M4 PR-3a S8: groups (design §3.5, §4.1) ─────────────────────────────────────────────────────

/** The org clause of the group builders below, followed by the rest of that builder's condition. */
function taskGroupOrgClause(rest: string): string {
  return `(task_groups.org_id = ${ORG_PLACEHOLDER}) AND ${rest}`
}

/**
 * The groups of one list. `$1` = list id, `$2` = org: the same binds as `buildTaskInListCondition`
 * (task-access.ts), so a query over a list's groups and the list's tasks takes one parameter list.
 */
export function buildTaskListGroupScopeCondition(input: { listIdParam: string; orgParam: string }): TaskListCondition {
  return {
    sql: taskGroupOrgClause(`task_groups.scope = 'list' AND task_groups.list_id = ${FIRST_PLACEHOLDER}`),
    params: [input.listIdParam, input.orgParam],
  }
}

/**
 * The personal groups of one user in one org. `$1` = the user, `$2` = org: the same binds as
 * `buildTaskScopeCondition` (task-access.ts), whose `assigned` view is the personal scope's
 * visible set, so a query over both takes one parameter list.
 */
export function buildTaskUserGroupScopeCondition(input: { userParam: string; orgParam: string }): TaskListCondition {
  return {
    sql: taskGroupOrgClause(`task_groups.scope = 'user' AND task_groups.user_id = ${FIRST_PLACEHOLDER}`),
    params: [input.userParam, input.orgParam],
  }
}

// ASSUMPTION(task-m4): [D9] [own-51] ORDER BY bodies of the group endpoints, ids in byte order
// (`COLLATE "C"`, independent of the database's default collation). Groups: by position. Inside one
// group, the placements by stored position; the reads number them densely in this order, and the
// placement write splits a group's rows in the same order. The placement pages: by group id, then
// that dense index (`placement` is the derived table of the placement reads).
export const TASK_GROUP_PAGE_SORT_KEY = 'task_groups.position, task_groups.id COLLATE "C"' as const
export const TASK_GROUP_ITEM_ORDER_KEY = 'task_group_items.position, task_group_items.task_id COLLATE "C"' as const
export const TASK_GROUP_PLACEMENT_PAGE_SORT_KEY = 'placement.group_id COLLATE "C", placement.position' as const
