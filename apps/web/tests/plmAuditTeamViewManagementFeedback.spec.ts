import { describe, expect, it } from 'vitest'
import type { PlmWorkbenchTeamView } from '../src/views/plm/plmPanelModels'
import { resolvePlmAuditTeamViewManagementFeedback } from '../src/views/plmAuditTeamViewManagementFeedback'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

function createAuditTeamView(
  overrides: Partial<PlmWorkbenchTeamView<'audit'>> = {},
): PlmWorkbenchTeamView<'audit'> {
  return {
    id: 'audit-view-1',
    kind: 'audit',
    scope: 'team',
    name: '默认审计视图',
    ownerUserId: 'owner-a',
    canManage: true,
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
    isDefault: false,
    isArchived: false,
    state: {
      page: 1,
      q: '',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
    },
    createdAt: '2026-03-19T09:00:00.000Z',
    updatedAt: '2026-03-19T10:00:00.000Z',
    ...overrides,
  }
}

describe('plmAuditTeamViewManagementFeedback', () => {
  it('returns selection and lock feedback before actionability checks', () => {
    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'delete',
      target: null,
      managementTargetLocked: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Select an audit team view first.|请先选择审计团队视图。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'archive',
      target: createAuditTeamView(),
      managementTargetLocked: true,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Apply the selected team view before running management actions.|请先应用所选团队视图，再执行管理动作。',
    })
  })

  it('returns owner-specific denial for readonly targets', () => {
    const readonly = createAuditTeamView({
      canManage: false,
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
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'share',
      target: readonly,
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Only the creator can share this audit team view.|仅创建者可分享审计团队视图。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'set-default',
      target: readonly,
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Only the creator can set this audit team view as default.|仅创建者可设置审计团队视图默认。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'delete',
      target: readonly,
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: false,
      canArchive: false,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Only the creator can delete this audit team view.|仅创建者可删除审计团队视图。',
    })
  })

  it('returns explicit no-op feedback for default and lifecycle actions', () => {
    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'transfer',
      target: createAuditTeamView({ ownerUserId: 'owner-a' }),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: false,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      draftOwnerUserId: 'owner-a',
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view already belongs to this user.|审计团队视图已经属于该用户。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'set-default',
      target: createAuditTeamView({ isDefault: true }),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: true,
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view already set as default.|审计团队视图已设为默认。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'clear-default',
      target: createAuditTeamView({ isDefault: false }),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view is not set as default.|当前审计团队视图尚未设为默认。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'archive',
      target: createAuditTeamView({ isArchived: true }),
      managementTargetLocked: false,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: true,
      canArchive: false,
      canRestore: true,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view already archived.|审计团队视图已归档。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'restore',
      target: createAuditTeamView({ isArchived: false }),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'info',
      message: 'Audit team view does not need restoring.|审计团队视图无需恢复。',
    })
  })

  it('returns archived restore-first and generic unavailable feedback', () => {
    const archivedDefault = createAuditTeamView({
      isArchived: true,
      isDefault: true,
      permissions: {
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
      },
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'apply',
      target: createAuditTeamView({ isArchived: true }),
      managementTargetLocked: false,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: true,
      canArchive: false,
      canRestore: true,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Restore the audit team view before applying it.|请先恢复审计团队视图，再执行应用。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'rename',
      target: archivedDefault,
      managementTargetLocked: false,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: true,
      canArchive: false,
      canRestore: true,
      canSetDefault: false,
      canClearDefault: false,
      draftName: '新的名称',
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Restore the audit team view before renaming it.|请先恢复审计团队视图，再执行重命名。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'transfer',
      target: createAuditTeamView(),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: false,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      draftOwnerUserId: '',
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Enter the audit team view target user ID.|请输入审计团队视图目标用户 ID。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'set-default',
      target: createAuditTeamView(),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current audit team view cannot be set as default.|当前审计团队视图不可设为默认。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'clear-default',
      target: archivedDefault,
      managementTargetLocked: false,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: true,
      canArchive: false,
      canRestore: true,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Restore the audit team view before clearing default.|请先恢复审计团队视图，再取消默认。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'restore',
      target: createAuditTeamView({ isArchived: true }),
      managementTargetLocked: false,
      canApply: false,
      canDuplicate: true,
      canShare: false,
      canRenameTarget: false,
      canRename: false,
      canTransferTarget: false,
      canTransfer: false,
      canDelete: true,
      canArchive: false,
      canRestore: false,
      canSetDefault: false,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current audit team view cannot be restored.|当前审计团队视图不可恢复。',
    })

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'delete',
      target: createAuditTeamView(),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: false,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toEqual({
      kind: 'error',
      message: 'Current audit team view cannot be deleted.|当前审计团队视图不可删除。',
    })
  })

  it('returns null when the action can proceed', () => {
    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'share',
      target: createAuditTeamView(),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toBeNull()

    expect(resolvePlmAuditTeamViewManagementFeedback({
      actionKind: 'archive',
      target: createAuditTeamView(),
      managementTargetLocked: false,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canRenameTarget: true,
      canRename: true,
      canTransferTarget: true,
      canTransfer: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canSetDefault: true,
      canClearDefault: false,
      tr,
    })).toBeNull()
  })
})
