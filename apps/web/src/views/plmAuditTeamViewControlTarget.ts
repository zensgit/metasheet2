import type { PlmAuditRouteState } from './plmAuditQueryState'

export function resolvePlmAuditCanonicalTeamViewManagementTargetId(options: {
  routeTeamViewId: string
  followupTeamViewId: string
}) {
  return options.routeTeamViewId.trim() || options.followupTeamViewId.trim()
}

export function shouldLockPlmAuditTeamViewManagementTarget(options: {
  canonicalTeamViewId: string
  selectedTeamViewId: string
}) {
  return Boolean(
    options.canonicalTeamViewId.trim()
    && options.selectedTeamViewId.trim()
    && options.canonicalTeamViewId !== options.selectedTeamViewId,
  )
}

export function resolvePlmAuditCanonicalTeamViewRouteState(options: {
  currentState: PlmAuditRouteState
  routeTeamViewId: string
}): PlmAuditRouteState {
  return {
    ...options.currentState,
    teamViewId: options.routeTeamViewId.trim(),
  }
}

export function resolvePlmAuditTeamViewDuplicateName(options: {
  draftName: string
  allowDraftName: boolean
}) {
  const trimmedName = options.draftName.trim()
  if (!trimmedName || !options.allowDraftName) return undefined
  return trimmedName
}
