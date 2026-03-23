import {
  buildPlmAuditTeamViewState,
  type PlmAuditRouteState,
  type PlmAuditTeamViewState,
} from './plmAuditQueryState'

export function buildPlmAuditSceneQueryValue(state: Pick<PlmAuditRouteState, 'sceneId' | 'sceneName'>) {
  return state.sceneId || state.sceneName || ''
}

export function isPlmAuditSceneOwnerContextActive(
  state: Pick<PlmAuditRouteState, 'q' | 'sceneOwnerUserId'>,
) {
  return Boolean(state.sceneOwnerUserId) && state.q === state.sceneOwnerUserId
}

export function isPlmAuditSceneQueryContextActive(
  state: Pick<PlmAuditRouteState, 'q' | 'sceneId' | 'sceneName'>,
) {
  const sceneQuery = buildPlmAuditSceneQueryValue(state)
  return Boolean(sceneQuery) && state.q === sceneQuery
}

export function withPlmAuditSceneOwnerContext(state: PlmAuditRouteState): PlmAuditRouteState {
  if (!state.sceneOwnerUserId) return state

  return {
    ...state,
    page: 1,
    q: state.sceneOwnerUserId,
  }
}

export function withPlmAuditSceneQueryContext(state: PlmAuditRouteState): PlmAuditRouteState {
  const nextQuery = buildPlmAuditSceneQueryValue(state)
  if (!nextQuery) return state

  return {
    ...state,
    page: 1,
    q: nextQuery,
  }
}

export function buildPlmAuditSceneSavedViewState(state: PlmAuditRouteState): PlmAuditRouteState {
  if (isPlmAuditSceneOwnerContextActive(state)) {
    return withPlmAuditSceneOwnerContext(state)
  }

  if (buildPlmAuditSceneQueryValue(state)) {
    return withPlmAuditSceneQueryContext(state)
  }

  return withPlmAuditSceneOwnerContext(state)
}

export function buildPlmAuditSceneTeamViewState(state: PlmAuditRouteState): PlmAuditTeamViewState {
  return buildPlmAuditTeamViewState(buildPlmAuditSceneSavedViewState(state))
}

export function withoutPlmAuditSceneContext(state: PlmAuditRouteState): PlmAuditRouteState {
  return {
    ...state,
    sceneId: '',
    sceneName: '',
    sceneOwnerUserId: '',
    sceneRecommendationReason: '',
    sceneRecommendationSourceLabel: '',
    returnToPlmPath: '',
  }
}
