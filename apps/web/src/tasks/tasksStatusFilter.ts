/**
 * G2-core: the list page's status switch (未完成 / 已完成 / 全部). The default is `open`
 * (未完成, lock §2 item 1: 默认未完成可切); the last choice is remembered per browser.
 *
 * Storage can be missing or throw (private mode, blocked site data, quota): every access is in its
 * own try/catch, and a stored value outside the closed set reads as the default. Nothing here is
 * shared between viewers or read by the server.
 */
import type { TaskStatusFilter, TaskView } from './tasksApi'

export const TASK_STATUS_FILTERS: readonly TaskStatusFilter[] = ['open', 'done', 'all']

export const DEFAULT_TASK_STATUS_FILTER: TaskStatusFilter = 'open'

export const TASK_STATUS_FILTER_STORAGE_KEY = 'metasheet.tasks.statusFilter'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function isTaskStatusFilter(value: unknown): value is TaskStatusFilter {
  return typeof value === 'string' && (TASK_STATUS_FILTERS as readonly string[]).includes(value)
}

/** The remembered choice, or `open` when there is none, it is not in the closed set, or storage throws. */
export function readTaskStatusFilter(): TaskStatusFilter {
  try {
    const stored = storage()?.getItem(TASK_STATUS_FILTER_STORAGE_KEY)
    return isTaskStatusFilter(stored) ? stored : DEFAULT_TASK_STATUS_FILTER
  } catch {
    return DEFAULT_TASK_STATUS_FILTER
  }
}

/** Remembers the choice; a storage failure is ignored (the switch still works for this page). */
export function writeTaskStatusFilter(value: TaskStatusFilter): void {
  try {
    storage()?.setItem(TASK_STATUS_FILTER_STORAGE_KEY, value)
  } catch {
    // Not remembered; the page keeps the choice in memory.
  }
}

/**
 * Whether a task the create form just made is left out of a list read under `status`. A new task
 * always starts not completed, so only `done` (已完成) leaves it out; `open` and `all` do not leave
 * it out on status grounds (whether the current view lists it is `viewListsNewTask`).
 * The answer depends on the filter alone, not on the reloaded rows, so a page that stops short of
 * the new row cannot be mistaken for a filter that hides it.
 */
export function statusFilterHidesNewTask(status: TaskStatusFilter): boolean {
  return status === 'done'
}

/**
 * Whether a list view includes a task the list page's create form just made. That form sends no
 * assignees, so the creator is the new task's only assignee and nobody follows it: 分配给我,
 * 我创建的 and 任一角色 include it; 关注中 (needs a follower) and 我委派的 (needs another assignee)
 * do not, under any status. Switching the status filter therefore shows the new task only in the
 * views this returns `true` for.
 * This mirrors the server's create defaults (omitted assignees become the creator alone; a create
 * adds no follower). If those defaults change, revisit this predicate: the frontend cells encode
 * the same rule in their fake list read and would not notice.
 */
export function viewListsNewTask(view: TaskView): boolean {
  return view === 'assigned' || view === 'created' || view === 'any_role'
}
