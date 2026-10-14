/**
 * G2-core: the list page's status switch (未完成 / 已完成 / 全部). The default is `open`
 * (未完成, lock §2 item 1: 默认未完成可切); the last choice is remembered per browser.
 *
 * Storage can be missing or throw (private mode, blocked site data, quota): every access is in its
 * own try/catch, and a stored value outside the closed set reads as the default. Nothing here is
 * shared between viewers or read by the server.
 */
import type { TaskStatusFilter } from './tasksApi'

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
