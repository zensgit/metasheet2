/**
 * Viewer-facing date/time display for the `/tasks/:id` detail page — `dueAt` (a TIMED task's
 * absolute due instant) and an assignee's `completedAt`. Both are ISO instants from the backend;
 * this renders them in the VIEWER's own local time, zh-CN style — the same `Intl.DateTimeFormat`
 * idiom this codebase's other views already use for a record's date/time (e.g.
 * `AfterSalesView.formatRecordDate`, the elearning wallet sections' local `formatDate`):
 * `dateStyle: 'medium'`, `timeStyle: 'short'`, 24h (`hour12: false`).
 *
 * (P3-3 correction: this used to be shown as the RAW ISO string, with a comment claiming the
 * backend already resolved the viewer-relevant representation. Viewer-local formatting now
 * happens here instead.)
 *
 * `timeZone` is optional and exists ONLY so a test can pin a deterministic zone for a fixed
 * instant — every production call site omits it, so `Intl` resolves the browser's own zone.
 */
export function formatViewerInstant(value: string, timeZone?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(date)
}

export interface TaskDueFields {
  /** Non-null for a TIMED task — an absolute instant, formatted viewer-local via
   *  `formatViewerInstant`. */
  dueAt: string | null
  /** `'YYYY-MM-DD'`, set for an all-day task. A WALL-CLOCK date, not an instant — never
   *  round-tripped through `Date`/`Intl` (doing so would silently reinterpret it in whatever zone
   *  the host happens to run in). */
  dueDate: string | null
  /** `'HH:MM:SS'`, optionally set alongside `dueDate`. Same wall-clock caveat as `dueDate`. */
  dueTime: string | null
  timeZone: string | null
}

/** A TIMED task carries a non-null `dueAt` — display it viewer-local. An ALL-DAY task has
 *  `dueAt: null` and instead carries `dueDate` (+ optional `dueTime`, `timeZone`) — display those
 *  as given, `dueTime` included when present (P3-3: it used to be silently dropped here even when
 *  the backend sent it). Neither set means no due date at all. */
export function formatDueDisplay(task: TaskDueFields): string {
  if (task.dueAt) return formatViewerInstant(task.dueAt)
  if (task.dueDate) {
    const withTime = task.dueTime ? `${task.dueDate} ${task.dueTime.slice(0, 5)}` : task.dueDate
    return task.timeZone ? `${withTime}（${task.timeZone}）` : withTime
  }
  return '无截止日期'
}
