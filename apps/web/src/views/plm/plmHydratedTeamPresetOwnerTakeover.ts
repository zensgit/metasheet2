type PlmHydratedTeamPresetOwnerTakeoverOptions = {
  routeOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localGroupDraft: string
  localOwnerUserIdDraft: string
}

type PlmHydratedRemovedTeamPresetOwnerOptions = {
  removedRouteOwnerId: string
  localSelectorId: string
  localNameDraft: string
  localGroupDraft: string
  localOwnerUserIdDraft: string
}

export function resolvePlmHydratedTeamPresetOwnerTakeover(
  options: PlmHydratedTeamPresetOwnerTakeoverOptions,
) {
  const routeOwnerId = options.routeOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const shouldClearLocalSelector = Boolean(routeOwnerId && localSelectorId && routeOwnerId !== localSelectorId)

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearLocalSelector ? '' : options.localSelectorId,
    nextNameDraft: shouldClearLocalSelector ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearLocalSelector ? '' : options.localGroupDraft,
    nextOwnerUserIdDraft: shouldClearLocalSelector ? '' : options.localOwnerUserIdDraft,
  }
}

export function resolvePlmHydratedRemovedTeamPresetOwner(
  options: PlmHydratedRemovedTeamPresetOwnerOptions,
) {
  const removedRouteOwnerId = options.removedRouteOwnerId.trim()
  const localSelectorId = options.localSelectorId.trim()
  const shouldClearLocalSelector = Boolean(
    removedRouteOwnerId && (!localSelectorId || localSelectorId === removedRouteOwnerId),
  )

  return {
    shouldClearLocalSelector,
    nextSelectorId: shouldClearLocalSelector ? '' : options.localSelectorId,
    nextNameDraft: shouldClearLocalSelector ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearLocalSelector ? '' : options.localGroupDraft,
    nextOwnerUserIdDraft: shouldClearLocalSelector ? '' : options.localOwnerUserIdDraft,
  }
}
