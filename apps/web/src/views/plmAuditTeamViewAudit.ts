import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import type { PlmAuditRouteState } from './plmAuditQueryState'

export type PlmAuditTeamViewLogActionKind =
  | 'archive'
  | 'restore'
  | 'delete'
  | 'set-default'
  | 'clear-default'

export function isPlmAuditOwnerlessTeamViewLifecycleLogRoute(
  state: Pick<PlmAuditRouteState, 'teamViewId' | 'action' | 'resourceType'>,
) {
  if (state.teamViewId.trim()) return false

  if (state.action === 'clear-default') {
    return state.resourceType === 'plm-team-view-default'
  }

  if (state.action === 'archive' || state.action === 'restore' || state.action === 'delete') {
    return state.resourceType === 'plm-team-view-batch'
  }

  return false
}

export function shouldClearPlmAuditTeamViewFormDraftsOnLogRoute(options: {
  state: Pick<PlmAuditRouteState, 'teamViewId' | 'action' | 'resourceType'>
  canonicalManagementTargetId: string
}) {
  if (options.canonicalManagementTargetId.trim()) return false

  if (isPlmAuditOwnerlessTeamViewLifecycleLogRoute(options.state)) {
    return true
  }

  return !options.state.teamViewId.trim()
    && options.state.action === 'set-default'
    && options.state.resourceType === 'plm-team-view-default'
}

function getAuditResourceType(action: PlmAuditTeamViewLogActionKind) {
  return action === 'set-default' || action === 'clear-default'
    ? 'plm-team-view-default'
    : 'plm-team-view-batch'
}

export function buildPlmAuditTeamViewLogState(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'>,
  action: PlmAuditTeamViewLogActionKind,
  currentState: Pick<PlmAuditRouteState, 'windowMinutes' | 'returnToPlmPath'>,
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
    returnToPlmPath: currentState.returnToPlmPath,
  }
}

export function buildPlmAuditTeamViewBatchLogState(
  views: Array<Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'>>,
  action: 'archive' | 'restore' | 'delete',
  currentState: Pick<PlmAuditRouteState, 'windowMinutes' | 'returnToPlmPath'>,
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
    returnToPlmPath: currentState.returnToPlmPath,
  }
}

export function resolvePlmAuditProcessedBatchLogViews(options: {
  processedIds: string[]
  resolveView: (id: string) => Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'> | null | undefined
}) {
  const processedViews = options.processedIds
    .map((id) => options.resolveView(id))
    .filter((view): view is Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind'> => Boolean(view))

  if (processedViews.length) {
    return processedViews
  }

  return options.processedIds.map((id) => ({
    id,
    kind: 'audit' as const,
  }))
}
