/**
 * Task feature — advisory lock key builders. PURE, no I/O.
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §6.4 `:436`
 *
 * These only build the TEXT of a lock key (the string a caller passes to `pg_advisory_xact_lock`
 * or similar). They never touch a database connection, a clock, or `crypto`.
 */

/** Structure-mutation lock for one org's task tree (create/reparent/delete). Lock §6.4 `:436`. */
export function taskStructureLockKey(orgId: string): string {
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new TypeError('taskStructureLockKey: orgId must be a non-empty string')
  }
  return `task-structure:${orgId}`
}

/** Per-task projection-write lock, scoped by the owning list and the task itself. */
export function taskProjectionLockKey(listId: string, taskId: string): string {
  if (typeof listId !== 'string' || listId.length === 0) {
    throw new TypeError('taskProjectionLockKey: listId must be a non-empty string')
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new TypeError('taskProjectionLockKey: taskId must be a non-empty string')
  }
  return `task-projection:${listId}:${taskId}`
}

/** Singleton leader-election lock for the tasks scheduler loop. No arguments — one lock, one key. */
export function tasksSchedulerLeaderLockKey(): string {
  return 'tasks-scheduler:leader'
}
