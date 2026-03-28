type PlmHydratedTeamPresetOwnerTakeoverOptions = {
  routeOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localGroupDraft: string
  localOwnerUserIdDraft: string
  localSelectionIds: string[]
}

type PlmHydratedRemovedTeamPresetOwnerOptions = {
  removedRouteOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localGroupDraft: string
  localOwnerUserIdDraft: string
  localSelectionIds: string[]
}

export function resolvePlmHydratedTeamPresetOwnerTakeover(
  options: PlmHydratedTeamPresetOwnerTakeoverOptions,
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
  const shouldClearLocalSelector = Boolean(
    routeOwnerId
    && (
      (localSelectorId && routeOwnerId !== localSelectorId)
      || nextSelectionIds.length !== localSelectionIds.length
    ),
  )
  const shouldClearDrafts = Boolean(routeOwnerId && localSelectorId && routeOwnerId !== localSelectorId)

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearDrafts ? '' : options.localSelectorId,
    nextNameDraft: shouldClearDrafts ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearDrafts ? '' : options.localGroupDraft,
    nextOwnerUserIdDraft: shouldClearDrafts ? '' : options.localOwnerUserIdDraft,
    nextSelectionIds,
  }
}

export function resolvePlmHydratedRemovedTeamPresetOwner(
  options: PlmHydratedRemovedTeamPresetOwnerOptions,
) {
  const removedRouteOwnerId = options.removedRouteOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const localSelectionIds = Array.from(new Set(
    options.localSelectionIds
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
  const shouldClearLocalSelector = Boolean(
    removedRouteOwnerId && (!localSelectorId || localSelectorId === removedRouteOwnerId),
  )
  const nextSelectionIds = removedRouteOwnerId
    ? localSelectionIds.filter((entry) => entry !== removedRouteOwnerId)
    : localSelectionIds

  return {
    shouldClearLocalSelector: Boolean(
      shouldClearLocalSelector || nextSelectionIds.length !== localSelectionIds.length,
    ),
    nextSelectorId: shouldClearLocalSelector ? '' : options.localSelectorId,
    nextNameDraft: shouldClearLocalSelector ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearLocalSelector ? '' : options.localGroupDraft,
    nextOwnerUserIdDraft: shouldClearLocalSelector ? '' : options.localOwnerUserIdDraft,
    nextSelectionIds,
  }
}
