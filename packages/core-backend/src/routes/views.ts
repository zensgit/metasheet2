/**
 * Views Router
 *
 * Generic views API that delegates view-specific configuration handling
 * to registered ViewConfigProvider plugins. This maintains architectural
 * purity by keeping view-specific logic in their respective plugins.
 *
 * View types (gallery, calendar, kanban, etc.) register their config providers
 * via the 'view:configProvider:register' event or directly through the registry.
 */

import { Router } from 'express'
import { poolManager } from '../integration/db/connection-pool'
import { getViewConfigRegistry } from '../core/view-config-registry'
import { getViewDataRegistry } from '../core/view-data-registry'
import { getDefaultViewDataProvider } from '../core/default-view-data-provider'
import type { ViewConfigProvider, DatabasePool } from '../types/view-config'
import type { ViewDataProvider, ViewDataContext, ViewDataQueryOptions, FilterCondition, SortOptions } from '../types/view-data'
import { eventBus } from '../core/EventBusService'
import { Logger } from '../core/logger'

const logger = new Logger('ViewsRouter')

// Initialize event listener for provider registration
let eventListenerInitialized = false

/**
 * Register a view config provider directly (for synchronous registration)
 * Can be called by plugin system or during bootstrap
 */
export function registerViewConfigProviderSync(provider: ViewConfigProvider): void {
  const registry = getViewConfigRegistry()
  registry.register(provider)
  logger.info(`View config provider registered: ${provider.viewType}`)
}

/**
 * Initialize event listeners for provider registration
 * Listens for 'view:configProvider:register' events from plugins
 */
function initializeEventListeners(): void {
  if (eventListenerInitialized) return
  eventListenerInitialized = true

  // Listen for config provider registration events from plugins
  eventBus.on('view:configProvider:register', (data: { viewType: string; provider: ViewConfigProvider }) => {
    if (data && data.provider) {
      const configRegistry = getViewConfigRegistry()
      configRegistry.register(data.provider)
      logger.info(`View config provider registered via event: ${data.viewType}`)
    }
  })

  // Listen for data provider registration events from plugins
  eventBus.on('view:dataProvider:register', (data: { viewType: string; provider: ViewDataProvider }) => {
    if (data && data.provider) {
      const dataRegistry = getViewDataRegistry()
      dataRegistry.register(data.provider)
      logger.info(`View data provider registered via event: ${data.viewType}`)
    }
  })

  logger.debug('View provider event listeners initialized')
}

