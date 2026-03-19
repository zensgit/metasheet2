export type PlmCollaborativePermissionsInput = {
  ownerUserId: string
  currentUserId?: string | null
  isArchived?: boolean
  isDefault?: boolean
}

export type PlmCollaborativePermissions = {
  canManage: boolean
  canApply: boolean
  canDuplicate: boolean
  canShare: boolean
  canDelete: boolean
  canArchive: boolean
  canRestore: boolean
  canRename: boolean
  canTransfer: boolean
  canSetDefault: boolean
  canClearDefault: boolean
}

export function buildPlmCollaborativePermissions(
  input: PlmCollaborativePermissionsInput,
): PlmCollaborativePermissions {
  const isArchived = Boolean(input.isArchived)
  const isDefault = Boolean(input.isDefault)
  const canManage = Boolean(input.currentUserId) && input.ownerUserId === input.currentUserId

  return {
    canManage,
    canApply: !isArchived,
    canDuplicate: true,
    canShare: canManage && !isArchived,
    canDelete: canManage,
    canArchive: canManage && !isArchived,
    canRestore: canManage && isArchived,
    canRename: canManage && !isArchived,
    canTransfer: canManage && !isArchived,
    canSetDefault: canManage && !isArchived && !isDefault,
    canClearDefault: canManage && !isArchived && isDefault,
  }
}
