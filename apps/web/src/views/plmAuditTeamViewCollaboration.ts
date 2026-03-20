import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'

export type PlmAuditTeamViewCollaborationSource = 'recommendation' | 'saved-view-promotion'

export type PlmAuditTeamViewCollaborationDraft = {
  teamViewId: string
  teamViewName: string
  teamViewOwnerUserId: string
  focusTargetId: string
  statusMessage: string
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
