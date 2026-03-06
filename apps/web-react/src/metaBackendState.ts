import type { IWorkbookData } from '@univerjs/core'
import { createLocalMetaBackendState, type MetaBackendStateSnapshot } from './metaBackendController'
import type { LastErrorInfo } from './metaBackend'

export interface MetaBackendState extends MetaBackendStateSnapshot {
  isRefreshing: boolean
}

interface ApplyLoadingStateOptions {
  quiet?: boolean
  refreshViews?: boolean
}

interface BootstrapFailureState {
  error: string
  lastErrorInfo: LastErrorInfo
  status: 'error'
  viewsError: string
  viewsStatus: 'error'
}

export function createMetaBackendState(fallbackWorkbook: IWorkbookData): MetaBackendState {
  return {
    ...createLocalMetaBackendState(fallbackWorkbook),
    isRefreshing: false,
  }
}

export function toMetaBackendSnapshot(state: MetaBackendState): MetaBackendStateSnapshot {
  const { isRefreshing: _isRefreshing, ...snapshot } = state
  return snapshot
}

export function applyMetaBackendLoadingState(
  state: MetaBackendState,
  options: ApplyLoadingStateOptions,
): MetaBackendState {
  const next: MetaBackendState = {
    ...state,
    isRefreshing: true,
  }

  if (!options.quiet) {
    next.status = 'loading'
    next.error = null
  }

  if (options.refreshViews) {
    next.viewsStatus = 'loading'
    next.viewsError = null
  }

  return next
}

export function applyMetaBackendSnapshot(
  state: MetaBackendState,
  snapshot: MetaBackendStateSnapshot,
): MetaBackendState {
  return {
    ...state,
    ...snapshot,
    isRefreshing: false,
  }
}

export function applyBootstrapFailureState(
  state: MetaBackendState,
  failure: BootstrapFailureState,
): MetaBackendState {
  return {
    ...state,
    error: failure.error,
    isRefreshing: false,
    lastErrorInfo: failure.lastErrorInfo,
    status: failure.status,
    viewsError: failure.viewsError,
    viewsStatus: failure.viewsStatus,
  }
}

export function clearMetaBackendErrors(state: MetaBackendState): MetaBackendState {
  return {
    ...state,
    dataErrorAt: null,
    error: null,
    lastErrorInfo: null,
    viewsError: null,
    viewsErrorAt: null,
  }
}
