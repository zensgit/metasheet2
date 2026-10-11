/**
 * Task-feature-line M4 frontend — draft state and client-side pre-checks for the detail editor
 * (`PATCH /api/tasks/:id`), the settings page and the list / group name inputs. PURE: no I/O, no
 * clock, no `Intl` beyond the time-zone name check.
 *
 * Design: docs/development/task-m4-frontend-design-20261007.md §3.3, §4.3, §7.1–§7.3.
 * Backend rules mirrored: PR-3a `src/tasks/task-edit.ts` (`planTaskDates`, `planTaskPatch`,
 * `REMIND_AT_RE`), `task-settings.ts` (`parseSettingsPatch`), `task-lists.ts` /
 * `task-groups.ts` (name rules), `task-ids.ts` (`normalizeUserText`, `isStorableText`).
 *
 * Same standing as `checkCommentBody`: a pre-check saves a round trip and lets one code drive one
 * message; the server's 422 remains the source of truth.
 *
 * The draft's canonical form (`[fe-17]`): times are `'HH:MM'` (the server's `'HH:MM:SS'` is
 * truncated by `initDraft`), a `null` description is `''`, a `null` time zone is `''`. Comparison
 * (`buildTaskPatch`) and the request body both use this form only. For the four date / time keys
 * an empty string, the value a cleared control reports, reads as `null`.
 */
import type { TaskBadgeScope, TaskDetail, TaskPatch, TaskRemindMode, TaskSettings, TaskSettingsPatch } from './tasksApi'
import { TASK_BADGE_SCOPES, TASK_REMIND_MODES } from './tasksApi'

// ASSUMPTION(task-m4-fe): [own-08] (PR-3a) — the description bound, in code points.
export const TASK_DESCRIPTION_MAX_CODEPOINTS = 20000
// ASSUMPTION(task-m4-fe): [D14] — list and group names, in code points after normalization.
export const TASK_NAME_MAX_CODEPOINTS = 100

// ---- text rules (mirror of task-ids.ts) ------------------------------------------------------

const EDGE_TRIM_RE = /^[\p{White_Space}\u200B\u200C\u200D\uFEFF]+|[\p{White_Space}\u200B\u200C\u200D\uFEFF]+$/gu
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** NFC, trim Unicode White_Space and the four zero-width marks from both edges, NFC again;
 *  `null` when nothing is left. The server's `normalizeUserText`. */
export function normalizeUserText(raw: string): string | null {
  const trimmed = raw.normalize('NFC').replace(EDGE_TRIM_RE, '')
  if (trimmed.length === 0) return null
  return trimmed.normalize('NFC')
}

/** No U+0000 and no lone UTF-16 surrogate — text Postgres stores exactly as sent. */
export function isStorableText(value: string): boolean {
  return !value.includes('\u0000') && !LONE_SURROGATE_RE.test(value)
}

function codePointLength(value: string): number {
  return Array.from(value).length
}

// ---- draft ------------------------------------------------------------------------------------

/** The editor's working copy, in the canonical form described in the module note. */
export interface TaskDraft {
  title: string
  /** `''` stands for the server's `null`. */
  description: string
  dueDate: string | null
  /** `'HH:MM'` or `null`. */
  dueTime: string | null
  startDate: string | null
  startTime: string | null
  /** `''` stands for the server's `null`. */
  timeZone: string
  remindAt: string | null
  /** Set once the viewer changes the reminder; `remindAt` enters a patch only then. */
  remindTouched: boolean
}

/** The detail fields a draft is taken from. The four S4 keys are optional on `TaskDetail`
 *  (an older body omits them) and read as their empty values here. */
export type TaskDraftSource = Pick<
  TaskDetail,
  'title' | 'dueDate' | 'dueTime' | 'timeZone' | 'description' | 'startDate' | 'startTime' | 'remindAt'
>

function clockMinutes(value: string | null | undefined): string | null {
  return value ? value.slice(0, 5) : null
}

