export function shouldLockPlmAuditTeamViewManagementTarget(options: {
  routeTeamViewId: string
  selectedTeamViewId: string
}) {
  return Boolean(
    options.routeTeamViewId.trim()
    && options.selectedTeamViewId.trim()
    && options.routeTeamViewId !== options.selectedTeamViewId,
  )
}

export function resolvePlmAuditTeamViewDuplicateName(options: {
  draftName: string
  allowDraftName: boolean
}) {
  const trimmedName = options.draftName.trim()
  if (!trimmedName || !options.allowDraftName) return undefined
  return trimmedName
}
