/**
 * The tasks feature switch as the web client sees it (session `features.tasks`).
 *
 * Same predicate as the gate in `routes/tasks.ts` (`tasksRouter()` returns null unless
 * TASKS_ENABLED is exactly the string 'true'): the web shows the 任务 entry, its badge and the
 * /tasks route only when the /api/tasks routes are actually mounted. Default OFF; no trimming or
 * case folding, so 'TRUE', '1' and ' true' are all off. `tests/unit/tasks-feature-flag.test.ts`
 * pins the two predicates against each other.
 */
export function isTasksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TASKS_ENABLED === 'true'
}
