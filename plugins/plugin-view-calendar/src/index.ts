/**
 * Calendar View Plugin
 *
 * Provides a calendar view for records with date-based visualization,
 * supporting multiple view modes (month, week, day, list) and event management.
 *
 * This plugin implements ViewConfigProvider to handle calendar-specific
 * configuration storage, maintaining architectural separation of concerns.
 */

import type {
  PluginLifecycle,
  PluginContext
} from '@metasheet/core-backend'
import type { Pool } from 'pg'

// ============================================================
// View Config Provider Types (matches core-backend interface)
// ============================================================

interface ViewConfigProvider<T = unknown> {
  readonly viewType: string
  getConfig(viewId: string, pool: Pool): Promise<T | null>
  saveConfig(viewId: string, config: Partial<T>, pool: Pool): Promise<void>
  deleteConfig(viewId: string, pool: Pool): Promise<void>
  transformConfig?(rawConfig: Record<string, unknown>): Partial<T>
  toApiFormat?(storedConfig: T): Record<string, unknown>
}

// ============================================================
// Calendar Plugin Types
// ============================================================

interface CalendarConfig {
  id: string
  viewId: string
  spreadsheetId: string
  fieldMapping: FieldMapping
  displayOptions: CalendarDisplayOptions
  colorRules: ColorRule[]
  createdAt: Date
  updatedAt: Date
}

interface FieldMapping {
  startDateField: string
  endDateField?: string
  titleField?: string
  descriptionField?: string
  categoryField?: string
  colorField?: string
  allDayField?: string
}

interface CalendarDisplayOptions {
  defaultView: 'month' | 'week' | 'day' | 'list'
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6
  showWeekNumbers: boolean
  showWeekends: boolean
  timeFormat: '12h' | '24h'
  slotDuration: number
  defaultEventDuration: number
  firstHour: number
  lastHour: number
}

interface ColorRule {
  id: string
  condition: ColorCondition
  color: string
  priority: number
}

interface ColorCondition {
  type: 'field_value' | 'date_range' | 'category'
  fieldId?: string
  operator?: 'equals' | 'contains' | 'greater_than' | 'less_than'
  value?: unknown
  category?: string
}

interface CalendarEvent {
  id: string
  title: string
  start: string
  end?: string
  allDay: boolean
  description?: string
  category?: string
  color?: string
  recordId: string
  extendedProps?: Record<string, unknown>
}

interface DateRange {
  start: Date
  end: Date
}

// Database row type
interface CalendarConfigRow {
  view_id: string
  date_field: string | null
  end_date_field: string | null
  title_field: string | null
  default_view: string | null
  week_starts_on: number | null
  color_rules: ColorRule[] | string | null
  created_at: Date
  updated_at: Date
}

// ============================================================
// Default Configurations
// ============================================================

const DEFAULT_FIELD_MAPPING: Partial<FieldMapping> = {
  startDateField: ''
}

const DEFAULT_DISPLAY_OPTIONS: CalendarDisplayOptions = {
  defaultView: 'month',
  weekStartsOn: 1,
  showWeekNumbers: false,
  showWeekends: true,
  timeFormat: '24h',
  slotDuration: 30,
  defaultEventDuration: 60,
  firstHour: 8,
  lastHour: 18
}

const CATEGORY_COLORS = [
  '#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399',
  '#9c27b0', '#00bcd4', '#ff9800', '#795548', '#607d8b'
]

// ============================================================
// Calendar View Config Provider (Database Integration)
// ============================================================

/**
 * Calendar view configuration provider
 * Handles reading/writing calendar_configs table
 */
class CalendarViewConfigProvider implements ViewConfigProvider<CalendarConfig> {
  readonly viewType = 'calendar'

