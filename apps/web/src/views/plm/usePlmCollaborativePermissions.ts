import { computed, watch, type ComputedRef, type Ref } from 'vue'

type CollaborativeEntry = {
  canManage?: boolean
  isArchived?: boolean
  isDefault?: boolean
  ownerUserId?: string
  permissions?: {
    canManage?: boolean
    canApply?: boolean
    canDuplicate?: boolean
    canShare?: boolean
    canDelete?: boolean
    canArchive?: boolean
    canRestore?: boolean
    canRename?: boolean
    canTransfer?: boolean
    canSetDefault?: boolean
    canClearDefault?: boolean
  }
} | null

export type PlmCollaborativePermissionEntry = CollaborativeEntry

function resolveCanManage(entry: CollaborativeEntry) {
  if (!entry) return false
  if (typeof entry.permissions?.canManage === 'boolean') {
    return entry.permissions.canManage
  }
  return Boolean(entry.canManage)
}

export function canSharePlmCollaborativeEntry(entry: CollaborativeEntry) {
  if (!entry) return false
  if (typeof entry.permissions?.canShare === 'boolean') {
    return entry.permissions.canShare
  }
  return resolveCanManage(entry) && !entry.isArchived
}

export function canApplyPlmCollaborativeEntry(entry: CollaborativeEntry) {
  if (!entry) return false
  if (typeof entry.permissions?.canApply === 'boolean') {
    return entry.permissions.canApply
  }
  return !entry.isArchived
}

export function canDuplicatePlmCollaborativeEntry(entry: CollaborativeEntry) {
  if (!entry) return false
  if (typeof entry.permissions?.canDuplicate === 'boolean') {
    return entry.permissions.canDuplicate
  }
  return true
}

export function canSetDefaultPlmCollaborativeEntry(entry: CollaborativeEntry) {
  if (!entry) return false
  if (typeof entry.permissions?.canSetDefault === 'boolean') {
    return entry.permissions.canSetDefault
  }
  return resolveCanManage(entry) && !entry.isArchived && !entry.isDefault
}

type UsePlmCollaborativePermissionsOptions<TEntry extends CollaborativeEntry> = {
  selectedEntry: ComputedRef<TEntry>
  nameRef: Ref<string>
  ownerUserIdRef?: Ref<string>
}

export function usePlmCollaborativePermissions<TEntry extends CollaborativeEntry>(
  options: UsePlmCollaborativePermissionsOptions<TEntry>,
) {
  const canManageSelectedEntry = computed(() => {
    const entry = options.selectedEntry.value
    return resolveCanManage(entry)
  })
  const showManagementActions = computed(
    () => !options.selectedEntry.value || canManageSelectedEntry.value,
  )
  const canApply = computed(() => {
    return canApplyPlmCollaborativeEntry(options.selectedEntry.value)
  })
  const canDuplicate = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    if (typeof entry.permissions?.canDuplicate === 'boolean') {
      return entry.permissions.canDuplicate
    }
    return true
  })
  const canShare = computed(() => {
    return canSharePlmCollaborativeEntry(options.selectedEntry.value)
  })
  const canDelete = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    if (typeof entry.permissions?.canDelete === 'boolean') {
      return entry.permissions.canDelete
    }
    return canManageSelectedEntry.value
  })
  const canArchive = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    if (typeof entry.permissions?.canArchive === 'boolean') {
      return entry.permissions.canArchive
    }
    return canManageSelectedEntry.value && !entry.isArchived
  })
  const canRestore = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    if (typeof entry.permissions?.canRestore === 'boolean') {
      return entry.permissions.canRestore
    }
    return canManageSelectedEntry.value && Boolean(entry.isArchived)
  })
  const canRename = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    const canRenameEntry =
      typeof entry.permissions?.canRename === 'boolean'
        ? entry.permissions.canRename
        : canManageSelectedEntry.value && !entry.isArchived
    return canRenameEntry && Boolean(options.nameRef.value.trim())
  })
  const canTransferTarget = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    return (
      typeof entry.permissions?.canTransfer === 'boolean'
        ? entry.permissions.canTransfer
        : canManageSelectedEntry.value && !entry.isArchived
    )
  })
  const canTransfer = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    const targetOwnerUserId = options.ownerUserIdRef?.value.trim() || ''
    return (
      canTransferTarget.value
      && Boolean(targetOwnerUserId)
      && targetOwnerUserId !== entry.ownerUserId
    )
  })
  const canSetDefault = computed(() => {
    const entry = options.selectedEntry.value
    return canSetDefaultPlmCollaborativeEntry(entry)
  })
  const canClearDefault = computed(() => {
    const entry = options.selectedEntry.value
    if (!entry) return false
    if (typeof entry.permissions?.canClearDefault === 'boolean') {
      return entry.permissions.canClearDefault
    }
    return canManageSelectedEntry.value && !entry.isArchived && Boolean(entry.isDefault)
  })

  watch(
    options.selectedEntry,
    (entry) => {
      if (!resolveCanManage(entry) && options.ownerUserIdRef) {
        options.ownerUserIdRef.value = ''
      }
    },
    { immediate: true },
  )

  return {
    canManageSelectedEntry,
    showManagementActions,
    canApply,
    canDuplicate,
    canShare,
    canDelete,
    canArchive,
    canRestore,
    canRename,
    canTransferTarget,
    canTransfer,
    canSetDefault,
    canClearDefault,
  }
}
