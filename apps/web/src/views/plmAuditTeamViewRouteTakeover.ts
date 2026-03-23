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
import type { PlmAuditTeamViewShareEntry } from './plmAuditTeamViewShareEntry'

export type PlmAuditTeamViewRouteTakeoverState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  collaboration: {
    selectedIds: string[]
    draft: PlmAuditTeamViewCollaborationDraft | null
    followup: PlmAuditTeamViewCollaborationFollowup | null
  }
}

export function buildPlmAuditTeamViewRouteTakeoverState(options: {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  collaboration: {
    selectedIds: string[]
    draft: PlmAuditTeamViewCollaborationDraft | null
    followup: PlmAuditTeamViewCollaborationFollowup | null
  }
}): PlmAuditTeamViewRouteTakeoverState {
  const nextAttentionState = buildPlmAuditRoutePivotAttentionState(
    options.attentionFocus,
    options.savedViewAttention,
  )

  return {
    attentionFocus: nextAttentionState.attentionFocus,
    savedViewAttention: nextAttentionState.savedViewAttention,
    shareEntry: null,
    collaboration: resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: options.collaboration.selectedIds,
      draft: options.collaboration.draft,
      followup: options.collaboration.followup,
    }),
  }
}