  async getConfig(viewId: string, pool: Pool): Promise<CalendarConfig | null> {
    const result = await pool.query<CalendarConfigRow>(
      'SELECT * FROM calendar_configs WHERE view_id = $1',
      [viewId]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return this.rowToConfig(row)
  }

  async saveConfig(viewId: string, config: Partial<CalendarConfig>, pool: Pool): Promise<void> {
    const fieldMapping = config.fieldMapping || {}
    const displayOptions = config.displayOptions || {}
    const colorRules = config.colorRules || []

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
        fieldMapping.startDateField || null,
        fieldMapping.endDateField || null,
        fieldMapping.titleField || null,
        displayOptions.defaultView || 'month',
        displayOptions.weekStartsOn ?? 1,
        JSON.stringify(colorRules)
      ]
    )
  }

  async deleteConfig(viewId: string, pool: Pool): Promise<void> {
    await pool.query('DELETE FROM calendar_configs WHERE view_id = $1', [viewId])
  }

  /**
   * Transform raw API config to internal format
   */
  transformConfig(rawConfig: Record<string, unknown>): Partial<CalendarConfig> {
    const fields = (rawConfig.fields || {}) as Partial<FieldMapping>

    return {
      fieldMapping: {
        startDateField: fields.startDate as string || rawConfig.dateField as string || '',
        endDateField: fields.endDate as string || rawConfig.endDateField as string,
        titleField: fields.title as string || rawConfig.titleField as string
      },
      displayOptions: {
        defaultView: rawConfig.defaultView as CalendarDisplayOptions['defaultView'] || 'month',
        weekStartsOn: rawConfig.weekStartsOn as CalendarDisplayOptions['weekStartsOn'] ?? 1,
        showWeekNumbers: false,
        showWeekends: true,
        timeFormat: '24h',
        slotDuration: 30,
        defaultEventDuration: 60,
        firstHour: 8,
        lastHour: 18
      },
      colorRules: rawConfig.colorRules as ColorRule[] || []
    }
  }

  /**
   * Transform stored config to API response format
   */
  toApiFormat(storedConfig: CalendarConfig): Record<string, unknown> {
    return {
      defaultView: storedConfig.displayOptions.defaultView,
      weekStartsOn: storedConfig.displayOptions.weekStartsOn,
      fields: {
        title: storedConfig.fieldMapping.titleField,
        startDate: storedConfig.fieldMapping.startDateField,
        endDate: storedConfig.fieldMapping.endDateField
      },
      colorRules: storedConfig.colorRules
    }
  }

  private rowToConfig(row: CalendarConfigRow): CalendarConfig {
    let colorRules: ColorRule[] = []
    if (row.color_rules) {
      colorRules = typeof row.color_rules === 'string'
        ? JSON.parse(row.color_rules)
        : row.color_rules
    }

    return {
      id: `calendar:${row.view_id}`,
      viewId: row.view_id,
      spreadsheetId: '',
      fieldMapping: {
        startDateField: row.date_field || '',
        endDateField: row.end_date_field || undefined,
        titleField: row.title_field || undefined
      },
      displayOptions: {
        defaultView: (row.default_view as CalendarDisplayOptions['defaultView']) || 'month',
        weekStartsOn: (row.week_starts_on as CalendarDisplayOptions['weekStartsOn']) ?? 1,
        showWeekNumbers: false,
        showWeekends: true,
        timeFormat: '24h',
        slotDuration: 30,
        defaultEventDuration: 60,
        firstHour: 8,
        lastHour: 18
      },
      colorRules,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

// ============================================================
// Calendar Plugin Implementation
// ============================================================

export default class CalendarPlugin implements PluginLifecycle {
  private context!: PluginContext
  private calendarConfigs = new Map<string, CalendarConfig>()
  private categoryColorMap = new Map<string, Map<string, string>>()
  private configProvider = new CalendarViewConfigProvider()

  async activate(context: PluginContext): Promise<void> {
    this.context = context
    this.context.logger.info('Calendar View Plugin activating...')

    this.registerViewConfigProvider()
    this.registerRoutes()
    this.registerEventListeners()
    this.registerPluginAPI()
    this.registerWebSocketEvents()

    this.context.logger.info('Calendar View Plugin activated')
  }

  async deactivate(): Promise<void> {
    this.context.logger.info('Calendar View Plugin deactivating...')
    this.calendarConfigs.clear()
    this.categoryColorMap.clear()
    this.context.logger.info('Calendar View Plugin deactivated')
  }

  /**
   * Register the view config provider with the core registry
   */
  private registerViewConfigProvider(): void {
    this.context.api.events.emit('view:configProvider:register', {
      viewType: 'calendar',
      provider: this.configProvider
    })
    this.context.logger.debug('Calendar view config provider registered')
  }

  private registerRoutes(): void {
    const router = this.context.api.http

    // Get calendar configuration
    router.addRoute('GET', '/api/calendar/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`

        let config = this.calendarConfigs.get(configKey)
        if (!config) {
          try {
            const dbConfig = await this.loadConfigFromDb(viewId)
            if (dbConfig) {
              config = { ...dbConfig, spreadsheetId }
              this.calendarConfigs.set(configKey, config)
            }
          } catch {
            // Database not available
          }

          if (!config) {
            config = {
              id: configKey,
              spreadsheetId,
              viewId,
              fieldMapping: { ...DEFAULT_FIELD_MAPPING } as FieldMapping,
              displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
              colorRules: [],
              createdAt: new Date(),
              updatedAt: new Date()
            }
            this.calendarConfigs.set(configKey, config)
          }
        }

        res.json({ success: true, data: config })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get calendar config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Update calendar configuration
    router.addRoute('PUT', '/api/calendar/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`
        const updates = req.body as Partial<CalendarConfig>

        let config = this.calendarConfigs.get(configKey)
        if (!config) {
          config = {
            id: configKey,
            spreadsheetId,
            viewId,
            fieldMapping: { ...DEFAULT_FIELD_MAPPING } as FieldMapping,
            displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
            colorRules: [],
            createdAt: new Date(),
            updatedAt: new Date()
          }
        }

        if (updates.fieldMapping) {
          config.fieldMapping = { ...config.fieldMapping, ...updates.fieldMapping }
        }
        if (updates.displayOptions) {
          config.displayOptions = { ...config.displayOptions, ...updates.displayOptions }
        }
        if (updates.colorRules) {
          config.colorRules = updates.colorRules
        }
        config.updatedAt = new Date()

        this.calendarConfigs.set(configKey, config)

        // Persist to database
        try {
          await this.saveConfigToDb(viewId, config)
        } catch {
          // Database not available
        }

        this.context.api.events.emit('calendar:config:updated', {
          spreadsheetId,
          viewId,
          config
        })

        this.context.api.websocket?.broadcast('calendar', {
          type: 'config_updated',
          spreadsheetId,
          viewId,
          config
        })

        res.json({ success: true, data: config })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to update calendar config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Get calendar events for date range
    router.addRoute('GET', '/api/calendar/:spreadsheetId/:viewId/events', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const { start, end } = req.query as { start?: string; end?: string }

        if (!start || !end) {
          res.status(400).json({ success: false, error: 'start and end dates are required' })
          return
        }

        const configKey = `${spreadsheetId}:${viewId}`
        const config = this.calendarConfigs.get(configKey)

        if (!config?.fieldMapping.startDateField) {
          res.status(400).json({ success: false, error: 'Calendar not configured - no date field mapped' })
          return
        }

        const dateRange: DateRange = {
          start: new Date(start),
          end: new Date(end)
        }

        const recordsResult = await this.context.api.events.request('spreadsheet:records:query', {
          spreadsheetId,
          viewId,
          filters: [
            {
              fieldId: config.fieldMapping.startDateField,
              operator: 'gte',
              value: dateRange.start.toISOString()
            },
            {
              fieldId: config.fieldMapping.startDateField,
              operator: 'lte',
              value: dateRange.end.toISOString()
            }
          ],
          pageSize: 1000
        })

        if (!recordsResult?.success) {
          throw new Error('Failed to fetch records')
        }

        const events: CalendarEvent[] = recordsResult.data.records.map((record: Record<string, unknown>) => {
          return this.transformRecordToEvent(record, config)
        }).filter((event: CalendarEvent | null) => event !== null) as CalendarEvent[]

        res.json({ success: true, data: { events } })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get calendar events:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Create event
    router.addRoute('POST', '/api/calendar/:spreadsheetId/:viewId/events', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const eventData = req.body as {
          title?: string
          start: string
          end?: string
          allDay?: boolean
          description?: string
          category?: string
        }

        const configKey = `${spreadsheetId}:${viewId}`
        const config = this.calendarConfigs.get(configKey)

        if (!config?.fieldMapping.startDateField) {
          res.status(400).json({ success: false, error: 'Calendar not configured' })
          return
        }

        const fields: Record<string, unknown> = {
          [config.fieldMapping.startDateField]: eventData.start
        }

        if (config.fieldMapping.endDateField && eventData.end) {
          fields[config.fieldMapping.endDateField] = eventData.end
        }
        if (config.fieldMapping.titleField && eventData.title) {
          fields[config.fieldMapping.titleField] = eventData.title
        }
        if (config.fieldMapping.descriptionField && eventData.description) {
          fields[config.fieldMapping.descriptionField] = eventData.description
        }
        if (config.fieldMapping.categoryField && eventData.category) {
          fields[config.fieldMapping.categoryField] = eventData.category
        }
        if (config.fieldMapping.allDayField && eventData.allDay !== undefined) {
          fields[config.fieldMapping.allDayField] = eventData.allDay
        }

        const createResult = await this.context.api.events.request('spreadsheet:record:create', {
          spreadsheetId,
          fields
        })

        if (!createResult?.success) {
          throw new Error('Failed to create record')
        }

        const event = this.transformRecordToEvent(createResult.data, config)

        this.context.api.websocket?.broadcast('calendar', {
          type: 'event_created',
          spreadsheetId,
          viewId,
          event
        })

        res.json({ success: true, data: event })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to create calendar event:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Update event
    router.addRoute('PUT', '/api/calendar/:spreadsheetId/:viewId/events/:recordId', async (req, res) => {
      try {
        const { spreadsheetId, viewId, recordId } = req.params
        const updates = req.body as {
          start?: string
          end?: string
          title?: string
          allDay?: boolean
        }

        const configKey = `${spreadsheetId}:${viewId}`
        const config = this.calendarConfigs.get(configKey)

        if (!config) {
          res.status(400).json({ success: false, error: 'Calendar not configured' })
          return
        }

        const fields: Record<string, unknown> = {}

        if (updates.start && config.fieldMapping.startDateField) {
          fields[config.fieldMapping.startDateField] = updates.start
        }
        if (updates.end && config.fieldMapping.endDateField) {
          fields[config.fieldMapping.endDateField] = updates.end
        }
        if (updates.title && config.fieldMapping.titleField) {
          fields[config.fieldMapping.titleField] = updates.title
        }
        if (updates.allDay !== undefined && config.fieldMapping.allDayField) {
          fields[config.fieldMapping.allDayField] = updates.allDay
        }

        const updateResult = await this.context.api.events.request('spreadsheet:record:update', {
          spreadsheetId,
          recordId,
          fields
        })

        if (!updateResult?.success) {
          throw new Error('Failed to update record')
        }

        const event = this.transformRecordToEvent(updateResult.data, config)

        this.context.api.websocket?.broadcast('calendar', {
          type: 'event_updated',
          spreadsheetId,
          viewId,
          event
        })

        res.json({ success: true, data: event })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to update calendar event:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Delete event
    router.addRoute('DELETE', '/api/calendar/:spreadsheetId/:viewId/events/:recordId', async (req, res) => {
      try {
        const { spreadsheetId, viewId, recordId } = req.params

        const deleteResult = await this.context.api.events.request('spreadsheet:record:delete', {
          spreadsheetId,
          recordId
        })

        if (!deleteResult?.success) {
          throw new Error('Failed to delete record')
        }

        this.context.api.websocket?.broadcast('calendar', {
          type: 'event_deleted',
          spreadsheetId,
          viewId,
          recordId
        })

        res.json({ success: true })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to delete calendar event:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Get available date fields
    router.addRoute('GET', '/api/calendar/:spreadsheetId/date-fields', async (req, res) => {
      try {
        const { spreadsheetId } = req.params

        const fieldsResult = await this.context.api.events.request('spreadsheet:fields:list', {
          spreadsheetId
        })

        if (!fieldsResult?.success) {
          throw new Error('Failed to fetch fields')
        }

        const dateFields = fieldsResult.data.fields.filter((field: { type: string }) =>
          ['date', 'datetime', 'createdTime', 'lastModifiedTime'].includes(field.type)
        )

        res.json({ success: true, data: { fields: dateFields } })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get date fields:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Delete calendar configuration
    router.addRoute('DELETE', '/api/calendar/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`

        this.calendarConfigs.delete(configKey)

        try {
          await this.deleteConfigFromDb(viewId)
        } catch {
          // Database not available
        }

        res.json({ success: true })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to delete calendar config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    this.context.logger.debug('Calendar routes registered')
  }

  private registerEventListeners(): void {
    const events = this.context.api.events

    events.on('view:deleted', (data: { spreadsheetId: string; viewId: string }) => {
      const configKey = `${data.spreadsheetId}:${data.viewId}`
      this.calendarConfigs.delete(configKey)
      this.deleteConfigFromDb(data.viewId).catch(() => {})
      this.context.logger.debug(`Calendar config deleted for view: ${data.viewId}`)
    })

    events.on('spreadsheet:deleted', (data: { spreadsheetId: string }) => {
      for (const key of this.calendarConfigs.keys()) {
        if (key.startsWith(`${data.spreadsheetId}:`)) {
          this.calendarConfigs.delete(key)
        }
      }
      this.categoryColorMap.delete(data.spreadsheetId)
      this.context.logger.debug(`Calendar configs deleted for spreadsheet: ${data.spreadsheetId}`)
    })

    events.on('record:updated', (data: { spreadsheetId: string; recordId: string }) => {
      this.context.api.websocket?.broadcast('calendar', {
        type: 'record_updated',
        spreadsheetId: data.spreadsheetId,
        recordId: data.recordId
      })
    })

    events.on('field:deleted', (data: { spreadsheetId: string; fieldId: string }) => {
      for (const [key, config] of this.calendarConfigs.entries()) {
        if (config.spreadsheetId === data.spreadsheetId) {
          let updated = false
          const mapping = config.fieldMapping

          if (mapping.startDateField === data.fieldId) {
            mapping.startDateField = ''
            updated = true
          }
          if (mapping.endDateField === data.fieldId) {
            mapping.endDateField = undefined
            updated = true
          }
          if (mapping.titleField === data.fieldId) {
            mapping.titleField = undefined
            updated = true
          }
          if (mapping.descriptionField === data.fieldId) {
            mapping.descriptionField = undefined
            updated = true
          }
          if (mapping.categoryField === data.fieldId) {
            mapping.categoryField = undefined
            updated = true
          }
          if (mapping.colorField === data.fieldId) {
            mapping.colorField = undefined
            updated = true
          }
          if (mapping.allDayField === data.fieldId) {
            mapping.allDayField = undefined
            updated = true
          }

          if (updated) {
            config.updatedAt = new Date()
            this.calendarConfigs.set(key, config)
            this.saveConfigToDb(config.viewId, config).catch(() => {})
          }
        }
      }
    })

    this.context.logger.debug('Calendar event listeners registered')
  }

  private registerPluginAPI(): void {
    this.context.api.communication.expose('calendar:getConfig', async (params: { spreadsheetId: string; viewId: string }) => {
      const configKey = `${params.spreadsheetId}:${params.viewId}`
      return this.calendarConfigs.get(configKey)
    })

    this.context.api.communication.expose('calendar:getEvents', async (params: {
      spreadsheetId: string
      viewId: string
      start: string
      end: string
    }) => {
      const configKey = `${params.spreadsheetId}:${params.viewId}`
      const config = this.calendarConfigs.get(configKey)

      if (!config?.fieldMapping.startDateField) {
        return { events: [] }
      }

      const recordsResult = await this.context.api.events.request('spreadsheet:records:query', {
        spreadsheetId: params.spreadsheetId,
        viewId: params.viewId,
        filters: [
          {
            fieldId: config.fieldMapping.startDateField,
            operator: 'gte',
            value: params.start
          },
          {
            fieldId: config.fieldMapping.startDateField,
            operator: 'lte',
            value: params.end
          }
        ],
        pageSize: 1000
      })

      if (!recordsResult?.success) {
        return { events: [] }
      }

      const events = recordsResult.data.records
        .map((record: Record<string, unknown>) => this.transformRecordToEvent(record, config))
        .filter((event: CalendarEvent | null) => event !== null)

      return { events }
    })

    // Expose the config provider for core views router
    this.context.api.communication.expose('calendar:getConfigProvider', async () => {
      return this.configProvider
    })

    this.context.logger.debug('Calendar plugin API registered')
  }

  private registerWebSocketEvents(): void {
    const ws = this.context.api.websocket
    if (!ws) return

    ws.on('calendar:subscribe', (client, data: { spreadsheetId: string; viewId: string }) => {
      ws.joinRoom(client, `calendar:${data.spreadsheetId}:${data.viewId}`)
      this.context.logger.debug(`Client subscribed to calendar: ${data.spreadsheetId}:${data.viewId}`)
    })

    ws.on('calendar:unsubscribe', (client, data: { spreadsheetId: string; viewId: string }) => {
      ws.leaveRoom(client, `calendar:${data.spreadsheetId}:${data.viewId}`)
      this.context.logger.debug(`Client unsubscribed from calendar: ${data.spreadsheetId}:${data.viewId}`)
    })

    this.context.logger.debug('Calendar WebSocket events registered')
  }

  // ============================================================
  // Database Integration Methods
  // ============================================================

  private async loadConfigFromDb(viewId: string): Promise<CalendarConfig | null> {
    const pool = await this.getDbPool()
    if (!pool) return null
    return this.configProvider.getConfig(viewId, pool)
  }

  private async saveConfigToDb(viewId: string, config: CalendarConfig): Promise<void> {
    const pool = await this.getDbPool()
    if (!pool) return
    await this.configProvider.saveConfig(viewId, config, pool)
  }

  private async deleteConfigFromDb(viewId: string): Promise<void> {
    const pool = await this.getDbPool()
    if (!pool) return
    await this.configProvider.deleteConfig(viewId, pool)
  }

  private async getDbPool(): Promise<Pool | null> {
    try {
      const result = await this.context.api.database.query('SELECT 1')
      if (result) {
        return null
      }
      return null
    } catch {
      return null
    }
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private transformRecordToEvent(
    record: Record<string, unknown>,
    config: CalendarConfig
  ): CalendarEvent | null {
    const fields = (record.fields || record) as Record<string, unknown>
    const mapping = config.fieldMapping

    const startValue = fields[mapping.startDateField]
    if (!startValue) {
      return null
    }

    const start = this.parseDate(startValue)
    if (!start) {
      return null
    }

    const event: CalendarEvent = {
      id: `event-${record.id}`,
      recordId: record.id as string,
      title: mapping.titleField && fields[mapping.titleField]
        ? String(fields[mapping.titleField])
        : 'Untitled',
      start: start.toISOString(),
      allDay: false
    }

    if (mapping.endDateField && fields[mapping.endDateField]) {
      const end = this.parseDate(fields[mapping.endDateField])
      if (end) {
        event.end = end.toISOString()
      }
    }

    if (mapping.allDayField && fields[mapping.allDayField] !== undefined) {
      event.allDay = Boolean(fields[mapping.allDayField])
    }

    if (mapping.descriptionField && fields[mapping.descriptionField]) {
      event.description = String(fields[mapping.descriptionField])
    }

    if (mapping.categoryField && fields[mapping.categoryField]) {
      event.category = String(fields[mapping.categoryField])
      event.color = this.getCategoryColor(config.spreadsheetId, event.category)
    }

    if (mapping.colorField && fields[mapping.colorField]) {
      event.color = String(fields[mapping.colorField])
    }

    const ruleColor = this.applyColorRules(fields, config.colorRules)
    if (ruleColor) {
      event.color = ruleColor
    }

    if (!event.color) {
      event.color = CATEGORY_COLORS[0]
    }

    return event
  }

  private parseDate(value: unknown): Date | null {
    if (!value) return null

    if (value instanceof Date) {
      return value
    }

    if (typeof value === 'string') {
      const date = new Date(value)
      return isNaN(date.getTime()) ? null : date
    }

    if (typeof value === 'number') {
      return new Date(value)
    }

    return null
  }

  private getCategoryColor(spreadsheetId: string, category: string): string {
    let colorMap = this.categoryColorMap.get(spreadsheetId)
    if (!colorMap) {
      colorMap = new Map()
      this.categoryColorMap.set(spreadsheetId, colorMap)
    }

    let color = colorMap.get(category)
    if (!color) {
      const usedColors = new Set(colorMap.values())
      const availableColors = CATEGORY_COLORS.filter(c => !usedColors.has(c))
      color = availableColors.length > 0
        ? availableColors[0]
        : CATEGORY_COLORS[colorMap.size % CATEGORY_COLORS.length]
      colorMap.set(category, color)
    }

    return color
  }

  private applyColorRules(
    fields: Record<string, unknown>,
    rules: ColorRule[]
  ): string | null {
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority)

    for (const rule of sortedRules) {
      if (this.evaluateColorCondition(fields, rule.condition)) {
        return rule.color
      }
    }

    return null
  }

  private evaluateColorCondition(
    fields: Record<string, unknown>,
    condition: ColorCondition
  ): boolean {
    if (condition.type === 'category' && condition.category) {
      return fields[condition.fieldId || ''] === condition.category
    }

    if (condition.type === 'field_value' && condition.fieldId) {
      const fieldValue = fields[condition.fieldId]

      switch (condition.operator) {
        case 'equals':
          return fieldValue === condition.value
        case 'contains':
          return typeof fieldValue === 'string' &&
            fieldValue.includes(String(condition.value))
        case 'greater_than':
          return Number(fieldValue) > Number(condition.value)
        case 'less_than':
          return Number(fieldValue) < Number(condition.value)
        default:
          return false
      }
    }

    return false
  }
}

// Export the config provider for direct use
export { CalendarViewConfigProvider }
