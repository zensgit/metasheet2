// JSON Schema type for configuration
export interface JSONSchema {
  type?: string | string[]
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  additionalProperties?: boolean | JSONSchema
  enum?: unknown[]
  default?: unknown
  description?: string
  [key: string]: unknown
}

// Event handler function type
export type EventHandler = (...args: unknown[]) => void | Promise<void>

// Plugin export function type - allows any function signature
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginFunction = (...args: any[]) => any

// Component type for UI frameworks (Vue/React)
export type UIComponent = unknown

// Metadata type for logging
export type LogMetadata = Record<string, unknown>

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
    schema: JSONSchema // JSON Schema
    defaults?: Record<string, unknown>
    ui?: Record<string, unknown> // UI hints for config
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
  exports: PluginExports
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
  debug: (message: string, meta?: LogMetadata) => void
  info: (message: string, meta?: LogMetadata) => void
  warn: (message: string, meta?: LogMetadata) => void
  error: (message: string, meta?: LogMetadata) => void
}

export interface PluginAPI {
  callPlugin: (pluginId: string, method: string, ...args: unknown[]) => Promise<unknown>
  executeHook: (hookName: string, data: unknown) => Promise<unknown[]>
  getPlugin: (pluginId: string) => {
    id: string
    name: string
    version: string
    status: string
  } | null
}

export interface PluginEvents {
  on: (event: string, handler: EventHandler) => void
  off: (event: string, handler: EventHandler) => void
  emit: (event: string, data: unknown) => void
  once: (event: string, handler: EventHandler) => void
}

export interface PluginStorage {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  list: () => Promise<string[]>
}

export interface PluginHook {
  pluginId: string
  hookName: string
  handler: string | EventHandler
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
  [key: string]: unknown
}

export interface PluginLifecycle {
  init?: (context: PluginContext) => Promise<void> | void
  enable?: () => Promise<void> | void
  disable?: () => Promise<void> | void
  cleanup?: () => Promise<void> | void
}

export interface PluginExports extends PluginLifecycle {
  [key: string]: PluginFunction | undefined
}

// Hook definitions
export interface HookContext {
  pluginId: string
  hookName: string
  data: unknown
  timestamp: Date
  cancelled?: boolean
  stopPropagation?: boolean
}

export interface HookResult {
  success: boolean
  data?: unknown
  error?: Error
  modified?: boolean
  _stopPropagation?: boolean
}

// Event types
export interface PluginEvent {
  type: string
  source: string
  data: unknown
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
  component: UIComponent // Vue/React component
  props?: Record<string, unknown>
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
  data: unknown
  timestamp: Date
  replyTo?: string
}

export interface PluginRequest extends PluginMessage {
  method: string
  params: unknown[]
}

export interface PluginResponse extends PluginMessage {
  result?: unknown
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
