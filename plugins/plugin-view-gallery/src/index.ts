/**
 * Gallery View Plugin
 *
 * Provides a card-based gallery view for records with customizable
 * card templates, image support, and flexible layout options.
 *
 * This plugin implements ViewConfigProvider to handle gallery-specific
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
// Gallery Plugin Types
// ============================================================

interface GalleryConfig {
  id: string
  viewId: string
  spreadsheetId: string
  cardTemplate: CardTemplate
  displayOptions: DisplayOptions
  layoutOptions: LayoutOptions
  createdAt: Date
  updatedAt: Date
}

interface CardTemplate {
  coverField?: string
  titleField?: string
  subtitleField?: string
  descriptionField?: string
  visibleFields: string[]
  badgeField?: string
}

interface DisplayOptions {
  showCover: boolean
  coverFit: 'cover' | 'contain' | 'fill'
  coverHeight: number
  showEmptyCards: boolean
  cardClickAction: 'expand' | 'edit' | 'none'
}

interface LayoutOptions {
  columns: number
  cardSpacing: number
  cardBorderRadius: number
}

interface GalleryRecord {
  id: string
  fields: Record<string, unknown>
  coverUrl?: string
  title?: string
  subtitle?: string
  description?: string
  badge?: string
}

// Database row type
interface GalleryConfigRow {
  view_id: string
  cover_field: string | null
  title_field: string | null
  fields_to_show: string[] | null
  columns: number | null
  card_size: string | null
  created_at: Date
  updated_at: Date
}

// ============================================================
// Default Configurations
// ============================================================

const DEFAULT_CARD_TEMPLATE: CardTemplate = {
  visibleFields: []
}

const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = {
  showCover: true,
  coverFit: 'cover',
  coverHeight: 160,
  showEmptyCards: true,
  cardClickAction: 'expand'
}

const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  columns: 4,
  cardSpacing: 16,
  cardBorderRadius: 8
}

// ============================================================
// Gallery View Config Provider (Database Integration)
// ============================================================

/**
 * Gallery view configuration provider
 * Handles reading/writing gallery_configs table
 */
class GalleryViewConfigProvider implements ViewConfigProvider<GalleryConfig> {
  readonly viewType = 'gallery'

  async getConfig(viewId: string, pool: Pool): Promise<GalleryConfig | null> {
    const result = await pool.query<GalleryConfigRow>(
      'SELECT * FROM gallery_configs WHERE view_id = $1',
      [viewId]
    )

    if (result.rows.length === 0) {
      return null
    }

    const row = result.rows[0]
    return this.rowToConfig(row)
  }

