/**
 * Pure create-time assignee choice. Omitted field inserts the creator.
 * An explicit empty array inserts nobody. A non-empty array inserts only
 * the listed users. Ids must match the task_assignees printable CHECK or
 * the insert fails as 422, not a raw constraint error. More than
 * `TASK_ASSIGNEE_SOFT_LIMIT` distinct ids is 422 LIMIT.
 */
import { isStorableText } from '../tasks/task-ids'
import { TASK_ASSIGNEE_SOFT_LIMIT } from '../tasks/task-membership'

const PRINTABLE_ID = /^[!-~]+$/

// `isStorableText` lives with the other pure text rules in `src/tasks/task-ids.ts` (the M4 edit
// rules in `src/tasks/task-edit.ts` use it too); re-exported here for the existing importers.
export { isStorableText }

/**
 * Upper bound on a member (assignee/follower) id, in UTF-16 code units — the
 * id is printable ASCII, so this is also its byte and character length.
 * Well below the btree index-row limit on the `(task_id, user_id)` keys and
 * below URL length limits.
 */
export const MEMBER_ID_MAX_LENGTH = 255

/**
 * A value that can be bound as an existing id (task id, comment id, parent
 * id). Anything outside the printable set — U+0000 included — can match no
 * stored row, since every id column carries a printable CHECK, so callers
 * treat it as not found without sending it to the database.
 */
export function isPrintableId(value: unknown): value is string {
  return typeof value === 'string' && PRINTABLE_ID.test(value)
}

/**
 * Member (assignee/follower) user id validator, shared by every ingress
 * point (task creation here, and the M3 add-assignee/add-follower routes
 * in `task-structure.ts`) so a member id can never enter the system through
 * one path with a shape another path would have rejected. Printable, not
 * "." or "..", and at most `MEMBER_ID_MAX_LENGTH` long.
 */
export function isValidMemberId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MEMBER_ID_MAX_LENGTH
    && PRINTABLE_ID.test(value)
    && value !== '.'
    && value !== '..'
}

function rejectAssignees(): never {
  throw Object.assign(new Error('INVALID_ASSIGNEES'), { status: 422, code: 'INVALID_ASSIGNEES' })
}

export function resolveCreateAssigneeIds(input: {
  assignees: unknown
  creatorId: string
}): string[] {
  if (!isValidMemberId(input.creatorId)) rejectAssignees()
  if (input.assignees === undefined) return [input.creatorId]
  if (!Array.isArray(input.assignees)) rejectAssignees()
  const ids = input.assignees.map((value) => {
    if (!isValidMemberId(value)) rejectAssignees()
    return value
  })
  const distinct = [...new Set(ids)]
  // Same soft limit as the add-assignee route (M3R3-IN-2), counted on
  // distinct ids after every id has been validated.
  if (distinct.length > TASK_ASSIGNEE_SOFT_LIMIT) {
    throw Object.assign(new Error('LIMIT'), { status: 422, code: 'LIMIT' })
  }
  return distinct
}
