import type {
  PlmAuditTeamViewCollaborationDraft,
  PlmAuditTeamViewCollaborationFollowup,
} from './plmAuditTeamViewCollaboration'
import {
  prunePlmAuditTeamViewCollaborationDraftForRemovedViews,
  prunePlmAuditTeamViewCollaborationFollowupForRemovedViews,
} from './plmAuditTeamViewCollaboration'
import type { PlmAuditTeamViewShareEntry } from './plmAuditTeamViewShareEntry'
import { prunePlmAuditTeamViewShareEntryForRemovedViews } from './plmAuditTeamViewShareEntry'

export type PlmAuditTeamViewTransientOwnershipState = {
  collaborationDraft: PlmAuditTeamViewCollaborationDraft | null
  collaborationFollowup: PlmAuditTeamViewCollaborationFollowup | null
  shareEntry: PlmAuditTeamViewShareEntry | null
}

export type PlmAuditTeamViewListUiState = {
  selectedTeamViewId: string
  selectedIds: string[]
  focusedTeamViewId: string
  focusedRecommendedTeamViewId: string
  draftTeamViewName: string
  draftOwnerUserId: string
}

export function resolvePlmAuditRemovedTeamViewIds<T extends { id: string }>(
  previousViews: readonly T[],
  nextViews: readonly T[],
) {
  const nextIds = new Set(nextViews.map((view) => view.id))
  return previousViews
    .map((view) => view.id)
    .filter((viewId) => !nextIds.has(viewId))
}

export function prunePlmAuditTransientOwnershipForRemovedViews(
  state: PlmAuditTeamViewTransientOwnershipState,
  removedViewIds: readonly string[],
): PlmAuditTeamViewTransientOwnershipState {
  if (!removedViewIds.length) return state

  return {
    collaborationDraft: prunePlmAuditTeamViewCollaborationDraftForRemovedViews(
      state.collaborationDraft,
      removedViewIds,
    ),
    collaborationFollowup: prunePlmAuditTeamViewCollaborationFollowupForRemovedViews(
      state.collaborationFollowup,
      removedViewIds,
    ),
    shareEntry: prunePlmAuditTeamViewShareEntryForRemovedViews(
      state.shareEntry,
      removedViewIds,
    ),
  }
}

export function trimPlmAuditExistingTeamViewUiState<T extends { id: string }>(
  state: PlmAuditTeamViewListUiState,
  views: readonly T[],
): PlmAuditTeamViewListUiState {
  const existingIds = new Set(views.map((view) => view.id))
  const selectedTeamViewId = state.selectedTeamViewId.trim()
  const selectedTeamViewStillExists = !selectedTeamViewId || existingIds.has(selectedTeamViewId)

  return {
    selectedTeamViewId: selectedTeamViewStillExists ? state.selectedTeamViewId : '',
    selectedIds: state.selectedIds.filter((id) => existingIds.has(id)),
    focusedTeamViewId: existingIds.has(state.focusedTeamViewId) ? state.focusedTeamViewId : '',
    focusedRecommendedTeamViewId: existingIds.has(state.focusedRecommendedTeamViewId)
      ? state.focusedRecommendedTeamViewId
      : '',
    draftTeamViewName: selectedTeamViewStillExists ? state.draftTeamViewName : '',
    draftOwnerUserId: selectedTeamViewStillExists ? state.draftOwnerUserId : '',
  }
}
