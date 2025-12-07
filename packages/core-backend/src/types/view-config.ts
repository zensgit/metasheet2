/**
 * View Configuration Provider Interface
 *
 * This interface defines the contract for view-specific configuration providers.
 * Each view type plugin (gallery, calendar, kanban, etc.) should implement this
 * interface to handle their specific configuration storage and retrieval.
 *
 * This allows the core views router to delegate view-specific logic to plugins,
 * maintaining architectural purity and separation of concerns.
 */

import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Database pool interface - compatible with both pg.Pool and ConnectionPool wrapper
 * Uses minimal interface to support multiple pool implementations
 */
export interface DatabasePool {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>
}

/**
 * Base view configuration that all view types share
 */
export interface BaseViewConfig {
  viewId: string
  type: string
  createdAt?: Date
  updatedAt?: Date
}

/**
 * View configuration provider interface
 * Plugins implement this to handle their specific view config storage
 */
export interface ViewConfigProvider<T extends BaseViewConfig = BaseViewConfig> {
  /**
   * The view type this provider handles (e.g., 'gallery', 'calendar', 'kanban')
   */
  readonly viewType: string

  /**
   * Get view-specific configuration
   * @param viewId The view ID to get config for
   * @param pool Database connection pool
   * @returns The view-specific configuration or null if not found
   */
  getConfig(viewId: string, pool: DatabasePool): Promise<T | null>

  /**
   * Save/update view-specific configuration
   * @param viewId The view ID to save config for
   * @param config The configuration to save
   * @param pool Database connection pool
   */
  saveConfig(viewId: string, config: Partial<T>, pool: DatabasePool): Promise<void>

  /**
   * Delete view-specific configuration
   * @param viewId The view ID to delete config for
   * @param pool Database connection pool
   */
  deleteConfig(viewId: string, pool: DatabasePool): Promise<void>

  /**
   * Transform raw config from views router to view-specific format
   * @param rawConfig Raw configuration from request body
   * @returns Transformed configuration for storage
   */
  transformConfig?(rawConfig: Record<string, unknown>): Partial<T>

  /**
   * Transform stored config to API response format
   * @param storedConfig Configuration from database
   * @returns Configuration for API response
   */
  toApiFormat?(storedConfig: T): Record<string, unknown>
}

/**
 * Gallery-specific configuration
 */
export interface GalleryViewConfig extends BaseViewConfig {
  type: 'gallery'
  coverField?: string
  titleField?: string
  fieldsToShow?: string[]
  columns?: number
  cardSize?: 'small' | 'medium' | 'large'
}

/**
 * Calendar-specific configuration
 */
export interface CalendarViewConfig extends BaseViewConfig {
  type: 'calendar'
  dateField: string
  endDateField?: string
  titleField?: string
  defaultView?: 'month' | 'week' | 'day' | 'list'
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6
  colorRules?: CalendarColorRule[]
}

/**
 * Calendar color rule
 */
export interface CalendarColorRule {
  id: string
  fieldId?: string
  operator?: string
  value?: unknown
  color: string
  priority?: number
}

/**
 * Kanban-specific configuration (for reference)
 */
export interface KanbanViewConfig extends BaseViewConfig {
  type: 'kanban'
  groupField: string
  titleField?: string
  coverField?: string
  columns?: KanbanColumn[]
}

/**
 * Kanban column definition
 */
export interface KanbanColumn {
  id: string
  name: string
  color?: string
  wipLimit?: number
}

/**
 * Registry for view config providers
 */
export interface ViewConfigProviderRegistry {
  /**
   * Register a view config provider
   * @param provider The provider to register
   */
  register(provider: ViewConfigProvider): void

  /**
   * Unregister a view config provider
   * @param viewType The view type to unregister
   */
  unregister(viewType: string): void

  /**
   * Get a provider for a specific view type
   * @param viewType The view type
   * @returns The provider or undefined if not found
   */
  get(viewType: string): ViewConfigProvider | undefined

  /**
   * Check if a provider is registered for a view type
   * @param viewType The view type
   */
  has(viewType: string): boolean

  /**
   * Get all registered view types
   */
  getRegisteredTypes(): string[]
}

/**
 * Factory function type for creating view config providers
 */
export type ViewConfigProviderFactory<T extends BaseViewConfig = BaseViewConfig> = () => ViewConfigProvider<T>
