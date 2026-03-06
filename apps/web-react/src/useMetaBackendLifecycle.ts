import { useCallback, useEffect, useRef, useState } from 'react'
import type { IWorkbookData } from '@univerjs/core'
import {
  bootstrapMetaBackendSession,
  refreshMetaBackendState,
  type MetaBackendClientLike,
} from './metaBackendController'
import type { ErrorScope } from './metaBackend'
import { clearLastErrorScope } from './metaPageState'
import {
  applyBootstrapFailureState,
  applyMetaBackendLoadingState,
  applyMetaBackendSnapshot,
  clearMetaBackendErrors,
  createMetaBackendState,
  toMetaBackendSnapshot,
  type MetaBackendState,
} from './metaBackendState'
import type { MetaField, MetaRecord } from './metaWorkbook'

interface RefreshBackendOptions {
  quiet?: boolean
  refreshViews?: boolean
}

interface UseMetaBackendLifecycleOptions {
  autoRefresh: boolean
  buildWorkbook: (fields: MetaField[], rows: MetaRecord[]) => IWorkbookData
  client: MetaBackendClientLike
  fallbackWorkbook: IWorkbookData
  refreshIntervalSec: number
  sheetId: string
  useBackend: boolean
}

export function useMetaBackendLifecycle(options: UseMetaBackendLifecycleOptions) {
  const [state, setState] = useState<MetaBackendState>(() => createMetaBackendState(options.fallbackWorkbook))
  const [pageVisible, setPageVisible] = useState(true)
  const refreshInFlightRef = useRef(false)
  const stateRef = useRef(state)
  const lastSheetIdRef = useRef<string | null>(null)
  const tokenBootstrappedRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const clearLastErrorForScope = useCallback((scope: ErrorScope) => {
    setState((prev) => ({
      ...prev,
      lastErrorInfo: clearLastErrorScope(prev.lastErrorInfo, scope),
    }))
  }, [])

  const clearBackendErrors = useCallback(() => {
    setState((prev) => clearMetaBackendErrors(prev))
  }, [])

  const refreshBackend = useCallback(
    async ({ refreshViews = true, quiet = false }: RefreshBackendOptions = {}) => {
      if (!options.useBackend || refreshInFlightRef.current) return

      refreshInFlightRef.current = true
      setState((prev) => applyMetaBackendLoadingState(prev, { quiet, refreshViews }))

      try {
        const nextSnapshot = await refreshMetaBackendState({
          buildWorkbook: options.buildWorkbook,
          client: options.client,
          current: toMetaBackendSnapshot(stateRef.current),
          fallbackWorkbook: options.fallbackWorkbook,
          refreshViews,
        })

        setState((prev) => applyMetaBackendSnapshot(prev, nextSnapshot))
      } finally {
        refreshInFlightRef.current = false
        setState((prev) => ({
          ...prev,
          isRefreshing: false,
        }))
      }
    },
    [options.buildWorkbook, options.client, options.fallbackWorkbook, options.useBackend],
  )

  const handleRefresh = useCallback(() => {
    refreshBackend({ refreshViews: true })
  }, [refreshBackend])

  const retryViews = useCallback(() => {
    refreshBackend({ refreshViews: true })
  }, [refreshBackend])

  const retryData = useCallback(() => {
    refreshBackend({ refreshViews: false })
  }, [refreshBackend])

  useEffect(() => {
    let cancelled = false

    if (!options.useBackend) {
      tokenBootstrappedRef.current = false
      setState(createMetaBackendState(options.fallbackWorkbook))
      return () => {
        cancelled = true
      }
    }

    const shouldRefreshViews = lastSheetIdRef.current !== options.sheetId
    lastSheetIdRef.current = options.sheetId

    const run = async () => {
      const bootstrap = await bootstrapMetaBackendSession({
        client: options.client,
        tokenBootstrapped: tokenBootstrappedRef.current,
      })

      if (!bootstrap.ok) {
        if (cancelled) return
        setState((prev) => applyBootstrapFailureState(prev, bootstrap))
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
  }, [
    clearLastErrorForScope,
    options.client,
    options.fallbackWorkbook,
    options.sheetId,
    options.useBackend,
    refreshBackend,
  ])

  useEffect(() => {
    if (!options.useBackend || !options.autoRefresh) return

    const timer = window.setInterval(() => {
      if (!document.hidden) {
        refreshBackend({ refreshViews: false, quiet: true })
      }
    }, options.refreshIntervalSec * 1000)

    return () => window.clearInterval(timer)
  }, [options.autoRefresh, options.refreshIntervalSec, options.useBackend, refreshBackend])

  useEffect(() => {
    const update = () => {
      setPageVisible(!document.hidden)
    }

    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return {
    clearBackendErrors,
    handleRefresh,
    pageVisible,
    refreshBackend,
    retryData,
    retryViews,
    state,
  }
}
