import { useEffect, useMemo, useRef, useState } from 'react'
import { MetaControls } from './components/MetaControls'
import { DEMO_WORKBOOK_DATA } from './demoWorkbook'
import { buildWorkbookFromMeta } from './metaWorkbook'
import { createMetaBackendClient } from './metaBackend'
import {
  copyLastErrorInfo,
  deriveMetaPageState,
  REFRESH_INTERVAL_OPTIONS,
  type CopyStatus,
} from './metaPageState'
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
import { useMetaBackendLifecycle } from './useMetaBackendLifecycle'
import { VIEW_TYPE_FILTER_OPTIONS, type ViewTypeFilter } from './viewFilters'
import {
  createUniverRuntime,
  disposeUniverRuntime,
  renderWorkbook,
  type UniverRuntime,
} from './univerRuntime'

const CONTAINER_ID = 'univer-container'
const META_API_BASE = import.meta.env.VITE_META_API_BASE || ''
const META_SHEET_ID = import.meta.env.VITE_META_SHEET_ID || 'univer_demo_meta'
const META_VIEW_ID = import.meta.env.VITE_META_VIEW_ID || ''

export default function App() {
  const univerRuntimeRef = useRef<UniverRuntime | null>(null)
  const [useBackend, setUseBackend] = useState(() => readStoredBackend())
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const initialRefreshConfig = useMemo(() => readStoredRefresh(), [])
  const [autoRefresh, setAutoRefresh] = useState(initialRefreshConfig?.autoRefresh ?? false)
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(initialRefreshConfig?.intervalSec ?? 10)
  const initialViewFilters = useMemo(() => readStoredViewFilters(), [])
  const [viewSearch, setViewSearch] = useState(initialViewFilters?.search ?? '')
  const [viewTypeFilter, setViewTypeFilter] = useState<ViewTypeFilter>(
    initialViewFilters?.type ?? 'all',
  )
  const initialConfig = useMemo(() => {
    const stored = readStoredConfig()
    return {
      sheetId: stored?.sheetId ?? META_SHEET_ID,
      viewId: stored?.viewId ?? META_VIEW_ID
    }
  }, [])
  const [sheetIdInput, setSheetIdInput] = useState(initialConfig.sheetId)
  const [viewIdInput, setViewIdInput] = useState(initialConfig.viewId)
  const [sheetId, setSheetId] = useState(initialConfig.sheetId)
  const [viewId, setViewId] = useState(initialConfig.viewId)

  const backendClient = useMemo(
    () => createMetaBackendClient({ baseUrl: META_API_BASE, sheetId, viewId }),
    [sheetId, viewId],
  )
  const {
    clearBackendErrors,
    handleRefresh,
    pageVisible,
    retryData,
    retryViews,
    state: {
      dataErrorAt,
      error,
      isRefreshing,
      lastErrorInfo,
      lastRefreshAt,
      lastViewsAt,
      status,
      views,
      viewsError,
      viewsErrorAt,
      viewsStatus,
      workbookData,
    },
  } = useMetaBackendLifecycle({
    autoRefresh,
    buildWorkbook: buildWorkbookFromMeta,
    client: backendClient,
    fallbackWorkbook: DEMO_WORKBOOK_DATA,
    refreshIntervalSec,
    sheetId,
    useBackend,
  })

  const canApply = sheetIdInput.trim() !== sheetId || viewIdInput.trim() !== viewId
  const applyParams = () => {
    const nextSheetId = sheetIdInput.trim() || META_SHEET_ID
    const nextViewId = viewIdInput.trim()
    setSheetId(nextSheetId)
    setViewId(nextViewId)
    saveStoredConfig({ sheetId: nextSheetId, viewId: nextViewId })
  }

  const resetParams = () => {
    const nextSheetId = META_SHEET_ID
    const nextViewId = META_VIEW_ID
    setSheetIdInput(nextSheetId)
    setViewIdInput(nextViewId)
    setSheetId(nextSheetId)
    setViewId(nextViewId)
    clearStoredConfig()
  }

  const clearState = () => {
    setViewSearch('')
    setViewTypeFilter('all')
    clearBackendErrors()
    setCopyStatus('idle')
    setViewIdInput(META_VIEW_ID)
    setViewId(META_VIEW_ID)
    saveStoredConfig({ sheetId, viewId: META_VIEW_ID })
  }

  const handleViewSelect = (nextViewId: string) => {
    setViewIdInput(nextViewId)
    setViewId(nextViewId)
    saveStoredConfig({ sheetId, viewId: nextViewId })
  }

  const handleIntervalChange = (nextValue: number) => {
    if (Number.isFinite(nextValue)) {
      setRefreshIntervalSec(nextValue)
    }
  }

  const handleCopyError = async () => {
    const nextCopyStatus = await copyLastErrorInfo(
      lastErrorInfo,
      typeof navigator === 'undefined' ? null : navigator.clipboard,
    )
    if (nextCopyStatus === 'idle') return
    setCopyStatus(nextCopyStatus)
    window.setTimeout(() => setCopyStatus('idle'), 2000)
  }

  useEffect(() => {
    saveStoredRefresh({ autoRefresh, intervalSec: refreshIntervalSec })
  }, [autoRefresh, refreshIntervalSec])

  useEffect(() => {
    saveStoredBackend(useBackend)
  }, [useBackend])

  useEffect(() => {
    saveStoredViewFilters({ search: viewSearch, type: viewTypeFilter })
  }, [viewSearch, viewTypeFilter])

  useEffect(() => {
    if (!useBackend) {
      setCopyStatus('idle')
    }
  }, [useBackend])

  useEffect(() => {
    const container = document.getElementById(CONTAINER_ID)
    if (!container) {
      return undefined
    }

    const runtime = createUniverRuntime(container)
    univerRuntimeRef.current = runtime

    return () => {
      if (univerRuntimeRef.current) {
        disposeUniverRuntime(univerRuntimeRef.current)
        univerRuntimeRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!univerRuntimeRef.current) return

    renderWorkbook(univerRuntimeRef.current, workbookData)
  }, [workbookData])

  const {
    autoRefreshLabel,
    canRefresh,
    canRetryData,
    canRetryViews,
    groupedViews,
    lastErrorLabel,
    showViewIdInput,
    showViewSelect,
    viewTypeLabel,
  } = useMemo(
    () =>
      deriveMetaPageState({
        autoRefresh,
        isRefreshing,
        lastErrorInfo,
        pageVisible,
        status,
        useBackend,
        viewId,
        viewSearch,
        views,
        viewsStatus,
        viewTypeFilter,
      }),
    [
      autoRefresh,
      isRefreshing,
      lastErrorInfo,
      pageVisible,
      status,
      useBackend,
      viewId,
      viewSearch,
      views,
      viewsStatus,
      viewTypeFilter,
    ],
  )

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>MetaSheet Univer POC</h1>
          <p>React + Univer minimal demo</p>
        </div>
        <MetaControls
          autoRefresh={autoRefresh}
          autoRefreshLabel={autoRefreshLabel}
          canApply={canApply}
          canRefresh={canRefresh}
          canRetryData={canRetryData}
          canRetryViews={canRetryViews}
          copyStatus={copyStatus}
          dataErrorAt={dataErrorAt}
          error={error}
          groupedViews={groupedViews}
          isRefreshing={isRefreshing}
          lastErrorInfo={lastErrorInfo}
          lastErrorLabel={lastErrorLabel}
          lastRefreshAt={lastRefreshAt}
          lastViewsAt={lastViewsAt}
          onApply={applyParams}
          onClearState={clearState}
          onCopyError={handleCopyError}
          onRefresh={handleRefresh}
          onRefreshIntervalChange={handleIntervalChange}
          onReset={resetParams}
          onRetryData={retryData}
          onRetryViews={retryViews}
          onSetAutoRefresh={setAutoRefresh}
          onSetSheetIdInput={setSheetIdInput}
          onSetUseBackend={setUseBackend}
          onSetViewIdInput={setViewIdInput}
          onSetViewSearch={setViewSearch}
          onSetViewTypeFilter={setViewTypeFilter}
          onViewSelect={handleViewSelect}
          refreshIntervalOptions={REFRESH_INTERVAL_OPTIONS}
          refreshIntervalSec={refreshIntervalSec}
          sheetIdInput={sheetIdInput}
          showViewIdInput={showViewIdInput}
          showViewSelect={showViewSelect}
          status={status}
          useBackend={useBackend}
          viewId={viewId}
          viewIdInput={viewIdInput}
          viewsError={viewsError}
          viewsErrorAt={viewsErrorAt}
          viewsStatus={viewsStatus}
          viewSearch={viewSearch}
          viewTypeFilter={viewTypeFilter}
          viewTypeFilterOptions={VIEW_TYPE_FILTER_OPTIONS}
          viewTypeLabel={viewTypeLabel}
        />
      </header>
      <div id={CONTAINER_ID} className="univer-container" />
    </div>
  )
}
