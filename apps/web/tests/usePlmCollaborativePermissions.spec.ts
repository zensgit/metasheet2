import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { usePlmCollaborativePermissions } from '../src/views/plm/usePlmCollaborativePermissions'

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
})
