/**
 * Viewer-facing date/time display for the `/tasks/:id` detail page — `dueAt` (a TIMED task's
 * absolute due instant) and an assignee's `completedAt`. Both are ISO instants from the backend;
 * this renders them in the VIEWER's own local time with the common `Intl.DateTimeFormat` options
 * for a record's date/time: `dateStyle: 'medium'`, `timeStyle: 'short'`, 24h (`hour12: false`).
 *
 * (P3-3 correction: this used to be shown as the RAW ISO string, with a comment claiming the
 * backend already resolved the viewer-relevant representation. Viewer-local formatting now
 * happens here instead.)
 *
 * `timeZone` is optional and exists ONLY so a test can pin a deterministic zone for a fixed
 * instant — every production call site omits it, so `Intl` resolves the browser's own zone.
 *
 * M4 FE-0 (design §9.1): the language is a parameter — `locale` (a BCP-47 tag handed to `Intl`)
 * and, for `formatDueDisplay`, the `labels` table that supplies the placeholder and the
 * time-zone brackets. Both default to the zh-CN forms, so a call that passes neither renders
 * byte-for-byte what it rendered before; the views pass `'zh-CN'` / `'en-US'` and the matching
 * table from `useLocale()`.
 */
import { TASKS_ZH, type TasksText } from './labels'

export function formatViewerInstant(value: string, timeZone?: string, locale = 'zh-CN'): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
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

/** The three label-table entries the all-day form reads. */
export type TasksDueLabels = Pick<TasksText, 'noDueDate' | 'timeZoneOpen' | 'timeZoneClose'>

/** A TIMED task carries a non-null `dueAt` — display it viewer-local. An ALL-DAY task has
 *  `dueAt: null` and instead carries `dueDate` (+ optional `dueTime`, `timeZone`) — display those
 *  as given, `dueTime` included when present (P3-3: it used to be silently dropped here even when
 *  the backend sent it). Neither set means no due date at all.
 *
 *  `labels` and `locale` travel together: the TIMED branch formats through `Intl` with `locale`,
 *  the ALL-DAY branch reads its brackets and the no-due placeholder from `labels`. */
export function formatDueDisplay(
  task: TaskDueFields,
  labels: TasksDueLabels = TASKS_ZH,
  locale = 'zh-CN',
): string {
  if (task.dueAt) return formatViewerInstant(task.dueAt, undefined, locale)
  if (task.dueDate) {
    const withTime = task.dueTime ? `${task.dueDate} ${task.dueTime.slice(0, 5)}` : task.dueDate
    return task.timeZone ? `${withTime}${labels.timeZoneOpen}${task.timeZone}${labels.timeZoneClose}` : withTime
  }
  return labels.noDueDate
}

/** The start fields of a task (M4, PR-3a S4; absent from an older detail body). Both are
 *  WALL-CLOCK values — there is no start instant — with the same caveat as `dueDate` / `dueTime`. */
export interface TaskStartFields {
  /** `'YYYY-MM-DD'`. */
  startDate?: string | null
  /** `'HH:MM:SS'` from the server. */
  startTime?: string | null
  timeZone: string | null
}

/** The three label-table entries the start row reads. */
export type TasksStartLabels = Pick<TasksText, 'noStartDate' | 'timeZoneOpen' | 'timeZoneClose'>

/** The start row: the all-day form of `formatDueDisplay` — the date, the time in the minutes form
 *  when present, the zone in brackets — never round-tripped through `Date`; `noStartDate` when the
 *  task has no start date. */
export function formatStartDisplay(task: TaskStartFields, labels: TasksStartLabels = TASKS_ZH): string {
  if (!task.startDate) return labels.noStartDate
  const withTime = task.startTime ? `${task.startDate} ${task.startTime.slice(0, 5)}` : task.startDate
  return task.timeZone ? `${withTime}${labels.timeZoneOpen}${task.timeZone}${labels.timeZoneClose}` : withTime
}