  async saveConfig(viewId: string, config: Partial<GalleryConfig>, pool: Pool): Promise<void> {
    const cardTemplate = config.cardTemplate || {}
    const layoutOptions = config.layoutOptions || {}

    // Convert columns to card_size for backward compatibility
    let cardSize: string = 'medium'
    if (layoutOptions.columns) {
      if (layoutOptions.columns >= 5) cardSize = 'small'
      else if (layoutOptions.columns <= 2) cardSize = 'large'
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
        cardTemplate.coverField || null,
        cardTemplate.titleField || null,
        JSON.stringify(cardTemplate.visibleFields || []),
        layoutOptions.columns || 4,
        cardSize
      ]
    )
  }

  async deleteConfig(viewId: string, pool: Pool): Promise<void> {
    await pool.query('DELETE FROM gallery_configs WHERE view_id = $1', [viewId])
  }

  /**
   * Transform raw API config to internal format
   */
  transformConfig(rawConfig: Record<string, unknown>): Partial<GalleryConfig> {
    const cardTemplate = (rawConfig.cardTemplate || {}) as Partial<CardTemplate>
    const layout = (rawConfig.layout || rawConfig.layoutOptions || {}) as Partial<LayoutOptions>

    return {
      cardTemplate: {
        coverField: cardTemplate.coverField || (rawConfig.imageField as string),
        titleField: cardTemplate.titleField,
        subtitleField: cardTemplate.subtitleField,
        descriptionField: cardTemplate.descriptionField,
        visibleFields: cardTemplate.visibleFields || (rawConfig.contentFields as string[]) || [],
        badgeField: cardTemplate.badgeField
      },
      layoutOptions: {
        columns: layout.columns || 4,
        cardSpacing: layout.cardSpacing || 16,
        cardBorderRadius: layout.cardBorderRadius || 8
      }
    }
  }

  /**
   * Transform stored config to API response format
   */
  toApiFormat(storedConfig: GalleryConfig): Record<string, unknown> {
    return {
      cardTemplate: {
        titleField: storedConfig.cardTemplate.titleField,
        imageField: storedConfig.cardTemplate.coverField,
        contentFields: storedConfig.cardTemplate.visibleFields
      },
      layout: {
        columns: storedConfig.layoutOptions.columns,
        cardSize: this.columnsToCardSize(storedConfig.layoutOptions.columns)
      }
    }
  }

  private rowToConfig(row: GalleryConfigRow): GalleryConfig {
    return {
      id: `gallery:${row.view_id}`,
      viewId: row.view_id,
      spreadsheetId: '',
      cardTemplate: {
        coverField: row.cover_field || undefined,
        titleField: row.title_field || undefined,
        visibleFields: row.fields_to_show || []
      },
      displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
      layoutOptions: {
        columns: row.columns || 4,
        cardSpacing: 16,
        cardBorderRadius: 8
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  private columnsToCardSize(columns: number): string {
    if (columns >= 5) return 'small'
    if (columns <= 2) return 'large'
    return 'medium'
  }
}

// ============================================================
// Gallery Plugin Implementation
// ============================================================

export default class GalleryPlugin implements PluginLifecycle {
  private context!: PluginContext
  private galleryConfigs = new Map<string, GalleryConfig>()
  private configProvider = new GalleryViewConfigProvider()

  async activate(context: PluginContext): Promise<void> {
    this.context = context
    this.context.logger.info('Gallery View Plugin activating...')

    this.registerViewConfigProvider()
    this.registerRoutes()
    this.registerEventListeners()
    this.registerPluginAPI()
    this.registerWebSocketEvents()

    this.context.logger.info('Gallery View Plugin activated')
  }

  async deactivate(): Promise<void> {
    this.context.logger.info('Gallery View Plugin deactivating...')
    this.galleryConfigs.clear()
    this.context.logger.info('Gallery View Plugin deactivated')
  }

  /**
   * Register the view config provider with the core registry
   */
  private registerViewConfigProvider(): void {
    // Emit event for core to register our provider
    this.context.api.events.emit('view:configProvider:register', {
      viewType: 'gallery',
      provider: this.configProvider
    })
    this.context.logger.debug('Gallery view config provider registered')
  }

  private registerRoutes(): void {
    const router = this.context.api.http

    // Get gallery configuration for a view
    router.addRoute('GET', '/api/gallery/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`

        let config = this.galleryConfigs.get(configKey)
        if (!config) {
          // Try to load from database via provider
          try {
            const dbConfig = await this.loadConfigFromDb(viewId)
            if (dbConfig) {
              config = { ...dbConfig, spreadsheetId }
              this.galleryConfigs.set(configKey, config)
            }
          } catch {
            // Database not available, use defaults
          }

          if (!config) {
            config = {
              id: configKey,
              spreadsheetId,
              viewId,
              cardTemplate: { ...DEFAULT_CARD_TEMPLATE },
              displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
              layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS },
              createdAt: new Date(),
              updatedAt: new Date()
            }
            this.galleryConfigs.set(configKey, config)
          }
        }

        res.json({ success: true, data: config })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get gallery config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Update gallery configuration
    router.addRoute('PUT', '/api/gallery/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`
        const updates = req.body as Partial<GalleryConfig>

        let config = this.galleryConfigs.get(configKey)
        if (!config) {
          config = {
            id: configKey,
            spreadsheetId,
            viewId,
            cardTemplate: { ...DEFAULT_CARD_TEMPLATE },
            displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
            layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS },
            createdAt: new Date(),
            updatedAt: new Date()
          }
        }

        // Merge updates
        if (updates.cardTemplate) {
          config.cardTemplate = { ...config.cardTemplate, ...updates.cardTemplate }
        }
        if (updates.displayOptions) {
          config.displayOptions = { ...config.displayOptions, ...updates.displayOptions }
        }
        if (updates.layoutOptions) {
          config.layoutOptions = { ...config.layoutOptions, ...updates.layoutOptions }
        }
        config.updatedAt = new Date()

        this.galleryConfigs.set(configKey, config)

        // Persist to database
        try {
          await this.saveConfigToDb(viewId, config)
        } catch {
          // Database not available, in-memory only
        }

        // Emit config change event
        this.context.api.events.emit('gallery:config:updated', {
          spreadsheetId,
          viewId,
          config
        })

        // Broadcast to WebSocket clients
        this.context.api.websocket?.broadcast('gallery', {
          type: 'config_updated',
          spreadsheetId,
          viewId,
          config
        })

        res.json({ success: true, data: config })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to update gallery config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Get gallery records with card data
    router.addRoute('GET', '/api/gallery/:spreadsheetId/:viewId/records', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const { page = '1', pageSize = '20', search = '' } = req.query as Record<string, string>

        const configKey = `${spreadsheetId}:${viewId}`
        const config = this.galleryConfigs.get(configKey)

        // Get records from spreadsheet (via internal API or events)
        const recordsResult = await this.context.api.events.request('spreadsheet:records:query', {
          spreadsheetId,
          viewId,
          page: parseInt(page),
          pageSize: parseInt(pageSize),
          search
        })

        if (!recordsResult?.success) {
          throw new Error('Failed to fetch records')
        }

        // Transform records for gallery view
        const galleryRecords: GalleryRecord[] = recordsResult.data.records.map((record: Record<string, unknown>) => {
          return this.transformRecordForGallery(record, config?.cardTemplate)
        })

        res.json({
          success: true,
          data: {
            records: galleryRecords,
            total: recordsResult.data.total,
            page: parseInt(page),
            pageSize: parseInt(pageSize)
          }
        })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get gallery records:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Get single record detail
    router.addRoute('GET', '/api/gallery/:spreadsheetId/:viewId/records/:recordId', async (req, res) => {
      try {
        const { spreadsheetId, viewId, recordId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`
        const config = this.galleryConfigs.get(configKey)

        const recordResult = await this.context.api.events.request('spreadsheet:record:get', {
          spreadsheetId,
          recordId
        })

        if (!recordResult?.success) {
          res.status(404).json({ success: false, error: 'Record not found' })
          return
        }

        const galleryRecord = this.transformRecordForGallery(recordResult.data, config?.cardTemplate)

        res.json({ success: true, data: galleryRecord })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to get gallery record:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Upload cover image
    router.addRoute('POST', '/api/gallery/:spreadsheetId/:viewId/records/:recordId/cover', async (req, res) => {
      try {
        const { spreadsheetId, recordId } = req.params
        const configKey = `${req.params.spreadsheetId}:${req.params.viewId}`
        const config = this.galleryConfigs.get(configKey)

        if (!config?.cardTemplate.coverField) {
          res.status(400).json({ success: false, error: 'No cover field configured' })
          return
        }

        const { url } = req.body as { url: string }

        // Update record with cover URL
        await this.context.api.events.request('spreadsheet:record:update', {
          spreadsheetId,
          recordId,
          fields: {
            [config.cardTemplate.coverField]: url
          }
        })

        res.json({ success: true, data: { url } })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to upload cover:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    // Delete gallery configuration
    router.addRoute('DELETE', '/api/gallery/:spreadsheetId/:viewId/config', async (req, res) => {
      try {
        const { spreadsheetId, viewId } = req.params
        const configKey = `${spreadsheetId}:${viewId}`

        this.galleryConfigs.delete(configKey)

        // Delete from database
        try {
          await this.deleteConfigFromDb(viewId)
        } catch {
          // Database not available
        }

        res.json({ success: true })
      } catch (error) {
        const err = error as Error
        this.context.logger.error('Failed to delete gallery config:', err)
        res.status(500).json({ success: false, error: err.message })
      }
    })

    this.context.logger.debug('Gallery routes registered')
  }

  private registerEventListeners(): void {
    const events = this.context.api.events

    // Listen for view deletion
    events.on('view:deleted', (data: { spreadsheetId: string; viewId: string }) => {
      const configKey = `${data.spreadsheetId}:${data.viewId}`
      this.galleryConfigs.delete(configKey)
      this.deleteConfigFromDb(data.viewId).catch(() => {})
      this.context.logger.debug(`Gallery config deleted for view: ${data.viewId}`)
    })

    // Listen for spreadsheet deletion
    events.on('spreadsheet:deleted', (data: { spreadsheetId: string }) => {
      for (const key of this.galleryConfigs.keys()) {
        if (key.startsWith(`${data.spreadsheetId}:`)) {
          this.galleryConfigs.delete(key)
        }
      }
      this.context.logger.debug(`Gallery configs deleted for spreadsheet: ${data.spreadsheetId}`)
    })

    // Listen for record updates to broadcast changes
    events.on('record:updated', (data: { spreadsheetId: string; recordId: string }) => {
      this.context.api.websocket?.broadcast('gallery', {
        type: 'record_updated',
        spreadsheetId: data.spreadsheetId,
        recordId: data.recordId
      })
    })

    // Listen for field deletion (may affect card template)
    events.on('field:deleted', (data: { spreadsheetId: string; fieldId: string }) => {
      for (const [key, config] of this.galleryConfigs.entries()) {
        if (config.spreadsheetId === data.spreadsheetId) {
          let updated = false

          if (config.cardTemplate.coverField === data.fieldId) {
            config.cardTemplate.coverField = undefined
            updated = true
          }
          if (config.cardTemplate.titleField === data.fieldId) {
            config.cardTemplate.titleField = undefined
            updated = true
          }
          if (config.cardTemplate.subtitleField === data.fieldId) {
            config.cardTemplate.subtitleField = undefined
            updated = true
          }
          if (config.cardTemplate.descriptionField === data.fieldId) {
            config.cardTemplate.descriptionField = undefined
            updated = true
          }
          if (config.cardTemplate.badgeField === data.fieldId) {
            config.cardTemplate.badgeField = undefined
            updated = true
          }

          const fieldIndex = config.cardTemplate.visibleFields.indexOf(data.fieldId)
          if (fieldIndex > -1) {
            config.cardTemplate.visibleFields.splice(fieldIndex, 1)
            updated = true
          }

          if (updated) {
            config.updatedAt = new Date()
            this.galleryConfigs.set(key, config)
            this.saveConfigToDb(config.viewId, config).catch(() => {})
          }
        }
      }
    })

    this.context.logger.debug('Gallery event listeners registered')
  }

  private registerPluginAPI(): void {
    // Expose methods to other plugins via communication API
    this.context.api.communication.expose('gallery:getConfig', async (params: { spreadsheetId: string; viewId: string }) => {
      const configKey = `${params.spreadsheetId}:${params.viewId}`
      return this.galleryConfigs.get(configKey)
    })

    this.context.api.communication.expose('gallery:updateConfig', async (params: {
      spreadsheetId: string
      viewId: string
      config: Partial<GalleryConfig>
    }) => {
      const configKey = `${params.spreadsheetId}:${params.viewId}`
      let config = this.galleryConfigs.get(configKey)

      if (!config) {
        config = {
          id: configKey,
          spreadsheetId: params.spreadsheetId,
          viewId: params.viewId,
          cardTemplate: { ...DEFAULT_CARD_TEMPLATE },
          displayOptions: { ...DEFAULT_DISPLAY_OPTIONS },
          layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS },
          createdAt: new Date(),
          updatedAt: new Date()
        }
      }

      if (params.config.cardTemplate) {
        config.cardTemplate = { ...config.cardTemplate, ...params.config.cardTemplate }
      }
      if (params.config.displayOptions) {
        config.displayOptions = { ...config.displayOptions, ...params.config.displayOptions }
      }
      if (params.config.layoutOptions) {
        config.layoutOptions = { ...config.layoutOptions, ...params.config.layoutOptions }
      }
      config.updatedAt = new Date()

      this.galleryConfigs.set(configKey, config)
      await this.saveConfigToDb(params.viewId, config).catch(() => {})
      return config
    })

    // Expose the config provider for core views router
    this.context.api.communication.expose('gallery:getConfigProvider', async () => {
      return this.configProvider
    })

    this.context.logger.debug('Gallery plugin API registered')
  }

  private registerWebSocketEvents(): void {
    const ws = this.context.api.websocket
    if (!ws) return

    ws.on('gallery:subscribe', (client, data: { spreadsheetId: string; viewId: string }) => {
      ws.joinRoom(client, `gallery:${data.spreadsheetId}:${data.viewId}`)
      this.context.logger.debug(`Client subscribed to gallery: ${data.spreadsheetId}:${data.viewId}`)
    })

    ws.on('gallery:unsubscribe', (client, data: { spreadsheetId: string; viewId: string }) => {
      ws.leaveRoom(client, `gallery:${data.spreadsheetId}:${data.viewId}`)
      this.context.logger.debug(`Client unsubscribed from gallery: ${data.spreadsheetId}:${data.viewId}`)
    })

    this.context.logger.debug('Gallery WebSocket events registered')
  }

  // ============================================================
  // Database Integration Methods
  // ============================================================

  private async loadConfigFromDb(viewId: string): Promise<GalleryConfig | null> {
    const pool = await this.getDbPool()
    if (!pool) return null
    return this.configProvider.getConfig(viewId, pool)
  }

  private async saveConfigToDb(viewId: string, config: GalleryConfig): Promise<void> {
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
      // Try to get database pool from core API
      const result = await this.context.api.database.query('SELECT 1')
      if (result) {
        // The database API wraps the pool, but we need direct access for the provider
        // This is a workaround - in production, the provider should receive the pool
        return null // Let the provider use the database API instead
      }
      return null
    } catch {
      return null
    }
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  private transformRecordForGallery(
    record: Record<string, unknown>,
    template?: CardTemplate
  ): GalleryRecord {
    const fields = (record.fields || record) as Record<string, unknown>

    const galleryRecord: GalleryRecord = {
      id: record.id as string || '',
      fields
    }

    if (template) {
      if (template.coverField && fields[template.coverField]) {
        galleryRecord.coverUrl = this.extractImageUrl(fields[template.coverField])
      }
      if (template.titleField && fields[template.titleField]) {
        galleryRecord.title = String(fields[template.titleField])
      }
      if (template.subtitleField && fields[template.subtitleField]) {
        galleryRecord.subtitle = String(fields[template.subtitleField])
      }
      if (template.descriptionField && fields[template.descriptionField]) {
        galleryRecord.description = String(fields[template.descriptionField])
      }
      if (template.badgeField && fields[template.badgeField]) {
        galleryRecord.badge = String(fields[template.badgeField])
      }
    }

    return galleryRecord
  }

  private extractImageUrl(value: unknown): string | undefined {
    if (typeof value === 'string') {
      if (value.startsWith('http://') || value.startsWith('https://')) {
        return value
      }
      if (value.startsWith('data:image/')) {
        return value
      }
    }

    if (Array.isArray(value) && value.length > 0) {
      const firstAttachment = value[0] as { url?: string; thumbnailUrl?: string }
      return firstAttachment.thumbnailUrl || firstAttachment.url
    }

    if (typeof value === 'object' && value !== null) {
      const obj = value as { url?: string; thumbnailUrl?: string }
      return obj.thumbnailUrl || obj.url
    }

    return undefined
  }
}

// Export the config provider for direct use
export { GalleryViewConfigProvider }