export function viewsRouter() {
  const router = Router()
  const registry = getViewConfigRegistry()

  initializeEventListeners()

  /**
   * Get view configuration
   * Delegates to registered ViewConfigProvider for view-specific config
   */
  router.get('/:viewId/config', async (req, res) => {
    try {
      const { viewId } = req.params
      const pool = poolManager.get()

      // Get base view
      const viewResult = await pool.query(
        'SELECT * FROM views WHERE id = $1 AND deleted_at IS NULL',
        [viewId]
      )

      if (viewResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      const view = viewResult.rows[0]
      const config = typeof view.config === 'string' ? JSON.parse(view.config) : view.config || {}

      // Get view-specific config from registered provider
      const viewType = view.type as string
      const provider = registry.get(viewType)
      let specificConfig: Record<string, unknown> = {}

      if (provider) {
        // Delegate to plugin's config provider
        const pluginConfig = await provider.getConfig(viewId, pool)
        if (pluginConfig && provider.toApiFormat) {
          specificConfig = provider.toApiFormat(pluginConfig)
        } else if (pluginConfig) {
          specificConfig = pluginConfig as unknown as Record<string, unknown>
        }
      } else {
        // Fallback for unregistered view types - use legacy inline handling
        // This maintains backward compatibility during migration
        specificConfig = await getLegacyViewConfig(viewId, viewType, pool)
      }

      res.json({
        success: true,
        data: {
          ...view,
          ...config,
          ...specificConfig
        }
      })
    } catch (err) {
      console.error('Failed to get view config:', err)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  /**
   * Update view configuration
   * Delegates to registered ViewConfigProvider for view-specific config
   */
  router.put('/:viewId/config', async (req, res) => {
    try {
      const { viewId } = req.params
      const config = req.body
      const pool = poolManager.get()

      // Get view type first
      const viewResult = await pool.query(
        'SELECT type FROM views WHERE id = $1 AND deleted_at IS NULL',
        [viewId]
      )

      if (viewResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      const viewType = (config.type || viewResult.rows[0].type) as string

      // Update base view config
      await pool.query(
        'UPDATE views SET config = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(config), viewId]
      )

      // Update view-specific config via registered provider
      const provider = registry.get(viewType)

      if (provider) {
        // Transform and delegate to plugin's config provider
        const transformedConfig = provider.transformConfig
          ? provider.transformConfig(config)
          : config
        await provider.saveConfig(viewId, transformedConfig, pool)
      } else {
        // Fallback for unregistered view types - use legacy inline handling
        await saveLegacyViewConfig(viewId, viewType, config, pool)
      }

      res.json({ success: true })
    } catch (err) {
      console.error('Failed to update view config:', err)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  /**
   * Get view data with real database integration
   * Delegates to registered ViewDataProvider for view-specific data handling
   */
  router.get('/:viewId/data', async (req, res) => {
    try {
      const { viewId } = req.params
      const {
        page = '1',
        pageSize = '50',
        sort,
        order,
        search,
        searchFields,
        groupBy,
        ...filterParams
      } = req.query

      const pool = poolManager.get()
      const dataRegistry = getViewDataRegistry()

      // Get view info to determine type and table_id
      const viewResult = await pool.query(
        'SELECT id, type, table_id, config, filters, sorting, visible_fields FROM views WHERE id = $1 AND deleted_at IS NULL',
        [viewId]
      )

      if (viewResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      const view = viewResult.rows[0]
      const viewType = view.type as string
      const tableId = view.table_id as string

      // Build view context
      const viewConfig = typeof view.config === 'string' ? JSON.parse(view.config) : view.config || {}
      const viewFilters = typeof view.filters === 'string' ? JSON.parse(view.filters) : view.filters || []
      const viewSorting = typeof view.sorting === 'string' ? JSON.parse(view.sorting) : view.sorting || []
      const viewVisibleFields = typeof view.visible_fields === 'string'
        ? JSON.parse(view.visible_fields)
        : view.visible_fields || []

      const context: ViewDataContext = {
        viewId,
        viewType,
        tableId,
        config: viewConfig,
        filters: viewFilters as FilterCondition[],
        sorting: viewSorting as SortOptions[],
        visibleFields: viewVisibleFields as string[]
      }

      // Build query options from request params
      const queryOptions: ViewDataQueryOptions = {
        pagination: {
          page: Number(page),
          pageSize: Number(pageSize)
        },
        sorting: buildSortingFromParams(sort as string | undefined, order as string | undefined, viewSorting),
        filters: buildFiltersFromParams(filterParams),
        search: search as string | undefined,
        searchFields: searchFields ? (searchFields as string).split(',') : undefined,
        groupBy: groupBy as string | undefined,
        includeMetadata: true
      }

      // Get the appropriate data provider
      const dataProvider = dataRegistry.get(viewType) || getDefaultViewDataProvider()

      // Fetch data using the provider
      let result
      if (queryOptions.groupBy && dataProvider.getGroupedData) {
        result = await dataProvider.getGroupedData(context, queryOptions.groupBy, queryOptions, pool)
      } else {
        result = await dataProvider.getData(context, queryOptions, pool)
      }

      res.json({
        success: true,
        data: result.data,
        meta: result.meta,
        groups: result.groups
      })
    } catch (err) {
      logger.error('Failed to get view data', err instanceof Error ? err : undefined)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  /**
   * Save view state (per-user preferences)
   */
  router.post('/:viewId/state', async (req, res) => {
    try {
      const { viewId } = req.params
      const state = req.body
      const userId = (req as unknown as { user?: { id: number } }).user?.id || 0

      const pool = poolManager.get()
      await pool.query(
        `INSERT INTO view_states (view_id, user_id, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (view_id, user_id) DO UPDATE SET
           state = EXCLUDED.state,
           updated_at = NOW()`,
        [viewId, userId, JSON.stringify(state)]
      )

      res.json({ success: true })
    } catch (err) {
      console.error('Failed to save view state:', err)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  /**
   * Get view state (per-user preferences)
   */
  router.get('/:viewId/state', async (req, res) => {
    try {
      const { viewId } = req.params
      const userId = (req as unknown as { user?: { id: number } }).user?.id || 0

      const pool = poolManager.get()
      const result = await pool.query(
        'SELECT state FROM view_states WHERE view_id = $1 AND user_id = $2',
        [viewId, userId]
      )

      if (result.rows.length > 0) {
        res.json(result.rows[0].state)
      } else {
        res.json({})
      }
    } catch (err) {
      console.error('Failed to get view state:', err)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  /**
   * Delete view configuration (cleanup)
   */
  router.delete('/:viewId/config', async (req, res) => {
    try {
      const { viewId } = req.params
      const pool = poolManager.get()

      // Get view type first
      const viewResult = await pool.query(
        'SELECT type FROM views WHERE id = $1',
        [viewId]
      )

      if (viewResult.rows.length > 0) {
        const viewType = viewResult.rows[0].type as string
        const provider = registry.get(viewType)

        if (provider) {
          await provider.deleteConfig(viewId, pool)
        } else {
          // Fallback legacy cleanup
          await deleteLegacyViewConfig(viewId, viewType, pool)
        }
      }

      res.json({ success: true })
    } catch (err) {
      console.error('Failed to delete view config:', err)
      res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  return router
}

// ============================================================
// Legacy Fallback Functions (for backward compatibility)
// These will be deprecated once all view plugins are migrated
// ============================================================

async function getLegacyViewConfig(
  viewId: string,
  viewType: string,
  pool: DatabasePool
): Promise<Record<string, unknown>> {
  if (viewType === 'kanban') {
    const result = await pool.query(
      'SELECT * FROM kanban_configs WHERE view_id = $1',
      [viewId]
    )
    if (result.rows.length > 0) {
      return result.rows[0] as Record<string, unknown>
    }
  } else if (viewType === 'gallery') {
    // Legacy gallery handling - will be removed when plugin is loaded
    const result = await pool.query(
      'SELECT * FROM gallery_configs WHERE view_id = $1',
      [viewId]
    )
    if (result.rows.length > 0) {
      const row = result.rows[0] as {
        title_field?: string
        cover_field?: string
        fields_to_show?: string[]
        columns?: number
        card_size?: string
      }
      return {
        cardTemplate: {
          titleField: row.title_field,
          imageField: row.cover_field,
          contentFields: row.fields_to_show || []
        },
        layout: {
          columns: row.columns,
          cardSize: row.card_size
        }
      }
    }
  } else if (viewType === 'calendar') {
    // Legacy calendar handling - will be removed when plugin is loaded
    const result = await pool.query(
      'SELECT * FROM calendar_configs WHERE view_id = $1',
      [viewId]
    )
    if (result.rows.length > 0) {
      const row = result.rows[0] as {
        default_view?: string
        week_starts_on?: number
        title_field?: string
        date_field?: string
        end_date_field?: string
        color_rules?: unknown[]
      }
      return {
        defaultView: row.default_view,
        weekStartsOn: row.week_starts_on,
        fields: {
          title: row.title_field,
          startDate: row.date_field,
          endDate: row.end_date_field
        },
        colorRules: row.color_rules || []
      }
    }
  }

  return {}
}

async function saveLegacyViewConfig(
  viewId: string,
  viewType: string,
  config: Record<string, unknown>,
  pool: DatabasePool
): Promise<void> {
  if (viewType === 'gallery') {
    const cardTemplate = (config.cardTemplate || {}) as {
      imageField?: string
      titleField?: string
      contentFields?: string[]
    }
    const layout = (config.layout || {}) as {
      columns?: number
      cardSize?: string
    }

    await pool.query(
      `INSERT INTO gallery_configs (view_id, cover_field, title_field, fields_to_show, columns, card_size, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (view_id) DO UPDATE SET
         cover_field = EXCLUDED.cover_field,
         title_field = EXCLUDED.title_field,
         fields_to_show = EXCLUDED.fields_to_show,
         columns = EXCLUDED.columns,
         card_size = EXCLUDED.card_size,
         updated_at = NOW()`,
      [
        viewId,
        cardTemplate.imageField,
        cardTemplate.titleField,
        JSON.stringify(cardTemplate.contentFields || []),
        layout.columns,
        layout.cardSize
      ]
    )
  } else if (viewType === 'calendar') {
    const fields = (config.fields || {}) as {
      startDate?: string
      endDate?: string
      title?: string
    }

    await pool.query(
      `INSERT INTO calendar_configs (view_id, date_field, end_date_field, title_field, default_view, week_starts_on, color_rules, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (view_id) DO UPDATE SET
         date_field = EXCLUDED.date_field,
         end_date_field = EXCLUDED.end_date_field,
         title_field = EXCLUDED.title_field,
         default_view = EXCLUDED.default_view,
         week_starts_on = EXCLUDED.week_starts_on,
         color_rules = EXCLUDED.color_rules,
         updated_at = NOW()`,
      [
        viewId,
        fields.startDate,
        fields.endDate,
        fields.title,
        config.defaultView,
        config.weekStartsOn,
        JSON.stringify(config.colorRules || [])
      ]
    )
  }
}

async function deleteLegacyViewConfig(
  viewId: string,
  viewType: string,
  pool: DatabasePool
): Promise<void> {
  if (viewType === 'gallery') {
    await pool.query('DELETE FROM gallery_configs WHERE view_id = $1', [viewId])
  } else if (viewType === 'calendar') {
    await pool.query('DELETE FROM calendar_configs WHERE view_id = $1', [viewId])
  } else if (viewType === 'kanban') {
    await pool.query('DELETE FROM kanban_configs WHERE view_id = $1', [viewId])
  }
}

// ============================================================
// Helper Functions for Data Query Building
// ============================================================

/**
 * Build sorting configuration from request params
 */
function buildSortingFromParams(
  sort: string | undefined,
  order: string | undefined,
  viewSorting: unknown[]
): SortOptions[] {
  // Use request params if provided
  if (sort) {
    const fields = sort.split(',')
    const directions = order ? order.split(',') : []
    return fields.map((field, i) => ({
      field: field.trim(),
      direction: (directions[i]?.toLowerCase() === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc'
    }))
  }

  // Fallback to view's saved sorting
  if (viewSorting && Array.isArray(viewSorting) && viewSorting.length > 0) {
    return viewSorting as SortOptions[]
  }

  return []
}

/**
 * Build filters from query params
 * Supports formats like:
 *   - filter_status=active (simple equality)
 *   - filter_status_eq=active (explicit operator)
 *   - filter_price_gt=100 (greater than)
 *   - filter_date_between=2024-01-01,2024-12-31 (range)
 */
function buildFiltersFromParams(
  params: Record<string, unknown>
): FilterCondition[] {
  const filters: FilterCondition[] = []
  const operatorMap: Record<string, FilterCondition['operator']> = {
    eq: 'eq',
    ne: 'ne',
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte',
    like: 'like',
    ilike: 'ilike',
    in: 'in',
    nin: 'nin',
    between: 'between',
    isnull: 'isNull',
    isnotnull: 'isNotNull'
  }

  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith('filter_') || value === undefined || value === '') {
      continue
    }

    const filterKey = key.substring(7) // Remove 'filter_' prefix

    // Check for operator suffix (e.g., status_eq, price_gt)
    const parts = filterKey.split('_')
    const lastPart = parts[parts.length - 1].toLowerCase()

    let field: string
    let operator: FilterCondition['operator']
    let filterValue: unknown = value

    if (operatorMap[lastPart]) {
      // Operator is explicit in key
      operator = operatorMap[lastPart]
      field = parts.slice(0, -1).join('_')
    } else {
      // Default to equality
      operator = 'eq'
      field = filterKey
    }

    // Parse value based on operator
    if (operator === 'in' || operator === 'nin') {
      filterValue = String(value).split(',').map(v => v.trim())
    } else if (operator === 'between') {
      filterValue = String(value).split(',').map(v => v.trim())
    } else if (operator === 'isNull' || operator === 'isNotNull') {
      filterValue = true
    }

    filters.push({ field, operator, value: filterValue })
  }

  return filters
}

/**
 * Register a view data provider (exported for direct registration)
 */
export function registerViewDataProviderSync(provider: ViewDataProvider): void {
  const dataRegistry = getViewDataRegistry()
  dataRegistry.register(provider)
  logger.info(`View data provider registered: ${provider.viewType}`)
}
