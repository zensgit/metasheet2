import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type CopyStatus } from './metaPageState'
import {
  clearStoredConfig,
  readStoredBackend,
  readStoredConfig,
  readStoredRefresh,
  readStoredViewFilters,
  saveStoredBackend,
  saveStoredConfig,
  saveStoredRefresh,
  saveStoredViewFilters,
} from './metaStorage'
import {
  applyMetaControlsParams,
  clearMetaControlsState,
  createMetaControlsState,
  deriveMetaControlsCanApply,
  resetMetaControlsParams,
  selectMetaControlsView,
  updateMetaControlsRefreshInterval,
  type MetaControlsDefaults,
  type MetaControlsState,
} from './metaControlsState'
import type { ViewTypeFilter } from './viewFilters'

export function useMetaControlsState(defaults: MetaControlsDefaults) {
  const initialState = useMemo(
    () =>
      createMetaControlsState({
        defaultSheetId: defaults.defaultSheetId,
        defaultViewId: defaults.defaultViewId,
        storedBackend: readStoredBackend(),
        storedConfig: readStoredConfig(),
        storedRefresh: readStoredRefresh(),
        storedViewFilters: readStoredViewFilters(),
      }),
    [defaults.defaultSheetId, defaults.defaultViewId],
  )

  const [state, setState] = useState<MetaControlsState>(initialState)
  const stateRef = useRef(state)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    saveStoredBackend(state.useBackend)
  }, [state.useBackend])

  useEffect(() => {
    saveStoredRefresh({ autoRefresh: state.autoRefresh, intervalSec: state.refreshIntervalSec })
  }, [state.autoRefresh, state.refreshIntervalSec])

  useEffect(() => {
    saveStoredViewFilters({ search: state.viewSearch, type: state.viewTypeFilter })
  }, [state.viewSearch, state.viewTypeFilter])

  const setUseBackend = useCallback((next: boolean) => {
    setState((prev) => ({
      ...prev,
      copyStatus: next ? prev.copyStatus : 'idle',
      useBackend: next,
    }))
  }, [])

  const setAutoRefresh = useCallback((next: boolean) => {
    setState((prev) => ({
      ...prev,
      autoRefresh: next,
    }))
  }, [])

  const setSheetIdInput = useCallback((next: string) => {
    setState((prev) => ({
      ...prev,
      sheetIdInput: next,
    }))
  }, [])

  const setViewIdInput = useCallback((next: string) => {
    setState((prev) => ({
      ...prev,
      viewIdInput: next,
    }))
  }, [])

  const setViewSearch = useCallback((next: string) => {
    setState((prev) => ({
      ...prev,
      viewSearch: next,
    }))
  }, [])

  const setViewTypeFilter = useCallback((next: ViewTypeFilter) => {
    setState((prev) => ({
      ...prev,
      viewTypeFilter: next,
    }))
  }, [])

  const setCopyStatus = useCallback((next: CopyStatus) => {
    setState((prev) => ({
      ...prev,
      copyStatus: next,
    }))
  }, [])

  const applyParams = useCallback(() => {
    const nextState = applyMetaControlsParams(stateRef.current, defaults)
    setState(nextState)
    saveStoredConfig({ sheetId: nextState.sheetId, viewId: nextState.viewId })
  }, [defaults])

  const resetParams = useCallback(() => {
    const nextState = resetMetaControlsParams(stateRef.current, defaults)
    setState(nextState)
    clearStoredConfig()
  }, [defaults])

  const clearLocalState = useCallback(() => {
    const nextState = clearMetaControlsState(stateRef.current, defaults)
    setState(nextState)
    saveStoredConfig({ sheetId: nextState.sheetId, viewId: nextState.viewId })
  }, [defaults])

  const handleViewSelect = useCallback((nextViewId: string) => {
    const nextState = selectMetaControlsView(stateRef.current, nextViewId)
    setState(nextState)
    saveStoredConfig({ sheetId: nextState.sheetId, viewId: nextState.viewId })
  }, [])

  const handleIntervalChange = useCallback((nextValue: number) => {
    setState((prev) => updateMetaControlsRefreshInterval(prev, nextValue))
  }, [])

  return {
    applyParams,
    canApply: deriveMetaControlsCanApply(state),
    clearLocalState,
    handleIntervalChange,
    handleViewSelect,
    resetParams,
    setAutoRefresh,
    setCopyStatus,
    setSheetIdInput,
    setUseBackend,
    setViewIdInput,
    setViewSearch,
    setViewTypeFilter,
    state,
  }
}
