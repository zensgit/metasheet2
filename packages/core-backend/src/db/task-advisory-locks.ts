/**
 * Task-domain advisory locks. I/O lives here; key text comes from task-lock-keys.
 * Declaration form: export async function (lock §6.4).
 */
import {
  taskProjectionLockKey,
  taskStructureLockKey,
  tasksSchedulerLeaderLockKey,
} from '../tasks/task-lock-keys'

export type TaskAdvisoryQuery = (sql: string, params?: unknown[]) => Promise<unknown>

export async function acquireTaskStructureLock(
  query: TaskAdvisoryQuery,
  orgId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskStructureLockKey(orgId)])
}

export async function acquireTaskProjectionLock(
  query: TaskAdvisoryQuery,
  listId: string,
  taskId: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [taskProjectionLockKey(listId, taskId)])
}

export async function acquireTasksSchedulerLeaderLock(query: TaskAdvisoryQuery): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [tasksSchedulerLeaderLockKey()])
}
