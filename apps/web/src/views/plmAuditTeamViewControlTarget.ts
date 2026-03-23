import type { PlmAuditRouteState } from './plmAuditQueryState'

export function resolvePlmAuditCanonicalTeamViewManagementTargetId(options: {
  routeTeamViewId: string
  followupTeamViewId: string
}) {
  return options.routeTeamViewId.trim() || options.followupTeamViewId.trim()
}

export function resolvePlmAuditCanonicalTeamViewManagementTarget<T extends { id: string }>(
  views: readonly T[],
  options: {
    routeTeamViewId: string
    followupTeamViewId: string
  },
) {
  const targetId = resolvePlmAuditCanonicalTeamViewManagementTargetId(options)
  if (!targetId) return null
  return views.find((view) => view.id === targetId) || null
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

export function shouldDisablePlmAuditTeamViewTransferOwnerInput(options: {
  managementTargetLocked: boolean
  canTransferTarget: boolean
  loading: boolean
}) {
  return options.managementTargetLocked || !options.canTransferTarget || options.loading
}
