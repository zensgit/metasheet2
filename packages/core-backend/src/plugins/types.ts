export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author: string | {
    name: string
    email?: string
    url?: string
  }
  license?: string
  main?: string // Entry point, default: index.js
  api_version?: number // Plugin API version

  // Dependencies
  dependencies?: Record<string, string> // Other plugins
  modules?: string[] // NPM modules

  // Permissions
  permissions?: {
    apis?: string[] // API permissions
    modules?: string[] // Allowed Node modules
    resources?: string[] // Resource access
  }

  // Hooks
  hooks?: Record<string, {
    handler?: string
    priority?: number
    required?: boolean
  }>

  // UI Extensions
  ui?: {
    panels?: Array<{
      id: string
      title: string
      icon?: string
      component: string
      position?: 'left' | 'right' | 'bottom' | 'modal'
    }>
    menuItems?: Array<{
      id: string
      label: string
      icon?: string
      parent?: string
      action: string
    }>
    toolbarButtons?: Array<{
      id: string
      label: string
      icon?: string
      action: string
      position?: number
    }>
  }

  // Configuration schema
  config?: {
    schema: Record<string, any> // JSON Schema
    defaults?: Record<string, any>
    ui?: Record<string, any> // UI hints for config
  }

  // Assets
  assets?: {
    styles?: string[]
    scripts?: string[]
    images?: string[]
  }

  // Metadata
  homepage?: string
  repository?: string | {
    type: string
    url: string
  }
  bugs?: string | {
    url: string
    email?: string
  }
  keywords?: string[]
  categories?: string[]

  // Runtime options
  singleton?: boolean // Only one instance allowed
  autoEnable?: boolean // Auto-enable on load
  hotReload?: boolean // Support hot reload
  background?: boolean // Run in background thread
}

export interface PluginInstance {
  id: string
  name: string
  version: string
  manifest: PluginManifest
  path: string
  status: 'loading' | 'active' | 'disabled' | 'error'
  loadedAt: Date
  context: PluginContext
  exports: any
  error?: Error
  metrics?: PluginMetrics
}

export interface PluginContext {
  id: string
  name: string
  version: string
  dataDir: string
  logger: PluginLogger
  api: PluginAPI
  events: PluginEvents
  storage: PluginStorage
}

export interface PluginLogger {
  debug: (message: string, meta?: any) => void
  info: (message: string, meta?: any) => void
  warn: (message: string, meta?: any) => void
  error: (message: string, meta?: any) => void
}

export interface PluginAPI {
  callPlugin: (pluginId: string, method: string, ...args: any[]) => Promise<any>
  executeHook: (hookName: string, data: any) => Promise<any[]>
  getPlugin: (pluginId: string) => {
    id: string
    name: string
    version: string
    status: string
  } | null
}

export interface PluginEvents {
  on: (event: string, handler: Function) => void
  off: (event: string, handler: Function) => void
  emit: (event: string, data: any) => void
  once: (event: string, handler: Function) => void
}

export interface PluginStorage {
  get: (key: string) => Promise<any>
  set: (key: string, value: any) => Promise<void>
  delete: (key: string) => Promise<void>
  list: () => Promise<string[]>
}

export interface PluginHook {
  pluginId: string
  hookName: string
  handler: string | Function
  priority?: number
  required?: boolean
}

export interface PluginMetrics {
  executionCount: number
  totalExecutionTime: number
  averageExecutionTime: number
  lastExecutionTime: number
  errorCount: number
  memoryUsage?: number
  cpuUsage?: number
}

export interface PluginConfig {
  [key: string]: any
}

export interface PluginLifecycle {
  init?: (context: PluginContext) => Promise<void> | void
  enable?: () => Promise<void> | void
  disable?: () => Promise<void> | void
  cleanup?: () => Promise<void> | void
}

export interface PluginExports extends PluginLifecycle {
  [key: string]: any
}

// Hook definitions
export interface HookContext {
  pluginId: string
  hookName: string
  data: any
  timestamp: Date
  cancelled?: boolean
  stopPropagation?: boolean
}

export interface HookResult {
  success: boolean
  data?: any
  error?: Error
  modified?: boolean
  _stopPropagation?: boolean
}

// Event types
export interface PluginEvent {
  type: string
  source: string
  data: any
  timestamp: Date
}

// Permission types
export type PluginPermission =
  | 'api:read'
  | 'api:write'
  | 'database:read'
  | 'database:write'
  | 'file:read'
  | 'file:write'
  | 'network:http'
  | 'network:websocket'
  | 'system:info'
  | 'system:execute'
  | 'plugin:communicate'
  | 'ui:modify'
  | 'workflow:execute'

// UI Extension types
export interface UIPanel {
  id: string
  pluginId: string
  title: string
  icon?: string
  component: any // Vue/React component
  props?: Record<string, any>
  position: 'left' | 'right' | 'bottom' | 'modal'
  visible: boolean
}

export interface UIMenuItem {
  id: string
  pluginId: string
  label: string
  icon?: string
  action: () => void
  parent?: string
  order?: number
  visible: boolean
  enabled: boolean
}

export interface UIToolbarButton {
  id: string
  pluginId: string
  label: string
  icon?: string
  tooltip?: string
  action: () => void
  position?: number
  visible: boolean
  enabled: boolean
}

// Plugin communication
export interface PluginMessage {
  from: string
  to: string
  type: string
  data: any
  timestamp: Date
  replyTo?: string
}

export interface PluginRequest extends PluginMessage {
  method: string
  params: any[]
}

export interface PluginResponse extends PluginMessage {
  result?: any
  error?: Error
}

// Plugin registry entry
export interface PluginRegistryEntry {
  id: string
  name: string
  version: string
  description?: string
  author: string | { name: string; email?: string }
  homepage?: string
  downloads?: number
  rating?: number
  verified?: boolean
  tags?: string[]
  publishedAt?: Date
  updatedAt?: Date
}