/** The server's shape in the draft's canonical form; `remindTouched` starts false. */
export function initDraft(task: TaskDraftSource): TaskDraft {
  return {
    title: task.title,
    description: task.description ?? '',
    dueDate: task.dueDate,
    dueTime: clockMinutes(task.dueTime),
    startDate: task.startDate ?? null,
    startTime: clockMinutes(task.startTime),
    timeZone: task.timeZone ?? '',
    remindAt: task.remindAt ?? null,
    remindTouched: false,
  }
}

/** The editor's phases (design §7.3). */
export type EditorPhase = 'idle' | 'pending' | 'reloading' | 'conflict'

export type TaskDraftField =
  | 'title'
  | 'description'
  | 'dueDate'
  | 'dueTime'
  | 'startDate'
  | 'startTime'
  | 'timeZone'
  | 'remindAt'

/** The editor state the detail page holds (design §4.3): the draft, whether it differs from the
 *  server's values, the phase, the version a 409 reported, the inline error code per field, and
 *  whether a reload landed while the draft was dirty. */
export interface EditorState {
  draft: TaskDraft | null
  dirty: boolean
  phase: EditorPhase
  conflictVersion: number | null
  fieldErrors: Partial<Record<TaskDraftField, string>>
  serverUpdated: boolean
}

export function createEditorState(): EditorState {
  return { draft: null, dirty: false, phase: 'idle', conflictVersion: null, fieldErrors: {}, serverUpdated: false }
}

/** Where an inline editor error renders: next to one of the draft's fields, or next to the submit
 *  button for a code that names no field. */
export type EditorErrorSlot = TaskDraftField | 'form'

type RebasedField = Exclude<TaskDraftField, 'remindAt'>

// RULED(2026-10-07): [R03] — a draft survives a reload of the task, the 409 reload included
// (design §4.3, §7.3, §12-Q6). Which part of it survives is `[fe-19]`, below.
/**
 * The draft carried across a reload (`[fe-19]`). A field the viewer changed — `draft` differs from
 * `base`, the values the draft was taken from — keeps the viewer's value; every other field takes
 * `next`, the reloaded values. A later save therefore sends the viewer's own changes and never
 * writes an older value back over a field someone else changed in between. The reminder counts as
 * changed only when it was touched and differs; `remindTouched` follows that. All three drafts are
 * in the canonical form (`initDraft`).
 */
export function rebaseDraft(base: TaskDraft, draft: TaskDraft, next: TaskDraft): TaskDraft {
  const keep = <K extends RebasedField>(key: K): TaskDraft[K] => (draft[key] !== base[key] ? draft[key] : next[key])
  const remindChanged = draft.remindTouched && draft.remindAt !== base.remindAt
  return {
    title: keep('title'),
    description: keep('description'),
    dueDate: keep('dueDate'),
    dueTime: keep('dueTime'),
    startDate: keep('startDate'),
    startTime: keep('startTime'),
    timeZone: keep('timeZone'),
    remindAt: remindChanged ? draft.remindAt : next.remindAt,
    remindTouched: remindChanged,
  }
}

// ---- pre-checks (mirror of task-edit.ts) ----------------------------------------------------

/** Title: non-empty after normalization, storable. */
export function checkTaskTitle(raw: string): 'ok' | 'INVALID_TITLE' {
  const normalized = normalizeUserText(raw)
  if (normalized === null || !isStorableText(normalized)) return 'INVALID_TITLE'
  return 'ok'
}

// ASSUMPTION(task-m4-fe): [own-31] (PR-3a) — the description is neither trimmed nor normalized.
/** Description: storable, at most `TASK_DESCRIPTION_MAX_CODEPOINTS` code points, measured as
 *  given. `''` is the cleared value. */
export function checkTaskDescription(raw: string): 'ok' | 'INVALID_DESCRIPTION' {
  if (!isStorableText(raw)) return 'INVALID_DESCRIPTION'
  if (codePointLength(raw) > TASK_DESCRIPTION_MAX_CODEPOINTS) return 'INVALID_DESCRIPTION'
  return 'ok'
}

