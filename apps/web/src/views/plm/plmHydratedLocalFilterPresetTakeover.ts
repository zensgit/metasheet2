type PlmHydratedLocalFilterPresetTakeoverOptions = {
  routePresetKey: string
  localSelectorKey: string
  localNameDraft: string
  localGroupDraft: string
  localSelectionKeys: string[]
  localBatchGroupDraft: string
}

export function resolvePlmHydratedLocalFilterPresetTakeover(
  options: PlmHydratedLocalFilterPresetTakeoverOptions,
) {
  const routePresetKey = options.routePresetKey.trim()
  const localSelectorKey = options.localSelectorKey.trim()
  const shouldClearLocalSelector = Boolean(routePresetKey && localSelectorKey && routePresetKey !== localSelectorKey)

  return {
    shouldClearLocalSelector,
    nextSelectorKey: shouldClearLocalSelector ? '' : options.localSelectorKey,
    nextNameDraft: shouldClearLocalSelector ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearLocalSelector ? '' : options.localGroupDraft,
    nextSelectionKeys: shouldClearLocalSelector ? [] : options.localSelectionKeys,
    nextBatchGroupDraft: shouldClearLocalSelector ? '' : options.localBatchGroupDraft,
  }
}
