import { buildPlmAuditRouteQuery, type PlmAuditRouteState } from '../plmAuditQueryState'
import type { PlmRecommendedWorkbenchScene } from './plmPanelModels'

export function buildRecommendedWorkbenchSceneAuditState(
  scene: PlmRecommendedWorkbenchScene,
): PlmAuditRouteState {
  const baseState: PlmAuditRouteState = {
    page: 1,
    q: scene.id || scene.name,
    actorId: '',
    kind: 'workbench',
    action: '',
    resourceType: '',
    from: '',
    to: '',
    windowMinutes: 180,
    teamViewId: '',
    sceneId: scene.id,
    sceneName: scene.name,
    sceneOwnerUserId: scene.ownerUserId,
  }

  if (scene.recommendationReason === 'default' || scene.recommendationReason === 'recent-default') {
    return {
      ...baseState,
      action: 'set-default',
      resourceType: 'plm-team-view-default',
    }
  }

  return baseState
}

export function buildRecommendedWorkbenchSceneAuditQuery(
  scene: PlmRecommendedWorkbenchScene,
) {
  return buildPlmAuditRouteQuery(buildRecommendedWorkbenchSceneAuditState(scene))
}
