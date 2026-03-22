import { buildPlmAuditSceneSourceCopy } from './plmAuditSceneCopy'
import {
  buildPlmAuditTeamViewState,
  type PlmAuditRouteState,
  type PlmAuditTeamViewState,
} from './plmAuditQueryState'
import type { PlmAuditSavedViewShareFollowupSource } from './plmAuditSavedViewShareFollowup'
import type { PlmAuditSavedView } from './plmAuditSavedViews'

export type PlmAuditSavedViewTeamPromotionDraft = {
  name: string
  state: PlmAuditTeamViewState
  localContextNote: string
}

function hasLocalSceneContext(state: Pick<PlmAuditRouteState, 'sceneId' | 'sceneName' | 'sceneOwnerUserId'>) {
  return Boolean(state.sceneId || state.sceneName || state.sceneOwnerUserId)
}

export function buildPlmAuditSavedViewTeamPromotionDraft(
  view: Pick<PlmAuditSavedView, 'name' | 'state'>,
  tr: (en: string, zh: string) => string,
): PlmAuditSavedViewTeamPromotionDraft {
  return {
    name: view.name,
    state: buildPlmAuditTeamViewState(view.state),
    localContextNote: hasLocalSceneContext(view.state)
      ? buildPlmAuditSceneSourceCopy('team-view', tr).description
      : '',
  }
}

export function shouldFocusPlmAuditSavedViewPromotionRecommendation(
  source: PlmAuditSavedViewShareFollowupSource | null | undefined,
) {
  return source === 'shared-entry'
}
