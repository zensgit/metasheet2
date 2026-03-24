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
  options?: {
    isApplicableView?: (view: T) => boolean
    isSelectableView?: (view: T) => boolean
    isManageableView?: (view: T) => boolean
  },
): PlmAuditTeamViewListUiState {
  const viewsById = new Map(views.map((view) => [view.id, view]))
  const selectedTeamViewId = state.selectedTeamViewId.trim()
  const managedTeamViewId = state.managedTeamViewId.trim()
  const selectedTeamView = selectedTeamViewId ? viewsById.get(selectedTeamViewId) : null
  const managedTeamView = managedTeamViewId ? viewsById.get(managedTeamViewId) : null
  const selectedTeamViewStillAvailable = !selectedTeamViewId || Boolean(
    selectedTeamView
    && (options?.isApplicableView ? options.isApplicableView(selectedTeamView) : true),
  )
  const managedTeamViewStillExists = !managedTeamViewId || Boolean(managedTeamView)
  const managedTeamViewStillManageable = !managedTeamViewId || Boolean(
    managedTeamView
    && (options?.isManageableView ? options.isManageableView(managedTeamView) : true),
  )
  const nextSelectedTeamViewId = selectedTeamViewStillAvailable ? state.selectedTeamViewId : ''
  const hasManagedDraftOwner = Boolean(state.draftTeamViewNameOwnerId.trim())
  const selectedTeamViewOwnsDraft = Boolean(
    nextSelectedTeamViewId.trim()
    && state.draftTeamViewNameOwnerId.trim() === nextSelectedTeamViewId.trim(),
  )
  const shouldPreserveNameDraft = hasManagedDraftOwner
    ? Boolean(nextSelectedTeamViewId.trim()) || managedTeamViewStillExists
    : true
  const shouldPreserveManagedDraftBinding = hasManagedDraftOwner
    && (selectedTeamViewOwnsDraft || managedTeamViewStillManageable)

  return {
    selectedTeamViewId: nextSelectedTeamViewId,
    selectedIds: state.selectedIds.filter((id) => {
      const view = viewsById.get(id)
      if (!view) return false
      return options?.isSelectableView ? options.isSelectableView(view) : true
    }),
    focusedTeamViewId: viewsById.has(state.focusedTeamViewId) ? state.focusedTeamViewId : '',
    focusedRecommendedTeamViewId: viewsById.has(state.focusedRecommendedTeamViewId)
      ? state.focusedRecommendedTeamViewId
      : '',
    draftTeamViewName: shouldPreserveNameDraft ? state.draftTeamViewName : '',
    draftTeamViewNameOwnerId: shouldPreserveManagedDraftBinding ? state.draftTeamViewNameOwnerId : '',
    draftOwnerUserId: hasManagedDraftOwner
      ? shouldPreserveManagedDraftBinding
        ? state.draftOwnerUserId
        : ''
      : state.draftOwnerUserId,
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
