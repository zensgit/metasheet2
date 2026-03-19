import { describe, expect, it } from 'vitest'
import { buildPlmCollaborativePermissions } from '../../src/plm/plmCollaborativePermissions'

describe('plmCollaborativePermissions', () => {
  it('builds full manage permissions for an active owner entry', () => {
    expect(
      buildPlmCollaborativePermissions({
        ownerUserId: 'owner-1',
        currentUserId: 'owner-1',
        isArchived: false,
        isDefault: false,
      }),
    ).toEqual({
      canManage: true,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canRename: true,
      canTransfer: true,
      canSetDefault: true,
      canClearDefault: false,
    })
  })

  it('builds readonly permissions for a transferred entry', () => {
    expect(
      buildPlmCollaborativePermissions({
        ownerUserId: 'owner-2',
        currentUserId: 'owner-1',
        isArchived: false,
        isDefault: true,
      }),
    ).toEqual({
      canManage: false,
      canApply: true,
      canDuplicate: true,
      canShare: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canRename: false,
      canTransfer: false,
      canSetDefault: false,
      canClearDefault: false,
    })
  })

  it('builds archived owner permissions with restore only', () => {
    expect(
      buildPlmCollaborativePermissions({
        ownerUserId: 'owner-1',
        currentUserId: 'owner-1',
        isArchived: true,
        isDefault: false,
      }),
    ).toEqual({
      canManage: true,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canDelete: true,
      canArchive: false,
      canRestore: true,
      canRename: false,
      canTransfer: false,
      canSetDefault: false,
      canClearDefault: false,
    })
  })
})
