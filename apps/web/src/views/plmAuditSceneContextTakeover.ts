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
import {
  resolvePlmAuditTakeoverTeamViewFormDraftState,
  type PlmAuditTeamViewFormDraftState,
} from './plmAuditTeamViewOwnership'

export type PlmAuditSceneContextTakeoverState = {
  attentionFocus: PlmAuditAttentionFocusState
  savedViewAttention: PlmAuditSavedViewAttentionState
  shareEntry: PlmAuditTeamViewShareEntry | null
  consumeSharedEntry: boolean
  formDraft: PlmAuditTeamViewFormDraftState
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
  formDraft?: PlmAuditTeamViewFormDraftState
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
  const sharedEntryTakenOver = shouldTakeOverPlmAuditSharedEntryOnSceneContextTakeover(
    options.shareEntry,
  )

  return {
    attentionFocus: nextAttentionState.attentionFocus,
    savedViewAttention: nextAttentionState.savedViewAttention,
    shareEntry: sharedEntryTakenOver ? null : options.shareEntry,
    consumeSharedEntry: sharedEntryTakenOver,
    formDraft: resolvePlmAuditTakeoverTeamViewFormDraftState(options.formDraft || {
      draftTeamViewName: '',
      draftTeamViewNameOwnerId: '',
      draftOwnerUserId: '',
    }),
    collaboration: resolvePlmAuditSavedViewTakeoverCollaborationState({
      selectedIds: options.collaboration.selectedIds,
      draft: options.collaboration.draft,
      followup: options.collaboration.followup,
    }),
  }
}
