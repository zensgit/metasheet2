import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import type { PlmAuditRouteState } from './plmAuditQueryState'

export type PlmAuditTeamViewLogActionKind =
  | 'archive'
  | 'restore'
  | 'delete'
  | 'set-default'
  | 'clear-default'

function getAuditResourceType(action: PlmAuditTeamViewLogActionKind) {
  return action === 'set-default' || action === 'clear-default'
    ? 'plm-team-view-default'
    : 'plm-team-view-batch'
}

export function buildPlmAuditTeamViewLogState(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'>,
  action: PlmAuditTeamViewLogActionKind,
  currentState: Pick<PlmAuditRouteState, 'windowMinutes'>,
): PlmAuditRouteState {
  return {
    page: 1,
    q: view.id,
    actorId: '',
    kind: view.kind || 'audit',
    action,
    resourceType: getAuditResourceType(action),
    from: '',
    to: '',
    windowMinutes: currentState.windowMinutes,
    teamViewId: '',
    sceneId: '',
    sceneName: '',
    sceneOwnerUserId: '',
    sceneRecommendationReason: '',
    sceneRecommendationSourceLabel: '',
    returnToPlmPath: '',
  }
}

export function buildPlmAuditTeamViewBatchLogState(
  views: Array<Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'>>,
  action: 'archive' | 'restore' | 'delete',
  currentState: Pick<PlmAuditRouteState, 'windowMinutes'>,
): PlmAuditRouteState {
  const firstView = views[0]
  return {
    page: 1,
    q: firstView?.id || '',
    actorId: '',
    kind: firstView?.kind || 'audit',
    action,
    resourceType: 'plm-team-view-batch',
    from: '',
    to: '',
    windowMinutes: currentState.windowMinutes,
    teamViewId: '',
    sceneId: '',
    sceneName: '',
    sceneOwnerUserId: '',
    sceneRecommendationReason: '',
    sceneRecommendationSourceLabel: '',
    returnToPlmPath: '',
  }
}
