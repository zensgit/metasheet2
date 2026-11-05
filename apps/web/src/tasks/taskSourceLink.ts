// Package 2 (S-G2): the link from a task's detail back to the multitable record it was dispatched
// from. PURE, no I/O, no router: it returns the app path, and the detail renders it with
// `<router-link>`, which resolves it through the router (so an app served under a sub-path gets its
// base) — the same route and `?recordId=` query the record drawer and the comment inbox open a record
// with (`/multitable/:sheetId/:viewId`, router/types.ts).
//
// Ids only: nothing is read from the record, and the task page never asks whether the viewer may
// read it — the record page decides that when the link is followed.
//
// The link is REFUSED (`null`, the row then shows without a link) when the source has no view (the
// route needs a view segment) or when any id is not a plain path segment. The rule mirrors the
// service's `isValidSourceId` (core-backend tasks/task-source-links.ts): printable ASCII, 1..255,
// not `.` or `..`, none of `/ ? # % \`. The service refuses such ids at create, so a refusal here
// only meets a body the service did not write.
import type { TaskDetailSource } from './tasksApi'

/** Upper bound on a source id, the service's `TASK_SOURCE_ID_MAX_LENGTH`. */
export const TASK_SOURCE_ID_MAX_LENGTH = 255

const PRINTABLE_ASCII = /^[!-~]+$/
const PATH_SEGMENT_BREAKERS = /[/?#%\\]/

/** Whether `value` is an id the link may carry: the service's source-id rule. */
export function isPlainSourceSegment(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= TASK_SOURCE_ID_MAX_LENGTH
    && PRINTABLE_ASCII.test(value)
    && value !== '.'
    && value !== '..'
    && !PATH_SEGMENT_BREAKERS.test(value)
}

/**
 * The app path of the record a task came from, `/multitable/<sheet>/<view>?baseId=<base>&recordId=<record>`
 * (`baseId` only when the source carries one), or `null` when no link can be built: no `viewId`, or
 * an id that is not a plain path segment. Every id is URI-encoded.
 */
export function taskSourceRecordPath(source: TaskDetailSource): string | null {
  const { sheetId, recordId, viewId, baseId } = source
  if (viewId === null) return null
  if (!isPlainSourceSegment(sheetId) || !isPlainSourceSegment(viewId) || !isPlainSourceSegment(recordId)) return null
  if (baseId !== null && !isPlainSourceSegment(baseId)) return null
  const query = new URLSearchParams()
  if (baseId !== null) query.set('baseId', baseId)
  query.set('recordId', recordId)
  return `/multitable/${encodeURIComponent(sheetId)}/${encodeURIComponent(viewId)}?${query.toString()}`
}
