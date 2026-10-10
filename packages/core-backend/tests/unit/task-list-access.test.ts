import { describe, expect, it } from 'vitest'
import { buildTaskInListCondition, buildTaskScopeCondition } from '../../src/tasks/task-access'
import {
  buildTaskListByIdCondition,
  buildTaskListGroupScopeCondition,
  buildTaskListScopeCondition,
  buildTaskUserGroupScopeCondition,
  TASK_GROUP_ITEM_ORDER_KEY,
  TASK_GROUP_PAGE_SORT_KEY,
  TASK_GROUP_PLACEMENT_PAGE_SORT_KEY,
  TASK_LIST_EVENT_PAGE_SORT_KEY,
  TASK_LIST_MEMBER_PAGE_SORT_KEY,
  TASK_LIST_PAGE_SORT_KEY,
} from '../../src/tasks/task-list-access'

/**
 * M4 PR-3a S5 (design task-m4-pr3a-backend-design-20260930.md §4.1). Text snapshots of the list
 * condition builders; `task_lists.org_id = $2` appears exactly once in every output.
 */

function orgClauseCount(sql: string): number {
  return sql.split('task_lists.org_id = $2').length - 1
}

describe('task-list-access', () => {
  it('buildTaskListScopeCondition, archived excluded', () => {
    const cond = buildTaskListScopeCondition({ actorParam: 'usr_a', orgParam: 'org_a', includeArchived: false })
    expect(cond).toEqual({
      sql:
        '(task_lists.org_id = $2) AND EXISTS (SELECT 1 FROM task_list_members tlm_me WHERE tlm_me.list_id = task_lists.id ' +
        'AND tlm_me.user_id = $1) AND task_lists.archived_at IS NULL',
      params: ['usr_a', 'org_a'],
    })
    expect(orgClauseCount(cond.sql)).toBe(1)
  })

  it('buildTaskListScopeCondition, archived included', () => {
    const cond = buildTaskListScopeCondition({ actorParam: 'usr_a', orgParam: 'org_a', includeArchived: true })
    expect(cond).toEqual({
      sql:
        '(task_lists.org_id = $2) AND EXISTS (SELECT 1 FROM task_list_members tlm_me WHERE tlm_me.list_id = task_lists.id ' +
        'AND tlm_me.user_id = $1)',
      params: ['usr_a', 'org_a'],
    })
    expect(orgClauseCount(cond.sql)).toBe(1)
  })

  it('buildTaskListScopeCondition only drops the archived filter for exactly true', () => {
    for (const includeArchived of ['true', 1, null, undefined] as unknown[]) {
      const cond = buildTaskListScopeCondition({ actorParam: 'u', orgParam: 'o', includeArchived: includeArchived as boolean })
      expect(cond.sql.endsWith(' AND task_lists.archived_at IS NULL')).toBe(true)
    }
  })

  it('buildTaskListByIdCondition', () => {
    const cond = buildTaskListByIdCondition({ listIdParam: 'tlst_x', orgParam: 'org_a' })
    expect(cond).toEqual({
      sql: '(task_lists.org_id = $2) AND task_lists.id = $1',
      params: ['tlst_x', 'org_a'],
    })
    expect(orgClauseCount(cond.sql)).toBe(1)
  })

  it('the bind values are passed through, never inlined', () => {
    const hostile = "x') OR TRUE --"
    const byId = buildTaskListByIdCondition({ listIdParam: hostile, orgParam: hostile })
    const scope = buildTaskListScopeCondition({ actorParam: hostile, orgParam: hostile, includeArchived: false })
    expect(byId.sql.includes(hostile)).toBe(false)
    expect(scope.sql.includes(hostile)).toBe(false)
  })

  it('sort keys end with the primary key', () => {
    expect(TASK_LIST_PAGE_SORT_KEY).toBe('task_lists.updated_at DESC, task_lists.id DESC')
    expect(TASK_LIST_EVENT_PAGE_SORT_KEY).toBe('task_list_events.occurred_at DESC, task_list_events.id DESC')
  })

  // M4 PR-3a S6, [own-40]: the roster key is the member primary key's second column in byte order.
  it('the member roster sort key is user_id in byte order', () => {
    expect(TASK_LIST_MEMBER_PAGE_SORT_KEY).toBe('task_list_members.user_id COLLATE "C"')
  })

  // M4 PR-3a S8 (design §3.5, §4.1): the group builders. `task_groups.org_id` is emitted by one
  // private clause; each output carries it exactly once.
  function groupOrgClauseCount(sql: string): number {
    return sql.split('task_groups.org_id = $2').length - 1
  }

  it('buildTaskListGroupScopeCondition', () => {
    const cond = buildTaskListGroupScopeCondition({ listIdParam: 'tlst_x', orgParam: 'org_a' })
    expect(cond).toEqual({
      sql: "(task_groups.org_id = $2) AND task_groups.scope = 'list' AND task_groups.list_id = $1",
      params: ['tlst_x', 'org_a'],
    })
    expect(groupOrgClauseCount(cond.sql)).toBe(1)
    expect(orgClauseCount(cond.sql)).toBe(0)
  })

  it('buildTaskUserGroupScopeCondition', () => {
    const cond = buildTaskUserGroupScopeCondition({ userParam: 'usr_a', orgParam: 'org_a' })
    expect(cond).toEqual({
      sql: "(task_groups.org_id = $2) AND task_groups.scope = 'user' AND task_groups.user_id = $1",
      params: ['usr_a', 'org_a'],
    })
    expect(groupOrgClauseCount(cond.sql)).toBe(1)
  })

  it('the group builders pass their bind values through, never inlined', () => {
    const hostile = "x') OR TRUE --"
    for (const cond of [
      buildTaskListGroupScopeCondition({ listIdParam: hostile, orgParam: hostile }),
      buildTaskUserGroupScopeCondition({ userParam: hostile, orgParam: hostile }),
    ]) {
      expect(cond.sql.includes(hostile)).toBe(false)
      expect(cond.params).toEqual([hostile, hostile])
    }
  })

  // The group services AND a container's group condition with its visible-set condition over ONE
  // parameter list, so both builders of each scope must bind the same two values in the same slots.
  it('each group builder binds the same $1 / $2 as the visible-set builder of its scope', () => {
    const listGroups = buildTaskListGroupScopeCondition({ listIdParam: 'tlst_x', orgParam: 'org_a' })
    const listTasks = buildTaskInListCondition({ listIdParam: 'tlst_x', orgParam: 'org_a' })
    expect(listGroups.params).toEqual(listTasks.params)
    const userGroups = buildTaskUserGroupScopeCondition({ userParam: 'usr_a', orgParam: 'org_a' })
    const assigned = buildTaskScopeCondition({ view: 'assigned', actorParam: 'usr_a', orgParam: 'org_a' })
    expect(userGroups.params).toEqual(assigned.params)
    for (const sql of [listGroups.sql, listTasks.sql, userGroups.sql, assigned.sql]) {
      expect(new Set(sql.match(/\$\d+/g))).toEqual(new Set(['$1', '$2']))
    }
  })

  it('the group sort keys: position, then ids in byte order; placements by group id, then the dense index', () => {
    expect(TASK_GROUP_PAGE_SORT_KEY).toBe('task_groups.position, task_groups.id COLLATE "C"')
    expect(TASK_GROUP_ITEM_ORDER_KEY).toBe('task_group_items.position, task_group_items.task_id COLLATE "C"')
    expect(TASK_GROUP_PLACEMENT_PAGE_SORT_KEY).toBe('placement.group_id COLLATE "C", placement.position')
  })
})
