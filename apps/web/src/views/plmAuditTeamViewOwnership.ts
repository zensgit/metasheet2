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
