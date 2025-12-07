/**
 * Kanban View Plugin
 *
 * Provides Kanban board functionality for MetaSheet views.
 *
 * V2 Changes:
 * - Database persistence via context.database
 * - Fallback to memory storage if database unavailable
 * - Full CRUD operations for boards, columns, and cards
 */

import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend'

// Types for Kanban data structures
interface KanbanBoard {
  id: string
  view_id: string
  name: string
  columns: KanbanColumn[]
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface KanbanColumn {
  id: string
  name: string
  order_index: number
  color?: string
  wip_limit?: number
}

interface KanbanCard {
  id: string
  board_id: string
  column_id: string
  record_id?: string
  title: string
  description?: string
  order_index: number
  assignee_id?: string
  labels?: string[]
  due_date?: string
  created_at: string
  updated_at: string
}

export default class KanbanPlugin implements PluginLifecycle {
  private context: PluginContext | null = null

  // In-memory cache/fallback storage
  private boardsCache: Map<string, KanbanBoard> = new Map()
  private cardsCache: Map<string, KanbanCard> = new Map()

  // Database availability flag
  private useDatabase: boolean = false

  async activate(context: PluginContext): Promise<void> {
    this.context = context
    const logger = (context as any)?.logger
    const http = (context as any)?.http
    const events = (context as any)?.events
    const database = (context as any)?.database

    if (!logger) {
      // eslint-disable-next-line no-console
      console.warn('[KanbanPlugin] Logger missing in context; skipping activation')
      return
    }

    logger.info('Kanban plugin activating...')

    // Check database availability
    if (database && typeof database.query === 'function') {
      this.useDatabase = true
      logger.info('Kanban plugin: Using database persistence')
    } else {
      this.useDatabase = false
      logger.warn('Kanban plugin: Database unavailable, using in-memory storage (data will be lost on restart)')
    }

    // If HTTP API is not wired, skip route registration
    if (!http || typeof http.addRoute !== 'function') {
      logger.warn('Kanban plugin: context.http.addRoute unavailable; skipping route registration')
      return
    }

    // ==========================================
    // Board Routes
    // ==========================================

    // List all boards
    http.addRoute('GET', '/api/kanban/boards', async (_req: any, res: any) => {
      try {
        const boards = await this.listBoards()
        res.json({
          ok: true,
          data: { items: boards, total: boards.length }
        })
      } catch (error) {
        logger.error('Failed to list boards:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to list boards' }
        })
      }
    })

