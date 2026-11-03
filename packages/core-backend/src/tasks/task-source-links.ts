/**
 * Task feature — the source of a task dispatched from a multitable record, and the client's retry key
 * for one dispatch: parsing of the two optional `POST /api/tasks` keys. PURE, no I/O.
 *
 * `source` is `{ sheetId, recordId, viewId?, baseId? }`. Every id has the member-id shape (printable
 * ASCII, 1..255, not `.` or `..`) and is a plain path segment: none of `/ ? # % \`, because the ids are
 * put back into the record link every task viewer sees. `viewId` and `baseId` may be omitted or null.
 * `dispatchKey` has the shape the `task_source_links.dispatch_key` CHECK allows and is accepted only
 * with a `source`. Either body key is absent only when its value is `undefined`; any other value is
 * checked, so an explicit `null` `source` or `dispatchKey` is refused like any other malformed value.
 * A body with neither key parses to `{ source: null, dispatchKey: null }`, and the create is the one it
 * was without them.
 */
import { isValidPrintableAsciiId } from './task-ids'

/** The only `task_source_links.source_type` today. */
export const TASK_SOURCE_TYPE_RECORD = 'multitable_record' as const

/** Upper bound on a source id, the member-id bound (`MEMBER_ID_MAX_LENGTH`, services/task-create.ts). */
export const TASK_SOURCE_ID_MAX_LENGTH = 255

const PATH_SEGMENT_BREAKERS = /[/?#%\\]/
const DISPATCH_KEY = /^[A-Za-z0-9_-]{8,64}$/

/** The parsed source of a dispatch; absent optional ids are `null`. */
export interface TaskSourceRef {
  sheetId: string
  recordId: string
  viewId: string | null
  baseId: string | null
}

export type TaskSourceParseReason = 'invalid_source' | 'invalid_dispatch_key'

export type TaskSourceParse =
  | { ok: true; source: TaskSourceRef | null; dispatchKey: string | null }
  | { ok: false; reason: TaskSourceParseReason }

/** A source id: the member-id shape and a plain path segment. */
export function isValidSourceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= TASK_SOURCE_ID_MAX_LENGTH
    && isValidPrintableAsciiId(value)
    && value !== '.'
    && value !== '..'
    && !PATH_SEGMENT_BREAKERS.test(value)
}

/** A retry key of the shape `task_source_links.dispatch_key` accepts. */
export function isDispatchKey(value: unknown): value is string {
  return typeof value === 'string' && DISPATCH_KEY.test(value)
}

function optionalSourceId(value: unknown): { ok: true; id: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, id: null }
  return isValidSourceId(value) ? { ok: true, id: value } : { ok: false }
}

/** Whether `value` is a `TaskSourceRef` every id of which passes `isValidSourceId`. */
export function isTaskSourceRef(value: unknown): value is TaskSourceRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return isValidSourceId(ref.sheetId)
    && isValidSourceId(ref.recordId)
    && (ref.viewId === null || isValidSourceId(ref.viewId))
    && (ref.baseId === null || isValidSourceId(ref.baseId))
}

/**
 * The two keys of a create body. `source` is checked first: a malformed source is `invalid_source`
 * whatever the key is. A key without a source, or of another shape, is `invalid_dispatch_key`.
 */
export function parseTaskSourceInput(input: { source?: unknown; dispatchKey?: unknown }): TaskSourceParse {
  const raw = input.source
  let source: TaskSourceRef | null = null
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'invalid_source' }
    const fields = raw as Record<string, unknown>
    if (!isValidSourceId(fields.sheetId) || !isValidSourceId(fields.recordId)) return { ok: false, reason: 'invalid_source' }
    const viewId = optionalSourceId(fields.viewId)
    const baseId = optionalSourceId(fields.baseId)
    if (viewId.ok === false || baseId.ok === false) return { ok: false, reason: 'invalid_source' }
    source = { sheetId: fields.sheetId, recordId: fields.recordId, viewId: viewId.id, baseId: baseId.id }
  }
  const key = input.dispatchKey
  if (key === undefined) return { ok: true, source, dispatchKey: null }
  if (source === null || !isDispatchKey(key)) return { ok: false, reason: 'invalid_dispatch_key' }
  return { ok: true, source, dispatchKey: key }
}

/** Rows a record's list of tasks answers when the caller names no page size. */
export const RECORD_TASK_LIST_DEFAULT_LIMIT = 20

/** The most rows a record's list of tasks answers. */
export const RECORD_TASK_LIST_MAX_LIMIT = 100

/**
 * The page size of a record's list of tasks: an integer in `1..RECORD_TASK_LIST_MAX_LIMIT`. A value
 * above the bound is the bound; an absent, non-integer or non-positive value is the default.
 */
export function clampRecordTaskListLimit(value: unknown): number {
  const raw = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return RECORD_TASK_LIST_DEFAULT_LIMIT
  return Math.min(raw, RECORD_TASK_LIST_MAX_LIMIT)
}
