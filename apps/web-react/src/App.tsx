import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import { MetaControls } from './components/MetaControls'
import {
  bootstrapMetaBackendSession,
  createLocalMetaBackendState,
  refreshMetaBackendState,
  type MetaBackendStateSnapshot,
} from './metaBackendController'
import { DEMO_WORKBOOK_DATA } from './demoWorkbook'
import { buildWorkbookFromMeta } from './metaWorkbook'
import { createMetaBackendClient, type ErrorScope, type LastErrorInfo } from './metaBackend'
import {
  clearLastErrorScope,
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
import { VIEW_TYPE_FILTER_OPTIONS, type ViewOption, type ViewTypeFilter } from './viewFilters'
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
  const [status, setStatus] = useState<'local' | 'loading' | 'ready' | 'error'>('local')
  const [error, setError] = useState<string | null>(null)
  const [lastErrorInfo, setLastErrorInfo] = useState<LastErrorInfo | null>(null)
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const [views, setViews] = useState<ViewOption[]>([])
  const [viewsStatus, setViewsStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [viewsError, setViewsError] = useState<string | null>(null)
  const [viewsErrorAt, setViewsErrorAt] = useState<string | null>(null)
  const initialRefreshConfig = useMemo(() => readStoredRefresh(), [])
  const [autoRefresh, setAutoRefresh] = useState(initialRefreshConfig?.autoRefresh ?? false)
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(initialRefreshConfig?.intervalSec ?? 10)
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null)
  const [lastViewsAt, setLastViewsAt] = useState<string | null>(null)
  const [dataErrorAt, setDataErrorAt] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [pageVisible, setPageVisible] = useState(true)
  const initialViewFilters = useMemo(() => readStoredViewFilters(), [])
  const [viewSearch, setViewSearch] = useState(initialViewFilters?.search ?? '')
  const [viewTypeFilter, setViewTypeFilter] = useState<ViewTypeFilter>(
    initialViewFilters?.type ?? 'all',
  )
  const refreshInFlightRef = useRef(false)
  const backendStateRef = useRef<MetaBackendStateSnapshot>({
    status: 'local',
    error: null,
    lastErrorInfo: null,
    views: [],
    viewsStatus: 'idle',
    viewsError: null,
    viewsErrorAt: null,
    lastViewsAt: null,
    lastRefreshAt: null,
    dataErrorAt: null,
    workbookData: DEMO_WORKBOOK_DATA,
  })
  const lastSheetIdRef = useRef<string | null>(null)
  const tokenBootstrappedRef = useRef(false)
  const [workbookData, setWorkbookData] = useState<IWorkbookData>(DEMO_WORKBOOK_DATA)
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
    setLastErrorInfo(null)
    setError(null)
    setViewsError(null)
    setViewsErrorAt(null)
    setDataErrorAt(null)
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

  const clearLastErrorForScope = (scope: ErrorScope) => {
    setLastErrorInfo((prev) => clearLastErrorScope(prev, scope))
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
    // Keep refresh logic stable so the bootstrap effect only reruns when backend params change.
    backendStateRef.current = {
      status,
      error,
      lastErrorInfo,
      views,
      viewsStatus,
      viewsError,
      viewsErrorAt,
      lastViewsAt,
      lastRefreshAt,
      dataErrorAt,
      workbookData,
    }
  }, [
    dataErrorAt,
    error,
    lastErrorInfo,
    lastRefreshAt,
    lastViewsAt,
    status,
    views,
    viewsError,
    viewsErrorAt,
    viewsStatus,
    workbookData,
  ])

  const refreshBackend = useCallback(
    async ({ refreshViews = true, quiet = false }: { refreshViews?: boolean; quiet?: boolean } = {}) => {
      if (!useBackend || refreshInFlightRef.current) return
      refreshInFlightRef.current = true
      setIsRefreshing(true)
      if (!quiet) {
        setStatus('loading')
        setError(null)
      }
      if (refreshViews) {
        setViewsStatus('loading')
        setViewsError(null)
      }
      try {
        const nextState = await refreshMetaBackendState({
          client: backendClient,
          current: backendStateRef.current,
          refreshViews,
          fallbackWorkbook: DEMO_WORKBOOK_DATA,
          buildWorkbook: buildWorkbookFromMeta,
        })

        setStatus(nextState.status)
        setError(nextState.error)
        setLastErrorInfo(nextState.lastErrorInfo)
        setViews(nextState.views)
        setViewsStatus(nextState.viewsStatus)
        setViewsError(nextState.viewsError)
        setViewsErrorAt(nextState.viewsErrorAt)
        setLastViewsAt(nextState.lastViewsAt)
        setLastRefreshAt(nextState.lastRefreshAt)
        setDataErrorAt(nextState.dataErrorAt)
        setWorkbookData(nextState.workbookData)
      } finally {
        refreshInFlightRef.current = false
        setIsRefreshing(false)
      }
    },
    [backendClient, useBackend],
  )

  const handleRefresh = () => {
    refreshBackend({ refreshViews: true })
  }

  const retryViews = () => {
    refreshBackend({ refreshViews: true })
  }

  const retryData = () => {
    refreshBackend({ refreshViews: false })
  }

  useEffect(() => {
    let cancelled = false
    if (!useBackend) {
      tokenBootstrappedRef.current = false
      const localState = createLocalMetaBackendState(DEMO_WORKBOOK_DATA)
      setStatus(localState.status)
      setError(localState.error)
      setLastErrorInfo(localState.lastErrorInfo)
      setCopyStatus('idle')
      setViews(localState.views)
      setViewsStatus(localState.viewsStatus)
      setViewsError(localState.viewsError)
      setViewsErrorAt(localState.viewsErrorAt)
      setDataErrorAt(localState.dataErrorAt)
      setIsRefreshing(false)
      setLastRefreshAt(localState.lastRefreshAt)
      setLastViewsAt(localState.lastViewsAt)
      setWorkbookData(localState.workbookData)
      return () => {
        cancelled = true
      }
    }
    const shouldRefreshViews = lastSheetIdRef.current !== sheetId
    lastSheetIdRef.current = sheetId

    const run = async () => {
      const bootstrap = await bootstrapMetaBackendSession({
        client: backendClient,
        tokenBootstrapped: tokenBootstrappedRef.current,
      })

      if (!bootstrap.ok) {
        if (cancelled) return
        setLastErrorInfo(bootstrap.lastErrorInfo)
        setStatus(bootstrap.status)
        setError(bootstrap.error)
        setViewsStatus(bootstrap.viewsStatus)
        setViewsError(bootstrap.viewsError)
        setIsRefreshing(false)
        return
      }

      tokenBootstrappedRef.current = bootstrap.tokenBootstrapped
      if (bootstrap.clearTokenError) {
        clearLastErrorForScope('token')
      }
      if (cancelled) return
      refreshBackend({ refreshViews: shouldRefreshViews })
    }

    run()

    return () => {
      cancelled = true
    }
  }, [backendClient, refreshBackend, sheetId, useBackend, viewId])

  useEffect(() => {
    if (!useBackend || !autoRefresh) return
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refreshBackend({ refreshViews: false, quiet: true })
      }
    }, refreshIntervalSec * 1000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, refreshBackend, refreshIntervalSec, useBackend])

  useEffect(() => {
    const update = () => {
      setPageVisible(!document.hidden)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

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
