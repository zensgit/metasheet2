import { buildPlmAuditSceneSourceCopy } from './plmAuditSceneCopy'
import {
  buildPlmAuditTeamViewState,
  type PlmAuditRouteState,
  type PlmAuditTeamViewState,
} from './plmAuditQueryState'
import type { PlmAuditSavedViewShareFollowupSource } from './plmAuditSavedViewShareFollowup'
import type { PlmAuditTeamViewCollaborationSource } from './plmAuditTeamViewCollaboration'
import type { PlmAuditSavedView } from './plmAuditSavedViews'

export type PlmAuditSavedViewTeamPromotionDraft = {
  name: string
  state: PlmAuditTeamViewState
  localContextNote: string
}

export type PlmAuditSavedViewPromotionBehavior = {
  collaborationSource: PlmAuditTeamViewCollaborationSource
  shouldFocusRecommendation: boolean
  shouldShowDefaultFollowup: boolean
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

export function resolvePlmAuditSavedViewPromotionBehavior(
  source: PlmAuditSavedViewShareFollowupSource | null | undefined,
  options?: {
    isDefault?: boolean
  },
): PlmAuditSavedViewPromotionBehavior {
  return {
    collaborationSource: source === 'scene-context' ? 'scene-context' : 'saved-view-promotion',
    shouldFocusRecommendation: !options?.isDefault && source === 'shared-entry',
    shouldShowDefaultFollowup: Boolean(options?.isDefault),
  }
}

export function shouldFocusPlmAuditSavedViewPromotionRecommendation(
  source: PlmAuditSavedViewShareFollowupSource | null | undefined,
) {
  return resolvePlmAuditSavedViewPromotionBehavior(source).shouldFocusRecommendation
}

export function shouldClearPlmAuditSavedViewPromotionFormDrafts(
  source: PlmAuditSavedViewShareFollowupSource | null | undefined,
  options?: {
    isDefault?: boolean
  },
) {
  return resolvePlmAuditSavedViewPromotionBehavior(source, options).shouldShowDefaultFollowup
}