    // Get board by ID
    http.addRoute('GET', '/api/kanban/boards/:id', async (req: any, res: any) => {
      try {
        const board = await this.getBoard(req.params.id)
        if (!board) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Board not found' }
          })
        }
        res.json({ ok: true, data: board })
      } catch (error) {
        logger.error('Failed to get board:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to get board' }
        })
      }
    })

    // Create board
    http.addRoute('POST', '/api/kanban/boards', async (req: any, res: any) => {
      try {
        const { view_id, name, columns, config } = req.body
        if (!view_id || !name) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'view_id and name are required' }
          })
        }

        const board = await this.createBoard({
          view_id,
          name,
          columns: columns || [
            { id: 'todo', name: 'To Do', order_index: 0 },
            { id: 'in-progress', name: 'In Progress', order_index: 1 },
            { id: 'done', name: 'Done', order_index: 2 }
          ],
          config: config || {}
        })

        events?.emit('kanban:board:created', { boardId: board.id, name: board.name })
        res.status(201).json({ ok: true, data: board })
      } catch (error) {
        logger.error('Failed to create board:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create board' }
        })
      }
    })

    // Update board
    http.addRoute('PUT', '/api/kanban/boards/:id', async (req: any, res: any) => {
      try {
        const board = await this.updateBoard(req.params.id, req.body)
        if (!board) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Board not found' }
          })
        }
        events?.emit('kanban:board:updated', { boardId: board.id })
        res.json({ ok: true, data: board })
      } catch (error) {
        logger.error('Failed to update board:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to update board' }
        })
      }
    })

    // Delete board
    http.addRoute('DELETE', '/api/kanban/boards/:id', async (req: any, res: any) => {
      try {
        const deleted = await this.deleteBoard(req.params.id)
        if (!deleted) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Board not found' }
          })
        }
        events?.emit('kanban:board:deleted', { boardId: req.params.id })
        res.json({ ok: true, data: { id: req.params.id, deleted: true } })
      } catch (error) {
        logger.error('Failed to delete board:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete board' }
        })
      }
    })

    // ==========================================
    // Card Routes
    // ==========================================

    // List cards for a board
    http.addRoute('GET', '/api/kanban/boards/:boardId/cards', async (req: any, res: any) => {
      try {
        const cards = await this.listCards(req.params.boardId)
        res.json({ ok: true, data: { items: cards, total: cards.length } })
      } catch (error) {
        logger.error('Failed to list cards:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to list cards' }
        })
      }
    })

    // Create card
    http.addRoute('POST', '/api/kanban/boards/:boardId/cards', async (req: any, res: any) => {
      try {
        const { column_id, title, description, record_id, assignee_id, labels, due_date } = req.body
        if (!column_id || !title) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'column_id and title are required' }
          })
        }

        const card = await this.createCard({
          board_id: req.params.boardId,
          column_id,
          title,
          description,
          record_id,
          assignee_id,
          labels,
          due_date
        })

        events?.emit('kanban:card:created', { cardId: card.id, boardId: req.params.boardId })

        // Broadcast to WebSocket clients
        if (context.websocket) {
          context.websocket.broadcast('kanban:card:created', {
            type: 'kanban:card:created',
            card,
            timestamp: new Date().toISOString()
          })
        }

        res.status(201).json({ ok: true, data: card })
      } catch (error) {
        logger.error('Failed to create card:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create card' }
        })
      }
    })

    // Move card (change column/position)
    http.addRoute('POST', '/api/kanban/cards/move', async (req: any, res: any) => {
      const { cardId, fromColumn, toColumn, newIndex } = req.body

      if (!cardId || !fromColumn || !toColumn) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'cardId, fromColumn, toColumn are required' }
        })
      }

      try {
        const card = await this.moveCard(cardId, toColumn, newIndex)
        if (!card) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Card not found' }
          })
        }

        // Emit event
        events?.emit('kanban:card:moved', {
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
          ok: true,
          data: card,
          message: `Card ${cardId} moved from ${fromColumn} to ${toColumn}`
        })
      } catch (error) {
        logger.error('Failed to move card:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to move card' }
        })
      }
    })

    // Update card
    http.addRoute('PUT', '/api/kanban/cards/:id', async (req: any, res: any) => {
      try {
        const card = await this.updateCard(req.params.id, req.body)
        if (!card) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Card not found' }
          })
        }
        events?.emit('kanban:card:updated', { cardId: card.id })
        res.json({ ok: true, data: card })
      } catch (error) {
        logger.error('Failed to update card:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to update card' }
        })
      }
    })

    // Delete card
    http.addRoute('DELETE', '/api/kanban/cards/:id', async (req: any, res: any) => {
      try {
        const deleted = await this.deleteCard(req.params.id)
        if (!deleted) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Card not found' }
          })
        }
        events?.emit('kanban:card:deleted', { cardId: req.params.id })
        res.json({ ok: true, data: { id: req.params.id, deleted: true } })
      } catch (error) {
        logger.error('Failed to delete card:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to delete card' }
        })
      }
    })

    // ==========================================
    // Column Routes
    // ==========================================

    // Add column to board
    http.addRoute('POST', '/api/kanban/columns/add', async (req: any, res: any) => {
      const { boardId, columnName, color, wip_limit } = req.body

      if (!boardId || !columnName) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'boardId and columnName are required' }
        })
      }

      try {
        const board = await this.addColumn(boardId, {
          name: columnName,
          color,
          wip_limit
        })

        if (!board) {
          return res.status(404).json({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Board not found' }
          })
        }

        events?.emit('kanban:column:added', {
          boardId,
          columnName,
          timestamp: new Date().toISOString()
        })

        res.json({
          ok: true,
          data: board,
          message: `Column ${columnName} added to board ${boardId}`
        })
      } catch (error) {
        logger.error('Failed to add column:', error)
        res.status(500).json({
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to add column' }
        })
      }
    })

    // Register event listeners
    if (events && typeof events.on === 'function') {
      events.on('database:record:created', this.handleRecordCreated.bind(this))
      events.on('database:record:updated', this.handleRecordUpdated.bind(this))
    } else {
      logger.warn('Kanban plugin: context.events unavailable; skipping event listeners')
    }

    logger.info('Kanban plugin activated successfully')
  }

  async deactivate(): Promise<void> {
    const { logger, events } = (this.context || {}) as any

    // Remove event listeners
    try {
      events?.off?.('database:record:created', this.handleRecordCreated.bind(this))
      events?.off?.('database:record:updated', this.handleRecordUpdated.bind(this))
    } catch {
      // Ignore errors during deactivation
    }

    logger?.info('Kanban plugin deactivated')
    this.context = null
    this.boardsCache.clear()
    this.cardsCache.clear()
  }

  // ==========================================
  // Database Operations
  // ==========================================

  private async listBoards(): Promise<KanbanBoard[]> {
    if (this.useDatabase) {
      const database = (this.context as any)?.database
      const result = await database.query(
        `SELECT v.id, v.table_id as view_id, v.name, v.config, v.created_at, v.updated_at,
                kc.group_by_field, kc.swimlanes_field, kc.card_fields, kc.show_empty_groups
         FROM views v
         LEFT JOIN kanban_configs kc ON kc.view_id = v.id
         WHERE v.type = 'kanban' AND v.deleted_at IS NULL
         ORDER BY v.created_at DESC`
      )
      return result.rows.map(this.mapRowToBoard)
    }

    return Array.from(this.boardsCache.values())
  }

  private async getBoard(id: string): Promise<KanbanBoard | null> {
    if (this.useDatabase) {
      const database = (this.context as any)?.database
      const result = await database.query(
        `SELECT v.id, v.table_id as view_id, v.name, v.config, v.created_at, v.updated_at,
                kc.group_by_field, kc.swimlanes_field, kc.card_fields, kc.show_empty_groups
         FROM views v
         LEFT JOIN kanban_configs kc ON kc.view_id = v.id
         WHERE v.id = $1 AND v.type = 'kanban' AND v.deleted_at IS NULL`,
        [id]
      )
      return result.rows.length > 0 ? this.mapRowToBoard(result.rows[0]) : null
    }

    return this.boardsCache.get(id) || null
  }

  private async createBoard(data: Omit<KanbanBoard, 'id' | 'created_at' | 'updated_at'>): Promise<KanbanBoard> {
    const now = new Date().toISOString()
    const id = `board_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    if (this.useDatabase) {
      const database = (this.context as any)?.database

      // Create view entry
      await database.query(
        `INSERT INTO views (id, table_id, type, name, config, created_at, updated_at)
         VALUES ($1, $2, 'kanban', $3, $4, $5, $5)`,
        [id, data.view_id, data.name, JSON.stringify({ columns: data.columns, ...data.config }), now]
      )

      // Create kanban config
      const groupByField = data.columns?.[0]?.name || 'status'
      await database.query(
        `INSERT INTO kanban_configs (view_id, group_by_field, card_fields, show_empty_groups, created_at, updated_at)
         VALUES ($1, $2, $3, true, $4, $4)`,
        [id, groupByField, JSON.stringify([]), now]
      )

      return this.getBoard(id) as Promise<KanbanBoard>
    }

    const board: KanbanBoard = {
      id,
      view_id: data.view_id,
      name: data.name,
      columns: data.columns,
      config: data.config,
      created_at: now,
      updated_at: now
    }

    this.boardsCache.set(id, board)
    return board
  }

  private async updateBoard(id: string, data: Partial<KanbanBoard>): Promise<KanbanBoard | null> {
    const existing = await this.getBoard(id)
    if (!existing) return null

    const now = new Date().toISOString()

    if (this.useDatabase) {
      const database = (this.context as any)?.database
      const updates: string[] = []
      const params: unknown[] = []
      let paramIndex = 1

      if (data.name) {
        updates.push(`name = $${paramIndex++}`)
        params.push(data.name)
      }
      if (data.columns || data.config) {
        const newConfig = {
          ...existing.config,
          ...data.config,
          columns: data.columns || existing.columns
        }
        updates.push(`config = $${paramIndex++}`)
        params.push(JSON.stringify(newConfig))
      }

      updates.push(`updated_at = $${paramIndex++}`)
      params.push(now)
      params.push(id)

      await database.query(
        `UPDATE views SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
        params
      )

      return this.getBoard(id)
    }

    const updated: KanbanBoard = {
      ...existing,
      ...data,
      id,
      updated_at: now
    }
    this.boardsCache.set(id, updated)
    return updated
  }

  private async deleteBoard(id: string): Promise<boolean> {
    if (this.useDatabase) {
      const database = (this.context as any)?.database
      const result = await database.query(
        `UPDATE views SET deleted_at = NOW() WHERE id = $1 AND type = 'kanban' AND deleted_at IS NULL`,
        [id]
      )
      return result.rowCount > 0
    }

    return this.boardsCache.delete(id)
  }

  private async addColumn(boardId: string, column: Omit<KanbanColumn, 'id' | 'order_index'>): Promise<KanbanBoard | null> {
    const board = await this.getBoard(boardId)
    if (!board) return null

    const newColumn: KanbanColumn = {
      id: `col_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: column.name,
      order_index: board.columns.length,
      color: column.color,
      wip_limit: column.wip_limit
    }

    const updatedColumns = [...board.columns, newColumn]
    return this.updateBoard(boardId, { columns: updatedColumns })
  }

  // ==========================================
  // Card Operations
  // ==========================================

  private async listCards(boardId: string): Promise<KanbanCard[]> {
    // Cards are typically stored in the main data table, filtered by view
    // For now, use in-memory cache
    return Array.from(this.cardsCache.values())
      .filter(card => card.board_id === boardId)
      .sort((a, b) => a.order_index - b.order_index)
  }

  private async createCard(data: Omit<KanbanCard, 'id' | 'order_index' | 'created_at' | 'updated_at'>): Promise<KanbanCard> {
    const now = new Date().toISOString()
    const id = `card_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    // Get max order_index for this column
    const existingCards = await this.listCards(data.board_id)
    const columnCards = existingCards.filter(c => c.column_id === data.column_id)
    const maxIndex = columnCards.length > 0
      ? Math.max(...columnCards.map(c => c.order_index))
      : -1

    const card: KanbanCard = {
      id,
      board_id: data.board_id,
      column_id: data.column_id,
      record_id: data.record_id,
      title: data.title,
      description: data.description,
      order_index: maxIndex + 1,
      assignee_id: data.assignee_id,
      labels: data.labels,
      due_date: data.due_date,
      created_at: now,
      updated_at: now
    }

    this.cardsCache.set(id, card)
    return card
  }

  private async moveCard(cardId: string, toColumn: string, newIndex?: number): Promise<KanbanCard | null> {
    const card = this.cardsCache.get(cardId)
    if (!card) return null

    const now = new Date().toISOString()
    const updated: KanbanCard = {
      ...card,
      column_id: toColumn,
      order_index: newIndex ?? card.order_index,
      updated_at: now
    }

    this.cardsCache.set(cardId, updated)
    return updated
  }

  private async updateCard(id: string, data: Partial<KanbanCard>): Promise<KanbanCard | null> {
    const existing = this.cardsCache.get(id)
    if (!existing) return null

    const updated: KanbanCard = {
      ...existing,
      ...data,
      id,
      updated_at: new Date().toISOString()
    }

    this.cardsCache.set(id, updated)
    return updated
  }

  private async deleteCard(id: string): Promise<boolean> {
    return this.cardsCache.delete(id)
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  private mapRowToBoard(row: any): KanbanBoard {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config || {}
    return {
      id: row.id,
      view_id: row.view_id,
      name: row.name,
      columns: config.columns || [],
      config: {
        group_by_field: row.group_by_field,
        swimlanes_field: row.swimlanes_field,
        card_fields: row.card_fields,
        show_empty_groups: row.show_empty_groups,
        ...config
      },
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }

  private handleRecordCreated(data: any): void {
    const { logger } = (this.context || {}) as any
    logger?.debug('Kanban: Record created', data)

    // Auto-create card in kanban when record is created
    if (data.viewType === 'kanban') {
      (this.context as any)?.events?.emit('kanban:card:created', {
        recordId: data.recordId,
        column: 'todo',
        timestamp: new Date().toISOString()
      })
    }
  }

  private handleRecordUpdated(data: any): void {
    const { logger } = (this.context || {}) as any
    logger?.debug('Kanban: Record updated', data)

    // Update kanban card when record is updated
    if (data.viewType === 'kanban') {
      (this.context as any)?.events?.emit('kanban:card:updated', {
        recordId: data.recordId,
        changes: data.changes,
        timestamp: new Date().toISOString()
      })
    }
  }
}
