import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  canApplyPlmCollaborativeEntry,
  canDuplicatePlmCollaborativeEntry,
  canRenamePlmCollaborativeEntry,
  canSharePlmCollaborativeEntry,
  canSetDefaultPlmCollaborativeEntry,
  usePlmCollaborativePermissions,
} from '../src/views/plm/usePlmCollaborativePermissions'

describe('usePlmCollaborativePermissions', () => {
  it('prefers explicit entry permissions over fallback flags', () => {
    const selectedEntry = computed(() => ({
      canManage: true,
      isArchived: false,
      isDefault: false,
      ownerUserId: 'owner-a',
      permissions: {
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
      },
    }))
    const nameRef = ref('共享副本')
    const ownerUserIdRef = ref('other-owner')

    const model = usePlmCollaborativePermissions({
      selectedEntry,
      nameRef,
      ownerUserIdRef,
    })

    expect(model.canManageSelectedEntry.value).toBe(false)
    expect(model.showManagementActions.value).toBe(false)
    expect(model.canShare.value).toBe(false)
    expect(model.canTransfer.value).toBe(false)
    expect(model.canSetDefault.value).toBe(false)
    expect(ownerUserIdRef.value).toBe('')
  })

  it('derives duplicate, rename, transfer, archive, and restore states from archived/manageable entries', () => {
    const selectedEntry = ref({
      canManage: true,
      isArchived: false,
      isDefault: false,
      ownerUserId: 'owner-a',
      permissions: {
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
      },
    })
    const nameRef = ref('新的审计视图')
    const ownerUserIdRef = ref('owner-b')

    const model = usePlmCollaborativePermissions({
      selectedEntry: computed(() => selectedEntry.value),
      nameRef,
      ownerUserIdRef,
    })

    expect(model.canDuplicate.value).toBe(true)
    expect(model.canRename.value).toBe(true)
    expect(model.canTransferTarget.value).toBe(true)
    expect(model.canTransfer.value).toBe(true)
    expect(model.canArchive.value).toBe(true)
    expect(model.canRestore.value).toBe(false)

    nameRef.value = ''
    ownerUserIdRef.value = ''
    expect(model.canTransferTarget.value).toBe(true)
    expect(model.canTransfer.value).toBe(false)

    ownerUserIdRef.value = 'owner-a'
    selectedEntry.value = {
      ...selectedEntry.value,
      isArchived: true,
      permissions: {
        ...selectedEntry.value.permissions,
        canArchive: false,
        canRestore: true,
        canRename: false,
        canTransfer: false,
      },
    }

    expect(model.canRename.value).toBe(false)
    expect(model.canTransferTarget.value).toBe(false)
    expect(model.canTransfer.value).toBe(false)
    expect(model.canArchive.value).toBe(false)
    expect(model.canRestore.value).toBe(true)
  })

  it('can resolve set-default eligibility for a follow-up target without a current selection', () => {
    expect(canApplyPlmCollaborativeEntry({
      canManage: false,
      isArchived: false,
      isDefault: false,
      permissions: {
        canApply: true,
      },
    })).toBe(true)

    expect(canApplyPlmCollaborativeEntry({
      canManage: true,
      isArchived: true,
      isDefault: false,
      permissions: {
        canApply: false,
      },
    })).toBe(false)

    expect(canApplyPlmCollaborativeEntry({
      canManage: true,
      isArchived: true,
      isDefault: false,
      permissions: {
        canApply: true,
      },
    })).toBe(false)

    expect(canSharePlmCollaborativeEntry({
      canManage: true,
      isArchived: false,
      isDefault: false,
      permissions: {},
    })).toBe(true)

    expect(canDuplicatePlmCollaborativeEntry({
      canManage: false,
      isArchived: true,
      isDefault: false,
      permissions: {},
    })).toBe(true)

    expect(canSetDefaultPlmCollaborativeEntry({
      canManage: true,
      isArchived: false,
      isDefault: false,
      permissions: {},
    })).toBe(true)

    expect(canSetDefaultPlmCollaborativeEntry({
      canManage: false,
      isArchived: false,
      isDefault: false,
      permissions: {
        canSetDefault: true,
      },
    })).toBe(true)

    expect(canSetDefaultPlmCollaborativeEntry({
      canManage: true,
      isArchived: true,
      isDefault: false,
      permissions: {},
    })).toBe(false)
  })

  it('keeps apply available when the current control target comes from a canonical follow-up owner', () => {
    const selectedEntry = ref({
      canManage: true,
      isArchived: false,
      isDefault: false,
      ownerUserId: 'owner-a',
      permissions: {
        canApply: true,
      },
    })

    const model = usePlmCollaborativePermissions({
      selectedEntry: computed(() => selectedEntry.value),
      nameRef: ref(''),
    })

    expect(model.canApply.value).toBe(true)

    selectedEntry.value = {
      ...selectedEntry.value,
      isArchived: true,
      permissions: {
        canApply: false,
      },
    }

    expect(model.canApply.value).toBe(false)
  })

  it('hard-blocks archived management actionability even when explicit permissions stay enabled', () => {
    const selectedEntry = ref({
      canManage: true,
      isArchived: true,
      isDefault: false,
      ownerUserId: 'owner-a',
      permissions: {
        canManage: true,
        canShare: true,
        canRename: true,
        canTransfer: true,
        canSetDefault: true,
        canClearDefault: true,
      },
    })
    const nameRef = ref('归档条目')
    const ownerUserIdRef = ref('owner-b')

    const model = usePlmCollaborativePermissions({
      selectedEntry: computed(() => selectedEntry.value),
      nameRef,
      ownerUserIdRef,
    })

    expect(canSharePlmCollaborativeEntry(selectedEntry.value)).toBe(false)
    expect(canRenamePlmCollaborativeEntry(selectedEntry.value)).toBe(false)
    expect(canSetDefaultPlmCollaborativeEntry(selectedEntry.value)).toBe(false)
    expect(model.canShare.value).toBe(false)
    expect(model.canRename.value).toBe(false)
    expect(model.canTransferTarget.value).toBe(false)
    expect(model.canTransfer.value).toBe(false)
    expect(model.canSetDefault.value).toBe(false)

    selectedEntry.value = {
      ...selectedEntry.value,
      isDefault: true,
    }

    expect(model.canClearDefault.value).toBe(false)
  })

  it('hard-blocks lifecycle and default toggles when current state disagrees with explicit permissions', () => {
    const selectedEntry = ref({
      canManage: true,
      isArchived: false,
      isDefault: false,
      ownerUserId: 'owner-a',
      permissions: {
        canArchive: true,
        canRestore: true,
        canSetDefault: true,
        canClearDefault: true,
      },
    })

    const model = usePlmCollaborativePermissions({
      selectedEntry: computed(() => selectedEntry.value),
      nameRef: ref('条目'),
      ownerUserIdRef: ref('owner-b'),
    })

    expect(model.canArchive.value).toBe(true)
    expect(model.canRestore.value).toBe(false)
    expect(model.canSetDefault.value).toBe(true)
    expect(model.canClearDefault.value).toBe(false)
    expect(canSetDefaultPlmCollaborativeEntry(selectedEntry.value)).toBe(true)

    selectedEntry.value = {
      ...selectedEntry.value,
      isDefault: true,
    }

    expect(model.canSetDefault.value).toBe(false)
    expect(model.canClearDefault.value).toBe(true)
    expect(canSetDefaultPlmCollaborativeEntry(selectedEntry.value)).toBe(false)

    selectedEntry.value = {
      ...selectedEntry.value,
      isArchived: true,
      isDefault: false,
    }

    expect(model.canArchive.value).toBe(false)
    expect(model.canRestore.value).toBe(true)
    expect(model.canSetDefault.value).toBe(false)
    expect(model.canClearDefault.value).toBe(false)
    expect(canSetDefaultPlmCollaborativeEntry(selectedEntry.value)).toBe(false)
  })
})
