type PlmHydratedTeamViewOwnerTakeoverOptions = {
  routeOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localOwnerUserIdDraft: string
  localSelectionIds: string[]
}

type PlmHydratedRemovedTeamViewOwnerOptions = {
  removedRouteOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localOwnerUserIdDraft: string
  localSelectionIds: string[]
}

export function resolvePlmHydratedTeamViewOwnerTakeover(
  options: PlmHydratedTeamViewOwnerTakeoverOptions,
) {
  const routeOwnerId = options.routeOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const localSelectionIds = Array.from(new Set(
    options.localSelectionIds
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
  const nextSelectionIds = !routeOwnerId
    ? localSelectionIds
    : localSelectorId && localSelectorId !== routeOwnerId
      ? []
      : localSelectionIds.filter((entry) => entry === routeOwnerId)
  const shouldClearDrafts = Boolean(routeOwnerId && localSelectorId && routeOwnerId !== localSelectorId)
  const shouldClearLocalSelector = Boolean(
    routeOwnerId
    && (
      (localSelectorId && localSelectorId !== routeOwnerId)
      || nextSelectionIds.length !== localSelectionIds.length
    ),
  )

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearDrafts ? '' : options.localSelectorId,
    nextNameDraft: shouldClearDrafts ? '' : options.localNameDraft,
    nextOwnerUserIdDraft: shouldClearDrafts ? '' : options.localOwnerUserIdDraft,
    nextSelectionIds,
  }
}

export function resolvePlmHydratedRemovedTeamViewOwner(
  options: PlmHydratedRemovedTeamViewOwnerOptions,
) {
  const removedRouteOwnerId = options.removedRouteOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const localSelectionIds = Array.from(new Set(
    options.localSelectionIds
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
  const shouldClearDrafts = Boolean(
    removedRouteOwnerId && (!localSelectorId || localSelectorId === removedRouteOwnerId),
  )
  const nextSelectionIds = removedRouteOwnerId
    ? localSelectionIds.filter((entry) => entry !== removedRouteOwnerId)
    : localSelectionIds
  const shouldClearLocalSelector = Boolean(
    shouldClearDrafts || nextSelectionIds.length !== localSelectionIds.length,
  )

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearDrafts ? '' : options.localSelectorId,
    nextNameDraft: shouldClearDrafts ? '' : options.localNameDraft,
    nextOwnerUserIdDraft: shouldClearDrafts ? '' : options.localOwnerUserIdDraft,
    nextSelectionIds,
  }
}
