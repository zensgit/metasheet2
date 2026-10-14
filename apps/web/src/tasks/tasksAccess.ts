/**
 * Who may see a tasks entry point. One place for the rule the top bar's 任务 link has used since R62
 * (#6173; App.vue `canUseTasks`) so that a second entry point — the multitable record drawer's
 * 派发任务 — builds on the same rule instead of a copy that can drift.
 *
 * The tasks feature (the session's `tasks`, from the server's TASKS_ENABLED) is checked FIRST: while
 * it is off nothing about tasks renders, administrators included (an administrator passes every
 * permission probe, so a permission-only gate showed a dead entry on a server with /api/tasks not
 * mounted).
 *
 * The focused product shells (attendance-only, plm-workbench-only) never render the 任务 link — App.vue
 * places it only in the platform branch of the nav, and the route guard's focus allowlists do not
 * include /tasks — so an entry that leads into the task centre stays hidden there as well.
 */

export interface TasksAccessProbe {
  hasFeature: (feature: 'tasks') => boolean
  hasPermission: (code: string) => boolean
}

export interface TasksFocusProbe {
  isAttendanceFocused: () => boolean
  isPlmWorkbenchFocused: () => boolean
}

/** The top bar's 任务 entry: the tasks feature is on and the viewer holds `tasks:read`. */
export function canSeeTasksEntry(probe: TasksAccessProbe): boolean {
  return probe.hasFeature('tasks') && probe.hasPermission('tasks:read')
}

/** An entry that CREATES a task outside the task centre (the record drawer's 派发任务): not inside a
 *  focused product shell, the top bar's 任务 rule holds, and the viewer holds `tasks:write` (the guard of
 *  `POST /api/tasks` and `PATCH /api/tasks/:id`). The server re-checks all of it; this only decides
 *  whether the entry renders. */
export function canDispatchTasks(probe: TasksAccessProbe & TasksFocusProbe): boolean {
  if (probe.isAttendanceFocused() || probe.isPlmWorkbenchFocused()) return false
  return canSeeTasksEntry(probe) && probe.hasPermission('tasks:write')
}
