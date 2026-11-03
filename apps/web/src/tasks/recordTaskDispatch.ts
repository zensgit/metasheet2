/**
 * 派发任务 from a multitable record (owner ruling R-45 step 1) — the pure half: assignee ids, the
 * create body, the source line, and the reading of a failed create. No I/O; the dialog
 * (`MetaRecordTaskDispatchDialog.vue`) does the two writes through `tasksApi.ts`.
 *
 * What may leave the record: the title the dispatcher sees and confirms, the user ids they confirm as
 * assignees, and the record's deep link (ids only). Nothing else from `record.data` is ever read here.
 */
import type { CompletionMode, CreateTaskInput, CreateTaskResult } from './tasksApi'
import { buildCreateDue, normalizeUserText, checkTaskTitle, type CreateDueKeys } from './tasksDraft'

/** The server's assignee soft limit (`TASK_ASSIGNEE_SOFT_LIMIT`), counted on distinct ids. */
export const DISPATCH_ASSIGNEE_LIMIT = 50
/** The server's member id bound (`MEMBER_ID_MAX_LENGTH`). */
const MEMBER_ID_MAX_LENGTH = 255
const PRINTABLE_ID = /^[!-~]+$/

/** Mirror of the server's `isValidMemberId`: printable ASCII, 1..255 long, not `.` or `..`. */
export function isValidAssigneeId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MEMBER_ID_MAX_LENGTH
    && PRINTABLE_ID.test(value)
    && value !== '.'
    && value !== '..'
}

/** The user ids stored in a native person field's value (`userId[]`): only valid id strings, in
 *  order, each once. Anything else in a dirty value (objects, numbers, blanks) is dropped. */
export function personValueAssigneeIds(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
  const out: string[] = []
  for (const item of items) {
    if (isValidAssigneeId(item) && !out.includes(item)) out.push(item)
  }
  return out
}

/** Typed input: ids separated by commas (ASCII or full-width), the Chinese enumeration comma,
 *  semicolons or whitespace. */
export function splitTypedAssigneeIds(raw: string): string[] {
  return raw.split(/[\s,，、;；]+/u).filter((part) => part.length > 0)
}

export type AddAssigneesResult =
  | { ok: true; ids: string[] }
  | { ok: false; code: 'INVALID' | 'LIMIT' }

/** `current` plus `added`, deduplicated in order. Refuses (and changes nothing) when an added id is
 *  not a valid member id or the distinct total would pass the limit. */
export function addAssignees(current: readonly string[], added: readonly string[]): AddAssigneesResult {
  if (added.some((id) => !isValidAssigneeId(id))) return { ok: false, code: 'INVALID' }
  const ids = [...current]
  for (const id of added) if (!ids.includes(id)) ids.push(id)
  if (ids.length > DISPATCH_ASSIGNEE_LIMIT) return { ok: false, code: 'LIMIT' }
  return { ok: true, ids }
}

export interface DispatchDraft {
  title: string
  assignees: readonly string[]
  completionMode: CompletionMode
  /** `'YYYY-MM-DD'` from the date control, `''` when empty. Required. */
  dueDate: string
  /** `'HH:MM'` from the time control, `''` when empty. Optional. */
  dueTime: string
}

export type DispatchCheckCode =
  | 'TITLE_REQUIRED'
  | 'INVALID_TITLE'
  | 'DUE_DATE_REQUIRED'
  | 'ZONE_UNAVAILABLE'
  | 'INVALID_DATE'
  | 'INVALID_TIME_ZONE'
  | 'TIME_ZONE_REQUIRED'
  | 'INVALID_ASSIGNEES'
  | 'LIMIT'

export type DispatchBuildResult = { ok: true; input: CreateTaskInput } | { ok: false; code: DispatchCheckCode }

/**
 * The `POST /api/tasks` body for a dispatch, or the first pre-check that fails. `zone` is the
 * viewer's usable zone (`usableViewerTimeZone()`), the one the task create form sends.
 *
 * Keys: `title` (normalized as the server normalizes it), `completionMode`, the due keys of
 * `buildCreateDue` (a due date is REQUIRED here, so they are always present), and `assignees` only
 * when the dispatcher named someone. With no assignee the key is OMITTED, which makes the dispatcher
 * the sole assignee — the task create form's behaviour; an explicit `[]` would create a task nobody
 * is assigned to.
 */
export function buildDispatchCreateInput(draft: DispatchDraft, zone: string): DispatchBuildResult {
  const title = normalizeUserText(draft.title)
  if (title === null) return { ok: false, code: 'TITLE_REQUIRED' }
  if (checkTaskTitle(title) !== 'ok') return { ok: false, code: 'INVALID_TITLE' }
  if (draft.dueDate === '') return { ok: false, code: 'DUE_DATE_REQUIRED' }
  const due = buildCreateDue(draft.dueDate, draft.dueTime, zone)
  if (!due.ok) return { ok: false, code: due.code }
  if (draft.assignees.some((id) => !isValidAssigneeId(id))) return { ok: false, code: 'INVALID_ASSIGNEES' }
  const assignees = [...new Set(draft.assignees)]
  if (assignees.length > DISPATCH_ASSIGNEE_LIMIT) return { ok: false, code: 'LIMIT' }
  const dueKeys: CreateDueKeys = due.keys
  const input: CreateTaskInput = { title, completionMode: draft.completionMode, ...dueKeys }
  if (assignees.length > 0) input.assignees = assignees
  return { ok: true, input }
}

/** The plain description line naming the source record: a fixed prefix and the deep link. */
export function buildSourceLine(prefix: string, link: string): string {
  return `${prefix} ${link}`
}

/** How a failed create reads in the dialog. Each kind has its own plain message. */
export type DispatchFailure =
  | 'INACTIVE_ORG_MEMBER'
  | 'ASSIGNEE_TASK_ACCESS_REQUIRED'
  | 'INVALID_ASSIGNEES'
  | 'LIMIT'
  | 'ORG_MISSING'
  | 'FORBIDDEN'
  | 'TASKS_UNAVAILABLE'
  | 'INVALID_TITLE'
  | 'INVALID_DATE'
  | 'FAILED'

/**
 * A failed `createTask` result to its message kind. 403 is the missing `tasks:write`; 404 is
 * `/api/tasks` not mounted, i.e. the tasks feature switched off on the server since the page loaded.
 */
export function classifyDispatchFailure(result: Exclude<CreateTaskResult, { kind: 'ok' }>): DispatchFailure {
  switch (result.kind) {
    case 'org_missing':
      return 'ORG_MISSING'
    case 'forbidden':
      return 'FORBIDDEN'
    case 'not_found':
      return 'TASKS_UNAVAILABLE'
    case 'invalid_title':
      return 'INVALID_TITLE'
    case 'validation':
      if (result.code === 'INACTIVE_ORG_MEMBER' || result.code === 'INVALID_ASSIGNEES' || result.code === 'LIMIT') {
        return result.code
      }
      // An assignee who cannot use the task feature yet.
      if (result.code === 'ASSIGNEE_TASK_ACCESS_REQUIRED') return 'ASSIGNEE_TASK_ACCESS_REQUIRED'
      if (result.code === 'INVALID_DATE' || result.code === 'INVALID_TIME_ZONE' || result.code === 'TIME_ZONE_REQUIRED') {
        return 'INVALID_DATE'
      }
      return 'FAILED'
    default:
      return 'FAILED'
  }
}
