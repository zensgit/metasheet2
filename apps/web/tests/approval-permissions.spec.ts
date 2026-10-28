import { beforeEach, describe, expect, it } from 'vitest'
import { useApprovalPermissions } from '../src/approvals/permissions'

beforeEach(() => {
  localStorage.clear()
})

describe('approval permission grants follow the decision route', () => {
  it.each([
    { name: 'no grants', codes: [], roles: [], expected: [false, false, false, false] },
    { name: 'reader', codes: ['approvals:read'], roles: [], expected: [true, false, false, false] },
    { name: 'writer does not imply read or act', codes: ['approvals:write'], roles: [], expected: [false, true, false, false] },
    { name: 'actor', codes: ['approvals:act'], roles: [], expected: [false, false, true, false] },
    { name: 'approval wildcard', codes: ['approvals:*'], roles: [], expected: [true, true, true, false] },
    { name: 'global wildcard', codes: ['*:*'], roles: [], expected: [true, true, true, true] },
    { name: 'administrator role without codes', codes: [], roles: ['admin'], expected: [true, true, true, true] },
    { name: 'template wildcard stays in its resource', codes: ['approval-templates:*'], roles: [], expected: [false, false, false, true] },
    { name: 'unrelated wildcard', codes: ['attendance:*'], roles: [], expected: [false, false, false, false] },
    { name: 'approval admin code is not a wildcard', codes: ['approvals:admin'], roles: [], expected: [false, false, false, false] },
  ])('$name', ({ codes, roles, expected }) => {
    localStorage.setItem('user_permissions', JSON.stringify(codes))
    localStorage.setItem('user_roles', JSON.stringify(roles))
    const access = useApprovalPermissions()

    expect([
      access.canRead.value,
      access.canWrite.value,
      access.canAct.value,
      access.canManageTemplates.value,
    ]).toEqual(expected)
  })
})
