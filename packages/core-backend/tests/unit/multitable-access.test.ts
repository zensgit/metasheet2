import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

import {
  deriveCapabilities,
  deriveFieldPermissions,
  deriveRowActions,
  deriveViewPermissions,
  normalizePermissionCodes,
  resolveRequestAccess,
} from '../../src/multitable/access'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'

describe('multitable access helper', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('normalizes permission arrays and drops invalid entries', () => {
    expect(normalizePermissionCodes([' multitable:read ', '', 1, null] as unknown)).toEqual([
      'multitable:read',
    ])
  })

  it('prefers direct permissions from req.user without calling RBAC service', async () => {
    const req = {
      user: {
        id: 'user_1',
        perms: ['multitable:write'],
        roles: ['user'],
      },
    } as any

    const result = await resolveRequestAccess(req)

    expect(result).toEqual({
      permissions: ['multitable:write'],
      isAdminRole: false,
    })
    expect(listUserPermissions).not.toHaveBeenCalled()
    expect(isAdmin).not.toHaveBeenCalled()
  })

  it('falls back to RBAC service when direct permissions are absent', async () => {
    vi.mocked(listUserPermissions).mockResolvedValue(['comments:write'])
    vi.mocked(isAdmin).mockResolvedValue(false)

    const req = {
      user: {
        id: 'user_2',
        roles: ['user'],
      },
    } as any

    const result = await resolveRequestAccess(req)

    expect(result).toEqual({
      permissions: ['comments:write'],
      isAdminRole: false,
    })
    expect(listUserPermissions).toHaveBeenCalledWith('user_2')
    expect(isAdmin).toHaveBeenCalledWith('user_2')
  })

  it('derives full write capability set from multitable:write', () => {
    expect(deriveCapabilities(['multitable:write'], false)).toEqual({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageViews: true,
      canComment: false,
      canManageAutomation: false,
    })
  })

  it('derives field and view permissions from capabilities', () => {
    const capabilities = deriveCapabilities(['multitable:write', 'comments:write'], false)
    expect(
      deriveFieldPermissions(
        [{ id: 'fld_public' }, { id: 'fld_hidden' }],
        capabilities,
        { hiddenFieldIds: ['fld_hidden'] },
      ),
    ).toEqual({
      fld_public: { visible: true, readOnly: false },
      fld_hidden: { visible: false, readOnly: false },
    })
    expect(
      deriveViewPermissions([{ id: 'view_grid' }, { id: 'view_form' }], capabilities),
    ).toEqual({
      view_grid: { canAccess: true, canConfigure: true, canDelete: true },
      view_form: { canAccess: true, canConfigure: true, canDelete: true },
    })
    expect(deriveRowActions(capabilities)).toEqual({
      canEdit: true,
      canDelete: true,
      canComment: true,
    })
  })
})
