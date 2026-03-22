import type { PlmAuditSavedViewShareFollowup } from './plmAuditSavedViewShareFollowup'

export type PlmAuditSavedViewAttentionState = {
  shareFollowup: PlmAuditSavedViewShareFollowup | null
  focusedSavedViewId: string
}

export type PlmAuditSourceFocusState = {
  focusedRecommendedAuditTeamViewId: string
  focusedSavedViewId: string
}

export type PlmAuditSavedViewAttentionAction =
  | { kind: 'apply' | 'context-action' | 'reset-filters' }
  | { kind: 'delete'; savedViewId: string }

export function clearPlmAuditSourceFocusState(): PlmAuditSourceFocusState {
  return {
    focusedRecommendedAuditTeamViewId: '',
    focusedSavedViewId: '',
  }
}

export function reducePlmAuditSavedViewAttentionState(
  state: PlmAuditSavedViewAttentionState,
  action: PlmAuditSavedViewAttentionAction,
): PlmAuditSavedViewAttentionState {
  if (action.kind === 'delete') {
    return {
      shareFollowup: state.shareFollowup?.savedViewId === action.savedViewId
        ? null
        : state.shareFollowup,
      focusedSavedViewId: state.focusedSavedViewId === action.savedViewId
        ? ''
        : state.focusedSavedViewId,
    }
  }

  return {
    shareFollowup: null,
    focusedSavedViewId: '',
  }
}
