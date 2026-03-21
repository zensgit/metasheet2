import { buildPlmAuditRouteQuery, type PlmAuditRouteState } from '../plmAuditQueryState'
import type { PlmRecommendedWorkbenchScene } from './plmPanelModels'

export function buildRecommendedWorkbenchSceneAuditState(
  scene: PlmRecommendedWorkbenchScene,
  returnToPlmPath = '',
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
    sceneRecommendationReason: scene.recommendationReason,
    sceneRecommendationSourceLabel: scene.recommendationSourceLabel,
    returnToPlmPath,
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
  returnToPlmPath = '',
) {
  return buildPlmAuditRouteQuery(buildRecommendedWorkbenchSceneAuditState(scene, returnToPlmPath))
}

export function buildWorkbenchAuditQuery(returnToPlmPath = '') {
  return buildPlmAuditRouteQuery({
    page: 1,
    q: '',
    actorId: '',
    kind: 'workbench',
    action: '',
    resourceType: 'plm-team-view-default',
    from: '',
    to: '',
    windowMinutes: 180,
    teamViewId: '',
    sceneId: '',
    sceneName: '',
    sceneOwnerUserId: '',
    sceneRecommendationReason: '',
    sceneRecommendationSourceLabel: '',
    returnToPlmPath,
  })
}
