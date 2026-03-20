import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmAuditTeamViewCollaborationSource = 'recommendation' | 'saved-view-promotion'
export type PlmAuditTeamViewCollaborationActionKind = 'share' | 'set-default' | 'dismiss'

export type PlmAuditTeamViewCollaborationDraft = {
  teamViewId: string
  teamViewName: string
  teamViewOwnerUserId: string
  focusTargetId: string
  statusMessage: string
  source: PlmAuditTeamViewCollaborationSource
}

export type PlmAuditTeamViewCollaborationNotice = {
  sourceLabel: string
  title: string
  description: string
  actions: Array<{
    kind: PlmAuditTeamViewCollaborationActionKind
    label: string
    emphasis: 'primary' | 'secondary'
  }>
}

export function buildPlmAuditTeamViewCollaborationActionStatus(
  source: PlmAuditTeamViewCollaborationSource,
  action: Exclude<PlmAuditTeamViewCollaborationActionKind, 'dismiss'>,
  tr: (en: string, zh: string) => string,
) {
  if (action === 'share') {
    return source === 'saved-view-promotion'
      ? tr(
          'Share link copied for the promoted audit team view.',
          '已复制提升后的审计团队视图分享链接。',
        )
      : tr(
          'Share link copied for the recommended audit team view.',
          '已复制推荐审计团队视图的分享链接。',
        )
  }

  return source === 'saved-view-promotion'
    ? tr(
        'Promoted audit team view set as default. Showing matching audit logs.',
        '已将提升后的审计团队视图设为默认，并切换到对应审计日志。',
      )
    : tr(
        'Recommended audit team view set as default. Showing matching audit logs.',
        '已将推荐审计团队视图设为默认，并切换到对应审计日志。',
      )
}

export function buildPlmAuditTeamViewCollaborationDraft(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name'>,
  tr: (en: string, zh: string) => string,
  source: PlmAuditTeamViewCollaborationSource = 'recommendation',
): PlmAuditTeamViewCollaborationDraft {
  return {
    teamViewId: view.id,
    teamViewName: view.name,
    teamViewOwnerUserId: '',
    focusTargetId: 'plm-audit-team-view-controls',
    source,
    statusMessage: source === 'saved-view-promotion'
      ? tr(
          'Saved view promoted and collaboration controls are ready.',
          '保存视图已提升为团队视图，并已准备好协作操作。',
        )
      : tr(
          'Prepared collaboration controls for this audit team view.',
          '已为该审计团队视图准备好协作操作。',
        ),
  }
}

export function buildPlmAuditTeamViewCollaborationNotice(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'name' | 'isDefault' | 'isArchived'>,
  draft: PlmAuditTeamViewCollaborationDraft | null,
  options: {
    canShare: boolean
    canSetDefault: boolean
  },
  tr: (en: string, zh: string) => string,
): PlmAuditTeamViewCollaborationNotice | null {
  if (!draft || draft.teamViewId !== view.id) return null

  const actions: PlmAuditTeamViewCollaborationNotice['actions'] = []
  if (options.canShare && !view.isArchived) {
    actions.push({
      kind: 'share',
      label: tr('Copy share link', '复制分享链接'),
      emphasis: 'secondary',
    })
  }
  if (options.canSetDefault && !view.isArchived && !view.isDefault) {
    actions.push({
      kind: 'set-default',
      label: tr('Set as default', '设为默认'),
      emphasis: 'primary',
    })
  }
  actions.push({
    kind: 'dismiss',
    label: tr('Done', '完成'),
    emphasis: 'secondary',
  })

  return {
    sourceLabel: draft.source === 'saved-view-promotion'
      ? tr('Saved view promotion', '保存视图提升')
      : tr('Recommended team view', '推荐团队视图'),
    title: draft.source === 'saved-view-promotion'
      ? tr('The promoted team view is ready for collaboration.', '已提升的团队视图已可继续协作。')
      : tr('The recommended team view is ready for collaboration.', '推荐的团队视图已可继续协作。'),
    description: draft.source === 'saved-view-promotion'
      ? tr(
          'Typical next steps are sharing this team view or promoting it to the default team audit entry.',
          '常见下一步是分享这个团队视图，或继续提升为团队默认审计入口。',
        )
      : tr(
          'You can immediately share this recommended team view or promote it to the default audit entry.',
          '你可以立即分享这个推荐团队视图，或将其提升为默认审计入口。',
        ),
    actions,
  }
}
