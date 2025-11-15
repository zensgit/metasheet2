// Lightweight DTO types for v2 web

export type PluginStatus = 'active' | 'inactive' | 'failed'

export interface ContributedView {
  id: string
  name: string
  component?: string
}

export interface PluginInfoDTO {
  name: string
  version?: string
  displayName?: string
  status: PluginStatus
  error?: string
  errorCode?: string
  lastAttempt?: string
  contributes?: {
    views?: ContributedView[]
  }
}

