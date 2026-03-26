type PlmHydratedTeamViewOwnerTakeoverOptions = {
  routeOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localOwnerUserIdDraft: string
}

export function resolvePlmHydratedTeamViewOwnerTakeover(
  options: PlmHydratedTeamViewOwnerTakeoverOptions,
) {
  const routeOwnerId = options.routeOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const shouldClearLocalSelector = Boolean(routeOwnerId && localSelectorId && routeOwnerId !== localSelectorId)

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearLocalSelector ? '' : options.localSelectorId,
    nextNameDraft: shouldClearLocalSelector ? '' : options.localNameDraft,
    nextOwnerUserIdDraft: shouldClearLocalSelector ? '' : options.localOwnerUserIdDraft,
  }
}
