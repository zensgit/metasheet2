/**
 * Pure create-time assignee choice. Omitted field inserts the creator.
 * An explicit empty array inserts nobody. A non-empty array inserts only
 * the listed users. Ids must match the task_assignees printable CHECK or
 * the insert fails as 422, not a raw constraint error.
 */
const PRINTABLE_ID = /^[!-~]+$/

function rejectAssignees(): never {
  throw Object.assign(new Error('INVALID_ASSIGNEES'), { status: 422, code: 'INVALID_ASSIGNEES' })
}

export function resolveCreateAssigneeIds(input: {
  assignees: unknown
  creatorId: string
}): string[] {
  if (!PRINTABLE_ID.test(input.creatorId)) rejectAssignees()
  if (input.assignees === undefined) return [input.creatorId]
  if (!Array.isArray(input.assignees)) rejectAssignees()
  const ids = input.assignees.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || !PRINTABLE_ID.test(value)) rejectAssignees()
    return value
  })
  return [...new Set(ids)]
}
