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

  if (!routePresetKey || !activePreset) {
    return {
      nextRoutePresetKey: routePresetKey,
      nextSelectedPresetKey: selectedPresetKey,
      nextNameDraft: input.nameDraft || '',
      nextGroupDraft: input.groupDraft || '',
      shouldClear: false,
    }
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
      shouldClear: false,
    }
  }

  const nextSelectedPresetKey =
    input.preserveSelectedPresetKeyOnClear
      ? selectedPresetKey
      : selectedPresetKey === routePresetKey ? '' : selectedPresetKey
  const shouldClearDrafts = !nextSelectedPresetKey.trim()

  return {
    nextRoutePresetKey: '',
    nextSelectedPresetKey,
    nextNameDraft: shouldClearDrafts ? '' : input.nameDraft || '',
    nextGroupDraft: shouldClearDrafts ? '' : input.groupDraft || '',
    shouldClear: true,
  }
}
