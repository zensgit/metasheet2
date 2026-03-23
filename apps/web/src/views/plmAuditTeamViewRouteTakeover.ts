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
  resolvePlmAuditTakeoverTeamViewFormDraftState,
  type PlmAuditTeamViewFormDraftState,
} from './plmAuditTeamViewOwnership'
import type { PlmAuditTeamViewShareEntry } from './plmAuditTeamViewShareEntry'

export type PlmAuditTeamViewRouteTakeoverState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  formDraft: PlmAuditTeamViewFormDraftState
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
  formDraft: PlmAuditTeamViewFormDraftState
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
    formDraft: resolvePlmAuditTakeoverTeamViewFormDraftState(options.formDraft),
    collaboration: resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: options.collaboration.selectedIds,
      draft: options.collaboration.draft,
      followup: options.collaboration.followup,
    }),
  }
}
