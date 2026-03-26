import {
  matchPlmTeamFilterPresetStateSnapshot,
  pickPlmTeamFilterPresetStateKeys,
} from './plmTeamFilterPresetStateMatch'
import type { FilterPreset } from './plmPanelModels'

type PlmLocalFilterPresetRouteIdentityInput = {
  routePresetKey: string
  selectedPresetKey: string
  activePreset: FilterPreset | null
  currentState: {
    field: string
    value: string
  }
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
      shouldClear: false,
    }
  }

  if (matchPlmTeamFilterPresetStateSnapshot(
    pickPlmTeamFilterPresetStateKeys(activePreset, ['field', 'value']),
    input.currentState,
  )) {
    return {
      nextRoutePresetKey: routePresetKey,
      nextSelectedPresetKey: selectedPresetKey,
      shouldClear: false,
    }
  }

  return {
    nextRoutePresetKey: '',
    nextSelectedPresetKey: selectedPresetKey === routePresetKey ? '' : selectedPresetKey,
    shouldClear: true,
  }
}
