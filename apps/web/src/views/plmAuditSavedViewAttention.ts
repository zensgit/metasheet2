import type { PlmAuditSavedViewShareFollowup } from './plmAuditSavedViewShareFollowup'

export type PlmAuditSavedViewAttentionState = {
  shareFollowup: PlmAuditSavedViewShareFollowup | null
  focusedSavedViewId: string
}

export type PlmAuditSourceFocusState = {
  focusedRecommendedAuditTeamViewId: string
  focusedSavedViewId: string
}

export type PlmAuditAttentionFocusState = {
  focusedAuditTeamViewId: string
  focusedRecommendedAuditTeamViewId: string
  focusedSavedViewId: string
}

export type PlmAuditTeamViewHandoffAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
}

export type PlmAuditSavedViewStoreAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
}

export type PlmAuditSourceShareFollowupAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
}

export type PlmAuditClearedCollaborationFollowupAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
}

export type PlmAuditDismissedCollaborationDraftAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
}

export type PlmAuditRoutePivotAttentionState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
}

export type PlmAuditSavedViewAttentionAction =
  | { kind: 'install-followup'; shareFollowup: PlmAuditSavedViewShareFollowup }
  | { kind: 'apply' | 'context-action' | 'filter-navigation' | 'promotion-handoff' | 'reset-filters' | 'share-entry-takeover' }
  | { kind: 'delete'; savedViewId: string }

export type PlmAuditAttentionFocusAction =
  | { kind: 'clear-source' }
  | { kind: 'clear-management' }
  | { kind: 'clear-all' }

export function clearPlmAuditSourceFocusState(): PlmAuditSourceFocusState {
  return {
    focusedRecommendedAuditTeamViewId: '',
    focusedSavedViewId: '',
  }
}

export function applyPlmAuditSourceFocusState(
  state: PlmAuditAttentionFocusState,
  sourceFocus: PlmAuditSourceFocusState,
): PlmAuditAttentionFocusState {
  const clearedState = reducePlmAuditAttentionFocusState(state, { kind: 'clear-all' })
  return {
    ...clearedState,
    focusedRecommendedAuditTeamViewId: sourceFocus.focusedRecommendedAuditTeamViewId,
    focusedSavedViewId: sourceFocus.focusedSavedViewId,
  }
}

export function reducePlmAuditAttentionFocusState(
  state: PlmAuditAttentionFocusState,
  action: PlmAuditAttentionFocusAction,
): PlmAuditAttentionFocusState {
  if (action.kind === 'clear-source') {
    return {
      ...state,
      focusedRecommendedAuditTeamViewId: '',
      focusedSavedViewId: '',
    }
  }

  if (action.kind === 'clear-management') {
    return {
      ...state,
      focusedAuditTeamViewId: '',
    }
  }

  return {
    focusedAuditTeamViewId: '',
    focusedRecommendedAuditTeamViewId: '',
    focusedSavedViewId: '',
  }
}

export function buildPlmAuditTeamViewHandoffAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
  savedViewAttention: PlmAuditSavedViewAttentionState,
): PlmAuditTeamViewHandoffAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-source' }),
    savedViewAttention: reducePlmAuditSavedViewAttentionState(savedViewAttention, { kind: 'promotion-handoff' }),
  }
}

export function buildPlmAuditSavedViewStoreAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
  savedViewAttention: PlmAuditSavedViewAttentionState,
): PlmAuditSavedViewStoreAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-source' }),
    savedViewAttention: reducePlmAuditSavedViewAttentionState(savedViewAttention, { kind: 'apply' }),
  }
}

export function buildPlmAuditSourceShareFollowupAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
  savedViewAttention: PlmAuditSavedViewAttentionState,
): PlmAuditSourceShareFollowupAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-all' }),
    savedViewAttention: reducePlmAuditSavedViewAttentionState(savedViewAttention, { kind: 'apply' }),
  }
}

export function buildPlmAuditClearedCollaborationFollowupAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
): PlmAuditClearedCollaborationFollowupAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-all' }),
  }
}

export function buildPlmAuditDismissedCollaborationDraftAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
): PlmAuditDismissedCollaborationDraftAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-management' }),
  }
}

export function buildPlmAuditRoutePivotAttentionState(
  attentionFocus: PlmAuditAttentionFocusState,
  savedViewAttention: PlmAuditSavedViewAttentionState,
): PlmAuditRoutePivotAttentionState {
  return {
    attentionFocus: reducePlmAuditAttentionFocusState(attentionFocus, { kind: 'clear-all' }),
    savedViewAttention: reducePlmAuditSavedViewAttentionState(savedViewAttention, { kind: 'filter-navigation' }),
  }
}

export function reducePlmAuditSavedViewAttentionState(
  state: PlmAuditSavedViewAttentionState,
  action: PlmAuditSavedViewAttentionAction,
): PlmAuditSavedViewAttentionState {
  if (action.kind === 'install-followup') {
    return {
      shareFollowup: action.shareFollowup,
      focusedSavedViewId: '',
    }
  }

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
