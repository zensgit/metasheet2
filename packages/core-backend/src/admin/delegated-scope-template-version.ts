import { createHash } from 'node:crypto'

/** Binds the department flags and group references that applying a template writes. */
export function delegatedScopeTemplateVersion(
  templateId: string,
  departments: readonly { directoryDepartmentId: string; includeChildren: boolean }[],
  memberGroups: readonly { id: string }[],
): string {
  const departmentBits = [...departments]
    .sort((left, right) => compareIds(left.directoryDepartmentId, right.directoryDepartmentId))
    .map(({ directoryDepartmentId, includeChildren }) => [directoryDepartmentId, includeChildren])
  const groupIds = memberGroups.map(({ id }) => id).sort(compareIds)
  return createHash('sha256').update(JSON.stringify([templateId, departmentBits, groupIds])).digest('hex')
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
