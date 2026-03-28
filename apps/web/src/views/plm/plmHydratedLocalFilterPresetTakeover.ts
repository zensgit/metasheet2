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
  const localSelectionKeys = Array.from(new Set(
    options.localSelectionKeys
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
  const nextSelectionKeys = !routePresetKey
    ? localSelectionKeys
    : localSelectorKey && localSelectorKey !== routePresetKey
      ? []
      : localSelectionKeys.filter((entry) => entry === routePresetKey)
  const shouldClearDrafts = Boolean(
    routePresetKey
    && localSelectorKey !== routePresetKey,
  )
  const shouldClearLocalSelector = Boolean(
    routePresetKey
    && (
      (localSelectorKey && localSelectorKey !== routePresetKey)
      || nextSelectionKeys.length !== localSelectionKeys.length
    ),
  )

  return {
    shouldClearLocalSelector,
    nextSelectorKey: shouldClearDrafts ? '' : options.localSelectorKey,
    nextNameDraft: shouldClearDrafts ? '' : options.localNameDraft,
    nextGroupDraft: shouldClearDrafts ? '' : options.localGroupDraft,
    nextSelectionKeys,
    nextBatchGroupDraft: nextSelectionKeys.length ? options.localBatchGroupDraft : '',
  }
}
