import type { ErrorScope, LastErrorInfo } from './metaBackend'
import {
  filterViews,
  getViewTypeLabel,
  groupViews,
  type ViewOption,
  type ViewTypeFilter,
} from './viewFilters'

export type CopyStatus = 'idle' | 'copied' | 'failed'

export const REFRESH_INTERVAL_OPTIONS = [10, 30, 60] as const

interface DeriveMetaPageStateOptions {
  autoRefresh: boolean
  isRefreshing: boolean
  lastErrorInfo: LastErrorInfo | null
  pageVisible: boolean
  status: 'local' | 'loading' | 'ready' | 'error'
  useBackend: boolean
  viewId: string
  viewSearch: string
  views: ViewOption[]
  viewsStatus: 'idle' | 'loading' | 'ready' | 'error'
  viewTypeFilter: ViewTypeFilter
}

export interface ClipboardLike {
  writeText(text: string): Promise<void>
}

export function clearLastErrorScope(lastErrorInfo: LastErrorInfo | null, scope: ErrorScope) {
  return lastErrorInfo?.scope === scope ? null : lastErrorInfo
}

export function formatAutoRefreshLabel(autoRefresh: boolean, pageVisible: boolean) {
  if (!autoRefresh) {
    return 'auto: off'
  }

  return pageVisible ? 'auto: on' : 'auto: paused'
}

export function formatLastErrorLabel(lastErrorInfo: LastErrorInfo | null) {
  if (!lastErrorInfo) {
    return ''
  }

  return `${lastErrorInfo.scope}${lastErrorInfo.status ? ` HTTP ${lastErrorInfo.status}` : ''}${lastErrorInfo.url ? ` ${lastErrorInfo.url}` : ''} @ ${lastErrorInfo.at}`
}

export function deriveMetaPageState(options: DeriveMetaPageStateOptions) {
  const showViewSelect = options.useBackend && options.views.length > 0
  const filteredViews = filterViews(options.views, options.viewSearch, options.viewTypeFilter)
  const groupedViews = groupViews(filteredViews)
  const selectedView = options.views.find((view) => view.id === options.viewId) || null

  return {
    autoRefreshLabel: formatAutoRefreshLabel(options.autoRefresh, options.pageVisible),
    canRefresh: options.useBackend && !options.isRefreshing,
    canRetryData: options.status === 'error',
    canRetryViews: options.viewsStatus === 'error',
    filteredViews,
    groupedViews,
    lastErrorLabel: formatLastErrorLabel(options.lastErrorInfo),
    showViewIdInput: !showViewSelect,
    showViewSelect,
    viewTypeLabel: selectedView?.type ? `type: ${getViewTypeLabel(selectedView.type)}` : '',
  }
}

export async function copyLastErrorInfo(lastErrorInfo: LastErrorInfo | null, clipboard?: ClipboardLike | null) {
  if (!lastErrorInfo || !clipboard) {
    return 'idle' as const
  }

  try {
    await clipboard.writeText(JSON.stringify(lastErrorInfo, null, 2))
    return 'copied' as const
  } catch {
    return 'failed' as const
  }
}
