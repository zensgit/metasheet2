import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import { canManagePlmAuditTeamView } from './plmAuditTeamViewManagement'

export type PlmAuditTeamViewManagementFeedbackKind = 'info' | 'error'

export type PlmAuditTeamViewManagementFeedback = {
  kind: PlmAuditTeamViewManagementFeedbackKind
  message: string
}

export type PlmAuditTeamViewManagementActionKind =
  | 'apply'
  | 'duplicate'
  | 'share'
  | 'rename'
  | 'transfer'
  | 'set-default'
  | 'clear-default'
  | 'archive'
  | 'restore'
  | 'delete'

type AuditTeamViewManagementTarget = Pick<
  PlmWorkbenchTeamView<'audit'>,
  'canManage' | 'isArchived' | 'isDefault' | 'ownerUserId' | 'permissions'
>

function buildFeedback(
  kind: PlmAuditTeamViewManagementFeedbackKind,
  message: string,
): PlmAuditTeamViewManagementFeedback {
  return { kind, message }
}

export function resolvePlmAuditTeamViewManagementFeedback(options: {
  actionKind: PlmAuditTeamViewManagementActionKind
  target: AuditTeamViewManagementTarget | null | undefined
  managementTargetLocked: boolean
  canApply?: boolean
  canDuplicate?: boolean
  canShare?: boolean
  canRenameTarget?: boolean
  canRename?: boolean
  canTransferTarget?: boolean
  canTransfer?: boolean
  canDelete: boolean
  canArchive: boolean
  canRestore: boolean
  canSetDefault: boolean
  canClearDefault: boolean
  draftName?: string
  draftOwnerUserId?: string
  tr: (en: string, zh: string) => string
}): PlmAuditTeamViewManagementFeedback | null {
  const target = options.target || null
  const { tr } = options

  if (!target) {
    return buildFeedback('error', tr('Select an audit team view first.', '请先选择审计团队视图。'))
  }

  if (options.actionKind !== 'apply' && options.managementTargetLocked) {
    return buildFeedback(
      'error',
      tr(
        'Apply the selected team view before running management actions.',
        '请先应用所选团队视图，再执行管理动作。',
      ),
    )
  }

  if (options.actionKind === 'apply') {
    if (!options.canApply) {
      return buildFeedback(
        'error',
        target.isArchived
          ? tr('Restore the audit team view before applying it.', '请先恢复审计团队视图，再执行应用。')
          : tr('Current audit team view cannot be applied.', '当前审计团队视图不可应用。'),
      )
    }
    return null
  }

  if (options.actionKind === 'duplicate') {
    if (!options.canDuplicate) {
      return buildFeedback(
        'error',
        tr('Current audit team view cannot be duplicated.', '当前审计团队视图不可复制。'),
      )
    }
    return null
  }

  if (options.actionKind === 'share') {
    if (target.isArchived) {
      return buildFeedback(
        'error',
        tr('Restore the audit team view before sharing it.', '请先恢复审计团队视图，再执行分享。'),
      )
    }
    if (!options.canShare) {
      return buildFeedback(
        'error',
        canManagePlmAuditTeamView(target)
          ? tr('Current audit team view cannot be shared.', '当前审计团队视图不可分享。')
          : tr('Only the creator can share this audit team view.', '仅创建者可分享审计团队视图。'),
      )
    }
    return null
  }

  if (options.actionKind === 'rename') {
    if (!options.canRenameTarget) {
      return buildFeedback(
        'error',
        target.isArchived
          ? tr('Restore the audit team view before renaming it.', '请先恢复审计团队视图，再执行重命名。')
          : canManagePlmAuditTeamView(target)
            ? tr('Current audit team view cannot be renamed.', '当前审计团队视图不可重命名。')
            : tr('Only the creator can rename this audit team view.', '仅创建者可重命名审计团队视图。'),
      )
    }
    if (!options.draftName?.trim()) {
      return buildFeedback(
        'error',
        tr('Enter an audit team view name.', '请输入审计团队视图名称。'),
      )
    }
    if (!options.canRename) {
      return buildFeedback(
        'error',
        tr('Current audit team view cannot be renamed.', '当前审计团队视图不可重命名。'),
      )
    }
    return null
  }

  if (options.actionKind === 'transfer') {
    if (target.isArchived) {
      return buildFeedback(
        'error',
        tr('Restore the audit team view before transferring ownership.', '请先恢复审计团队视图，再执行转移所有者。'),
      )
    }
    if (!options.canTransferTarget) {
      return buildFeedback(
        'error',
        canManagePlmAuditTeamView(target)
          ? tr('Current audit team view cannot transfer ownership.', '当前审计团队视图不可转移所有者。')
          : tr('Only the creator can transfer this audit team view.', '仅创建者可转移审计团队视图。'),
      )
    }
    const targetOwnerUserId = options.draftOwnerUserId?.trim() || ''
    if (!targetOwnerUserId) {
      return buildFeedback(
        'error',
        tr('Enter the audit team view target user ID.', '请输入审计团队视图目标用户 ID。'),
      )
    }
    if (targetOwnerUserId === target.ownerUserId) {
      return buildFeedback(
        'info',
        tr('Audit team view already belongs to this user.', '审计团队视图已经属于该用户。'),
      )
    }
    if (!options.canTransfer) {
      return buildFeedback(
        'error',
        tr('Current audit team view cannot transfer ownership.', '当前审计团队视图不可转移所有者。'),
      )
    }
    return null
  }

  if (!canManagePlmAuditTeamView(target)) {
    if (options.actionKind === 'delete') {
      return buildFeedback('error', tr('Only the creator can delete this audit team view.', '仅创建者可删除审计团队视图。'))
    }
    if (options.actionKind === 'archive') {
      return buildFeedback('error', tr('Only the creator can archive this audit team view.', '仅创建者可归档审计团队视图。'))
    }
    if (options.actionKind === 'restore') {
      return buildFeedback('error', tr('Only the creator can restore this audit team view.', '仅创建者可恢复审计团队视图。'))
    }
    if (options.actionKind === 'set-default') {
      return buildFeedback(
        'error',
        tr('Only the creator can set this audit team view as default.', '仅创建者可设置审计团队视图默认。'),
      )
    }
    return buildFeedback(
      'error',
      tr('Only the creator can clear this audit team view default.', '仅创建者可取消审计团队视图默认。'),
    )
  }

  if (options.actionKind === 'set-default') {
    if (target.isDefault) {
      return buildFeedback('info', tr('Audit team view already set as default.', '审计团队视图已设为默认。'))
    }
    if (!options.canSetDefault) {
      if (target.isArchived) {
        return buildFeedback(
          'error',
          tr('Restore the audit team view before setting it as default.', '请先恢复审计团队视图，再设为默认。'),
        )
      }
      return buildFeedback(
        'error',
        tr('Current audit team view cannot be set as default.', '当前审计团队视图不可设为默认。'),
      )
    }
    return null
  }

  if (options.actionKind === 'clear-default') {
    if (!target.isDefault) {
      return buildFeedback('info', tr('Audit team view is not set as default.', '当前审计团队视图尚未设为默认。'))
    }
    if (!options.canClearDefault) {
      if (target.isArchived) {
        return buildFeedback(
          'error',
          tr('Restore the audit team view before clearing default.', '请先恢复审计团队视图，再取消默认。'),
        )
      }
      return buildFeedback(
        'error',
        tr('Current audit team view cannot clear default.', '当前审计团队视图不可取消默认。'),
      )
    }
    return null
  }

  if (options.actionKind === 'archive') {
    if (target.isArchived) {
      return buildFeedback('info', tr('Audit team view already archived.', '审计团队视图已归档。'))
    }
    if (!options.canArchive) {
      return buildFeedback(
        'error',
        tr('Current audit team view cannot be archived.', '当前审计团队视图不可归档。'),
      )
    }
    return null
  }

  if (options.actionKind === 'restore') {
    if (!target.isArchived) {
      return buildFeedback('info', tr('Audit team view does not need restoring.', '审计团队视图无需恢复。'))
    }
    if (!options.canRestore) {
      return buildFeedback(
        'error',
        tr('Current audit team view cannot be restored.', '当前审计团队视图不可恢复。'),
      )
    }
    return null
  }

  if (!options.canDelete) {
    return buildFeedback(
      'error',
      tr('Current audit team view cannot be deleted.', '当前审计团队视图不可删除。'),
    )
  }

  return null
}
