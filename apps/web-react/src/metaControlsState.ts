import type { CopyStatus } from './metaPageState'
import type { StoredMetaConfig, StoredRefreshConfig, StoredViewFilters } from './metaStorage'
import type { ViewTypeFilter } from './viewFilters'

export interface MetaControlsDefaults {
  defaultSheetId: string
  defaultViewId: string
}

export interface MetaControlsState {
  autoRefresh: boolean
  copyStatus: CopyStatus
  refreshIntervalSec: number
  sheetId: string
  sheetIdInput: string
  useBackend: boolean
  viewId: string
  viewIdInput: string
  viewSearch: string
  viewTypeFilter: ViewTypeFilter
}

interface CreateMetaControlsStateOptions extends MetaControlsDefaults {
  storedBackend: boolean
  storedConfig: StoredMetaConfig | null
  storedRefresh: StoredRefreshConfig | null
  storedViewFilters: StoredViewFilters | null
}

export function createMetaControlsState(options: CreateMetaControlsStateOptions): MetaControlsState {
  const sheetId = options.storedConfig?.sheetId ?? options.defaultSheetId
  const viewId = options.storedConfig?.viewId ?? options.defaultViewId

  return {
    autoRefresh: options.storedRefresh?.autoRefresh ?? false,
    copyStatus: 'idle',
    refreshIntervalSec: options.storedRefresh?.intervalSec ?? 10,
    sheetId,
    sheetIdInput: sheetId,
    useBackend: options.storedBackend,
    viewId,
    viewIdInput: viewId,
    viewSearch: options.storedViewFilters?.search ?? '',
    viewTypeFilter: options.storedViewFilters?.type ?? 'all',
  }
}

export function deriveMetaControlsCanApply(state: MetaControlsState) {
  return state.sheetIdInput.trim() !== state.sheetId || state.viewIdInput.trim() !== state.viewId
}

export function applyMetaControlsParams(
  state: MetaControlsState,
  defaults: MetaControlsDefaults,
): MetaControlsState {
  return {
    ...state,
    sheetId: state.sheetIdInput.trim() || defaults.defaultSheetId,
    viewId: state.viewIdInput.trim(),
  }
}

export function resetMetaControlsParams(
  state: MetaControlsState,
  defaults: MetaControlsDefaults,
): MetaControlsState {
  return {
    ...state,
    sheetId: defaults.defaultSheetId,
    sheetIdInput: defaults.defaultSheetId,
    viewId: defaults.defaultViewId,
    viewIdInput: defaults.defaultViewId,
  }
}

export function clearMetaControlsState(
  state: MetaControlsState,
  defaults: Pick<MetaControlsDefaults, 'defaultViewId'>,
): MetaControlsState {
  return {
    ...state,
    copyStatus: 'idle',
    viewId: defaults.defaultViewId,
    viewIdInput: defaults.defaultViewId,
    viewSearch: '',
    viewTypeFilter: 'all',
  }
}

export function selectMetaControlsView(state: MetaControlsState, nextViewId: string): MetaControlsState {
  return {
    ...state,
    viewId: nextViewId,
    viewIdInput: nextViewId,
  }
}

export function updateMetaControlsRefreshInterval(state: MetaControlsState, nextValue: number): MetaControlsState {
  if (!Number.isFinite(nextValue)) {
    return state
  }

  return {
    ...state,
    refreshIntervalSec: nextValue,
  }
}