const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const CLOCK_MINUTES_RE = /^(\d{2}):(\d{2})$/
// ASSUMPTION(task-m4-fe): [own-30] (PR-3a) — the client only ever produces `Date#toISOString()`
// output, so only that grammar is accepted here.
const REMIND_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/

/** A real calendar date: the year / month / day round-trip through `Date.UTC`, the server's own
 *  check (so `2031-02-30` and a two-digit-mapped year fail the same way there and here). */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

function isCalendarDateString(value: string): boolean {
  const match = CALENDAR_DATE_RE.exec(value)
  if (!match) return false
  return isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

function isClockMinutes(value: string): boolean {
  const match = CLOCK_MINUTES_RE.exec(value)
  if (!match) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/** A real calendar date for an instant, the server's `parseInstant` check: the parts round-trip
 *  through `setUTCFullYear`, so years 0001–0099 are real years here (unlike `isCalendarDate`). */
function isInstantDate(year: number, month: number, day: number): boolean {
  const probe = new Date(0)
  probe.setUTCFullYear(year, month - 1, day)
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** `null` passes; otherwise `YYYY-MM-DDTHH:MM:SS.sssZ` naming a real instant in years 0001–9999. */
export function checkRemindAt(raw: string | null): 'ok' | 'INVALID_REMIND_AT' {
  if (raw === null) return 'ok'
  const match = REMIND_AT_RE.exec(raw)
  if (!match) return 'INVALID_REMIND_AT'
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1 || year > 9999 || month < 1 || month > 12) return 'INVALID_REMIND_AT'
  if (!isInstantDate(year, month, Number(match[3]))) return 'INVALID_REMIND_AT'
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return 'INVALID_REMIND_AT'
  return 'ok'
}

const OFFSET_FORM_RE = /^(?:[+-]\d{1,2}(?::?\d{2})?|Z)$/i
const NAMED_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

// ASSUMPTION(task-m4-fe): [D7] — a case variant (`asia/shanghai`) passes; the server stores and
// answers with the canonical name.
/** A named IANA zone the platform knows: not an offset form, accepted by `Intl.DateTimeFormat`,
 *  and resolving to a named zone. Edge whitespace is ignored, as the server ignores it. */
export function isValidTimeZoneName(zone: string): boolean {
  const trimmed = zone.trim()
  if (trimmed.length === 0 || OFFSET_FORM_RE.test(trimmed)) return false
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat(undefined, { timeZone: trimmed }).resolvedOptions().timeZone
  } catch {
    return false
  }
  return NAMED_ZONE_RE.test(canonical) && !OFFSET_FORM_RE.test(canonical)
}

export type TaskDateField = 'dueDate' | 'dueTime' | 'startDate' | 'startTime' | 'timeZone'
export type TaskDatesCode = 'INVALID_DATE' | 'TIME_ZONE_REQUIRED' | 'INVALID_TIME_ZONE'
export type TaskDatesCheck = { ok: true } | { ok: false; code: TaskDatesCode; field: TaskDateField }

function emptyToNull(value: string | null): string | null {
  return value === '' ? null : value
}

// ASSUMPTION(task-m4-fe): [own-07] (PR-3a) — a date needs a zone. [own-29] (PR-3a) — an empty
// zone reads as none: with a date it is TIME_ZONE_REQUIRED, without one it is allowed.
/** The date rules of `planTaskDates`, on the draft as the intended end state and in the server's
 *  order: each date is a real `YYYY-MM-DD`; a time needs its date; each time is `HH:MM` within
 *  range; a non-empty zone must be a valid name; a date needs a non-empty zone. */
export function checkTaskDates(draft: Pick<TaskDraft, TaskDateField>): TaskDatesCheck {
  const dueDate = emptyToNull(draft.dueDate)
  const dueTime = emptyToNull(draft.dueTime)
  const startDate = emptyToNull(draft.startDate)
  const startTime = emptyToNull(draft.startTime)
  if (dueDate !== null && !isCalendarDateString(dueDate)) return { ok: false, code: 'INVALID_DATE', field: 'dueDate' }
  if (startDate !== null && !isCalendarDateString(startDate)) return { ok: false, code: 'INVALID_DATE', field: 'startDate' }
  if (dueTime !== null && dueDate === null) return { ok: false, code: 'INVALID_DATE', field: 'dueTime' }
  if (startTime !== null && startDate === null) return { ok: false, code: 'INVALID_DATE', field: 'startTime' }
  if (dueTime !== null && !isClockMinutes(dueTime)) return { ok: false, code: 'INVALID_DATE', field: 'dueTime' }
  if (startTime !== null && !isClockMinutes(startTime)) return { ok: false, code: 'INVALID_DATE', field: 'startTime' }
  const zone = draft.timeZone
  if (zone !== '' && !isValidTimeZoneName(zone)) return { ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' }
  const hasDate = dueDate !== null || startDate !== null
  if (hasDate && zone === '') return { ok: false, code: 'TIME_ZONE_REQUIRED', field: 'timeZone' }
  return { ok: true }
}

// RULED(2026-10-07): [R03] — the patch is the key-by-key difference between the draft and the
// server's values.
// ASSUMPTION(task-m4-fe): [own-06] (PR-3a) — `remindAt` is never derived from a date change.
/**
 * The keys of `draft` that differ from `initDraft(current)` (both in the canonical form, so
 * `'10:00:00'` against `'10:00'`, a `null` description against `''` and a `null` zone against `''`
 * are never changes), with the server's coupling rules applied: clearing a date clears its time
 * in the same body; a body that touches a date key and leaves a date on the task carries
 * `timeZone` (the draft's value, `null` for an empty one); a zone change alone carries only
 * `timeZone`; `remindAt` enters only when touched. `null` when nothing differs.
 *
 * The title is compared normalized; a title that normalizes to nothing is placed as typed so
 * `checkTaskTitle` reports it.
 */
export function buildTaskPatch(current: TaskDraftSource, draft: TaskDraft): TaskPatch | null {
  const base = initDraft(current)
  const patch: TaskPatch = {}

  const title = normalizeUserText(draft.title) ?? draft.title
  if (title !== base.title) patch.title = title
  if (draft.description !== base.description) patch.description = draft.description

  const dueDate = emptyToNull(draft.dueDate)
  const startDate = emptyToNull(draft.startDate)
  let dueTime = emptyToNull(draft.dueTime)
  let startTime = emptyToNull(draft.startTime)
  if (dueDate === null && base.dueDate !== null) dueTime = null
  if (startDate === null && base.startDate !== null) startTime = null
  if (dueDate !== base.dueDate) patch.dueDate = dueDate
  if (dueTime !== base.dueTime) patch.dueTime = dueTime
  if (startDate !== base.startDate) patch.startDate = startDate
  if (startTime !== base.startTime) patch.startTime = startTime

  const touchedDates = 'dueDate' in patch || 'dueTime' in patch || 'startDate' in patch || 'startTime' in patch
  const hasDate = dueDate !== null || startDate !== null
  const zoneChanged = draft.timeZone !== base.timeZone
  if ((touchedDates && hasDate) || zoneChanged) patch.timeZone = draft.timeZone === '' ? null : draft.timeZone

  if (draft.remindTouched && draft.remindAt !== base.remindAt) patch.remindAt = draft.remindAt

  return Object.keys(patch).length === 0 ? null : patch
}

// ---- settings (mirror of task-settings.ts) --------------------------------------------------

/** The settings form's working copy: the closed-set fields as strings (a control's value), the
 *  zone as `''` for the server's `null`. */
export interface SettingsDraft {
  badgeScope: string
  dailyReminderEnabled: boolean
  defaultRemindPolicy: { mode: string }
  timeZone: string
}

export type SettingsField = 'badgeScope' | 'dailyReminderEnabled' | 'defaultRemindPolicy' | 'timeZone'
export type SettingsCode = 'INVALID_BADGE_SCOPE' | 'INVALID_POLICY' | 'INVALID_TIME_ZONE' | 'DAILY_REMINDER_REQUIRES_TIME_ZONE'
export type SettingsCheck = { ok: true } | { ok: false; code: SettingsCode; field: SettingsField }

export function initSettingsDraft(settings: TaskSettings): SettingsDraft {
  return {
    badgeScope: settings.badgeScope,
    dailyReminderEnabled: settings.dailyReminderEnabled,
    defaultRemindPolicy: { mode: settings.defaultRemindPolicy.mode },
    timeZone: settings.timeZone ?? '',
  }
}

// RULED(2026-10-07): [R02] [R07] — the closed sets and the zone the daily reminder requires.
/** The rules of `parseSettingsPatch` on the whole draft, in the server's order: the two closed
 *  sets, a non-empty zone must be a valid name, the daily reminder needs a zone. */
export function checkSettingsDraft(draft: SettingsDraft): SettingsCheck {
  if (!(TASK_BADGE_SCOPES as readonly string[]).includes(draft.badgeScope)) {
    return { ok: false, code: 'INVALID_BADGE_SCOPE', field: 'badgeScope' }
  }
  if (!(TASK_REMIND_MODES as readonly string[]).includes(draft.defaultRemindPolicy.mode)) {
    return { ok: false, code: 'INVALID_POLICY', field: 'defaultRemindPolicy' }
  }
  if (draft.timeZone !== '' && !isValidTimeZoneName(draft.timeZone)) {
    return { ok: false, code: 'INVALID_TIME_ZONE', field: 'timeZone' }
  }
  if (draft.dailyReminderEnabled && draft.timeZone === '') {
    return { ok: false, code: 'DAILY_REMINDER_REQUIRES_TIME_ZONE', field: 'timeZone' }
  }
  return { ok: true }
}

/** The keys of `draft` that differ from `current`: an empty zone is sent as `null`;
 *  `badgeScope` and `defaultRemindPolicy` are placed as typed (never `null`) so
 *  `checkSettingsDraft` reports a value outside the closed set. `null` when nothing differs. */
export function buildSettingsPatch(current: TaskSettings, draft: SettingsDraft): TaskSettingsPatch | null {
  const patch: TaskSettingsPatch = {}
  if (draft.badgeScope !== current.badgeScope) patch.badgeScope = draft.badgeScope as TaskBadgeScope
  if (draft.dailyReminderEnabled !== current.dailyReminderEnabled) patch.dailyReminderEnabled = draft.dailyReminderEnabled
  if (draft.defaultRemindPolicy.mode !== current.defaultRemindPolicy.mode) {
    patch.defaultRemindPolicy = { mode: draft.defaultRemindPolicy.mode as TaskRemindMode }
  }
  if (draft.timeZone !== (current.timeZone ?? '')) patch.timeZone = draft.timeZone === '' ? null : draft.timeZone
  return Object.keys(patch).length === 0 ? null : patch
}

// ---- list / group names (mirror of task-lists.ts / task-groups.ts) --------------------------

/** A list or group name: non-empty after normalization, storable, at most
 *  `TASK_NAME_MAX_CODEPOINTS` code points. */
export function checkListName(raw: string): 'ok' | 'INVALID_NAME' | 'NAME_TOO_LONG' {
  const normalized = normalizeUserText(raw)
  if (normalized === null) return 'INVALID_NAME'
  if (codePointLength(normalized) > TASK_NAME_MAX_CODEPOINTS) return 'NAME_TOO_LONG'
  if (!isStorableText(normalized)) return 'INVALID_NAME'
  return 'ok'
}

/** Same rules as `checkListName`. */
export function checkGroupName(raw: string): 'ok' | 'INVALID_NAME' | 'NAME_TOO_LONG' {
  return checkListName(raw)
}
