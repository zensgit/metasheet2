import {
  matchPlmTeamFilterPresetStateSnapshot,
  pickPlmTeamFilterPresetRouteOwnerState,
} from './plmTeamFilterPresetStateMatch'
import type { FilterPreset } from './plmPanelModels'

type PlmLocalFilterPresetRouteIdentityInput = {
  routePresetKey: string
  selectedPresetKey: string
  nameDraft?: string
  groupDraft?: string
  selectionKeys?: string[]
  batchGroupDraft?: string
  activePreset: FilterPreset | null
  currentState: {
    field: string
    value: string
  }
  preserveSelectedPresetKeyOnClear?: boolean
}

export function buildPlmLocalFilterPresetRouteOwnerWatchKey(
  preset: Pick<FilterPreset, 'key' | 'field' | 'value'> | null,
) {
  if (!preset) return ''
  return JSON.stringify({
    key: preset.key.trim(),
    state: pickPlmTeamFilterPresetRouteOwnerState(preset),
  })
}

export function resolvePlmLocalFilterPresetRouteIdentity(
  input: PlmLocalFilterPresetRouteIdentityInput,
) {
  const routePresetKey = input.routePresetKey.trim()
  const selectedPresetKey = input.selectedPresetKey.trim()
  const activePreset = input.activePreset
  const selectionKeys = (input.selectionKeys || []).filter((entry) => entry.trim())
  const batchGroupDraft = input.batchGroupDraft || ''

  const buildClearedState = () => {
    const preserveSelectedPresetKey = Boolean(input.preserveSelectedPresetKeyOnClear && activePreset)
    const nextSelectedPresetKey =
      preserveSelectedPresetKey
        ? selectedPresetKey
        : selectedPresetKey === routePresetKey ? '' : selectedPresetKey
    const nextSelectionKeys =
      nextSelectedPresetKey && nextSelectedPresetKey === routePresetKey
        ? selectionKeys
        : selectionKeys.filter((entry) => entry.trim() !== routePresetKey)
    const shouldClearDrafts = !nextSelectedPresetKey.trim()

    return {
      nextRoutePresetKey: '',
      nextSelectedPresetKey,
      nextNameDraft: shouldClearDrafts ? '' : input.nameDraft || '',
      nextGroupDraft: shouldClearDrafts ? '' : input.groupDraft || '',
      nextSelectionKeys,
      nextBatchGroupDraft: nextSelectionKeys.length ? batchGroupDraft : '',
      shouldClear: true,
    }
  }

  if (!routePresetKey) {
    return {
      nextRoutePresetKey: routePresetKey,
      nextSelectedPresetKey: selectedPresetKey,
      nextNameDraft: input.nameDraft || '',
      nextGroupDraft: input.groupDraft || '',
      nextSelectionKeys: selectionKeys,
      nextBatchGroupDraft: batchGroupDraft,
      shouldClear: false,
    }
  }

  if (!activePreset) {
    return buildClearedState()
  }

  if (matchPlmTeamFilterPresetStateSnapshot(
    pickPlmTeamFilterPresetRouteOwnerState(activePreset),
    input.currentState,
  )) {
    return {
      nextRoutePresetKey: routePresetKey,
      nextSelectedPresetKey: selectedPresetKey,
      nextNameDraft: input.nameDraft || '',
      nextGroupDraft: input.groupDraft || '',
      nextSelectionKeys: selectionKeys,
      nextBatchGroupDraft: batchGroupDraft,
      shouldClear: false,
    }
  }

  return buildClearedState()
}
