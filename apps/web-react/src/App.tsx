import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { IWorkbookData } from '@univerjs/core'
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

  const handleViewSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextViewId = event.target.value
    setViewIdInput(nextViewId)
    setViewId(nextViewId)
    saveStoredConfig({ sheetId, viewId: nextViewId })
  }

  const handleIntervalChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = Number.parseInt(event.target.value, 10)
    if (Number.isFinite(nextValue)) {
      setRefreshIntervalSec(nextValue)
    }
  }

  const handleViewSearch = (event: ChangeEvent<HTMLInputElement>) => {
    setViewSearch(event.target.value)
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
        <div className="app-actions">
          <button
            className={`toggle ${useBackend ? 'active' : ''}`}
            type="button"
            onClick={() => setUseBackend((prev) => !prev)}
          >
            {useBackend ? 'Backend ON' : 'Backend OFF'}
          </button>
          <button
            className={`toggle ${autoRefresh ? 'active' : ''}`}
            type="button"
            onClick={() => setAutoRefresh((prev) => !prev)}
            disabled={!useBackend}
          >
            {autoRefresh ? 'Auto Refresh ON' : 'Auto Refresh OFF'}
          </button>
          <label className="interval">
            Interval
            <select
              value={refreshIntervalSec}
              onChange={handleIntervalChange}
              disabled={!useBackend}
            >
              {REFRESH_INTERVAL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}s
                </option>
              ))}
            </select>
          </label>
          <div className="status">
            <span>{status}</span>
            {error ? <span className="error">({error})</span> : null}
            {useBackend ? <span className="hint">views: {viewsStatus}</span> : null}
            {viewsStatus === 'error' && viewsError ? <span className="error">({viewsError})</span> : null}
            {dataErrorAt ? <span className="error">(err@ {dataErrorAt})</span> : null}
            {viewsErrorAt ? <span className="error">(views@ {viewsErrorAt})</span> : null}
            {lastRefreshAt ? <span className="hint">last: {lastRefreshAt}</span> : null}
            {lastViewsAt ? <span className="hint">views@ {lastViewsAt}</span> : null}
            {viewTypeLabel ? <span className="hint">{viewTypeLabel}</span> : null}
            {useBackend ? <span className="hint">{autoRefreshLabel}</span> : null}
            {lastErrorInfo ? <span className="error">last error: {lastErrorLabel}</span> : null}
            {lastErrorInfo ? (
              <button className="copy" type="button" onClick={handleCopyError}>
                Copy error
              </button>
            ) : null}
            {copyStatus === 'copied' ? <span className="hint">copied</span> : null}
            {copyStatus === 'failed' ? <span className="error">copy failed</span> : null}
          </div>
          <button className="refresh" type="button" onClick={handleRefresh} disabled={!canRefresh}>
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          {canRetryViews ? (
            <button className="retry" type="button" onClick={retryViews}>
              Retry views
            </button>
          ) : null}
          {canRetryData ? (
            <button className="retry" type="button" onClick={retryData}>
              Retry data
            </button>
          ) : null}
          <div className="param-group">
            <label htmlFor="sheetIdInput">
              Sheet
              <input
                id="sheetIdInput"
                name="sheetIdInput"
                value={sheetIdInput}
                onChange={(event) => setSheetIdInput(event.target.value)}
              />
            </label>
            {showViewIdInput ? (
              <label htmlFor="viewIdInput">
                View
                <input
                  id="viewIdInput"
                  name="viewIdInput"
                  value={viewIdInput}
                  onChange={(event) => setViewIdInput(event.target.value)}
                />
              </label>
            ) : null}
            {showViewSelect ? (
              <label htmlFor="viewSelect">
                View List
                <select
                  id="viewSelect"
                  name="viewSelect"
                  value={viewId}
                  onChange={handleViewSelect}
                  disabled={!useBackend || viewsStatus === 'loading'}
                >
                  <option value="">Default view</option>
                  {groupedViews.map((group) => (
                    <optgroup key={group.type} label={group.label}>
                      {group.views.map((view) => (
                        <option key={view.id} value={view.id}>
                          {view.name || view.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            ) : null}
            {showViewSelect ? (
              <label htmlFor="viewSearchInput">
                Search
                <input
                  id="viewSearchInput"
                  name="viewSearchInput"
                  className="view-search"
                  value={viewSearch}
                  onChange={handleViewSearch}
                  placeholder="name or id"
                />
              </label>
            ) : null}
            {showViewSelect ? (
              <div className="view-filters">
                {VIEW_TYPE_FILTER_OPTIONS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    className={`filter ${viewTypeFilter === filter.id ? 'active' : ''}`}
                    onClick={() => setViewTypeFilter(filter.id)}
                    disabled={!useBackend}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              className="apply"
              type="button"
              onClick={applyParams}
              disabled={!canApply}
            >
              Apply
            </button>
            <button className="reset" type="button" onClick={resetParams}>
              Reset
            </button>
            <button className="reset" type="button" onClick={clearState}>
              Clear State
            </button>
          </div>
        </div>
      </header>
      <div id={CONTAINER_ID} className="univer-container" />
    </div>
  )
}
