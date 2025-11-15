import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend'

export default class KanbanPlugin implements PluginLifecycle {
  private context: PluginContext | null = null
  private boards: Map<string, any> = new Map()

  async activate(context: PluginContext): Promise<void> {
    this.context = context
    const logger = (context as any)?.logger
    const http = (context as any)?.http
    const events = (context as any)?.events

    if (!logger) {
      // Fallback console to avoid throwing during activation
      // eslint-disable-next-line no-console
      console.warn('[KanbanPlugin] Logger missing in context; skipping activation to avoid breaking server start')
      return
    }

    logger.info('Kanban plugin activating...')

    // If HTTP API is not wired (e.g., limited CI context), skip route registration gracefully
    if (!http || typeof http.addRoute !== 'function') {
      logger.warn('Kanban plugin: context.http.addRoute unavailable; skipping route registration')
      return
    }

    // Register API routes
    http.addRoute('GET', '/api/kanban/boards', async (req, res) => {
      const boardsList = Array.from(this.boards.values())
      res.json({
        boards: boardsList,
        total: boardsList.length
      })
    })

    http.addRoute('POST', '/api/kanban/cards/move', async (req, res) => {
      const { cardId, fromColumn, toColumn } = req.body

      if (!cardId || !fromColumn || !toColumn) {
        return res.status(400).json({
          error: 'Missing required fields: cardId, fromColumn, toColumn'
        })
      }

      // Emit card moved event
      events.emit('kanban:card:moved', {
        cardId,
        fromColumn,
        toColumn,
        timestamp: new Date().toISOString()
      })

      // Broadcast to WebSocket clients
      if (context.websocket) {
        context.websocket.broadcast('kanban:card:moved', {
          type: 'kanban:card:moved',
          cardId,
          fromColumn,
          toColumn,
          timestamp: new Date().toISOString()
        })
      }

      res.json({
        success: true,
        message: `Card ${cardId} moved from ${fromColumn} to ${toColumn}`
      })
    })

    http.addRoute('POST', '/api/kanban/columns/add', async (req, res) => {
      const { boardId, columnName } = req.body

      if (!boardId || !columnName) {
        return res.status(400).json({
          error: 'Missing required fields: boardId, columnName'
        })
      }

      events.emit('kanban:column:added', {
        boardId,
        columnName,
        timestamp: new Date().toISOString()
      })

      res.json({
        success: true,
        message: `Column ${columnName} added to board ${boardId}`
      })
    })

    // Register event listeners
    // Guard events presence as well
    if (events && typeof events.on === 'function') {
      events.on('database:record:created', this.handleRecordCreated.bind(this))
      events.on('database:record:updated', this.handleRecordUpdated.bind(this))
    } else {
      logger.warn('Kanban plugin: context.events unavailable; skipping event listeners')
    }

    logger.info('Kanban plugin activated successfully')
  }

  async deactivate(): Promise<void> {
    const { logger, events } = this.context || ({} as any)

    // Remove event listeners
    try { events?.off?.('database:record:created', this.handleRecordCreated.bind(this)) } catch {}
    try { events?.off?.('database:record:updated', this.handleRecordUpdated.bind(this)) } catch {}

    logger.info('Kanban plugin deactivated')
    this.context = null
  }

  private handleRecordCreated(data: any): void {
    const { logger } = this.context!
    logger.debug('Kanban: Record created', data)

    // Auto-create card in kanban when record is created
    if (data.viewType === 'kanban') {
      this.context!.events.emit('kanban:card:created', {
        recordId: data.recordId,
        column: 'todo',
        timestamp: new Date().toISOString()
      })
    }
  }

  private handleRecordUpdated(data: any): void {
    const { logger } = this.context!
    logger.debug('Kanban: Record updated', data)

    // Update kanban card when record is updated
    if (data.viewType === 'kanban') {
      this.context!.events.emit('kanban:card:updated', {
        recordId: data.recordId,
        changes: data.changes,
        timestamp: new Date().toISOString()
      })
    }
  }
}
