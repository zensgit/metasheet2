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
  draftTeamViewNameOwnerId: string
  draftOwnerUserId: string
}

export type PlmAuditTeamViewFormDraftState = {
  draftTeamViewName: string
  draftTeamViewNameOwnerId: string
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
  state: PlmAuditTeamViewListUiState & {
    managedTeamViewId: string
  },
  views: readonly T[],
): PlmAuditTeamViewListUiState {
  const existingIds = new Set(views.map((view) => view.id))
  const selectedTeamViewId = state.selectedTeamViewId.trim()
  const managedTeamViewId = state.managedTeamViewId.trim()
  const selectedTeamViewStillExists = !selectedTeamViewId || existingIds.has(selectedTeamViewId)
  const managedTeamViewStillExists = !managedTeamViewId || existingIds.has(managedTeamViewId)
  const shouldPreserveDrafts = selectedTeamViewId
    ? selectedTeamViewStillExists
    : managedTeamViewStillExists

  return {
    selectedTeamViewId: selectedTeamViewStillExists ? state.selectedTeamViewId : '',
    selectedIds: state.selectedIds.filter((id) => existingIds.has(id)),
    focusedTeamViewId: existingIds.has(state.focusedTeamViewId) ? state.focusedTeamViewId : '',
    focusedRecommendedTeamViewId: existingIds.has(state.focusedRecommendedTeamViewId)
      ? state.focusedRecommendedTeamViewId
      : '',
    draftTeamViewName: shouldPreserveDrafts ? state.draftTeamViewName : '',
    draftTeamViewNameOwnerId: shouldPreserveDrafts ? state.draftTeamViewNameOwnerId : '',
    draftOwnerUserId: shouldPreserveDrafts ? state.draftOwnerUserId : '',
  }
}

export function resolvePlmAuditCanonicalTeamViewFormDraftState(options: {
  previousCanonicalTeamViewId: string
  nextCanonicalTeamViewId: string
  draftTeamViewName: string
  draftTeamViewNameOwnerId: string
  draftOwnerUserId: string
}): PlmAuditTeamViewFormDraftState {
  const previousCanonicalTeamViewId = options.previousCanonicalTeamViewId.trim()
  const nextCanonicalTeamViewId = options.nextCanonicalTeamViewId.trim()

  if (
    previousCanonicalTeamViewId === nextCanonicalTeamViewId
    || (!previousCanonicalTeamViewId && !nextCanonicalTeamViewId)
  ) {
    return {
      draftTeamViewName: options.draftTeamViewName,
      draftTeamViewNameOwnerId: options.draftTeamViewNameOwnerId,
      draftOwnerUserId: options.draftOwnerUserId,
    }
  }

  return {
    draftTeamViewName: options.draftTeamViewName,
    draftTeamViewNameOwnerId: options.draftTeamViewNameOwnerId,
    draftOwnerUserId: '',
  }
}

export function resolvePlmAuditTakeoverTeamViewFormDraftState(options: {
  draftTeamViewName: string
  draftTeamViewNameOwnerId: string
  draftOwnerUserId: string
}): PlmAuditTeamViewFormDraftState {
  if (!options.draftTeamViewNameOwnerId.trim()) {
    return {
      draftTeamViewName: options.draftTeamViewName,
      draftTeamViewNameOwnerId: options.draftTeamViewNameOwnerId,
      draftOwnerUserId: options.draftOwnerUserId,
    }
  }

  return {
    draftTeamViewName: '',
    draftTeamViewNameOwnerId: '',
    draftOwnerUserId: '',
  }
}

export function resolvePlmAuditLogRouteTakeoverFormDraftState(options: {
  draftTeamViewName: string
  draftTeamViewNameOwnerId: string
  draftOwnerUserId: string
}): PlmAuditTeamViewFormDraftState {
  return resolvePlmAuditTakeoverTeamViewFormDraftState(options)
}
