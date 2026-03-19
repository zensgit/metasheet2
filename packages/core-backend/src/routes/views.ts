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

type MetaViewRow = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo: Record<string, unknown>
  sortInfo: Record<string, unknown>
  groupInfo: Record<string, unknown>
  hiddenFieldIds: string[]
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
}

type MetaSheetRow = {
  id: string
  name: string
  description: string | null
}

type MetaFieldRow = {
  id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

type MetaViewType = 'grid' | 'form' | 'gallery' | 'calendar'

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
        const metaConfig = await buildMetaViewConfig(viewId, pool)
        if (metaConfig) {
          return res.json({ success: true, data: metaConfig })
        }
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
        const metaData = await buildMetaViewData(viewId, Number(page), Number(pageSize), pool)
        if (metaData) {
          return res.json(metaData)
        }
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

  router.post('/:viewId/submit', async (req, res) => {
    try {
      const { viewId } = req.params
      const pool = poolManager.get()
      const metaView = await loadMetaView(viewId, pool)
      if (!metaView) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      return res.redirect(307, `/api/multitable/views/${viewId}/submit`)
    } catch (err) {
      console.error('Failed to submit view form:', err)
      return res.status(500).json({ success: false, error: 'Internal server error' })
    }
  })

  router.get('/:viewId/responses', async (req, res) => {
    try {
      const { viewId } = req.params
      const page = Number(req.query.page ?? 1)
      const pageSize = Number(req.query.pageSize ?? 20)
      const pool = poolManager.get()
      const responses = await buildMetaFormResponses(viewId, page, pageSize, pool)
      if (!responses) {
        return res.status(404).json({ success: false, error: 'View not found' })
      }

      return res.json(responses)
    } catch (err) {
      console.error('Failed to get form responses:', err)
      return res.status(500).json({ success: false, error: 'Internal server error' })
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    try {
      return normalizeJsonArray(JSON.parse(value))
    } catch {
      return []
    }
  }
  return []
}

function extractSelectOptions(property: unknown): Array<{ value: string; label: string }> {
  const config = normalizeJson(property)
  const raw = Array.isArray(config.options) ? config.options : []
  return raw
    .map((option) => {
      if (typeof option === 'string') {
        return { value: option, label: option }
      }
      if (isPlainObject(option) && typeof option.value === 'string') {
        return { value: option.value, label: typeof option.label === 'string' ? option.label : option.value }
      }
      return null
    })
    .filter((option): option is { value: string; label: string } => !!option)
}

function parseLinkFieldConfig(property: unknown): { foreignSheetId: string; limitSingleRecord: boolean } | null {
  const config = normalizeJson(property)
  const foreignSheetId = config.foreignDatasheetId ?? config.foreignSheetId ?? config.datasheetId
  if (typeof foreignSheetId !== 'string' || foreignSheetId.trim().length === 0) return null
  return {
    foreignSheetId: foreignSheetId.trim(),
    limitSingleRecord: config.limitSingleRecord === true,
  }
}

function normalizeMetaViewType(type: string): MetaViewType {
  if (type === 'form' || type === 'gallery' || type === 'calendar') return type
  return 'grid'
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function findFieldByNames(fields: MetaFieldRow[], candidates: string[]): MetaFieldRow | undefined {
  const normalizedCandidates = new Set(candidates.map(normalizeFieldName))
  return fields.find((field) => normalizedCandidates.has(normalizeFieldName(field.name)))
}

function findFirstFieldByType(fields: MetaFieldRow[], types: string[]): MetaFieldRow | undefined {
  const allowedTypes = new Set(types)
  return fields.find((field) => allowedTypes.has(field.type))
}

function findLikelyDateField(fields: MetaFieldRow[], preferredNames: string[]): MetaFieldRow | undefined {
  const exactMatch = findFieldByNames(fields, preferredNames)
  if (exactMatch) return exactMatch

  const fuzzy = fields.find((field) => {
    const normalized = normalizeFieldName(field.name)
    return normalized.includes('date') || normalized.includes('time') || normalized.includes('deadline')
  })
  if (fuzzy) return fuzzy

  return fields.find((field) => field.type === 'string')
}

function findLikelyImageField(fields: MetaFieldRow[]): MetaFieldRow | undefined {
  const exactMatch = findFieldByNames(fields, ['image', 'thumbnail', 'cover', 'avatar', 'photo', 'picture'])
  if (exactMatch) return exactMatch
  return fields.find((field) => {
    const normalized = normalizeFieldName(field.name)
    return normalized.includes('image') || normalized.includes('thumb') || normalized.includes('cover')
  })
}

function findLikelyTagFields(fields: MetaFieldRow[]): MetaFieldRow[] {
  const nameMatches = fields.filter((field) => {
    const normalized = normalizeFieldName(field.name)
    return normalized.includes('tag') || normalized.includes('label') || normalized.includes('category')
  })
  if (nameMatches.length > 0) return nameMatches.slice(0, 2)

  return fields
    .filter((field) => field.type === 'select' || field.type === 'link')
    .slice(0, 2)
}

function mapSortInfoToLegacySorting(sortInfo: Record<string, unknown>, fields: MetaFieldRow[]): Array<{ field: string; direction: 'asc' | 'desc' }> {
  const rawEntries = Array.isArray(sortInfo.items)
    ? sortInfo.items
    : Array.isArray(sortInfo.sorts)
      ? sortInfo.sorts
      : []
  if (!Array.isArray(rawEntries)) return []

  const fieldNameById = new Map(fields.map((field) => [field.id, field.name]))

  return rawEntries
    .map((entry) => {
      if (!isPlainObject(entry)) return null
      const fieldId = typeof entry.fieldId === 'string' ? entry.fieldId : typeof entry.field === 'string' ? entry.field : null
      if (!fieldId) return null
      const direction = entry.direction === 'desc' ? 'desc' : 'asc'
      return {
        field: fieldNameById.get(fieldId) ?? fieldId,
        direction,
      }
    })
    .filter((entry): entry is { field: string; direction: 'asc' | 'desc' } => !!entry)
}

function mapMetaFieldTypeToFormType(field: MetaFieldRow): 'text' | 'number' | 'checkbox' | 'select' | 'multiselect' {
  if (field.type === 'number' || field.type === 'rollup') return 'number'
  if (field.type === 'boolean') return 'checkbox'
  if (field.type === 'select') return 'select'
  if (field.type === 'link') {
    const link = parseLinkFieldConfig(field.property)
    return link?.limitSingleRecord ? 'select' : 'multiselect'
  }
  return 'text'
}

function toResponseValue(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

async function loadMetaView(viewId: string, pool: DatabasePool): Promise<MetaViewRow | null> {
  const result = await pool.query(
    `SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, created_at, updated_at
     FROM meta_views
     WHERE id = $1`,
    [viewId],
  )
  const row = result.rows[0] as any
  if (!row) return null
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

async function loadMetaSheet(sheetId: string, pool: DatabasePool): Promise<MetaSheetRow | null> {
  const result = await pool.query(
    'SELECT id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
    [sheetId],
  )
  const row = result.rows[0] as any
  if (!row) return null
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
  }
}

async function loadMetaFields(sheetId: string, pool: DatabasePool): Promise<MetaFieldRow[]> {
  const result = await pool.query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  return result.rows.map((row: any) => ({
    id: String(row.id),
    name: String(row.name),
    type: String(row.type ?? 'string'),
    property: normalizeJson(row.property),
    order: Number(row.order ?? 0),
  }))
}

async function loadRecordOptions(sheetId: string, pool: DatabasePool): Promise<Array<{ value: string; label: string }>> {
  const fields = await loadMetaFields(sheetId, pool)
  const displayFieldId = fields.find((field) => field.type === 'string')?.id ?? fields[0]?.id
  const records = await pool.query(
    'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT 200',
    [sheetId],
  )
  return (records.rows as any[]).map((row) => {
    const data = normalizeJson(row.data)
    const label = displayFieldId ? toResponseValue(data[displayFieldId]) : String(row.id)
    return {
      value: String(row.id),
      label: typeof label === 'string' ? label : String(label),
    }
  })
}

async function buildMetaViewConfig(viewId: string, pool: DatabasePool): Promise<Record<string, unknown> | null> {
  const view = await loadMetaView(viewId, pool)
  if (!view) return null
  const sheet = await loadMetaSheet(view.sheetId, pool)
  if (!sheet) return null
  const fields = await loadMetaFields(view.sheetId, pool)
  const visibleFields = fields.filter((field) => !view.hiddenFieldIds.includes(field.id))
  const normalizedType = normalizeMetaViewType(view.type)
  const sorting = mapSortInfoToLegacySorting(view.sortInfo, fields)

  const baseConfig: Record<string, unknown> = {
    id: view.id,
    name: view.name,
    type: normalizedType,
    description: sheet.description ?? '',
    createdAt: view.createdAt ?? new Date().toISOString(),
    updatedAt: view.updatedAt ?? new Date().toISOString(),
    createdBy: 'system',
    tableId: sheet.id,
    filters: [],
    sorting,
    visibleFields: visibleFields.map((field) => field.id),
    editable: true,
    deletable: true,
  }

  if (normalizedType === 'gallery') {
    const titleField = findFieldByNames(visibleFields, ['title', 'name', 'subject', 'summary'])
      ?? findFirstFieldByType(visibleFields, ['string', 'formula', 'lookup'])
      ?? visibleFields[0]
    const imageField = findLikelyImageField(visibleFields)
    const tagFields = findLikelyTagFields(visibleFields)
      .filter((field) => field.id !== titleField?.id && field.id !== imageField?.id)
    const contentFields = visibleFields
      .filter((field) => field.id !== titleField?.id && field.id !== imageField?.id && !tagFields.some((tag) => tag.id === field.id))
      .slice(0, 3)

    return {
      ...baseConfig,
      cardTemplate: {
        titleField: titleField?.name ?? 'title',
        contentFields: contentFields.map((field) => field.name).length > 0
          ? contentFields.map((field) => field.name)
          : [titleField?.name ?? 'content'],
        ...(imageField ? { imageField: imageField.name } : {}),
        ...(tagFields.length > 0 ? { tagFields: tagFields.map((field) => field.name) } : {}),
      },
      layout: {
        columns: 3,
        cardSize: 'medium',
        spacing: 'normal',
      },
      display: {
        showTitle: true,
        showContent: true,
        showImage: true,
        showTags: true,
        truncateContent: true,
        maxContentLength: 150,
      },
    }
  }

  if (normalizedType === 'calendar') {
    const titleField = findFieldByNames(visibleFields, ['title', 'name', 'subject', 'summary'])
      ?? findFirstFieldByType(visibleFields, ['string', 'formula', 'lookup'])
      ?? visibleFields[0]
    const startField = findLikelyDateField(visibleFields, ['startDate', 'start', 'date', 'dueDate', 'deadline'])
      ?? titleField
    const endField = findLikelyDateField(
      visibleFields.filter((field) => field.id !== startField?.id),
      ['endDate', 'end', 'dueDate', 'deadline'],
    ) ?? startField
    const descriptionField = findFieldByNames(visibleFields, ['description', 'content', 'notes', 'detail'])
    const categoryField = findFieldByNames(visibleFields, ['category', 'status', 'type', 'priority'])
    const locationField = findFieldByNames(visibleFields, ['location', 'place', 'room', 'venue'])

    return {
      ...baseConfig,
      defaultView: 'month',
      weekStartsOn: 1,
      timeFormat: 24,
      fields: {
        title: titleField?.name ?? 'title',
        start: startField?.name ?? 'startDate',
        end: endField?.name ?? (startField?.name ?? 'endDate'),
        startDate: startField?.name ?? 'startDate',
        endDate: endField?.name ?? (startField?.name ?? 'endDate'),
        ...(descriptionField ? { description: descriptionField.name } : {}),
        ...(categoryField ? { category: categoryField.name } : {}),
        ...(locationField ? { location: locationField.name } : {}),
      },
      colorRules: [],
    }
  }

  if (normalizedType !== 'form') {
    return {
      ...baseConfig,
      columns: visibleFields.map((field) => ({ field: field.id, hidden: false })),
      rowHeight: 'normal',
      showRowNumbers: true,
      enableGrouping: true,
      enableFiltering: true,
      enableSorting: true,
    }
  }

  const formFields = await Promise.all(visibleFields.map(async (field) => {
    const type = mapMetaFieldTypeToFormType(field)
    const link = field.type === 'link' ? parseLinkFieldConfig(field.property) : null
    const options = field.type === 'select'
      ? extractSelectOptions(field.property)
      : link
        ? await loadRecordOptions(link.foreignSheetId, pool)
        : undefined

    return {
      id: field.id,
      name: field.id,
      label: field.name,
      type,
      required: field.property.required === true,
      placeholder: field.name,
      order: field.order,
      width: 'full',
      ...(options && options.length > 0 ? { options } : {}),
    }
  }))

  return {
    ...baseConfig,
    fields: formFields,
    settings: {
      title: view.name,
      description: sheet.description ?? '',
      submitButtonText: '提交',
      successMessage: '提交成功',
      allowMultiple: true,
      requireAuth: false,
      enablePublicAccess: false,
      notifyOnSubmission: false,
    },
    validation: {
      enableValidation: true,
    },
    styling: {
      theme: 'default',
      layout: 'single-column',
    },
  }
}

async function buildMetaViewData(
  viewId: string,
  page: number,
  pageSize: number,
  pool: DatabasePool,
): Promise<{ success: true; data: Record<string, unknown>[]; meta: { total: number; page: number; pageSize: number; hasMore: boolean } } | null> {
  const view = await loadMetaView(viewId, pool)
  if (!view) return null

  const safePage = Number.isFinite(page) && page > 0 ? page : 1
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 50
  const offset = (safePage - 1) * safePageSize

  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1',
    [view.sheetId],
  )
  const total = Number((countRes.rows[0] as any)?.total ?? 0)
  const recordRes = await pool.query(
    'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
    [view.sheetId, safePageSize, offset],
  )

  const fields = await loadMetaFields(view.sheetId, pool)
  const labelById = new Map(fields.map((field) => [field.id, field.name]))
  const data = (recordRes.rows as any[]).map((row) => {
    const payload = normalizeJson(row.data)
    const mapped: Record<string, unknown> = { id: String(row.id) }
    for (const [key, value] of Object.entries(payload)) {
      mapped[labelById.get(key) ?? key] = value
    }
    return mapped
  })

  return {
    success: true,
    data,
    meta: {
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: offset + data.length < total,
    },
  }
}

async function buildMetaFormResponses(
  viewId: string,
  page: number,
  pageSize: number,
  pool: DatabasePool,
): Promise<{ success: true; data: Array<Record<string, unknown>>; meta: { total: number; page: number; pageSize: number; hasMore: boolean } } | null> {
  const view = await loadMetaView(viewId, pool)
  if (!view || view.type !== 'form') return null

  const safePage = Number.isFinite(page) && page > 0 ? page : 1
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20
  const offset = (safePage - 1) * safePageSize

  const fields = await loadMetaFields(view.sheetId, pool)
  const labelById = new Map(fields.map((field) => [field.id, field.name]))

  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1',
    [view.sheetId],
  )
  const total = Number((countRes.rows[0] as any)?.total ?? 0)
  const recordRes = await pool.query(
    'SELECT id, data, created_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3',
    [view.sheetId, safePageSize, offset],
  )

  const data = (recordRes.rows as any[]).map((row) => {
    const payload = normalizeJson(row.data)
    const mappedData: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(payload)) {
      mappedData[labelById.get(key) ?? key] = toResponseValue(value)
    }
    return {
      id: String(row.id),
      formId: viewId,
      data: mappedData,
      submittedAt: row.created_at ?? new Date().toISOString(),
      status: 'submitted',
    }
  })

  return {
    success: true,
    data,
    meta: {
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: offset + data.length < total,
    },
  }
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
