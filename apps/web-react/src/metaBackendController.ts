import type { IWorkbookData } from '@univerjs/core'
import { buildLastErrorInfo, type LastErrorInfo } from './metaBackend'
import type { MetaField, MetaRecord } from './metaWorkbook'
import type { ViewOption } from './viewFilters'

export type MetaPageStatus = 'local' | 'loading' | 'ready' | 'error'
export type MetaViewsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MetaBackendStateSnapshot {
  status: MetaPageStatus
  error: string | null
  lastErrorInfo: LastErrorInfo | null
  views: ViewOption[]
  viewsStatus: MetaViewsStatus
  viewsError: string | null
  viewsErrorAt: string | null
  lastViewsAt: string | null
  lastRefreshAt: string | null
  dataErrorAt: string | null
  workbookData: IWorkbookData
}

export interface MetaBackendClientLike {
  ensureDevToken(forceRefresh?: boolean): Promise<string>
  fetchViews(): Promise<ViewOption[]>
  fetchMetaView(): Promise<{
    data?: {
      fields: MetaField[]
      rows: MetaRecord[]
    }
  }>
}

interface RefreshMetaBackendStateOptions {
  client: MetaBackendClientLike
  current: MetaBackendStateSnapshot
  refreshViews?: boolean
  fallbackWorkbook: IWorkbookData
  buildWorkbook: (fields: MetaField[], rows: MetaRecord[]) => IWorkbookData
  now?: Date
}

interface BootstrapMetaBackendOptions {
  client: MetaBackendClientLike
  tokenBootstrapped: boolean
  now?: Date
}

export function createLocalMetaBackendState(fallbackWorkbook: IWorkbookData): MetaBackendStateSnapshot {
  return {
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
    workbookData: fallbackWorkbook,
  }
}

export async function bootstrapMetaBackendSession(options: BootstrapMetaBackendOptions) {
  if (options.tokenBootstrapped) {
    return {
      ok: true as const,
      tokenBootstrapped: true,
      clearTokenError: false,
    }
  }

  try {
    await options.client.ensureDevToken(true)

    return {
      ok: true as const,
      tokenBootstrapped: true,
      clearTokenError: true,
    }
  } catch (error) {
    const info = buildLastErrorInfo('token', error, options.now)

    return {
      ok: false as const,
      tokenBootstrapped: false,
      status: 'error' as const,
      error: info.message,
      lastErrorInfo: info,
      viewsStatus: 'error' as const,
      viewsError: info.message,
      isRefreshing: false,
    }
  }
}

export async function refreshMetaBackendState(options: RefreshMetaBackendStateOptions): Promise<MetaBackendStateSnapshot> {
  const next: MetaBackendStateSnapshot = {
    ...options.current,
  }
  const nowLabel = (options.now ?? new Date()).toLocaleTimeString()

  if (options.refreshViews) {
    try {
      next.views = await options.client.fetchViews()
      next.viewsStatus = 'ready'
      next.viewsError = null
      next.viewsErrorAt = null
      next.lastViewsAt = nowLabel
      if (next.lastErrorInfo?.scope === 'views') {
        next.lastErrorInfo = null
      }
    } catch (error) {
      const info = buildLastErrorInfo('views', error, options.now)
      next.lastErrorInfo = info
      next.viewsStatus = 'error'
      next.viewsError = info.message
      next.viewsErrorAt = info.at
    }
  }

  try {
    const payload = await options.client.fetchMetaView()
    const data = payload.data
    if (!data) {
      throw new Error('Backend response missing data')
    }

    next.workbookData = options.buildWorkbook(data.fields, data.rows)
    next.status = 'ready'
    next.error = null
    next.dataErrorAt = null
    next.lastRefreshAt = nowLabel
    if (next.lastErrorInfo?.scope === 'data') {
      next.lastErrorInfo = null
    }
  } catch (error) {
    const info = buildLastErrorInfo('data', error, options.now)
    next.lastErrorInfo = info
    next.status = 'error'
    next.error = info.message
    next.dataErrorAt = info.at
    next.workbookData = options.fallbackWorkbook
  }

  return next
}
