/**
 * Pure create-time assignee choice. Omitted field inserts the creator.
 * An explicit empty array inserts nobody. A non-empty array inserts only
 * the listed users.
 */
export function resolveCreateAssigneeIds(input: {
  assignees: unknown
  creatorId: string
}): string[] {
  if (input.assignees === undefined) return [input.creatorId]
  if (!Array.isArray(input.assignees)) {
    throw Object.assign(new Error('assignees must be an array'), { status: 422, code: 'INVALID_ASSIGNEES' })
  }
  const ids = input.assignees.map((value) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error('assignee id must be a string'), { status: 422, code: 'INVALID_ASSIGNEES' })
    }
    return value
  })
  return [...new Set(ids)]
}
