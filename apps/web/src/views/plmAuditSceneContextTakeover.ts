import {
  buildPlmAuditRoutePivotAttentionState,
  type PlmAuditAttentionFocusState,
  type PlmAuditSavedViewAttentionState,
} from './plmAuditSavedViewAttention'
import {
  resolvePlmAuditSavedViewTakeoverCollaborationState,
  type PlmAuditTeamViewCollaborationDraft,
  type PlmAuditTeamViewCollaborationFollowup,
} from './plmAuditTeamViewCollaboration'
import {
  shouldTakeOverPlmAuditSharedEntryOnSceneContextTakeover,
  type PlmAuditTeamViewShareEntry,
} from './plmAuditTeamViewShareEntry'

export type PlmAuditSceneContextTakeoverState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  collaboration: {
    selectedIds: string[]
    draft: PlmAuditTeamViewCollaborationDraft | null
    followup: PlmAuditTeamViewCollaborationFollowup | null
  }
}

export function buildPlmAuditSceneContextTakeoverState(options: {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  collaboration: {
    selectedIds: string[]
    draft: PlmAuditTeamViewCollaborationDraft | null
    followup: PlmAuditTeamViewCollaborationFollowup | null
  }
}): PlmAuditSceneContextTakeoverState {
  const nextAttentionState = buildPlmAuditRoutePivotAttentionState(
    options.attentionFocus,
    options.savedViewAttention,
  )

  return {
    attentionFocus: nextAttentionState.attentionFocus,
    savedViewAttention: nextAttentionState.savedViewAttention,
    shareEntry: shouldTakeOverPlmAuditSharedEntryOnSceneContextTakeover(options.shareEntry)
      ? null
      : options.shareEntry,
    collaboration: resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: options.collaboration.selectedIds,
      draft: options.collaboration.draft,
      followup: options.collaboration.followup,
    }),
  }
}
